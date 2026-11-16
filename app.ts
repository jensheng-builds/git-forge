// app.ts — HTTP surface of the forge: git smart HTTP, the REST v3 API,
// the GraphQL endpoint and the MCP endpoint, all over one in-memory store.
//
// Every response the suite can see follows the same wire rules: JSON (never
// HTML) for API answers, a non-empty X-GitHub-Request-Id on every REST
// reply, {message} bodies for errors, and a 401 for a missing or wrong
// bearer token before anything else is considered.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Forge, diffTrees, identEpoch, parseCommit, parseTree } from './store.ts';
import type { IssueRec, PullRec, Repo } from './store.ts';
import { advertise, receivePack, uploadPack } from './gitproto.ts';
import { executeGraphQL, globalId, mergePull, pullDisplayState } from './graphql.ts';

const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const INSTALLED_VERSION = '1.0.0';

let requestSeq = 0;
function requestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(36)}-${Date.now().toString(36)}`;
}

// ------------------------------------------------------------------ http plumbing

interface Reply {
  status: number;
  body: unknown; // object -> JSON, Buffer/string -> raw
  contentType?: string;
  headers?: Record<string, string>;
}

function send(res: ServerResponse, reply: Reply): void {
  const headers: Record<string, string> = { ...(reply.headers ?? {}) };
  let body: Buffer;
  if (Buffer.isBuffer(reply.body)) {
    body = reply.body;
    headers['content-type'] = reply.contentType ?? 'application/octet-stream';
  } else if (typeof reply.body === 'string') {
    body = Buffer.from(reply.body, 'utf8');
    headers['content-type'] = reply.contentType ?? 'text/plain; charset=utf-8';
  } else {
    body = Buffer.from(JSON.stringify(reply.body), 'utf8');
    headers['content-type'] = reply.contentType ?? 'application/json; charset=utf-8';
  }
  headers['content-length'] = String(body.length);
  res.writeHead(reply.status, headers);
  res.end(body);
}

function restReply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers: { 'x-github-request-id': requestId(), ...headers } };
}

function errorReply(status: number, message: string): Reply {
  return restReply(status, { message });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function authorized(req: IncomingMessage): boolean {
  if (TOKEN === '') return false;
  const header = req.headers.authorization;
  return typeof header === 'string' && header === `Bearer ${TOKEN}`;
}

// ------------------------------------------------------------------ REST shapes

function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = forge.viewerLogin ?? '';
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    html_url: '',
    clone_url: '',
    ssh_url: '',
    created_at: new Date(1735689600000 + repo.id * 1000).toISOString(),
    updated_at: new Date(1735689600000 + repo.id * 1000).toISOString(),
    pushed_at: new Date(1735689600000 + repo.id * 1000).toISOString(),
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

function issueJson(forge: Forge, repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: forge.viewerLogin ?? '' },
    comments: issue.comments.length,
    created_at: new Date(1735689600000 + issue.seq * 61000).toISOString(),
    updated_at: new Date(1735689600000 + issue.seq * 61000).toISOString(),
    closed_at: issue.state === 'closed' ? new Date(1735689600000 + issue.seq * 61000).toISOString() : null,
    pull_request: undefined,
  };
}

function pullJson(forge: Forge, repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
  const owner = forge.viewerLogin ?? '';
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullDisplayState(pull) === 'OPEN' ? 'open' : 'closed',
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: owner },
    head: { ref: pull.headRef, sha: headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${owner}:${pull.baseRef}` },
    created_at: new Date(1735689600000 + pull.seq * 61000).toISOString(),
    updated_at: new Date(1735689600000 + pull.seq * 61000).toISOString(),
    closed_at: pull.state === 'closed' ? new Date(1735689600000 + pull.seq * 61000).toISOString() : null,
    draft: false,
  };
}

function commentJson(forge: Forge, comment: { id: number; body: string; seq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', String(comment.id)),
    body: comment.body,
    user: { login: forge.viewerLogin ?? '' },
    created_at: new Date(1735689600000 + comment.seq * 61000).toISOString(),
    updated_at: new Date(1735689600000 + comment.seq * 61000).toISOString(),
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const object = repo.getObject(oid);
  const view = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  const nameMail = (ident: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) /.exec(ident);
    if (match === null) return { name: '', email: '', date: new Date(0).toISOString() };
    return {
      name: match[1] as string,
      email: match[2] as string,
      date: new Date(Number(match[3]) * 1000).toISOString(),
    };
  };
  return {
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: {
      // The REST view of a commit message carries no trailing newline.
      message: (view?.message ?? '').replace(/\n+$/, ''),
      tree: { sha: view?.tree ?? '' },
      author: nameMail(view?.author ?? ''),
      committer: nameMail(view?.committer ?? ''),
      comment_count: 0,
    },
    parents: (view?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

// ------------------------------------------------------------------ REST routing

function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const text = raw.toString('utf8').trim();
  if (text === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function labelNames(repo: Repo, input: unknown): string[] | null {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) return null;
  const names: string[] = [];
  for (const item of input) {
    const name = typeof item === 'string' ? item : typeof item === 'object' && item !== null ? str((item as Record<string, unknown>).name) : '';
    if (name === '' || !repo.labels.has(name)) return null;
    names.push(name);
  }
  return names;
}

function handleRest(forge: Forge, method: string, segments: string[], query: URLSearchParams, rawBody: Buffer, origin: string): Reply {
  const parsedBody = (): { ok: true; value: Record<string, unknown> } | { ok: false } => parseJsonBody(rawBody);

  // Service root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return errorReply(404, 'Not Found');
    return restReply(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
      emojis_url: '/api/v3/emojis',
      installed_version: INSTALLED_VERSION,
    }, { 'x-oauth-scopes': 'repo, read:user' });
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    return restReply(200, { installed_version: INSTALLED_VERSION, verifiable_password_authentication: false });
  }
  if (segments.length === 1 && segments[0] === 'user') {
    if (method === 'GET') {
      if (forge.viewerLogin === null) return errorReply(404, 'Not Found');
      return restReply(200, { login: forge.viewerLogin, id: 1, type: 'User', site_admin: false });
    }
    if (method === 'POST') {
      // Repository creation also lives at /user/repos; a bare POST /user is unknown.
      return errorReply(404, 'Not Found');
    }
    return errorReply(404, 'Not Found');
  }
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const all = [...forge.repos.values()].sort((a, b) => a.id - b.id);
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        headers.link = `<${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next", <${origin}/api/v3/user/repos?per_page=${perPage}&page=${Math.ceil(all.length / perPage)}>; rel="last"`;
      }
      return restReply(200, slice.map((repo) => repoJson(forge, repo)), headers);
    }
    if (method === 'POST') {
      const body = parsedBody();
      if (!body.ok) return errorReply(400, 'Problems parsing JSON');
      return createRepository(forge, body.value);
    }
    return errorReply(404, 'Not Found');
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = forge.repoFor(owner, name);
        return repo === undefined ? errorReply(404, 'Not Found') : restReply(200, repoJson(forge, repo));
      }
      if (method === 'PATCH') {
        const repo = forge.repoFor(owner, name);
        if (repo === undefined) return errorReply(404, 'Not Found');
        const body = parsedBody();
        if (!body.ok) return errorReply(400, 'Problems parsing JSON');
        if (typeof body.value.description === 'string') repo.description = body.value.description;
        if (typeof body.value.private === 'boolean') repo.isPrivate = body.value.private;
        if (typeof body.value.default_branch === 'string') repo.defaultBranch = body.value.default_branch;
        return restReply(200, repoJson(forge, repo));
      }
      if (method === 'DELETE') {
        const repo = forge.repoFor(owner, name);
        if (repo === undefined) return errorReply(404, 'Not Found');
        forge.deleteRepo(name);
        return restReply(204, Buffer.alloc(0), {});
      }
      if (method === 'POST') {
        // Creation at /repos/{owner}/{repo} is not a GitHub route.
        return errorReply(404, 'Not Found');
      }
      return errorReply(404, 'Not Found');
    }

    const repo = forge.repoFor(owner, name);
    if (repo === undefined) return errorReply(404, 'Not Found');
    return handleRepoScoped(forge, repo, method, rest, query, rawBody, parsedBody);
  }

  if (segments[0] === 'orgs' && segments.length >= 3 && segments[2] === 'repos' && method === 'POST') {
    const body = parsedBody();
    if (!body.ok) return errorReply(400, 'Problems parsing JSON');
    return createRepository(forge, body.value);
  }

  return errorReply(404, 'Not Found');
}

function createRepository(forge: Forge, input: Record<string, unknown>): Reply {
  const name = str(input.name);
  if (name === '') return errorReply(422, 'Validation Failed: name is required');
  if (forge.repos.has(name)) {
    return restReply(422, {
      message: 'Validation Failed',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
  }
  const repo = forge.createRepo(name, str(input.description), input.private === true);
  if (typeof input.default_branch === 'string' && input.default_branch !== '') {
    repo.defaultBranch = input.default_branch;
    repo.headRef = `refs/heads/${repo.defaultBranch}`;
  }
  return restReply(201, repoJson(forge, repo));
}

function handleRepoScoped(
  forge: Forge,
  repo: Repo,
  method: string,
  rest: string[],
  query: URLSearchParams,
  rawBody: Buffer,
  parsedBody: () => { ok: true; value: Record<string, unknown> } | { ok: false },
): Reply {
  const [head, ...tail] = rest;

  if (head === 'git') return handleGitData(forge, repo, method, tail, parsedBody);
  if (head === 'branches') return handleBranches(forge, repo, method, tail);
  if (head === 'commits') return handleCommits(repo, method, tail, query);
  if (head === 'contents') return handleContents(forge, repo, method, tail, query, parsedBody);
  if (head === 'labels') return handleLabels(repo, method, tail, parsedBody);
  if (head === 'issues') return handleIssues(forge, repo, method, tail, query, parsedBody);
  if (head === 'pulls') return handlePulls(forge, repo, method, tail, query, parsedBody);
  if (head === 'tags' && method === 'GET' && tail.length === 0) {
    const tags = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/tags/'))
      .map(([ref, oid]) => ({ name: ref.slice('refs/tags/'.length), commit: { sha: oid } }));
    return restReply(200, tags);
  }
  return errorReply(404, 'Not Found');
}

function handleGitData(
  forge: Forge,
  repo: Repo,
  method: string,
  tail: string[],
  parsedBody: () => { ok: true; value: Record<string, unknown> } | { ok: false },
): Reply {
  if (tail[0] === 'refs') {
    if (method === 'POST' && tail.length === 1) {
      const body = parsedBody();
      if (!body.ok) return errorReply(400, 'Problems parsing JSON');
      const ref = str(body.value.ref);
      const sha = str(body.value.sha);
      if (!ref.startsWith('refs/') || repo.getObject(sha) === undefined) return errorReply(422, 'Validation Failed');
      if (repo.refs.has(ref)) return errorReply(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return restReply(201, { ref, node_id: globalId('Ref', `${repo.id}:${ref}`), object: { sha, type: repo.getObject(sha)?.type ?? 'commit' } });
    }
    if (method === 'GET') {
      const ref = `refs/${tail.slice(1).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return errorReply(404, 'Not Found');
      return restReply(200, { ref, node_id: globalId('Ref', `${repo.id}:${ref}`), object: { sha: oid, type: repo.getObject(oid)?.type ?? 'commit' } });
    }
  }
  if (tail[0] === 'trees' && method === 'GET' && tail.length >= 2) {
    const oid = tail[1] as string;
    const object = repo.getObject(oid);
    if (object === undefined) return errorReply(404, 'Not Found');
    let treeOid = oid;
    if (object.type === 'commit') treeOid = parseCommit(object.data).tree;
    else if (object.type === 'tag') {
      const peeled = repo.peelToCommit(oid);
      if (peeled === undefined) return errorReply(404, 'Not Found');
      treeOid = parseCommit((repo.getObject(peeled) as { data: Buffer }).data).tree;
    }
    const treeObject = repo.getObject(treeOid);
    if (treeObject === undefined || treeObject.type !== 'tree') return errorReply(404, 'Not Found');
    const flat = query.get('recursive') === '1' || query.get('recursive') === 'true' ? repo.flattenTree(treeOid) : null;
    if (flat !== null) {
      return restReply(200, {
        sha: treeOid,
        tree: [...flat.entries()].map(([path, entry]) => ({ path, mode: entry.mode, type: 'blob', sha: entry.oid })),
        truncated: false,
      });
    }
    return restReply(200, {
      sha: treeOid,
      tree: parseTree(treeObject.data).map((entry) => ({
        path: entry.name,
        mode: entry.mode,
        type: entry.mode === '40000' ? 'tree' : 'blob',
        sha: entry.oid,
      })),
      truncated: false,
    });
  }
  if (tail[0] === 'blobs' && method === 'GET' && tail.length === 2) {
    const object = repo.getObject(tail[1] as string);
    if (object === undefined || object.type !== 'blob') return errorReply(404, 'Not Found');
    return restReply(200, {
      sha: tail[1],
      size: object.data.length,
      encoding: 'base64',
      content: object.data.toString('base64'),
    });
  }
  if (tail[0] === 'commits' && method === 'GET' && tail.length === 2) {
    const object = repo.getObject(tail[1] as string);
    if (object === undefined || object.type !== 'commit') return errorReply(404, 'Not Found');
    return restReply(200, commitJson(repo, tail[1] as string));
  }
  void forge;
  return errorReply(404, 'Not Found');
}

function handleBranches(forge: Forge, repo: Repo, method: string, tail: string[]): Reply {
  if (method === 'GET' && tail.length === 0) {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
    return restReply(200, branches);
  }
  if (method === 'GET' && tail.length >= 1) {
    const name = tail.join('/');
    const oid = repo.refs.get(`refs/heads/${name}`);
    if (oid === undefined) return errorReply(404, 'Not Found');
    return restReply(200, { name, commit: commitJson(repo, oid), protected: false });
  }
  void forge;
  return errorReply(404, 'Not Found');
}

function handleCommits(repo: Repo, method: string, tail: string[], query: URLSearchParams): Reply {
  if (method === 'GET' && tail.length === 1) {
    const object = repo.getObject(tail[0] as string);
    if (object === undefined || object.type !== 'commit') return errorReply(404, 'Not Found');
    return restReply(200, commitJson(repo, tail[0] as string));
  }
  if (method !== 'GET' || tail.length !== 0) return errorReply(404, 'Not Found');
  const shaParam = query.get('sha');
  let start: string | undefined;
  if (shaParam !== null && shaParam !== '') {
    start = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.getObject(shaParam)?.type === 'commit' ? shaParam : repo.peelToCommit(shaParam));
    if (start === undefined) return errorReply(404, 'Not Found');
  } else {
    const tip = repo.refs.get(repo.headRef);
    if (tip === undefined) return restReply(200, []);
    start = repo.peelToCommit(tip);
    if (start === undefined) return restReply(200, []);
  }
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const all: string[] = [];
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    all.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  all.sort((a, b) => {
    const ea = identEpoch(parseCommit((repo.getObject(a) as { data: Buffer }).data).committer);
    const eb = identEpoch(parseCommit((repo.getObject(b) as { data: Buffer }).data).committer);
    return eb - ea;
  });
  const slice = all.slice((page - 1) * perPage, page * perPage);
  return restReply(200, slice.map((oid) => commitJson(repo, oid)));
}

function resolveRef(repo: Repo, refParam: string | null): string | undefined {
  if (refParam === null || refParam === '') {
    const tip = repo.refs.get(repo.headRef);
    return tip === undefined ? undefined : repo.peelToCommit(tip);
  }
  const branchTip = repo.refs.get(`refs/heads/${refParam}`) ?? repo.refs.get(`refs/tags/${refParam}`) ?? repo.refs.get(refParam);
  if (branchTip !== undefined) return repo.peelToCommit(branchTip);
  if (repo.getObject(refParam)?.type === 'commit') return refParam;
  return repo.peelToCommit(refParam);
}

function handleContents(
  forge: Forge,
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
  parsedBody: () => { ok: true; value: Record<string, unknown> } | { ok: false },
): Reply {
  const path = tail.join('/');
  if (method === 'GET') {
    const commit = resolveRef(repo, query.get('ref'));
    if (commit === undefined) return errorReply(404, 'Not Found');
    const tree = repo.treeOfCommit(commit);
    if (tree === undefined) return errorReply(404, 'Not Found');
    if (path === '') {
      const entries = parseTree((repo.getObject(tree) as { data: Buffer }).data);
      return restReply(200, entries.map((entry) => ({
        type: entry.mode === '40000' ? 'dir' : 'file',
        name: entry.name,
        path: entry.name,
        sha: entry.oid,
        size: entry.mode === '40000' ? 0 : (repo.getObject(entry.oid)?.data.length ?? 0),
      })));
    }
    const flat = repo.flattenTree(tree);
    const entry = flat.get(path);
    if (entry !== undefined) {
      const blob = repo.getObject(entry.oid);
      if (blob === undefined) return errorReply(404, 'Not Found');
      return restReply(200, {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        sha: entry.oid,
        name: path.split('/').pop(),
        path,
        size: blob.data.length,
      });
    }
    // Directory?
    const prefix = `${path}/`;
    const children = [...flat.keys()].filter((key) => key.startsWith(prefix));
    if (children.length === 0) return errorReply(404, 'Not Found');
    const immediate = new Map<string, { dir: boolean; oid: string }>();
    for (const child of children) {
      const rest = child.slice(prefix.length);
      const [first] = rest.split('/');
      if (first === undefined || immediate.has(first)) continue;
      const isDir = rest.includes('/');
      let oid = '';
      if (!isDir) oid = (flat.get(child) as { oid: string }).oid;
      else {
        const subtree = descendTree(repo, tree, `${path}/${first}`);
        oid = subtree ?? '';
      }
      immediate.set(first, { dir: isDir, oid });
    }
    return restReply(200, [...immediate.entries()].map(([name, info]) => ({
      type: info.dir ? 'dir' : 'file',
      name,
      path: `${path}/${name}`,
      sha: info.oid,
      size: info.dir ? 0 : (repo.getObject(info.oid)?.data.length ?? 0),
    })));
  }

  if (method === 'PUT' || method === 'DELETE') {
    const body = parsedBody();
    if (!body.ok) return errorReply(400, 'Problems parsing JSON');
    const branch = str(body.value.branch) || repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const message = str(body.value.message) || (method === 'PUT' ? `Update ${path}` : `Delete ${path}`);
    const tip = repo.refs.get(ref);
    const tree = tip === undefined ? undefined : repo.treeOfCommit(tip);
    const flat = repo.flattenTree(tree);
    const existing = flat.get(path);
    if (method === 'PUT') {
      const contentBase64 = str(body.value.content);
      let bytes: Buffer;
      try {
        bytes = Buffer.from(contentBase64, 'base64');
      } catch {
        return errorReply(422, 'Validation Failed: content is not valid base64');
      }
      const givenSha = typeof body.value.sha === 'string' ? body.value.sha : undefined;
      if (existing !== undefined && givenSha !== undefined && givenSha !== existing.oid) {
        return restReply(409, { message: `${path} has changed since the given sha was read` });
      }
      if (existing === undefined && givenSha !== undefined) {
        return restReply(404, { message: 'Not Found' });
      }
      const blobOid = repo.putObject('blob', bytes);
      const commit = repo.commitFiles(ref, new Map([[path, bytes]]), message);
      void blobOid;
      const created = existing === undefined;
      return restReply(created ? 201 : 200, {
        content: {
          type: 'file',
          encoding: 'base64',
          content: bytes.toString('base64'),
          sha: repo.flattenTree(repo.treeOfCommit(commit)).get(path)?.oid ?? '',
          name: path.split('/').pop(),
          path,
          size: bytes.length,
        },
        commit: { sha: commit },
      });
    }
    // DELETE
    if (existing === undefined) return errorReply(404, 'Not Found');
    const givenSha = typeof body.value.sha === 'string' ? body.value.sha : undefined;
    if (givenSha !== undefined && givenSha !== existing.oid) {
      return restReply(409, { message: `${path} has changed since the given sha was read` });
    }
    const commit = repo.commitFiles(ref, new Map([[path, null]]), message);
    return restReply(200, { content: null, commit: { sha: commit } });
  }
  void forge;
  return errorReply(404, 'Not Found');
}

function descendTree(repo: Repo, treeOid: string, path: string): string | undefined {
  let current = treeOid;
  for (const segment of path.split('/')) {
    const object = repo.getObject(current);
    if (object === undefined || object.type !== 'tree') return undefined;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return undefined;
    current = entry.oid;
  }
  return current;
}

function handleLabels(
  repo: Repo,
  method: string,
  tail: string[],
  parsedBody: () => { ok: true; value: Record<string, unknown> } | { ok: false },
): Reply {
  if (method === 'GET' && tail.length === 0) {
    return restReply(200, [...repo.labels.values()].map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description, default: false })));
  }
  if (method === 'POST' && tail.length === 0) {
    const body = parsedBody();
    if (!body.ok) return errorReply(400, 'Problems parsing JSON');
    const name = str(body.value.name);
    if (name === '') return errorReply(422, 'Validation Failed: name is required');
    if (repo.labels.has(name)) return errorReply(422, 'Validation Failed: name already exists');
    const label = {
      id: repo.labels.size + 1,
      name,
      color: str(body.value.color) || 'ededed',
      description: typeof body.value.description === 'string' ? body.value.description : null,
    };
    repo.labels.set(name, label);
    return restReply(201, { id: label.id, name: label.name, color: label.color, description: label.description, default: false });
  }
  return errorReply(404, 'Not Found');
}

function handleIssues(
  forge: Forge,
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
  parsedBody: () => { ok: true; value: Record<string, unknown> } | { ok: false },
): Reply {
  if (tail.length === 0) {
    if (method === 'GET') {
      let items = [...repo.issues];
      const state = query.get('state') ?? 'open';
      if (state === 'open') items = items.filter((issue) => issue.state === 'open');
      else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? 'desc';
      items = [...items].sort((a, b) => {
        const key = sort === 'updated' ? 'seq' : 'seq';
        const diff = (a[key] as number) - (b[key] as number);
        return direction === 'asc' ? diff : -diff;
      });
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      items = items.slice((page - 1) * perPage, page * perPage);
      return restReply(200, items.map((issue) => issueJson(forge, repo, issue)));
    }
    if (method === 'POST') {
      const body = parsedBody();
      if (!body.ok) return errorReply(400, 'Problems parsing JSON');
      const names = labelNames(repo, body.value.labels);
      if (names === null) return errorReply(422, 'Validation Failed: labels contains an unknown label');
      const issue: IssueRec = {
        id: forge.nextGlobalId(),
        number: repo.nextNumber++,
        title: str(body.value.title),
        body: str(body.value.body),
        state: 'open',
        labels: names,
        comments: [],
        seq: forge.nextSeq(),
      };
      repo.issues.push(issue);
      return restReply(201, issueJson(forge, repo, issue));
    }
    return errorReply(404, 'Not Found');
  }

  const number = Number(tail[0]);
  const issue = Number.isInteger(number) ? repo.issueByNumber(number) : undefined;
  if (tail.length === 1) {
    if (issue === undefined) return errorReply(404, 'Not Found');
    if (method === 'GET') return restReply(200, issueJson(forge, repo, issue));
    if (method === 'PATCH') {
      const body = parsedBody();
      if (!body.ok) return errorReply(400, 'Problems parsing JSON');
      if (typeof body.value.title === 'string') issue.title = body.value.title;
      if (typeof body.value.body === 'string') issue.body = body.value.body;
      if (body.value.state === 'open' || body.value.state === 'closed') issue.state = body.value.state;
      if (body.value.labels !== undefined) {
        const names = labelNames(repo, body.value.labels);
        if (names === null) return errorReply(422, 'Validation Failed: labels contains an unknown label');
        issue.labels = names;
      }
      return restReply(200, issueJson(forge, repo, issue));
    }
    return errorReply(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined) return errorReply(404, 'Not Found');
    if (method === 'GET') return restReply(200, issue.comments.map((comment) => commentJson(forge, comment)));
    if (method === 'POST') {
      const body = parsedBody();
      if (!body.ok) return errorReply(400, 'Problems parsing JSON');
      const comment = { id: forge.nextGlobalId(), body: str(body.value.body), seq: forge.nextSeq() };
      issue.comments.push(comment);
      return restReply(201, commentJson(forge, comment));
    }
    return errorReply(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'labels') {
    if (issue === undefined) return errorReply(404, 'Not Found');
    if (method === 'POST') {
      const body = parsedBody();
      if (!body.ok) return errorReply(400, 'Problems parsing JSON');
      const names = labelNames(repo, body.value.labels);
      if (names === null) return errorReply(422, 'Validation Failed: labels contains an unknown label');
      for (const name of names) if (!issue.labels.includes(name)) issue.labels.push(name);
      return restReply(200, issueJson(forge, repo, issue).labels as unknown);
    }
    if (method === 'PUT') {
      const body = parsedBody();
      if (!body.ok) return errorReply(400, 'Problems parsing JSON');
      const names = labelNames(repo, body.value.labels);
      if (names === null) return errorReply(422, 'Validation Failed: labels contains an unknown label');
      issue.labels = names;
      return restReply(200, issueJson(forge, repo, issue).labels as unknown);
    }
    if (method === 'DELETE') {
      issue.labels = [];
      return restReply(200, []);
    }
    return errorReply(404, 'Not Found');
  }

  if (tail.length === 3 && tail[1] === 'labels' && method === 'DELETE') {
    if (issue === undefined) return errorReply(404, 'Not Found');
    const name = decodeURIComponent(tail[2] as string);
    issue.labels = issue.labels.filter((label) => label !== name);
    return restReply(200, issueJson(forge, repo, issue).labels as unknown);
  }

  return errorReply(404, 'Not Found');
}

function handlePulls(
  forge: Forge,
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
  parsedBody: () => { ok: true; value: Record<string, unknown> } | { ok: false },
): Reply {
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let items = repo.pulls;
      if (state === 'open') items = items.filter((pull) => pull.state === 'open');
      else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed');
      items = [...items].sort((a, b) => b.number - a.number);
      const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
      const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
      items = items.slice((page - 1) * perPage, page * perPage);
      return restReply(200, items.map((pull) => pullJson(forge, repo, pull)));
    }
    if (method === 'POST') {
      const body = parsedBody();
      if (!body.ok) return errorReply(400, 'Problems parsing JSON');
      const headRaw = str(body.value.head);
      const baseRaw = str(body.value.base) || repo.defaultBranch;
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return errorReply(422, 'Validation Failed: head ref does not exist');
      if (repo.refs.get(`refs/heads/${base}`) === undefined) return errorReply(422, 'Validation Failed: base ref does not exist');
      const pull: PullRec = {
        id: forge.nextGlobalId(),
        number: repo.nextNumber++,
        title: str(body.value.title),
        body: str(body.value.body),
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: forge.nextSeq(),
      };
      repo.pulls.push(pull);
      return restReply(201, pullJson(forge, repo, pull));
    }
    return errorReply(404, 'Not Found');
  }

  const number = Number(tail[0]);
  const pull = Number.isInteger(number) ? repo.pullByNumber(number) : undefined;

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return errorReply(404, 'Not Found');
    const body = parsedBody();
    if (!body.ok) return errorReply(400, 'Problems parsing JSON');
    if (pull.state !== 'open') return errorReply(405, 'Pull Request is not mergeable');
    const methodName = str(body.value.merge_method) || 'merge';
    const outcome = mergePull(repo, pull, methodName.toUpperCase());
    if (!outcome.ok) {
      return outcome.conflict
        ? errorReply(405, 'Pull Request is not mergeable: merge conflict')
        : errorReply(405, 'Pull Request is not mergeable');
    }
    return restReply(200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  if (pull === undefined) return errorReply(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') return restReply(200, pullJson(forge, repo, pull));
    if (method === 'PATCH') {
      const body = parsedBody();
      if (!body.ok) return errorReply(400, 'Problems parsing JSON');
      if (typeof body.value.title === 'string') pull.title = body.value.title;
      if (typeof body.value.body === 'string') pull.body = body.value.body;
      if (body.value.state === 'open' || body.value.state === 'closed') pull.state = body.value.state;
      return restReply(200, pullJson(forge, repo, pull));
    }
    return errorReply(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return restReply(200, []);
    const headCommit = repo.peelToCommit(headTip);
    const baseCommit = repo.peelToCommit(baseTip);
    if (headCommit === undefined || baseCommit === undefined) return restReply(200, []);
    const mergeBase = repo.mergeBase(headCommit, baseCommit) ?? baseCommit;
    const diffs = diffTrees(repo, repo.treeOfCommit(mergeBase), repo.treeOfCommit(headCommit));
    return restReply(200, diffs.map((diff) => ({
      sha: repo.flattenTree(repo.treeOfCommit(headCommit)).get(diff.filename)?.oid ?? '',
      filename: diff.filename,
      status: diff.status === 'modified' ? 'modified' : diff.status,
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.changes,
    })));
  }

  if (tail.length === 2 && tail[1] === 'commits' && method === 'GET') {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return restReply(200, []);
    const headCommit = repo.peelToCommit(headTip);
    const baseCommit = repo.peelToCommit(baseTip);
    if (headCommit === undefined || baseCommit === undefined) return restReply(200, []);
    const baseAncestors = repo.ancestorsOf(baseCommit);
    const commits = [...repo.ancestorsOf(headCommit)].filter((oid) => !baseAncestors.has(oid));
    return restReply(200, commits.map((oid) => commitJson(repo, oid)));
  }

  return errorReply(404, 'Not Found');
}

// ------------------------------------------------------------------ MCP

const MCP_TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Owner/name, accepted as an alternative.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
        merge_method: { type: 'string', description: 'Merge method: merge, squash or rebase.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];
const MCP_TOOLS_JSON = JSON.stringify(MCP_TOOLS);
const MCP_TOOLS_PARSED = JSON.parse(MCP_TOOLS_JSON) as Record<string, unknown>[];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolContent(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function mcpResolveRepo(forge: Forge, args: Record<string, unknown>): Repo | undefined {
  const repoName = str(args.repo) || str(args.repository) || str(args.name);
  const fullName = str(args.full_name) || str(args.fullName);
  let owner = str(args.owner) || str(args.owner_login);
  let name = repoName;
  if (fullName.includes('/')) {
    const [ownerPart, namePart] = fullName.split('/');
    if (owner === '') owner = ownerPart ?? '';
    if (name === '') name = namePart ?? '';
  }
  if (name === '') return undefined;
  if (owner === '') return forge.repos.get(name);
  return forge.repoFor(owner, name);
}

function mcpCallTool(forge: Forge, name: string, rawArgs: unknown): Record<string, unknown> {
  const args = (rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
  const tool = MCP_TOOLS_PARSED.find((candidate) => candidate.name === name);
  if (tool === undefined) throw Object.assign(new Error(`unknown tool ${name}`), { rpcCode: -32601 });
  const schema = tool.inputSchema as { required?: string[] };
  for (const required of schema.required ?? []) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`missing required argument: ${required}`);
    }
  }
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (forge.repos.has(repoName)) return toolError(`repository ${repoName} already exists`);
      const repo = forge.createRepo(repoName, str(args.description), args.private === true);
      return toolContent(repoJson(forge, repo));
    }
    case 'get_repo': {
      const repo = mcpResolveRepo(forge, args);
      if (repo === undefined) return toolError('repository not found');
      return toolContent(repoJson(forge, repo));
    }
    case 'create_issue': {
      const repo = mcpResolveRepo(forge, args);
      if (repo === undefined) return toolError('repository not found');
      const issue: IssueRec = {
        id: forge.nextGlobalId(),
        number: repo.nextNumber++,
        title: str(args.title),
        body: str(args.body),
        state: 'open',
        labels: [],
        comments: [],
        seq: forge.nextSeq(),
      };
      repo.issues.push(issue);
      return toolContent(issueJson(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = mcpResolveRepo(forge, args);
      if (repo === undefined) return toolError('repository not found');
      const state = str(args.state) || 'open';
      let items = repo.issues;
      if (state === 'open') items = items.filter((issue) => issue.state === 'open');
      else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
      return toolContent(items.map((issue) => issueJson(forge, repo, issue)));
    }
    case 'create_pull_request': {
      const repo = mcpResolveRepo(forge, args);
      if (repo === undefined) return toolError('repository not found');
      const head = str(args.head);
      const base = str(args.base) || repo.defaultBranch;
      if (repo.refs.get(`refs/heads/${head}`) === undefined) return toolError('head branch not found');
      const pull: PullRec = {
        id: forge.nextGlobalId(),
        number: repo.nextNumber++,
        title: str(args.title),
        body: str(args.body),
        state: 'open',
        headRef: head,
        baseRef: base,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: forge.nextSeq(),
      };
      repo.pulls.push(pull);
      return toolContent(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = mcpResolveRepo(forge, args);
      if (repo === undefined) return toolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.pullByNumber(number) : undefined;
      if (pull === undefined) return toolError('pull request not found');
      const method = (str(args.merge_method) || 'merge').toUpperCase();
      const outcome = mergePull(repo, pull, method);
      if (!outcome.ok) return toolError(outcome.conflict ? 'merge conflict' : 'pull request is not mergeable');
      return toolContent({ ...pullJson(forge, repo, pull), sha: outcome.sha, merged: true });
    }
    default:
      throw Object.assign(new Error(`unknown tool ${name}`), { rpcCode: -32601 });
  }
}

function handleMcpMessage(forge: Forge, message: JsonRpcRequest): Record<string, unknown> | null {
  const method = message.method ?? '';
  const id = message.id;
  const params = message.params ?? {};
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
        capabilities: { tools: {} },
        serverInfo: { name: 'git-forge', version: INSTALLED_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'git-forge', version: INSTALLED_VERSION } },
      });
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'git-forge', version: INSTALLED_VERSION },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS_PARSED });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      try {
        return rpcResult(id, mcpCallTool(forge, toolName, params.arguments));
      } catch (err) {
        const code = (err as { rpcCode?: number }).rpcCode ?? -32602;
        return rpcError(id, code, err instanceof Error ? err.message : 'tool call failed');
      }
    }
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    default:
      if (id === undefined || method.startsWith('notifications/')) return null;
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

function handleMcp(forge: Forge, rawBody: Buffer): Reply {
  const text = rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: rpcError(null, -32700, 'Parse error') };
  }
  if (Array.isArray(parsed)) {
    const results: Record<string, unknown>[] = [];
    for (const item of parsed) {
      const result = handleMcpMessage(forge, item as JsonRpcRequest);
      if (result !== null) results.push(result);
    }
    return { status: 200, contentType: 'application/json; charset=utf-8', body: results };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, contentType: 'application/json; charset=utf-8', body: rpcError(null, -32600, 'Invalid Request') };
  }
  const result = handleMcpMessage(forge, parsed as JsonRpcRequest);
  if (result === null) return { status: 202, contentType: 'application/json; charset=utf-8', body: Buffer.alloc(0) };
  return { status: 200, contentType: 'application/json; charset=utf-8', body: result };
}

// ------------------------------------------------------------------ GraphQL endpoint

function handleGraphQL(forge: Forge, rawBody: Buffer): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    return restReply(400, { message: 'Problems parsing JSON' });
  }
  const runOne = (item: unknown): Record<string, unknown> => {
    if (item === null || typeof item !== 'object') return { errors: [{ message: 'invalid request' }] };
    const record = item as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (record.variables !== null && typeof record.variables === 'object' ? record.variables : {}) as Record<string, unknown>;
    try {
      const result = executeGraphQL(forge, query, variables);
      const out: Record<string, unknown> = {};
      if (result.data !== undefined) out.data = result.data;
      if (result.errors !== undefined) out.errors = result.errors;
      return out;
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'graphql error' }] };
    }
  };
  if (Array.isArray(parsed)) return restReply(200, parsed.map(runOne));
  return restReply(200, runOne(parsed));
}

// ------------------------------------------------------------------ server

export function createForgeServer(forge: Forge): Server {
  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      try {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://forge.local');
        const path = url.pathname;

        if (path === '/healthz') {
          send(res, { status: 200, body: { ok: true }, contentType: 'application/json; charset=utf-8' });
          return;
        }

        if (!authorized(req)) {
          send(res, restReply(401, { message: 'Bad credentials' }));
          return;
        }

        const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const name = decodeURIComponent(gitMatch[2] as string);
          const action = gitMatch[3] as string;
          if (action === 'info/refs' && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              send(res, errorReply(400, 'service required'));
              return;
            }
            const protocol = req.headers['git-protocol'];
            const v2 = typeof protocol === 'string' && protocol.includes('version=2');
            const result = advertise(forge, owner, name, service, v2);
            send(res, { status: result.status, body: result.body, contentType: result.contentType });
            return;
          }
          if (action === 'git-upload-pack' && method === 'POST') {
            const protocol = req.headers['git-protocol'];
            const v2 = typeof protocol === 'string' && protocol.includes('version=2');
            try {
              const result = uploadPack(forge, owner, name, rawBody, v2);
              send(res, { status: result.status, body: result.body, contentType: result.contentType });
            } catch {
              send(res, errorReply(400, 'Bad Request'));
            }
            return;
          }
          if (action === 'git-receive-pack' && method === 'POST') {
            try {
              const result = receivePack(forge, owner, name, rawBody);
              send(res, { status: result.status, body: result.body, contentType: result.contentType });
            } catch {
              send(res, errorReply(400, 'Bad Request'));
            }
            return;
          }
          send(res, errorReply(404, 'Not Found'));
          return;
        }

        if (path === '/mcp' || path.startsWith('/mcp/')) {
          if (method === 'POST') {
            const reply = handleMcp(forge, rawBody);
            send(res, reply);
            return;
          }
          if (method === 'GET') {
            send(res, errorReply(405, 'Method Not Allowed'));
            return;
          }
          send(res, errorReply(404, 'Not Found'));
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') {
            send(res, errorReply(404, 'Not Found'));
            return;
          }
          send(res, handleGraphQL(forge, rawBody));
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          const segments = restPath === '' ? [] : restPath.split('/').map((segment) => decodeURIComponent(segment));
          const host = req.headers.host ?? 'forge.local';
          send(res, handleRest(forge, method, segments, url.searchParams, rawBody, `http://${host}`));
          return;
        }

        send(res, errorReply(404, 'Not Found'));
      } catch {
        try {
          send(res, errorReply(500, 'Internal Server Error'));
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });
  return server;
}

/** The entrypoint main.ts uses: a forge server that binds nothing until listened on. */
export function createApp(): Server {
  return createForgeServer(new Forge());
}

export async function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const forge = new Forge();
  const server = createForgeServer(forge);
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
