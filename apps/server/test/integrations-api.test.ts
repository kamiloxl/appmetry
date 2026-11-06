import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppRow, Env } from '../src/env';
import { tokenContext } from '../src/integrations/dispatch';
import { open, parseKeys } from '../src/lib/sealed';
import { BASE, call, createApp, login } from './helpers';

const db = env.DB;
const TOKEN = 'EAAGm0PX4ZCpsBAKZB-test-token-0123456789';
const DATASET = '1601828548167313';

let cookie: string;
beforeAll(async () => {
  cookie = await login();
});
afterEach(() => vi.restoreAllMocks());

type Integration = Record<string, unknown> & { id: string; mappings: Array<Record<string, unknown>> };
const api = (path: string, init: Parameters<typeof call>[1] = {}) => call(path, { cookie, ...init });
async function create(app: AppRow): Promise<Integration> {
  const res = await api(`/api/apps/${app.id}/integrations`, { method: 'POST', json: { provider: 'meta' } });
  expect(res.status).toBe(201);
  return res.json();
}
const patch = (app: AppRow, id: string, json: unknown, init: Parameters<typeof call>[1] = {}) =>
  api(`/api/apps/${app.id}/integrations/${id}`, { method: 'PATCH', json, ...init });

async function ready(app: AppRow) {
  const it = await create(app);
  expect((await patch(app, it.id, { dataset_id: DATASET, token: TOKEN, test_event_code: 'TEST42' })).status).toBe(200);
  return it;
}

describe('integrations API', () => {
  it('requires a session and is scoped to the app', async () => {
    const app = await createApp(cookie);
    expect((await call(`/api/apps/${app.id}/integrations`)).status).toBe(401);
    expect((await api('/api/apps/nope/integrations')).status).toBe(404);
    const it = await create(app);
    const other = await createApp(cookie);
    expect((await patch(other, it.id, { send_scope: 'attributed' })).status).toBe(404);
  });

  it('creates Meta with default mappings, once per app', async () => {
    const app = await createApp(cookie);
    const it = await create(app);
    expect(it).toMatchObject({ provider: 'meta', status: 'draft', send_scope: 'all', has_token: false, missing: 'dataset_id', keys_configured: true });
    expect(it.mappings).toContainEqual({ source_event: 'install', target_event: 'MobileAppInstall', send_value: false, locked: true });
    expect((it.target_events as string[]).includes('Purchase')).toBe(true);
    expect((await api(`/api/apps/${app.id}/integrations`, { method: 'POST', json: { provider: 'meta' } })).status).toBe(409);
    expect((await api(`/api/apps/${app.id}/integrations`, { method: 'POST', json: { provider: 'nope' } })).status).toBe(400);
  });

  it('stores the token sealed and never returns it', async () => {
    const app = await createApp(cookie);
    const it = await create(app);
    const res = await patch(app, it.id, { dataset_id: DATASET, dataset_name: 'Appstack - iOS', token: TOKEN });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(TOKEN);
    expect(JSON.parse(text)).toMatchObject({ has_token: true, missing: null, dataset_id: DATASET, dataset_name: 'Appstack - iOS' });
    const row = await db.prepare('SELECT capi_token_enc, config FROM integrations WHERE id = ?').bind(it.id).first<{ capi_token_enc: string; config: string }>();
    expect(row!.capi_token_enc).not.toContain(TOKEN);
    expect(await open(parseKeys(env as Env), row!.capi_token_enc, tokenContext(it.id))).toBe(TOKEN);
    const audit = (await db.prepare('SELECT action FROM integration_audit WHERE integration_id = ?').bind(it.id).all<{ action: string }>()).results;
    expect(audit.map((a) => a.action)).toEqual(['create', 'update:dataset_id,dataset_name,token']);
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
  });

  it('validates settings', async () => {
    const app = await createApp(cookie);
    const it = await create(app);
    for (const bad of [{ dataset_id: '../me' }, { token: 'short' }, { send_scope: 'some' }, { test_event_code: 'a b' }, { share_hashed_email: 'yes' }]) {
      expect((await patch(app, it.id, bad)).status).toBe(400);
    }
    expect((await patch(app, it.id, { token: TOKEN })).status).toBe(200);
  });

  it('rejects cross-site writes', async () => {
    const app = await createApp(cookie);
    const it = await create(app);
    expect((await patch(app, it.id, { send_scope: 'attributed' }, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await patch(app, it.id, { send_scope: 'attributed' }, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await patch(app, it.id, { send_scope: 'attributed' }, { headers: { origin: BASE, 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
  });

  it('activation needs the full config and accepted terms; losing a setting returns it to draft', async () => {
    const app = await createApp(cookie);
    const it = await create(app);
    const activate = (json: unknown = {}) => api(`/api/apps/${app.id}/integrations/${it.id}/activate`, { method: 'POST', json });
    expect(await (await activate()).json()).toEqual({ error: 'incomplete', missing: 'dataset_id' });
    await patch(app, it.id, { dataset_id: DATASET });
    expect(await (await activate()).json()).toEqual({ error: 'incomplete', missing: 'token' });
    await patch(app, it.id, { token: TOKEN });
    expect(await (await activate()).json()).toEqual({ error: 'terms_not_accepted' });
    const ok = await activate({ accept_terms: true });
    expect(await ok.json()).toMatchObject({ status: 'active', terms_accepted_at: expect.any(Number) });

    expect(await (await patch(app, it.id, { token: null })).json()).toMatchObject({ status: 'draft', has_token: false });
  });

  it('replaces mappings, keeps the locked install mapping, validates names', async () => {
    const app = await createApp(cookie);
    const it = await create(app);
    const put = (mappings: unknown) => api(`/api/apps/${app.id}/integrations/${it.id}/mappings`, { method: 'PUT', json: { mappings } });
    const res = await put([
      { source_event: 'rc_trial_converted', target_event: 'Purchase', send_value: true },
      { source_event: 'onboarding_done', target_event: 'CompleteRegistration' },
      { source_event: 'level_5', target_event: 'level_five_custom' },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json<Integration>();
    expect(body.mappings.map((m) => [m.source_event, m.target_event, m.send_value, m.locked])).toEqual([
      ['install', 'MobileAppInstall', false, true],
      ['level_5', 'level_five_custom', false, false],
      ['onboarding_done', 'CompleteRegistration', false, false],
      ['rc_trial_converted', 'Purchase', true, false],
    ]);
    expect((await put([{ source_event: 'install', target_event: 'Purchase' }])).status).toBe(400);
    expect((await put([{ source_event: 'rc_made_up', target_event: 'Purchase' }])).status).toBe(400);
    expect((await put([{ source_event: 'x', target_event: 'bad/name' }])).status).toBe(400);
    expect((await put([{ source_event: 'x', target_event: 'Lead' }, { source_event: 'x', target_event: 'Lead' }])).status).toBe(400);
    expect((await put('nope')).status).toBe(400);
  });

  it('test event: needs a test code, sends one event to Meta with it, reports the outcome', async () => {
    const app = await createApp(cookie);
    const it = await create(app);
    await patch(app, it.id, { dataset_id: DATASET, token: TOKEN });
    const test = () => api(`/api/apps/${app.id}/integrations/${it.id}/test`, { method: 'POST', json: { target_event: 'Purchase' } });
    expect(await (await test()).json()).toEqual({ error: 'test_event_code_required' });

    await patch(app, it.id, { test_event_code: 'TEST42' });
    const calls: Array<{ url: string; body: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ url: String(input), body: String(init?.body) });
      return new Response(JSON.stringify({ events_received: 1, fbtrace_id: 'x' }), { status: 200 });
    });
    expect(await (await test()).json()).toEqual({ ok: true, outcome: 'sent', error: null, target_event: 'Purchase' });
    expect(calls[0].url).toBe(`https://graph.facebook.com/v27.0/${DATASET}/events?access_token=${TOKEN}`);
    const sent = JSON.parse(calls[0].body);
    expect(sent.test_event_code).toBe('TEST42');
    expect(sent.data[0]).toMatchObject({ event_name: 'Purchase', action_source: 'app', custom_data: { value: 1, currency: 'USD' } });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Error validating access token', code: 190, fbtrace_id: 'T' } }), { status: 400 }),
    );
    const failed = await (await test()).json<{ ok: boolean; error: string }>();
    expect(failed).toMatchObject({ ok: false, outcome: 'fatal' });
    expect(failed.error).toContain('code 190');
    expect(failed.error).not.toContain(TOKEN);
  });

  it('disconnect clears credentials and skips pending deliveries; the network can be added again', async () => {
    const app = await createApp(cookie);
    const it = await ready(app);
    const now = Date.now();
    await db
      .prepare(`INSERT INTO postback_outbox (id, app_id, integration_id, source_event_id, target_event, event_ts, status, next_attempt_at, created_at)
                VALUES ('pb-dc', ?, ?, 'src-1', 'Purchase', ?, 'pending', ?, ?)`)
      .bind(app.id, it.id, now, now, now)
      .run();
    expect((await api(`/api/apps/${app.id}/integrations/${it.id}`, { method: 'DELETE' })).status).toBe(200);
    const row = await db.prepare('SELECT status, capi_token_enc FROM integrations WHERE id = ?').bind(it.id).first();
    expect(row).toEqual({ status: 'disconnected', capi_token_enc: null });
    expect(await db.prepare(`SELECT status FROM postback_outbox WHERE id = 'pb-dc'`).first('status')).toBe('skipped');

    const again = await create(app);
    expect(again).toMatchObject({ id: it.id, status: 'draft', has_token: false, dataset_id: null });
  });

  it('lists integrations with 24 h delivery stats and the last error; deliveries carry no device data', async () => {
    const app = await createApp(cookie);
    const it = await ready(app);
    const now = Date.now();
    const ins = (id: string, status: string, err: string | null, sentAt: number | null) =>
      db
        .prepare(`INSERT INTO postback_outbox (id, app_id, integration_id, source_event_id, install_id, target_event, event_ts, status, last_error, created_at, sent_at, transient_enc)
                  VALUES (?, ?, ?, ?, 'inst-secret', 'Purchase', ?, ?, ?, ?, ?, 'v1.x.y.z')`)
        .bind(id, app.id, it.id, `s-${id}`, now, status, err, now, sentAt)
        .run();
    await ins('d1', 'sent', null, now);
    await ins('d2', 'failed', 'Meta 400 (code 100): Invalid parameter', null);
    await ins('d3', 'pending', null, null);

    const list = await (await api(`/api/apps/${app.id}/integrations`)).json<{ providers: unknown[]; integrations: Integration[] }>();
    expect(list.providers).toEqual([{ provider: 'meta', name: 'Meta Ads' }]);
    expect(list.integrations[0].stats).toMatchObject({ sent_24h: 1, failed_24h: 1, pending: 1, last_error: 'Meta 400 (code 100): Invalid parameter' });

    const deliveries = await (await api(`/api/apps/${app.id}/integrations/${it.id}/deliveries?status=failed`)).json<Array<Record<string, unknown>>>();
    expect(deliveries.map((d) => d.id)).toEqual(['d2']);
    expect(JSON.stringify(deliveries)).not.toMatch(/inst-secret|transient|v1\.x/);
    expect((await api(`/api/apps/${app.id}/integrations/${it.id}/deliveries?status=weird`)).status).toBe(400);
  });

  it('event catalog: built-in names plus recent custom events, never rc_* from the SDK', async () => {
    const app = await createApp(cookie);
    const now = Date.now();
    const ev = (id: string, name: string) =>
      db.prepare(`INSERT INTO events (app_id, id, install_id, ts, type, name) VALUES (?, ?, 'i1', ?, 'event', ?)`).bind(app.id, id, now, name).run();
    await ev('e1', 'level_up');
    await ev('e2', 'level_up');
    await ev('e3', 'rc_trial_converted');
    const cat = await (await api(`/api/apps/${app.id}/event-catalog`)).json<{ builtin: string[]; custom: Array<{ name: string }> }>();
    expect(cat.builtin[0]).toBe('install');
    expect(cat.builtin).toContain('rc_trial_converted');
    expect(cat.custom).toEqual([{ name: 'level_up', count_30d: 2 }]);
  });
});
