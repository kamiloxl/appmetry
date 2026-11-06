import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SdkEvent } from '@appmetry/shared';
import worker from '../src/index';
import type { AppRow, Env } from '../src/env';
import { ingestBatch } from '../src/ingest';
import { open, parseKeys } from '../src/lib/sealed';
import { BASE, createApp, login } from './helpers';

const DAY = 86_400_000;
const GEO = { country: 'PL', region: 'Mazovia', city: 'Warsaw' };

let cookie: string;
beforeAll(async () => {
  cookie = await login();
});

const context = (patch: Record<string, unknown> = {}) => ({
  iid: 'install-0001',
  platform: 'ios',
  osVersion: '18.1',
  appVersion: '1.2.0',
  build: '42',
  deviceModel: 'iPhone16,1',
  locale: 'en-GB',
  timezone: 'Europe/London',
  sdkVersion: '0.1.0',
  bundleId: 'com.example.app',
  ...patch,
});

let seq = 0;
/** An SDK event with a fresh id. `ts` is an offset from now in ms unless `abs` is set. */
function ev(type: SdkEvent['type'], extra: Partial<SdkEvent> & { at?: number } = {}): SdkEvent {
  seq += 1;
  const { at = 0, ...rest } = extra;
  return { id: `event-${String(seq).padStart(6, '0')}`, type, ts: Date.now() + at, sid: 'session-0001', ...rest };
}

interface PostInit {
  key?: string | null;
  body?: string;
  json?: unknown;
  limiter?: RateLimit;
  cf?: Record<string, unknown>;
  method?: string;
  headers?: Record<string, string>;
  envPatch?: Partial<Env>;
}

/** Send a request to the batch endpoint in-process, optionally with a stub rate limiter and request.cf. */
async function post(init: PostInit = {}): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json', 'cf-connecting-ip': '198.51.100.7', ...init.headers });
  if (init.key) headers.set('X-App-Key', init.key);
  const body = init.body ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined);
  let testEnv: Env = init.limiter ? { ...(env as Env), INGEST_LIMITER: init.limiter } : (env as Env);
  if (init.envPatch) testEnv = { ...testEnv, ...init.envPatch };
  const req = new Request(BASE + '/api/v1/batch', {
    method: init.method ?? 'POST',
    headers,
    body,
    cf: (init.cf ?? GEO) as RequestInit['cf'],
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(req, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

const send = (app: AppRow, events: SdkEvent[], ctxPatch: Record<string, unknown> = {}, cf?: Record<string, unknown>, envPatch?: Partial<Env>) =>
  post({ key: app.app_key, json: { context: context(ctxPatch), events }, cf, envPatch });

const install = (app: AppRow, id = 'install-0001') =>
  env.DB.prepare('SELECT * FROM installs WHERE app_id = ? AND id = ?').bind(app.id, id).first<Record<string, unknown>>();
const session = (app: AppRow, id = 'session-0001') =>
  env.DB.prepare('SELECT * FROM sessions WHERE app_id = ? AND id = ?').bind(app.id, id).first<Record<string, unknown>>();
const eventCount = (app: AppRow) =>
  env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE app_id = ?').bind(app.id).first<number>('n');

describe('POST /api/v1/batch', () => {
  it('401 for unknown key', async () => {
    const batch = { context: context(), events: [ev('screen', { name: 'Home' })] };
    expect((await post({ key: 'app_unknown', json: batch })).status).toBe(401);
    expect((await post({ json: batch })).status).toBe(401);
  });

  it('413 over 64 KB', async () => {
    const app = await createApp(cookie);
    const res = await post({ key: app.app_key, body: JSON.stringify({ pad: 'x'.repeat(70_000) }) });
    expect(res.status).toBe(413);
    expect(await eventCount(app)).toBe(0);
  });

  it('400 for malformed json', async () => {
    const app = await createApp(cookie);
    expect((await post({ key: app.app_key, body: '{"context":' })).status).toBe(400);
    // Valid JSON that fails the shared schema is also a 400.
    expect((await post({ key: app.app_key, json: { context: context(), events: [] } })).status).toBe(400);
  });

  it('429 when limiter says no', async () => {
    const app = await createApp(cookie);
    const keys: string[] = [];
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      },
    } as RateLimit;
    const res = await post({ key: app.app_key, json: { context: context(), events: [ev('screen', { name: 'Home' })] }, limiter });
    expect(res.status).toBe(429);
    expect(keys).toEqual([`${app.app_key}:198.51.100.7`]);
    expect(await eventCount(app)).toBe(0);
  });

  it('403 when bundleId mismatches app.ios_bundle_id', async () => {
    const app = await createApp(cookie, { ios_bundle_id: 'com.example.other', android_package: 'com.example.app' });
    expect((await send(app, [ev('screen', { name: 'Home' })])).status).toBe(403);
    expect(await eventCount(app)).toBe(0);
    // The android package is checked only for android batches.
    expect((await send(app, [ev('screen', { name: 'Home' })], { platform: 'android' })).status).toBe(202);
    const droid = await createApp(cookie, { android_package: 'com.example.droid' });
    expect((await send(droid, [ev('screen', { name: 'Home' })], { platform: 'android' })).status).toBe(403);
    expect((await send(droid, [ev('screen', { name: 'Home' })], { platform: 'ios' })).status).toBe(202);
  });

  it('202 when the app has no bundle ids set', async () => {
    const app = await createApp(cookie);
    expect((await send(app, [ev('screen', { name: 'Home' })], { bundleId: 'anything.at.all' })).status).toBe(202);
  });

  it('answers CORS preflight for any origin', async () => {
    const res = await post({
      method: 'OPTIONS',
      headers: { Origin: 'https://example.com', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'X-App-Key, Content-Type' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('x-app-key');
  });

  it('returns 202', async () => {
    const app = await createApp(cookie);
    const res = await post({
      key: app.app_key,
      json: { context: context(), events: [ev('screen', { name: 'Home' }), ev('event', { name: 'tap' }), { bogus: true }] },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ inserted: 2, dropped: 1 });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('install event creates organic install with context and geo', async () => {
    const app = await createApp(cookie);
    const first = ev('install', { at: -5000 });
    const res = await send(app, [ev('screen', { name: 'Home', at: -1000 }), first]);
    expect(res.status).toBe(202);
    const row = await install(app);
    expect(row).toMatchObject({
      platform: 'ios',
      first_seen: first.ts,
      app_version: '1.2.0',
      os_version: '18.1',
      device_model: 'iPhone16,1',
      locale: 'en-GB',
      country: 'PL',
      region: 'Mazovia',
      city: 'Warsaw',
      source: 'App Store',
      channel: 'Organic',
      attribution_method: 'organic',
      utm_source: null,
      user_id: null,
    });
    expect(row!.last_seen).toBe(first.ts + 4000);

    // Later batches refresh context fields and last_seen; geo stays as first seen.
    await send(app, [ev('screen', { name: 'Settings' })], { appVersion: '1.3.0', osVersion: '18.2' }, { country: 'DE', city: 'Berlin' });
    const after = await install(app);
    expect(after).toMatchObject({ app_version: '1.3.0', os_version: '18.2', country: 'PL', city: 'Warsaw', first_seen: first.ts });
    expect(after!.last_seen as number).toBeGreaterThan(row!.last_seen as number);

    // A late batch with older events never moves last_seen back, but does move first_seen back.
    await send(app, [ev('screen', { name: 'Old', at: -60_000 })]);
    const late = await install(app);
    expect(late!.last_seen).toBe(after!.last_seen);
    expect(late!.first_seen as number).toBeLessThan(first.ts);
  });

  it('stores no request data beyond city-level geo', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('install'), ev('screen', { name: 'Home' })], {}, { ...GEO, latitude: '52.2', longitude: '21.0', postalCode: '00-001', asn: 1 });
    const dump = JSON.stringify([
      await install(app),
      await session(app),
      (await env.DB.prepare('SELECT * FROM events WHERE app_id = ?').bind(app.id).all()).results,
    ]);
    for (const s of ['198.51.100.7', '52.2', '21.0', '00-001', app.app_key]) expect(dump).not.toContain(s);
  });

  it('creates session from a non-start event', async () => {
    const app = await createApp(cookie);
    const screen = ev('screen', { name: 'Paywall' });
    expect((await send(app, [screen])).status).toBe(202);
    expect(await session(app)).toMatchObject({
      install_id: 'install-0001',
      started_at: screen.ts,
      last_seen_at: screen.ts,
      screens: 1,
      events: 0,
      duration: 0,
      entry_screen: 'Paywall',
      exit_screen: 'Paywall',
      platform: 'ios',
      app_version: '1.2.0',
      os_version: '18.1',
      country: 'PL',
      region: 'Mazovia',
      city: 'Warsaw',
      source: 'Direct',
      channel: 'Direct',
    });
    // The install exists too, even without an `install` event.
    expect(await install(app)).toMatchObject({ attribution_method: 'organic', first_seen: screen.ts });
  });

  it('retried batch does not double counters', async () => {
    const app = await createApp(cookie);
    const events = [
      ev('session_start', { at: -3000 }),
      ev('screen', { name: 'Home', at: -2000 }),
      ev('event', { name: 'tap', at: -1500 }),
      ev('ping', { at: -1000, props: { ms: 4000 } }),
    ];
    const r1 = await send(app, events);
    expect(await r1.json()).toEqual({ inserted: 4, dropped: 0 });
    const r2 = await send(app, events);
    expect(r2.status).toBe(202);
    expect(await r2.json()).toEqual({ inserted: 0, dropped: 0 });
    expect(await eventCount(app)).toBe(events.length);
    expect(await session(app)).toMatchObject({ screens: 1, events: 1, duration: 4000 });

    // A retry that overlaps with new events counts only the new ones.
    const more = [events[1], ev('screen', { name: 'Paywall' })];
    expect(await (await send(app, more)).json()).toEqual({ inserted: 1, dropped: 0 });
    expect(await session(app)).toMatchObject({ screens: 2, events: 1, duration: 4000 });
    expect(await eventCount(app)).toBe(5);
  });

  it('calls onInstall for every install event, including retries of stored ones', async () => {
    const app = await createApp(cookie);
    const calls: Array<[string, string]> = [];
    const onInstall = async (installId: string, e: SdkEvent) => {
      calls.push([installId, e.id]);
    };
    const inst = ev('install', { props: { referrer: 'utm_source=x' } });
    const batch = { context: context() as never, events: [inst, ev('screen', { name: 'Home' })] };
    await ingestBatch(env.DB, app, batch, GEO, Date.now(), onInstall);
    await ingestBatch(env.DB, app, batch, GEO, Date.now(), onInstall);
    expect(calls).toEqual([['install-0001', inst.id], ['install-0001', inst.id]]);
  });

  it('drops events outside ts clamp', async () => {
    const app = await createApp(cookie);
    const res = await post({
      key: app.app_key,
      json: {
        context: context(),
        events: [
          ev('screen', { name: 'Old', at: -8 * DAY }),
          ev('screen', { name: 'Future', at: 5 * 60_000 }),
          ev('screen', { name: 'Recent', at: -6 * DAY }),
          ev('screen', { name: 'Now' }),
          { id: 'bad id!', type: 'screen', ts: Date.now(), sid: 'session-0001' },
        ],
      },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ inserted: 2, dropped: 3 });
    const names = (await env.DB.prepare('SELECT name FROM events WHERE app_id = ? ORDER BY ts').bind(app.id).all()).results.map((r) => r.name);
    expect(names).toEqual(['Recent', 'Now']);

    // A batch with nothing in range writes nothing.
    const none = await send({ ...app }, [ev('screen', { name: 'Ancient', at: -30 * DAY, sid: 'session-0002' })]);
    expect(await none.json()).toEqual({ inserted: 0, dropped: 1 });
    expect(await session(app, 'session-0002')).toBeNull();
  });

  it('ping adds foreground ms capped at 10 min', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('ping', { at: -3000, props: { ms: 30_000 } }), ev('ping', { at: -2000, props: { ms: 900_000 } })]);
    expect((await session(app))!.duration).toBe(30_000 + 600_000);
    await send(app, [ev('ping', { at: -1000, props: { ms: -500 } }), ev('ping', { props: { ms: 'lots' } }), ev('ping')]);
    const s = await session(app);
    expect(s!.duration).toBe(630_000);
    expect(s).toMatchObject({ screens: 0, events: 0, entry_screen: null });
  });

  it('identify fills user_id/email(lowercased)/name with COALESCE', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('identify', { props: { userId: '  user-42  ', email: '  Jane.Doe@Example.COM ', name: ' Jane ' } })]);
    expect(await install(app)).toMatchObject({ user_id: 'user-42', email: 'jane.doe@example.com', name: 'Jane' });

    // A later identify with only some fields keeps the others; blank values never erase.
    await send(app, [ev('identify', { props: { userId: 'user-43', email: '   ' } })]);
    expect(await install(app)).toMatchObject({ user_id: 'user-43', email: 'jane.doe@example.com', name: 'Jane' });

    await send(app, [ev('identify', { props: { name: 'x'.repeat(500) } })]);
    expect(((await install(app))!.name as string).length).toBe(200);

    // The identity is applied to the install; it is not copied into the events table.
    const stored = await env.DB.prepare("SELECT props FROM events WHERE app_id = ? AND type = 'identify'").bind(app.id).all();
    expect(JSON.stringify(stored.results)).not.toContain('jane');
  });

  it('deep_link sets session source but not install source after first session', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('install', { at: -60_000, sid: 'session-0001' }), ev('screen', { name: 'Home', at: -59_000, sid: 'session-0001' })]);
    const link = 'myapp://promo?utm_source=newsletter&utm_medium=email&utm_campaign=spring&email=a@b.com#tok';
    const res = await send(app, [
      ev('deep_link', { name: link, sid: 'session-0002', at: -2000 }),
      ev('deep_link', { name: 'myapp://x?utm_source=tiktok', sid: 'session-0002', at: -1000 }),
    ]);
    expect(res.status).toBe(202);
    expect(await session(app, 'session-0002')).toMatchObject({
      source: 'Newsletter',
      channel: 'Email',
      utm_source: 'newsletter',
      utm_medium: 'email',
      utm_campaign: 'spring',
    });
    expect(await install(app)).toMatchObject({ attribution_method: 'organic', source: 'App Store', channel: 'Organic' });
    expect(await session(app, 'session-0001')).toMatchObject({ source: 'Direct', channel: 'Direct' });

    // A deep link that arrives in a later batch for the same session does not replace the first one.
    await send(app, [ev('deep_link', { name: 'myapp://y?utm_source=facebook', sid: 'session-0002' })]);
    expect((await session(app, 'session-0002'))!.source).toBe('Newsletter');

    const names = (await env.DB.prepare("SELECT name FROM events WHERE app_id = ? AND type = 'deep_link' ORDER BY ts").bind(app.id).all()).results;
    expect(names[0].name).toBe('myapp://promo?utm_source=newsletter&utm_medium=email&utm_campaign=spring');
  });

  it('deep_link in first session upgrades organic install to deep_link', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('install', { at: -5000 })]);
    await send(app, [ev('deep_link', { name: 'myapp://open?utm_source=google&utm_medium=cpc&utm_campaign=c1&ref=r1&click_id=abc123', at: -4000 })]);
    expect(await install(app)).toMatchObject({
      attribution_method: 'deep_link',
      source: 'Google',
      channel: 'Paid',
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'c1',
      ref: 'r1',
      click_id: 'abc123',
    });
    // Once attributed by deep link, a reported source cannot replace it.
    await send(app, [ev('source', { name: 'Instagram' })]);
    expect((await install(app))!.attribution_method).toBe('deep_link');
  });

  it('source event upgrades organic install to reported only', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('install', { at: -5000 }), ev('source', { name: 'TikTok', at: -4000 })]);
    const row = await install(app);
    expect(row).toMatchObject({ attribution_method: 'reported', source: 'TikTok' });
    // A second answer does not change a reported install.
    await send(app, [ev('source', { name: 'A friend told me' })]);
    expect((await install(app))!.source).toBe('TikTok');

    // An install already attributed with a stronger method is left alone.
    await env.DB.prepare("UPDATE installs SET attribution_method = 'search_ads', source = 'Apple Search Ads' WHERE app_id = ?").bind(app.id).run();
    await send(app, [ev('source', { name: 'YouTube' })], { iid: 'install-0001' });
    expect(await install(app)).toMatchObject({ attribution_method: 'search_ads', source: 'Apple Search Ads' });
  });

  it('a nameless screen does not blank entry_screen or exit_screen', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('screen', { name: 'Home', at: -3000 })]);
    // Earlier and later screens without a name still count, but never replace a named entry/exit screen.
    await send(app, [ev('screen', { at: -9000 }), ev('screen', { at: -1000 })]);
    expect(await session(app)).toMatchObject({ entry_screen: 'Home', exit_screen: 'Home', screens: 3 });
  });

  it('retry applies a deep_link upgrade that was lost after commit', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('install', { at: -5000 })]);
    // Simulate a commit whose attribution follow-up never ran: the event row exists, the install is still organic.
    const link = ev('deep_link', { name: 'myapp://open?utm_source=google&utm_medium=cpc&utm_campaign=c1', at: -4000 });
    await env.DB.prepare('INSERT INTO events (app_id, id, session_id, install_id, ts, type, name) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(app.id, link.id, link.sid, 'install-0001', link.ts, link.type, link.name)
      .run();
    expect((await install(app))!.attribution_method).toBe('organic');

    const calls: string[] = [];
    const res = await ingestBatch(env.DB, app, { context: context() as never, events: [link] }, GEO, Date.now(), async (_iid, e) => {
      calls.push(e.id);
    });
    expect(res).toEqual({ inserted: 0, dropped: 0 });
    expect(await install(app)).toMatchObject({ attribution_method: 'deep_link', source: 'Google', utm_campaign: 'c1' });

    // A retry of an install batch fires onInstall again (R16: the hook is idempotent).
    const inst = ev('install', { at: -6000, sid: 'session-0003' });
    await ingestBatch(env.DB, app, { context: context() as never, events: [inst] }, GEO, Date.now(), async (_iid, e) => {
      calls.push(e.id);
    });
    await ingestBatch(env.DB, app, { context: context() as never, events: [inst, link] }, GEO, Date.now(), async (_iid, e) => {
      calls.push(e.id);
    });
    expect(calls).toEqual([inst.id, inst.id]);
  });

  it('exit_screen tracks the latest screen by ts', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('screen', { name: 'B', at: -3000 }), ev('screen', { name: 'C', at: -2000 })]);
    expect(await session(app)).toMatchObject({ entry_screen: 'B', exit_screen: 'C', screens: 2 });
    // A late batch with an earlier screen moves the entry screen and start, but not the exit screen.
    const a = ev('screen', { name: 'A', at: -9000 });
    await send(app, [a]);
    expect(await session(app)).toMatchObject({ entry_screen: 'A', exit_screen: 'C', screens: 3, started_at: a.ts });
    await send(app, [ev('screen', { name: 'D', at: -1000 })]);
    expect(await session(app)).toMatchObject({ entry_screen: 'A', exit_screen: 'D', screens: 4 });
  });
});

describe('ad consent and device extinfo', () => {
  const IDFA = '6D92078A-8246-4BA4-AE5B-76104861E7DC';
  const keys = () => parseKeys(env as Env);

  it('stores consent, ATT status and the sealed IDFA when ATT is authorized; never in events', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('install', { props: { adConsent: true, att: 'authorized', madid: IDFA } })]);
    const row = await install(app);
    expect(row).toMatchObject({ ad_consent: 1, att_status: 'authorized' });
    expect(row!.madid_enc).toMatch(/^v1\./);
    expect(await open(keys(), row!.madid_enc as string, `install:${app.id}:install-0001:madid`)).toBe(IDFA);
    const rows = (await env.DB.prepare('SELECT * FROM events WHERE app_id = ?').bind(app.id).all<{ props: string }>()).results;
    expect(JSON.stringify(rows)).not.toContain(IDFA);
    expect(JSON.parse(rows[0].props)).toEqual({ adConsent: true, att: 'authorized' });
  });

  it('does not store the IDFA without ATT authorization or without ad consent', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('install', { props: { adConsent: true, att: 'denied', madid: IDFA } })]);
    expect(await install(app)).toMatchObject({ ad_consent: 1, att_status: 'denied', madid_enc: null });

    const app2 = await createApp(cookie);
    await send(app2, [ev('install', { props: { adConsent: false, att: 'authorized', madid: IDFA } })]);
    expect(await install(app2)).toMatchObject({ ad_consent: 0, madid_enc: null });
  });

  it('stores the GAID on Android with consent, and ignores the all-zero id', async () => {
    const app = await createApp(cookie);
    const gaid = '38400000-8cf0-11bd-b23e-10b96e40000d';
    await send(app, [ev('install', { props: { adConsent: true, madid: gaid } })], { platform: 'android' });
    expect((await install(app))!.madid_enc).toMatch(/^v1\./);

    const app2 = await createApp(cookie);
    await send(app2, [ev('install', { props: { adConsent: true, madid: '00000000-0000-0000-0000-000000000000' } })], { platform: 'android' });
    expect((await install(app2))!.madid_enc).toBeNull();
  });

  it('a later consent event updates the install; withdrawing consent clears the IDFA', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('install', { props: { adConsent: false, att: 'notDetermined' } })]);
    await send(app, [ev('consent', { props: { adConsent: true, att: 'authorized', madid: IDFA } })]);
    expect(await install(app)).toMatchObject({ ad_consent: 1, att_status: 'authorized' });
    expect((await install(app))!.madid_enc).not.toBeNull();

    await send(app, [ev('consent', { props: { adConsent: false, att: 'authorized', madid: IDFA } })]);
    expect(await install(app)).toMatchObject({ ad_consent: 0, madid_enc: null });
  });

  it('the latest consent event in a batch wins, by ts', async () => {
    const app = await createApp(cookie);
    await send(app, [
      ev('consent', { props: { adConsent: false }, at: -1000 }),
      ev('install', { props: { adConsent: true, att: 'authorized' }, at: -5000 }),
    ]);
    expect(await install(app)).toMatchObject({ ad_consent: 0 });
  });

  it('an older event from a late batch never overrides newer stored consent', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('consent', { props: { adConsent: true, att: 'authorized' } })]);
    await send(app, [ev('install', { props: { adConsent: false, att: 'denied' }, at: -60_000 })]);
    expect(await install(app)).toMatchObject({ ad_consent: 1, att_status: 'authorized' });
  });

  it('without INTEGRATIONS_KEY the IDFA is dropped, consent is still stored (fail closed)', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('install', { props: { adConsent: true, att: 'authorized', madid: IDFA } })], {}, undefined, { INTEGRATIONS_KEY: undefined });
    expect(await install(app)).toMatchObject({ ad_consent: 1, att_status: 'authorized', madid_enc: null });
  });

  it('ignores invalid consent values', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('install', { props: { adConsent: 'yes', att: 'maybe', madid: 'not-an-id' } })]);
    expect(await install(app)).toMatchObject({ ad_consent: null, att_status: null, madid_enc: null });
  });

  it('stores device extinfo from the context when present', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('install')], { deviceModelId: 'iPhone16,1', screenWidth: 1179, screenHeight: 2556, screenDensity: 3 });
    expect(JSON.parse((await install(app))!.device_extinfo as string)).toEqual({ modelId: 'iPhone16,1', w: 1179, h: 2556, density: 3 });

    const app2 = await createApp(cookie);
    await send(app2, [ev('install')]);
    expect((await install(app2))!.device_extinfo).toBeNull();
  });

  it('consent events do not count as custom events in session aggregates', async () => {
    const app = await createApp(cookie);
    await send(app, [ev('session_start'), ev('consent', { props: { adConsent: true } })]);
    expect((await session(app))!.events).toBe(0);
  });
});
