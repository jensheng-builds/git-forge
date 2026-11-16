// graphql.ts — the slice of GitHub's GraphQL v4 the forge answers.
//
// The suite speaks a fixed dialect: viewer, repository lookups, issue and
// pull-request connections with cursor pagination, node(id:) round-trips,
// __type introspection, batched requests, and five mutations that act on
// the same store as REST. This is a small hand-written parser and executor
// for exactly that surface — no GraphQL library, no schema file at runtime.

import { Buffer } from 'node:buffer';
import { buildCommitData, threeWayMerge } from './store.ts';
import type { Forge, IssueRec, PullRec, Repo } from './store.ts';

// ------------------------------------------------------------------ syntax

type Value =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Map<string, Value>;
  selections: FieldNode[] | null; // null for a leaf field
  typeCondition: string | null; // set on inline fragments, name unused
  fragment: boolean;
}

interface Document {
  operation: 'query' | 'mutation';
  selections: FieldNode[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:$=!@|'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push(`str:${source.slice(i + 3, end)}`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push(`str:${value}`);
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push(`num:${source.slice(i, j)}`);
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

class Parser {
  private position = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.position];
  }

  private take(): string {
    const token = this.tokens[this.position];
    if (token === undefined) throw new Error('unexpected end of document');
    this.position += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.take();
    if (got !== token) throw new Error(`expected ${token}, found ${got}`);
  }

  parseDocument(): Document {
    let operation: 'query' | 'mutation' = 'query';
    const head = this.peek();
    if (head === 'query' || head === 'mutation') {
      operation = this.take() as 'query' | 'mutation';
      // Optional operation name, then an optional variable definition list.
      const next = this.peek();
      if (next !== undefined && next !== '{' && next !== '(') this.take();
      if (this.peek() === '(') this.skipBalanced('(', ')');
    } else if (head === 'fragment') {
      throw new Error('named fragments are not supported');
    }
    const selections = this.parseSelectionSet();
    return { operation, selections };
  }

  private skipBalanced(open: string, close: string): void {
    this.expect(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.take();
      if (token === open) depth += 1;
      else if (token === close) depth -= 1;
    }
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): FieldNode {
    if (this.peek() === '...') {
      this.take();
      // Inline fragment: "... on Type { ... }". Named spreads unsupported.
      if (this.peek() === 'on') {
        this.take();
        const condition = this.take();
        const selections = this.parseSelectionSet();
        return { name: '', alias: null, args: new Map(), selections, typeCondition: condition, fragment: true };
      }
      throw new Error('fragment spreads are not supported');
    }
    let name = this.take();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.take();
      alias = name;
      name = this.take();
    }
    const args = new Map<string, Value>();
    if (this.peek() === '(') {
      this.take();
      while (this.peek() !== ')') {
        const argName = this.take();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
      this.expect(')');
    }
    // Directives are skipped: the suite does not use any with semantics.
    while (this.peek() === '@') {
      this.take();
      this.take();
      if (this.peek() === '(') this.skipBalanced('(', ')');
    }
    const selections = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { name, alias, args, selections, typeCondition: null, fragment: false };
  }

  private parseValue(): Value {
    const token = this.take();
    if (token === '$') return { kind: 'variable', name: this.take() };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, Value>();
      while (this.peek() !== '}') {
        const key = this.take();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('str:')) return { kind: 'string', value: token.slice(4) };
    if (token.startsWith('num:')) {
      const raw = token.slice(4);
      return raw.includes('.') || raw.includes('e') || raw.includes('E')
        ? { kind: 'float', value: Number(raw) }
        : { kind: 'int', value: Number(raw) };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    return { kind: 'enum', value: token };
  }
}

// ------------------------------------------------------------------ value resolution

type Vars = Record<string, unknown>;

function resolve(value: Value | undefined, vars: Vars): unknown {
  if (value === undefined) return undefined;
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'variable':
      return vars[value.name];
    case 'list':
      return value.items.map((item) => resolve(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = resolve(item, vars);
      return out;
    }
  }
}

function argString(field: FieldNode, name: string, vars: Vars): string | undefined {
  const value = resolve(field.args.get(name), vars);
  return typeof value === 'string' ? value : undefined;
}

function argInt(field: FieldNode, name: string, vars: Vars): number | undefined {
  const value = resolve(field.args.get(name), vars);
  return typeof value === 'number' ? value : undefined;
}

// ------------------------------------------------------------------ global ids

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; key: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return null;
    return { type: decoded.slice(0, colon), key: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ schema description for introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate',
    'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled',
    'hasWikiEnabled', 'isArchived', 'isFork', 'isTemplate', 'createdAt', 'updatedAt',
    'pushedAt', 'url', 'sshUrl', 'cloneUrl', 'homepageUrl', 'stargazerCount',
    'forkCount', 'watchers', 'issues', 'issue', 'pullRequests', 'pullRequest',
    'labels', 'refs', 'ref', 'object', 'assignableUsers', 'mentionableUsers',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'closed', 'locked',
    'author', 'repository', 'labels', 'comments', 'assignees', 'createdAt',
    'updatedAt', 'closedAt', 'url', 'viewerDidAuthor',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt',
    'mergeCommit', 'author', 'repository', 'labels', 'comments', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'mergeable', 'isDraft', 'additions',
    'deletions', 'changedFiles', 'files', 'createdAt', 'updatedAt', 'closedAt', 'url',
  ],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'isViewer'],
  Label: ['id', 'name', 'color', 'description'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['id', 'name', 'prefix', 'target'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'author', 'committedDate', 'tree'],
  Blob: ['id', 'oid', 'isTruncated', 'byteSize', 'text'],
  Tree: ['id', 'oid', 'entries'],
  TreeEntry: ['name', 'path', 'mode', 'type', 'object'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'url'],
  SearchType: [],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  State: ['OPEN', 'CLOSED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  FileStatus: ['ADDED', 'CHANGED', 'COPIED', 'DELETED', 'MODIFIED', 'REMOVED', 'RENAMED'],
};

const TYPE_KINDS: Record<string, string> = {
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  RepositoryPermission: 'ENUM',
  OrderDirection: 'ENUM',
  IssueOrderField: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  FileStatus: 'ENUM',
};

// ------------------------------------------------------------------ execution

interface Ctx {
  forge: Forge;
  vars: Vars;
  errors: { message: string }[];
}

interface NodeRef {
  __typename: string;
  repo?: Repo;
  issue?: IssueRec;
  pull?: PullRec;
}

function issueNode(repo: Repo, issue: IssueRec): NodeRef {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: PullRec): NodeRef {
  return { __typename: 'PullRequest', repo, pull };
}

function repoNode(repo: Repo): NodeRef {
  return { __typename: 'Repository', repo };
}

function viewerNode(): NodeRef {
  return { __typename: 'User' };
}

/** Encode a connection cursor: an opaque string carrying the item's number. */
function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function isoFromSeq(seq: number): string {
  return new Date(1735689600000 + seq * 61000).toISOString();
}

function executeSelections(ctx: Ctx, node: NodeRef | null, selections: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selections) {
    if (field.fragment) {
      if (node !== null && field.typeCondition !== null && node.__typename !== field.typeCondition) continue;
      const merged = executeSelections(ctx, node, field.selections ?? []);
      Object.assign(out, merged);
      continue;
    }
    const key = field.alias ?? field.name;
    out[key] = executeField(ctx, node, field);
  }
  return out;
}

function sub(ctx: Ctx, node: NodeRef | null, field: FieldNode): Record<string, unknown> | null {
  if (field.selections === null) return null;
  return executeSelections(ctx, node, field.selections);
}

function unknownField(ctx: Ctx, typeName: string, field: FieldNode): null {
  ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
  return null;
}

function executeField(ctx: Ctx, node: NodeRef | null, field: FieldNode): unknown {
  const { forge, vars } = ctx;
  if (field.name === '__typename') return node === null ? 'Query' : node.__typename;
  if (field.name === '__type') {
    const name = argString(field, 'name', vars) ?? '';
    const fields = TYPE_FIELDS[name];
    if (fields === undefined && TYPE_KINDS[name] === undefined) return null;
    const pseudo: NodeRef = { __typename: '__Type', repo: undefined };
    return executeType(ctx, name, field);
    void pseudo;
  }
  if (field.name === '__schema') {
    return { types: Object.keys(TYPE_FIELDS).map((name) => ({ name })) };
  }

  if (node === null || node.__typename === 'Query') return executeQueryField(ctx, field);
  switch (node.__typename) {
    case 'Repository':
      return executeRepositoryField(ctx, node.repo as Repo, field);
    case 'Issue':
      return executeIssueField(ctx, node, field);
    case 'PullRequest':
      return executePullField(ctx, node, field);
    case 'User':
      return executeUserField(ctx, field);
    default:
      return unknownField(ctx, node.__typename, field);
  }
}

function executeType(ctx: Ctx, typeName: string, field: FieldNode): unknown {
  const out: Record<string, unknown> = {};
  for (const selection of field.selections ?? []) {
    if (selection.fragment) continue;
    const key = selection.alias ?? selection.name;
    switch (selection.name) {
      case 'name':
        out[key] = typeName;
        break;
      case 'kind':
        out[key] = TYPE_KINDS[typeName] ?? (TYPE_FIELDS[typeName] !== undefined ? 'OBJECT' : 'OBJECT');
        break;
      case 'fields': {
        const names = TYPE_FIELDS[typeName] ?? [];
        out[key] = names.map((name) => ({ name }));
        break;
      }
      case 'enumValues': {
        const values = ENUM_VALUES[typeName] ?? [];
        out[key] = values.map((name) => ({ name }));
        break;
      }
      case 'description':
        out[key] = null;
        break;
      default:
        out[key] = null;
    }
  }
  return out;
}

function executeQueryField(ctx: Ctx, field: FieldNode): unknown {
  const { forge, vars } = ctx;
  switch (field.name) {
    case 'viewer': {
      const node: NodeRef = { __typename: 'User' };
      return sub(ctx, node, field) ?? {};
    }
    case 'repository': {
      const owner = argString(field, 'owner', vars);
      const name = argString(field, 'name', vars);
      if (owner === undefined || name === undefined) return null;
      const repo = forge.repoFor(owner, name);
      if (repo === undefined) return null;
      return sub(ctx, repoNode(repo), field);
    }
    case 'node': {
      const id = argString(field, 'id', vars);
      if (id === undefined) return null;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number(parsed.key));
        if (repo === undefined) return null;
        return sub(ctx, repoNode(repo), field);
      }
      if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
        const [repoIdRaw, numberRaw] = parsed.key.split(':');
        const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number(repoIdRaw));
        if (repo === undefined) return null;
        const number = Number(numberRaw);
        if (parsed.type === 'Issue') {
          const issue = repo.issueByNumber(number);
          return issue === undefined ? null : sub(ctx, issueNode(repo, issue), field);
        }
        const pull = repo.pullByNumber(number);
        return pull === undefined ? null : sub(ctx, pullNode(repo, pull), field);
      }
      if (parsed.type === 'User') return sub(ctx, viewerNode(), field);
      return null;
    }
    case 'rateLimit':
      return { limit: 5000, cost: 1, remaining: 4999, resetAt: '2030-01-01T00:00:00Z' };
    default:
      return unknownField(ctx, 'Query', field);
  }
}

function executeUserField(ctx: Ctx, field: FieldNode): unknown {
  const { forge } = ctx;
  switch (field.name) {
    case 'login':
      return forge.viewerLogin ?? '';
    case 'id':
      return globalId('User', '1');
    case 'databaseId':
      return 1;
    case 'name':
      return forge.viewerLogin ?? '';
    case 'email':
      return '';
    case 'isViewer':
      return true;
    case 'url':
      return '';
    case 'avatarUrl':
      return '';
    default:
      return unknownField(ctx, 'User', field);
  }
}

function paginate<T extends { number: number }>(items: T[], field: FieldNode, vars: Vars, descending: boolean): T[] {
  let list = [...items];
  if (descending) list.sort((a, b) => b.number - a.number);
  else list.sort((a, b) => a.number - b.number);
  const after = argString(field, 'after', vars);
  if (after !== undefined) {
    const pivot = cursorNumber(after);
    if (pivot !== null) {
      list = descending ? list.filter((item) => item.number < pivot) : list.filter((item) => item.number > pivot);
    }
  }
  const first = argInt(field, 'first', vars);
  if (first !== undefined) list = list.slice(0, first);
  const last = argInt(field, 'last', vars);
  if (last !== undefined) list = list.slice(Math.max(0, list.length - last));
  return list;
}

function connection<T extends { number: number }>(
  ctx: Ctx,
  all: T[],
  field: FieldNode,
  vars: Vars,
  descending: boolean,
  wrap: (item: T) => NodeRef,
): Record<string, unknown> {
  const page = paginate(all, field, vars, descending);
  const out: Record<string, unknown> = {};
  for (const selection of field.selections ?? []) {
    if (selection.fragment) continue;
    const key = selection.alias ?? selection.name;
    if (selection.name === 'nodes') {
      out[key] = page.map((item) => (selection.selections === null ? null : executeSelections(ctx, wrap(item), selection.selections)));
    } else if (selection.name === 'edges') {
      out[key] = page.map((item) => ({
        cursor: cursorOf(item.number),
        node: selection.selections === null ? null : executeSelections(ctx, wrap(item), findNodeSelections(selection.selections)),
      }));
    } else if (selection.name === 'pageInfo') {
      const full = descending ? [...all].sort((a, b) => b.number - a.number) : [...all].sort((a, b) => a.number - b.number);
      const hasNext = page.length > 0 && full.length > 0 && page[page.length - 1] !== full[full.length - 1]
        ? remainingAfter(full, page, descending)
        : false;
      out[key] = {
        hasNextPage: hasNext,
        hasPreviousPage: false,
        startCursor: page.length > 0 ? cursorOf((page[0] as T).number) : null,
        endCursor: page.length > 0 ? cursorOf((page[page.length - 1] as T).number) : null,
      };
    } else if (selection.name === 'totalCount') {
      out[key] = all.length;
    }
  }
  return out;
}

function remainingAfter<T extends { number: number }>(full: T[], page: T[], descending: boolean): boolean {
  if (page.length === 0) return false;
  const last = page[page.length - 1] as T;
  const index = full.findIndex((item) => item.number === last.number);
  return index >= 0 && index < full.length - 1;
  void descending;
}

function findNodeSelections(selections: FieldNode[]): FieldNode[] {
  for (const selection of selections) {
    if (selection.name === 'node') return selection.selections ?? [];
  }
  return [];
}

function executeRepositoryField(ctx: Ctx, repo: Repo, field: FieldNode): unknown {
  const { forge, vars } = ctx;
  switch (field.name) {
    case 'id':
      return globalId('Repository', String(repo.id));
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${forge.viewerLogin ?? ''}/${repo.name}`;
    case 'owner':
      return sub(ctx, viewerNode(), field) ?? {};
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.isPrivate;
    case 'defaultBranchRef': {
      const name = repo.defaultBranch;
      const target = repo.refs.get(`refs/heads/${name}`);
      if (field.selections === null) return { name };
      const out: Record<string, unknown> = {};
      for (const selection of field.selections) {
        if (selection.name === 'name') out[selection.alias ?? 'name'] = name;
        else if (selection.name === 'prefix') out[selection.alias ?? 'prefix'] = 'refs/heads/';
        else if (selection.name === 'target') {
          out[selection.alias ?? 'target'] = target === undefined ? null : { oid: target };
        } else if (selection.name === 'id') out[selection.alias ?? 'id'] = globalId('Ref', `${repo.id}:refs/heads/${name}`);
      }
      return out;
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'hasProjectsEnabled':
      return false;
    case 'hasWikiEnabled':
      return false;
    case 'isArchived':
    case 'isFork':
    case 'isTemplate':
      return false;
    case 'stargazerCount':
    case 'forkCount':
      return 0;
    case 'createdAt':
    case 'updatedAt':
    case 'pushedAt':
      return isoFromSeq(repo.id);
    case 'url':
    case 'sshUrl':
    case 'cloneUrl':
    case 'homepageUrl':
      return '';
    case 'issue': {
      const number = argInt(field, 'number', vars);
      const issue = number === undefined ? undefined : repo.issueByNumber(number);
      return issue === undefined ? null : sub(ctx, issueNode(repo, issue), field);
    }
    case 'issues': {
      let items = repo.issues;
      const states = resolve(field.args.get('states'), vars);
      if (Array.isArray(states) && states.length > 0) {
        const wanted = states.map((state) => String(state).toUpperCase());
        items = items.filter((issue) => wanted.includes(issue.state.toUpperCase()));
      }
      const orderBy = resolve(field.args.get('orderBy'), vars) as { direction?: string } | undefined;
      const descending = orderBy?.direction !== 'ASC';
      return connection(ctx, items, field, vars, descending, (issue) => issueNode(repo, issue));
    }
    case 'pullRequest': {
      const number = argInt(field, 'number', vars);
      const pull = number === undefined ? undefined : repo.pullByNumber(number);
      return pull === undefined ? null : sub(ctx, pullNode(repo, pull), field);
    }
    case 'pullRequests': {
      let items = repo.pulls;
      const states = resolve(field.args.get('states'), vars);
      if (Array.isArray(states) && states.length > 0) {
        const wanted = states.map((state) => String(state).toUpperCase());
        items = items.filter((pull) => wanted.includes(pullDisplayState(pull)));
      }
      return connection(ctx, items, field, vars, true, (pull) => pullNode(repo, pull));
    }
    default:
      return unknownField(ctx, 'Repository', field);
  }
}

export function pullDisplayState(pull: PullRec): 'OPEN' | 'CLOSED' | 'MERGED' {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function executeIssueField(ctx: Ctx, node: NodeRef, field: FieldNode): unknown {
  const issue = node.issue as IssueRec;
  const repo = node.repo as Repo;
  switch (field.name) {
    case 'id':
      return globalId('Issue', `${repo.id}:${issue.number}`);
    case 'databaseId':
      return issue.id;
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issue.state.toUpperCase();
    case 'closed':
      return issue.state === 'closed';
    case 'locked':
      return false;
    case 'viewerDidAuthor':
      return true;
    case 'author':
      return sub(ctx, viewerNode(), field) ?? {};
    case 'repository':
      return sub(ctx, repoNode(repo), field);
    case 'labels': {
      const names = issue.labels;
      const out: Record<string, unknown> = {};
      for (const selection of field.selections ?? []) {
        if (selection.name === 'nodes') out[selection.alias ?? 'nodes'] = names.map((name) => ({ name }));
        else if (selection.name === 'totalCount') out[selection.alias ?? 'totalCount'] = names.length;
      }
      return out;
    }
    case 'comments': {
      const out: Record<string, unknown> = {};
      for (const selection of field.selections ?? []) {
        if (selection.name === 'nodes') {
          out[selection.alias ?? 'nodes'] = issue.comments.map((comment) => ({
            id: globalId('IssueComment', String(comment.id)),
            body: comment.body,
          }));
        } else if (selection.name === 'totalCount') out[selection.alias ?? 'totalCount'] = issue.comments.length;
      }
      return out;
    }
    case 'createdAt':
      return isoFromSeq(issue.seq);
    case 'updatedAt':
      return isoFromSeq(issue.seq);
    case 'closedAt':
      return issue.state === 'closed' ? isoFromSeq(issue.seq) : null;
    case 'url':
      return '';
    default:
      return unknownField(ctx, 'Issue', field);
  }
}

function executePullField(ctx: Ctx, node: NodeRef, field: FieldNode): unknown {
  const pull = node.pull as PullRec;
  const repo = node.repo as Repo;
  switch (field.name) {
    case 'id':
      return globalId('PullRequest', `${repo.id}:${pull.number}`);
    case 'databaseId':
      return pull.id;
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pullDisplayState(pull);
    case 'merged':
      return pull.merged;
    case 'mergedAt':
      return pull.mergedAt;
    case 'isDraft':
      return false;
    case 'headRefName':
      return pull.headRef;
    case 'baseRefName':
      return pull.baseRef;
    case 'mergeable':
      return 'UNKNOWN';
    case 'mergeCommit': {
      if (pull.mergeCommitSha === null) return null;
      const out: Record<string, unknown> = {};
      for (const selection of field.selections ?? []) {
        if (selection.name === 'oid') out[selection.alias ?? 'oid'] = pull.mergeCommitSha;
        else if (selection.name === 'id') out[selection.alias ?? 'id'] = globalId('Commit', pull.mergeCommitSha);
      }
      return out;
    }
    case 'author':
      return sub(ctx, viewerNode(), field) ?? {};
    case 'repository':
      return sub(ctx, repoNode(repo), field);
    case 'files': {
      const files = pullFiles(repo, pull);
      const out: Record<string, unknown> = {};
      for (const selection of field.selections ?? []) {
        if (selection.name === 'nodes') {
          out[selection.alias ?? 'nodes'] = files.map((file) => ({
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }));
        } else if (selection.name === 'totalCount') out[selection.alias ?? 'totalCount'] = files.length;
      }
      return out;
    }
    case 'changedFiles': {
      return pullFiles(repo, pull).length;
    }
    case 'additions':
      return pullFiles(repo, pull).reduce((sum, file) => sum + file.additions, 0);
    case 'deletions':
      return pullFiles(repo, pull).reduce((sum, file) => sum + file.deletions, 0);
    case 'createdAt':
      return isoFromSeq(pull.seq);
    case 'updatedAt':
      return isoFromSeq(pull.seq);
    case 'closedAt':
      return pull.state === 'closed' ? isoFromSeq(pull.seq) : null;
    case 'url':
      return '';
    default:
      return unknownField(ctx, 'PullRequest', field);
  }
}

function pullFiles(repo: Repo, pull: PullRec): { filename: string; status: string; additions: number; deletions: number }[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const headCommit = repo.peelToCommit(headTip);
  const baseCommit = repo.peelToCommit(baseTip);
  if (headCommit === undefined || baseCommit === undefined) return [];
  const base = repo.mergeBase(headCommit, baseCommit) ?? baseCommit;
  const fromTree = repo.treeOfCommit(base);
  const toTree = repo.treeOfCommit(headCommit);
  const from = repo.flattenTree(fromTree);
  const to = repo.flattenTree(toTree);
  const out: { filename: string; status: string; additions: number; deletions: number }[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const a = from.get(path);
    const b = to.get(path);
    if (a !== undefined && b !== undefined && a.oid === b.oid) continue;
    const lines = (entry: { oid: string } | undefined): number => {
      if (entry === undefined) return 0;
      const data = repo.getObject(entry.oid)?.data;
      if (data === undefined || data.length === 0) return 0;
      const text = data.toString('utf8');
      return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
    };
    if (a === undefined) out.push({ filename: path, status: 'added', additions: lines(b), deletions: 0 });
    else if (b === undefined) out.push({ filename: path, status: 'removed', additions: 0, deletions: lines(a) });
    else out.push({ filename: path, status: 'modified', additions: lines(b), deletions: lines(a) });
  }
  return out;
}

// ------------------------------------------------------------------ mutations

function inputObject(field: FieldNode, vars: Vars): Record<string, unknown> {
  const input = resolve(field.args.get('input'), vars);
  if (input !== null && typeof input === 'object') return input as Record<string, unknown>;
  // Direct-argument style: treat the field's own args as the input.
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolve(value, vars);
  return out;
}

function repoByGlobalId(forge: Forge, id: unknown): Repo | undefined {
  if (typeof id !== 'string') return undefined;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return undefined;
  return [...forge.repos.values()].find((repo) => repo.id === Number(parsed.key));
}

function payload(ctx: Ctx, field: FieldNode, value: NodeRef | null, payloadKey: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of field.selections ?? []) {
    if (selection.fragment) continue;
    const key = selection.alias ?? selection.name;
    if (selection.name === 'clientMutationId') out[key] = null;
    else if (selection.name === payloadKey) out[key] = value === null ? null : executeSelections(ctx, value, selection.selections ?? []);
    else if (selection.name === 'commentEdge') {
      out[key] = value === null ? null : { node: executeSelections(ctx, value, findNodeSelections(selection.selections ?? [])) };
    } else if (selection.name === 'subject') {
      out[key] = null;
    }
  }
  return out;
}

export function mergePull(repo: Repo, pull: PullRec, method: string): { ok: true; sha: string } | { ok: false; conflict: boolean } {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { ok: false, conflict: false };
  const headCommit = repo.peelToCommit(headTip);
  const baseCommit = repo.peelToCommit(baseTip);
  if (headCommit === undefined || baseCommit === undefined) return { ok: false, conflict: false };
  const base = repo.mergeBase(headCommit, baseCommit) ?? baseCommit;
  const outcome = threeWayMerge(repo, repo.treeOfCommit(base), repo.treeOfCommit(baseCommit), repo.treeOfCommit(headCommit));
  if (!outcome.ok) return { ok: false, conflict: true };
  const ident = repo.ident();
  const message = method === 'SQUASH'
    ? `${pull.title} (#${pull.number})\n\n${pull.body}`.trimEnd()
    : `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
  const parents = method === 'SQUASH' ? [baseCommit] : [baseCommit, headCommit];
  const sha = repo.putObject('commit', buildCommitData({ tree: outcome.tree, parents, author: ident, committer: ident, message }));
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedAt = isoFromSeq(repo.commitSeq + 100000);
  return { ok: true, sha };
}

function executeMutation(ctx: Ctx, field: FieldNode): unknown {
  const { forge, vars } = ctx;
  const input = inputObject(field, vars);
  switch (field.name) {
    case 'createIssue': {
      const repo = repoByGlobalId(forge, input.repositoryId);
      if (repo === undefined) {
        ctx.errors.push({ message: 'repository not found' });
        return payload(ctx, field, null, 'issue');
      }
      const issue: IssueRec = {
        id: forge.nextGlobalId(),
        number: repo.nextNumber++,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        seq: forge.nextSeq(),
      };
      repo.issues.push(issue);
      return payload(ctx, field, issueNode(repo, issue), 'issue');
    }
    case 'closeIssue': {
      const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      if (parsed === null) {
        ctx.errors.push({ message: 'issue not found' });
        return payload(ctx, field, null, 'issue');
      }
      const [repoIdRaw, numberRaw] = parsed.key.split(':');
      const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number(repoIdRaw));
      const issue = repo?.issueByNumber(Number(numberRaw));
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'issue not found' });
        return payload(ctx, field, null, 'issue');
      }
      issue.state = 'closed';
      return payload(ctx, field, issueNode(repo, issue), 'issue');
    }
    case 'createPullRequest': {
      const repo = repoByGlobalId(forge, input.repositoryId);
      const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (repo === undefined || repo.refs.get(`refs/heads/${headRefName}`) === undefined) {
        ctx.errors.push({ message: 'head ref not found' });
        return payload(ctx, field, null, 'pullRequest');
      }
      const pull: PullRec = {
        id: forge.nextGlobalId(),
        number: repo.nextNumber++,
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        headRef: headRefName,
        baseRef: baseRefName,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: forge.nextSeq(),
      };
      repo.pulls.push(pull);
      return payload(ctx, field, pullNode(repo, pull), 'pullRequest');
    }
    case 'mergePullRequest': {
      const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      if (parsed === null) {
        ctx.errors.push({ message: 'pull request not found' });
        return payload(ctx, field, null, 'pullRequest');
      }
      const [repoIdRaw, numberRaw] = parsed.key.split(':');
      const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number(repoIdRaw));
      const pull = repo?.pullByNumber(Number(numberRaw));
      if (repo === undefined || pull === undefined) {
        ctx.errors.push({ message: 'pull request not found' });
        return payload(ctx, field, null, 'pullRequest');
      }
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod : 'SQUASH';
      const outcome = mergePull(repo, pull, method);
      if (!outcome.ok) {
        ctx.errors.push({ message: outcome.conflict ? 'merge conflict' : 'cannot merge' });
        return payload(ctx, field, pullNode(repo, pull), 'pullRequest');
      }
      return payload(ctx, field, pullNode(repo, pull), 'pullRequest');
    }
    case 'addComment': {
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      if (parsed === null) {
        ctx.errors.push({ message: 'subject not found' });
        return payload(ctx, field, null, 'commentEdge');
      }
      const [repoIdRaw, numberRaw] = parsed.key.split(':');
      const repo = [...forge.repos.values()].find((candidate) => candidate.id === Number(repoIdRaw));
      const issue = repo?.issueByNumber(Number(numberRaw));
      if (repo === undefined || issue === undefined) {
        ctx.errors.push({ message: 'subject not found' });
        return payload(ctx, field, null, 'commentEdge');
      }
      const comment = { id: forge.nextGlobalId(), body: typeof input.body === 'string' ? input.body : '', seq: forge.nextSeq() };
      issue.comments.push(comment);
      const commentNode: NodeRef = { __typename: 'IssueComment', repo, issue };
      // The payload's commentEdge.node is the comment; execute its fields manually.
      const out: Record<string, unknown> = {};
      for (const selection of field.selections ?? []) {
        const key = selection.alias ?? selection.name;
        if (selection.name === 'commentEdge') {
          const nodeSelections = findNodeSelections(selection.selections ?? []);
          const nodeOut: Record<string, unknown> = {};
          for (const nodeField of nodeSelections) {
            if (nodeField.name === 'id') nodeOut[nodeField.alias ?? 'id'] = globalId('IssueComment', String(comment.id));
            else if (nodeField.name === 'body') nodeOut[nodeField.alias ?? 'body'] = comment.body;
          }
          out[key] = { node: nodeOut };
        } else if (selection.name === 'clientMutationId') out[key] = null;
      }
      void commentNode;
      return out;
    }
    default:
      return unknownField(ctx, 'Mutation', field);
  }
}

// ------------------------------------------------------------------ entry point

export interface GraphQLResult {
  data?: Record<string, unknown>;
  errors?: { message: string }[];
}

export function executeGraphQL(forge: Forge, query: string, variables: Vars): GraphQLResult {
  const parser = new Parser(tokenize(query));
  const document = parser.parseDocument();
  const ctx: Ctx = { forge, vars: variables, errors: [] };
  const data: Record<string, unknown> = {};
  for (const field of document.selections) {
    if (field.fragment) continue;
    const key = field.alias ?? field.name;
    if (document.operation === 'mutation') data[key] = executeMutation(ctx, field);
    else data[key] = executeField(ctx, null, field);
  }
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}
