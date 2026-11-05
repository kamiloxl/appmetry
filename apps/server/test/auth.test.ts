import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { forgetSessionKey, sessionKey } from '../src/auth';
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

  it('protected route without cookie returns 401', async () => {
    const res = await call('/api/apps');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });

    const ok = await login('test-password-12', freshIp());
    const authed = await call('/api/apps', { cookie: cookieFrom(ok) });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual([]);
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
