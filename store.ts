// The forge's in-memory store: repositories, git objects and refs, tickets,
// pull requests, labels and notes. Deterministic: sequence numbers order
// everything; timestamps come from a logical clock, never the wall clock.
//
// Perf notes: parsed git objects are memoized per repository (objects are
// immutable by oid, so a parsed view never goes stale and the cache dies with
// the repository on delete); ticket serializations are cached as exact
// response bytes and dropped by every mutation site (see dropTicketJson).
import {
  computeOid,
  decodeCommit,
  decodeTree,
  encodeTree,
  sortTreeItems,
  decodeTag,
  NIL_OID,
  isOidText,
  type GitRecord,
  type ObjectKind,
  type TreeItem,
  type CommitView,
  type TagView,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

/** A fixed author/committer line for commits this forge creates. */
function forgePersonLine(epochSec: number): string {
  return `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${epochSec} +0000`;
}

/** One repository: its metadata, its git objects and refs, and its tickets. */
export interface Repository {
  id: number;
  globalId: string;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  tickets: Ticket[];
  pullRequests: PullRequest[];
  labels: Label[];
  nextTicketNumber: number;
  nextPullRequestNumber: number;
  nextNoteId: number;
  /** refs/heads/<branch> -> commit oid (or '' when unborn). */
  refs: Map<string, string>;
  /** refs/tags/<tag> -> object oid. */
  tags: Map<string, string>;
  /** oid -> object. */
  objects: Map<string, GitRecord>;
  /** Memoized commit parses (objects are immutable by oid: never stale). */
  commitViews: Map<string, CommitView>;
  /** Memoized tree parses. */
  treeViews: Map<string, TreeItem[]>;
  /** Memoized tag parses. */
  tagViews: Map<string, TagView>;
}

export interface Label {
  name: string;
  color: string;
}

/** An issue ("ticket"): its fields, its labels, and its notes (comments). */
export interface Ticket {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  notes: Note[];
  /** Cached GET-one response text (JSON + '\n'); null when stale/unbuilt. */
  cachedJson: string | null;
}

/** One comment ("note") on a ticket. */
export interface Note {
  id: number;
  globalId: string;
  body: string;
  seq: number;
}

/** A pull request: head/base branches and merge state. */
export interface PullRequest {
  id: number;
  globalId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

/** A stable node id: "<kind>_" + base64url("<kind>:<n>"). */
export function makeGlobalId(kind: string, n: number): string {
  return `${kind}_${Buffer.from(`${kind}:${n}`).toString('base64url')}`;
}

/** The forge itself: every repository plus the logical clock. */
export class Forge {
  repos = new Map<string, Repository>();
  nextRepoId = 1;
  nextObjectSeq = 1;
  seq = 0;
  /** Logical clock: seconds since the scenario epoch, +1 per event. */
  clockSeconds = 1735689600;

  /** Advance the clock by one second and one sequence number. */
  advanceClock(): { epoch: number; iso: string; seq: number } {
    this.clockSeconds += 1;
    this.seq += 1;
    return { epoch: this.clockSeconds, iso: new Date(this.clockSeconds * 1000).toISOString(), seq: this.seq };
  }

  keyOfRepo(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  findRepo(owner: string, name: string): Repository | undefined {
    return this.repos.get(this.keyOfRepo(owner, name));
  }

  createRepository(owner: string, name: string, isPrivate: boolean, description: string): Repository {
    const id = this.nextRepoId;
    this.nextRepoId += 1;
    const repo: Repository = {
      id,
      globalId: makeGlobalId('R', id),
      name,
      owner,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      seq: this.seq,
      tickets: [],
      pullRequests: [],
      labels: [],
      nextTicketNumber: 1,
      nextPullRequestNumber: 1,
      nextNoteId: 1,
      refs: new Map(),
      tags: new Map(),
      objects: new Map(),
      commitViews: new Map(),
      treeViews: new Map(),
      tagViews: new Map(),
    };
    this.repos.set(this.keyOfRepo(owner, name), repo);
    return repo;
  }

  deleteRepository(owner: string, name: string): boolean {
    return this.repos.delete(this.keyOfRepo(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  listOwnedRepos(): Repository[] {
    const owned: Repository[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER_LOGIN) owned.push(repo);
    }
    owned.sort((a, b) => a.id - b.id);
    return owned;
  }

  // ---------------------------------------------------------- git objects

  /** Store an object (deduplicated by oid) and return its oid. */
  storeObject(repo: Repository, kind: ObjectKind, content: Buffer): string {
    const oid = computeOid(kind, content);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { kind, content });
    return oid;
  }

  fetchObject(repo: Repository, oid: string): GitRecord | undefined {
    return repo.objects.get(oid);
  }

  /**
   * Parsed views of a repo's objects, memoized per repo. Git objects are
   * immutable by oid (storeObject never overwrites, receive-pack only adds
   * new oids), so a parsed result stays valid for the repo's lifetime; the
   * caches die with the repo on delete. Callers must not mutate the returned
   * tree array (setTreePath copies it before editing).
   */
  commitView(repo: Repository, oid: string): CommitView | undefined {
    const hit = repo.commitViews.get(oid);
    if (hit) return hit;
    const obj = repo.objects.get(oid);
    if (!obj || obj.kind !== 'commit') return undefined;
    const parsed = decodeCommit(obj.content);
    repo.commitViews.set(oid, parsed);
    return parsed;
  }

  treeView(repo: Repository, oid: string): TreeItem[] | undefined {
    const hit = repo.treeViews.get(oid);
    if (hit) return hit;
    const obj = repo.objects.get(oid);
    if (!obj || obj.kind !== 'tree') return undefined;
    const parsed = decodeTree(obj.content);
    repo.treeViews.set(oid, parsed);
    return parsed;
  }

  tagView(repo: Repository, oid: string): TagView | undefined {
    const hit = repo.tagViews.get(oid);
    if (hit) return hit;
    const obj = repo.objects.get(oid);
    if (!obj || obj.kind !== 'tag') return undefined;
    const parsed = decodeTag(obj.content);
    repo.tagViews.set(oid, parsed);
    return parsed;
  }

  /** Drop every cached ticket serialization in a repo (ticket/note/label change). */
  dropTicketJson(repo: Repository): void {
    for (const ticket of repo.tickets) ticket.cachedJson = null;
  }

  /** All refs of a repo as <refname> -> oid (heads, tags, HEAD resolved separately). */
  allRefEntries(repo: Repository): Map<string, string> {
    const out = new Map<string, string>();
    for (const [name, oid] of repo.refs) out.set(`refs/heads/${name}`, oid);
    for (const [name, oid] of repo.tags) out.set(`refs/tags/${name}`, oid);
    return out;
  }

  /** The oid a ref name resolves to, or '' when it does not exist. */
  resolveReference(repo: Repository, ref: string): string {
    if (ref === 'HEAD') return repo.refs.get(DEFAULT_BRANCH) ?? '';
    if (ref.startsWith('refs/heads/')) return repo.refs.get(ref.slice('refs/heads/'.length)) ?? '';
    if (ref.startsWith('refs/tags/')) {
      const oid = repo.tags.get(ref.slice('refs/tags/'.length)) ?? '';
      if (oid === '') return '';
      const tag = this.tagView(repo, oid);
      if (tag) return tag.object;
      return oid;
    }
    // Bare branch name.
    if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
    return '';
  }

  /** True when `ancestor` is reachable from `descendant` (or equal). */
  isAncestorOf(repo: Repository, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    if (!isOidText(ancestor) || !isOidText(descendant)) return false;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const c = this.commitView(repo, oid);
      if (!c) continue;
      for (const p of c.parents) stack.push(p);
    }
    return false;
  }

  /** Commits reachable from `tip`, newest first (parents after children). */
  walkHistory(repo: Repository, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const pending: string[] = [tip];
    while (pending.length > 0) {
      const oid = pending.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const c = this.commitView(repo, oid);
      if (!c) continue;
      out.push(oid);
      for (const p of c.parents) pending.push(p);
    }
    return out;
  }

  /** Every object reachable from a set of tips (commits, trees, blobs, tags). */
  collectReachable(repo: Repository, tips: string[]): Map<string, GitRecord> {
    const found = new Map<string, GitRecord>();
    const stack: string[] = [...tips];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      found.set(oid, obj);
      if (obj.kind === 'commit') {
        const c = this.commitView(repo, oid);
        if (c) {
          stack.push(c.tree);
          for (const p of c.parents) stack.push(p);
        }
      } else if (obj.kind === 'tree') {
        for (const e of this.treeView(repo, oid) ?? []) stack.push(e.oid);
      } else if (obj.kind === 'tag') {
        const t = this.tagView(repo, oid);
        if (t) stack.push(t.object);
      }
    }
    return found;
  }

  /** Objects reachable from `wants` minus those reachable from `haves`. */
  objectsMinusHaves(repo: Repository, wants: string[], haves: string[]): Map<string, GitRecord> {
    const held = this.collectReachable(repo, haves);
    const wanted = this.collectReachable(repo, wants);
    for (const oid of held.keys()) wanted.delete(oid);
    return wanted;
  }

  /** Haves that are ancestors of (or equal to) the wants: the common base. */
  sharedHaves(repo: Repository, wants: string[], haves: string[]): string[] {
    const ancestorsOfWants = new Set<string>();
    const stack: string[] = [];
    for (const w of wants) {
      // Tag wants peel to their target commit before ancestry is computed.
      const peeled = this.peelTagToCommit(repo, w);
      stack.push(peeled !== '' ? peeled : w);
    }
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (ancestorsOfWants.has(oid)) continue;
      ancestorsOfWants.add(oid);
      const c = this.commitView(repo, oid);
      if (c) {
        for (const p of c.parents) stack.push(p);
      }
    }
    return haves.filter((h) => ancestorsOfWants.has(h));
  }

  /**
   * Distance (1-based, want = 1) from the wants to the deepest reachable
   * shallow boundary, peeling tag wants to their target commits. 0 when no
   * boundary is reachable.
   */
  boundaryDepth(repo: Repository, wants: string[], boundaries: string[]): number {
    const boundarySet = new Set(boundaries);
    const seen = new Set<string>();
    const pending: Array<{ oid: string; d: number }> = [];
    for (const w of wants) {
      const peeled = this.peelTagToCommit(repo, w);
      if (peeled !== '') pending.push({ oid: peeled, d: 1 });
    }
    let best = 0;
    while (pending.length > 0) {
      const { oid, d } = pending.shift() as { oid: string; d: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (boundarySet.has(oid)) best = Math.max(best, d);
      const c = this.commitView(repo, oid);
      if (c) {
        for (const p of c.parents) pending.push({ oid: p, d: d + 1 });
      }
    }
    return best;
  }

  /** Peel a tag (possibly nested) to its target commit oid, or '' if none. */
  peelTagToCommit(repo: Repository, oid: string): string {
    let current = oid;
    for (let i = 0; i < 8; i++) {
      const obj = repo.objects.get(current);
      if (!obj) return '';
      if (obj.kind === 'commit') return current;
      if (obj.kind === 'tag') {
        const t = this.tagView(repo, current);
        if (!t) return '';
        current = t.object;
        continue;
      }
      return '';
    }
    return '';
  }

  /**
   * Depth-limited walk: commits within `depth` steps of `wants` (depth 1 = the
   * want commits only), minus anything reachable from `haves`. Returns the
   * commits to send, the objects to send, and the new shallow boundary oids.
   */
  walkShallow(
    repo: Repository,
    wants: string[],
    haves: string[],
    depth: number,
    shallowBoundaries: string[] = [],
  ): { commits: string[]; objects: Map<string, GitRecord>; shallow: string[] } {
    // A "have" that is also a shallow boundary is held by the client as a
    // commit plus its tree, but NOT its parents: exclude only the commit and
    // its tree from the pack, never its ancestors (a deepen must deliver them).
    const boundarySet = new Set(shallowBoundaries);
    const heldSet = new Set<string>();
    for (const h of haves) {
      const obj = repo.objects.get(h);
      if (boundarySet.has(h) && obj?.kind === 'commit') {
        heldSet.add(h);
        const c = this.commitView(repo, h);
        if (c) {
          for (const [o] of this.collectReachable(repo, [c.tree])) heldSet.add(o);
        }
      } else {
        for (const [o] of this.collectReachable(repo, [h])) heldSet.add(o);
      }
    }
    const commits: string[] = [];
    const shallow: string[] = [];
    const seen = new Set<string>();
    // Tag wants peel to their target commit for the walk; the tag objects
    // themselves are still sent (unless the client already has them).
    const tagWants: string[] = [];
    const roots: Array<{ oid: string; d: number }> = [];
    for (const w of wants) {
      const obj = repo.objects.get(w);
      if (obj?.kind === 'tag') {
        tagWants.push(w);
        const peeled = this.peelTagToCommit(repo, w);
        if (peeled !== '') roots.push({ oid: peeled, d: 1 });
      } else {
        roots.push({ oid: w, d: 1 });
      }
    }
    const pending: Array<{ oid: string; d: number }> = roots;
    while (pending.length > 0) {
      const { oid, d } = pending.shift() as { oid: string; d: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      const c = this.commitView(repo, oid);
      if (!c) continue;
      commits.push(oid);
      if (d >= depth) {
        shallow.push(oid);
        continue;
      }
      for (const p of c.parents) pending.push({ oid: p, d: d + 1 });
    }
    // Only the walked commits and their trees/blobs go in the pack: never
    // leak ancestors' trees through a full reachability walk.
    const objects = new Map<string, GitRecord>();
    for (const tagOid of tagWants) {
      const tagObj = repo.objects.get(tagOid);
      if (tagObj && !heldSet.has(tagOid)) objects.set(tagOid, tagObj);
    }
    for (const oid of commits) {
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (!heldSet.has(oid)) objects.set(oid, obj);
      if (obj.kind === 'commit') {
        const c = this.commitView(repo, oid);
        if (c) {
          for (const [o, tobj] of this.collectReachable(repo, [c.tree])) {
            if (!heldSet.has(o)) objects.set(o, tobj);
          }
        }
      }
    }
    return { commits, objects, shallow };
  }

  /** The tree oid at a ref, or '' when the ref has no commit. */
  treeAtRef(repo: Repository, ref: string): string {
    const tip = this.resolveReference(repo, ref);
    if (tip === '') return '';
    return this.commitView(repo, tip)?.tree ?? '';
  }

  /** Read one path out of a tree (recursive). Returns the blob entry or undefined. */
  lookupPath(repo: Repository, treeOid: string, path: string): TreeItem | undefined {
    if (treeOid === '') return undefined;
    const parts = path.split('/').filter((p) => p !== '');
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const entries = this.treeView(repo, current);
      if (!entries) return undefined;
      const entry = entries.find((e) => e.name === parts[i]);
      if (!entry) return undefined;
      if (i === parts.length - 1) return entry;
      if (entry.mode !== '40000') return undefined;
      current = entry.oid;
    }
    return undefined;
  }

  /** List a directory tree's entries ('' = root). */
  listTreePath(repo: Repository, treeOid: string, path: string): TreeItem[] | undefined {
    if (treeOid === '') return undefined;
    if (path === '' || path === '/') {
      return this.treeView(repo, treeOid);
    }
    const entry = this.lookupPath(repo, treeOid, path);
    if (!entry || entry.mode !== '40000') return undefined;
    return this.treeView(repo, entry.oid);
  }

  /**
   * Build a new tree with `path` set to `blobOid` (or removed when null),
   * starting from `baseTreeOid` ('' for an empty tree). Returns the new tree oid.
   */
  setTreePath(repo: Repository, baseTreeOid: string, path: string, blobOid: string | null): string {
    const parts = path.split('/').filter((p) => p !== '');
    const rebuild = (treeOid: string, depth: number): string => {
      // Copy the cached entries: this function edits the list in place.
      const entries: TreeItem[] = treeOid === '' ? [] : [...(this.treeView(repo, treeOid) ?? [])];
      const name = parts[depth] as string;
      const last = depth === parts.length - 1;
      const idx = entries.findIndex((e) => e.name === name);
      if (last) {
        if (blobOid === null) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode: '100644', name, oid: blobOid };
        } else {
          entries.push({ mode: '100644', name, oid: blobOid });
        }
      } else {
        const child = idx >= 0 ? entries[idx] : undefined;
        const childTree = child && child.mode === '40000' ? child.oid : '';
        const newChild = rebuild(childTree, depth + 1);
        const newChildObj = repo.objects.get(newChild);
        const empty = !newChildObj || (newChildObj.kind === 'tree' && newChildObj.content.length === 0);
        if (empty) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode: '40000', name, oid: newChild };
        } else {
          entries.push({ mode: '40000', name, oid: newChild });
        }
      }
      const sorted = sortTreeItems(entries);
      return this.storeObject(repo, 'tree', encodeTree(sorted));
    };
    return rebuild(baseTreeOid, 0);
  }

  /** Create a commit object on `branch` ('' tip = unborn). Returns the new commit oid. */
  createCommit(repo: Repository, branch: string, treeOid: string, message: string): string {
    const { epoch } = this.advanceClock();
    const parent = repo.refs.get(branch) ?? '';
    const lines: string[] = [`tree ${treeOid}`];
    if (parent !== '' && isOidText(parent)) lines.push(`parent ${parent}`);
    const person = forgePersonLine(epoch);
    lines.push(`author ${person}`, `committer ${person}`, '', message);
    const content = Buffer.from(lines.join('\n'), 'utf8');
    const oid = this.storeObject(repo, 'commit', content);
    repo.refs.set(branch, oid);
    return oid;
  }

  /** Paths changed between two trees (recursive), as filename -> 'added' | 'modified' | 'deleted'. */
  diffTreePair(repo: Repository, oldTree: string, newTree: string): Map<string, 'added' | 'modified' | 'deleted'> {
    const out = new Map<string, 'added' | 'modified' | 'deleted'>();
    const flatten = (treeOid: string, prefix: string, into: Map<string, string>): void => {
      if (treeOid === '') return;
      for (const e of this.treeView(repo, treeOid) ?? []) {
        const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') flatten(e.oid, path, into);
        else into.set(path, e.oid);
      }
    };
    const oldFiles = new Map<string, string>();
    const newFiles = new Map<string, string>();
    flatten(oldTree, '', oldFiles);
    flatten(newTree, '', newFiles);
    for (const [path, oid] of newFiles) {
      if (!oldFiles.has(path)) out.set(path, 'added');
      else if (oldFiles.get(path) !== oid) out.set(path, 'modified');
    }
    for (const path of oldFiles.keys()) {
      if (!newFiles.has(path)) out.set(path, 'deleted');
    }
    return out;
  }

  /** Line counts for a pull-request file entry (multiset diff of lines). */
  countLineChanges(repo: Repository, oldOid: string | undefined, newOid: string | undefined): { additions: number; deletions: number } {
    // Split a blob into lines; missing/non-blob/empty content has no lines.
    const splitLines = (oid: string | undefined): string[] => {
      if (!oid) return [];
      const obj = repo.objects.get(oid);
      if (!obj || obj.kind !== 'blob') return [];
      const text = obj.content.toString('utf8');
      if (text === '') return [];
      return text.split('\n');
    };
    // Count how many copies of each line the new side has beyond the old side.
    const countBeyond = (from: string[], against: string[]): number => {
      const have = new Map<string, number>();
      for (const line of against) have.set(line, (have.get(line) ?? 0) + 1);
      let extra = 0;
      const used = new Map<string, number>();
      for (const line of from) {
        used.set(line, (used.get(line) ?? 0) + 1);
        if ((have.get(line) ?? 0) < (used.get(line) as number)) extra += 1;
      }
      return extra;
    };
    const oldLines = splitLines(oldOid);
    const newLines = splitLines(newOid);
    let additions = countBeyond(newLines, oldLines);
    let deletions = countBeyond(oldLines, newLines);
    if (additions === 0 && deletions === 0 && (oldOid !== newOid)) {
      // Same lines, different bytes (e.g. no trailing newline): count as one change.
      additions = newOid !== undefined && oldOid === undefined ? Math.max(1, newLines.length) : 1;
    }
    return { additions, deletions };
  }
}

export { NIL_OID };
