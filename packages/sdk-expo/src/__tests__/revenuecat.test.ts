import type { AttributionResponse } from '@appmetry/shared';

import { createAppmetry } from '../client';
import { rcAttributes, type RevenueCatLike } from '../revenuecat';
import type { KV } from '../storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

class MemoryKV implements KV {
  map = new Map<string, string>();
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.map.set(k, v);
  }
  async remove(k: string) {
    this.map.delete(k);
  }
}

const attr = (over: Partial<AttributionResponse> = {}): AttributionResponse => ({
  resolved: true,
  method: 'deep_link',
  source: 'TikTok',
  channel: 'Paid',
  utm_campaign: 'launch',
  utm_content: 'v2',
  utm_term: null,
  asa_campaign_id: null,
  asa_adgroup_id: null,
  asa_keyword_id: null,
  ...over,
});
const json = (status: number, body?: unknown) => ({ status, ok: status === 200, json: async () => body }) as unknown as Response;

const flushPromises = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
async function advance(ms: number) {
  await flushPromises();
  await jest.advanceTimersByTimeAsync(ms);
  await flushPromises();
}

function rc(over: Record<string, unknown> = {}) {
  return {
    setAttributes: jest.fn(async () => {}),
    setMediaSource: jest.fn(async () => {}),
    setCampaign: jest.fn(async () => {}),
    setAdGroup: jest.fn(async () => {}),
    setAd: jest.fn(async () => {}),
    setKeyword: jest.fn(async () => {}),
    syncAttributesAndOfferingsIfNeeded: jest.fn(async () => ({})),
    ...over,
  };
}

const created: Array<{ optOut(): void }> = [];
function setup(opts: { attribution?: () => Response | Promise<Response>; requireConsent?: boolean } = {}) {
  const kv = new MemoryKV();
  const calls: string[] = [];
  const fetchFn = jest.fn(async (u: unknown) => {
    const url = String(u);
    if (url.includes('/api/v1/attribution')) {
      calls.push(url);
      return opts.attribution ? opts.attribution() : json(200, attr());
    }
    return { status: 200 } as Response;
  });
  let n = 0;
  const api = createAppmetry({
    store: kv,
    appState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    fetchFn: fetchFn as unknown as typeof fetch,
    newId: () => `id-${String(++n).padStart(6, '0')}-xxxx`,
    os: 'ios',
    linking: { getInitialURL: async () => null, addEventListener: () => ({ remove() {} }) } as never,
  });
  created.push(api);
  api.init({ appKey: 'app_test', host: 'https://x.example', requireConsent: opts.requireConsent });
  return { api, kv, fetchFn, calls };
}

beforeEach(() => jest.useFakeTimers());
afterEach(async () => {
  for (const a of created.splice(0)) a.optOut();
  await advance(10);
  jest.useRealTimers();
});

describe('rcAttributes', () => {
  it('maps a link install', () => {
    expect(rcAttributes(attr({ utm_campaign: 'launch', utm_content: 'v2' }))).toEqual({
      mediaSource: 'TikTok',
      campaign: 'launch',
      adGroup: null,
      ad: 'v2',
      keyword: null,
    });
  });

  it('maps Search Ads', () => {
    expect(
      rcAttributes(
        attr({ source: 'Apple Search Ads', utm_campaign: null, utm_content: null, asa_campaign_id: 111, asa_adgroup_id: 222, asa_keyword_id: 333 })
      )
    ).toEqual({ mediaSource: 'Apple Search Ads', campaign: '111', adGroup: '222', ad: null, keyword: '333' });
  });
});

describe('Appmetry.syncRevenueCat', () => {
  it('sets appmetry_install_id before attribution resolves', async () => {
    const a = setup({ attribution: () => new Promise<Response>(() => {}) });
    await advance(0);
    const p = rc();
    const done = a.api.syncRevenueCat(p, { waitMs: 3000 });
    await advance(10);
    expect(p.setAttributes).toHaveBeenCalledWith({ appmetry_install_id: await a.api.installId() });
    expect(p.setMediaSource).not.toHaveBeenCalled();
    await advance(20_000);
    await done;
  });

  it('sets only non-null attributes and calls syncAttributesAndOfferingsIfNeeded', async () => {
    const a = setup();
    await advance(0);
    const p = rc();
    await a.api.syncRevenueCat(p);
    await advance(0);
    expect(p.setMediaSource).toHaveBeenCalledWith('TikTok');
    expect(p.setCampaign).toHaveBeenCalledWith('launch');
    expect(p.setAd).toHaveBeenCalledWith('v2');
    expect(p.setAdGroup).not.toHaveBeenCalled();
    expect(p.setKeyword).not.toHaveBeenCalled();
    expect(p.syncAttributesAndOfferingsIfNeeded).toHaveBeenCalledTimes(1);
  });

  it('tolerates missing optional methods', async () => {
    const a = setup();
    await advance(0);
    const setAttributes = jest.fn(async () => {});
    await expect(a.api.syncRevenueCat({ setAttributes })).resolves.toBeUndefined();
    expect(setAttributes).toHaveBeenCalledTimes(1);
  });

  it('late resolution re-applies attributes once', async () => {
    let pendingNow = true;
    const a = setup({
      attribution: () =>
        json(200, pendingNow ? attr({ resolved: false }) : attr({ source: 'Apple Search Ads', utm_campaign: null, utm_content: null, asa_campaign_id: 9 })),
    });
    await advance(0);
    const p = rc();
    const done = a.api.syncRevenueCat(p, { waitMs: 1000 });
    await advance(1000);
    await done;
    expect(p.setMediaSource).not.toHaveBeenCalled();
    expect(p.syncAttributesAndOfferingsIfNeeded).not.toHaveBeenCalled();
    pendingNow = false;
    await advance(5000);
    expect(p.setMediaSource).toHaveBeenCalledTimes(1);
    expect(p.setMediaSource).toHaveBeenCalledWith('Apple Search Ads');
    expect(p.setCampaign).toHaveBeenCalledWith('9');
    expect(p.syncAttributesAndOfferingsIfNeeded).toHaveBeenCalledTimes(1);
    await advance(30_000);
    expect(p.setMediaSource).toHaveBeenCalledTimes(1);
  });

  it('no-op before init', async () => {
    const api = createAppmetry({ os: 'ios' });
    const p = rc();
    await api.syncRevenueCat(p);
    expect(p.setAttributes).not.toHaveBeenCalled();
  });

  it('no-op before consent and after opt-out', async () => {
    const a = setup({ requireConsent: true });
    await advance(0);
    const p = rc();
    await a.api.syncRevenueCat(p);
    expect(p.setAttributes).not.toHaveBeenCalled();
    expect(a.calls).toHaveLength(0);

    a.api.optIn();
    await advance(0);
    await a.api.syncRevenueCat(p);
    expect(p.setAttributes).toHaveBeenCalledTimes(1);
    a.api.optOut();
    const q = rc();
    await a.api.syncRevenueCat(q);
    expect(q.setAttributes).not.toHaveBeenCalled();
  });

  it('never throws when purchases methods throw, and still runs the remaining setters', async () => {
    const a = setup();
    await advance(0);
    const p = rc({
      setAttributes: jest.fn(() => {
        throw new Error('boom');
      }),
      setMediaSource: jest.fn(async () => {
        throw new Error('rejected');
      }),
      syncAttributesAndOfferingsIfNeeded: jest.fn(() => {
        throw new Error('sync boom');
      }),
    });
    await expect(a.api.syncRevenueCat(p as unknown as RevenueCatLike)).resolves.toBeUndefined();
    expect(p.setCampaign).toHaveBeenCalledWith('launch');
    expect(p.setAd).toHaveBeenCalledWith('v2');
    await expect(a.api.syncRevenueCat(null as never)).resolves.toBeUndefined();
  });

  it('opt-out removes the attribution cache and stops the poller', async () => {
    const a = setup({ attribution: () => json(200, attr({ resolved: false })) });
    await advance(0);
    const p = rc();
    const done = a.api.syncRevenueCat(p, { waitMs: 0 });
    await advance(10);
    await done;
    a.kv.map.set('appmetry:attribution', 'stale');
    a.fetchFn.mockClear();
    a.api.optOut();
    await advance(30_000);
    expect(a.kv.map.has('appmetry:attribution')).toBe(false);
    expect(a.calls.filter(() => true).length).toBeGreaterThan(0);
    expect(a.fetchFn.mock.calls.filter((c) => String(c[0]).includes('/attribution'))).toHaveLength(0);
    expect(p.setMediaSource).not.toHaveBeenCalled();
  });
});
