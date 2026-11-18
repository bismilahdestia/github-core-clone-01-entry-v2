// GraphQL v4 (/api/graphql): a small parser for the documents the suite sends,
// plus resolvers over the Forge store. No schema generation, no validation
// beyond unknown-field errors (HTTP 200 with an errors array naming the field).
import { Forge, VIEWER_LOGIN, makeGlobalId, type Repository, type Ticket, type PullRequest } from './store.ts';
import { squashMergePull, pullHasConflict, treeOfCommitOid } from './rest.ts';

// ---------------------------------------------------------------- tokenizer

/** One lexical token of a GraphQL document. */
type LexToken =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string };

/** Split a GraphQL document into tokens (comments and commas are skipped). */
function lexDocument(src: string): LexToken[] {
  const lexemes: LexToken[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      lexemes.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@|&'.includes(ch)) {
      lexemes.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      lexemes.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j += 1;
      const raw = src.slice(i, j);
      if (raw.includes('.') || raw.includes('e') || raw.includes('E')) {
        lexemes.push({ kind: 'float', value: Number(raw) });
      } else {
        lexemes.push({ kind: 'int', value: Number(raw) });
      }
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      lexemes.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return lexemes;
}

// ---------------------------------------------------------------- AST

/** A literal value in a document (variable, scalar, list, or object). */
type AstValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: AstValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: AstValue }> };

/** One field in a selection set, with optional alias, arguments, and sub-selections. */
interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Array<{ name: string; value: AstValue }>;
  selections?: SelectionNode[];
}

/** A fragment spread (inline or named) in a selection set. */
interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

/** One top-level operation (query or mutation) of a document. */
interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  varDefs: Array<{ name: string; type: string; defaultValue?: AstValue }>;
  selections: SelectionNode[];
}

/** Recursive-descent parser over the lexer's tokens. */
class DocumentParser {
  private cursor = 0;
  private readonly lexemes: LexToken[];
  constructor(lexemes: LexToken[]) {
    this.lexemes = lexemes;
  }

  private peekToken(): LexToken | undefined {
    return this.lexemes[this.cursor];
  }

  private takeToken(): LexToken {
    const t = this.lexemes[this.cursor];
    if (!t) throw new Error('unexpected end of GraphQL document');
    this.cursor += 1;
    return t;
  }

  private expectPunctuation(value: string): void {
    const t = this.takeToken();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectIdentifier(value?: string): string {
    const t = this.takeToken();
    if (t.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && t.value !== value) throw new Error(`expected ${value} in GraphQL document`);
    return t.value;
  }

  /** Parse the whole document into its operations. */
  parseOperations(): OperationNode[] {
    const ops: OperationNode[] = [];
    while (this.cursor < this.lexemes.length) {
      const t = this.peekToken() as LexToken;
      if (t.kind === 'punct' && t.value === '{') {
        ops.push({ kind: 'query', varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const kind = this.takeToken().value as 'query' | 'mutation';
        let name: string | undefined;
        const next = this.peekToken();
        if (next && next.kind === 'name') name = this.takeToken().value as string;
        const varDefs = this.parseVariableDefs();
        const selections = this.parseSelectionSet();
        ops.push({ kind, name, varDefs, selections });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(t)} in GraphQL document`);
    }
    return ops;
  }

  private parseVariableDefs(): Array<{ name: string; type: string; defaultValue?: AstValue }> {
    const defs: Array<{ name: string; type: string; defaultValue?: AstValue }> = [];
    const t = this.peekToken();
    if (!t || t.kind !== 'punct' || t.value !== '(') return defs;
    this.takeToken();
    while (true) {
      const next = this.peekToken() as LexToken;
      if (next.kind === 'punct' && next.value === ')') {
        this.takeToken();
        break;
      }
      this.expectPunctuation('$');
      const name = this.expectIdentifier();
      this.expectPunctuation(':');
      const type = this.parseTypeRef();
      let defaultValue: AstValue | undefined;
      const eq = this.peekToken();
      if (eq && eq.kind === 'punct' && eq.value === '=') {
        this.takeToken();
        defaultValue = this.parseLiteralValue();
      }
      defs.push({ name, type, defaultValue });
    }
    return defs;
  }

  private parseTypeRef(): string {
    const t = this.takeToken();
    if (t.kind === 'punct' && t.value === '[') {
      const inner = this.parseTypeRef();
      this.expectPunctuation(']');
      let out = `[${inner}]`;
      const bang = this.peekToken();
      if (bang && bang.kind === 'punct' && bang.value === '!') {
        this.takeToken();
        out += '!';
      }
      return out;
    }
    if (t.kind !== 'name') throw new Error('expected a type name in GraphQL document');
    let out = t.value;
    const bang = this.peekToken();
    if (bang && bang.kind === 'punct' && bang.value === '!') {
      this.takeToken();
      out += '!';
    }
    return out;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunctuation('{');
    const out: SelectionNode[] = [];
    for (;;) {
      const t = this.peekToken() as LexToken;
      if (t.kind === 'punct' && t.value === '}') {
        this.takeToken();
        break;
      }
      out.push(this.parseOneSelection());
    }
    return out;
  }

  private parseOneSelection(): SelectionNode {
    const t = this.peekToken() as LexToken;
    if (t.kind === 'punct' && t.value === '...') {
      this.takeToken();
      const next = this.peekToken();
      if (next && next.kind === 'name' && next.value === 'on') {
        this.takeToken();
        const typeCondition = this.expectIdentifier();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next && next.kind === 'name') {
        // Named fragment spread (not used by the suite); skip its selections.
        this.takeToken();
        return { kind: 'fragment', selections: [] };
      }
      throw new Error('bad fragment spread in GraphQL document');
    }
    const first = this.expectIdentifier();
    let alias: string | undefined;
    let name = first;
    const colon = this.peekToken();
    if (colon && colon.kind === 'punct' && colon.value === ':') {
      this.takeToken();
      alias = first;
      name = this.expectIdentifier();
    }
    const args: Array<{ name: string; value: AstValue }> = [];
    const open = this.peekToken();
    if (open && open.kind === 'punct' && open.value === '(') {
      this.takeToken();
      for (;;) {
        const next = this.peekToken() as LexToken;
        if (next.kind === 'punct' && next.value === ')') {
          this.takeToken();
          break;
        }
        const argName = this.expectIdentifier();
        this.expectPunctuation(':');
        args.push({ name: argName, value: this.parseLiteralValue() });
      }
    }
    let selections: SelectionNode[] | undefined;
    const brace = this.peekToken();
    if (brace && brace.kind === 'punct' && brace.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseLiteralValue(): AstValue {
    const t = this.takeToken();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectIdentifier() };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: AstValue[] = [];
      for (;;) {
        const next = this.peekToken() as LexToken;
        if (next.kind === 'punct' && next.value === ']') {
          this.takeToken();
          break;
        }
        items.push(this.parseLiteralValue());
      }
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: AstValue }> = [];
      for (;;) {
        const next = this.peekToken() as LexToken;
        if (next.kind === 'punct' && next.value === '}') {
          this.takeToken();
          break;
        }
        const name = this.expectIdentifier();
        this.expectPunctuation(':');
        fields.push({ name, value: this.parseLiteralValue() });
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(t)} in GraphQL document`);
  }
}

// ---------------------------------------------------------------- values

/** Resolve a literal AST value against the request's variables. */
function resolveAstValue(value: AstValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((v) => resolveAstValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of value.fields) out[f.name] = resolveAstValue(f.value, variables);
      return out;
    }
  }
}

/** A field's arguments as a name -> resolved value map. */
function fieldArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveAstValue(a.value, variables);
  return out;
}

// ---------------------------------------------------------------- introspection

/** Fields the suite may introspect on each type (for __type queries). */
const KNOWN_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'author', 'createdAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt'],
  SearchType: [],
};

/** Enum values the suite may introspect on each enum type. */
const KNOWN_TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION', 'CODE'],
};

// ---------------------------------------------------------------- execution

/** An error that becomes a GraphQL errors entry (HTTP 200, data null). */
class GraphQLError extends Error {}

/** A resolved node value: its GraphQL type plus its fields. */
interface GraphNode {
  __type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/** A ticket's state as a GraphQL enum value. */
function ticketStateName(state: 'open' | 'closed'): string {
  return state === 'open' ? 'OPEN' : 'CLOSED';
}

/** A pull request's state as a GraphQL enum value (merged wins over closed). */
function pullStateName(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Encode a ticket number as an opaque page cursor. */
function encodePageCursor(n: number): string {
  return Buffer.from(`cursor:${n}`).toString('base64url');
}

/** Decode a page cursor back to a ticket number (null when malformed). */
function decodePageCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

function findRepoByNodeId(forge: Forge, id: unknown): Repository | undefined {
  if (typeof id !== 'string') return undefined;
  for (const repo of forge.repos.values()) {
    if (repo.globalId === id) return repo;
  }
  return undefined;
}

function findTicketByNodeId(forge: Forge, id: unknown): { repo: Repository; ticket: Ticket } | undefined {
  if (typeof id !== 'string') return undefined;
  for (const repo of forge.repos.values()) {
    const ticket = repo.tickets.find((i) => i.globalId === id);
    if (ticket) return { repo, ticket };
  }
  return undefined;
}

function findPullByNodeId(forge: Forge, id: unknown): { repo: Repository; pull: PullRequest } | undefined {
  if (typeof id !== 'string') return undefined;
  for (const repo of forge.repos.values()) {
    const pull = repo.pullRequests.find((p) => p.globalId === id);
    if (pull) return { repo, pull };
  }
  return undefined;
}

function ticketNode(ticket: Ticket): GraphNode {
  return {
    __type: 'Issue',
    id: ticket.globalId,
    number: ticket.number,
    title: ticket.title,
    state: ticketStateName(ticket.state),
    body: ticket.body,
  };
}

function pullRequestNode(forge: Forge, repo: Repository, pull: PullRequest): GraphNode {
  return {
    __type: 'PullRequest',
    id: pull.globalId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullStateName(pull),
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: pullHasConflict(forge, repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    _repo: repo,
    _pull: pull,
  };
}

function repositoryNode(repo: Repository): GraphNode {
  return {
    __type: 'Repository',
    id: repo.globalId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __type: 'User', login: repo.owner },
    defaultBranchRef: { __type: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    _repo: repo,
  };
}

/** Run a selection set against a value of the given type. */
function runSelections(
  forge: Forge,
  type: string,
  value: GraphNode | Record<string, unknown>,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition && sel.typeCondition !== type) continue;
      const nested = runSelections(forge, type, value, sel.selections, variables);
      Object.assign(out, nested);
      continue;
    }
    const key = sel.alias ?? sel.name;
    out[key] = resolveFieldValue(forge, type, value, sel, variables);
  }
  return out;
}

function resolveFieldValue(
  forge: Forge,
  type: string,
  value: GraphNode | Record<string, unknown>,
  field: FieldNode,
  variables: Record<string, unknown>,
): unknown {
  const args = fieldArgs(field, variables);
  const subs = field.selections ?? [];

  if (type === 'Query') {
    if (field.name === 'viewer') {
      const node: GraphNode = { __type: 'User', login: VIEWER_LOGIN };
      return subs.length > 0 ? runSelections(forge, 'User', node, subs, variables) : node;
    }
    if (field.name === 'repository') {
      const repo = forge.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      const node = repositoryNode(repo);
      return subs.length > 0 ? runSelections(forge, 'Repository', node, subs, variables) : node;
    }
    if (field.name === 'node') {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const repo = findRepoByNodeId(forge, id);
      if (repo) {
        const node = repositoryNode(repo);
        return subs.length > 0 ? runSelections(forge, 'Repository', node, subs, variables) : node;
      }
      const ticket = findTicketByNodeId(forge, id);
      if (ticket) {
        const node = ticketNode(ticket.ticket);
        return subs.length > 0 ? runSelections(forge, 'Issue', node, subs, variables) : node;
      }
      const pull = findPullByNodeId(forge, id);
      if (pull) {
        const node = pullRequestNode(forge, pull.repo, pull.pull);
        return subs.length > 0 ? runSelections(forge, 'PullRequest', node, subs, variables) : node;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      const fields = KNOWN_TYPE_FIELDS[name];
      if (fields === undefined) return null;
      const node: GraphNode = {
        __type: '__Type',
        name,
        fields: fields.map((f) => ({ __type: '__Field', name: f })),
        enumValues: (KNOWN_TYPE_ENUMS[name] ?? []).map((n) => ({ __type: '__EnumValue', name: n })),
      };
      return subs.length > 0 ? runSelections(forge, '__Type', node, subs, variables) : node;
    }
    throw new GraphQLError(`Cannot query field "${field.name}" on type "Query".`);
  }

  if (type === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByNodeId(forge, input.repositoryId);
      if (!repo) throw new GraphQLError('createIssue: unknown repositoryId');
      const number = repo.nextTicketNumber;
      repo.nextTicketNumber += 1;
      const { seq } = forge.advanceClock();
      const ticket: Ticket = {
        id: number,
        globalId: makeGlobalId('I', repo.id * 100000 + number),
        number,
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        state: 'open',
        labels: [],
        seq,
        notes: [],
        cachedJson: null,
      };
      repo.tickets.push(ticket);
      const payload: GraphNode = { __type: 'CreateIssuePayload', issue: ticketNode(ticket) };
      return subs.length > 0 ? runSelections(forge, 'CreateIssuePayload', payload, subs, variables) : payload;
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findTicketByNodeId(forge, input.issueId);
      if (!found) throw new GraphQLError('closeIssue: unknown issueId');
      found.ticket.state = 'closed';
      forge.dropTicketJson(found.repo);
      const payload: GraphNode = { __type: 'CloseIssuePayload', issue: ticketNode(found.ticket) };
      return subs.length > 0 ? runSelections(forge, 'CloseIssuePayload', payload, subs, variables) : payload;
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByNodeId(forge, input.repositoryId);
      if (!repo) throw new GraphQLError('createPullRequest: unknown repositoryId');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(head);
      const baseSha = repo.refs.get(base);
      if (!headSha || !baseSha) throw new GraphQLError('createPullRequest: head or base branch does not exist');
      const number = repo.nextPullRequestNumber;
      repo.nextPullRequestNumber += 1;
      const { seq } = forge.advanceClock();
      const pull: PullRequest = {
        id: number,
        globalId: makeGlobalId('PR', repo.id * 100000 + number),
        number,
        title: String(input.title ?? ''),
        body: '',
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
      const payload: GraphNode = { __type: 'CreatePullRequestPayload', pullRequest: pullRequestNode(forge, repo, pull) };
      return subs.length > 0 ? runSelections(forge, 'CreatePullRequestPayload', payload, subs, variables) : payload;
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullByNodeId(forge, input.pullRequestId);
      if (!found) throw new GraphQLError('mergePullRequest: unknown pullRequestId');
      const result = squashMergePull(forge, found.repo, found.pull);
      if (result.status !== 200) throw new GraphQLError(`mergePullRequest: ${result.message}`);
      const payload: GraphNode = { __type: 'MergePullRequestPayload', pullRequest: pullRequestNode(forge, found.repo, found.pull) };
      return subs.length > 0 ? runSelections(forge, 'MergePullRequestPayload', payload, subs, variables) : payload;
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findTicketByNodeId(forge, input.subjectId);
      if (!found) throw new GraphQLError('addComment: unknown subjectId');
      const id = found.repo.nextNoteId;
      found.repo.nextNoteId += 1;
      const { seq } = forge.advanceClock();
      const note = { id, globalId: makeGlobalId('C', id), body: String(input.body ?? ''), seq };
      found.ticket.notes.push(note);
      forge.dropTicketJson(found.repo);
      const node: GraphNode = { __type: 'IssueComment', id: note.globalId, body: note.body };
      const edge: GraphNode = { __type: 'IssueCommentEdge', node };
      const payload: GraphNode = { __type: 'AddCommentPayload', commentEdge: edge };
      return subs.length > 0 ? runSelections(forge, 'AddCommentPayload', payload, subs, variables) : payload;
    }
    throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`);
  }

  if (type === 'Repository') {
    const repo = (value as GraphNode)._repo as Repository;
    if (field.name === 'issue') {
      const ticket = repo.tickets.find((i) => i.number === Number(args.number));
      if (!ticket) return null;
      const node = ticketNode(ticket);
      return subs.length > 0 ? runSelections(forge, 'Issue', node, subs, variables) : node;
    }
    if (field.name === 'issues') {
      let list = repo.tickets.slice();
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        list = list.filter((i) => states.includes(ticketStateName(i.state)));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'DESC');
      list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      const afterNum = decodePageCursor(args.after);
      if (afterNum !== null) {
        // DESC order: keep tickets with a smaller number than the cursor's.
        list = direction === 'ASC' ? list.filter((i) => i.number > afterNum) : list.filter((i) => i.number < afterNum);
      }
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      const hasNext = list.length > page.length;
      const endCursor = page.length > 0 ? encodePageCursor(page[page.length - 1]?.number ?? 0) : null;
      const conn: GraphNode = {
        __type: 'IssueConnection',
        nodes: page.map((i) => ticketNode(i)),
        pageInfo: { __type: 'PageInfo', hasNextPage: hasNext, endCursor },
      };
      if (subs.length === 0) return conn;
      // Expand nested selections (nodes / pageInfo) manually.
      const out: Record<string, unknown> = {};
      for (const s of subs) {
        if (s.kind !== 'field') continue;
        if (s.name === 'nodes') {
          out[s.alias ?? 'nodes'] = conn.nodes.map((n: GraphNode) => runSelections(forge, 'Issue', n, s.selections ?? [], variables));
        } else if (s.name === 'pageInfo') {
          out[s.alias ?? 'pageInfo'] = runSelections(forge, 'PageInfo', conn.pageInfo, s.selections ?? [], variables);
        } else if (s.name === 'totalCount') {
          out[s.alias ?? 'totalCount'] = list.length;
        } else {
          throw new GraphQLError(`Cannot query field "${s.name}" on type "IssueConnection".`);
        }
      }
      return out;
    }
    if (field.name === 'pullRequests') {
      let list = repo.pullRequests.slice();
      list.sort((a, b) => b.seq - a.seq);
      const first = typeof args.first === 'number' ? args.first : list.length;
      const page = list.slice(0, first);
      const conn: GraphNode = {
        __type: 'PullRequestConnection',
        nodes: page.map((p) => pullRequestNode(forge, repo, p)),
        pageInfo: { __type: 'PageInfo', hasNextPage: list.length > page.length, endCursor: null },
      };
      if (subs.length === 0) return conn;
      const out: Record<string, unknown> = {};
      for (const s of subs) {
        if (s.kind !== 'field') continue;
        if (s.name === 'nodes') {
          out[s.alias ?? 'nodes'] = conn.nodes.map((n: GraphNode) => runSelections(forge, 'PullRequest', n, s.selections ?? [], variables));
        } else if (s.name === 'pageInfo') {
          out[s.alias ?? 'pageInfo'] = runSelections(forge, 'PageInfo', conn.pageInfo, s.selections ?? [], variables);
        } else {
          throw new GraphQLError(`Cannot query field "${s.name}" on type "PullRequestConnection".`);
        }
      }
      return out;
    }
    if (field.name === 'pullRequest') {
      const pull = repo.pullRequests.find((p) => p.number === Number(args.number));
      if (!pull) return null;
      const node = pullRequestNode(forge, repo, pull);
      return subs.length > 0 ? runSelections(forge, 'PullRequest', node, subs, variables) : node;
    }
    if (field.name === 'owner') {
      const node: GraphNode = { __type: 'User', login: repo.owner };
      return subs.length > 0 ? runSelections(forge, 'User', node, subs, variables) : node;
    }
    if (field.name === 'defaultBranchRef') {
      const node: GraphNode = { __type: 'Ref', name: repo.defaultBranch };
      return subs.length > 0 ? runSelections(forge, 'Ref', node, subs, variables) : node;
    }
    const scalar: Record<string, unknown> = {
      id: repo.globalId,
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: `${repo.owner}/${repo.name}`,
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
      description: repo.description,
    };
    if (field.name in scalar) {
      if (subs.length > 0) throw new GraphQLError(`Field "${field.name}" on type "Repository" must not have a selection set.`);
      return scalar[field.name];
    }
    throw new GraphQLError(`Cannot query field "${field.name}" on type "Repository".`);
  }

  if (type === 'PullRequest') {
    const node = value as GraphNode;
    if (field.name === 'files') {
      const repo = node._repo as Repository;
      const pull = node._pull as PullRequest;
      const baseTree = treeOfCommitOid(forge, repo, pull.baseSha);
      const headTip = forge.resolveReference(repo, `refs/heads/${pull.headRef}`);
      const headTree = headTip === '' ? '' : treeOfCommitOid(forge, repo, headTip);
      const diff = forge.diffTreePair(repo, baseTree, headTree);
      const first = typeof args.first === 'number' ? args.first : diff.size;
      const paths = [...diff.keys()].sort().slice(0, first);
      const conn: GraphNode = {
        __type: 'PullRequestChangedFileConnection',
        nodes: paths.map((p) => ({ __type: 'PullRequestChangedFile', path: p })),
      };
      if (subs.length === 0) return conn;
      const out: Record<string, unknown> = {};
      for (const s of subs) {
        if (s.kind !== 'field') continue;
        if (s.name === 'nodes') {
          out[s.alias ?? 'nodes'] = conn.nodes.map((n: GraphNode) => runSelections(forge, 'PullRequestChangedFile', n, s.selections ?? [], variables));
        } else {
          throw new GraphQLError(`Cannot query field "${s.name}" on type "PullRequestChangedFileConnection".`);
        }
      }
      return out;
    }
    const scalar: Record<string, unknown> = {
      id: node.id,
      number: node.number,
      title: node.title,
      body: node.body,
      state: node.state,
      merged: node.merged,
      headRefName: node.headRefName,
      baseRefName: node.baseRefName,
      mergeable: node.mergeable,
    };
    if (field.name in scalar) return scalar[field.name];
    throw new GraphQLError(`Cannot query field "${field.name}" on type "PullRequest".`);
  }

  // Leaf / passthrough types: scalar fields live on the value itself.
  const record = value as Record<string, unknown>;
  if (field.name in record) {
    const v = record[field.name];
    if (subs.length > 0) {
      if (Array.isArray(v)) {
        return v.map((el) => {
          if (el !== null && typeof el === 'object') {
            const childType = (el as GraphNode).__type ?? type;
            return runSelections(forge, childType, el as GraphNode, subs, variables);
          }
          return el;
        });
      }
      if (v !== null && typeof v === 'object') {
        const childType = (v as GraphNode).__type ?? type;
        return runSelections(forge, childType, v as GraphNode, subs, variables);
      }
      throw new GraphQLError(`Field "${field.name}" on type "${type}" must not have a selection set.`);
    }
    return v;
  }
  throw new GraphQLError(`Cannot query field "${field.name}" on type "${type}".`);
}

/** The result of one operation: data, plus errors when the operation failed. */
export interface GraphqlOutcome {
  data: unknown;
  errors?: Array<{ message: string }>;
}

function runOperation(forge: Forge, op: OperationNode, variables: Record<string, unknown>): GraphqlOutcome {
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GraphNode = { __type: rootType };
  try {
    const data = runSelections(forge, rootType, root, op.selections, variables);
    return { data };
  } catch (e) {
    if (e instanceof GraphQLError) {
      return { data: null, errors: [{ message: e.message }] };
    }
    throw e;
  }
}

/** Execute one GraphQL request body (object or array of operations). */
export function handleGraphqlApi(forge: Forge, body: unknown): unknown {
  // Shared runner: parse the document, pick the operation, run it.
  const runOne = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return { data: null, errors: [{ message: 'request is not an object' }] };
    const rec = item as Record<string, unknown>;
    const query = typeof rec.query === 'string' ? rec.query : '';
    const variables = (rec.variables ?? {}) as Record<string, unknown>;
    try {
      const ops = new DocumentParser(lexDocument(query)).parseOperations();
      const op = pickOperation(ops, typeof rec.operationName === 'string' ? rec.operationName : undefined);
      if (!op) return { data: null, errors: [{ message: 'no operation found' }] };
      return runOperation(forge, op, variables);
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
  };
  if (Array.isArray(body)) return body.map(runOne);
  if (body === null || typeof body !== 'object') {
    return { data: null, errors: [{ message: 'request body must be a JSON object' }] };
  }
  return runOne(body);
}

/** Pick the named operation, or the first one when no name is given. */
function pickOperation(ops: OperationNode[], name: string | undefined): OperationNode | undefined {
  if (ops.length === 0) return undefined;
  if (name !== undefined) return ops.find((o) => o.name === name);
  return ops[0];
}
