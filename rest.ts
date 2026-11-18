// REST v3 (/api/v3) handlers. Pure functions over the Forge store; the HTTP
// server in app.ts owns transport, auth and body parsing.
//
// Perf notes: GET-one-ticket answers from the ticket's cached response bytes
// (ticketJsonText); the commits endpoint and the pull-request file diff walk
// through the store's memoized commit parses instead of re-parsing.
import { Forge, VIEWER_LOGIN, VIEWER_ID, makeGlobalId, type Repository, type Ticket, type PullRequest } from './store.ts';
import { isOidText } from './git.ts';

/** One REST request: method, decoded path, query, and body. */
export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body (null when no body / not JSON). */
  json: unknown;
  /** Raw body bytes (for contents endpoints). */
  body: Buffer;
  host: string;
}

/** One REST response: status, JSON body (or cached text), optional headers. */
export interface RestResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const respondOk = (status: number, body: unknown, headers?: Record<string, string>): RestResponse => ({ status, body, headers });
const respondErr = (status: number, message: string): RestResponse => respondOk(status, { message });
const respondMissing = (): RestResponse => respondErr(404, 'Not Found');

/** ISO timestamp for logical-clock sequence `seq` (epoch 1735689600 + seq). */
function isoAtSeq(seq: number): string {
  return new Date((1735689600 + seq) * 1000).toISOString();
}

/** The REST shape of a repository. `created_at` and `updated_at` share one seq. */
export function repoPayload(repo: Repository): Record<string, unknown> {
  const iso = isoAtSeq(repo.seq);
  return {
    id: repo.id,
    node_id: repo.globalId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1000 + repo.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: iso,
    updated_at: iso,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

/** The REST shape of a ticket. `created_at` and `updated_at` share one seq. */
export function ticketPayload(ticket: Ticket, repo: Repository): Record<string, unknown> {
  const iso = isoAtSeq(ticket.seq);
  return {
    id: ticket.id,
    node_id: ticket.globalId,
    number: ticket.number,
    title: ticket.title,
    body: ticket.body,
    state: ticket.state,
    labels: ticket.labels.map((name) => ({ name, color: repo.labels.find((l) => l.name === name)?.color ?? 'ededed' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: iso,
    updated_at: iso,
    comments: ticket.notes.length,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${ticket.number}/comments`,
  };
}

/**
 * The GET-one response bytes for a ticket, cached on the ticket. The ticket's
 * serialization depends only on the ticket, its note count and the repo's
 * label colors, so every mutation site (PATCH state, note create, label
 * create, GraphQL close/comment) clears the cache; the cached text is byte
 * for byte what JSON.stringify(ticketPayload(...)) + '\n' produces.
 */
export function ticketJsonText(ticket: Ticket, repo: Repository): string {
  if (ticket.cachedJson !== null) return ticket.cachedJson;
  const text = `${JSON.stringify(ticketPayload(ticket, repo))}\n`;
  ticket.cachedJson = text;
  return text;
}

/** The REST shape of a pull request. `created_at` and `updated_at` share one seq. */
export function pullPayload(pull: PullRequest, repo: Repository): Record<string, unknown> {
  const iso = isoAtSeq(pull.seq);
  const headSha = repo.refs.get(pull.headRef) ?? pull.headSha;
  const baseSha = repo.refs.get(pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: iso,
    updated_at: iso,
  };
}

/** The request's JSON body as an object ({} when it is not one). */
function jsonObjectBody(ctx: RestRequest): Record<string, unknown> {
  if (ctx.json !== null && typeof ctx.json === 'object' && !Array.isArray(ctx.json)) {
    return ctx.json as Record<string, unknown>;
  }
  return {};
}

/** A value as a string, or '' when it is not a string. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Decode a base64 body field; returns null when it is not valid base64 text. */
function decodeBase64Body(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  if (value === '') return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/=\n\r]+$/.test(value)) return null;
  try {
    return Buffer.from(value.replace(/\n/g, ''), 'base64');
  } catch {
    return null;
  }
}

/** Route one REST request to its handler. */
export function handleRestApi(forge: Forge, ctx: RestRequest): RestResponse {
  const { method, segments: s } = ctx;
  const get = method === 'GET';
  const post = method === 'POST';
  const put = method === 'PUT';
  const patch = method === 'PATCH';
  const del = method === 'DELETE';

  // GET /api/v3/ — the API root.
  if (s.length === 0) {
    if (!get) return respondMissing();
    return respondOk(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (s.length === 1 && s[0] === 'meta') {
    if (!get) return respondMissing();
    return respondOk(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (s.length === 1 && s[0] === 'user') {
    if (!get) return respondMissing();
    return respondOk(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' });
  }

  // /api/v3/user/repos
  if (s.length === 2 && s[0] === 'user' && s[1] === 'repos') {
    if (post) {
      const body = jsonObjectBody(ctx);
      const name = asString(body.name);
      if (name === '') return respondErr(422, 'name is required');
      if (forge.findRepo(VIEWER_LOGIN, name)) return respondErr(422, 'Repository already exists');
      const repo = forge.createRepository(VIEWER_LOGIN, name, body.private === true, asString(body.description));
      return respondOk(201, repoPayload(repo));
    }
    if (get) {
      const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '10') || 10));
      const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
      const all = forge.listOwnedRepos();
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < all.length) {
        const next = `http://${ctx.host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        headers.link = `<${next}>; rel="next"`;
      }
      return respondOk(200, slice.map(repoPayload), headers);
    }
    return respondMissing();
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (s.length >= 3 && s[0] === 'repos') {
    const owner = s[1] as string;
    const name = s[2] as string;
    const repo = forge.findRepo(owner, name);
    const rest = s.slice(3);
    // A repository belongs to the token owner; any other owner is 404.
    if (!repo || owner !== VIEWER_LOGIN) return respondMissing();

    if (rest.length === 0) {
      if (get) return respondOk(200, repoPayload(repo));
      if (patch) {
        const body = jsonObjectBody(ctx);
        if (typeof body.description === 'string') repo.description = body.description;
        return respondOk(200, repoPayload(repo));
      }
      if (del) {
        forge.deleteRepository(owner, name);
        return { status: 204, body: '' };
      }
      return respondMissing();
    }

    // git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (post && rest.length === 2) {
        const body = jsonObjectBody(ctx);
        const ref = asString(body.ref);
        const sha = asString(body.sha);
        if (!ref.startsWith('refs/heads/') || !isOidText(sha)) return respondErr(422, 'invalid ref');
        if (!forge.fetchObject(repo, sha)) return respondErr(422, 'unknown sha');
        const branch = ref.slice('refs/heads/'.length);
        repo.refs.set(branch, sha);
        return respondOk(201, { ref, object: { sha } });
      }
      if (get && rest.length >= 3) {
        // GET /git/refs/heads/<branch>
        const ref = rest.slice(2).join('/');
        if (!ref.startsWith('heads/')) return respondMissing();
        const branch = ref.slice('heads/'.length);
        const sha = repo.refs.get(branch);
        if (!sha) return respondMissing();
        return respondOk(200, { ref: `refs/heads/${branch}`, object: { sha } });
      }
      return respondMissing();
    }

    // branches
    if (rest[0] === 'branches') {
      if (get && rest.length === 1) {
        const out: Record<string, unknown>[] = [];
        for (const [branch, sha] of repo.refs) {
          out.push({ name: branch, commit: { sha } });
        }
        out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        return respondOk(200, out);
      }
      if (get && rest.length === 2) {
        const sha = repo.refs.get(rest[1] as string);
        if (!sha) return respondMissing();
        return respondOk(200, { name: rest[1], commit: { sha } });
      }
      return respondMissing();
    }

    // commits
    if (rest[0] === 'commits') {
      if (!get) return respondMissing();
      const refName = ctx.query.get('sha') ?? repo.defaultBranch;
      const tip = forge.resolveReference(repo, refName);
      if (tip === '') return respondOk(200, []);
      const commits = forge.walkHistory(repo, tip).map((oid) => {
        const c = forge.commitView(repo, oid);
        return { sha: oid, commit: { message: c ? c.message : '' } };
      });
      return respondOk(200, commits);
    }

    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const refName = ctx.query.get('ref') ?? repo.defaultBranch;
      if (put) return writeContents(forge, repo, ctx, path, refName);
      if (del) return removeContents(forge, repo, ctx, path, refName);
      if (get) return readContents(forge, repo, path, refName);
      return respondMissing();
    }

    // labels
    if (rest[0] === 'labels') {
      if (post && rest.length === 1) {
        const body = jsonObjectBody(ctx);
        const name = asString(body.name);
        if (name === '') return respondErr(422, 'name is required');
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        const existing = repo.labels.find((l) => l.name === name);
        if (existing) return respondOk(201, { name, color: existing.color });
        repo.labels.push({ name, color });
        forge.dropTicketJson(repo);
        return respondOk(201, { name, color });
      }
      if (get && rest.length === 1) {
        return respondOk(200, repo.labels.map((l) => ({ name: l.name, color: l.color })));
      }
      return respondMissing();
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (post) return createTicket(forge, repo, ctx);
        if (get) return listTickets(forge, repo, ctx);
        return respondMissing();
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) return respondMissing();
      const ticket = repo.tickets.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!ticket) return respondMissing();
        if (get) return respondOk(200, ticketJsonText(ticket, repo));
        if (patch) {
          const body = jsonObjectBody(ctx);
          if (body.state === 'closed') ticket.state = 'closed';
          else if (body.state === 'open') ticket.state = 'open';
          forge.dropTicketJson(repo);
          return respondOk(200, ticketPayload(ticket, repo));
        }
        return respondMissing();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!ticket) return respondMissing();
        if (post) {
          const body = jsonObjectBody(ctx);
          const text = asString(body.body);
          if (text === '') return respondErr(422, 'body is required');
          const id = repo.nextNoteId;
          repo.nextNoteId += 1;
          const { seq } = forge.advanceClock();
          const note = { id, globalId: makeGlobalId('C', id), body: text, seq };
          ticket.notes.push(note);
          forge.dropTicketJson(repo);
          return respondOk(201, { id, node_id: note.globalId, body: text });
        }
        if (get) {
          return respondOk(200, ticket.notes.map((c) => ({ id: c.id, node_id: c.globalId, body: c.body })));
        }
        return respondMissing();
      }
      return respondMissing();
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (post) return createPullRequest(forge, repo, ctx);
        if (get) return listPullRequests(forge, repo, ctx);
        return respondMissing();
      }
      const num = Number(rest[1]);
      if (!Number.isInteger(num)) return respondMissing();
      const pull = repo.pullRequests.find((p) => p.number === num);
      if (rest.length === 2) {
        if (!pull) return respondMissing();
        if (get) return respondOk(200, pullPayload(pull, repo));
        return respondMissing();
      }
      if (rest.length === 3 && rest[2] === 'files') {
        if (!pull) return respondMissing();
        if (!get) return respondMissing();
        return respondOk(200, pullChangedFiles(forge, repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'merge') {
        if (!pull) return respondMissing();
        if (!put) return respondMissing();
        return mergePullRequest(forge, repo, pull, ctx);
      }
      return respondMissing();
    }

    return respondMissing();
  }

  return respondMissing();
}

// ---------------------------------------------------------------- contents

/** PUT /contents/:path — create or update a file (base64 content, new commit). */
function writeContents(forge: Forge, repo: Repository, ctx: RestRequest, path: string, refName: string): RestResponse {
  const body = jsonObjectBody(ctx);
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : refName;
  const content = decodeBase64Body(body.content);
  if (content === null) return respondErr(422, 'content must be base64');
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const tip = repo.refs.get(branch) ?? '';
  const existing = tip === '' ? undefined : forge.lookupPath(repo, forge.treeAtRef(repo, branch), path);
  if (typeof body.sha === 'string' && body.sha !== '') {
    if (!existing || existing.oid !== body.sha) return respondErr(409, 'sha does not match the current file');
  }
  const isUpdate = existing !== undefined;
  const blobOid = forge.storeObject(repo, 'blob', content);
  const baseTree = forge.treeAtRef(repo, branch);
  const newTree = forge.setTreePath(repo, baseTree, path, blobOid);
  const commitOid = forge.createCommit(repo, branch, newTree, message);
  return respondOk(isUpdate ? 200 : 201, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, encoding: 'base64' },
    commit: { sha: commitOid, message },
  });
}

/** DELETE /contents/:path — remove a file (new commit). */
function removeContents(forge: Forge, repo: Repository, ctx: RestRequest, path: string, refName: string): RestResponse {
  const body = jsonObjectBody(ctx);
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : refName;
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const tip = repo.refs.get(branch) ?? '';
  if (tip === '') return respondMissing();
  const existing = forge.lookupPath(repo, forge.treeAtRef(repo, branch), path);
  if (!existing) return respondMissing();
  if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing.oid) {
    return respondErr(409, 'sha does not match the current file');
  }
  const baseTree = forge.treeAtRef(repo, branch);
  const newTree = forge.setTreePath(repo, baseTree, path, null);
  const commitOid = forge.createCommit(repo, branch, newTree, message);
  return respondOk(200, { commit: { sha: commitOid, message } });
}

/** GET /contents/:path — a file (base64), a directory listing, or the root listing. */
function readContents(forge: Forge, repo: Repository, path: string, refName: string): RestResponse {
  const treeOid = forge.treeAtRef(repo, refName);
  if (treeOid === '') return respondMissing();
  if (path === '') {
    const entries = forge.listTreePath(repo, treeOid, '');
    if (!entries) return respondMissing();
    return respondOk(200, entries.map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: e.name,
      sha: e.oid,
    })));
  }
  const entry = forge.lookupPath(repo, treeOid, path);
  if (!entry) return respondMissing();
  if (entry.mode === '40000') {
    const entries = forge.listTreePath(repo, treeOid, path);
    if (!entries) return respondMissing();
    return respondOk(200, entries.map((e) => ({
      type: e.mode === '40000' ? 'dir' : 'file',
      name: e.name,
      path: `${path}/${e.name}`,
      sha: e.oid,
    })));
  }
  const obj = forge.fetchObject(repo, entry.oid);
  if (!obj || obj.kind !== 'blob') return respondMissing();
  return respondOk(200, {
    type: 'file',
    encoding: 'base64',
    content: obj.content.toString('base64'),
    sha: entry.oid,
    size: obj.content.length,
    name: path.split('/').pop() ?? path,
    path,
  });
}

// ---------------------------------------------------------------- issues

/** POST /issues — create a ticket (labels must already exist). */
function createTicket(forge: Forge, repo: Repository, ctx: RestRequest): RestResponse {
  const body = jsonObjectBody(ctx);
  const title = asString(body.title);
  if (title === '') return respondErr(422, 'title is required');
  const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.some((l) => l.name === label)) return respondErr(422, `label ${label} does not exist`);
  }
  const number = repo.nextTicketNumber;
  repo.nextTicketNumber += 1;
  const id = number;
  const { seq } = forge.advanceClock();
  const ticket: Ticket = {
    id,
    globalId: makeGlobalId('I', repo.id * 100000 + number),
    number,
    title,
    body: asString(body.body),
    state: 'open',
    labels,
    seq,
    notes: [],
    cachedJson: null,
  };
  repo.tickets.push(ticket);
  return respondOk(201, ticketPayload(ticket, repo));
}

/** GET /issues — list tickets, filtered by state, sorted by creation seq. */
function listTickets(forge: Forge, repo: Repository, ctx: RestRequest): RestResponse {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let list = repo.tickets.slice();
  if (state !== 'all') list = list.filter((i) => i.state === state);
  if (sort === 'created') {
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  return respondOk(200, list.slice(start, start + perPage).map((i) => ticketPayload(i, repo)));
}

// ---------------------------------------------------------------- pulls

/** POST /pulls — open a pull request between two existing branches. */
function createPullRequest(forge: Forge, repo: Repository, ctx: RestRequest): RestResponse {
  const body = jsonObjectBody(ctx);
  const head = asString(body.head);
  const base = asString(body.base);
  if (head === '' || base === '') return respondErr(422, 'head and base are required');
  const headSha = repo.refs.get(head);
  const baseSha = repo.refs.get(base);
  if (!headSha || !baseSha) return respondErr(422, 'head or base branch does not exist');
  const number = repo.nextPullRequestNumber;
  repo.nextPullRequestNumber += 1;
  const id = number;
  const { seq } = forge.advanceClock();
  const pull: PullRequest = {
    id,
    globalId: makeGlobalId('PR', repo.id * 100000 + number),
    number,
    title: asString(body.title),
    body: asString(body.body),
    state: 'open',
    merged: false,
    mergedAt: '',
    mergeCommitSha: '',
    headRef: head,
    baseRef: base,
    headSha,
    baseSha,
    seq,
  };
  repo.pullRequests.push(pull);
  return respondOk(201, pullPayload(pull, repo));
}

/** GET /pulls — list pull requests, open by default, by number ascending. */
function listPullRequests(forge: Forge, repo: Repository, ctx: RestRequest): RestResponse {
  const state = ctx.query.get('state') ?? 'open';
  let list = repo.pullRequests.slice();
  if (state !== 'all') list = list.filter((p) => p.state === state);
  list.sort((a, b) => a.number - b.number);
  return respondOk(200, list.map((p) => pullPayload(p, repo)));
}

/** GET /pulls/:n/files — the changed files with line counts. */
function pullChangedFiles(forge: Forge, repo: Repository, pull: PullRequest): Record<string, unknown>[] {
  // Diff the trees at the PR's recorded base sha and its head tip.
  const baseTip = pull.baseSha;
  const headTip = forge.resolveReference(repo, `refs/heads/${pull.headRef}`);
  const baseTreeOid = treeOfCommitOid(forge, repo, baseTip);
  const headTreeOid = headTip === '' ? '' : treeOfCommitOid(forge, repo, headTip);
  const diff = forge.diffTreePair(repo, baseTreeOid, headTreeOid);
  const out: Record<string, unknown>[] = [];
  for (const [path, status] of [...diff.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const oldEntry = status === 'added' ? undefined : forge.lookupPath(repo, baseTreeOid, path);
    const newEntry = status === 'deleted' ? undefined : forge.lookupPath(repo, headTreeOid, path);
    const stats = forge.countLineChanges(repo, oldEntry?.oid, newEntry?.oid);
    out.push({
      filename: path,
      status: status === 'modified' ? 'modified' : status,
      additions: stats.additions,
      deletions: stats.deletions,
      changes: stats.additions + stats.deletions,
    });
  }
  return out;
}

/** The tree oid of a commit, or '' when the commit is unknown. */
export function treeOfCommitOid(forge: Forge, repo: Repository, commitOid: string): string {
  return forge.commitView(repo, commitOid)?.tree ?? '';
}

/** Squash-merge a pull request. Returns the merge sha, or an error status/message. */
export function squashMergePull(
  forge: Forge,
  repo: Repository,
  pull: PullRequest,
): { status: number; sha?: string; message: string } {
  if (pull.state !== 'open') return { status: 405, message: 'pull request is not open' };
  const currentBaseTip = repo.refs.get(pull.baseRef) ?? '';
  const headTip = repo.refs.get(pull.headRef) ?? '';
  if (currentBaseTip === '' || headTip === '') return { status: 422, message: 'head or base branch is missing' };
  const headTree = treeOfCommitOid(forge, repo, headTip);
  const baseAtPrTree = treeOfCommitOid(forge, repo, pull.baseSha);
  const baseNowTree = treeOfCommitOid(forge, repo, currentBaseTip);
  const prChanged = forge.diffTreePair(repo, baseAtPrTree, headTree);
  const baseChanged = forge.diffTreePair(repo, baseAtPrTree, baseNowTree);
  for (const path of prChanged.keys()) {
    if (baseChanged.has(path)) return { status: 405, message: 'merge conflict' };
  }
  const { epoch, iso } = forge.advanceClock();
  const person = `${VIEWER_LOGIN} <adaiversen@example.invalid> ${epoch} +0000`;
  const lines = [
    `tree ${headTree}`,
    `parent ${currentBaseTip}`,
    `author ${person}`,
    `committer ${person}`,
    '',
    pull.title === '' ? `Merge pull request #${pull.number}` : pull.title,
  ];
  const content = Buffer.from(lines.join('\n'), 'utf8');
  const mergeSha = forge.storeObject(repo, 'commit', content);
  repo.refs.set(pull.baseRef, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = iso;
  pull.mergeCommitSha = mergeSha;
  return { status: 200, sha: mergeSha, message: `Pull request #${pull.number} merged` };
}

/** True when a pull request would conflict with the current base branch. */
export function pullHasConflict(forge: Forge, repo: Repository, pull: PullRequest): boolean {
  const currentBaseTip = repo.refs.get(pull.baseRef) ?? '';
  const headTip = repo.refs.get(pull.headRef) ?? '';
  if (currentBaseTip === '' || headTip === '' || pull.baseSha === currentBaseTip) return false;
  const headTree = treeOfCommitOid(forge, repo, headTip);
  const baseAtPrTree = treeOfCommitOid(forge, repo, pull.baseSha);
  const baseNowTree = treeOfCommitOid(forge, repo, currentBaseTip);
  const prChanged = forge.diffTreePair(repo, baseAtPrTree, headTree);
  const baseChanged = forge.diffTreePair(repo, baseAtPrTree, baseNowTree);
  for (const path of prChanged.keys()) {
    if (baseChanged.has(path)) return true;
  }
  return false;
}

/** PUT /pulls/:n/merge — squash-merge (merge/rebase methods map to the same squash). */
function mergePullRequest(forge: Forge, repo: Repository, pull: PullRequest, ctx: RestRequest): RestResponse {
  const body = jsonObjectBody(ctx);
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'squash';
  if (method !== 'squash' && method !== 'merge' && method !== 'rebase') {
    return respondErr(422, 'unknown merge_method');
  }
  if (!repo.pullRequests.includes(pull)) return respondMissing();
  const result = squashMergePull(forge, repo, pull);
  if (result.status !== 200 || !result.sha) return respondErr(result.status, result.message);
  return respondOk(200, { sha: result.sha, merged: true, message: result.message });
}
