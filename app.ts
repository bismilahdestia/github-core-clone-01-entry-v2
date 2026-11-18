// The HTTP server: routing, auth, JSON bodies, and git smart HTTP.
// main.ts owns the lifecycle (bind, register, poll /done); this file owns the
// surfaces the suite drives.
//
// Perf notes: the request URL is parsed once per request (pathname + query);
// bodyless GET/HEAD requests never wait for the socket's 'end' event; the
// upload-pack planner skips the common-haves walk entirely when the client
// sent no 'have' lines (see buildFetchPlan).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, VIEWER_LOGIN, type Repository } from './store.ts';
import { handleRestApi } from './rest.ts';
import { handleGraphqlApi } from './graphql.ts';
import { handleMcpApi } from './mcp.ts';
import {
  encodePktLine,
  decodePktFrames,
  decodePktFramesUntilFlush,
  pktFrameTexts,
  decodePack,
  encodePack,
  sidebandChunks,
  NIL_OID,
  isOidText,
  DELIM_PKT,
  FLUSH_PKT,
  type GitRecord,
} from './git.ts';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

/** A fresh request id for the x-github-request-id response header. */
function newRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Read the request body fully (data chunks until 'end'). */
function collectBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Send a JSON response (a string body is sent verbatim). */
function replyJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': newRequestId(),
    ...headers,
  });
  res.end(text);
}

/** Send a raw-bytes response with the given content type. */
function replyBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': newRequestId(),
  });
  res.end(body);
}

/** The bearer token from the Authorization header ('' when absent). */
function bearerValue(req: IncomingMessage): string {
  const auth = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/.exec(auth);
  return m ? (m[1] as string) : '';
}

/** The token the entry was given (empty when the harness gave none). */
function configuredToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** True when the request carries an acceptable bearer token. */
function isAuthorized(req: IncomingMessage): boolean {
  const expected = configuredToken();
  const got = bearerValue(req);
  if (got === '') return false;
  if (expected === '') return true;
  return got === expected;
}

/** Parse a JSON body (an empty body parses as null). */
function parseJsonPayload(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Build the forge HTTP server (exported name kept: dev tooling imports it). */
export function createApp(forge: Forge = new Forge()): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      // Parse the request URL once (pathname + query), not twice.
      let path = '/';
      let query = new URLSearchParams();
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        path = url.pathname;
        query = url.searchParams;
      } catch {
        // Keep the defaults: the router answers 404 JSON below.
      }

      // Boot probe: no auth.
      if (method === 'GET' && path === '/healthz') {
        replyJson(res, 200, { ok: true });
        return;
      }

      // Everything else needs the bearer token.
      if (!isAuthorized(req)) {
        replyJson(res, 401, { message: 'Requires authentication' });
        return;
      }

      // GET/HEAD requests from the suite never carry a body: when the headers
      // promise none (no content-length, no chunked encoding), answer without
      // waiting for the socket's 'end' event. Anything else still reads fully.
      const hasBody =
        req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;
      const body =
        hasBody || (method !== 'GET' && method !== 'HEAD')
          ? await collectBody(req).catch(() => null)
          : Buffer.alloc(0);
      if (body === null) {
        replyJson(res, 400, { message: 'could not read request body' });
        return;
      }

      // GraphQL v4.
      if (method === 'POST' && path === '/api/graphql') {
        const parsed = parseJsonPayload(body);
        if (!parsed.ok) {
          replyJson(res, 400, { message: 'request body is not valid JSON' });
          return;
        }
        try {
          replyJson(res, 200, handleGraphqlApi(forge, parsed.value));
        } catch (e) {
          replyJson(res, 200, { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] });
        }
        return;
      }

      // MCP.
      if (path === '/mcp') {
        if (method === 'DELETE') {
          res.writeHead(202, { 'x-github-request-id': newRequestId() });
          res.end();
          return;
        }
        if (method !== 'POST') {
          replyJson(res, 405, { message: 'Method Not Allowed' });
          return;
        }
        const result = handleMcpApi(forge, body);
        if (result.body === null) {
          res.writeHead(result.status, { 'x-github-request-id': newRequestId() });
          res.end();
          return;
        }
        replyJson(res, result.status, result.body);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const restPath = path === '/api/v3' ? '/' : path.slice('/api/v3'.length);
        const segments = restPath
          .split('/')
          .filter((s) => s !== '')
          .map((s) => {
            try {
              return decodeURIComponent(s);
            } catch {
              return s;
            }
          });
        const parsed = parseJsonPayload(body);
        if (!parsed.ok) {
          replyJson(res, 400, { message: 'request body is not valid JSON' });
          return;
        }
        const result = handleRestApi(forge, {
          method,
          segments,
          query,
          json: parsed.value,
          body,
          host: req.headers.host ?? 'localhost',
        });
        if (result.status === 204) {
          res.writeHead(204, { 'x-github-request-id': newRequestId(), ...(result.headers ?? {}) });
          res.end();
          return;
        }
        replyJson(res, result.status, result.body, result.headers);
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/...
      const gitMatch = /^\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\.git\/(.+)$/.exec(path);
      if (gitMatch) {
        const owner = gitMatch[1] as string;
        const repoName = gitMatch[2] as string;
        const rest = gitMatch[3] as string;
        const repo = forge.findRepo(owner, repoName);
        if (!repo || owner !== VIEWER_LOGIN) {
          replyJson(res, 404, { message: 'Not Found' });
          return;
        }
        try {
          if (method === 'GET' && rest === 'info/refs') {
            serveInfoRefs(forge, repo, req, res, query);
            return;
          }
          if (method === 'POST' && rest === 'git-upload-pack') {
            serveUploadPack(forge, repo, req, res, body);
            return;
          }
          if (method === 'POST' && rest === 'git-receive-pack') {
            serveReceivePack(forge, repo, req, res, body);
            return;
          }
        } catch (e) {
          replyJson(res, 400, { message: e instanceof Error ? e.message : String(e) });
          return;
        }
        replyJson(res, 404, { message: 'Not Found' });
        return;
      }

      replyJson(res, 404, { message: 'Not Found' });
    })().catch((e: unknown) => {
      if (!res.headersSent) {
        replyJson(res, 500, { message: e instanceof Error ? e.message : String(e) });
      } else {
        res.end();
      }
    });
  });
}

// ---------------------------------------------------------------- git helpers

/** The content type of a git smart-HTTP advertisement or result. */
function gitContentType(service: 'upload-pack' | 'receive-pack', kind: 'advertisement' | 'result'): string {
  return `application/x-git-${service}-${kind}`;
}

/**
 * The advertised ref lines for a repo (HEAD first when requested, then refs
 * sorted by name), with peeled lines for annotated tags. The first line
 * carries the capability list when one is given.
 */
function advertisedRefLines(forge: Forge, repo: Repository, caps: string, withHead: boolean): Buffer[] {
  const lines: Buffer[] = [];
  const refs = forge.allRefEntries(repo);
  const entries = [...refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const mainTip = repo.refs.get('main') ?? '';
  let first = true;
  const emit = (oid: string, ref: string): void => {
    const suffix = first && caps !== '' ? `\0${caps}` : '';
    lines.push(encodePktLine(`${oid} ${ref}${suffix}\n`));
    first = false;
  };
  if (withHead && mainTip !== '' && isOidText(mainTip)) {
    emit(mainTip, 'HEAD');
  }
  for (const [ref, oid] of entries) {
    emit(oid, ref);
    // Peeled line for annotated tags.
    if (ref.startsWith('refs/tags/')) {
      const t = forge.tagView(repo, oid);
      if (t) lines.push(encodePktLine(`${t.object} ${ref}^{}\n`));
    }
  }
  if (entries.length === 0 && (!withHead || mainTip === '')) {
    emit(NIL_OID, 'capabilities^{}');
  }
  return lines;
}

/** GET info/refs: advertise upload-pack / receive-pack capabilities and refs. */
function serveInfoRefs(
  forge: Forge,
  repo: Repository,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
): void {
  const service = query.get('service') ?? '';
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      const parts: Buffer[] = [
        encodePktLine('version 2\n'),
        encodePktLine('ls-refs=unborn\n'),
        encodePktLine('fetch=shallow filter\n'),
        encodePktLine('object-format=sha1\n'),
        encodePktLine('agent=makefun-forge/1.0\n'),
        FLUSH_PKT,
      ];
      replyBytes(res, 200, Buffer.concat(parts), gitContentType('upload-pack', 'advertisement'));
      return;
    }
    const caps = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=makefun-forge/1.0';
    const parts: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), FLUSH_PKT, ...advertisedRefLines(forge, repo, caps, true), FLUSH_PKT];
    replyBytes(res, 200, Buffer.concat(parts), gitContentType('upload-pack', 'advertisement'));
    return;
  }
  if (service === 'git-receive-pack') {
    const caps = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-forge/1.0';
    const parts: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), FLUSH_PKT, ...advertisedRefLines(forge, repo, caps, false), FLUSH_PKT];
    replyBytes(res, 200, Buffer.concat(parts), gitContentType('receive-pack', 'advertisement'));
    return;
  }
  replyJson(res, 400, { message: `unknown service ${service}` });
}

// ---------------------------------------------------------------- upload-pack

/** POST git-upload-pack: protocol v2 or v0, by the git-protocol header. */
function serveUploadPack(
  forge: Forge,
  repo: Repository,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): void {
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (wantsV2) {
    serveUploadPackV2(forge, repo, res, body);
  } else {
    serveUploadPackV0(forge, repo, res, body);
  }
}

/** Upload-pack protocol v2: one command (ls-refs / fetch) plus arguments. */
function serveUploadPackV2(forge: Forge, repo: Repository, res: ServerResponse, body: Buffer): void {
  const frames = decodePktFrames(body);
  let i = 0;
  let command = '';
  const args: string[] = [];
  for (; i < frames.length; i += 1) {
    const p = frames[i] as { kind: string; payload: Buffer };
    if (p.kind === 'delim') {
      i += 1;
      break;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) command = line.slice('command='.length);
  }
  for (; i < frames.length; i += 1) {
    const p = frames[i] as { kind: string; payload: Buffer };
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    args.push(p.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (command === 'ls-refs') {
    serveLsRefs(forge, repo, res, args);
    return;
  }
  if (command === 'fetch') {
    serveFetch(forge, repo, res, args, 2);
    return;
  }
  throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
}

/** Upload-pack v2 ls-refs: refs matching the requested prefixes, peeled on demand. */
function serveLsRefs(forge: Forge, repo: Repository, res: ServerResponse, args: string[]): void {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const out: string[] = [];
  const mainTip = repo.refs.get('main') ?? '';
  const refs = forge.allRefEntries(repo);
  if (mainTip !== '' && isOidText(mainTip)) {
    if (keep('HEAD')) {
      out.push(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  } else if (unborn && keep('refs/heads/main')) {
    out.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  }
  const sorted = [...refs.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [ref, oid] of sorted) {
    if (!keep(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel && ref.startsWith('refs/tags/')) {
      const t = forge.tagView(repo, oid);
      if (t) line += ` peeled:${t.object}`;
    }
    out.push(`${line}\n`);
  }
  const parts: Buffer[] = out.map((l) => encodePktLine(l));
  parts.push(FLUSH_PKT);
  replyBytes(res, 200, Buffer.concat(parts), gitContentType('upload-pack', 'result'));
}

/** What a fetch asks for: wants, haves, shallow boundaries, depth, want-refs. */
interface FetchRequest {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
  wantRefs: string[];
  deepenRelative: boolean;
}

/** Parse fetch argument lines (want/have/shallow/deepen/want-ref/...) into a plan. */
function parseFetchLines(args: string[]): FetchRequest {
  const plan: FetchRequest = { wants: [], haves: [], shallowBoundaries: [], depth: null, wantRefs: [], deepenRelative: false };
  for (const line of args) {
    if (line.startsWith('want ')) plan.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) plan.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) plan.depth = Number(line.slice(7).trim());
    else if (line.startsWith('want-ref ')) plan.wantRefs.push(line.slice(9).trim());
    else if (line === 'deepen-relative') plan.deepenRelative = true;
    // thin-pack, no-progress, ofs-delta, filter, done, agent, object-format: ignored.
  }
  return plan;
}

/**
 * Resolve a fetch plan into the objects to send, the new shallow boundaries,
 * the boundaries that stopped being shallow, and the ACKs for the haves.
 */
function buildFetchPlan(
  forge: Forge,
  repo: Repository,
  plan: FetchRequest,
): { objects: GitRecord[]; shallow: string[]; unshallow: string[]; acks: string[] } {
  const wants = plan.wants.filter((w) => isOidText(w) && forge.fetchObject(repo, w) !== undefined);
  const haves = plan.haves.filter((h) => isOidText(h));
  if (wants.length === 0) return { objects: [], shallow: [], unshallow: [], acks: [] };
  // ACKs need the common base even for shallow fetches (real git expects
  // ACK + ready, not NAK, when the haves are ancestors of the wants). With no
  // haves there is nothing to ack (v0 answers NAK, v2 sends no
  // acknowledgments section), so skip the full-history walk entirely: a
  // depth-1 clone of a 200-commit repo used to walk all 200 commits here.
  const acks = haves.length > 0 ? forge.sharedHaves(repo, wants, haves) : [];
  if (plan.depth !== null && Number.isFinite(plan.depth) && plan.depth > 0) {
    // `deepen-relative` (real git --deepen): the deepen value counts from the
    // current shallow boundary, so the absolute depth is the boundary's
    // distance from the wants plus the requested deepen.
    let depth = plan.depth;
    if (plan.deepenRelative && plan.shallowBoundaries.length > 0) {
      const base = forge.boundaryDepth(repo, wants, plan.shallowBoundaries);
      if (base > 0) depth = base + plan.depth;
    }
    const { objects, shallow, commits } = forge.walkShallow(repo, wants, haves, depth, plan.shallowBoundaries);
    // A previous boundary that is now inside the walked range stops being
    // shallow (real git reports it as unshallow even though it is not in
    // the pack — the client already holds it).
    const commitSet = new Set(commits);
    const unshallow = plan.shallowBoundaries.filter((b) => commitSet.has(b) && !shallow.includes(b));
    return { objects: [...objects.values()], shallow, unshallow, acks };
  }
  const objects = forge.objectsMinusHaves(repo, wants, haves);
  return { objects: [...objects.values()], shallow: [], unshallow: [], acks };
}

/** Send a fetch answer: ACKs/shallow-info/wanted-refs sections, then the pack. */
function sendPackResponse(
  forge: Forge,
  repo: Repository,
  plan: FetchRequest,
  protocol: 0 | 2,
  res: ServerResponse,
): void {
  const { objects, shallow, unshallow, acks } = buildFetchPlan(forge, repo, plan);
  const pack = objects.length > 0 ? encodePack(objects) : null;
  if (protocol === 2) {
    const parts: Buffer[] = [];
    // The acknowledgments section only exists when the client negotiated
    // with 'have' lines; a no-haves fetch (clone) has nothing to ack, and
    // real git rejects an acknowledgments section in that position.
    if (plan.haves.length > 0) {
      parts.push(encodePktLine('acknowledgments\n'));
      if (acks.length > 0) {
        for (const a of acks) parts.push(encodePktLine(`ACK ${a}\n`));
      } else {
        parts.push(encodePktLine('NAK\n'));
      }
      // 'ready' tells the client the server is done negotiating and more
      // sections (shallow-info / packfile) follow; without it git expects
      // the response to end right after the acknowledgments section.
      parts.push(encodePktLine('ready\n'));
      // Protocol v2 sections are separated by delimiter packets (0001); a
      // flush packet (0000) ends the whole response.
      parts.push(DELIM_PKT);
    }
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(encodePktLine('shallow-info\n'));
      for (const s of shallow) parts.push(encodePktLine(`shallow ${s}\n`));
      for (const u of unshallow) parts.push(encodePktLine(`unshallow ${u}\n`));
      parts.push(DELIM_PKT);
    }
    const refs = forge.allRefEntries(repo);
    const wantedLines: string[] = [];
    // wanted-refs is only sent when the client asked for it (want-ref lines);
    // real git rejects an unsolicited wanted-refs section.
    for (const wantRef of plan.wantRefs) {
      const oid = refs.get(wantRef) ?? (wantRef === 'HEAD' ? repo.refs.get('main') ?? '' : '');
      if (oid !== '') wantedLines.push(`${oid} ${wantRef}\n`);
    }
    if (wantedLines.length > 0) {
      parts.push(encodePktLine('wanted-refs\n'));
      for (const l of wantedLines) parts.push(encodePktLine(l));
      parts.push(DELIM_PKT);
    }
    if (pack) {
      parts.push(encodePktLine('packfile\n'));
      for (const p of sidebandChunks(pack, 1)) parts.push(p);
      parts.push(FLUSH_PKT);
    }
    replyBytes(res, 200, Buffer.concat(parts), gitContentType('upload-pack', 'result'));
    return;
  }
  // Protocol v0: ACK/NAK + shallow lines, then sideband pack.
  const parts: Buffer[] = [];
  if (acks.length > 0) {
    for (const a of acks) parts.push(encodePktLine(`ACK ${a}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const s of shallow) parts.push(encodePktLine(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(encodePktLine(`unshallow ${u}\n`));
  if (pack) {
    for (const p of sidebandChunks(pack, 1)) parts.push(p);
  }
  parts.push(FLUSH_PKT);
  replyBytes(res, 200, Buffer.concat(parts), gitContentType('upload-pack', 'result'));
}

/** Run a fetch (v0 or v2) from parsed argument lines. */
function serveFetch(
  forge: Forge,
  repo: Repository,
  res: ServerResponse,
  args: string[],
  protocol: 0 | 2,
): void {
  const plan = parseFetchLines(args);
  sendPackResponse(forge, repo, plan, protocol, res);
}

/** Upload-pack protocol v0: wants (+ shallow/deepen), flush, haves + done, flush. */
function serveUploadPackV0(forge: Forge, repo: Repository, res: ServerResponse, body: Buffer): void {
  const first = decodePktFramesUntilFlush(body);
  const wantsLines = pktFrameTexts(first.frames);
  const rest = body.subarray(first.consumed);
  const second = decodePktFramesUntilFlush(rest);
  const haveLines = pktFrameTexts(second.frames);
  const plan = parseFetchLines([...wantsLines, ...haveLines]);
  sendPackResponse(forge, repo, plan, 0, res);
}

// ---------------------------------------------------------------- receive-pack

/** POST git-receive-pack: read the commands + pack, store objects, update refs. */
function serveReceivePack(
  forge: Forge,
  repo: Repository,
  _req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): void {
  const first = decodePktFramesUntilFlush(body);
  const lines = pktFrameTexts(first.frames);
  const packBytes = body.subarray(first.consumed);
  interface RefCommand {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: RefCommand[] = [];
  for (const line of lines) {
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const parts = clean.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOidText(oldOid) || !isOidText(newOid)) throw new Error('bad object id in receive-pack command');
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('receive-pack got no commands');
  const needsPack = commands.some((c) => c.newOid !== NIL_OID);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpacker error';
    } else {
      try {
        const objects = decodePack(packBytes, (oid) => forge.fetchObject(repo, oid));
        for (const [oid, obj] of objects) {
          if (!forge.fetchObject(repo, oid)) {
            repo.objects.set(oid, obj);
          }
        }
      } catch (e) {
        unpackOk = false;
        unpackDetail = e instanceof Error ? e.message : 'unpacker error';
      }
    }
  }
  const report: string[] = [];
  if (unpackOk) {
    report.push('unpack ok\n');
  } else {
    report.push(`unpack ${unpackDetail}\n`);
  }
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(`ng ${cmd.ref} unpacker error\n`);
      continue;
    }
    const result = applyRefCommand(forge, repo, cmd);
    if (result.ok) report.push(`ok ${cmd.ref}\n`);
    else report.push(`ng ${cmd.ref} ${result.reason}\n`);
  }
  const reportStream = Buffer.concat([...report.map((l) => encodePktLine(l)), FLUSH_PKT]);
  const parts: Buffer[] = [...sidebandChunks(reportStream, 1), FLUSH_PKT];
  replyBytes(res, 200, Buffer.concat(parts), gitContentType('receive-pack', 'result'));
}

/**
 * Apply one ref update (create / update / delete on a branch or a tag).
 * Updates must be fast-forwards from the advertised old value.
 */
function applyRefCommand(
  forge: Forge,
  repo: Repository,
  cmd: { oldOid: string; newOid: string; ref: string },
): { ok: boolean; reason: string } {
  if (!cmd.ref.startsWith('refs/') || cmd.ref.length > 200 || /[\s\x00-\x1f]/.test(cmd.ref)) {
    return { ok: false, reason: 'invalid ref' };
  }
  if (cmd.ref.startsWith('refs/heads/')) {
    const branch = cmd.ref.slice('refs/heads/'.length);
    const current = repo.refs.get(branch) ?? '';
    if (cmd.newOid === NIL_OID) {
      // Delete.
      if (cmd.oldOid !== NIL_OID && current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
      repo.refs.delete(branch);
      return { ok: true, reason: '' };
    }
    if (cmd.oldOid === NIL_OID) {
      // Create.
      if (current !== '') return { ok: false, reason: 'already exists' };
      if (!forge.fetchObject(repo, cmd.newOid)) return { ok: false, reason: 'object not found' };
      repo.refs.set(branch, cmd.newOid);
      return { ok: true, reason: '' };
    }
    // Update: must be a fast-forward from the advertised old value.
    if (current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
    if (!forge.fetchObject(repo, cmd.newOid)) return { ok: false, reason: 'object not found' };
    if (!forge.isAncestorOf(repo, cmd.oldOid, cmd.newOid)) {
      return { ok: false, reason: 'non-fast-forward' };
    }
    repo.refs.set(branch, cmd.newOid);
    return { ok: true, reason: '' };
  }
  if (cmd.ref.startsWith('refs/tags/')) {
    const tag = cmd.ref.slice('refs/tags/'.length);
    const current = repo.tags.get(tag) ?? '';
    if (cmd.newOid === NIL_OID) {
      if (cmd.oldOid !== NIL_OID && current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
      repo.tags.delete(tag);
      return { ok: true, reason: '' };
    }
    if (cmd.oldOid === NIL_OID) {
      if (current !== '') return { ok: false, reason: 'already exists' };
      if (!forge.fetchObject(repo, cmd.newOid)) return { ok: false, reason: 'object not found' };
      repo.tags.set(tag, cmd.newOid);
      return { ok: true, reason: '' };
    }
    if (current !== cmd.oldOid) return { ok: false, reason: 'non-fast-forward' };
    repo.tags.set(tag, cmd.newOid);
    return { ok: true, reason: '' };
  }
  return { ok: false, reason: 'invalid ref' };
}
