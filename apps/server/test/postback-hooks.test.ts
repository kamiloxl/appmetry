import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SdkEvent } from '@appmetry/shared';
import worker from '../src/index';
import type { AppRow, Env } from '../src/env';
import { tokenContext } from '../src/integrations/dispatch';
import { registerAdapter } from '../src/integrations/registry';
import { forgetIntegrations } from '../src/integrations/store';
import type { OutboxEvent, PostbackAdapter } from '../src/integrations/types';
import { parseKeys, seal } from '../src/lib/sealed';
import { rematch } from '../src/revenuecat';
import { BASE, call, createApp, login } from './helpers';
import { rcBody, rcEvent, withInstallAttr } from './fixtures/rc';

const db = env.DB;
const keys = parseKeys(env as Env)!;
const sent: OutboxEvent[] = [];

const hookAdapter: PostbackAdapter = {
  provider: 'hookfake',
  maxBatch: 100,
  allowedHosts: ['hookfake.example'],
  isAttributedTo: () => true,
  async buildRequest(_ctx, events) {
    sent.push(...events);
    return { url: 'https://hookfake.example/events', init: { method: 'POST', body: '[]' } };
  },
  classify: (status) => (status < 300 ? { outcome: 'sent' } : { outcome: 'retry', error: `http ${status}` }),
};

let cookie: string;
beforeAll(async () => {
  cookie = await login();
  registerAdapter(hookAdapter);
});
beforeEach(() => {
  sent.length = 0;
  // Only the fake network is reachable; anything else would be a bug.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://hookfake.example/')) throw new Error(`unexpected fetch ${url}`);
    return new Response('{}', { status: 200 });
  });
});
afterEach(() => vi.restoreAllMocks());

async function setup(mappings: Array<[string, string, number]> = [['install', 'hook_install', 0], ['level_up', 'Level', 0], ['rc_trial_converted', 'Purchase', 1]]) {
  const app = await createApp(cookie);
  const id = `hook-int-${crypto.randomUUID()}`;
  const now = Date.now();
  await db.batch([
    db
      .prepare(`INSERT INTO integrations (id, app_id, provider, status, send_scope, config, capi_token_enc, created_at, updated_at)
                VALUES (?, ?, 'hookfake', 'active', 'all', '{}', ?, ?, ?)`)
      .bind(id, app.id, await seal(keys, 'tok', tokenContext(id)), now, now),
    ...mappings.map(([s, t, v]) =>
      db.prepare('INSERT INTO integration_mappings (app_id, integration_id, source_event, target_event, send_value, locked) VALUES (?, ?, ?, ?, ?, 0)').bind(app.id, id, s, t, v),
    ),
  ]);
  forgetIntegrations(app.id);
  return app;
}

const context = { iid: 'hook-install-1', platform: 'ios', osVersion: '18.1', appVersion: '1.0', build: '1', deviceModel: 'iPhone', locale: 'en-GB', timezone: 'UTC', sdkVersion: '0.1.0', bundleId: 'com.x' };
let seq = 0;
const ev = (type: SdkEvent['type'], extra: Partial<SdkEvent> = {}): SdkEvent => ({ id: `hook-ev-${String(++seq).padStart(6, '0')}`, type, ts: Date.now() - 1000, sid: 'hook-session-1', ...extra });

async function batch(app: AppRow, events: SdkEvent[]) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(BASE + '/api/v1/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-app-key': app.app_key, 'cf-connecting-ip': '198.51.100.20', 'user-agent': 'Demo/1 CFNetwork Darwin' },
      body: JSON.stringify({ context, events }),
    }),
    env as Env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  expect(res.status).toBe(202);
}

const outbox = (app: AppRow) => db.prepare('SELECT * FROM postback_outbox WHERE app_id = ? ORDER BY event_ts').bind(app.id).all<Record<string, unknown>>().then((r) => r.results);

describe('SDK batch → ad network', () => {
  it('sends the install and mapped custom events with consent; reserved names from the SDK are ignored', async () => {
    const app = await setup();
    await batch(app, [
      ev('install', { props: { adConsent: true, att: 'authorized' } }),
      ev('event', { name: 'level_up' }),
      ev('event', { name: 'rc_trial_converted' }), // spoofed lifecycle name: never a Purchase
      ev('event', { name: 'unmapped' }),
    ]);
    const rows = await outbox(app);
    expect(rows.map((r) => [r.source_event_id, r.target_event, r.status])).toEqual([
      ['install_hook-install-1', 'hook_install', 'sent'],
      [expect.stringMatching(/^hook-ev-/), 'Level', 'sent'],
    ]);
    expect(sent.find((e) => e.targetEvent === 'hook_install')?.transient).toEqual({ ip: '198.51.100.20', ua: 'Demo/1 CFNetwork Darwin' });
    expect(rows.every((r) => r.transient_enc === null)).toBe(true);
  });

  it('sends nothing without consent, then the install once consent is given', async () => {
    const app = await setup();
    await batch(app, [ev('install', { props: { adConsent: false } }), ev('event', { name: 'level_up' })]);
    expect(await outbox(app)).toEqual([]);

    await batch(app, [ev('consent', { props: { adConsent: true, att: 'denied' }, ts: Date.now() })]);
    await batch(app, [ev('consent', { props: { adConsent: true, att: 'denied' }, ts: Date.now() + 1 })]);
    const rows = await outbox(app);
    expect(rows.map((r) => [r.source_event_id, r.status])).toEqual([['install_hook-install-1', 'sent']]);
    // ATT denied: no IP / user agent kept or sent.
    expect(sent[0].transient).toBeNull();
  });

  it('a retried batch never sends twice', async () => {
    const app = await setup();
    const events = [ev('install', { props: { adConsent: true } }), ev('event', { name: 'level_up' })];
    await batch(app, events);
    await batch(app, events);
    expect(sent).toHaveLength(2);
  });
});

describe('RevenueCat → ad network', () => {
  async function rcSecret(app: AppRow) {
    const res = await call(`/api/apps/${app.id}/rc-secret`, { method: 'POST', cookie });
    return (await res.json<{ secret: string }>()).secret;
  }
  const hook = (app: AppRow, secret: string, event: ReturnType<typeof rcEvent>) =>
    call(`/api/webhooks/revenuecat/${app.id}`, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, json: rcBody(event) });

  it('a trial conversion becomes a Purchase with value', async () => {
    const app = await setup();
    await batch(app, [ev('install', { props: { adConsent: true, att: 'authorized' } })]);
    const secret = await rcSecret(app);
    const conv = withInstallAttr(rcEvent({ type: 'RENEWAL', is_trial_conversion: true, price: 59.99 }), 'hook-install-1');
    expect((await hook(app, secret, conv)).status).toBe(200);
    const row = (await outbox(app)).find((r) => r.target_event === 'Purchase');
    expect(row).toMatchObject({ source_event_id: `rc_${conv.id}`, value_cents: 5999, currency: 'USD', status: 'sent' });
  });

  it('a late match via rematch queues the lifecycle event for the cron', async () => {
    const app = await setup();
    await batch(app, [ev('install', { props: { adConsent: true } })]);
    const secret = await rcSecret(app);
    const conv = rcEvent({ type: 'RENEWAL', is_trial_conversion: true, price: 9.99, app_user_id: 'user-late' });
    await hook(app, secret, conv);
    expect((await outbox(app)).some((r) => r.target_event === 'Purchase')).toBe(false);

    await db.prepare('UPDATE installs SET user_id = ? WHERE app_id = ? AND id = ?').bind('user-late', app.id, 'hook-install-1').run();
    expect((await rematch(db, app.id, 0)).matched).toBe(1);
    const queued = (await outbox(app)).find((r) => r.target_event === 'Purchase');
    expect(queued).toMatchObject({ status: 'pending', value_cents: 999 });

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.now() + 1, cron: '*/5 * * * *' }), env as Env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await outbox(app)).find((r) => r.target_event === 'Purchase')?.status).toBe('sent');
  });
});
