// The forge's HTTP server: routing and the shared wire discipline (auth, JSON, request ids).
// Surfaces: git smart HTTP (git.ts), REST v3 (rest.ts), GraphQL v4 (graphql.ts), MCP (mcp.ts),
// all over the one store in store.ts. main.ts owns the lifecycle (bind, register, wait for done).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 512 * 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': randomUUID().toUpperCase(),
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text === '' ? undefined : text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer <redacted> is valid only when it equals the process's MAKEFUN_SHOP_TOKEN exactly. */
export function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return false;
  return (req.headers.authorization ?? '') === `Bearer ${expected}`;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://entry');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      try {
        // The env's boot probe: no auth, called twice.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // GraphQL and MCP answer their own 401s (their checks read the exact bodies), so they are
        // dispatched before the shared auth gate.
        if (path === '/api/graphql') {
          const body = await readBody(req);
          if (await handleGraphQL(req, res, path, body)) return;
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (path === '/mcp') {
          const body = await readBody(req);
          if (await handleMCP(req, res, path, body)) return;
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // Everything else needs the token.
        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req).catch(() => Buffer.alloc(0));
          if (await handleRest(req, res, path, url.searchParams, body)) return;
          sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
          return;
        }

        if (/^\/[^/]+\/[^/]+\.git(\/.*)?$/.test(path)) {
          if (await handleGit(req, res, path, url.searchParams)) return;
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: `Internal Server Error: ${err instanceof Error ? err.message : String(err)}` });
        else res.end();
      }
    })();
  });
}
