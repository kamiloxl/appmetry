import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AttributionResponse, SdkEvent } from '@appdash/shared';
import worker from '../src/index';
import type { AppRow, Env } from '../src/env';
import { exchangeAdServicesToken } from '../src/adservices';
import { applyAttribution, makeOnInstall } from '../src/attribution';
import { ingestBatch } from '../src/ingest';
import { BASE, createApp, login } from './helpers';

const GEO = { country: 'PL', region: null, city: null };
const DAY = 86_400_000;

let cookie: string;
beforeAll(async () => {
  cookie = await login();
});

const context = (iid: string, platform: 'ios' | 'android') => ({
  iid, platform, osVersion: '18.1', appVersion: '1.0.0', build: '1', deviceModel: 'X', locale: 'en-GB',
  timezone: 'Europe/London', sdkVersion: '0.1.0', bundleId: 'com.example.app',
});

let seq = 0;
function installEv(props: Record<string, unknown>, at = -5000): SdkEvent {
  seq += 1;
  return { id: `attr-event-${String(seq).padStart(6, '0')}`, type: 'install', ts: Date.now() + at, sid: 'session-attr-1', props } as SdkEvent;
}

let iidSeq = 0;
const newIid = () => `attr-install-${String(++iidSeq).padStart(4, '0')}`;

const row = (app: AppRow, iid: string) =>
  env.DB.prepare('SELECT * FROM installs WHERE app_id = ? AND id = ?').bind(app.id, iid).first<Record<string, unknown>>();

async function addLink(appId: string, id: string, extra: Partial<Record<string, string | null>> = {}) {
  const l = { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'spring', utm_content: 'hero', ref: null, ...extra };
  await env.DB.prepare('INSERT INTO links (id, app_id, slug, name, utm_source, utm_medium, utm_campaign, utm_content, ref, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .bind(id, appId, `slug-${id}`, 'L', l.utm_source, l.utm_medium, l.utm_campaign, l.utm_content, l.ref, Date.now()).run();
}
const addClick = (appId: string, linkId: string, id: string) =>
  env.DB.prepare('INSERT INTO link_clicks (id, link_id, app_id, ts) VALUES (?,?,?,?)').bind(id, linkId, appId, Date.now()).run();

/** Run an install batch through ingestBatch with makeOnInstall, flushing waitUntil work. */
async function ingest(app: AppRow, platform: 'ios' | 'android', iid: string, events: SdkEvent[], fetchFn?: typeof fetch) {
  const pending: Promise<unknown>[] = [];
  const onInstall = makeOnInstall(env.DB, app, (p) => void pending.push(p), Date.now(), {
    fetchFn, sleep: async () => {},
  });
  const res = await ingestBatch(env.DB, app, { context: context(iid, platform) as never, events }, GEO, Date.now(), onInstall);
  await Promise.all(pending);
  return res;
}

const fakeFetch = (status: number, body: unknown = {}, calls: Array<{ url: string; init?: RequestInit }> = []) =>
  (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

async function getAttribution(key: string | null, iid: string | null) {
  const headers = new Headers({ 'cf-connecting-ip': '198.51.100.9' });
  if (key) headers.set('X-App-Key', key);
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${BASE}/api/v1/attribution${iid === null ? '' : `?iid=${iid}`}`, { headers }), env as Env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('install referrer', () => {
  it('referrer with known click_id links install and click', async () => {
    const app = await createApp(cookie);
    await addLink(app.id, 'link-0001');
    await addClick(app.id, 'link-0001', 'click-0001');
    const iid = newIid();
    await ingest(app, 'android', iid, [installEv({ referrer: 'click_id=click-0001' })]);
    expect(await row(app, iid)).toMatchObject({
      attribution_method: 'install_referrer', utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'spring',
      utm_content: 'hero', click_id: 'click-0001',
    });
    const click = await env.DB.prepare('SELECT install_id FROM link_clicks WHERE id = ?').bind('click-0001').first<string>('install_id');
    expect(click).toBe(iid);
  });

  it('ignores click_id of another app', async () => {
    const app = await createApp(cookie);
    const other = await createApp(cookie);
    await addLink(other.id, 'link-0002');
    await addClick(other.id, 'link-0002', 'click-0002');
    const iid = newIid();
    await ingest(app, 'android', iid, [installEv({ referrer: 'click_id=click-0002' })]);
    expect(await row(app, iid)).toMatchObject({ attribution_method: 'organic' });
    const click = await env.DB.prepare('SELECT install_id FROM link_clicks WHERE id = ?').bind('click-0002').first<string | null>('install_id');
    expect(click).toBeNull();
  });

  it('empty link fields do not override referrer values', async () => {
    const app = await createApp(cookie);
    await addLink(app.id, 'link-0003', { utm_source: '', utm_campaign: '' });
    await addClick(app.id, 'link-0003', 'click-0003');
    const iid = newIid();
    await ingest(app, 'android', iid, [installEv({ referrer: 'utm_source=fb&utm_campaign=c9&click_id=click-0003' })]);
    expect(await row(app, iid)).toMatchObject({ attribution_method: 'install_referrer', utm_source: 'fb', utm_campaign: 'c9' });
  });

  it('does not overwrite a click already linked to another install', async () => {
    const app = await createApp(cookie);
    await addLink(app.id, 'link-0004');
    await addClick(app.id, 'link-0004', 'click-0004');
    const a = newIid();
    const b = newIid();
    await ingest(app, 'android', a, [installEv({ referrer: 'click_id=click-0004' })]);
    await ingest(app, 'android', b, [installEv({ referrer: 'click_id=click-0004' })]);
    const click = await env.DB.prepare('SELECT install_id FROM link_clicks WHERE id = ?').bind('click-0004').first<string>('install_id');
    expect(click).toBe(a);
  });

  it('a retried install batch (event row already stored) still applies the referrer attribution', async () => {
    const app = await createApp(cookie);
    const iid = newIid();
    const e = installEv({ referrer: 'utm_source=google&utm_medium=cpc&utm_campaign=retry' });
    // First attempt committed but onInstall never ran.
    await ingestBatch(env.DB, app, { context: context(iid, 'android') as never, events: [e] }, GEO, Date.now());
    expect(await row(app, iid)).toMatchObject({ attribution_method: 'organic' });
    const res = await ingest(app, 'android', iid, [e]);
    expect(res.inserted).toBe(0);
    expect(await row(app, iid)).toMatchObject({ attribution_method: 'install_referrer', utm_campaign: 'retry' });
  });

  it('never stores asaToken, and strips private params from the stored referrer', async () => {
    const app = await createApp(cookie);
    const iid = newIid();
    const e = installEv({ asaToken: 'SECRET-TOKEN-VALUE', referrer: 'utm_source=x&email=a%40b.com&token=zzz', installBeginTs: 5 });
    await ingest(app, 'ios', iid, [e], fakeFetch(200, { attribution: false }));
    const stored = await env.DB.prepare("SELECT props FROM events WHERE app_id = ? AND type = 'install'").bind(app.id).first<string>('props');
    expect(stored).not.toContain('asaToken');
    expect(stored).not.toContain('SECRET-TOKEN-VALUE');
    expect(JSON.parse(stored!)).toMatchObject({ referrer: 'utm_source=x', installBeginTs: 5 });
  });
});

describe('exchangeAdServicesToken', () => {
  it('posts the raw token as text/plain', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const out = await exchangeAdServicesToken('tok', fakeFetch(200, { attribution: true, campaignId: 1 }, calls), async () => {});
    expect(out).toEqual({ status: 'ok', result: { attribution: true, campaignId: 1 } });
    expect(calls[0].url).toBe('https://api-adservices.apple.com/api/v1/');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe('tok');
    expect(new Headers(calls[0].init?.headers).get('content-type')).toBe('text/plain');
  });

  it('retries 404 three times 5 s apart then returns retry', async () => {
    const sleeps: number[] = [];
    const calls: Array<{ url: string }> = [];
    const out = await exchangeAdServicesToken('tok', fakeFetch(404, {}, calls), async (ms) => void sleeps.push(ms));
    expect(out).toEqual({ status: 'retry' });
    expect(sleeps).toEqual([5000, 5000]);
    expect(calls).toHaveLength(3);
  });

  it('400 gives invalid', async () => {
    expect(await exchangeAdServicesToken('tok', fakeFetch(400), async () => {})).toEqual({ status: 'invalid' });
  });

  it('500 and network errors give retry immediately', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    expect(await exchangeAdServicesToken('tok', fakeFetch(500), sleep)).toEqual({ status: 'retry' });
    const boom = (async () => { throw new Error('net'); }) as unknown as typeof fetch;
    expect(await exchangeAdServicesToken('tok', boom, sleep)).toEqual({ status: 'retry' });
    expect(sleeps).toEqual([]);
  });
});

describe('Apple Search Ads', () => {
  it('200 attribution true sets search_ads and clears pending', async () => {
    const app = await createApp(cookie);
    const iid = newIid();
    await ingest(app, 'ios', iid, [installEv({ asaToken: 'tok-a' })], fakeFetch(200, { attribution: true, campaignId: 11, adGroupId: 22, keywordId: 33 }));
    expect(await row(app, iid)).toMatchObject({
      attribution_method: 'search_ads', source: 'Apple Search Ads', channel: 'Paid Search',
      asa_campaign_id: '11', asa_adgroup_id: '22', asa_keyword_id: '33', asa_pending_token: null, asa_pending_until: null,
    });
  });

  it('retry outcome stores asa_pending_token and asa_pending_until = install ts + 24h', async () => {
    const app = await createApp(cookie);
    const iid = newIid();
    const e = installEv({ asaToken: 'tok-b' });
    await ingest(app, 'ios', iid, [e], fakeFetch(500));
    expect(await row(app, iid)).toMatchObject({ attribution_method: 'organic', asa_pending_token: 'tok-b', asa_pending_until: e.ts + DAY });
  });

  it('invalid token clears pending', async () => {
    const app = await createApp(cookie);
    const iid = newIid();
    await ingest(app, 'ios', iid, [installEv({ asaToken: 'tok-c' })], fakeFetch(400));
    expect(await row(app, iid)).toMatchObject({ attribution_method: 'organic', asa_pending_token: null, asa_pending_until: null });
  });

  it('skips the exchange while a non-expired token is pending, and when already attributed', async () => {
    const app = await createApp(cookie);
    const iid = newIid();
    const e = installEv({ asaToken: 'tok-d' });
    await ingest(app, 'ios', iid, [e], fakeFetch(500));
    const calls: Array<{ url: string }> = [];
    await ingest(app, 'ios', iid, [e], fakeFetch(200, { attribution: true, campaignId: 1 }, calls));
    expect(calls).toHaveLength(0);
    expect(await row(app, iid)).toMatchObject({ asa_pending_token: 'tok-d', attribution_method: 'organic' });
  });

  it('search_ads does not override install_referrer', async () => {
    const app = await createApp(cookie);
    const iid = newIid();
    await ingest(app, 'android', iid, [installEv({ referrer: 'utm_source=google&utm_medium=cpc' })]);
    await applyAttribution(env.DB, app.id, iid, {
      method: 'search_ads', source: 'Apple Search Ads', channel: 'Paid Search', utm_source: null, utm_medium: null, utm_campaign: null,
      utm_term: null, utm_content: null, ref: null, click_id: null, asa_campaign_id: 5, asa_adgroup_id: null, asa_keyword_id: null,
    });
    expect(await row(app, iid)).toMatchObject({ attribution_method: 'install_referrer', utm_source: 'google', asa_campaign_id: null });
  });
});

describe('GET /api/v1/attribution', () => {
  it('returns resolved install_referrer attribution', async () => {
    const app = await createApp(cookie);
    const iid = newIid();
    await ingest(app, 'android', iid, [installEv({ referrer: 'utm_source=google&utm_medium=cpc&utm_campaign=c1&utm_term=shoes' })]);
    const res = await getAttribution(app.app_key, iid);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json<AttributionResponse>();
    expect(body).toMatchObject({
      resolved: true, method: 'install_referrer', source: 'Google', channel: 'Paid', utm_campaign: 'c1', utm_term: 'shoes',
      utm_content: null, asa_campaign_id: null, asa_adgroup_id: null, asa_keyword_id: null,
    });
  });

  it('returns resolved false while asa token pending', async () => {
    const app = await createApp(cookie);
    const iid = newIid();
    await ingest(app, 'ios', iid, [installEv({ asaToken: 'tok-e' })], fakeFetch(500));
    const body = await (await getAttribution(app.app_key, iid)).json<AttributionResponse>();
    expect(body).toMatchObject({ resolved: false, method: 'organic' });
  });

  it('returns numeric asa ids', async () => {
    const app = await createApp(cookie);
    const iid = newIid();
    await ingest(app, 'ios', iid, [installEv({ asaToken: 'tok-f' })], fakeFetch(200, { attribution: true, campaignId: 7, adGroupId: 8 }));
    const body = await (await getAttribution(app.app_key, iid)).json<AttributionResponse>();
    expect(body).toMatchObject({ resolved: true, method: 'search_ads', asa_campaign_id: 7, asa_adgroup_id: 8, asa_keyword_id: null });
  });

  it('404 for unknown iid and for an iid of another app', async () => {
    const app = await createApp(cookie);
    const other = await createApp(cookie);
    const iid = newIid();
    await ingest(other, 'android', iid, [installEv({ referrer: 'utm_source=x' })]);
    expect((await getAttribution(app.app_key, 'does-not-exist-1')).status).toBe(404);
    expect((await getAttribution(app.app_key, iid)).status).toBe(404);
  });

  it('401 for unknown or missing key', async () => {
    expect((await getAttribution('app_unknownunknown1', 'does-not-exist-1')).status).toBe(401);
    expect((await getAttribution(null, 'does-not-exist-1')).status).toBe(401);
  });

  it('400 for a missing or malformed iid', async () => {
    const app = await createApp(cookie);
    expect((await getAttribution(app.app_key, null)).status).toBe(400);
    expect((await getAttribution(app.app_key, 'short')).status).toBe(400);
  });
});
