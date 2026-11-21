// Entrypoint for the forge: owns the process lifecycle around the HTTP app in app.ts.
//
// Lifecycle under the trial harness (MAKEFUN_ENV_URL set):
//   1. Bind an ephemeral port and start serving.
//   2. Announce the chosen port to the harness with POST /register.
//   3. Poll GET /done until the harness says it is finished, then shut down cleanly.
// Run locally (no MAKEFUN_ENV_URL), the process simply serves until it is stopped.

import type { Server } from 'node:http';
import { createApp } from './app.ts';

const REGISTER_PAUSE_MS = 400;
const POLL_PAUSE_MS = 150;
const REQUEST_TIMEOUT_MS = 120_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logProblem(what: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`main: ${what}: ${detail}\n`);
}

/** The harness base URL with any trailing slashes removed, or null for a plain local run. */
function harnessBase(): string | null {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') return null;
  return raw.replace(/\/+$/, '');
}

/** Tell the harness where to reach us. Transient failures are retried; the boot budget is generous. */
async function announcePort(base: string, port: number): Promise<void> {
  const endpoint = `${base}/register`;
  const payload = JSON.stringify({ port });
  for (;;) {
    try {
      const reply = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (reply.ok) {
        await reply.text().catch(() => '');
        return;
      }
      logProblem(`register answered HTTP ${reply.status}; retrying`, new Error(endpoint));
    } catch (err) {
      logProblem('register attempt failed; retrying', err);
    }
    await pause(REGISTER_PAUSE_MS);
  }
}

/** Ask the harness whether it is done; one transient failure just means "not yet". */
async function askIfDone(base: string): Promise<boolean> {
  try {
    const reply = await fetch(`${base}/done`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!reply.ok) return false;
    const body: unknown = await reply.json().catch(() => null);
    return (
      typeof body === 'object' &&
      body !== null &&
      (body as { done?: unknown }).done === true
    );
  } catch {
    return false;
  }
}

async function waitUntilDone(base: string): Promise<void> {
  while (!(await askIfDone(base))) {
    await pause(POLL_PAUSE_MS);
  }
}

function stopServing(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Idle keep-alive sockets held by the harness must not delay the exit.
    server.closeIdleConnections();
    setTimeout(resolve, 1_000).unref();
  });
}

async function run(): Promise<void> {
  const server = createApp();

  server.on('error', (err) => {
    logProblem('server error', err);
    process.exit(1);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0: the kernel picks a free ephemeral port (never 8080, the harness's own).
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind a TCP port');
  }

  const base = harnessBase();
  if (base === null) {
    process.stderr.write(`main: serving on port ${address.port} (no harness configured)\n`);
    return; // The listening server itself keeps the process alive.
  }

  await announcePort(base, address.port);
  await waitUntilDone(base);
  await stopServing(server);
  process.exit(0);
}

run().catch((err: unknown) => {
  logProblem('fatal startup failure', err);
  process.exit(1);
});
