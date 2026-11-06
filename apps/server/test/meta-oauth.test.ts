import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { AppRow, Env } from '../src/env';
import { META_OAUTH_SCOPES, oauthContext } from '../src/integrations/meta-oauth';
import { open, parseKeys } from '../src/lib/sealed';
import { BASE, call, createApp, login } from './helpers';

const db = env.DB;
const META = { META_APP_ID: '123456789', META_APP_SECRET: 'app-secret-xyz' };
const CALLBACK = '/api/integrations/meta/oauth/callback';

let cookie: string;
beforeAll(async () => {
  cookie = await login();
});
afterEach(() => vi.restoreAllMocks());

/** In-process request with optional extra env and cookies. */
async function req(path: string, opts: { cookies?: string[]; envPatch?: Partial<Env> } = {}) {
  const headers = new Headers({ 'cf-connecting-ip': '198.51.100.30' });
  const jar = [...(opts.cookies ?? [])];
  if (jar.length) headers.set('cookie', jar.join('; '));
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(BASE + path, { headers, redirect: 'manual' }), { ...(env as Env), ...META, ...opts.envPatch }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function setup(): Promise<{ app: AppRow; iid: string }> {
  const app = await createApp(cookie);
  const res = await call(`/api/apps/${app.id}/integrations`, { method: 'POST', cookie, json: { provider: 'meta' } });
  return { app, iid: (await res.json<{ id: string }>()).id };
}

/** Run /oauth/start and return the state plus the nonce cookie it set. */
async function start(app: AppRow, iid: string) {
  const res = await req(`/api/apps/${app.id}/integrations/${iid}/oauth/start`, { cookies: [cookie] });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('location')!);
  const nonceCookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  return { loc, state: loc.searchParams.get('state')!, nonceCookie };
}

function mockGraph(handler: (url: URL, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  return calls;
}

describe('Meta OAuth', () => {
  it('is unavailable without a Meta app, and says so in the integration', async () => {
    const { app, iid } = await setup();
    const res = await req(`/api/apps/${app.id}/integrations/${iid}/oauth/start`, { cookies: [cookie], envPatch: { META_APP_ID: undefined } });
    expect(res.status).toBe(404);
    const list = await (await call(`/api/apps/${app.id}/integrations`, { cookie })).json<{ integrations: Array<{ oauth_available: boolean }> }>();
    expect(list.integrations[0].oauth_available).toBe(false);
  });

  it('start redirects to the Facebook dialog with a signed state and sets a nonce cookie', async () => {
    const { app, iid } = await setup();
    const { loc, state, nonceCookie } = await start(app, iid);
    expect(loc.origin).toBe('https://www.facebook.com');
    expect(loc.pathname).toBe('/v27.0/dialog/oauth');
    expect(Object.fromEntries(loc.searchParams)).toMatchObject({ client_id: '123456789', redirect_uri: BASE + CALLBACK, scope: META_OAUTH_SCOPES, response_type: 'code' });
    expect(state.length).toBeGreaterThan(40);
    expect(nonceCookie).toMatch(/^meta_oauth_nonce=\w+/);
    expect(loc.href).not.toContain('app-secret-xyz');
  });

  it('start and callback require the dashboard login', async () => {
    const { app, iid } = await setup();
    expect((await req(`/api/apps/${app.id}/integrations/${iid}/oauth/start`)).status).toBe(401);
    expect((await req(`${CALLBACK}?code=x&state=y`)).status).toBe(401);
  });

  it('callback stores a sealed long-lived token and returns to the Meta page', async () => {
    const { app, iid } = await setup();
    const { state, nonceCookie } = await start(app, iid);
    const calls = mockGraph((url) =>
      url.searchParams.get('grant_type') === 'fb_exchange_token'
        ? { body: { access_token: 'LONG-token', token_type: 'bearer', expires_in: 5_184_000 } }
        : { body: { access_token: 'SHORT-token', expires_in: 3600 } },
    );
    const res = await req(`${CALLBACK}?code=the-code&state=${encodeURIComponent(state)}`, { cookies: [cookie, nonceCookie] });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/apps/${app.id}/integrations/meta?oauth=connected`);
    expect(calls[0].url.searchParams.get('code')).toBe('the-code');
    expect(calls[0].url.searchParams.get('redirect_uri')).toBe(BASE + CALLBACK);
    expect(calls[1].url.searchParams.get('fb_exchange_token')).toBe('SHORT-token');

    const row = await db.prepare('SELECT oauth_token_enc, oauth_expires_at FROM integrations WHERE id = ?').bind(iid).first<{ oauth_token_enc: string; oauth_expires_at: number }>();
    expect(await open(parseKeys(env as Env), row!.oauth_token_enc, oauthContext(iid))).toBe('LONG-token');
    expect(row!.oauth_expires_at).toBeGreaterThan(Date.now() + 59 * 86_400_000);
    const pub = await (await call(`/api/apps/${app.id}/integrations`, { cookie })).text();
    expect(pub).not.toContain('LONG-token');
  });

  it('rejects a forged, replayed-elsewhere or expired state', async () => {
    const { app, iid } = await setup();
    const { state, nonceCookie } = await start(app, iid);
    const fetchSpy = mockGraph(() => ({ body: {} }));
    // No nonce cookie (state used from another browser).
    expect((await req(`${CALLBACK}?code=c&state=${encodeURIComponent(state)}`, { cookies: [cookie] })).status).toBe(400);
    // Tampered state.
    expect((await req(`${CALLBACK}?code=c&state=${encodeURIComponent(state + 'x')}`, { cookies: [cookie, nonceCookie] })).status).toBe(400);
    // Expired.
    const later = Date.now() + 11 * 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expect((await req(`${CALLBACK}?code=c&state=${encodeURIComponent(state)}`, { cookies: [cookie, nonceCookie] })).status).toBe(400);
    expect(fetchSpy).toHaveLength(0);
  });

  it('a declined dialog returns to the page without a token', async () => {
    const { app, iid } = await setup();
    const { state, nonceCookie } = await start(app, iid);
    const res = await req(`${CALLBACK}?error=access_denied&state=${encodeURIComponent(state)}`, { cookies: [cookie, nonceCookie] });
    expect(res.headers.get('location')).toBe(`/apps/${app.id}/integrations/meta?oauth=denied`);
    expect(await db.prepare('SELECT oauth_token_enc FROM integrations WHERE id = ?').bind(iid).first('oauth_token_enc')).toBeNull();
  });
});

describe('GET …/datasets', () => {
  async function connected() {
    const s = await setup();
    const { state, nonceCookie } = await start(s.app, s.iid);
    mockGraph(() => ({ body: { access_token: 'LONG-token', expires_in: 5_184_000 } }));
    await req(`${CALLBACK}?code=c&state=${encodeURIComponent(state)}`, { cookies: [cookie, nonceCookie] });
    vi.restoreAllMocks();
    return s;
  }

  it('needs a Facebook connection', async () => {
    const { app, iid } = await setup();
    expect(await (await call(`/api/apps/${app.id}/integrations/${iid}/datasets`, { cookie })).json()).toEqual({ error: 'oauth_not_connected' });
  });

  it('lists datasets from ad accounts and businesses, deduplicated, with the token only in the header', async () => {
    const { app, iid } = await connected();
    const calls = mockGraph((url) =>
      url.pathname.endsWith('/me/adaccounts')
        ? { body: { data: [{ name: 'Ads A', adspixels: { data: [{ id: '1601828548167313', name: 'Appstack - iOS' }, { id: '222222', name: 'Web pixel' }] } }] } }
        : { body: { data: [{ name: 'Biz', owned_pixels: { data: [{ id: '1601828548167313', name: 'Appstack - iOS' }, { id: 'bad', name: 'x' }] } }] } },
    );
    const res = await call(`/api/apps/${app.id}/integrations/${iid}/datasets`, { cookie });
    expect(await res.json()).toEqual([
      { id: '1601828548167313', name: 'Appstack - iOS', owner: 'Ads A' },
      { id: '222222', name: 'Web pixel', owner: 'Ads A' },
    ]);
    for (const c of calls) {
      expect(c.url.href).not.toContain('LONG-token');
      expect(new Headers(c.init?.headers).get('authorization')).toBe('Bearer LONG-token');
    }
  });

  it('an expired Facebook token is cleared and reported', async () => {
    const { app, iid } = await connected();
    mockGraph(() => ({ status: 400, body: { error: { code: 190, message: 'Session has expired' } } }));
    expect(await (await call(`/api/apps/${app.id}/integrations/${iid}/datasets`, { cookie })).json()).toEqual({ error: 'oauth_expired' });
    expect(await db.prepare('SELECT oauth_token_enc FROM integrations WHERE id = ?').bind(iid).first('oauth_token_enc')).toBeNull();
  });
});
