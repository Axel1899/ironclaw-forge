// MCP surface (POST /mcp): JSON-RPC 2.0 over Streamable HTTP, both protocol eras the suite accepts.
// Modern: server/discover answers supportedVersions + capabilities + serverInfo in one request.
// Legacy: initialize + notifications/initialized, with an Mcp-Session-Id header handed out on initialize.
// Tools operate on the one store in store.ts, so objects created here are the same objects REST reads.
// No dependencies (Node 22 stdlib only, erasable TS). Auth is checked here (app.ts dispatches /mcp
// without pre-auth): a request without the bearer token is HTTP 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  getRepo, getRepoByName, createRepo, resolveRef,
  type Repo, type Issue, type Pull,
} from './store.ts';
import { createIssueRecord, createPullRecord, squashMergePull } from './graphql.ts';

// ------------------------------------------------------------------ http / auth

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text === '' ? undefined : text);
}

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return false;
  return (req.headers.authorization ?? '') === `Bearer ${expected}`;
}

// ------------------------------------------------------------------ plain object views (REST-shaped)

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description === '' ? null : repo.description,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${issue.id}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { id: label?.id ?? 0, name, color: label?.color ?? 'ededed', description: label?.description ?? null };
    }),
    user: { login: issue.userLogin, id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://api.github.com/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = resolveRef(repo, pull.headRef) ?? pull.headSha;
  const baseSha = resolveRef(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${pull.id}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}`, repo: repoJson(repo) },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}`, repo: repoJson(repo) },
    user: { login: pull.userLogin, id: 1000, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

// ------------------------------------------------------------------ tools (constant: byte-identical tools/list)

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const STRING = { type: 'string' } as const;

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: objectSchema(
      { owner: STRING, name: STRING, description: STRING, private: { type: 'boolean' } },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, title: STRING, body: STRING, labels: { type: 'array', items: { type: 'string' } } },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed or all).',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number.',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, number: { type: 'number' } }, ['owner', 'repo', 'number']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, title: STRING, body: STRING, head: STRING, base: STRING },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state (open, closed or all).',
    inputSchema: objectSchema({ owner: STRING, repo: STRING, state: STRING }, ['owner', 'repo']),
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: objectSchema(
      { owner: STRING, repo: STRING, pull_number: { type: 'number' } },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

const REQUIRED_ARGS: Record<string, string[]> = {
  create_repo: ['name'],
  get_repo: ['owner', 'repo'],
  create_issue: ['owner', 'repo', 'title'],
  list_issues: ['owner', 'repo'],
  get_issue: ['owner', 'repo', 'number'],
  create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
  list_pull_requests: ['owner', 'repo'],
  merge_pull_request: ['owner', 'repo', 'pull_number'],
};

class ToolFailure extends Error {}

function needRepo(args: Record<string, unknown>): Repo {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  const repo = getRepo(owner, name);
  if (repo === undefined) throw new ToolFailure(`repository ${owner}/${name} not found`);
  return repo;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

function num(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return NaN;
}

function runTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const repoName = str(args, 'name');
      const existing = getRepoByName(repoName);
      if (existing !== undefined) return repoJson(existing);
      const repo = createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        private: typeof args.private === 'boolean' ? args.private : false,
      });
      return repoJson(repo);
    }
    case 'get_repo': {
      return repoJson(needRepo(args));
    }
    case 'create_issue': {
      const repo = needRepo(args);
      const labelNames: string[] = [];
      if (Array.isArray(args.labels)) {
        for (const raw of args.labels) {
          if (typeof raw !== 'string') continue;
          if (!repo.labels.has(raw)) {
            const label = { id: repo.nextLabelId, name: raw, color: 'ededed', description: null as string | null };
            repo.nextLabelId += 1;
            repo.labels.set(raw, label);
          }
          labelNames.push(raw);
        }
      }
      const issue = createIssueRecord(repo, { title: str(args, 'title'), body: str(args, 'body'), labelNames });
      return issueJson(repo, issue);
    }
    case 'list_issues': {
      const repo = needRepo(args);
      const state = str(args, 'state') === '' ? 'open' : str(args, 'state');
      let list = [...repo.issues.values()].filter((i) => !i.isPull);
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.number - b.number);
      return list.map((i) => issueJson(repo, i));
    }
    case 'get_issue': {
      const repo = needRepo(args);
      const issue = repo.issues.get(num(args, 'number'));
      if (issue === undefined || issue.isPull) throw new ToolFailure(`issue #${String(args.number)} not found in ${repo.owner}/${repo.name}`);
      return issueJson(repo, issue);
    }
    case 'create_pull_request': {
      const repo = needRepo(args);
      const stripOwner = (ref: string): string => (ref.includes(':') ? (ref.split(':').pop() as string) : ref);
      const head = stripOwner(str(args, 'head'));
      const base = stripOwner(str(args, 'base')) || repo.defaultBranch;
      if (resolveRef(repo, head) === undefined) throw new ToolFailure(`head branch ${head} does not exist`);
      if (resolveRef(repo, base) === undefined) throw new ToolFailure(`base branch ${base} does not exist`);
      const pull = createPullRecord(repo, { title: str(args, 'title'), body: str(args, 'body'), headRef: head, baseRef: base });
      return pullJson(repo, pull);
    }
    case 'list_pull_requests': {
      const repo = needRepo(args);
      const state = str(args, 'state') === '' ? 'open' : str(args, 'state');
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((p) => p.state === 'open' && !p.merged);
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed' || p.merged);
      list.sort((a, b) => a.number - b.number);
      return list.map((p) => pullJson(repo, p));
    }
    case 'merge_pull_request': {
      const repo = needRepo(args);
      const pull = repo.pulls.get(num(args, 'pull_number'));
      if (pull === undefined) throw new ToolFailure(`pull request #${String(args.pull_number)} not found in ${repo.owner}/${repo.name}`);
      const result = squashMergePull(repo, pull);
      if ('error' in result) throw new ToolFailure(result.error);
      return { ...pullJson(repo, pull), sha: result.sha, merged: true };
    }
    default:
      throw new ToolFailure(`unknown tool ${name}`);
  }
}

// ------------------------------------------------------------------ JSON-RPC

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
const SESSION_ID = randomUUID();

type JsonRpcId = string | number | null;

interface RpcRequest {
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function toolResultOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolResultError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function dispatch(request: RpcRequest): { status: number; body: Record<string, unknown> | null; session: boolean } {
  const hasId = 'id' in request && request.id !== undefined;
  const id: JsonRpcId = hasId ? (request.id as JsonRpcId) : null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params !== null && typeof request.params === 'object' && !Array.isArray(request.params))
    ? (request.params as Record<string, unknown>)
    : {};

  // Notifications (no id): accepted, never answered with a JSON-RPC body.
  if (!hasId) return { status: 202, body: null, session: false };

  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        session: false,
        body: rpcResult(id, {
          resultType: 'complete',
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
          _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
        }),
      };
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-06-18';
      return {
        status: 200,
        session: true,
        body: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        }),
      };
    }
    case 'ping':
      return { status: 200, session: false, body: rpcResult(id, {}) };
    case 'tools/list':
      return { status: 200, session: false, body: rpcResult(id, { tools: TOOLS }) };
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments))
        ? (params.arguments as Record<string, unknown>)
        : {};
      const def = TOOLS.find((t) => t.name === toolName);
      if (def === undefined) {
        return { status: 200, session: false, body: rpcError(id, -32602, `Unknown tool: ${toolName === '' ? '(missing name)' : toolName}`) };
      }
      const required = REQUIRED_ARGS[toolName] ?? [];
      const missing = required.filter((key) => toolArgs[key] === undefined || toolArgs[key] === null || toolArgs[key] === '');
      if (missing.length > 0) {
        return { status: 200, session: false, body: rpcError(id, -32602, `Missing required arguments for ${toolName}: ${missing.join(', ')}`) };
      }
      try {
        const value = runTool(toolName, toolArgs);
        return { status: 200, session: false, body: rpcResult(id, toolResultOk(value)) };
      } catch (err) {
        if (err instanceof ToolFailure) return { status: 200, session: false, body: rpcResult(id, toolResultError(err.message)) };
        return { status: 200, session: false, body: rpcResult(id, toolResultError(err instanceof Error ? err.message : String(err))) };
      }
    }
    default:
      return { status: 200, session: false, body: rpcError(id, -32601, `Method not found: ${method === '' ? '(missing method)' : method}`) };
  }
}

// ------------------------------------------------------------------ handler

export function handleMCP(req: IncomingMessage, res: ServerResponse, pathname: string, body: Buffer): boolean {
  if (pathname !== '/mcp') return false;
  if (req.method === 'DELETE') {
    // Legacy session teardown: best-effort goodbye.
    sendJson(res, 200, undefined);
    return true;
  }
  if (req.method !== 'POST') return false;
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error: request body is not valid JSON'));
    return true;
  }
  if (Array.isArray(parsed)) {
    const bodies: Record<string, unknown>[] = [];
    for (const entry of parsed) {
      if (entry !== null && typeof entry === 'object') {
        const out = dispatch(entry as RpcRequest);
        if (out.body !== null) bodies.push(out.body);
      }
    }
    sendJson(res, 200, bodies);
    return true;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object'));
    return true;
  }
  const out = dispatch(parsed as RpcRequest);
  if (out.body === null) {
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
    res.end();
    return true;
  }
  sendJson(res, out.status, out.body, out.session ? { 'mcp-session-id': SESSION_ID } : {});
  return true;
}
