import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import { BASE, call, createApp, login } from './helpers';

let cookie: string;
beforeAll(async () => {
  cookie = await login();
});
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM apps'), env.DB.prepare('DELETE FROM links'), env.DB.prepare('DELETE FROM link_clicks')]);
});

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const PLAY = 'https://play.google.com/store/apps/details?id=com.x.y';
const STORE = 'https://apps.apple.com/app/id1';
const WEB = 'https://example.com';

/** Open a tracked link as a public visitor (no cookie), with a request.cf country. */
async function click(slug: string, ua: string, cf: Record<string, unknown> = { country: 'PL' }, query = '') {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(BASE + `/l/${slug}${query}`, { headers: { 'user-agent': ua, 'cf-connecting-ip': '198.51.100.9', referer: 'https://t.co/x' }, redirect: 'manual', cf: cf as RequestInit['cf'] }),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const createLink = (appId: string, json: Record<string, unknown>) => call(`/api/apps/${appId}/links`, { method: 'POST', cookie, json });

describe('GET /l/:slug', () => {
  it('android ua redirects to play_store_url with encoded referrer', async () => {
    const app = await createApp(cookie, { play_store_url: PLAY, app_store_url: STORE });
    expect((await createLink(app.id, { name: 'TikTok', slug: 'tt', utm_source: 'tiktok', utm_campaign: 'launch' })).status).toBe(201);
    const res = await click('tt', ANDROID);
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const loc = res.headers.get('location') as string;
    expect(loc.startsWith(PLAY + '&referrer=')).toBe(true);
    const clickRow = await env.DB.prepare('SELECT id FROM link_clicks').first<{ id: string }>();
    expect(clickRow?.id).toMatch(/^c_[0-9a-z]{20}$/);
    expect(loc).toBe(`${PLAY}&referrer=${encodeURIComponent(`click_id=${clickRow?.id}&utm_source=tiktok&utm_campaign=launch`)}`);
  });

  it('uses ? when the play url has no query', async () => {
    const app = await createApp(cookie, { play_store_url: 'https://play.google.com/store/apps/x' });
    await createLink(app.id, { name: 'a', slug: 'qq', utm_source: 's', ref: 'r1' });
    const loc = (await click('qq', ANDROID)).headers.get('location') as string;
    expect(loc.startsWith('https://play.google.com/store/apps/x?referrer=')).toBe(true);
    expect(decodeURIComponent(loc.split('referrer=')[1])).toMatch(/^click_id=c_\w+&utm_source=s&ref=r1$/);
  });

  it('ios ua redirects to app_store_url', async () => {
    const app = await createApp(cookie, { play_store_url: PLAY, app_store_url: STORE });
    await createLink(app.id, { name: 'a', slug: 'ios1', utm_source: 's' });
    const res = await click('ios1', IOS);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(STORE);
  });

  it('desktop ua redirects to web_url, falling back to app_store_url', async () => {
    const app = await createApp(cookie, { app_store_url: STORE, web_url: WEB });
    await createLink(app.id, { name: 'a', slug: 'dk', utm_source: 's' });
    expect((await click('dk', DESKTOP)).headers.get('location')).toBe(WEB);
    await call(`/api/apps/${app.id}`, { method: 'PATCH', cookie, json: { web_url: null } });
    expect((await click('dk', DESKTOP)).headers.get('location')).toBe(STORE);
  });

  it('records click with platform and country', async () => {
    const app = await createApp(cookie, { play_store_url: PLAY });
    await createLink(app.id, { name: 'a', slug: 'rec', utm_source: 's' });
    await click('rec', ANDROID, { country: 'DE' });
    await click('rec', DESKTOP, {});
    const rows = (await env.DB.prepare('SELECT * FROM link_clicks ORDER BY ts, rowid').all<Record<string, unknown>>()).results;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ app_id: app.id, platform: 'android', country: 'DE', install_id: null });
    expect(rows[1]).toMatchObject({ platform: 'other', country: null });
    expect(Object.keys(rows[0]).sort()).toEqual([
      'ad_id', 'adset_id', 'app_id', 'campaign_id', 'campaign_ids', 'country', 'fbclid', 'id', 'install_id', 'link_id', 'placement',
      'platform', 'ts', 'utm_campaign', 'utm_content', 'utm_medium', 'utm_source', 'utm_term',
    ]);
    expect(rows[0]).toMatchObject({ campaign_id: null, utm_source: null });
  });

  it('stores click-level campaign parameters from the query and drops private and unfilled ones', async () => {
    const app = await createApp(cookie, { app_store_url: STORE });
    await createLink(app.id, { name: 'Meta', slug: 'meta', utm_source: 'meta', utm_medium: 'paid_social' });
    const q =
      '?utm_campaign=Spring%20Sale&utm_content=Video%201&campaign_id=120&adset_id=121&ad_id=122&placement=Instagram_Stories' +
      '&fbclid=IwAR1&adset_name={{adset.name}}&email=a@b.c&utm_term=' + 'x'.repeat(300);
    expect((await click('meta', IOS, { country: 'GB' }, q)).status).toBe(302);
    const row = await env.DB.prepare('SELECT * FROM link_clicks').first<Record<string, unknown>>();
    expect(row).toMatchObject({
      utm_source: null, utm_medium: null, utm_campaign: 'Spring Sale', utm_content: 'Video 1', campaign_id: '120', adset_id: '121', ad_id: '122',
      placement: 'Instagram_Stories', fbclid: 'IwAR1', campaign_ids: null,
    });
    expect((row!.utm_term as string).length).toBe(200);
    expect(JSON.stringify(row)).not.toContain('a@b.c');
  });

  it('android referrer carries click-level values over the link values', async () => {
    const app = await createApp(cookie, { play_store_url: PLAY });
    await createLink(app.id, { name: 'Meta', slug: 'meta-a', utm_source: 'meta', utm_campaign: 'link-level' });
    const res = await click('meta-a', ANDROID, {}, '?utm_campaign=click-level&campaign_id=120&ad_id=122');
    const referrer = new URLSearchParams(decodeURIComponent((res.headers.get('location') as string).split('referrer=')[1]));
    expect(Object.fromEntries(referrer)).toMatchObject({ utm_source: 'meta', utm_campaign: 'click-level', campaign_id: '120', ad_id: '122' });
  });

  it('unknown slug returns 404', async () => {
    const res = await click('nope', DESKTOP);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('Not found');
  });

  it('link of an app with no store urls returns 404 with plain text', async () => {
    const app = await createApp(cookie);
    await createLink(app.id, { name: 'a', slug: 'empty', utm_source: 's' });
    const res = await click('empty', ANDROID);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('Link not available');
  });

  it('falls back across urls for android and ios', async () => {
    const app = await createApp(cookie, { web_url: WEB });
    await createLink(app.id, { name: 'a', slug: 'fb', utm_source: 's' });
    expect((await click('fb', ANDROID)).headers.get('location')).toBe(WEB);
    expect((await click('fb', IOS)).headers.get('location')).toBe(WEB);
  });
});

describe('links API', () => {
  it('requires a session', async () => {
    expect((await call('/api/apps/x/links')).status).toBe(401);
    expect((await call('/api/apps/x/links', { method: 'POST', json: {} })).status).toBe(401);
  });

  it('slug validation and duplicate 409', async () => {
    const app = await createApp(cookie);
    const other = await createApp(cookie);
    expect((await createLink(app.id, { name: 'a', slug: 'a', utm_source: 's' })).status).toBe(400);
    expect((await createLink(app.id, { name: 'a', slug: 'bad slug!', utm_source: 's' })).status).toBe(400);
    expect((await createLink(app.id, { name: 'a', slug: 'x'.repeat(49), utm_source: 's' })).status).toBe(400);
    const ok = await createLink(app.id, { name: 'a', slug: 'My-Slug', utm_source: 's' });
    expect(ok.status).toBe(201);
    expect((await ok.json<{ slug: string }>()).slug).toBe('my-slug');
    const dup = await createLink(other.id, { name: 'b', slug: 'my-slug', utm_source: 's' });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: 'slug_taken' });
  });

  it('validates fields, generates slug and stores blanks as NULL', async () => {
    const app = await createApp(cookie);
    expect((await createLink(app.id, { utm_source: 's' })).status).toBe(400);
    expect((await createLink(app.id, { name: 'a' })).status).toBe(400);
    expect((await createLink(app.id, { name: 'a', utm_source: ' ' })).status).toBe(400);
    expect((await createLink(app.id, { name: 'a', utm_source: 's', utm_medium: 'x'.repeat(201) })).status).toBe(400);
    const res = await createLink(app.id, { name: ' Spring ', utm_source: ' tiktok ', utm_medium: '', utm_campaign: '   ', ref: 'r' });
    expect(res.status).toBe(201);
    const link = await res.json<Record<string, unknown>>();
    expect(link).toMatchObject({ app_id: app.id, name: 'Spring', utm_source: 'tiktok', utm_medium: null, utm_campaign: null, utm_content: null, ref: 'r' });
    expect(link.slug).toMatch(/^[a-z0-9]{8}$/);
    expect(link.id).toMatch(/^[a-z0-9]{16}$/);
    const list = await (await call(`/api/apps/${app.id}/links`, { cookie })).json<unknown[]>();
    expect(list).toHaveLength(1);
  });

  it('is scoped to the app and 404s for unknown apps or foreign links', async () => {
    const a = await createApp(cookie);
    const b = await createApp(cookie);
    const link = await (await createLink(a.id, { name: 'a', slug: 'scoped', utm_source: 's' })).json<{ id: string }>();
    expect((await call('/api/apps/missing/links', { cookie })).status).toBe(404);
    expect((await createLink('missing', { name: 'a', utm_source: 's' })).status).toBe(404);
    expect((await call(`/api/apps/${b.id}/links/${link.id}`, { method: 'PATCH', cookie, json: { name: 'x' } })).status).toBe(404);
    expect((await call(`/api/apps/${b.id}/links/${link.id}`, { method: 'DELETE', cookie })).status).toBe(404);
    expect((await call(`/api/apps/${b.id}/links`, { cookie }).then((r) => r.json<unknown[]>()))).toHaveLength(0);
  });

  it('patches fields (slug stays unique) and delete keeps clicks', async () => {
    const app = await createApp(cookie, { web_url: WEB });
    const l1 = await (await createLink(app.id, { name: 'a', slug: 'one', utm_source: 's', utm_medium: 'm' })).json<{ id: string }>();
    await createLink(app.id, { name: 'b', slug: 'two', utm_source: 's' });
    const p = await call(`/api/apps/${app.id}/links/${l1.id}`, { method: 'PATCH', cookie, json: { name: ' Renamed ', utm_medium: '', id: 'hack', app_id: 'hack' } });
    expect(p.status).toBe(200);
    expect(await p.json()).toMatchObject({ id: l1.id, app_id: app.id, name: 'Renamed', utm_medium: null, utm_source: 's' });
    expect((await call(`/api/apps/${app.id}/links/${l1.id}`, { method: 'PATCH', cookie, json: { slug: 'two' } })).status).toBe(409);
    expect((await call(`/api/apps/${app.id}/links/${l1.id}`, { method: 'PATCH', cookie, json: { utm_source: '' } })).status).toBe(400);
    expect((await call(`/api/apps/${app.id}/links/${l1.id}`, { method: 'PATCH', cookie, json: { slug: 'X' } })).status).toBe(400);

    await click('one', DESKTOP);
    expect((await call(`/api/apps/${app.id}/links/${l1.id}`, { method: 'DELETE', cookie })).status).toBe(200);
    expect((await click('one', DESKTOP)).status).toBe(404);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM link_clicks').first<number>('n'))).toBe(1);
    expect((await call(`/api/apps/${app.id}/links/${l1.id}`, { method: 'DELETE', cookie })).status).toBe(404);
  });
});
