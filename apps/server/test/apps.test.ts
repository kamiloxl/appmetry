import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppRow } from '../src/env';
import { sha256Hex } from '../src/lib/crypto';
import { call, createApp, login } from './helpers';

let cookie: string;
beforeAll(async () => {
  cookie = await login();
});
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM apps').run();
});

const patch = (id: string, json: unknown) => call(`/api/apps/${id}`, { method: 'PATCH', cookie, json });

describe('apps API', () => {
  it('requires a session', async () => {
    expect((await call('/api/apps', { method: 'POST', json: { name: 'x' } })).status).toBe(401);
    expect((await call('/api/apps/abc', { method: 'DELETE' })).status).toBe(401);
  });

  it('creates app with app_ key', async () => {
    const app = await createApp(cookie);
    expect(app.app_key).toMatch(/^app_[0-9a-z]{32}$/);
    expect(app.name).toBe('Test App');
    expect(app.timezone).toBe('UTC');
    const list = await (await call('/api/apps', { cookie })).json<Array<AppRow & { has_rc_secret: boolean }>>();
    expect(list).toHaveLength(1);
    expect(list[0].has_rc_secret).toBe(false);
    expect('rc_secret_hash' in list[0]).toBe(false);
    expect((await call('/api/apps', { method: 'POST', cookie, json: { name: '  ' } })).status).toBe(400);
    expect((await call('/api/apps', { method: 'POST', cookie, json: { name: 'x'.repeat(101) } })).status).toBe(400);
  });

  it('patch updates whitelisted fields and ignores others', async () => {
    const app = await createApp(cookie);
    const res = await patch(app.id, {
      name: ' Renamed ',
      ios_bundle_id: 'com.x.y',
      app_store_url: 'https://apps.apple.com/app/id1',
      timezone: 'Europe/Warsaw',
      retention_months: 12,
      show_sandbox: true,
      app_key: 'app_hacked',
      id: 'nope',
    });
    expect(res.status).toBe(200);
    const row = await res.json<AppRow>();
    expect(row).toMatchObject({ name: 'Renamed', ios_bundle_id: 'com.x.y', timezone: 'Europe/Warsaw', retention_months: 12, show_sandbox: 1 });
    expect(row.app_key).toBe(app.app_key);
    expect(row.id).toBe(app.id);
    const cleared = await (await patch(app.id, { app_store_url: '' })).json<AppRow>();
    expect(cleared.app_store_url).toBeNull();
    expect((await patch('missing', { name: 'x' })).status).toBe(404);
  });

  it('patch validates urls and timezone', async () => {
    const app = await createApp(cookie);
    expect((await patch(app.id, { app_store_url: 'javascript:x' })).status).toBe(400);
    expect((await patch(app.id, { web_url: 'http://example.com' })).status).toBe(400);
    expect((await patch(app.id, { timezone: 'Mars/Base' })).status).toBe(400);
    expect((await patch(app.id, { retention_months: 0 })).status).toBe(400);
    expect((await patch(app.id, { retention_months: 121 })).status).toBe(400);
    expect((await patch(app.id, { retention_months: 1.5 })).status).toBe(400);
    expect((await patch(app.id, { show_sandbox: 2 })).status).toBe(400);
    expect((await patch(app.id, { name: '' })).status).toBe(400);
    expect((await patch(app.id, { ios_bundle_id: 'x'.repeat(256) })).status).toBe(400);
  });

  it('rc-secret is returned once and stored hashed', async () => {
    const app = await createApp(cookie);
    const res = await call(`/api/apps/${app.id}/rc-secret`, { method: 'POST', cookie });
    expect(res.status).toBe(200);
    const { secret } = await res.json<{ secret: string }>();
    expect(secret).toMatch(/^rcw_[0-9a-z]{48}$/);
    const hash = await env.DB.prepare('SELECT rc_secret_hash FROM apps WHERE id = ?').bind(app.id).first<string>('rc_secret_hash');
    expect(hash).toBe(await sha256Hex(secret));
    const listText = await (await call('/api/apps', { cookie })).text();
    expect(listText).not.toContain(secret);
    expect(listText).not.toContain(hash!);
    expect(JSON.parse(listText)[0].has_rc_secret).toBe(true);
    expect((await call('/api/apps/missing/rc-secret', { method: 'POST', cookie })).status).toBe(404);
  });

  it('delete removes child rows', async () => {
    const app = await createApp(cookie);
    const other = await createApp(cookie);
    for (const id of [app.id, other.id]) {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO installs (app_id, id, first_seen, last_seen) VALUES (?, ?, 1, 1)').bind(id, 'i1'),
        env.DB.prepare('INSERT INTO sessions (app_id, id, install_id, started_at, last_seen_at) VALUES (?, ?, ?, 1, 1)').bind(id, 's1', 'i1'),
        env.DB.prepare('INSERT INTO events (app_id, id, install_id, ts, type) VALUES (?, ?, ?, 1, ?)').bind(id, 'e1', 'i1', 'screen'),
        env.DB.prepare('INSERT INTO links (id, app_id, slug, created_at) VALUES (?, ?, ?, 1)').bind('l' + id, id, 'slug' + id),
        env.DB.prepare('INSERT INTO link_clicks (id, link_id, app_id, ts) VALUES (?, ?, ?, 1)').bind('c' + id, 'l' + id, id),
        env.DB.prepare('INSERT INTO payments (id, app_id, ts, kind) VALUES (?, ?, 1, ?)').bind('p' + id, id, 'payment'),
        env.DB.prepare('INSERT INTO rc_events (id, app_id, ts) VALUES (?, ?, 1)').bind('r' + id, id),
        env.DB.prepare("INSERT INTO asa_names (app_id, kind, id, name, updated_at) VALUES (?, 'keyword', '1', 'k', 1)").bind(id),
      ]);
    }
    const res = await call(`/api/apps/${app.id}`, { method: 'DELETE', cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    for (const t of ['apps', 'installs', 'sessions', 'events', 'links', 'link_clicks', 'payments', 'rc_events', 'asa_names']) {
      const col = t === 'apps' ? 'id' : 'app_id';
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`).bind(app.id).first('n'), t).toBe(0);
      expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?`).bind(other.id).first('n'), `${t} other`).toBe(1);
    }
    expect((await call(`/api/apps/${app.id}`, { method: 'DELETE', cookie })).status).toBe(404);
  });
});
