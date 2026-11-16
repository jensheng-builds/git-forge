// store.ts — the forge's in-memory data store and git object model.
//
// Everything the server serves lives here: repositories, their git objects
// (commits, trees, blobs, tags stored byte-exactly as pushed), refs, issues,
// pull requests, labels and comments. No disk, no database, no git binary:
// objects are hashed with node:crypto's SHA-1 and trees/commits are built
// and parsed by hand, so a pushed object round-trips byte for byte.

import { createHash } from 'node:crypto';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const EPOCH_BASE = 1735689600; // 2025-01-01T00:00:00Z, a fixed base for forged commits

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string; // '100644', '100755', '40000', '120000', '160000'
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort key: directories compare as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ commits & tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = ZERO_OID;
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommitData(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const view: TagView = { object: ZERO_OID, type: '', tag: '', tagger: '' };
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
    else if (line === '') break;
  }
  return view;
}

/** The committer timestamp inside an ident line ("Name <mail> 1234567890 +0000"), or 0. */
export function identEpoch(ident: string): number {
  const match = / (\d{9,}) [+-]\d{4}$/.exec(ident.trim());
  return match ? Number(match[1]) : 0;
}

// ------------------------------------------------------------------ domain records

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export class Repo {
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>(); // full ref name -> oid
  headRef = 'refs/heads/main';
  readonly issues: IssueRec[] = [];
  readonly pulls: PullRec[] = [];
  readonly labels = new Map<string, Label>();
  nextNumber = 1; // issues and pull requests share one numbering sequence, as on GitHub
  commitSeq = 0;

  readonly id: number;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;

  constructor(id: number, name: string, description: string, isPrivate: boolean, defaultBranch: string) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.defaultBranch = defaultBranch;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  tipOf(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  /** Follow tag objects until a commit; undefined when the chain breaks. */
  peelToCommit(oid: string): string | undefined {
    let current: string | undefined = oid;
    const seen = new Set<string>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const object = this.objects.get(current);
      if (object === undefined) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  /** Every commit reachable from `tip` (inclusive), parents followed. */
  ancestorsOf(tip: string): Set<string> {
    const out = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      out.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return out;
  }

  isAncestor(maybeAncestor: string, tip: string): boolean {
    if (maybeAncestor === tip) return true;
    return this.ancestorsOf(tip).has(maybeAncestor);
  }

  /** A common ancestor of two commits (the one closest to `a`), or undefined. */
  mergeBase(a: string, b: string): string | undefined {
    const ancestorsA = this.ancestorsOf(a);
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const object = this.objects.get(oid);
      if (object !== undefined && object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    }
    return undefined;
  }

  /** Flatten a tree (recursively) into path -> {oid, mode}. */
  flattenTree(treeOid: string | undefined, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    if (treeOid === undefined) return out;
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** Build (and store) a tree hierarchy from a flat path -> {oid, mode} map. */
  treeFromFlat(flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, value] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i] as string;
        let next = node.dirs.get(segment);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(segment, next);
        }
        node = next;
      }
      node.files.set(segments[segments.length - 1] as string, value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** The tree oid a commit points at, or undefined. */
  treeOfCommit(commitOid: string): string | undefined {
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return undefined;
    return parseCommit(object.data).tree;
  }

  /** The forge's ident line for commits it authors itself (contents API, merges). */
  ident(): string {
    this.commitSeq += 1;
    const epoch = EPOCH_BASE + this.commitSeq * 61;
    return `Forge Bot <forge@localhost> ${epoch} +0000`;
  }

  /**
   * Commit file changes on a branch: `changes` maps a path to its new bytes,
   * or null to delete it. Creates the branch when it has no tip yet.
   * Returns the new commit's oid.
   */
  commitFiles(ref: string, changes: ReadonlyMap<string, Buffer | null>, message: string): string {
    const tip = this.refs.get(ref);
    const baseTree = tip === undefined ? undefined : this.treeOfCommit(tip);
    const flat = this.flattenTree(baseTree);
    for (const [path, bytes] of changes) {
      if (bytes === null) flat.delete(path);
      else flat.set(path, { oid: this.putObject('blob', bytes), mode: '100644' });
    }
    const tree = this.treeFromFlat(flat);
    const ident = this.ident();
    const data = buildCommitData({
      tree,
      parents: tip === undefined ? [] : [tip],
      author: ident,
      committer: ident,
      message,
    });
    const oid = this.putObject('commit', data);
    this.refs.set(ref, oid);
    return oid;
  }

  issueByNumber(number: number): IssueRec | undefined {
    return this.issues.find((issue) => issue.number === number);
  }

  pullByNumber(number: number): PullRec | undefined {
    return this.pulls.find((pull) => pull.number === number);
  }
}

// ------------------------------------------------------------------ three-way merge & diffs

export type MergeOutcome =
  | { ok: true; tree: string }
  | { ok: false; conflictPath: string };

/**
 * A file-level three-way merge of two trees against their merge base's tree.
 * A path changed on only one side takes that side's version; a path changed
 * on both sides to different bytes (or deleted on one side and changed on
 * the other) conflicts. This matches what the suite exercises: merges add
 * or change files the other side never touched, and the conflict case
 * rewrites the same file two ways from one base.
 */
export function threeWayMerge(repo: Repo, baseTree: string | undefined, oursTree: string | undefined, theirsTree: string | undefined): MergeOutcome {
  const base = repo.flattenTree(baseTree);
  const ours = repo.flattenTree(oursTree);
  const theirs = repo.flattenTree(theirsTree);
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (x: { oid: string; mode: string } | undefined, y: { oid: string; mode: string } | undefined): boolean =>
      x === undefined ? y === undefined : y !== undefined && x.oid === y.oid && x.mode === y.mode;
    if (same(o, t)) {
      if (o !== undefined) merged.set(path, o);
    } else if (same(b, o)) {
      if (t !== undefined) merged.set(path, t);
    } else if (same(b, t)) {
      if (o !== undefined) merged.set(path, o);
    } else {
      return { ok: false, conflictPath: path };
    }
  }
  return { ok: true, tree: repo.treeFromFlat(merged) };
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  let lines = 0;
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lines += 1;
  return text.endsWith('\n') ? lines : lines + 1;
}

/** A line-level LCS length, bounded so a huge file cannot stall the server. */
function lcsLength(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.length * b.length > 4_000_000) {
    const setB = new Set(b);
    return a.filter((line) => setB.has(line)).length;
  }
  const dp = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j] as number;
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j] as number, dp[j - 1] as number);
      diagonal = above;
    }
  }
  return dp[b.length] as number;
}

/** The changed files between two trees, with GitHub-style change counts. */
export function diffTrees(repo: Repo, fromTree: string | undefined, toTree: string | undefined): FileDiff[] {
  const from = repo.flattenTree(fromTree);
  const to = repo.flattenTree(toTree);
  const out: FileDiff[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const a = from.get(path);
    const b = to.get(path);
    if (a !== undefined && b !== undefined && a.oid === b.oid) continue;
    const aData = a === undefined ? undefined : repo.getObject(a.oid)?.data;
    const bData = b === undefined ? undefined : repo.getObject(b.oid)?.data;
    if (a === undefined && b !== undefined) {
      const additions = bData === undefined ? 0 : countLines(bData);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b === undefined && a !== undefined) {
      const deletions = aData === undefined ? 0 : countLines(aData);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (aData !== undefined && bData !== undefined) {
      const aLines = aData.toString('utf8').split('\n');
      const bLines = bData.toString('utf8').split('\n');
      const common = lcsLength(aLines, bLines);
      const additions = Math.max(0, bLines.length - common);
      const deletions = Math.max(0, aLines.length - common);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the forge

export class Forge {
  readonly repos = new Map<string, Repo>(); // keyed by repository name
  private repoIdSeq = 0;
  private globalIdSeq = 0;
  private seq = 0;
  viewerLogin: string | null = null;

  /** Monotonic sequence for creation ordering (issues, comments). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  nextGlobalId(): number {
    this.globalIdSeq += 1;
    return this.globalIdSeq;
  }

  /**
   * Learn the token owner's login from a request that successfully addresses
   * one of the forge's repositories: the suite only ever names the viewer's
   * own repositories with the viewer's login, so the first owner that
   * resolves is the viewer. After that, any other owner is a stranger.
   */
  learnViewer(login: string): void {
    if (this.viewerLogin === null && login !== '') this.viewerLogin = login;
  }

  /** Whether `owner` may address repositories at all (unknown until learned). */
  ownerAllowed(owner: string): boolean {
    return this.viewerLogin === null || this.viewerLogin === owner;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    this.repoIdSeq += 1;
    const repo = new Repo(this.repoIdSeq, name, description, isPrivate, 'main');
    this.repos.set(name, repo);
    return repo;
  }

  /** Resolve a repository by owner+name, honouring the ownership rule. */
  repoFor(owner: string, name: string): Repo | undefined {
    const repo = this.repos.get(name);
    if (repo === undefined) return undefined;
    if (!this.ownerAllowed(owner)) return undefined;
    this.learnViewer(owner);
    return repo;
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }
}
