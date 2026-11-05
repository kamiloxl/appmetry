import type { Batch, SdkEvent } from '@appdash/shared';

import { createAppdash } from '../client';
import type { KV } from '../storage';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

class MemoryKV implements KV {
  map = new Map<string, string>();
  writes = 0;
  log: string[] = [];
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.writes += 1;
    this.log.push(`set ${k}=${v}`);
    this.map.set(k, v);
  }
  async remove(k: string) {
    this.map.delete(k);
  }
}

type Listener = (s: string) => void;
function fakeAppState(initial = 'active') {
  let listener: Listener | null = null;
  return {
    currentState: initial,
    addEventListener: (_: 'change', cb: Listener) => {
      listener = cb;
      return { remove: () => { listener = null; } };
    },
    emit(s: string) {
      this.currentState = s;
      listener?.(s);
    },
    hasListener: () => listener !== null,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 10; i++) await tick();
}

const created: Array<{ optOut(): void; flush(): Promise<void> }> = [];

afterEach(async () => {
  // stop flusher timers so jest can exit
  for (const a of created.splice(0)) {
    a.optOut();
    await a.flush();
  }
});

function setup(opts: { os?: string; state?: string; kv?: MemoryKV; status?: number; hang?: boolean } = {}) {
  const kv = opts.kv ?? new MemoryKV();
  const appState = fakeAppState(opts.state ?? 'active');
  const bodies: Batch[] = [];
  const signals: AbortSignal[] = [];
  const fetchFn = jest.fn(async (_u: unknown, init?: RequestInit) => {
    if (opts.hang) {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => {});
    }
    bodies.push(JSON.parse(String(init?.body)));
    return { status: opts.status ?? 200 } as Response;
  });
  let n = 0;
  let clock = 1_700_000_000_000;
  const api = createAppdash({
    store: kv,
    appState,
    fetchFn: fetchFn as unknown as typeof fetch,
    newId: () => `id-${String(++n).padStart(6, '0')}-xxxx`,
    now: () => clock,
    os: opts.os ?? 'ios',
  });
  created.push(api);
  const sent = () => bodies.flatMap((b) => b.events);
  return { api, kv, appState, fetchFn, bodies, signals, sent, advance: (ms: number) => (clock += ms) };
}

const init = { appKey: 'app_test', host: 'https://x.example' };
const types = (evs: SdkEvent[]) => evs.map((e) => e.type);

describe('Appdash client', () => {
  it('init enqueues install once ever and session_start', async () => {
    const kv = new MemoryKV();
    const a = setup({ kv });
    a.api.init(init);
    await settle();
    await a.api.flush();
    expect(types(a.sent())).toEqual(['install', 'session_start']);
    expect(kv.map.get('appdash:installed')).toBe('1');
    expect(a.bodies[0].context.platform).toBe('ios');
    expect(a.bodies[0].context.iid).toBe(kv.map.get('appdash:iid'));

    const b = setup({ kv });
    b.api.init(init);
    await settle();
    await b.api.flush();
    expect(types(b.sent())).toEqual(['session_start']);
  });

  it('AppState background enqueues ping with ms and flushes', async () => {
    const a = setup();
    a.api.init(init);
    await settle();
    await a.api.flush();
    a.fetchFn.mockClear();
    a.bodies.length = 0;
    a.advance(7000);
    a.appState.emit('background');
    await settle();
    expect(a.fetchFn).toHaveBeenCalledTimes(1);
    const ping = a.sent()[0];
    expect(ping.type).toBe('ping');
    expect(ping.props).toEqual({ ms: 7000 });
  });

  it('track/screen/identify enqueue typed events with current sid', async () => {
    const a = setup();
    a.api.init(init);
    a.api.track('  purchase_tap ', { plan: 'pro' });
    a.api.screen('Home');
    a.api.identify({ userId: 'u1' });
    await a.api.flush();
    const evs = a.sent();
    const sid = evs.find((e) => e.type === 'session_start')!.sid;
    expect(evs.filter((e) => e.type === 'event')[0]).toMatchObject({ name: 'purchase_tap', props: { plan: 'pro' }, sid });
    expect(evs.filter((e) => e.type === 'screen')[0]).toMatchObject({ name: 'Home', sid });
    expect(evs.filter((e) => e.type === 'identify')[0]).toMatchObject({ props: { userId: 'u1' }, sid });
    for (const e of evs) expect(e.id).toMatch(/^[\w-]{8,64}$/);
  });

  it('buffers calls made before setup finishes, in order', async () => {
    const a = setup();
    a.api.init(init);
    a.api.track('first');
    a.api.screen('second');
    a.api.reportSource('  podcast  ');
    await a.api.flush();
    expect(types(a.sent())).toEqual(['install', 'session_start', 'event', 'screen', 'source']);
    expect(a.sent()[4].name).toBe('podcast');
  });

  it('ignores a second init', async () => {
    const a = setup();
    a.api.init(init);
    a.api.init({ ...init, appKey: 'app_other', host: 'https://other.example' });
    await settle();
    await a.api.flush();
    expect(a.fetchFn.mock.calls[0][0]).toBe('https://x.example/api/v1/batch');
    expect(types(a.sent()).filter((t) => t === 'install')).toHaveLength(1);
  });

  it('non-mobile platform disables the SDK', async () => {
    const a = setup({ os: 'web' });
    a.api.init(init);
    a.api.track('x');
    await settle();
    await a.api.flush();
    expect(a.fetchFn).not.toHaveBeenCalled();
    expect(a.kv.writes).toBe(0);
    expect(await a.api.installId()).toBeNull();
    expect(a.appState.hasListener()).toBe(false);
  });

  it('requireConsent: nothing stored or sent before optIn; optIn creates iid and install', async () => {
    const a = setup();
    a.api.init({ ...init, requireConsent: true });
    a.api.track('dropped');
    await settle();
    await a.api.flush();
    expect(a.kv.writes).toBe(0);
    expect(a.kv.map.size).toBe(0);
    expect(a.fetchFn).not.toHaveBeenCalled();
    expect(await a.api.installId()).toBeNull();

    a.api.optIn();
    await a.api.flush();
    expect(a.kv.map.get('appdash:consent')).toBe('granted');
    expect(a.kv.map.get('appdash:iid')).toBeTruthy();
    expect(types(a.sent())).toEqual(['install', 'session_start']);
  });

  it('stored denied behaves like no consent whatever requireConsent says', async () => {
    const kv = new MemoryKV();
    kv.map.set('appdash:consent', 'denied');
    const a = setup({ kv });
    a.api.init(init);
    a.api.track('x');
    await settle();
    await a.api.flush();
    expect(a.fetchFn).not.toHaveBeenCalled();
    expect(kv.map.has('appdash:iid')).toBe(false);
    expect(kv.map.has('appdash:queue')).toBe(false);
  });

  it('optOut clears queue, stops flushing and persists denied', async () => {
    const a = setup({ status: 500 }); // events stay queued
    a.api.init(init);
    await settle();
    expect(await a.api.installId()).toBeTruthy();
    expect(kv(a).map.get('appdash:queue')).toBeTruthy();
    a.api.optOut();
    await settle();
    a.fetchFn.mockClear();
    a.api.track('after');
    a.appState.emit('background');
    await a.api.flush();
    expect(a.fetchFn).not.toHaveBeenCalled();
    expect(a.kv.map.get('appdash:consent')).toBe('denied');
    expect(a.kv.map.has('appdash:queue')).toBe(false);
    expect(a.kv.map.has('appdash:iid')).toBe(false);
    expect(a.kv.map.has('appdash:installed')).toBe(false);
    expect(await a.api.installId()).toBeNull();
  });

  it('opt-out then opt-in delivers events with a new install', async () => {
    const a = setup();
    a.api.init(init);
    await settle();
    const first = await a.api.installId();
    a.api.optOut();
    a.api.optIn();
    await a.api.flush();
    const second = await a.api.installId();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    const last = a.bodies[a.bodies.length - 1];
    expect(last.context.iid).toBe(second);
    expect(types(last.events)).toEqual(['install', 'session_start']);
  });

  it('methods before init are no-ops and never throw', async () => {
    const a = setup();
    expect(() => {
      a.api.track('x');
      a.api.screen('x');
      a.api.identify({ userId: 'x' });
      a.api.reportSource('x');
      a.api.optIn();
      a.api.optOut();
    }).not.toThrow();
    await expect(a.api.flush()).resolves.toBeUndefined();
    expect(await a.api.installId()).toBeNull();
    expect(a.kv.writes).toBe(0);
  });

  it('installId returns persisted id', async () => {
    const kv = new MemoryKV();
    kv.map.set('appdash:iid', 'persisted-iid-1234');
    const a = setup({ kv });
    a.api.init(init);
    expect(await a.api.installId()).toBe('persisted-iid-1234');
  });

  it('identify trims, omits empties and sends nothing when empty', async () => {
    const a = setup();
    a.api.init(init);
    a.api.identify({ userId: '  u1 ', email: ' a@b.co ', name: '   ' });
    a.api.identify({ userId: '   ' });
    a.api.identify({ userId: 'x'.repeat(300) });
    await a.api.flush();
    const ids = a.sent().filter((e) => e.type === 'identify');
    expect(ids).toHaveLength(2);
    expect(ids[0].props).toEqual({ userId: 'u1', email: 'a@b.co' });
    expect((ids[1].props as { userId: string }).userId).toHaveLength(200);
  });

  it('track validates names and props', async () => {
    const a = setup();
    a.api.init(init);
    a.api.track('   ');
    a.api.track('n'.repeat(400));
    a.api.track('badprops', [1, 2] as unknown as Record<string, unknown>);
    a.api.track('bigprops', { v: 'x'.repeat(1100) });
    a.api.reportSource('   ');
    await a.api.flush();
    const evs = a.sent().filter((e) => e.type === 'event' || e.type === 'source');
    expect(evs).toHaveLength(3);
    expect(evs[0].name).toHaveLength(255);
    expect(evs[1]).toMatchObject({ name: 'badprops' });
    expect(evs[1].props).toBeUndefined();
    expect(evs[2]).toMatchObject({ name: 'bigprops' });
    expect(evs[2].props).toBeUndefined();
  });
});

describe('opt-out semantics', () => {
  it('optOut while a fetch hangs returns promptly, aborts it, drops later calls, writes nothing after denial', async () => {
    const a = setup({ hang: true });
    a.api.init(init);
    await settle();
    expect(a.fetchFn).toHaveBeenCalledTimes(1);
    const t0 = Date.now();
    a.api.optOut();
    expect(Date.now() - t0).toBeLessThan(50);
    expect(a.signals[0].aborted).toBe(true);
    expect(a.appState.hasListener()).toBe(false);
    a.api.track('after');
    a.appState.emit('background');
    await settle();
    await a.api.flush();
    const denied = a.kv.log.indexOf('set appdash:consent=denied');
    expect(denied).toBeGreaterThanOrEqual(0);
    expect(a.kv.log.slice(denied + 1).filter((l) => !l.startsWith('set appdash:consent=denied'))).toEqual([]);
    expect(a.kv.map.has('appdash:queue')).toBe(false);
    expect(a.kv.map.has('appdash:iid')).toBe(false);
    expect(a.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('init then optOut sends nothing and stores only consent=denied', async () => {
    const a = setup();
    a.api.init(init);
    a.api.optOut();
    await settle();
    await a.api.flush();
    expect(a.fetchFn).not.toHaveBeenCalled();
    expect([...a.kv.map.entries()]).toEqual([['appdash:consent', 'denied']]);
  });

  it('track during a hanging flush is queued without waiting', async () => {
    const a = setup({ hang: true });
    a.api.init(init);
    await settle();
    a.api.track('during');
    await settle();
    const queued = JSON.parse(a.kv.map.get('appdash:queue') ?? '[]') as SdkEvent[];
    expect(queued.map((e) => e.name ?? e.type)).toContain('during');
  });

  it('mutating props after track() does not change the queued event', async () => {
    const a = setup();
    a.api.init(init);
    const props: Record<string, unknown> = { plan: 'pro' };
    a.api.track('buy', props);
    props.plan = 'free';
    props.extra = 1;
    await a.api.flush();
    expect(a.sent().find((e) => e.name === 'buy')?.props).toEqual({ plan: 'pro' });
  });

  it('optIn after a hung-flush opt-out still delivers', async () => {
    const a = setup({ hang: true });
    a.api.init(init);
    await settle();
    a.api.optOut();
    a.api.optIn();
    await settle();
    expect(a.kv.map.get('appdash:consent')).toBe('granted');
    expect(a.fetchFn.mock.calls.length).toBe(2);
    const second = a.signals.length;
    expect(second).toBe(2);
    expect(JSON.parse(a.kv.map.get('appdash:queue') ?? '[]').map((e: SdkEvent) => e.type)).toEqual(['install', 'session_start']);
  });

  it('optIn after init+optOut delivers', async () => {
    const a = setup();
    a.api.init(init);
    a.api.optOut();
    a.api.optIn();
    await a.api.flush();
    expect(types(a.sent())).toEqual(['install', 'session_start']);
  });
});

function kv(a: { kv: MemoryKV }) {
  return a.kv;
}
