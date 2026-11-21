// REST v3 surface: root/meta/user, repos, git refs, branches, commits, contents, labels,
// issues (+comments) and pulls (+files, squash merge). All state goes through store.ts so
// objects created here are the same objects the git/GraphQL/MCP surfaces see.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_NAME,
  VIEWER_EMAIL,
  branchRef,
  buildTree,
  commitFile,
  commitTree,
  createRepo,
  deleteRepo,
  flattenTree,
  getRepo,
  getRef,
  lineDiffCounts,
  listRepos,
  lookupPath,
  makeCommit,
  mergeBase,
  parseCommit,
  parseTree,
  readObject,
  resolveRef,
  setRef,
  writeObject,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type TreeEntry,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const API_BASE = 'https://api.github.com';
const WEB_BASE = 'https://github.com';

// --------------------------------------------------------------------------- helpers

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const requestId = randomUUID().toUpperCase();
  if (status === 204) {
    res.writeHead(204, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId, ...headers });
    res.end();
    return;
  }
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId,
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text === '' ? undefined : text);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

function fail(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

function decodeSeg(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

type JsonBody = Record<string, unknown>;

/** Parse the request body; returns null when a non-empty body is not valid JSON. */
function parseBody(body: Buffer): JsonBody | null {
  if (body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as JsonBody;
    return {};
  } catch {
    return null;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function userJson(login: string = VIEWER_LOGIN): Record<string, unknown> {
  const id = login === VIEWER_LOGIN ? VIEWER_ID : 0;
  return {
    login,
    id,
    node_id: `U_${id}`,
    avatar_url: `${WEB_BASE}/${login}.png`,
    gravatar_id: '',
    url: `${API_BASE}/users/${login}`,
    html_url: `${WEB_BASE}/${login}`,
    followers_url: `${API_BASE}/users/${login}/followers`,
    following_url: `${API_BASE}/users/${login}/following{/other_user}`,
    gists_url: `${API_BASE}/users/${login}/gists{/gist_id}`,
    starred_url: `${API_BASE}/users/${login}/starred{/owner}{/repo}`,
    subscriptions_url: `${API_BASE}/users/${login}/subscriptions`,
    organizations_url: `${API_BASE}/users/${login}/orgs`,
    repos_url: `${API_BASE}/users/${login}/repos`,
    events_url: `${API_BASE}/users/${login}/events{/privacy}`,
    received_events_url: `${API_BASE}/users/${login}/received_events`,
    type: 'User',
    site_admin: false,
  };
}

function viewerJson(): Record<string, unknown> {
  return {
    ...userJson(),
    name: VIEWER_NAME,
    company: null,
    blog: '',
    location: null,
    email: VIEWER_EMAIL,
    hireable: null,
    bio: null,
    twitter_username: null,
    public_repos: listRepos().length,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: '2020-01-01T00:00:00Z',
    updated_at: new Date().toISOString(),
  };
}

// --------------------------------------------------------------------------- shapes

export function repoJson(repo: Repo): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open' && !i.isPull).length
    + [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: full,
    owner: userJson(repo.owner),
    private: repo.private,
    html_url: `${WEB_BASE}/${full}`,
    description: repo.description,
    fork: false,
    url: `${API_BASE}/repos/${full}`,
    forks_url: `${API_BASE}/repos/${full}/forks`,
    keys_url: `${API_BASE}/repos/${full}/keys{/key_id}`,
    collaborators_url: `${API_BASE}/repos/${full}/collaborators{/collaborator}`,
    teams_url: `${API_BASE}/repos/${full}/teams`,
    hooks_url: `${API_BASE}/repos/${full}/hooks`,
    issue_events_url: `${API_BASE}/repos/${full}/issues/events{/number}`,
    events_url: `${API_BASE}/repos/${full}/events`,
    assignees_url: `${API_BASE}/repos/${full}/assignees{/user}`,
    branches_url: `${API_BASE}/repos/${full}/branches{/branch}`,
    tags_url: `${API_BASE}/repos/${full}/tags`,
    blobs_url: `${API_BASE}/repos/${full}/git/blobs{/sha}`,
    git_tags_url: `${API_BASE}/repos/${full}/git/tags{/sha}`,
    git_refs_url: `${API_BASE}/repos/${full}/git/refs{/sha}`,
    trees_url: `${API_BASE}/repos/${full}/git/trees{/sha}`,
    statuses_url: `${API_BASE}/repos/${full}/statuses/{sha}`,
    languages_url: `${API_BASE}/repos/${full}/languages`,
    stargazers_url: `${API_BASE}/repos/${full}/stargazers`,
    contributors_url: `${API_BASE}/repos/${full}/contributors`,
    subscribers_url: `${API_BASE}/repos/${full}/subscribers`,
    subscription_url: `${API_BASE}/repos/${full}/subscription`,
    commits_url: `${API_BASE}/repos/${full}/commits{/sha}`,
    git_commits_url: `${API_BASE}/repos/${full}/git/commits{/sha}`,
    comments_url: `${API_BASE}/repos/${full}/comments{/number}`,
    issue_comment_url: `${API_BASE}/repos/${full}/issues/comments{/number}`,
    contents_url: `${API_BASE}/repos/${full}/contents/{+path}`,
    compare_url: `${API_BASE}/repos/${full}/compare/{base}...{head}`,
    merges_url: `${API_BASE}/repos/${full}/merges`,
    archive_url: `${API_BASE}/repos/${full}/{archive_format}{/ref}`,
    downloads_url: `${API_BASE}/repos/${full}/downloads`,
    issues_url: `${API_BASE}/repos/${full}/issues{/number}`,
    pulls_url: `${API_BASE}/repos/${full}/pulls{/number}`,
    milestones_url: `${API_BASE}/repos/${full}/milestones{/number}`,
    notifications_url: `${API_BASE}/repos/${full}/notifications{?since,all,participating}`,
    labels_url: `${API_BASE}/repos/${full}/labels{/name}`,
    releases_url: `${API_BASE}/repos/${full}/releases{/id}`,
    deployments_url: `${API_BASE}/repos/${full}/deployments`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${full}.git`,
    ssh_url: `git@github.com:${full}.git`,
    clone_url: `${WEB_BASE}/${full}.git`,
    svn_url: `${WEB_BASE}/${full}`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: label.id,
    node_id: `LA_${label.id}`,
    url: `${API_BASE}/repos/${full}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function labelForName(repo: Repo, name: string): Record<string, unknown> {
  const found = repo.labels.get(name);
  if (found) return labelJson(repo, found);
  return {
    id: 0,
    node_id: 'LA_0',
    url: `${API_BASE}/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: 'ededed',
    default: false,
    description: null,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `${API_BASE}/repos/${full}/issues/${issue.number}`,
    repository_url: `${API_BASE}/repos/${full}`,
    labels_url: `${API_BASE}/repos/${full}/issues/${issue.number}/labels{/name}`,
    comments_url: `${API_BASE}/repos/${full}/issues/${issue.number}/comments`,
    events_url: `${API_BASE}/repos/${full}/issues/${issue.number}/events`,
    html_url: `${WEB_BASE}/${full}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.userLogin),
    labels: issue.labels.map((name) => labelForName(repo, name)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function pullSide(repo: Repo, ref: string, sha: string, labelOwner: string): Record<string, unknown> {
  return {
    label: `${labelOwner}:${ref}`,
    ref,
    sha,
    user: userJson(repo.owner),
    repo: repoJson(repo),
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  const headSha = resolveRef(repo, pull.headRef) ?? pull.headSha;
  const baseSha = resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    url: `${API_BASE}/repos/${full}/pulls/${pull.number}`,
    html_url: `${WEB_BASE}/${full}/pull/${pull.number}`,
    diff_url: `${WEB_BASE}/${full}/pull/${pull.number}.diff`,
    patch_url: `${WEB_BASE}/${full}/pull/${pull.number}.patch`,
    issue_url: `${API_BASE}/repos/${full}/issues/${pull.number}`,
    commits_url: `${API_BASE}/repos/${full}/pulls/${pull.number}/commits`,
    review_comments_url: `${API_BASE}/repos/${full}/pulls/${pull.number}/comments`,
    review_comment_url: `${API_BASE}/repos/${full}/pulls/comments{/number}`,
    comments_url: `${API_BASE}/repos/${full}/issues/${pull.number}/comments`,
    statuses_url: `${API_BASE}/statuses/${headSha}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(pull.userLogin),
    labels: [],
    milestone: null,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? (pull.mergedAt ?? pull.updatedAt) : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: pullSide(repo, pull.headRef, headSha, repo.owner),
    base: pullSide(repo, pull.baseRef, baseSha, repo.owner),
    _links: {
      self: { href: `${API_BASE}/repos/${full}/pulls/${pull.number}` },
      html: { href: `${WEB_BASE}/${full}/pull/${pull.number}` },
      issue: { href: `${API_BASE}/repos/${full}/issues/${pull.number}` },
      comments: { href: `${API_BASE}/repos/${full}/issues/${pull.number}/comments` },
      review_comments: { href: `${API_BASE}/repos/${full}/pulls/${pull.number}/comments` },
      review_comment: { href: `${API_BASE}/repos/${full}/pulls/comments{/number}` },
      commits: { href: `${API_BASE}/repos/${full}/pulls/${pull.number}/commits` },
      statuses: { href: `${API_BASE}/statuses/${headSha}` },
    },
    author_association: 'OWNER',
    draft: false,
    merged: pull.merged,
    mergeable: pull.merged ? false : null,
    rebaseable: null,
    mergeable_state: 'unknown',
    merged_by: pull.merged ? userJson(pull.userLogin) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; userLogin: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    url: `${API_BASE}/repos/${full}/issues/comments/${comment.id}`,
    html_url: `${WEB_BASE}/${full}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `${API_BASE}/repos/${full}/issues/${issue.number}`,
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

// --------------------------------------------------------------------------- git helpers

function parsePerson(line: string): { name: string; email: string; date: string } {
  const m = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!m) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: new Date(0).toISOString() };
  return { name: m[1] as string, email: m[2] as string, date: new Date(Number(m[3]) * 1000).toISOString() };
}

function personUser(repo: Repo, email: string): Record<string, unknown> | null {
  void repo;
  return email === VIEWER_EMAIL ? userJson() : null;
}

function commitSummary(repo: Repo, sha: string): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  const obj = readObject(repo, sha);
  const parsed = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const author = parsed ? parsePerson(parsed.authorLine) : { name: VIEWER_NAME, email: VIEWER_EMAIL, date: new Date().toISOString() };
  const committer = parsed ? parsePerson(parsed.committerLine) : author;
  return {
    sha,
    node_id: `C_${sha}`,
    url: `${API_BASE}/repos/${full}/git/commits/${sha}`,
    html_url: `${WEB_BASE}/${full}/commit/${sha}`,
    author,
    committer,
    message: parsed?.message.trimEnd() ?? '',
    tree: { sha: parsed?.tree ?? '', url: `${API_BASE}/repos/${full}/git/trees/${parsed?.tree ?? ''}` },
    parents: (parsed?.parents ?? []).map((p) => ({ sha: p, url: `${API_BASE}/repos/${full}/git/commits/${p}`, html_url: `${WEB_BASE}/${full}/commit/${p}` })),
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  const obj = readObject(repo, sha);
  const parsed = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const author = parsed ? parsePerson(parsed.authorLine) : { name: VIEWER_NAME, email: VIEWER_EMAIL, date: new Date().toISOString() };
  const committer = parsed ? parsePerson(parsed.committerLine) : author;
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      author,
      committer,
      message: parsed?.message.trimEnd() ?? '',
      tree: { sha: parsed?.tree ?? '', url: `${API_BASE}/repos/${full}/git/trees/${parsed?.tree ?? ''}` },
      url: `${API_BASE}/repos/${full}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${API_BASE}/repos/${full}/commits/${sha}`,
    html_url: `${WEB_BASE}/${full}/commit/${sha}`,
    comments_url: `${API_BASE}/repos/${full}/commits/${sha}/comments`,
    author: personUser(repo, author.email),
    committer: personUser(repo, committer.email),
    parents: (parsed?.parents ?? []).map((p) => ({ sha: p, url: `${API_BASE}/repos/${full}/commits/${p}`, html_url: `${WEB_BASE}/${full}/commit/${p}` })),
  };
}

/** Walk ancestry from a tip, tip first. */
function walkCommits(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = readObject(repo, cur);
    if (!obj || obj.type !== 'commit') continue;
    out.push(cur);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return out;
}

/** Build one tree sha from a flat path -> blob map (used by squash merge). */
function treeFromFlat(repo: Repo, flat: Map<string, { sha: string; mode: string }>): string {
  interface Dir {
    files: Map<string, { sha: string; mode: string }>;
    dirs: Map<string, Dir>;
  }
  const newDir = (): Dir => ({ files: new Map(), dirs: new Map() });
  const root = newDir();
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const name = parts[i] as string;
      if (!dir.dirs.has(name)) dir.dirs.set(name, newDir());
      dir = dir.dirs.get(name) as Dir;
    }
    dir.files.set(parts[parts.length - 1] as string, entry);
  }
  const build = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, sha: entry.sha });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, sha: build(sub) });
    return writeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

// --------------------------------------------------------------------------- pagination

interface Page {
  perPage: number;
  page: number;
}

function pageOf(query: URLSearchParams): Page {
  const perRaw = Number(query.get('per_page'));
  const pageRaw = Number(query.get('page'));
  const perPage = Number.isFinite(perRaw) && perRaw > 0 ? Math.min(Math.floor(perRaw), 100) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

function paginate<T>(req: IncomingMessage, pathname: string, query: URLSearchParams, items: T[]): { slice: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageOf(query);
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (total > 0 && (page < lastPage || page > 1)) {
    const host = req.headers.host ?? 'localhost';
    const make = (p: number): string => {
      const params = new URLSearchParams(query);
      params.set('per_page', String(perPage));
      params.set('page', String(p));
      return `<http://${host}${pathname}?${params.toString()}>`;
    };
    const parts: string[] = [];
    if (page < lastPage) {
      parts.push(`${make(page + 1)}; rel="next"`);
      parts.push(`${make(lastPage)}; rel="last"`);
    }
    if (page > 1) {
      parts.push(`${make(1)}; rel="first"`);
      parts.push(`${make(page - 1)}; rel="prev"`);
    }
    if (parts.length > 0) headers.link = parts.join(', ');
  }
  return { slice, headers };
}

// --------------------------------------------------------------------------- main handler

export function handleRest(req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams, body: Buffer): Promise<boolean> | boolean {
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;
  const method = (req.method ?? 'GET').toUpperCase();
  const rest = pathname.slice('/api/v3'.length);
  const segs = rest.split('/').filter((s) => s.length > 0).map(decodeSeg);

  // Malformed JSON on any body-carrying method under /api/v3 is a 400.
  let json: JsonBody = {};
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const parsed = parseBody(body);
    if (parsed === null) {
      fail(res, 400, 'Problems parsing JSON');
      return true;
    }
    json = parsed;
  }

  // ----- root / meta / user
  if (segs.length === 0) {
    if (method !== 'GET') return notFoundTrue(res);
    sendJson(res, 200, {
      current_user_url: `${API_BASE}/user`,
      current_user_authorizations_html_url: `${WEB_BASE}/settings/connections/applications{/client_id}`,
      authorizations_url: `${API_BASE}/authorizations`,
      code_search_url: `${API_BASE}/search/code?q={query}{&page,per_page,sort,order}`,
      commit_search_url: `${API_BASE}/search/commits?q={query}{&page,per_page,sort,order}`,
      emails_url: `${API_BASE}/user/emails`,
      emojis_url: `${API_BASE}/emojis`,
      events_url: `${API_BASE}/events`,
      feeds_url: `${API_BASE}/feeds`,
      followers_url: `${API_BASE}/user/followers`,
      following_url: `${API_BASE}/user/following{/target}`,
      gists_url: `${API_BASE}/gists{/gist_id}`,
      hub_url: `${API_BASE}/hub`,
      issue_search_url: `${API_BASE}/search/issues?q={query}{&page,per_page,sort,order}`,
      issues_url: `${API_BASE}/issues`,
      keys_url: `${API_BASE}/user/keys`,
      label_search_url: `${API_BASE}/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
      notifications_url: `${API_BASE}/notifications`,
      organization_url: `${API_BASE}/orgs/{org}`,
      organization_repositories_url: `${API_BASE}/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_teams_url: `${API_BASE}/orgs/{org}/teams`,
      public_gists_url: `${API_BASE}/gists/public`,
      rate_limit_url: `${API_BASE}/rate_limit`,
      repository_url: `${API_BASE}/repos/{owner}/{repo}`,
      repository_search_url: `${API_BASE}/search/repositories?q={query}{&page,per_page,sort,order}`,
      current_user_repositories_url: `${API_BASE}/user/repos{?type,page,per_page,sort}`,
      starred_url: `${API_BASE}/user/starred{/owner}{/repo}`,
      starred_gists_url: `${API_BASE}/gists/starred`,
      user_url: `${API_BASE}/users/{user}`,
      user_organizations_url: `${API_BASE}/users/{user}/orgs`,
      user_repositories_url: `${API_BASE}/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${API_BASE}/search/users?q={query}{&page,per_page,sort,order}`,
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (segs.length === 1 && segs[0] === 'meta') {
    if (method !== 'GET') return notFoundTrue(res);
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      installed_version: '1.0.0',
    });
    return true;
  }

  if (segs.length === 1 && segs[0] === 'user') {
    if (method !== 'GET') return notFoundTrue(res);
    sendJson(res, 200, viewerJson());
    return true;
  }

  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const all = listRepos().map(repoJson);
      const { slice, headers } = paginate(req, pathname, query, all);
      sendJson(res, 200, slice, headers);
      return true;
    }
    if (method === 'POST') {
      const name = str(json.name);
      if (name === undefined || name === '') {
        fail(res, 422, 'Repository creation failed.');
        return true;
      }
      if (listRepos().some((r) => r.name === name)) {
        sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return true;
      }
      const repo = createRepo(name, {
        description: str(json.description) ?? '',
        private: typeof json.private === 'boolean' ? json.private : false,
        defaultBranch: str(json.default_branch) ?? str(json.defaultBranch) ?? 'main',
      });
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    return notFoundTrue(res);
  }

  // ----- /repos/{owner}/{name}/...
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = segs[1] as string;
    const name = segs[2] as string;
    const repo = getRepo(owner, name);
    if (!repo) return notFoundTrue(res);
    const sub = segs.slice(3);
    const full = `${repo.owner}/${repo.name}`;
    const repoPath = `/api/v3/repos/${owner}/${name}`;

    if (sub.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        if (typeof json.description === 'string') repo.description = json.description;
        if (typeof json.private === 'boolean') repo.private = json.private;
        if (typeof json.name === 'string' && json.name !== '') repo.name = json.name;
        if (typeof json.default_branch === 'string' && json.default_branch !== '') repo.defaultBranch = json.default_branch;
        repo.updatedAt = new Date().toISOString();
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        deleteRepo(owner, name);
        sendJson(res, 204, undefined);
        return true;
      }
      return notFoundTrue(res);
    }

    // ----- git refs
    if (sub[0] === 'git' && sub[1] === 'refs') {
      if (method === 'POST' && sub.length === 2) {
        const ref = str(json.ref);
        const sha = str(json.sha);
        if (ref === undefined || sha === undefined) {
          fail(res, 422, 'Validation Failed');
          return true;
        }
        setRef(repo, ref, sha);
        sendJson(res, 201, refJson(repo, ref, sha));
        return true;
      }
      if (method === 'GET') {
        if (sub.length === 2) {
          const list = [...repo.refs.entries()].map(([ref, sha]) => refJson(repo, ref, sha));
          sendJson(res, 200, list);
          return true;
        }
        const tail = sub.slice(2).join('/');
        const fullRef = tail.startsWith('refs/') ? tail : `refs/${tail}`;
        const sha = getRef(repo, fullRef);
        if (sha === undefined) return notFoundTrue(res);
        sendJson(res, 200, refJson(repo, fullRef, sha));
        return true;
      }
      return notFoundTrue(res);
    }
    if (sub[0] === 'git' && sub[1] === 'ref' && method === 'GET') {
      const tail = sub.slice(2).join('/');
      const fullRef = tail.startsWith('refs/') ? tail : `refs/${tail}`;
      const sha = getRef(repo, fullRef);
      if (sha === undefined) return notFoundTrue(res);
      sendJson(res, 200, refJson(repo, fullRef, sha));
      return true;
    }

    // ----- branches
    if (sub[0] === 'branches') {
      if (method !== 'GET') return notFoundTrue(res);
      if (sub.length === 1) {
        const branches: Record<string, unknown>[] = [];
        for (const [ref, sha] of repo.refs) {
          if (!ref.startsWith('refs/heads/')) continue;
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha, url: `${API_BASE}/repos/${full}/commits/${sha}` }, protected: false });
        }
        branches.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
        sendJson(res, 200, branches);
        return true;
      }
      const branch = sub.slice(1).join('/');
      const sha = getRef(repo, branchRef(branch));
      if (sha === undefined) return notFoundTrue(res);
      sendJson(res, 200, { name: branch, commit: { sha, url: `${API_BASE}/repos/${full}/commits/${sha}` }, protected: false, protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } } });
      return true;
    }

    // ----- commits
    if (sub[0] === 'commits') {
      if (method !== 'GET') return notFoundTrue(res);
      if (sub.length === 1) {
        const refParam = query.get('sha') ?? repo.defaultBranch;
        const tip = resolveRef(repo, refParam);
        if (tip === undefined) {
          sendJson(res, 200, []);
          return true;
        }
        sendJson(res, 200, walkCommits(repo, tip).map((sha) => commitJson(repo, sha)));
        return true;
      }
      const sha = sub[1] as string;
      const obj = readObject(repo, sha);
      if (!obj || obj.type !== 'commit') return notFoundTrue(res);
      sendJson(res, 200, commitJson(repo, sha));
      return true;
    }

    // ----- contents
    if (sub[0] === 'contents') {
      const path = sub.slice(1).join('/');
      return handleContents(req, res, repo, method, path, query, json);
    }

    // ----- labels
    if (sub[0] === 'labels') {
      if (sub.length === 1) {
        if (method === 'GET') {
          sendJson(res, 200, [...repo.labels.values()].sort((a, b) => a.id - b.id).map((l) => labelJson(repo, l)));
          return true;
        }
        if (method === 'POST') {
          const labelName = str(json.name);
          if (labelName === undefined || labelName === '') {
            fail(res, 422, 'Validation Failed');
            return true;
          }
          if (repo.labels.has(labelName)) {
            fail(res, 422, 'Validation Failed: name already exists');
            return true;
          }
          const colorRaw = str(json.color) ?? 'ededed';
          const label: Label = {
            id: repo.nextLabelId++,
            name: labelName,
            color: colorRaw.replace(/^#/, '').toLowerCase(),
            description: typeof json.description === 'string' ? json.description : null,
          };
          repo.labels.set(labelName, label);
          sendJson(res, 201, labelJson(repo, label));
          return true;
        }
        return notFoundTrue(res);
      }
      if (method === 'GET') {
        const label = repo.labels.get(sub.slice(1).join('/'));
        if (!label) return notFoundTrue(res);
        sendJson(res, 200, labelJson(repo, label));
        return true;
      }
      return notFoundTrue(res);
    }

    // ----- issues
    if (sub[0] === 'issues') {
      return handleIssues(req, res, repo, method, sub, pathname, query, json);
    }

    // ----- pulls
    if (sub[0] === 'pulls') {
      return handlePulls(req, res, repo, method, sub, pathname, query, json);
    }

    void repoPath;
    return notFoundTrue(res);
  }

  return notFoundTrue(res);
}

function notFoundTrue(res: ServerResponse): boolean {
  notFound(res);
  return true;
}

function refJson(repo: Repo, ref: string, sha: string): Record<string, unknown> {
  const full = `${repo.owner}/${repo.name}`;
  return {
    ref,
    node_id: `REF_${ref}`,
    url: `${API_BASE}/repos/${full}/git/ref/${ref.replace(/^refs\//, '')}`,
    object: { sha, type: 'commit', url: `${API_BASE}/repos/${full}/git/commits/${sha}` },
  };
}

// --------------------------------------------------------------------------- contents

function handleContents(req: IncomingMessage, res: ServerResponse, repo: Repo, method: string, path: string, query: URLSearchParams, json: JsonBody): boolean {
  void req;
  const full = `${repo.owner}/${repo.name}`;
  const entryJson = (name: string, p: string, sha: string, size: number, isTree: boolean): Record<string, unknown> => ({
    name,
    path: p,
    sha,
    size,
    url: `${API_BASE}/repos/${full}/contents/${p}`,
    html_url: `${WEB_BASE}/${full}/blob/${repo.defaultBranch}/${p}`,
    git_url: `${API_BASE}/repos/${full}/git/${isTree ? 'trees' : 'blobs'}/${sha}`,
    download_url: isTree ? null : `${WEB_BASE}/${full}/raw/${repo.defaultBranch}/${p}`,
    type: isTree ? 'dir' : 'file',
    _links: {
      self: `${API_BASE}/repos/${full}/contents/${p}`,
      git: `${API_BASE}/repos/${full}/git/${isTree ? 'trees' : 'blobs'}/${sha}`,
      html: `${WEB_BASE}/${full}/blob/${repo.defaultBranch}/${p}`,
    },
  });

  if (method === 'GET') {
    const refParam = query.get('ref') ?? repo.defaultBranch;
    const tip = resolveRef(repo, refParam);
    if (tip === undefined) return notFoundTrue(res);
    const treeSha = commitTree(repo, tip);
    if (treeSha === undefined) return notFoundTrue(res);
    if (path === '') {
      const obj = readObject(repo, treeSha);
      const entries = obj ? parseTree(obj.data) : [];
      sendJson(res, 200, entries.map((e) => entryJson(e.name, e.name, e.sha, 0, e.mode === '40000')));
      return true;
    }
    const found = lookupPath(repo, treeSha, path);
    if (!found) return notFoundTrue(res);
    if (found.isTree) {
      const obj = readObject(repo, found.sha);
      const entries = obj ? parseTree(obj.data) : [];
      sendJson(res, 200, entries.map((e) => entryJson(e.name, `${path}/${e.name}`, e.sha, 0, e.mode === '40000')));
      return true;
    }
    const blob = readObject(repo, found.sha);
    const data = blob?.data ?? Buffer.alloc(0);
    const base = path.split('/').pop() ?? path;
    sendJson(res, 200, {
      ...entryJson(base, path, found.sha, data.length, false),
      encoding: 'base64',
      content: data.toString('base64'),
    });
    return true;
  }

  if (method === 'PUT') {
    if (path === '') {
      fail(res, 422, 'Validation Failed');
      return true;
    }
    const branch = str(json.branch) ?? repo.defaultBranch;
    const message = str(json.message) ?? 'Update file';
    const contentB64 = str(json.content);
    if (contentB64 === undefined) {
      fail(res, 422, 'Validation Failed');
      return true;
    }
    // Existing blob, for create-vs-update status and the stale-sha check.
    let existingSha: string | undefined;
    const tipBefore = resolveRef(repo, branch);
    if (tipBefore !== undefined) {
      const treeSha = commitTree(repo, tipBefore);
      if (treeSha !== undefined) {
        const found = lookupPath(repo, treeSha, path);
        if (found && !found.isTree) existingSha = found.sha;
        else if (found && found.isTree) {
          fail(res, 422, 'Validation Failed');
          return true;
        }
      }
    }
    const givenSha = str(json.sha);
    if (givenSha !== undefined && givenSha !== existingSha) {
      fail(res, 409, `${path} does not match ${givenSha}`);
      return true;
    }
    const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const { commitSha, blobSha } = commitFile(repo, branch, path, data, message);
    const base = path.split('/').pop() ?? path;
    sendJson(res, existingSha === undefined ? 201 : 200, {
      content: {
        ...entryJson(base, path, blobSha ?? '', data.length, false),
        encoding: 'base64',
      },
      commit: commitSummary(repo, commitSha),
    });
    return true;
  }

  if (method === 'DELETE') {
    if (path === '') return notFoundTrue(res);
    const branch = str(json.branch) ?? repo.defaultBranch;
    const message = str(json.message) ?? 'Delete file';
    const tip = resolveRef(repo, branch);
    if (tip === undefined) return notFoundTrue(res);
    const treeSha = commitTree(repo, tip);
    if (treeSha === undefined) return notFoundTrue(res);
    const found = lookupPath(repo, treeSha, path);
    if (!found || found.isTree) return notFoundTrue(res);
    const givenSha = str(json.sha);
    if (givenSha !== undefined && givenSha !== found.sha) {
      fail(res, 409, `${path} does not match ${givenSha}`);
      return true;
    }
    const { commitSha } = commitFile(repo, branch, path, null, message);
    sendJson(res, 200, { content: null, commit: commitSummary(repo, commitSha) });
    return true;
  }

  return notFoundTrue(res);
}

// --------------------------------------------------------------------------- issues

function labelNamesOf(repo: Repo, input: unknown): { names: string[] } | { error: string } {
  if (input === undefined) return { names: [] };
  if (!Array.isArray(input)) return { error: 'labels must be an array' };
  const names: string[] = [];
  for (const item of input) {
    const name = typeof item === 'string' ? item : (typeof item === 'object' && item !== null ? str((item as JsonBody).name) : undefined);
    if (name === undefined) return { error: 'invalid label' };
    if (!repo.labels.has(name)) return { error: `label ${name} does not exist` };
    names.push(name);
  }
  return { names };
}

function handleIssues(req: IncomingMessage, res: ServerResponse, repo: Repo, method: string, sub: string[], pathname: string, query: URLSearchParams, json: JsonBody): boolean {
  if (sub.length === 1) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.issues.values()].filter((i) => !i.isPull);
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      const direction = query.get('direction') ?? (query.get('sort') ? 'desc' : 'desc');
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { slice, headers } = paginate(req, pathname, query, list);
      sendJson(res, 200, slice.map((i) => issueJson(repo, i)), headers);
      return true;
    }
    if (method === 'POST') {
      const title = str(json.title);
      if (title === undefined || title === '') {
        fail(res, 422, 'Validation Failed');
        return true;
      }
      const labelResult = labelNamesOf(repo, json.labels);
      if ('error' in labelResult) {
        fail(res, 422, `Validation Failed: ${labelResult.error}`);
        return true;
      }
      const now = new Date().toISOString();
      const issue: Issue = {
        number: repo.nextNumber++,
        id: repo.nextIssueId++,
        title,
        body: typeof json.body === 'string' ? json.body : '',
        state: 'open',
        labels: labelResult.names,
        userLogin: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
        comments: [],
        isPull: false,
      };
      repo.issues.set(issue.number, issue);
      repo.updatedAt = now;
      sendJson(res, 201, issueJson(repo, issue));
      return true;
    }
    return notFoundTrue(res);
  }

  const number = Number(sub[1]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
  if (!issue || issue.isPull) return notFoundTrue(res);

  if (sub.length === 2) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      if (json.labels !== undefined) {
        const labelResult = labelNamesOf(repo, json.labels);
        if ('error' in labelResult) {
          fail(res, 422, `Validation Failed: ${labelResult.error}`);
          return true;
        }
        issue.labels = labelResult.names;
      }
      if (typeof json.title === 'string') issue.title = json.title;
      if (typeof json.body === 'string') issue.body = json.body;
      if (json.state === 'open' || json.state === 'closed') issue.state = json.state;
      issue.updatedAt = new Date().toISOString();
      sendJson(res, 200, issueJson(repo, issue));
      return true;
    }
    return notFoundTrue(res);
  }

  if (sub.length === 3 && sub[2] === 'comments') {
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => commentJson(repo, issue, c)));
      return true;
    }
    if (method === 'POST') {
      const bodyText = str(json.body);
      if (bodyText === undefined) {
        fail(res, 422, 'Validation Failed');
        return true;
      }
      const now = new Date().toISOString();
      const comment = { id: repo.nextCommentId++, body: bodyText, userLogin: VIEWER_LOGIN, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      issue.updatedAt = now;
      sendJson(res, 201, commentJson(repo, issue, comment));
      return true;
    }
    return notFoundTrue(res);
  }

  return notFoundTrue(res);
}

// --------------------------------------------------------------------------- pulls

function normalizeRef(input: string): string {
  const colon = input.indexOf(':');
  return colon === -1 ? input : input.slice(colon + 1);
}

function handlePulls(req: IncomingMessage, res: ServerResponse, repo: Repo, method: string, sub: string[], pathname: string, query: URLSearchParams, json: JsonBody): boolean {
  const full = `${repo.owner}/${repo.name}`;
  if (sub.length === 1) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      const direction = query.get('direction') ?? 'desc';
      list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { slice, headers } = paginate(req, pathname, query, list);
      sendJson(res, 200, slice.map((p) => pullJson(repo, p)), headers);
      return true;
    }
    if (method === 'POST') {
      const title = str(json.title);
      const headRaw = str(json.head);
      const baseRaw = str(json.base) ?? repo.defaultBranch;
      if (title === undefined || headRaw === undefined) {
        fail(res, 422, 'Validation Failed');
        return true;
      }
      const headRef = normalizeRef(headRaw);
      const baseRef = normalizeRef(baseRaw);
      const headSha = resolveRef(repo, headRef);
      const baseSha = resolveRef(repo, baseRef);
      if (headSha === undefined || baseSha === undefined) {
        fail(res, 422, 'Validation Failed: head or base ref does not exist');
        return true;
      }
      const now = new Date().toISOString();
      const pull: Pull = {
        number: repo.nextNumber++,
        id: repo.nextIssueId++,
        title,
        body: typeof json.body === 'string' ? json.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef,
        headSha,
        baseRef,
        baseSha,
        userLogin: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
      };
      repo.pulls.set(pull.number, pull);
      repo.updatedAt = now;
      sendJson(res, 201, pullJson(repo, pull));
      return true;
    }
    return notFoundTrue(res);
  }

  const number = Number(sub[1]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;

  if (sub.length === 3 && sub[2] === 'merge') {
    if (method !== 'PUT') return notFoundTrue(res);
    if (!pull) return notFoundTrue(res);
    return mergePullHandler(res, repo, pull, json);
  }

  if (!pull) return notFoundTrue(res);

  if (sub.length === 2) {
    if (method !== 'GET') return notFoundTrue(res);
    sendJson(res, 200, pullJson(repo, pull));
    return true;
  }

  if (sub.length === 3 && sub[2] === 'files') {
    if (method !== 'GET') return notFoundTrue(res);
    const baseTree = commitTree(repo, pull.baseSha);
    const headTree = commitTree(repo, pull.headSha);
    const baseFlat = baseTree ? flattenTree(repo, baseTree) : new Map<string, { sha: string; mode: string }>();
    const headFlat = headTree ? flattenTree(repo, headTree) : new Map<string, { sha: string; mode: string }>();
    const paths = [...new Set([...baseFlat.keys(), ...headFlat.keys()])].sort();
    const files: Record<string, unknown>[] = [];
    for (const p of paths) {
      const b = baseFlat.get(p);
      const h = headFlat.get(p);
      if (b && h && b.sha === h.sha) continue;
      const status = !b ? 'added' : !h ? 'removed' : 'modified';
      const baseData = b ? (readObject(repo, b.sha)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
      const headData = h ? (readObject(repo, h.sha)?.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
      const countLines = (buf: Buffer): number => {
        if (buf.length === 0) return 0;
        const text = buf.toString('utf8');
        const n = text.split('\n').length;
        return text.endsWith('\n') ? n - 1 : n;
      };
      const counts = status === 'added'
        ? { additions: countLines(headData), deletions: 0 }
        : status === 'removed'
          ? { additions: 0, deletions: countLines(baseData) }
          : lineDiffCounts(baseData, headData);
      files.push({
        sha: (h ?? b)?.sha ?? '',
        filename: p,
        status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        blob_url: `${API_BASE}/repos/${full}/git/blobs/${(h ?? b)?.sha ?? ''}`,
        raw_url: `${WEB_BASE}/${full}/raw/${pull.headRef}/${p}`,
        contents_url: `${API_BASE}/repos/${full}/contents/${p}?ref=${pull.headRef}`,
      });
    }
    sendJson(res, 200, files);
    return true;
  }

  return notFoundTrue(res);
}

function mergePullHandler(res: ServerResponse, repo: Repo, pull: Pull, json: JsonBody): boolean {
  const baseTip = resolveRef(repo, pull.baseRef);
  const headTip = resolveRef(repo, pull.headRef) ?? pull.headSha;
  if (baseTip === undefined || headTip === undefined) {
    fail(res, 405, 'Pull Request is not mergeable');
    return true;
  }
  const baseCommitTree = commitTree(repo, baseTip);
  const headCommitTree = commitTree(repo, headTip);
  if (baseCommitTree === undefined || headCommitTree === undefined) {
    fail(res, 405, 'Pull Request is not mergeable');
    return true;
  }
  const ancestorSha = mergeBase(repo, baseTip, headTip);
  const ancestorTree = ancestorSha ? commitTree(repo, ancestorSha) : undefined;
  const ancestorFlat = ancestorTree ? flattenTree(repo, ancestorTree) : new Map<string, { sha: string; mode: string }>();
  const baseFlat = flattenTree(repo, baseCommitTree);
  const headFlat = flattenTree(repo, headCommitTree);

  const result = new Map<string, { sha: string; mode: string }>();
  const allPaths = new Set([...ancestorFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  for (const p of allPaths) {
    const a = ancestorFlat.get(p)?.sha;
    const b = baseFlat.get(p)?.sha;
    const h = headFlat.get(p)?.sha;
    if (b === h) {
      const entry = baseFlat.get(p) ?? headFlat.get(p);
      if (entry) result.set(p, entry);
    } else if (a === b) {
      const entry = headFlat.get(p);
      if (entry) result.set(p, entry);
    } else if (a === h) {
      const entry = baseFlat.get(p);
      if (entry) result.set(p, entry);
    } else {
      fail(res, 405, 'Pull Request is not mergeable');
      return true;
    }
  }

  const resultTree = treeFromFlat(repo, result);
  const titlePart = str(json.commit_title) ?? pull.title;
  const extra = str(json.commit_message);
  const message = extra ? `${titlePart}\n\n${extra}` : titlePart;
  const mergeSha = makeCommit(repo, resultTree, [baseTip], message);
  setRef(repo, branchRef(pull.baseRef), mergeSha);

  const now = new Date().toISOString();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now;
  pull.mergeCommitSha = mergeSha;
  pull.updatedAt = now;
  repo.updatedAt = now;

  sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
  return true;
}
