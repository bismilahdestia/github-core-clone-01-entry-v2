// Git primitives: object ids, zlib objects, packfiles, pkt-lines and deltas.
// Standard library only. No git binary, no network, no wall clock.
//
// Design notes (perf): pack parsing inflates each zlib stream exactly once
// and learns the consumed byte count from the engine (see decodePack); object
// ids hash header and content in two updates so no concatenation copy is
// made; packs are built with deflate level 1, which is ~2-3x faster than the
// default on small objects and still yields a valid zlib stream.
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

/** The all-zero object id: "no object". */
export const NIL_OID = '0000000000000000000000000000000000000000';

/** Hex SHA-1 of a buffer. */
export function sha1Digest(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** True when the string looks like a 40-hex object id. */
export function isOidText(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * The object id of a git object: sha1("<type> <size>\0" + content).
 * The header and the content are fed as two separate hash updates, which
 * produces the same digest as hashing the concatenation without copying it.
 */
export function computeOid(kind: string, content: Buffer): string {
  return createHash('sha1').update(`${kind} ${content.length}\0`, 'ascii').update(content).digest('hex');
}

export type ObjectKind = 'commit' | 'tree' | 'blob' | 'tag';

/** One stored git object: its kind and its raw bytes. */
export interface GitRecord {
  kind: ObjectKind;
  content: Buffer;
}

/** A parsed commit header: its tree, its parents, and its message body. */
export interface CommitView {
  tree: string;
  parents: string[];
  message: string;
}

/** Split a commit's header lines from its message and pull out tree/parents. */
export function decodeCommit(content: Buffer): CommitView {
  const text = content.toString('utf8');
  const blankAt = text.indexOf('\n\n');
  const header = blankAt >= 0 ? text.slice(0, blankAt) : text;
  const message = blankAt >= 0 ? text.slice(blankAt + 2) : '';
  let tree = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** One entry of a tree object: mode, file name, and object id. */
export interface TreeItem {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries (they are already in git sort order). */
export function decodeTree(content: Buffer): TreeItem[] {
  const items: TreeItem[] = [];
  let offset = 0;
  while (offset < content.length) {
    const spaceAt = content.indexOf(0x20, offset);
    const nulAt = content.indexOf(0x00, spaceAt);
    if (spaceAt < 0 || nulAt < 0 || nulAt + 21 > content.length) break;
    const mode = content.subarray(offset, spaceAt).toString('ascii');
    const name = content.subarray(spaceAt + 1, nulAt).toString('utf8');
    const oid = content.subarray(nulAt + 1, nulAt + 21).toString('hex');
    items.push({ mode, name, oid });
    offset = nulAt + 21;
  }
  return items;
}

/** Serialize tree entries (the caller keeps git sort order). */
export function encodeTree(items: TreeItem[]): Buffer {
  const chunks: Buffer[] = [];
  for (const item of items) {
    chunks.push(Buffer.from(`${item.mode} ${item.name}\0`, 'utf8'));
    chunks.push(Buffer.from(item.oid, 'hex'));
  }
  return Buffer.concat(chunks);
}

/**
 * Git tree sort order: entries compare by name, with directories compared as
 * if their name had a trailing '/'.
 */
export function sortTreeItems(items: TreeItem[]): TreeItem[] {
  const sortKey = (item: TreeItem): string => (item.mode === '40000' ? `${item.name}/` : item.name);
  return items.slice().sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

/** A parsed tag object: the object it points at, its kind, and its name. */
export interface TagView {
  object: string;
  type: string;
  tag: string;
}

/** Parse a tag object: the object it points at. */
export function decodeTag(content: Buffer): TagView {
  const text = content.toString('utf8');
  const blankAt = text.indexOf('\n\n');
  const header = blankAt >= 0 ? text.slice(0, blankAt) : text;
  let object = '';
  let type = '';
  let tag = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

// ---------------------------------------------------------------- pkt-line

/** Encode one pkt-line (the data must already end with '\n' when it is a line). */
export function encodePktLine(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const total = body.length + 4;
  return Buffer.concat([Buffer.from(total.toString(16).padStart(4, '0'), 'ascii'), body]);
}

/** The flush packet: end of a pkt-line stream. */
export const FLUSH_PKT = Buffer.from('0000', 'ascii');
/** The delimiter packet: separator between protocol v2 sections. */
export const DELIM_PKT = Buffer.from('0001', 'ascii');
/** The end packet: end of a protocol v2 response. */
export const END_PKT = Buffer.from('0002', 'ascii');

/** Encode a list of lines as pkt-lines, with a trailing flush. */
export function encodePktLines(lines: string[]): Buffer {
  const parts: Buffer[] = lines.map((line) => encodePktLine(line));
  parts.push(FLUSH_PKT);
  return Buffer.concat(parts);
}

/** One decoded pkt-line frame. */
export interface PktFrame {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

const EMPTY_PAYLOAD = Buffer.alloc(0);

/**
 * Read the single frame starting at `at`. Returns the frame and the offset
 * just past it. Throws on a bad length or a truncated header.
 */
function readFrameAt(buf: Buffer, at: number): { frame: PktFrame; next: number } {
  if (at + 4 > buf.length) throw new Error('truncated pkt-line header');
  const hex = buf.subarray(at, at + 4).toString('ascii');
  if (hex === '0000') return { frame: { kind: 'flush', payload: EMPTY_PAYLOAD }, next: at + 4 };
  if (hex === '0001') return { frame: { kind: 'delim', payload: EMPTY_PAYLOAD }, next: at + 4 };
  if (hex === '0002') return { frame: { kind: 'end', payload: EMPTY_PAYLOAD }, next: at + 4 };
  const len = parseInt(hex, 16);
  if (!Number.isFinite(len) || len < 4 || len > 65520 || at + len > buf.length) {
    throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
  }
  return { frame: { kind: 'data', payload: buf.subarray(at + 4, at + len) }, next: at + len };
}

/**
 * Split a buffer into pkt-line frames. Throws on a bad length, a truncated
 * packet, or trailing bytes that do not parse.
 */
export function decodePktFrames(buf: Buffer): PktFrame[] {
  const frames: PktFrame[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const { frame, next } = readFrameAt(buf, offset);
    frames.push(frame);
    offset = next;
  }
  return frames;
}

/**
 * Split a buffer into pkt-line frames, stopping at the first flush.
 * Returns the frames and the number of bytes consumed.
 */
export function decodePktFramesUntilFlush(buf: Buffer): { frames: PktFrame[]; consumed: number } {
  const frames: PktFrame[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const { frame, next } = readFrameAt(buf, offset);
    frames.push(frame);
    offset = next;
    if (frame.kind === 'flush') return { frames, consumed: offset };
  }
  throw new Error('pkt-line stream ended without flush');
}

/** The text lines (without trailing newline) of the data frames, in order. */
export function pktFrameTexts(frames: PktFrame[]): string[] {
  const lines: string[] = [];
  for (const frame of frames) {
    if (frame.kind !== 'data') continue;
    lines.push(frame.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- deltas

/** Read one little-endian base-128 varint (delta sizes and copy offsets). */
function readVarintAt(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (;;) {
    if (cursor >= buf.length) throw new Error('truncated delta varint');
    const byte = buf[cursor] ?? 0;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    cursor += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: cursor };
}

/** Apply a git delta to a base object, returning the result bytes. */
export function applyDeltaOps(base: Buffer, delta: Buffer): Buffer {
  const baseSize = readVarintAt(delta, 0);
  const resultSize = readVarintAt(delta, baseSize.next);
  if (baseSize.value !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let total = 0;
  let cursor = resultSize.next;
  while (cursor < delta.length) {
    const opcode = delta[cursor] ?? 0;
    cursor += 1;
    if ((opcode & 0x80) !== 0) {
      // Copy from the base: offset/size bits say which bytes follow.
      let offset = 0;
      let size = 0;
      if ((opcode & 0x01) !== 0) {
        offset = delta[cursor] ?? 0;
        cursor += 1;
      }
      if ((opcode & 0x02) !== 0) {
        offset |= (delta[cursor] ?? 0) << 8;
        cursor += 1;
      }
      if ((opcode & 0x04) !== 0) {
        offset |= (delta[cursor] ?? 0) << 16;
        cursor += 1;
      }
      if ((opcode & 0x08) !== 0) {
        offset |= (delta[cursor] ?? 0) << 24;
        cursor += 1;
      }
      if ((opcode & 0x10) !== 0) {
        size = delta[cursor] ?? 0;
        cursor += 1;
      }
      if ((opcode & 0x20) !== 0) {
        size |= (delta[cursor] ?? 0) << 8;
        cursor += 1;
      }
      if ((opcode & 0x40) !== 0) {
        size |= (delta[cursor] ?? 0) << 16;
        cursor += 1;
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of range');
      const chunk = base.subarray(offset, offset + size);
      chunks.push(chunk);
      total += chunk.length;
    } else if (opcode !== 0) {
      // Insert literal bytes from the delta itself.
      if (cursor + opcode > delta.length) throw new Error('delta insert out of range');
      const chunk = delta.subarray(cursor, cursor + opcode);
      chunks.push(chunk);
      total += chunk.length;
      cursor += opcode;
    } else {
      throw new Error('delta op 0 is reserved');
    }
  }
  if (total !== resultSize.value) throw new Error('delta result size mismatch');
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- packfiles

const PACK_KIND_BY_CODE: Record<number, ObjectKind> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_CODE_BY_KIND: Record<ObjectKind, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** A raw pack entry as read in the first pass (deltas not yet resolved). */
interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  /** Inflated payload (delta bytes for delta entries). */
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Parse a packfile, resolving deltas against `resolveBase` (the local store
 * plus in-pack objects). Returns the objects keyed by their object id.
 */
export function decodePack(
  buf: Buffer,
  resolveBase: (oid: string) => GitRecord | undefined,
): Map<string, GitRecord> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitRecord>();
  // First pass: read raw entries in order (offsets matter for OFS_DELTA).
  const raw: RawPackEntry[] = [];
  let cursor = 12;
  for (let n = 0; n < count; n += 1) {
    const start = cursor;
    if (cursor >= buf.length) throw new Error('pack truncated');
    let byte = buf[cursor] ?? 0;
    cursor += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (cursor >= buf.length) throw new Error('pack truncated in size varint');
      byte = buf[cursor] ?? 0;
      cursor += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: the base is a negative offset from this entry's start.
      if (cursor >= buf.length) throw new Error('pack truncated in ofs base');
      let b = buf[cursor] ?? 0;
      cursor += 1;
      let off = b & 0x7f;
      while ((b & 0x80) !== 0) {
        if (cursor >= buf.length) throw new Error('pack truncated in ofs base');
        b = buf[cursor] ?? 0;
        cursor += 1;
        off = ((off + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - off;
    } else if (typeCode === 7) {
      // REF_DELTA: the base is named by object id.
      if (cursor + 20 > buf.length) throw new Error('pack truncated in ref base');
      baseOid = buf.subarray(cursor, cursor + 20).toString('hex');
      cursor += 20;
    }
    // One inflate per stream: inflateSync with info:true reports how many
    // input bytes the stream consumed (engine.bytesWritten), so there is no
    // binary search over the input and no failed inflate attempts (each of
    // which used to throw an Error with a captured stack). Verified against
    // the old search: both find the same stream end on every pack.
    const input = buf.subarray(cursor);
    let inflated: Buffer;
    let consumed: number;
    try {
      const result = inflateSync(input, { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      inflated = result.buffer;
      consumed = result.engine.bytesWritten;
    } catch {
      throw new Error('pack zlib stream did not inflate to declared size');
    }
    if (inflated.length !== size || !Number.isFinite(consumed) || consumed <= 0) {
      throw new Error('pack zlib stream did not inflate to declared size');
    }
    raw.push({ offset: start, typeCode, size, data: inflated, baseOffset, baseOid });
    cursor += consumed;
  }
  // Trailer: 20 bytes of sha1 over everything before it.
  if (cursor + 20 !== buf.length) throw new Error('pack has stray bytes before trailer');
  const trailer = buf.subarray(cursor, cursor + 20).toString('hex');
  if (trailer !== sha1Digest(buf.subarray(0, cursor))) throw new Error('pack trailer checksum mismatch');
  // Resolve entries (deltas may reference earlier entries by offset or any oid).
  const byOffset = new Map<number, RawPackEntry>();
  for (const entry of raw) byOffset.set(entry.offset, entry);
  const resolve = (entry: RawPackEntry, seen: Set<number>): GitRecord => {
    if (entry.typeCode >= 1 && entry.typeCode <= 4) {
      const kind = PACK_KIND_BY_CODE[entry.typeCode] as ObjectKind;
      if (entry.data.length !== entry.size) throw new Error('pack object size mismatch');
      return { kind, content: entry.data };
    }
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitRecord | undefined;
      if (entry.typeCode === 6) {
        if (entry.baseOffset === undefined) throw new Error('ofs delta without base');
        if (seen.has(entry.baseOffset)) throw new Error('delta cycle');
        const baseEntry = byOffset.get(entry.baseOffset);
        if (!baseEntry) throw new Error('ofs delta base outside pack');
        seen.add(entry.baseOffset);
        base = resolve(baseEntry, seen);
      } else {
        if (!entry.baseOid) throw new Error('ref delta without base');
        base = objects.get(entry.baseOid) ?? resolveBase(entry.baseOid);
        if (!base) {
          // Base may be a later pack entry (ref delta by oid): search raw entries.
          const baseEntry = raw.find((candidate) => {
            if (candidate.typeCode < 1 || candidate.typeCode > 4) return false;
            return computeOid(PACK_KIND_BY_CODE[candidate.typeCode] as ObjectKind, candidate.data) === entry.baseOid;
          });
          if (baseEntry) base = resolve(baseEntry, new Set(seen));
        }
        if (!base) throw new Error(`ref delta base not found: ${entry.baseOid}`);
      }
      const content = applyDeltaOps(base.content, entry.data);
      return { kind: base.kind, content };
    }
    throw new Error(`unknown pack type ${entry.typeCode}`);
  };
  for (const entry of raw) {
    const obj = resolve(entry, new Set([entry.offset]));
    objects.set(computeOid(obj.kind, obj.content), obj);
  }
  if (objects.size !== count && raw.length !== count) throw new Error('pack count mismatch');
  return objects;
}

/** Build a packfile (v2, no deltas) from objects. */
export function encodePack(objects: GitRecord[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeCode = PACK_CODE_BY_KIND[obj.kind];
    const size = obj.content.length;
    // type/size varint: first byte holds type in bits 4-6 and low 4 size bits.
    const varint: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    while (remaining > 0) {
      varint.push(first | 0x80);
      first = remaining & 0x7f;
      remaining >>= 7;
    }
    varint.push(first);
    parts.push(Buffer.from(varint));
    // Level 1 deflate: the pack stays a valid zlib stream (same objects, same
    // trailer checksum over the bytes sent) and inflates identically, but
    // compresses ~2-3x faster than the default level 6 on small objects.
    parts.push(deflateSync(obj.content, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Digest(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Encode a sideband packet (band 1 = data). Chunked to the pkt-line limit. */
export function sidebandChunks(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const maxPayload = 65520 - 4 - 1;
  for (let offset = 0; offset < data.length; offset += maxPayload) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxPayload));
    const pkt = Buffer.concat([Buffer.from([band]), chunk]);
    out.push(encodePktLine(pkt));
  }
  if (data.length === 0) {
    // An empty payload still needs no packet; callers add the flush themselves.
  }
  return out;
}
