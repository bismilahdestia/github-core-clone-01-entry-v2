// MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP.
// Speaks the modern 2026-07-28 era (server/discover) and the legacy era
// (initialize + notifications/initialized). Tools act on the same store as REST.
import { Forge, VIEWER_LOGIN, makeGlobalId, type Repository, type Ticket, type PullRequest } from './store.ts';
import { repoPayload, ticketPayload, pullPayload, squashMergePull } from './rest.ts';

const SERVER_NAME = 'makefun-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';

/** The outcome of one MCP request: HTTP status plus JSON body (null = empty 202). */
export interface McpOutcome {
  status: number;
  /** JSON value to send, or null for an empty 202. */
  body: unknown;
}

/** One JSON-RPC 2.0 request object. */
interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: any;
}

/** A successful JSON-RPC reply envelope. */
function okRpc(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/** An error JSON-RPC reply envelope. */
function errorRpc(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** The six tools this server offers, with their input schemas. */
const TOOL_CATALOG: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** Normalize a tool name for matching: lowercase, alphanumerics only. */
function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Find a tool by name, tolerating separators and suffix/prefix matches. */
function lookupTool(name: string): Record<string, unknown> | undefined {
  const want = normalizeToolName(name);
  for (const tool of TOOL_CATALOG) {
    const have = normalizeToolName(String(tool.name));
    if (have === want || have.endsWith(want) || want.endsWith(have)) return tool;
  }
  return undefined;
}

/** The first defined, non-null argument under any of these names. */
function pickArgument(args: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) {
    if (args[n] !== undefined && args[n] !== null) return args[n];
  }
  return undefined;
}

/** Resolve a repository from tool arguments (owner + repo, or full_name). */
function repoFromToolArgs(forge: Forge, args: Record<string, unknown>): Repository | undefined {
  let owner = pickArgument(args, ['owner', 'owner_login', 'org', 'organization', 'user', 'login', 'account', 'namespace']) as string | undefined;
  let repo = pickArgument(args, ['repo', 'repository', 'repository_name', 'repo_name', 'project']) as string | undefined;
  const full = pickArgument(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']) as string | undefined;
  if ((!owner || !repo) && typeof full === 'string') {
    const parts = full.split('/');
    if (parts.length === 2) {
      owner = owner ?? parts[0];
      repo = repo ?? parts[1];
    }
  }
  if (!owner || !repo) return undefined;
  return forge.findRepo(owner, repo);
}

/** A tool result: text content plus the same value as structured content. */
function toolResultText(text: string, structured: unknown, isError = false): Record<string, unknown> {
  const out: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
  if (isError) out.isError = true;
  return out;
}

/** Dispatch one tool call by name. Throws McpFault on bad input. */
function dispatchTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = lookupTool(name);
  if (!tool) throw new McpFault(-32601, `unknown tool ${name}`);
  const toolName = String(tool.name);

  if (toolName === 'create_repo') {
    const repoName = pickArgument(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']) as string | undefined;
    if (!repoName) throw new McpFault(-32602, 'create_repo needs a name');
    const existing = forge.findRepo(VIEWER_LOGIN, repoName);
    const repo = existing ?? forge.createRepository(
      VIEWER_LOGIN,
      repoName,
      pickArgument(args, ['private', 'is_private']) === true,
      (pickArgument(args, ['description', 'about', 'summary', 'body']) as string | undefined) ?? '',
    );
    const out = { ...repoPayload(repo), full_name: `${repo.owner}/${repo.name}` };
    return toolResultText(JSON.stringify(out), out);
  }

  if (toolName === 'get_repo') {
    const repo = repoFromToolArgs(forge, args);
    if (!repo) return toolResultText(JSON.stringify({ error: 'Repository not found' }), { error: 'Repository not found' }, true);
    const out = { ...repoPayload(repo), full_name: `${repo.owner}/${repo.name}` };
    return toolResultText(JSON.stringify(out), out);
  }

  if (toolName === 'create_issue') {
    const repo = repoFromToolArgs(forge, args);
    if (!repo) return toolResultText(JSON.stringify({ error: 'Repository not found' }), { error: 'Repository not found' }, true);
    const title = pickArgument(args, ['title', 'issue_title', 'subject']) as string | undefined;
    if (!title) throw new McpFault(-32602, 'create_issue needs a title');
    const body = (pickArgument(args, ['body', 'issue_body', 'description', 'content', 'text']) as string | undefined) ?? '';
    const number = repo.nextTicketNumber;
    repo.nextTicketNumber += 1;
    const { seq } = forge.advanceClock();
    const ticket: Ticket = {
      id: number,
      globalId: makeGlobalId('I', repo.id * 100000 + number),
      number,
      title,
      body,
      state: 'open',
      labels: [],
      seq,
      notes: [],
      cachedJson: null,
    };
    repo.tickets.push(ticket);
    const out = { ...ticketPayload(ticket, repo), full_name: `${repo.owner}/${repo.name}` };
    return toolResultText(JSON.stringify(out), out);
  }

  if (toolName === 'list_issues') {
    const repo = repoFromToolArgs(forge, args);
    if (!repo) return toolResultText(JSON.stringify({ error: 'Repository not found' }), { error: 'Repository not found' }, true);
    const state = (pickArgument(args, ['state', 'status']) as string | undefined) ?? 'open';
    let list = repo.tickets.slice();
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => a.number - b.number);
    const items = list.map((i) => ({ number: i.number, id: i.globalId, title: i.title, state: i.state, body: i.body }));
    const out = { issues: items };
    return toolResultText(JSON.stringify(out), out);
  }

  if (toolName === 'create_pull_request') {
    const repo = repoFromToolArgs(forge, args);
    if (!repo) return toolResultText(JSON.stringify({ error: 'Repository not found' }), { error: 'Repository not found' }, true);
    const title = pickArgument(args, ['title', 'pr_title', 'pull_request_title', 'subject']) as string | undefined;
    const head = pickArgument(args, ['head', 'head_ref', 'head_branch', 'source', 'source_branch', 'from_branch', 'branch']) as string | undefined;
    const base = pickArgument(args, ['base', 'base_ref', 'base_branch', 'target', 'target_branch', 'into_branch']) as string | undefined;
    if (!title || !head || !base) throw new McpFault(-32602, 'create_pull_request needs title, head and base');
    const headSha = repo.refs.get(head);
    const baseSha = repo.refs.get(base);
    if (!headSha || !baseSha) return toolResultText(JSON.stringify({ error: 'head or base branch does not exist' }), { error: 'head or base branch does not exist' }, true);
    const body = (pickArgument(args, ['body', 'issue_body', 'description', 'content', 'text']) as string | undefined) ?? '';
    const number = repo.nextPullRequestNumber;
    repo.nextPullRequestNumber += 1;
    const { seq } = forge.advanceClock();
    const pull: PullRequest = {
      id: number,
      globalId: makeGlobalId('PR', repo.id * 100000 + number),
      number,
      title,
      body,
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
    const out = { ...pullPayload(pull, repo), full_name: `${repo.owner}/${repo.name}` };
    return toolResultText(JSON.stringify(out), out);
  }

  if (toolName === 'merge_pull_request') {
    const repo = repoFromToolArgs(forge, args);
    if (!repo) return toolResultText(JSON.stringify({ error: 'Repository not found' }), { error: 'Repository not found' }, true);
    const numRaw = pickArgument(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
    const number = typeof numRaw === 'number' ? numRaw : Number(numRaw);
    if (!Number.isInteger(number)) throw new McpFault(-32602, 'merge_pull_request needs a pull_number');
    const pull = repo.pullRequests.find((p) => p.number === number);
    if (!pull) return toolResultText(JSON.stringify({ error: 'Pull request not found' }), { error: 'Pull request not found' }, true);
    const result = squashMergePull(forge, repo, pull);
    if (result.status !== 200 || !result.sha) {
      return toolResultText(JSON.stringify({ error: result.message }), { error: result.message }, true);
    }
    const out = { number: pull.number, merged: true, sha: result.sha };
    return toolResultText(JSON.stringify(out), out);
  }

  throw new McpFault(-32601, `unknown tool ${name}`);
}

/** A tool/JSON-RPC fault carrying its JSON-RPC error code. */
class McpFault extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Handle one POST /mcp request. `raw` is the request body; auth is checked by
 * the caller. Returns the HTTP status and the JSON body (null = empty 202).
 */
export function handleMcpApi(forge: Forge, raw: Buffer): McpOutcome {
  let req: JsonRpcRequest;
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { status: 400, body: errorRpc(null, -32700, 'Parse error: request must be a JSON object') };
    }
    req = parsed as JsonRpcRequest;
  } catch {
    return { status: 400, body: errorRpc(null, -32700, 'Parse error') };
  }

  const method = typeof req.method === 'string' ? req.method : '';
  const id = req.id === undefined ? null : req.id;
  const isNotification = req.id === undefined;

  try {
    if (method === 'server/discover') {
      const result = {
        protocolVersion: MODERN_REVISION,
        supportedVersions: [MODERN_REVISION],
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      };
      return { status: 200, body: okRpc(id, result) };
    }

    if (method === 'initialize') {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
      const result = {
        protocolVersion: version,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: {} },
      };
      return { status: 200, body: okRpc(id, result) };
    }

    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      return { status: 202, body: null };
    }

    if (method === 'ping') {
      return { status: 200, body: okRpc(id, {}) };
    }

    if (method === 'tools/list') {
      // The same array, byte for byte, on every call: TOOL_CATALOG is constant.
      return { status: 200, body: okRpc(id, { tools: TOOL_CATALOG }) };
    }

    if (method === 'tools/call') {
      const params = (req.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (name === '') throw new McpFault(-32602, 'tools/call needs a name');
      // Missing-arguments check: create_issue with no arguments at all.
      if (lookupTool(name)?.name === 'create_issue' && Object.keys(args).length === 0) {
        throw new McpFault(-32602, 'create_issue needs arguments');
      }
      const result = dispatchTool(forge, name, args);
      return { status: 200, body: okRpc(id, result) };
    }

    if (isNotification) return { status: 202, body: null };
    return { status: 200, body: errorRpc(id, -32601, `Method not found: ${method}`) };
  } catch (e) {
    if (e instanceof McpFault) {
      return { status: 200, body: errorRpc(id, e.code, e.message) };
    }
    return { status: 200, body: errorRpc(id, -32603, e instanceof Error ? e.message : String(e)) };
  }
}
