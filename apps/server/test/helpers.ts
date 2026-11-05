import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../src/index';
import type { AppRow, Env } from '../src/env';

export const BASE = 'https://appdash.example.workers.dev';
let ipCounter = 0;

/** Call the worker in-process. `cookie` is a `name=value` header value. */
export async function call(path: string, init: RequestInit & { cookie?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  headers.set('cf-connecting-ip', '198.51.100.1');
  if (init.cookie) headers.set('cookie', init.cookie);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(BASE + path, { ...init, headers, body }), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Log in with the test password and return the cookie header value. Each call uses its own IP. */
export async function login(): Promise<string> {
  ipCounter += 1;
  const headers = new Headers({ 'content-type': 'application/json', 'cf-connecting-ip': `203.0.113.${100 + ipCounter}` });
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(BASE + '/api/auth/login', { method: 'POST', headers, body: JSON.stringify({ password: 'test-password-12' }) }),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

/** Create an app through the API, optionally patching it afterwards. */
export async function createApp(cookie: string, patch: Record<string, unknown> = {}): Promise<AppRow> {
  const res = await call('/api/apps', { method: 'POST', cookie, json: { name: 'Test App' } });
  if (res.status !== 200 && res.status !== 201) throw new Error(`createApp failed: ${res.status}`);
  let row = await res.json<AppRow>();
  if (Object.keys(patch).length) {
    const p = await call(`/api/apps/${row.id}`, { method: 'PATCH', cookie, json: patch });
    if (p.status !== 200) throw new Error(`patch failed: ${p.status} ${await p.text()}`);
    row = await p.json<AppRow>();
  }
  return row;
}
