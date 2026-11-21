// GraphQL v4 surface (POST /api/graphql): a hand-written mini GraphQL parser + executor over store.ts.
// No dependencies (Node 22 stdlib only, erasable TS). Implements the documents gh / the checks send:
// viewer, repository fields, __type/__schema introspection, issues connection with cursor pagination,
// issue/pullRequest reads, node(id:) round-trip, and the createIssue / closeIssue / createPullRequest /
// mergePullRequest (real squash merge) / addComment mutations. Operation batching (JSON array body)
// is answered in order. Auth is checked here (app.ts dispatches /api/graphql without pre-auth).

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN, VIEWER_ID, VIEWER_NAME,
  getRepo, listRepos, branchRef, resolveRef, commitTree, flattenTree, parseCommit, parseTree,
  readObject, writeObject, buildTree, makeCommit, setRef, mergeBase, lineDiffCounts,
  type Repo, type Issue, type Pull, type IssueComment, type Label, type TreeEntry,
} from './store.ts';

// ------------------------------------------------------------------ http helpers

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return false;
  return (req.headers.authorization ?? '') === `Bearer ${expected}`;
}

// ------------------------------------------------------------------ global ids

function gid(type: string, dbId: number): string {
  return Buffer.from(`${type}:${dbId}`, 'utf8').toString('base64');
}

function parseGid(id: unknown): { type: string; dbId: number } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const m = /^([A-Za-z]+):(\d+)$/.exec(text);
    if (m === null) return null;
    return { type: m[1] as string, dbId: Number(m[2]) };
  } catch {
    return null;
  }
}

function findRepoByGid(id: unknown): Repo | null {
  const p = parseGid(id);
  if (p === null || p.type !== 'Repository') return null;
  return listRepos().find((r) => r.id === p.dbId) ?? null;
}

function findIssueByGid(id: unknown): { repo: Repo; issue: Issue } | null {
  const p = parseGid(id);
  if (p === null || p.type !== 'Issue') return null;
  for (const repo of listRepos()) {
    for (const issue of repo.issues.values()) if (issue.id === p.dbId) return { repo, issue };
  }
  return null;
}

function findPullByGid(id: unknown): { repo: Repo; pull: Pull } | null {
  const p = parseGid(id);
  if (p === null || p.type !== 'PullRequest') return null;
  for (const repo of listRepos()) {
    for (const pull of repo.pulls.values()) if (pull.id === p.dbId) return { repo, pull };
  }
  return null;
}

// ------------------------------------------------------------------ store mutations (shared semantics with REST)

function nowIso(): string {
  return new Date().toISOString();
}

export function createIssueRecord(repo: Repo, input: { title: string; body?: string; labelNames?: string[] }): Issue {
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const issue: Issue = {
    number,
    id: repo.nextIssueId,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...(input.labelNames ?? [])],
    userLogin: VIEWER_LOGIN,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    comments: [],
    isPull: false,
  };
  repo.nextIssueId += 1;
  repo.issues.set(number, issue);
  repo.updatedAt = nowIso();
  return issue;
}

export function createPullRecord(repo: Repo, input: { title: string; body?: string; headRef: string; baseRef: string }): Pull {
  const headSha = resolveRef(repo, input.headRef) ?? '';
  const baseSha = resolveRef(repo, input.baseRef) ?? '';
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const id = repo.nextIssueId;
  repo.nextIssueId += 1;
  const pull: Pull = {
    number, id,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.headRef,
    headSha,
    baseRef: input.baseRef,
    baseSha,
    userLogin: VIEWER_LOGIN,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  repo.pulls.set(number, pull);
  const backing: Issue = {
    number, id,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [],
    userLogin: VIEWER_LOGIN,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    comments: [],
    isPull: true,
  };
  repo.issues.set(number, backing);
  repo.updatedAt = nowIso();
  return pull;
}

/** Rebuild a git tree (recursively) from a flat path -> {sha, mode} map; returns the tree sha. */
function treeFromFiles(repo: Repo, files: Map<string, { sha: string; mode: string }>): string {
  const entries: TreeEntry[] = [];
  const dirs = new Map<string, Map<string, { sha: string; mode: string }>>();
  for (const [path, file] of files) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      entries.push({ mode: file.mode, name: path, sha: file.sha });
    } else {
      const head = path.slice(0, slash);
      let sub = dirs.get(head);
      if (sub === undefined) { sub = new Map(); dirs.set(head, sub); }
      sub.set(path.slice(slash + 1), file);
    }
  }
  for (const [name, sub] of dirs) entries.push({ mode: '40000', name, sha: treeFromFiles(repo, sub) });
  return writeObject(repo, 'tree', buildTree(entries));
}

interface MergeOutcome { ok: true; tree: string; baseTip: string; headSha: string }
interface MergeConflict { ok: false; conflicts: string[] }

/** Three-way file-level merge of head into base (dry-run capable): base = merge-base trees flattened. */
function planMerge(repo: Repo, pull: Pull): MergeOutcome | MergeConflict | { ok: false; error: string } {
  const headSha = resolveRef(repo, pull.headRef) ?? pull.headSha;
  const baseTip = resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  if (headSha === '' || baseTip === '') return { ok: false, error: 'head or base ref does not resolve' };
  const headTree = commitTree(repo, headSha);
  const baseTree = commitTree(repo, baseTip);
  if (headTree === undefined || baseTree === undefined) return { ok: false, error: 'head or base commit has no tree' };
  const mb = mergeBase(repo, baseTip, headSha);
  const mbTree = mb !== undefined ? commitTree(repo, mb) : undefined;
  const baseMap = mbTree !== undefined ? flattenTree(repo, mbTree) : new Map<string, { sha: string; mode: string }>();
  const oursMap = flattenTree(repo, baseTree);
  const theirsMap = flattenTree(repo, headTree);
  const merged = new Map<string, { sha: string; mode: string }>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
  for (const path of paths) {
    const b = baseMap.get(path);
    const o = oursMap.get(path);
    const t = theirsMap.get(path);
    if (o?.sha === t?.sha) {
      if (o !== undefined) merged.set(path, o);
    } else if (b?.sha === o?.sha) {
      if (t !== undefined) merged.set(path, t);
    } else if (b?.sha === t?.sha) {
      if (o !== undefined) merged.set(path, o);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, tree: treeFromFiles(repo, merged), baseTip, headSha };
}

/** A real squash merge: one commit on the base branch holding the merged tree; the pull closes merged. */
export function squashMergePull(repo: Repo, pull: Pull): { sha: string } | { error: string } {
  if (pull.merged) return { error: 'Pull request is already merged' };
  if (pull.state === 'closed') return { error: 'Pull request is closed' };
  const plan = planMerge(repo, pull);
  if (!plan.ok) {
    if ('conflicts' in plan) return { error: `Merge conflict in: ${plan.conflicts.join(', ')}` };
    return { error: plan.error };
  }
  const message = pull.body === '' ? `${pull.title} (#${pull.number})\n` : `${pull.title} (#${pull.number})\n\n${pull.body}\n`;
  const sha = makeCommit(repo, plan.tree, [plan.baseTip], message);
  setRef(repo, branchRef(pull.baseRef), sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  pull.updatedAt = nowIso();
  const backing = repo.issues.get(pull.number);
  if (backing !== undefined) { backing.state = 'closed'; backing.updatedAt = nowIso(); }
  repo.updatedAt = nowIso();
  return { sha };
}

/** Changed files of a pull: merge-base tree vs head tree. */
function pullFiles(repo: Repo, pull: Pull): { path: string; changeType: string; additions: number; deletions: number }[] {
  const headSha = resolveRef(repo, pull.headRef) ?? pull.headSha;
  const baseTip = resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  if (headSha === '' || baseTip === '') return [];
  const mb = mergeBase(repo, baseTip, headSha);
  const fromSha = mb ?? baseTip;
  const fromTree = commitTree(repo, fromSha);
  const headTree = commitTree(repo, headSha);
  if (fromTree === undefined || headTree === undefined) return [];
  const fromMap = flattenTree(repo, fromTree);
  const headMap = flattenTree(repo, headTree);
  const out: { path: string; changeType: string; additions: number; deletions: number }[] = [];
  const paths = new Set<string>([...fromMap.keys(), ...headMap.keys()]);
  for (const path of [...paths].sort()) {
    const a = fromMap.get(path);
    const b = headMap.get(path);
    if (a?.sha === b?.sha) continue;
    const aBuf = a !== undefined ? (readObject(repo, a.sha)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const bBuf = b !== undefined ? (readObject(repo, b.sha)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    const counts = lineDiffCounts(aBuf, bBuf);
    out.push({
      path,
      changeType: a === undefined ? 'ADDED' : b === undefined ? 'DELETED' : 'MODIFIED',
      additions: counts.additions,
      deletions: counts.deletions,
    });
  }
  return out;
}

// ------------------------------------------------------------------ GraphQL tokenizer

type TokKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
interface Tok { kind: TokKind; value: string }

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { toks.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if ('!$():=@[]{}|&'.includes(c)) { toks.push({ kind: 'punct', value: c }); i += 1; continue; }
    if (c === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        toks.push({ kind: 'string', value: src.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'b') out += '\b';
          else if (esc === 'f') out += '\f';
          else if (esc === '/') out += '/';
          else if (esc === '\\') out += '\\';
          else if (esc === '"') out += '"';
          else if (esc === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 4; }
          else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= src.length) throw new Error('unterminated string');
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      if (src[j] === '.') { isFloat = true; j += 1; while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1; }
      if (src[j] === 'e' || src[j] === 'E') { isFloat = true; j += 1; if (src[j] === '+' || src[j] === '-') j += 1; while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1; }
      if (j === i || (j === i + 1 && src[i] === '-')) throw new Error(`invalid number at ${i}`);
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j] as string)) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i}`);
  }
  toks.push({ kind: 'eof', value: '' });
  return toks;
}

// ------------------------------------------------------------------ GraphQL parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface DirectiveNode { name: string; args: { name: string; value: ValueNode }[] }
interface FieldNode { kind: 'field'; alias: string | null; name: string; args: { name: string; value: ValueNode }[]; directives: DirectiveNode[]; selectionSet: SelectionNode[] | null }
interface InlineFragmentNode { kind: 'inline'; typeCondition: string | null; directives: DirectiveNode[]; selectionSet: SelectionNode[] }
interface FragmentSpreadNode { kind: 'spread'; name: string; directives: DirectiveNode[] }
type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface OperationNode { kind: 'operation'; operation: 'query' | 'mutation' | 'subscription'; name: string | null; selectionSet: SelectionNode[] }
interface FragmentNode { kind: 'fragment'; name: string; typeCondition: string; selectionSet: SelectionNode[] }
type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private toks: Tok[];
  private pos = 0;
  constructor(src: string) { this.toks = tokenize(src); }
  private peek(): Tok { return this.toks[this.pos] as Tok; }
  private next(): Tok { const t = this.toks[this.pos] as Tok; this.pos += 1; return t; }
  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected "${v}", got ${t.kind} ${JSON.stringify(t.value)}`);
  }
  private skipPunct(v: string): boolean {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === v) { this.pos += 1; return true; }
    return false;
  }
  private expectName(): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`expected a name, got ${t.kind} ${JSON.stringify(t.value)}`);
    return t.value;
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): DefinitionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, selectionSet: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      this.next();
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
      this.parseDirectives();
      return { kind: 'operation', operation: t.value as OperationNode['operation'], name, selectionSet: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName();
      const onTok = this.next();
      if (onTok.kind !== 'name' || onTok.value !== 'on') throw new Error('expected "on" in fragment definition');
      const typeCondition = this.expectName();
      this.parseDirectives();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`unexpected definition start: ${t.kind} ${JSON.stringify(t.value)}`);
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
      this.parseDirectives();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseDirectives(): DirectiveNode[] {
    const directives: DirectiveNode[] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.expectName();
      const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
      directives.push({ name, args });
    }
    return directives;
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`unexpected value token ${t.kind} ${JSON.stringify(t.value)}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selectionSet: this.parseSelectionSet() };
      }
      const name = this.expectName();
      const directives = this.parseDirectives();
      return { kind: 'spread', name, directives };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, directives, selectionSet };
  }
}

// ------------------------------------------------------------------ schema (introspection data)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'user', 'search', 'rateLimit', 'meta'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository', 'deleteIssue', 'updatePullRequest'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'resourcePath', 'avatarUrl', 'bio', 'company', 'location', 'websiteUrl', 'twitterUsername', 'createdAt', 'updatedAt', 'isViewer', 'isSiteAdmin', 'isHireable', 'repositories', 'issues', 'pullRequests', 'followers', 'following', 'gists', 'organizations', 'starredRepositories', 'watching', 'status', 'pinnedItems', 'viewerCanFollow', 'viewerIsFollowing'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'url', 'resourcePath', 'createdAt', 'updatedAt', 'pushedAt', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'hasDiscussionsEnabled', 'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'label', 'labels', 'stargazerCount', 'stargazers', 'forkCount', 'forks', 'isFork', 'isArchived', 'isDisabled', 'isEmpty', 'isMirror', 'isTemplate', 'primaryLanguage', 'languages', 'licenseInfo', 'sshUrl', 'homepageUrl', 'diskUsage', 'watchers', 'viewerCanAdminister', 'viewerCanSubscribe', 'viewerCanUpdateTopics', 'viewerHasStarred', 'viewerSubscription', 'assignableUsers', 'mentionableUsers', 'collaborators', 'milestone', 'milestones', 'releases', 'release', 'refs', 'ref', 'object', 'parent', 'visibility', 'autoMergeAllowed', 'deleteBranchOnMerge', 'mergeCommitAllowed', 'rebaseMergeAllowed', 'squashMergeAllowed', 'projectsUrl', 'tempCloneToken', 'fundingLinks', 'interactionAbility', 'repositoryTopics', 'shortDescriptionHTML', 'viewerCanDelete', 'codeOfConduct', 'contactLinks', 'securityPolicyUrl', 'issueTypes'],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'bodyHTML', 'bodyText', 'state', 'stateReason', 'author', 'editor', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'locked', 'activeLockReason', 'url', 'resourcePath', 'repository', 'assignees', 'participants', 'milestone', 'projectCards', 'projectItems', 'reactions', 'reactionGroups', 'timelineItems', 'userContentEdits', 'viewerCanReact', 'viewerCanSubscribe', 'viewerCanUpdate', 'viewerDidAuthor', 'viewerSubscription', 'authorAssociation', 'isPinned', 'isReadByViewer', 'linkedBranches', 'issueType', 'duplicateOf', 'parent', 'subIssues', 'trackedIssues', 'trackedInIssues'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'bodyHTML', 'bodyText', 'state', 'merged', 'mergedAt', 'mergedBy', 'mergeCommit', 'potentialMergeCommit', 'mergeable', 'mergeStateStatus', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'headRef', 'baseRef', 'headRepository', 'baseRepository', 'files', 'commits', 'comments', 'reviews', 'author', 'editor', 'labels', 'assignees', 'participants', 'milestone', 'createdAt', 'updatedAt', 'closedAt', 'closed', 'locked', 'activeLockReason', 'url', 'resourcePath', 'repository', 'additions', 'deletions', 'changedFiles', 'isDraft', 'isReadByViewer', 'isCrossRepository', 'headRefDeleted', 'canBeRebased', 'maintainerCanModify', 'viewerCanReact', 'viewerCanSubscribe', 'viewerCanUpdate', 'viewerDidAuthor', 'viewerSubscription', 'authorAssociation', 'autoMergeRequest', 'closingIssuesReferences', 'latestReviews', 'reviewDecision', 'reviewRequests', 'reviewThreads', 'suggestedReviewers', 'timelineItems', 'totalCommentsCount', 'permalink', 'viewerCanEnableAutoMerge', 'viewerCanMergeAsAdmin', 'viewerCanRebase', 'viewerCanSquash'],
  Label: ['id', 'name', 'color', 'description', 'url', 'resourcePath', 'createdAt', 'updatedAt', 'isDefault', 'issues', 'pullRequests', 'repository'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyHTML', 'bodyText', 'author', 'editor', 'createdAt', 'updatedAt', 'url', 'resourcePath', 'repository', 'issue', 'pullRequest', 'reactions', 'viewerCanReact', 'viewerCanUpdate', 'viewerCanDelete', 'authorAssociation', 'isMinimized', 'minimizedReason', 'viaApp', 'lastEditedAt', 'publishedAt'],
  Commit: ['id', 'oid', 'abbreviatedOid', 'message', 'messageHeadline', 'messageBody', 'author', 'committer', 'authoredDate', 'committedDate', 'pushedDate', 'authorEmail', 'committerEmail', 'tree', 'url', 'resourcePath', 'history', 'parents', 'associatedPullRequests', 'comments', 'additions', 'deletions', 'changedFilesIfAvailable', 'repository', 'tarballUrl', 'zipballUrl', 'signature', 'status', 'viewerCanSubscribe'],
  Ref: ['id', 'name', 'prefix', 'target', 'repository', 'associatedPullRequests', 'branchProtectionRule', 'compare'],
  Tree: ['id', 'oid', 'abbreviatedOid', 'entries', 'url', 'repository'],
  TreeEntry: ['name', 'path', 'mode', 'type', 'oid', 'object', 'isGenerated', 'extension', 'lineCount'],
  Blob: ['id', 'oid', 'abbreviatedOid', 'text', 'isBinary', 'isTruncated', 'byteSize', 'url', 'repository', 'commitResourcePath', 'commitUrl'],
  GitActor: ['name', 'email', 'date', 'user', 'avatarUrl'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  RepositoryOwner: ['id', 'login', 'url', 'resourcePath', 'avatarUrl', 'repositories'],
  Actor: ['login', 'id', 'url', 'resourcePath', 'avatarUrl'],
  Node: ['id'],
  UniformResourceLocatable: ['url', 'resourcePath'],
  PullRequestFile: ['path', 'changeType', 'additions', 'deletions', 'patch'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  ReopenIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'comment', 'subject'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue', 'isDeprecated', 'deprecationReason'],
  __Schema: ['description', 'types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args', 'isRepeatable'],
};

const TYPE_KIND: Record<string, string> = {
  SearchType: 'ENUM', IssueState: 'ENUM', PullRequestState: 'ENUM', MergeableState: 'ENUM',
  MergeMethod: 'ENUM', StateReason: 'ENUM', OrderDirection: 'ENUM', IssueOrderField: 'ENUM',
  PullRequestOrderField: 'ENUM', FileChangeType: 'ENUM', Permission: 'ENUM',
  Node: 'INTERFACE', Actor: 'INTERFACE', UniformResourceLocatable: 'INTERFACE', RepositoryOwner: 'INTERFACE',
  String: 'SCALAR', Int: 'SCALAR', Float: 'SCALAR', Boolean: 'SCALAR', ID: 'SCALAR', DateTime: 'SCALAR', URI: 'SCALAR', GitObjectID: 'SCALAR',
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  StateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED', 'DUPLICATE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  FileChangeType: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED'],
  Permission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

function typeKind(name: string): string {
  return TYPE_KIND[name] ?? 'OBJECT';
}

function isKnownType(name: string): boolean {
  return name in TYPE_FIELDS || name in TYPE_KIND || name in ENUM_VALUES;
}

// ------------------------------------------------------------------ wrapped values

interface Wrap {
  __t: string;
  repo?: Repo;
  issue?: Issue;
  pull?: Pull;
  label?: Label;
  comment?: IssueComment;
  login?: string;
  sha?: string;
  refName?: string;
  nodes?: Wrap[];
  totalCount?: number;
  startIndex?: number;
  hasNext?: boolean;
  node?: Wrap | null;
  cursor?: string;
  conn?: Wrap;
  typeName?: string;
  fieldName?: string;
  path?: string;
  changeType?: string;
  additions?: number;
  deletions?: number;
  name?: string;
  mode?: string;
  email?: string;
  date?: string;
  payloadIssue?: Wrap;
  payloadPull?: Wrap;
  edge?: Wrap;
  text?: string;
}

const userWrap = (login: string = VIEWER_LOGIN): Wrap => ({ __t: 'User', login });
const repoWrap = (repo: Repo): Wrap => ({ __t: 'Repository', repo });
const issueWrap = (repo: Repo, issue: Issue): Wrap => ({ __t: 'Issue', repo, issue });
const pullWrap = (repo: Repo, pull: Pull): Wrap => ({ __t: 'PullRequest', repo, pull });
const commentWrap = (repo: Repo, issue: Issue, comment: IssueComment): Wrap => ({ __t: 'IssueComment', repo, issue, comment });
const commitWrap = (repo: Repo, sha: string): Wrap => ({ __t: 'Commit', repo, sha });

function cursorFor(index: number): string {
  return Buffer.from(`arrayconnection:${index}`, 'utf8').toString('base64');
}

function cursorIndex(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^arrayconnection:(\d+)$/.exec(text);
    return m === null ? null : Number(m[1]);
  } catch {
    return null;
  }
}

/** Slice a full list into a connection page honoring first/after (and last/before minimally). */
function paginate<T>(all: T[], args: Record<string, unknown>): { page: T[]; start: number; hasNext: boolean; total: number } {
  let start = 0;
  const afterIdx = cursorIndex(args.after);
  if (afterIdx !== null) start = afterIdx + 1;
  let end = all.length;
  const beforeIdx = cursorIndex(args.before);
  if (beforeIdx !== null) end = Math.min(end, beforeIdx);
  let page: T[];
  if (typeof args.first === 'number') {
    page = all.slice(start, start + Math.max(0, Math.trunc(args.first)));
  } else if (typeof args.last === 'number') {
    const from = Math.max(start, end - Math.max(0, Math.trunc(args.last)));
    page = all.slice(from, end);
    return { page, start: from, hasNext: false, total: all.length };
  } else {
    page = all.slice(start, end);
  }
  return { page, start, hasNext: start + page.length < all.length, total: all.length };
}

function connWrap(nodes: Wrap[], total: number, start: number, hasNext: boolean): Wrap {
  return { __t: 'Connection', nodes, totalCount: total, startIndex: start, hasNext };
}

// ------------------------------------------------------------------ execution context

interface ExecCtx {
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: { message: string; path?: (string | number)[] }[];
}

class GqlError extends Error {}

function evalValue(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'variable': return ctx.variables[node.name];
    case 'string': return node.value;
    case 'int': return node.value;
    case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => evalValue(v, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = evalValue(f.value, ctx);
      return out;
    }
  }
}

function evalArgs(args: { name: string; value: ValueNode }[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) out[a.name] = evalValue(a.value, ctx);
  return out;
}

function directivesAllow(directives: DirectiveNode[], ctx: ExecCtx): boolean {
  for (const d of directives) {
    const args = evalArgs(d.args, ctx);
    if (d.name === 'skip' && args.if === true) return false;
    if (d.name === 'include' && args.if === false) return false;
  }
  return true;
}

// ------------------------------------------------------------------ resolvers

type Resolver = (src: Wrap, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

function repoUrl(repo: Repo): string {
  return `https://github.com/${repo.owner}/${repo.name}`;
}

function sortIssues(issues: Issue[], args: Record<string, unknown>): Issue[] {
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const sorted = [...issues];
  if (orderBy?.direction === 'DESC') sorted.sort((a, b) => b.number - a.number);
  else sorted.sort((a, b) => a.number - b.number);
  return sorted;
}

function filterIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  let list = [...repo.issues.values()].filter((i) => !i.isPull);
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  } else if (typeof args.state === 'string') {
    list = list.filter((i) => i.state === String(args.state).toLowerCase());
  }
  const labels = args.labels as string[] | undefined;
  if (Array.isArray(labels) && labels.length > 0) list = list.filter((i) => labels.every((l) => i.labels.includes(String(l))));
  return sortIssues(list, args);
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open' || pull.merged) return 'UNKNOWN';
  const plan = planMerge(repo, pull);
  return plan.ok ? 'MERGEABLE' : 'CONFLICTING';
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Wrap {
  const all = filterIssues(repo, args);
  const { page, start, hasNext, total } = paginate(all, args);
  return connWrap(page.map((i) => issueWrap(repo, i)), total, start, hasNext);
}

function pullConnection(repo: Repo, args: Record<string, unknown>): Wrap {
  let list = [...repo.pulls.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s)));
    list = list.filter((p) => wanted.has(pullState(p)));
  }
  const orderBy = (args.orderBy ?? null) as { direction?: string } | null;
  list.sort((a, b) => (orderBy?.direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const { page, start, hasNext, total } = paginate(list, args);
  return connWrap(page.map((p) => pullWrap(repo, p)), total, start, hasNext);
}

function labelWrap(repo: Repo, name: string): Wrap {
  const found = repo.labels.get(name);
  const label: Label = found ?? { id: 0, name, color: 'ededed', description: null };
  return { __t: 'Label', repo, label };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userWrap(),
    user: (_s, args) => (args.login === VIEWER_LOGIN ? userWrap() : null),
    repository: (_s, args) => {
      if (typeof args.owner !== 'string' || typeof args.name !== 'string') return null;
      const repo = getRepo(args.owner, args.name);
      return repo !== undefined ? repoWrap(repo) : null;
    },
    node: (_s, args) => resolveNode(args.id),
    nodes: (_s, args) => {
      const ids = Array.isArray(args.ids) ? args.ids : [];
      return ids.map((id) => resolveNode(id));
    },
    __type: (_s, args) => (typeof args.name === 'string' && isKnownType(args.name) ? { __t: '__Type', typeName: args.name } : null),
    __schema: () => ({ __t: '__Schema' }),
    rateLimit: () => ({ __t: 'RateLimit', limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: nowIso(), nodeCount: 0 }),
  },
  Mutation: {
    createIssue: (_s, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGid(input.repositoryId);
      if (repo === null) throw new GqlError('Could not resolve Repository with the given ID.');
      if (typeof input.title !== 'string' || input.title === '') throw new GqlError('Title is required.');
      const labelNames: string[] = [];
      if (Array.isArray(input.labelIds)) {
        for (const lid of input.labelIds) {
          const p = parseGid(lid);
          if (p !== null && p.type === 'Label') {
            for (const label of repo.labels.values()) if (label.id === p.dbId) labelNames.push(label.name);
          }
        }
      }
      if (Array.isArray(input.labels)) for (const l of input.labels) if (typeof l === 'string') labelNames.push(l);
      const issue = createIssueRecord(repo, { title: input.title, body: typeof input.body === 'string' ? input.body : '', labelNames });
      void ctx;
      return { __t: 'CreateIssuePayload', repo, payloadIssue: issueWrap(repo, issue) };
    },
    closeIssue: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGid(input.issueId);
      if (found === null) throw new GqlError('Could not resolve Issue with the given ID.');
      found.issue.state = 'closed';
      found.issue.updatedAt = nowIso();
      return { __t: 'CloseIssuePayload', repo: found.repo, payloadIssue: issueWrap(found.repo, found.issue) };
    },
    reopenIssue: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGid(input.issueId);
      if (found === null) throw new GqlError('Could not resolve Issue with the given ID.');
      found.issue.state = 'open';
      found.issue.updatedAt = nowIso();
      return { __t: 'ReopenIssuePayload', repo: found.repo, payloadIssue: issueWrap(found.repo, found.issue) };
    },
    createPullRequest: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = findRepoByGid(input.repositoryId);
      if (repo === null) throw new GqlError('Could not resolve Repository with the given ID.');
      const stripOwner = (ref: string): string => (ref.includes(':') ? (ref.split(':').pop() as string) : ref);
      const headRefName = stripOwner(String(input.headRefName ?? ''));
      const baseRefName = stripOwner(String(input.baseRefName ?? repo.defaultBranch));
      if (typeof input.title !== 'string' || input.title === '') throw new GqlError('Title is required.');
      if (resolveRef(repo, headRefName) === undefined) throw new GqlError(`Head ref ${headRefName} does not exist.`);
      if (resolveRef(repo, baseRefName) === undefined) throw new GqlError(`Base ref ${baseRefName} does not exist.`);
      const pull = createPullRecord(repo, { title: input.title, body: typeof input.body === 'string' ? input.body : '', headRef: headRefName, baseRef: baseRefName });
      return { __t: 'CreatePullRequestPayload', repo, payloadPull: pullWrap(repo, pull) };
    },
    mergePullRequest: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPullByGid(input.pullRequestId);
      if (found === null) throw new GqlError('Could not resolve PullRequest with the given ID.');
      const result = squashMergePull(found.repo, found.pull);
      if ('error' in result) throw new GqlError(result.error);
      return { __t: 'MergePullRequestPayload', repo: found.repo, payloadPull: pullWrap(found.repo, found.pull) };
    },
    addComment: (_s, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssueByGid(input.subjectId);
      if (found === null) throw new GqlError('Could not resolve subject with the given ID.');
      if (typeof input.body !== 'string') throw new GqlError('Body is required.');
      const comment: IssueComment = {
        id: found.repo.nextCommentId,
        body: input.body,
        userLogin: VIEWER_LOGIN,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      found.issue.updatedAt = nowIso();
      const node = commentWrap(found.repo, found.issue, comment);
      const edge: Wrap = { __t: 'Edge', node, cursor: cursorFor(found.issue.comments.length - 1) };
      return { __t: 'AddCommentPayload', repo: found.repo, issue: found.issue, payloadIssue: issueWrap(found.repo, found.issue), edge, node };
    },
  },
  User: {
    id: (s) => gid('User', s.login === VIEWER_LOGIN || s.login === undefined ? VIEWER_ID : 0),
    databaseId: () => VIEWER_ID,
    login: (s) => s.login ?? VIEWER_LOGIN,
    name: () => VIEWER_NAME,
    email: () => '',
    url: (s) => `https://github.com/${s.login ?? VIEWER_LOGIN}`,
    resourcePath: (s) => `/${s.login ?? VIEWER_LOGIN}`,
    avatarUrl: () => 'https://github.com/identicons/adaiversen.png',
    bio: () => null,
    company: () => null,
    location: () => null,
    websiteUrl: () => null,
    twitterUsername: () => null,
    createdAt: () => '2020-01-01T00:00:00Z',
    updatedAt: () => nowIso(),
    isViewer: (s) => (s.login ?? VIEWER_LOGIN) === VIEWER_LOGIN,
    isSiteAdmin: () => false,
    isHireable: () => false,
    repositories: (_s, args) => {
      const all = listRepos();
      const { page, start, hasNext, total } = paginate(all, args);
      return connWrap(page.map(repoWrap), total, start, hasNext);
    },
  },
  Repository: {
    id: (s) => gid('Repository', (s.repo as Repo).id),
    databaseId: (s) => (s.repo as Repo).id,
    name: (s) => (s.repo as Repo).name,
    nameWithOwner: (s) => `${(s.repo as Repo).owner}/${(s.repo as Repo).name}`,
    owner: (s) => userWrap((s.repo as Repo).owner),
    description: (s) => (s.repo as Repo).description === '' ? null : (s.repo as Repo).description,
    isPrivate: (s) => (s.repo as Repo).private,
    url: (s) => repoUrl(s.repo as Repo),
    resourcePath: (s) => `/${(s.repo as Repo).owner}/${(s.repo as Repo).name}`,
    createdAt: (s) => (s.repo as Repo).createdAt,
    updatedAt: (s) => (s.repo as Repo).updatedAt,
    pushedAt: (s) => (s.repo as Repo).updatedAt,
    defaultBranchRef: (s) => {
      const repo = s.repo as Repo;
      const sha = repo.refs.get(branchRef(repo.defaultBranch));
      if (sha === undefined) return null;
      return { __t: 'Ref', repo, refName: repo.defaultBranch, sha } as Wrap;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasProjectsEnabled: () => true,
    hasWikiEnabled: () => true,
    hasDiscussionsEnabled: () => false,
    hasPullRequestsEnabled: () => true,
    issue: (s, args) => {
      const repo = s.repo as Repo;
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      if (issue === undefined || issue.isPull) return null;
      return issueWrap(repo, issue);
    },
    issues: (s, args) => issueConnection(s.repo as Repo, args),
    pullRequest: (s, args) => {
      const repo = s.repo as Repo;
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull !== undefined ? pullWrap(repo, pull) : null;
    },
    pullRequests: (s, args) => pullConnection(s.repo as Repo, args),
    label: (s, args) => {
      const repo = s.repo as Repo;
      if (typeof args.name !== 'string' || !repo.labels.has(args.name)) return null;
      return labelWrap(repo, args.name);
    },
    labels: (s, args) => {
      const repo = s.repo as Repo;
      const all = [...repo.labels.values()].sort((a, b) => a.id - b.id);
      const { page, start, hasNext, total } = paginate(all, args);
      return connWrap(page.map((l) => ({ __t: 'Label', repo, label: l } as Wrap)), total, start, hasNext);
    },
    stargazerCount: () => 0,
    forkCount: () => 0,
    isFork: () => false,
    isArchived: () => false,
    isDisabled: () => false,
    isEmpty: (s) => (s.repo as Repo).refs.size === 0,
    isMirror: () => false,
    isTemplate: () => false,
    primaryLanguage: () => null,
    licenseInfo: () => null,
    sshUrl: (s) => `git@github.com:${(s.repo as Repo).owner}/${(s.repo as Repo).name}.git`,
    homepageUrl: () => null,
    diskUsage: () => 0,
    viewerCanAdminister: () => true,
    viewerHasStarred: () => false,
    parent: () => null,
    visibility: (s) => ((s.repo as Repo).private ? 'PRIVATE' : 'PUBLIC'),
    autoMergeAllowed: () => false,
    deleteBranchOnMerge: () => false,
    mergeCommitAllowed: () => true,
    rebaseMergeAllowed: () => true,
    squashMergeAllowed: () => true,
    ref: (s, args) => {
      const repo = s.repo as Repo;
      if (typeof args.qualifiedName !== 'string') return null;
      const sha = resolveRef(repo, args.qualifiedName);
      if (sha === undefined) return null;
      const name = args.qualifiedName.replace(/^refs\/heads\//, '');
      return { __t: 'Ref', repo, refName: name, sha } as Wrap;
    },
    object: (s, args) => {
      const repo = s.repo as Repo;
      if (typeof args.oid !== 'string') return null;
      const obj = readObject(repo, args.oid);
      if (obj === undefined) return null;
      if (obj.type === 'commit') return commitWrap(repo, args.oid);
      if (obj.type === 'tree') return { __t: 'Tree', repo, sha: args.oid } as Wrap;
      if (obj.type === 'blob') return { __t: 'Blob', repo, sha: args.oid } as Wrap;
      return null;
    },
  },
  Ref: {
    id: (s) => gid('Ref', 0) === '' ? '' : Buffer.from(`Ref:${(s.repo as Repo).id}:${s.refName ?? ''}`, 'utf8').toString('base64'),
    name: (s) => s.refName ?? '',
    prefix: () => 'refs/heads/',
    target: (s) => commitWrap(s.repo as Repo, s.sha as string),
    repository: (s) => repoWrap(s.repo as Repo),
  },
  Commit: {
    id: (s) => Buffer.from(`Commit:${s.sha ?? ''}`, 'utf8').toString('base64'),
    oid: (s) => s.sha ?? '',
    abbreviatedOid: (s) => (s.sha ?? '').slice(0, 7),
    message: (s) => {
      const obj = readObject(s.repo as Repo, s.sha as string);
      return obj !== undefined ? parseCommit(obj.data).message.trim() : '';
    },
    messageHeadline: (s) => {
      const obj = readObject(s.repo as Repo, s.sha as string);
      if (obj === undefined) return '';
      const msg = parseCommit(obj.data).message;
      return (msg.split('\n')[0] ?? '').trim();
    },
    messageBody: (s) => {
      const obj = readObject(s.repo as Repo, s.sha as string);
      if (obj === undefined) return '';
      const parts = parseCommit(obj.data).message.split('\n');
      return parts.slice(1).join('\n').trim();
    },
    author: (s) => {
      const repo = s.repo as Repo;
      const obj = readObject(repo, s.sha as string);
      if (obj === undefined) return { __t: 'GitActor', name: VIEWER_NAME, email: '', date: nowIso() } as Wrap;
      const c = parseCommit(obj.data);
      return { __t: 'GitActor', name: c.authorName, email: c.authorEmail, date: new Date(c.authorEpoch * 1000).toISOString() } as Wrap;
    },
    committer: (s, _a, ctx) => (RESOLVERS.Commit as Record<string, Resolver>).author(s, {}, ctx),
    authoredDate: (s, _a, ctx) => {
      const a = (RESOLVERS.Commit as Record<string, Resolver>).author(s, {}, ctx) as Wrap;
      return a.date ?? nowIso();
    },
    committedDate: (s, _a, ctx) => (RESOLVERS.Commit as Record<string, Resolver>).authoredDate(s, {}, ctx),
    authorEmail: (s, _a, ctx) => {
      const a = (RESOLVERS.Commit as Record<string, Resolver>).author(s, {}, ctx) as Wrap;
      return a.email ?? '';
    },
    committerEmail: (s, _a, ctx) => (RESOLVERS.Commit as Record<string, Resolver>).authorEmail(s, {}, ctx),
    tree: (s) => {
      const repo = s.repo as Repo;
      const t = commitTree(repo, s.sha as string);
      return t !== undefined ? ({ __t: 'Tree', repo, sha: t } as Wrap) : null;
    },
    url: (s) => `${repoUrl(s.repo as Repo)}/commit/${s.sha ?? ''}`,
    resourcePath: (s) => `/${(s.repo as Repo).owner}/${(s.repo as Repo).name}/commit/${s.sha ?? ''}`,
    parents: (s, args) => {
      const repo = s.repo as Repo;
      const obj = readObject(repo, s.sha as string);
      const parents = obj !== undefined ? parseCommit(obj.data).parents : [];
      const { page, start, hasNext, total } = paginate(parents, args);
      return connWrap(page.map((p) => commitWrap(repo, p)), total, start, hasNext);
    },
    history: (s, args) => {
      const repo = s.repo as Repo;
      const all: string[] = [];
      const seen = new Set<string>();
      const stack = [s.sha as string];
      while (stack.length > 0) {
        const cur = stack.pop() as string;
        if (seen.has(cur)) continue;
        seen.add(cur);
        const obj = readObject(repo, cur);
        if (obj === undefined || obj.type !== 'commit') continue;
        all.push(cur);
        stack.push(...parseCommit(obj.data).parents);
      }
      const { page, start, hasNext, total } = paginate(all, args);
      return connWrap(page.map((p) => commitWrap(repo, p)), total, start, hasNext);
    },
    repository: (s) => repoWrap(s.repo as Repo),
    additions: () => 0,
    deletions: () => 0,
  },
  GitActor: {
    name: (s) => s.name ?? '',
    email: (s) => s.email ?? '',
    date: (s) => s.date ?? nowIso(),
    user: () => userWrap(),
    avatarUrl: () => 'https://github.com/identicons/adaiversen.png',
  },
  Tree: {
    id: (s) => Buffer.from(`Tree:${s.sha ?? ''}`, 'utf8').toString('base64'),
    oid: (s) => s.sha ?? '',
    abbreviatedOid: (s) => (s.sha ?? '').slice(0, 7),
    entries: (s) => {
      const repo = s.repo as Repo;
      const obj = readObject(repo, s.sha as string);
      if (obj === undefined || obj.type !== 'tree') return [];
      return parseTree(obj.data).map((e) => ({ __t: 'TreeEntry', repo, sha: e.sha, name: e.name, path: e.name, mode: e.mode } as Wrap));
    },
    url: (s) => `${repoUrl(s.repo as Repo)}/tree/${s.sha ?? ''}`,
    repository: (s) => repoWrap(s.repo as Repo),
  },
  TreeEntry: {
    name: (s) => s.name ?? '',
    path: (s) => s.path ?? '',
    mode: (s) => parseInt(s.mode ?? '0', 10),
    type: (s) => (s.mode === '40000' ? 'tree' : 'blob'),
    oid: (s) => s.sha ?? '',
    object: (s) => {
      const repo = s.repo as Repo;
      const obj = readObject(repo, s.sha as string);
      if (obj === undefined) return null;
      if (obj.type === 'tree') return { __t: 'Tree', repo, sha: s.sha } as Wrap;
      if (obj.type === 'commit') return commitWrap(repo, s.sha as string);
      return { __t: 'Blob', repo, sha: s.sha } as Wrap;
    },
    isGenerated: () => false,
  },
  Blob: {
    id: (s) => Buffer.from(`Blob:${s.sha ?? ''}`, 'utf8').toString('base64'),
    oid: (s) => s.sha ?? '',
    abbreviatedOid: (s) => (s.sha ?? '').slice(0, 7),
    text: (s) => {
      const obj = readObject(s.repo as Repo, s.sha as string);
      return obj !== undefined ? obj.data.toString('utf8') : '';
    },
    isBinary: () => false,
    isTruncated: () => false,
    byteSize: (s) => readObject(s.repo as Repo, s.sha as string)?.data.length ?? 0,
    url: (s) => `${repoUrl(s.repo as Repo)}/blob/${s.sha ?? ''}`,
    repository: (s) => repoWrap(s.repo as Repo),
  },
  Issue: {
    id: (s) => gid('Issue', (s.issue as Issue).id),
    databaseId: (s) => (s.issue as Issue).id,
    number: (s) => (s.issue as Issue).number,
    title: (s) => (s.issue as Issue).title,
    body: (s) => (s.issue as Issue).body,
    bodyText: (s) => (s.issue as Issue).body,
    bodyHTML: (s) => (s.issue as Issue).body,
    state: (s) => ((s.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    stateReason: (s) => ((s.issue as Issue).state === 'closed' ? 'COMPLETED' : null),
    author: (s) => userWrap((s.issue as Issue).userLogin),
    editor: () => null,
    labels: (s, args) => {
      const issue = s.issue as Issue;
      const repo = s.repo as Repo;
      const { page, start, hasNext, total } = paginate(issue.labels, args);
      return connWrap(page.map((n) => labelWrap(repo, n)), total, start, hasNext);
    },
    comments: (s, args) => {
      const issue = s.issue as Issue;
      const repo = s.repo as Repo;
      const { page, start, hasNext, total } = paginate(issue.comments, args);
      return connWrap(page.map((c) => commentWrap(repo, issue, c)), total, start, hasNext);
    },
    createdAt: (s) => (s.issue as Issue).createdAt,
    updatedAt: (s) => (s.issue as Issue).updatedAt,
    closedAt: (s) => ((s.issue as Issue).state === 'closed' ? (s.issue as Issue).updatedAt : null),
    closed: (s) => (s.issue as Issue).state === 'closed',
    locked: () => false,
    activeLockReason: () => null,
    url: (s) => `${repoUrl(s.repo as Repo)}/issues/${(s.issue as Issue).number}`,
    resourcePath: (s) => `/${(s.repo as Repo).owner}/${(s.repo as Repo).name}/issues/${(s.issue as Issue).number}`,
    repository: (s) => repoWrap(s.repo as Repo),
    authorAssociation: () => 'OWNER',
    viewerCanUpdate: () => true,
    viewerDidAuthor: () => true,
  },
  PullRequest: {
    id: (s) => gid('PullRequest', (s.pull as Pull).id),
    databaseId: (s) => (s.pull as Pull).id,
    number: (s) => (s.pull as Pull).number,
    title: (s) => (s.pull as Pull).title,
    body: (s) => (s.pull as Pull).body,
    bodyText: (s) => (s.pull as Pull).body,
    bodyHTML: (s) => (s.pull as Pull).body,
    state: (s) => pullState(s.pull as Pull),
    merged: (s) => (s.pull as Pull).merged,
    mergedAt: (s) => (s.pull as Pull).mergedAt,
    mergedBy: (s) => ((s.pull as Pull).merged ? userWrap() : null),
    mergeCommit: (s) => {
      const pull = s.pull as Pull;
      return pull.mergeCommitSha !== null ? commitWrap(s.repo as Repo, pull.mergeCommitSha) : null;
    },
    potentialMergeCommit: () => null,
    mergeable: (s) => pullMergeable(s.repo as Repo, s.pull as Pull),
    mergeStateStatus: () => 'UNKNOWN',
    headRefName: (s) => (s.pull as Pull).headRef,
    baseRefName: (s) => (s.pull as Pull).baseRef,
    headRefOid: (s) => resolveRef(s.repo as Repo, (s.pull as Pull).headRef) ?? (s.pull as Pull).headSha,
    baseRefOid: (s) => resolveRef(s.repo as Repo, (s.pull as Pull).baseRef) ?? (s.pull as Pull).baseSha,
    headRef: (s) => {
      const repo = s.repo as Repo;
      const pull = s.pull as Pull;
      const sha = resolveRef(repo, pull.headRef);
      return sha !== undefined ? ({ __t: 'Ref', repo, refName: pull.headRef, sha } as Wrap) : null;
    },
    baseRef: (s) => {
      const repo = s.repo as Repo;
      const pull = s.pull as Pull;
      const sha = resolveRef(repo, pull.baseRef);
      return sha !== undefined ? ({ __t: 'Ref', repo, refName: pull.baseRef, sha } as Wrap) : null;
    },
    headRepository: (s) => repoWrap(s.repo as Repo),
    baseRepository: (s) => repoWrap(s.repo as Repo),
    files: (s, args) => {
      const repo = s.repo as Repo;
      const all = pullFiles(repo, s.pull as Pull).map((f) => ({ __t: 'PullRequestFile', path: f.path, changeType: f.changeType, additions: f.additions, deletions: f.deletions } as Wrap));
      const { page, start, hasNext, total } = paginate(all, args);
      return connWrap(page, total, start, hasNext);
    },
    commits: (s, args) => {
      const repo = s.repo as Repo;
      const pull = s.pull as Pull;
      const headSha = resolveRef(repo, pull.headRef) ?? pull.headSha;
      const baseTip = resolveRef(repo, pull.baseRef) ?? pull.baseSha;
      const all: Wrap[] = [];
      if (headSha !== '') {
        const mb = mergeBase(repo, baseTip, headSha);
        const seen = new Set<string>();
        const stack = [headSha];
        const collected: string[] = [];
        while (stack.length > 0) {
          const cur = stack.pop() as string;
          if (cur === mb || seen.has(cur)) continue;
          seen.add(cur);
          const obj = readObject(repo, cur);
          if (obj === undefined || obj.type !== 'commit') continue;
          collected.push(cur);
          stack.push(...parseCommit(obj.data).parents);
        }
        for (const sha of collected.reverse()) all.push({ __t: 'PullRequestCommit', repo, sha } as Wrap);
      }
      const { page, start, hasNext, total } = paginate(all, args);
      return connWrap(page, total, start, hasNext);
    },
    comments: (s, args) => {
      const repo = s.repo as Repo;
      const backing = repo.issues.get((s.pull as Pull).number);
      const list = backing?.comments ?? [];
      const { page, start, hasNext, total } = paginate(list, args);
      return connWrap(page.map((c) => commentWrap(repo, backing as Issue, c)), total, start, hasNext);
    },
    author: (s) => userWrap((s.pull as Pull).userLogin),
    editor: () => null,
    labels: (s, args) => {
      const repo = s.repo as Repo;
      const backing = repo.issues.get((s.pull as Pull).number);
      const names = backing?.labels ?? [];
      const { page, start, hasNext, total } = paginate(names, args);
      return connWrap(page.map((n) => labelWrap(repo, n)), total, start, hasNext);
    },
    createdAt: (s) => (s.pull as Pull).createdAt,
    updatedAt: (s) => (s.pull as Pull).updatedAt,
    closedAt: (s) => ((s.pull as Pull).state === 'closed' ? (s.pull as Pull).updatedAt : null),
    closed: (s) => (s.pull as Pull).state === 'closed',
    locked: () => false,
    activeLockReason: () => null,
    url: (s) => `${repoUrl(s.repo as Repo)}/pull/${(s.pull as Pull).number}`,
    resourcePath: (s) => `/${(s.repo as Repo).owner}/${(s.repo as Repo).name}/pull/${(s.pull as Pull).number}`,
    repository: (s) => repoWrap(s.repo as Repo),
    additions: (s) => pullFiles(s.repo as Repo, s.pull as Pull).reduce((n, f) => n + f.additions, 0),
    deletions: (s) => pullFiles(s.repo as Repo, s.pull as Pull).reduce((n, f) => n + f.deletions, 0),
    changedFiles: (s) => pullFiles(s.repo as Repo, s.pull as Pull).length,
    isDraft: () => false,
    isCrossRepository: () => false,
    headRefDeleted: () => false,
    canBeRebased: (s) => pullMergeable(s.repo as Repo, s.pull as Pull) === 'MERGEABLE',
    maintainerCanModify: () => true,
    authorAssociation: () => 'OWNER',
    viewerCanUpdate: () => true,
    viewerDidAuthor: () => true,
    totalCommentsCount: (s) => (s.repo as Repo).issues.get((s.pull as Pull).number)?.comments.length ?? 0,
  },
  PullRequestCommit: {
    id: (s) => Buffer.from(`PullRequestCommit:${s.sha ?? ''}`, 'utf8').toString('base64'),
    commit: (s) => commitWrap(s.repo as Repo, s.sha as string),
    oid: (s) => s.sha ?? '',
    url: (s) => `${repoUrl(s.repo as Repo)}/commit/${s.sha ?? ''}`,
    resourcePath: (s) => `/${(s.repo as Repo).owner}/${(s.repo as Repo).name}/commit/${s.sha ?? ''}`,
  },
  PullRequestFile: {
    path: (s) => s.path ?? '',
    changeType: (s) => s.changeType ?? 'MODIFIED',
    additions: (s) => s.additions ?? 0,
    deletions: (s) => s.deletions ?? 0,
    patch: () => null,
  },
  Label: {
    id: (s) => gid('Label', (s.label as Label).id),
    name: (s) => (s.label as Label).name,
    color: (s) => (s.label as Label).color,
    description: (s) => (s.label as Label).description,
    url: (s) => `${repoUrl(s.repo as Repo)}/labels/${encodeURIComponent((s.label as Label).name)}`,
    resourcePath: (s) => `/${(s.repo as Repo).owner}/${(s.repo as Repo).name}/labels/${encodeURIComponent((s.label as Label).name)}`,
    isDefault: () => false,
    createdAt: () => '2020-01-01T00:00:00Z',
    updatedAt: () => nowIso(),
    repository: (s) => repoWrap(s.repo as Repo),
  },
  IssueComment: {
    id: (s) => gid('IssueComment', (s.comment as IssueComment).id),
    databaseId: (s) => (s.comment as IssueComment).id,
    body: (s) => (s.comment as IssueComment).body,
    bodyText: (s) => (s.comment as IssueComment).body,
    bodyHTML: (s) => (s.comment as IssueComment).body,
    author: (s) => userWrap((s.comment as IssueComment).userLogin),
    editor: () => null,
    createdAt: (s) => (s.comment as IssueComment).createdAt,
    updatedAt: (s) => (s.comment as IssueComment).updatedAt,
    url: (s) => `${repoUrl(s.repo as Repo)}/issues/${(s.issue as Issue).number}#issuecomment-${(s.comment as IssueComment).id}`,
    resourcePath: (s) => `/${(s.repo as Repo).owner}/${(s.repo as Repo).name}/issues/${(s.issue as Issue).number}#issuecomment-${(s.comment as IssueComment).id}`,
    repository: (s) => repoWrap(s.repo as Repo),
    issue: (s) => issueWrap(s.repo as Repo, s.issue as Issue),
    authorAssociation: () => 'OWNER',
    viewerCanUpdate: () => true,
    viewerCanDelete: () => true,
    isMinimized: () => false,
    minimizedReason: () => null,
  },
  Connection: {
    nodes: (s) => s.nodes ?? [],
    edges: (s) => (s.nodes ?? []).map((node, i) => ({ __t: 'Edge', node, cursor: cursorFor((s.startIndex ?? 0) + i) } as Wrap)),
    pageInfo: (s) => ({ __t: 'PageInfo', conn: s } as Wrap),
    totalCount: (s) => s.totalCount ?? (s.nodes ?? []).length,
  },
  Edge: {
    node: (s) => s.node ?? null,
    cursor: (s) => s.cursor ?? '',
  },
  PageInfo: {
    hasNextPage: (s) => (s.conn as Wrap).hasNext ?? false,
    hasPreviousPage: (s) => ((s.conn as Wrap).startIndex ?? 0) > 0,
    startCursor: (s) => {
      const conn = s.conn as Wrap;
      return (conn.nodes ?? []).length > 0 ? cursorFor(conn.startIndex ?? 0) : null;
    },
    endCursor: (s) => {
      const conn = s.conn as Wrap;
      const n = (conn.nodes ?? []).length;
      return n > 0 ? cursorFor((conn.startIndex ?? 0) + n - 1) : null;
    },
  },
  RateLimit: {
    limit: (s) => 5000,
    cost: () => 1,
    remaining: () => 4999,
    used: () => 1,
    resetAt: () => nowIso(),
    nodeCount: () => 0,
  },
  CreateIssuePayload: {
    clientMutationId: () => null,
    issue: (s) => s.payloadIssue ?? null,
  },
  CloseIssuePayload: {
    clientMutationId: () => null,
    issue: (s) => s.payloadIssue ?? null,
  },
  ReopenIssuePayload: {
    clientMutationId: () => null,
    issue: (s) => s.payloadIssue ?? null,
  },
  CreatePullRequestPayload: {
    clientMutationId: () => null,
    pullRequest: (s) => s.payloadPull ?? null,
  },
  MergePullRequestPayload: {
    clientMutationId: () => null,
    pullRequest: (s) => s.payloadPull ?? null,
  },
  AddCommentPayload: {
    clientMutationId: () => null,
    commentEdge: (s) => s.edge ?? null,
    comment: (s) => s.node ?? null,
    subject: (s) => s.payloadIssue ?? null,
  },
  __Type: {
    name: (s) => s.typeName ?? '',
    kind: (s) => typeKind(s.typeName as string),
    description: () => null,
    fields: (s) => {
      const fields = TYPE_FIELDS[s.typeName as string];
      if (fields === undefined) return null;
      return fields.map((f) => ({ __t: '__Field', fieldName: f } as Wrap));
    },
    enumValues: (s) => {
      const values = ENUM_VALUES[s.typeName as string];
      if (values === undefined) return null;
      return values.map((v) => ({ __t: '__EnumValue', fieldName: v } as Wrap));
    },
    possibleTypes: () => null,
    inputFields: () => null,
    ofType: () => null,
    specifiedByURL: () => null,
  },
  __Field: {
    name: (s) => s.fieldName ?? '',
    description: () => null,
    args: () => [],
    type: () => ({ __t: '__Type', typeName: 'String' } as Wrap),
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (s) => s.fieldName ?? '',
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    description: () => null,
    types: () => [...new Set([...Object.keys(TYPE_FIELDS), ...Object.keys(TYPE_KIND), ...Object.keys(ENUM_VALUES)])].map((n) => ({ __t: '__Type', typeName: n } as Wrap)),
    queryType: () => ({ __t: '__Type', typeName: 'Query' } as Wrap),
    mutationType: () => ({ __t: '__Type', typeName: 'Mutation' } as Wrap),
    subscriptionType: () => null,
    directives: () => [],
  },
};

function resolveNode(id: unknown): Wrap | null {
  const p = parseGid(id);
  if (p === null) return null;
  if (p.type === 'Repository') {
    const repo = listRepos().find((r) => r.id === p.dbId);
    return repo !== undefined ? repoWrap(repo) : null;
  }
  if (p.type === 'Issue') {
    const found = findIssueByGid(id);
    return found !== null ? issueWrap(found.repo, found.issue) : null;
  }
  if (p.type === 'PullRequest') {
    const found = findPullByGid(id);
    return found !== null ? pullWrap(found.repo, found.pull) : null;
  }
  if (p.type === 'User') return userWrap();
  if (p.type === 'Label') {
    for (const repo of listRepos()) {
      for (const label of repo.labels.values()) if (label.id === p.dbId) return { __t: 'Label', repo, label } as Wrap;
    }
    return null;
  }
  if (p.type === 'IssueComment') {
    for (const repo of listRepos()) {
      for (const issue of repo.issues.values()) {
        for (const comment of issue.comments) if (comment.id === p.dbId) return commentWrap(repo, issue, comment);
      }
    }
    return null;
  }
  return null;
}

// ------------------------------------------------------------------ executor

const ROOT_WRAP: Wrap = { __t: 'Query' };

function typeOfValue(value: unknown, fallback: string): string {
  if (value !== null && typeof value === 'object' && '__t' in (value as Wrap)) return (value as Wrap).__t;
  return fallback;
}

function executeSelectionSet(typeName: string, src: unknown, selections: SelectionNode[], ctx: ExecCtx, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (!directivesAllow(sel.directives, ctx)) continue;
    if (sel.kind === 'inline') {
      if (sel.typeCondition !== null && sel.typeCondition !== typeName && sel.typeCondition !== 'Node' && sel.typeCondition !== 'Actor') continue;
      Object.assign(out, executeSelectionSet(typeName, src, sel.selectionSet, ctx, path));
      continue;
    }
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name);
      if (frag === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path });
        continue;
      }
      if (frag.typeCondition !== typeName && frag.typeCondition !== 'Node' && frag.typeCondition !== 'Actor') continue;
      Object.assign(out, executeSelectionSet(typeName, src, frag.selectionSet, ctx, path));
      continue;
    }
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    if (sel.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const isRoot = typeName === 'Query' || typeName === 'Mutation';
    const wrap: Wrap = isRoot ? ROOT_WRAP : (src as Wrap);
    let resolver: Resolver | undefined;
    if (sel.name === '__type' && typeName === 'Query') resolver = (RESOLVERS.Query as Record<string, Resolver>).__type;
    else if (sel.name === '__schema' && typeName === 'Query') resolver = (RESOLVERS.Query as Record<string, Resolver>).__schema;
    else resolver = RESOLVERS[typeName]?.[sel.name];
    if (resolver === undefined) {
      // Plain-object fallback for small wrapper types (payload scalars etc.).
      const raw = (src as Record<string, unknown> | null)?.[sel.name];
      if (!isRoot && raw !== undefined && typeof raw !== 'function') {
        out[key] = completeValue(typeOfValue(raw, typeName), raw, sel, ctx, fieldPath);
        continue;
      }
      ctx.errors.push({ message: `Field '${sel.name}' doesn't exist on type '${typeName}'`, path: fieldPath });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolver(wrap, evalArgs(sel.args, ctx), ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(typeOfValue(value, typeName), value, sel, ctx, fieldPath);
  }
  return out;
}

function completeValue(inferredType: string, value: unknown, sel: FieldNode, ctx: ExecCtx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, i) => completeValue(typeOfValue(item, inferredType), item, sel, ctx, [...path, i]));
  }
  if (typeof value === 'object') {
    const w = value as Wrap;
    if (w.__t === 'Connection') {
      if (sel.selectionSet === null) return { nodes: [], edges: [], pageInfo: null, totalCount: w.totalCount ?? 0 };
      return executeSelectionSet('Connection', w, sel.selectionSet, ctx, path);
    }
    const t = w.__t;
    if (sel.selectionSet === null) return {};
    return executeSelectionSet(t, w, sel.selectionSet, ctx, path);
  }
  return value;
}

function executeOperation(op: OperationNode, fragments: Map<string, FragmentNode>, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string; path?: (string | number)[] }[] } {
  const ctx: ExecCtx = { variables, fragments, errors: [] };
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, ROOT_WRAP, op.selectionSet, ctx, []);
  const result: { data: Record<string, unknown> | null; errors?: { message: string; path?: (string | number)[] }[] } = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

function executeDocument(queryText: string, variables: Record<string, unknown>, operationName: string | undefined): { data: unknown; errors?: unknown[] } {
  let defs: DefinitionNode[];
  try {
    defs = new Parser(queryText).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `Parse error: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const d of defs) {
    if (d.kind === 'fragment') fragments.set(d.name, d);
    else operations.push(d);
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'No operation found in document.' }] };
  let op: OperationNode | undefined;
  if (operationName !== undefined && operationName !== '') op = operations.find((o) => o.name === operationName);
  else if (operations.length === 1) op = operations[0];
  else op = operations.find((o) => o.operation === 'query') ?? operations[0];
  if (op === undefined) return { data: null, errors: [{ message: `Operation "${operationName ?? ''}" not found.` }] };
  return executeOperation(op, fragments, variables);
}

// ------------------------------------------------------------------ handler

export function handleGraphQL(req: IncomingMessage, res: ServerResponse, pathname: string, body: Buffer): boolean {
  if (pathname !== '/api/graphql') return false;
  if (req.method !== 'POST') return false;
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/graphql' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON.' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => runOne(entry));
    sendJson(res, 200, results);
    return true;
  }
  const result = runOne(parsed);
  sendJson(res, 200, result);
  return true;
}

function runOne(entry: unknown): { data: unknown; errors?: unknown[] } {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'Operation must be a JSON object with a query.' }] };
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.query !== 'string' || record.query === '') {
    return { data: null, errors: [{ message: 'A query string is required.' }] };
  }
  const variables = (record.variables !== null && typeof record.variables === 'object' && !Array.isArray(record.variables))
    ? (record.variables as Record<string, unknown>)
    : {};
  const operationName = typeof record.operationName === 'string' ? record.operationName : undefined;
  return executeDocument(record.query, variables, operationName);
}
