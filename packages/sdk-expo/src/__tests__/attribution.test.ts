import type { AttributionResponse } from '@appdash/shared';

import { AttributionCache } from '../attribution';
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

const resolved = (over: Partial<AttributionResponse> = {}): AttributionResponse => ({
  resolved: true,
  method: 'deep_link',
  source: 'TikTok',
  channel: 'Paid',
  utm_campaign: 'launch',
  utm_content: null,
  utm_term: null,
  asa_campaign_id: null,
  asa_adgroup_id: null,
  asa_keyword_id: null,
  ...over,
});
const pending = () => resolved({ resolved: false, method: 'organic' });

const json = (status: number, body?: unknown) =>
  ({ status, ok: status >= 200 && status < 300, json: async () => body }) as unknown as Response;

const flushPromises = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
async function advance(ms: number) {
  await flushPromises();
  await jest.advanceTimersByTimeAsync(ms);
  await flushPromises();
}

const IID = 'iid-12345678';
const opts = { host: 'https://x.example/', appKey: 'app_test' };
const caches: AttributionCache[] = [];
function make(kv: KV, fetchFn: jest.Mock) {
  const c = new AttributionCache(kv, { ...opts, fetchFn: fetchFn as unknown as typeof fetch });
  caches.push(c);
  return c;
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  for (const c of caches.splice(0)) c.stop();
  jest.useRealTimers();
});

describe('AttributionCache', () => {
  it('returns cached resolved attribution without fetching', async () => {
    const kv = new MemoryKV();
    kv.map.set('appdash:attribution', JSON.stringify({ iid: IID, attribution: resolved() }));
    const f = jest.fn();
    expect(await make(kv, f).get(IID, 3000)).toEqual(resolved());
    expect(f).not.toHaveBeenCalled();
  });

  it('ignores a cached attribution for a different iid', async () => {
    const kv = new MemoryKV();
    kv.map.set('appdash:attribution', JSON.stringify({ iid: 'other-iid-0001', attribution: resolved({ source: 'Old' }) }));
    const f = jest.fn(async () => json(200, resolved({ source: 'New' })));
    expect((await make(kv, f).get(IID, 3000))?.source).toBe('New');
    expect(f).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kv.map.get('appdash:attribution')!).iid).toBe(IID);
  });

  it('fetches GET <host>/api/v1/attribution?iid= with X-App-Key and caches when resolved', async () => {
    const kv = new MemoryKV();
    const f = jest.fn(async (_u: unknown, _i?: RequestInit) => json(200, resolved()));
    const r = await make(kv, f).get(IID, 3000);
    expect(r).toEqual(resolved());
    expect(f.mock.calls[0][0]).toBe(`https://x.example/api/v1/attribution?iid=${IID}`);
    expect((f.mock.calls[0][1] as RequestInit).headers).toEqual({ 'X-App-Key': 'app_test' });
    expect(JSON.parse(kv.map.get('appdash:attribution')!)).toEqual({ iid: IID, attribution: resolved() });
  });

  it('polls every 1 s until resolved or waitMs, then returns null', async () => {
    const kv = new MemoryKV();
    const f = jest.fn(async () => json(200, pending()));
    const p = make(kv, f).get(IID, 3000);
    await flushPromises();
    expect(f).toHaveBeenCalledTimes(1);
    await advance(1000);
    expect(f).toHaveBeenCalledTimes(2);
    await advance(2000);
    expect(f).toHaveBeenCalledTimes(4);
    expect(await p).toBeNull();
    expect(kv.map.has('appdash:attribution')).toBe(false);
  });

  it('returns as soon as a poll resolves', async () => {
    const kv = new MemoryKV();
    const f = jest.fn().mockResolvedValueOnce(json(200, pending())).mockResolvedValue(json(200, resolved()));
    const p = make(kv, f).get(IID, 3000);
    await advance(1000);
    expect(await p).toEqual(resolved());
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('keeps polling in background after waitMs (every 5 s, max 2 min) and fires onResolved once', async () => {
    const kv = new MemoryKV();
    const f = jest.fn(async () => json(200, pending()));
    const c = make(kv, f);
    const cb = jest.fn();
    c.onResolved(cb);
    const p = c.get(IID, 1000);
    await advance(1000);
    expect(await p).toBeNull();
    const base = f.mock.calls.length; // 2 foreground fetches
    await advance(5000);
    expect(f).toHaveBeenCalledTimes(base + 1);
    f.mockImplementation(async () => json(200, resolved()));
    await advance(5000);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(resolved());
    expect(JSON.parse(kv.map.get('appdash:attribution')!).iid).toBe(IID);
    const n = f.mock.calls.length;
    await advance(60_000);
    expect(f).toHaveBeenCalledTimes(n); // poller stopped
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('stops background polling after 2 minutes', async () => {
    const f = jest.fn(async () => json(404));
    const c = make(new MemoryKV(), f);
    const p = c.get(IID, 0);
    await advance(0);
    await p;
    await advance(130_000);
    const n = f.mock.calls.length;
    expect(n).toBeLessThanOrEqual(1 + 24);
    expect(n).toBeGreaterThan(20);
    await advance(60_000);
    expect(f).toHaveBeenCalledTimes(n);
  });

  it('runs only one background poller per iid', async () => {
    const f = jest.fn(async () => json(200, pending()));
    const c = make(new MemoryKV(), f);
    const p1 = c.get(IID, 0);
    await advance(0);
    await p1;
    const p2 = c.get(IID, 0);
    await advance(0);
    await p2;
    f.mockClear();
    await advance(5000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('404 or network error returns null without throwing', async () => {
    const f404 = jest.fn(async () => json(404));
    const p = make(new MemoryKV(), f404).get(IID, 0);
    await advance(0);
    expect(await p).toBeNull();
    const fErr = jest.fn(async () => {
      throw new Error('offline');
    });
    const p2 = make(new MemoryKV(), fErr).get(IID, 0);
    await advance(0);
    expect(await p2).toBeNull();
  });

  it('404 keeps polling, then resolves', async () => {
    const f = jest.fn().mockResolvedValueOnce(json(404)).mockResolvedValue(json(200, resolved()));
    const p = make(new MemoryKV(), f).get(IID, 3000);
    await advance(1000);
    expect(await p).toEqual(resolved());
  });

  it('a 401 stops polling, including the background poller', async () => {
    const f = jest.fn(async () => json(401));
    const p = make(new MemoryKV(), f).get(IID, 3000);
    await advance(10_000);
    expect(await p).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a hung request times out after about 5 s', async () => {
    const f = jest.fn(() => new Promise<Response>(() => {}));
    const p = make(new MemoryKV(), f).get(IID, 0);
    await advance(5100);
    expect(await p).toBeNull();
  });

  it('stop() ends the background poller', async () => {
    const f = jest.fn(async () => json(200, pending()));
    const c = make(new MemoryKV(), f);
    const p = c.get(IID, 0);
    await advance(0);
    await p;
    c.stop();
    f.mockClear();
    await advance(30_000);
    expect(f).not.toHaveBeenCalled();
  });
});
