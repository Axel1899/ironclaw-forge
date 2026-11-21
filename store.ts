// Core store for the forge: in-memory repositories, a git object store (blob/tree/commit/tag),
// refs, issues, pull requests, labels and comments. Pure Node 22 stdlib (node:crypto, node:zlib).
// Every surface (git smart HTTP, REST v3, GraphQL v4, MCP) reads and writes through this module so
// an object created on one surface is the same object on every other.

import { createHash } from 'node:crypto';

/** The login the suite's bearer <redacted> owns (the seeded scenario's viewer; the token itself is opaque). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface TreeEntry {
  mode: string; // "100644" | "100755" | "120000" | "40000"
  name: string;
  sha: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  authorLine: string;
  committerLine: string;
  authorName: string;
  authorEmail: string;
  authorEpoch: number;
  message: string;
  raw: Buffer;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[]; // label names
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  comments: IssueComment[];
  isPull: boolean;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string; // branch name or sha
  headSha: string;
  baseRef: string;
  baseSha: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, { type: ObjectType; data: Buffer }>;
  refs: Map<string, string>; // full refname ("refs/heads/main") -> sha
  labels: Map<string, Label>;
  issues: Map<number, Issue>; // includes pulls (GitHub shares numbering)
  pulls: Map<number, Pull>;
  nextNumber: number;
  nextIssueId: number;
  nextCommentId: number;
  nextLabelId: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 5000;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function createRepo(name: string, opts: { description?: string; private?: boolean; defaultBranch?: string } = {}): Repo {
  const repo: Repo = {
    id: nextRepoId++,
    owner: VIEWER_LOGIN,
    name,
    description: opts.description ?? '',
    private: opts.private ?? false,
    defaultBranch: opts.defaultBranch ?? 'main',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextIssueId: 1,
    nextCommentId: 1,
    nextLabelId: 1,
  };
  repos.set(repoKey(repo.owner, name), repo);
  return repo;
}

/** A repository is visible only under its owner's login; any other owner reads as absent (404). */
export function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}

export function getRepoByName(name: string): Repo | undefined {
  return repos.get(repoKey(VIEWER_LOGIN, name));
}

export function deleteRepo(owner: string, name: string): boolean {
  if (owner !== VIEWER_LOGIN) return false;
  return repos.delete(repoKey(owner, name));
}

export function listRepos(): Repo[] {
  return [...repos.values()].sort((a, b) => a.id - b.id);
}

// ---------------------------------------------------------------- git objects

export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function writeObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function readObject(repo: Repo, sha: string): { type: ObjectType; data: Buffer } | undefined {
  return repo.objects.get(sha);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.toString('utf8', i, sp);
    const nul = data.indexOf(0x00, sp + 1);
    const name = data.toString('utf8', sp + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

/** Git tree ordering: entries sorted by name, directories as if they ended with '/'. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  const m = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(authorLine);
  return {
    tree,
    parents,
    authorLine,
    committerLine,
    authorName: m?.[1] ?? VIEWER_NAME,
    authorEmail: m?.[2] ?? VIEWER_EMAIL,
    authorEpoch: m ? Number(m[3]) : 0,
    message,
    raw: data,
  };
}

export function formatPerson(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

export function makeCommit(
  repo: Repo,
  tree: string,
  parents: string[],
  message: string,
  author: { name: string; email: string; epoch: number } = { name: VIEWER_NAME, email: VIEWER_EMAIL, epoch: Math.floor(Date.now() / 1000) },
): string {
  const person = formatPerson(author.name, author.email, author.epoch);
  let text = `tree ${tree}\n`;
  for (const p of parents) text += `parent ${p}\n`;
  text += `author ${person}\ncommitter ${person}\n\n${message}`;
  if (!text.endsWith('\n')) text += '\n';
  return writeObject(repo, 'commit', Buffer.from(text, 'utf8'));
}

// ---------------------------------------------------------------- refs

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

export function getRef(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function setRef(repo: Repo, ref: string, sha: string): void {
  repo.refs.set(ref, sha);
  repo.updatedAt = new Date().toISOString();
}

export function deleteRef(repo: Repo, ref: string): void {
  repo.refs.delete(ref);
}

/** Resolve a branch name, a full ref, HEAD, or a full sha to a commit sha. */
export function resolveRef(repo: Repo, ref: string): string | undefined {
  if (ref === 'HEAD') {
    const target = repo.refs.get(branchRef(repo.defaultBranch));
    if (target) return target;
  }
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  const asBranch = repo.refs.get(branchRef(ref));
  if (asBranch) return asBranch;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return undefined;
}

export function headSha(repo: Repo, branch?: string): string | undefined {
  return repo.refs.get(branchRef(branch ?? repo.defaultBranch));
}

export function commitTree(repo: Repo, commitSha: string): string | undefined {
  const obj = repo.objects.get(commitSha);
  if (!obj || obj.type !== 'commit') return undefined;
  return parseCommit(obj.data).tree;
}

// ---------------------------------------------------------------- trees as file maps

/** Flatten a tree into path -> {sha, mode} for files (blobs) only. */
export function flattenTree(repo: Repo, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const obj = repo.objects.get(treeSha);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.mode === '40000') flattenTree(repo, e.sha, path, out);
    else out.set(path, { sha: e.sha, mode: e.mode });
  }
  return out;
}

/** Look up one path in a tree; returns {sha, mode, type} or undefined. */
export function lookupPath(repo: Repo, treeSha: string, path: string): { sha: string; mode: string; isTree: boolean } | undefined {
  const parts = path.split('/').filter((p) => p.length > 0);
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return undefined;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return undefined;
    if (i === parts.length - 1) return { sha: entry.sha, mode: entry.mode, isTree: entry.mode === '40000' };
    if (entry.mode !== '40000') return undefined;
    current = entry.sha;
  }
  return undefined;
}

/** Rebuild the tree chain for `parts` with `leaf` (null removes the leaf); returns the new tree sha. */
function rebuildTree(repo: Repo, treeSha: string | undefined, parts: string[], leaf: { sha: string; mode: string } | null): string {
  const entries: TreeEntry[] = treeSha ? parseTree(repo.objects.get(treeSha)?.data ?? Buffer.alloc(0)) : [];
  const name = parts[0] as string;
  const idx = entries.findIndex((e) => e.name === name);
  if (parts.length === 1) {
    if (leaf === null) {
      if (idx !== -1) entries.splice(idx, 1);
    } else if (idx !== -1) entries[idx] = { mode: leaf.mode, name, sha: leaf.sha };
    else entries.push({ mode: leaf.mode, name, sha: leaf.sha });
  } else {
    const sub = idx !== -1 && entries[idx]?.mode === '40000' ? entries[idx]?.sha : undefined;
    const newSub = rebuildTree(repo, sub, parts.slice(1), leaf);
    const empty = (repo.objects.get(newSub)?.data.length ?? 0) === 0;
    if (empty) {
      if (idx !== -1) entries.splice(idx, 1);
    } else if (idx !== -1) entries[idx] = { mode: '40000', name, sha: newSub };
    else entries.push({ mode: '40000', name, sha: newSub });
  }
  return writeObject(repo, 'tree', buildTree(entries));
}

/**
 * Set or delete one file on a branch and commit it. Works on an unborn branch (creates the root
 * commit). Returns the new commit sha and the blob sha (null when deleted).
 */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null } {
  const ref = branchRef(branch);
  const tip = repo.refs.get(ref);
  const tipTree = tip ? commitTree(repo, tip) : undefined;
  let blobSha: string | null = null;
  let leaf: { sha: string; mode: string } | null = null;
  if (content !== null) {
    blobSha = writeObject(repo, 'blob', content);
    leaf = { sha: blobSha, mode: '100644' };
  }
  const parts = path.split('/').filter((p) => p.length > 0);
  const newTree = rebuildTree(repo, tipTree, parts, leaf);
  const commitSha = makeCommit(repo, newTree, tip ? [tip] : [], message);
  repo.refs.set(ref, commitSha);
  repo.updatedAt = new Date().toISOString();
  return { commitSha, blobSha };
}

/** Ancestor walk: is `ancestor` reachable from `from`? */
export function isAncestor(repo: Repo, ancestor: string, from: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj?.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}

/** Merge base of two commits (first common ancestor in BFS order), or undefined. */
export function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const ancestorsOfA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (ancestorsOfA.has(cur)) continue;
    ancestorsOfA.add(cur);
    const obj = repo.objects.get(cur);
    if (obj?.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (ancestorsOfA.has(cur)) return cur;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj?.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return undefined;
}

/** All objects reachable from the given tips (commits, their trees and blobs). */
export function reachableObjects(repo: Repo, tips: string[]): Map<string, { type: ObjectType; data: Buffer }> {
  const out = new Map<string, { type: ObjectType; data: Buffer }>();
  const stack: string[] = [...tips];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (out.has(sha)) continue;
    const obj = repo.objects.get(sha);
    if (!obj) continue;
    out.set(sha, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree, ...c.parents);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.sha);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})/m.exec(obj.data.toString('utf8'));
      if (m?.[1]) stack.push(m[1]);
    }
  }
  return out;
}

/** Line-based diff counts between two blob contents (LCS on lines; small files only in practice). */
export function lineDiffCounts(a: Buffer, b: Buffer): { additions: number; deletions: number } {
  const al = a.toString('utf8').split('\n');
  const bl = b.toString('utf8').split('\n');
  // Trim common prefix/suffix, then LCS on the middle.
  let start = 0;
  while (start < al.length && start < bl.length && al[start] === bl[start]) start += 1;
  let endA = al.length - 1;
  let endB = bl.length - 1;
  while (endA >= start && endB >= start && al[endA] === bl[endB]) { endA -= 1; endB -= 1; }
  const midA = al.slice(start, endA + 1);
  const midB = bl.slice(start, endB + 1);
  if (midA.length === 0) return { additions: midB.length, deletions: 0 };
  if (midB.length === 0) return { additions: 0, deletions: midA.length };
  const dp: number[] = new Array(midB.length + 1).fill(0);
  for (let i = 1; i <= midA.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= midB.length; j += 1) {
      const tmp = dp[j] as number;
      dp[j] = midA[i - 1] === midB[j - 1] ? prev + 1 : Math.max(dp[j] as number, dp[j - 1] as number);
      prev = tmp;
    }
  }
  const lcs = dp[midB.length] as number;
  return { additions: midB.length - lcs, deletions: midA.length - lcs };
}
