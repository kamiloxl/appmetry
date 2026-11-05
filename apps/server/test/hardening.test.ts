import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';

const BASE = 'https://appdash.example.workers.dev';

async function call(path: string, init: RequestInit = {}, bindings: Partial<Env> = {}, base = BASE) {
  const headers = new Headers(init.headers);
  headers.set('cf-connecting-ip', '198.51.100.77');
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(base + path, { ...init, headers }), { ...env, ...bindings } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const brokenDb = {
  prepare() {
    throw new Error('boom secret-detail at /internal/stack.ts:1');
  },
} as unknown as D1Database;

afterEach(() => vi.restoreAllMocks());

describe('hardening', () => {
  it('thrown error returns generic 500 without stack', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call(
      '/api/auth/login',
      { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer top-secret' }, body: JSON.stringify({ password: 'hunter2-hunter2' }) },
      { DB: brokenDb, SESSION_SECRET: undefined },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal error' });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain('/api/auth/login');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('top-secret');
  });

  it('api responses carry X-Content-Type-Options nosniff', async () => {
    for (const path of ['/api/auth/me', '/api/apps', '/api/nope']) {
      const res = await call(path);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000');
      expect(res.headers.get('content-security-policy')).toBeNull();
    }
    const http = await call('/api/auth/me', {}, {}, 'http://localhost:8787');
    expect(http.headers.get('x-content-type-options')).toBe('nosniff');
    expect(http.headers.get('strict-transport-security')).toBeNull();
  });

  it('keeps CORS headers on /api/v1/*', async () => {
    const res = await call('/api/v1/batch', { method: 'OPTIONS', headers: { origin: 'https://x.example', 'access-control-request-method': 'POST' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('missing ADMIN_PASSWORD makes login and protected routes fail closed, never a default password', async () => {
    const noPassword = { ADMIN_PASSWORD: undefined as unknown as string };
    for (const password of ['change-me-please', '', 'admin', 'password']) {
      const res = await call(
        '/api/auth/login',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) },
        noPassword,
      );
      expect(res.status).toBe(500);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    const protectedRes = await call('/api/apps', {}, noPassword);
    expect(protectedRes.status).toBeGreaterThanOrEqual(401);
    expect(protectedRes.status).not.toBe(200);
  });
});
