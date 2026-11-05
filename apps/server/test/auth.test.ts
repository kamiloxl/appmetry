import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { forgetSessionKey, purgeLoginFailures, sessionKey } from '../src/auth';
import type { Env } from '../src/env';

const BASE = 'https://appdash.example.workers.dev';
let ipCounter = 0;

/** Each test logs in from its own IP so the lockout counter never leaks between tests. */
function freshIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

async function call(path: string, init: RequestInit & { ip?: string; cookie?: string } = {}, bindings: Partial<Env> = {}) {
  const headers = new Headers(init.headers);
  headers.set('cf-connecting-ip', init.ip ?? '198.51.100.1');
  if (init.cookie) headers.set('cookie', init.cookie);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(BASE + path, { ...init, headers }), { ...env, ...bindings } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

function login(password: string | undefined, ip: string, bindings: Partial<Env> = {}) {
  return call(
    '/api/auth/login',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }), ip },
    bindings,
  );
}

/** `name=value` from a Set-Cookie header, ready to send back. */
function cookieFrom(res: Response) {
  return (res.headers.get('set-cookie') ?? '').split(';')[0];
}

beforeEach(async () => {
  forgetSessionKey();
  await env.DB.prepare('DELETE FROM meta').run();
  await env.DB.prepare('DELETE FROM login_failures').run();
});

describe('password login', () => {
  it('wrong password returns 401', async () => {
    const res = await login('not-the-password', freshIp());
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('right password sets an HttpOnly cookie and /api/auth/me returns loggedIn true', async () => {
    const res = await login('test-password-12', freshIp());
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^ad_auth=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/Max-Age=2592000/);

    const me = await call('/api/auth/me', { cookie: cookieFrom(res) });
    expect(await me.json()).toEqual({ loggedIn: true });

    const anon = await call('/api/auth/me');
    expect(await anon.json()).toEqual({ loggedIn: false });
  });

  it('11th failure within 15 min returns 429', async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await login('wrong-password!', ip)).status).toBe(401);
    const res = await login('wrong-password!', ip);
    expect(res.status).toBe(429);
    // Locked out even with the right password.
    expect((await login('test-password-12', ip)).status).toBe(429);
    // Other IPs are unaffected.
    expect((await login('test-password-12', freshIp())).status).toBe(200);
  });

  it('stores a keyed hash of the IP, never the raw IP', async () => {
    const ip = '192.0.2.77';
    expect((await login('not-the-password', ip)).status).toBe(401);
    const rows = await env.DB.prepare('SELECT * FROM login_failures').all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);
    expect(Object.keys(rows.results[0]).sort()).toEqual(['ip_hash', 'ts']);
    expect(rows.results[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows.results)).not.toContain(ip);
    // A successful login from the same IP clears its failures.
    expect((await login('test-password-12', ip)).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures').first('n')).toBe(0);
  });

  it('protected route without cookie returns 401', async () => {
    const res = await call('/api/apps');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });

    const ok = await login('test-password-12', freshIp());
    const authed = await call('/api/apps', { cookie: cookieFrom(ok) });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual([]);
  });

  it('every /api route needs a session unless it is on the public allowlist', async () => {
    for (const [method, path] of [
      ['GET', '/api/anything'],
      ['POST', '/api/apps/abc/links'],
      ['GET', '/api/stats/overview'],
      ['GET', '/api/auth/login'],
      ['DELETE', '/api/auth/me'],
      ['GET', '/api/v1'],
    ]) {
      const res = await call(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('SDK and webhook routes are not blocked by auth', async () => {
    for (const [method, path] of [
      ['POST', '/api/v1/batch'],
      ['GET', '/api/v1/attribution'],
      ['OPTIONS', '/api/v1/batch'],
      ['POST', '/api/webhooks/revenuecat/app1'],
    ]) {
      const res = await call(path, { method });
      expect(res.status, `${method} ${path}`).not.toBe(401);
      // Implemented routes answer for themselves (400 for an empty batch, 204 for CORS preflight); the rest are 404/405.
      expect([204, 400, 404, 405], `${method} ${path}`).toContain(res.status);
    }
  });

  it('rejects a tampered cookie', async () => {
    const ok = await login('test-password-12', freshIp());
    const [name, value] = cookieFrom(ok).split('=');
    const tampered = `${name}=${value.replace(/^admin/, 'admim')}`;
    expect((await call('/api/apps', { cookie: tampered })).status).toBe(401);
  });

  it('missing ADMIN_PASSWORD returns 500 with setup hint', async () => {
    const res = await login('anything-at-all', freshIp(), { ADMIN_PASSWORD: undefined as unknown as string });
    expect(res.status).toBe(500);
    const body = await res.json<{ error: string }>();
    expect(body.error).toMatch(/ADMIN_PASSWORD/);
    expect(body.error).toMatch(/Settings → Variables/);
  });

  it('ADMIN_PASSWORD shorter than 12 refuses login with 500 and the "set a stronger password" hint', async () => {
    const res = await login('short-pass1', freshIp(), { ADMIN_PASSWORD: 'short-pass1' });
    expect(res.status).toBe(500);
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe(
      'Set a stronger ADMIN_PASSWORD (at least 12 characters) in Cloudflare → Workers → appdash → Settings → Variables',
    );
  });

  it('logout clears the cookie', async () => {
    const res = await call('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^ad_auth=;.*Max-Age=0/);
  });
});

describe('session key', () => {
  it('sessionKey generates one key in meta and reuses it', async () => {
    const [a, b] = await Promise.all([sessionKey(env), sessionKey(env)]);
    forgetSessionKey();
    const c = await sessionKey(env);
    expect(a).toBe(b);
    expect(c).toBe(a);
    expect(atob(a)).toHaveLength(32);
    const rows = await env.DB.prepare("SELECT key, value FROM meta WHERE key = 'session_key'").all();
    expect(rows.results).toEqual([{ key: 'session_key', value: a }]);
  });

  it('SESSION_SECRET binding takes precedence over meta', async () => {
    await sessionKey(env);
    expect(await sessionKey({ ...env, SESSION_SECRET: 'from-the-binding' })).toBe('from-the-binding');

    // A cookie signed with the binding does not verify with the generated key, and vice versa.
    const withSecret = { SESSION_SECRET: 'from-the-binding' };
    const ok = await login('test-password-12', freshIp(), withSecret);
    expect(await (await call('/api/auth/me', { cookie: cookieFrom(ok) }, withSecret)).json()).toEqual({ loggedIn: true });
    expect(await (await call('/api/auth/me', { cookie: cookieFrom(ok) })).json()).toEqual({ loggedIn: false });
  });

  it('cookie signed before a key exists still verifies after', async () => {
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM meta').first('n')).toBe(0);
    const ok = await login('test-password-12', freshIp());
    expect(ok.status).toBe(200);
    // A new isolate: nothing cached, so the key is read back from D1.
    forgetSessionKey();
    const me = await call('/api/auth/me', { cookie: cookieFrom(ok) });
    expect(await me.json()).toEqual({ loggedIn: true });
  });
});

describe('login failure retention', () => {
  const LOCKOUT_MS = 15 * 60_000;

  async function seed(now: number) {
    await env.DB.batch(
      [now - LOCKOUT_MS - 1, now - 2 * 86_400_000, now - LOCKOUT_MS + 1, now - 1000].map((ts) =>
        env.DB.prepare('INSERT INTO login_failures (ip_hash, ts) VALUES (?, ?)').bind('ab'.repeat(32), ts),
      ),
    );
  }

  it('purgeLoginFailures removes rows older than 15 minutes', async () => {
    const now = Date.now();
    await seed(now);
    await purgeLoginFailures(env.DB, now);
    const rows = await env.DB.prepare('SELECT ts FROM login_failures ORDER BY ts').all<{ ts: number }>();
    expect(rows.results.map((r) => r.ts)).toEqual([now - LOCKOUT_MS + 1, now - 1000]);
  });

  it('the daily cron purges stale login failures', async () => {
    const now = Date.now();
    await seed(now);
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: now, cron: '0 3 * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures').first('n')).toBe(2);
  });
});
