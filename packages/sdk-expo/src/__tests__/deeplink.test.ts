import type { Batch, SdkEvent } from '@appmetry/shared';

import { createAppmetry } from '../client';
import { resetDeepLinksForTests } from '../deeplink';
import type { KV } from '../storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

class MemoryKV implements KV {
  map = new Map<string, string>();
  async get(k: string) { return this.map.get(k) ?? null; }
  async set(k: string, v: string) { this.map.set(k, v); }
  async remove(k: string) { this.map.delete(k); }
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

const created: Array<{ optOut(): void; flush(): Promise<void> }> = [];
afterEach(async () => {
  for (const a of created.splice(0)) {
    a.optOut();
    await a.flush();
  }
});
beforeEach(() => resetDeepLinksForTests());

function setup(initialUrl: string | null = null, opts: { clockStep?: number; getInitialURL?: () => Promise<string | null> } = {}) {
  const kv = new MemoryKV();
  const bodies: Batch[] = [];
  const fetchFn = jest.fn(async (_u: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return { status: 200 } as Response;
  });
  let urlListener: ((e: { url: string }) => void) | null = null;
  const remove = jest.fn(() => { urlListener = null; });
  const linking = {
    getInitialURL: jest.fn(opts.getInitialURL ?? (async () => initialUrl)),
    addEventListener: jest.fn((_: 'url', cb: (e: { url: string }) => void) => {
      urlListener = cb;
      return { remove };
    }),
  };
  let n = 0;
  let clock = 1_700_000_000_000;
  const api = createAppmetry({
    store: kv,
    appState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    fetchFn: fetchFn as unknown as typeof fetch,
    newId: () => `id-${String(++n).padStart(6, '0')}-xxxx`,
    now: () => (clock += opts.clockStep ?? 0),
    os: 'ios',
    linking,
  });
  created.push(api);
  const sent = () => bodies.flatMap((b) => b.events);
  const links = (): SdkEvent[] => sent().filter((e) => e.type === 'deep_link');
  return { api, linking, remove, sent, links, emit: (url: string) => urlListener?.({ url }), advance: (ms: number) => (clock += ms) };
}

const init = { appKey: 'app_test', host: 'https://x.example' };

describe('deep links', () => {
  it('initial url with utm enqueues deep_link with cleaned url', async () => {
    const a = setup('myapp://promo?utm_source=tiktok&utm_campaign=spring&email=a@b.c#frag');
    a.api.init(init);
    await settle();
    await a.api.flush();
    expect(a.links()).toHaveLength(1);
    expect(a.links()[0].name).toBe('myapp://promo?utm_source=tiktok&utm_campaign=spring');
    expect(a.links()[0].props).toBeUndefined();
  });

  it('url without touch params is ignored', async () => {
    const a = setup('myapp://home?tab=2');
    a.api.init(init);
    await settle();
    a.emit('myapp://other?x=1');
    await settle();
    await a.api.flush();
    expect(a.links()).toHaveLength(0);
  });

  it('private params never reach the queue', async () => {
    const a = setup();
    a.api.init(init);
    await settle();
    a.emit('https://x.app/p?token=SECRET&utm_source=a&password=hunter2&code=9');
    await settle();
    await a.api.flush();
    const json = JSON.stringify(a.sent());
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('hunter2');
    expect(a.links()[0].name).toBe('https://x.app/p?utm_source=a');
  });

  it('truncates the url to 500 chars', async () => {
    const a = setup();
    a.api.init(init);
    await settle();
    a.emit(`https://x.app/${'a'.repeat(600)}?utm_source=a`);
    await settle();
    await a.api.flush();
    expect(a.links()[0].name).toHaveLength(500);
  });

  it('url events while running are captured', async () => {
    const a = setup();
    a.api.init(init);
    await settle();
    a.emit('myapp://x?utm_source=a');
    await settle();
    await a.api.flush();
    expect(a.links().map((e) => e.name)).toEqual(['myapp://x?utm_source=a']);
  });

  it('re-activation does not resend the initial URL', async () => {
    const a = setup('myapp://x?utm_source=a');
    a.api.init(init);
    await settle();
    await a.api.flush();
    a.api.optOut();
    await settle();
    a.api.optIn();
    await settle();
    await a.api.flush();
    expect(a.linking.getInitialURL).toHaveBeenCalledTimes(1);
    expect(a.links()).toHaveLength(1); // the one from the first activation; no second copy
    expect(a.linking.addEventListener).toHaveBeenCalledTimes(2);
  });

  it('initial url resolving after optOut is delivered once after optIn', async () => {
    const url = 'myapp://x?utm_source=a';
    let resolveFirst!: (v: string | null) => void;
    let calls = 0;
    const a = setup(url, {
      getInitialURL: () => (++calls === 1 ? new Promise<string | null>((r) => { resolveFirst = r; }) : Promise.resolve(url)),
    });
    a.api.init(init);
    await settle();
    a.api.optOut();
    resolveFirst(url);
    await settle();
    a.api.optIn();
    await settle();
    await a.api.flush();
    expect(a.links()).toHaveLength(1);
  });

  it('initial url is retried after getInitialURL rejects', async () => {
    const url = 'myapp://x?utm_source=a';
    let calls = 0;
    const a = setup(url, { getInitialURL: () => (++calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(url)) });
    a.api.init(init);
    await settle();
    a.api.optOut();
    await settle();
    a.api.optIn();
    await settle();
    await a.api.flush();
    expect(a.links()).toHaveLength(1);
  });

  it('optOut removes the subscription', async () => {
    const a = setup();
    a.api.init(init);
    await settle();
    a.api.optOut();
    expect(a.remove).toHaveBeenCalled();
  });

  it('ignores the same url within 2 s, accepts it later', async () => {
    const a = setup('myapp://x?utm_source=a');
    a.api.init(init);
    await settle();
    a.emit('myapp://x?utm_source=a&token=t');
    await settle();
    await a.api.flush();
    expect(a.links()).toHaveLength(1);
    a.advance(2500);
    a.emit('myapp://x?utm_source=a');
    await settle();
    await a.api.flush();
    expect(a.links()).toHaveLength(2);
  });

  it('queues no deep link before consent when requireConsent is set', async () => {
    const a = setup('myapp://x?utm_source=a');
    a.api.init({ ...init, requireConsent: true });
    await settle();
    a.emit('myapp://y?utm_source=b');
    a.api.deepLink('myapp://z?utm_source=c');
    await settle();
    await a.api.flush();
    expect(a.linking.addEventListener).not.toHaveBeenCalled();
    expect(a.linking.getInitialURL).not.toHaveBeenCalled();
    expect(a.sent()).toHaveLength(0);
  });

  it('sends the initial url once consent is granted', async () => {
    const a = setup('myapp://x?utm_source=a');
    a.api.init({ ...init, requireConsent: true });
    await settle();
    a.api.optIn();
    await settle();
    await a.api.flush();
    expect(a.links()).toHaveLength(1);
  });
});
