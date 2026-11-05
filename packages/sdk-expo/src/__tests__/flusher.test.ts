import { LIMITS, type Batch, type BatchContext, type SdkEvent } from '@appdash/shared';

import { Flusher } from '../flusher';
import { Queue } from '../queue';
import type { KV } from '../storage';
import { Transport } from '../transport';

class MemoryKV implements KV {
  private map = new Map<string, string>();
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

const context: BatchContext = {
  iid: 'install-1234',
  platform: 'android',
  osVersion: '15',
  appVersion: '1.0.0',
  build: '1',
  deviceModel: 'Pixel 9',
  locale: 'en-GB',
  timezone: 'Europe/London',
  sdkVersion: '0.1.0',
  bundleId: 'com.example.app',
};

let seq = 0;
function ev(extra: Partial<SdkEvent> = {}): SdkEvent {
  seq += 1;
  return { id: `event-${String(seq).padStart(6, '0')}`, type: 'event', name: 'tap', ts: 1_700_000_000_000, sid: 'session-1', ...extra };
}

type FetchFn = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function setup(o: { status?: () => number; fetchFn?: FetchFn; context?: () => BatchContext } = {}) {
  const queue = new Queue(new MemoryKV());
  const status = o.status ?? (() => 202);
  const fetchFn = jest.fn<Promise<Response>, Parameters<FetchFn>>(
    o.fetchFn ?? (async () => ({ status: status() }) as Response)
  );
  const transport = new Transport({ host: 'https://h.example', appKey: 'app_test', fetchFn });
  const flusher = new Flusher({ queue, transport, context: o.context ?? (() => context) });
  const batches = (): Batch[] => fetchFn.mock.calls.map((c) => JSON.parse(c[1]?.body as string));
  return { queue, fetchFn, flusher, batches };
}

async function fill(queue: Queue, n: number, extra: Partial<SdkEvent> = {}) {
  for (let i = 0; i < n; i++) await queue.enqueue(ev(extra));
}

let current: Flusher | null = null;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  current?.stop();
  current = null;
  jest.useRealTimers();
});

describe('Flusher', () => {
  test('flushes every 15 s', async () => {
    const { queue, fetchFn, flusher } = setup();
    current = flusher;
    await fill(queue, 1);
    flusher.start();

    await jest.advanceTimersByTimeAsync(14_999);
    expect(fetchFn).toHaveBeenCalledTimes(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(0);

    // An empty queue sends nothing on the next tick.
    await jest.advanceTimersByTimeAsync(15_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    await fill(queue, 2);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(queue.size()).toBe(0);
  });

  test('flushes immediately at threshold 20', async () => {
    const { queue, fetchFn, flusher, batches } = setup();
    current = flusher;
    for (let i = 0; i < 19; i++) {
      await queue.enqueue(ev());
      flusher.notify();
    }
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(0);

    await queue.enqueue(ev());
    flusher.notify();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(batches()[0].events).toHaveLength(20);
    expect(batches()[0].context).toEqual(context);
    expect(queue.size()).toBe(0);
  });

  test('sends at most 50 per request and loops until empty', async () => {
    const { queue, flusher, batches } = setup();
    current = flusher;
    await fill(queue, 120);
    await flusher.flush();
    expect(batches().map((b) => b.events.length)).toEqual([LIMITS.maxEvents, LIMITS.maxEvents, 20]);
    expect(queue.size()).toBe(0);
    // Oldest first, no event sent twice.
    const sent = batches().flatMap((b) => b.events.map((e) => e.id));
    expect(new Set(sent).size).toBe(120);
    expect(sent).toEqual([...sent].sort());
  });

  test('keeps each request body within 64 KB', async () => {
    const { queue, flusher, batches, fetchFn } = setup();
    current = flusher;
    // ~1.3 KB per event: 50 of them would exceed LIMITS.maxBodyBytes.
    await fill(queue, 50, { name: 'n'.repeat(255), props: { blob: 'x'.repeat(1000) } });
    await flusher.flush();
    for (const call of fetchFn.mock.calls) {
      expect((call[1]?.body as string).length).toBeLessThanOrEqual(LIMITS.maxBodyBytes);
    }
    expect(batches().length).toBeGreaterThan(1);
    expect(batches().reduce((n, b) => n + b.events.length, 0)).toBe(50);
    expect(queue.size()).toBe(0);
  });

  test('backoff doubles from 2 s to max 5 min then resets on ok', async () => {
    let status = 503;
    const { queue, fetchFn, flusher } = setup({ status: () => status });
    current = flusher;
    await fill(queue, 3);

    expect(flusher.backoffMs()).toBe(2_000);
    await flusher.flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(3);

    const delays = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000];
    for (const delay of delays) {
      expect(flusher.backoffMs()).toBe(Math.min(delay * 2, 300_000));
      const calls = fetchFn.mock.calls.length;
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(fetchFn).toHaveBeenCalledTimes(calls);
      await jest.advanceTimersByTimeAsync(1);
      expect(fetchFn).toHaveBeenCalledTimes(calls + 1);
    }
    expect(flusher.backoffMs()).toBe(300_000);
    expect(queue.size()).toBe(3);

    status = 202;
    await jest.advanceTimersByTimeAsync(300_000);
    expect(queue.size()).toBe(0);
    expect(flusher.backoffMs()).toBe(2_000);
  });

  test('429 and network errors keep the events and schedule a retry', async () => {
    let calls = 0;
    const { queue, fetchFn, flusher } = setup({
      fetchFn: async () => {
        calls += 1;
        if (calls === 1) return { status: 429 } as Response;
        if (calls === 2) throw new TypeError('Network request failed');
        return { status: 202 } as Response;
      },
    });
    current = flusher;
    await fill(queue, 2);
    await flusher.flush();
    expect(queue.size()).toBe(2);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(queue.size()).toBe(2);
    await jest.advanceTimersByTimeAsync(4_000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(queue.size()).toBe(0);
  });

  test('drop acks the batch', async () => {
    let calls = 0;
    const { queue, fetchFn, flusher, batches } = setup({ status: () => (++calls === 1 ? 400 : 202) });
    current = flusher;
    await fill(queue, 60);
    await flusher.flush();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(batches().map((b) => b.events.length)).toEqual([50, 10]);
    expect(queue.size()).toBe(0);
    expect(flusher.backoffMs()).toBe(2_000);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('concurrent flush calls do not double send', async () => {
    let release: (r: Response) => void = () => {};
    const { queue, fetchFn, flusher } = setup({
      fetchFn: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    current = flusher;
    await fill(queue, 5);

    const first = flusher.flush();
    const second = flusher.flush();
    flusher.notify();
    expect(second).toBe(first);
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    release({ status: 202 } as Response);
    await first;
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(queue.size()).toBe(0);

    // Once settled, a new flush may run again.
    await fill(queue, 1);
    const third = flusher.flush();
    expect(third).not.toBe(first);
    await jest.advanceTimersByTimeAsync(0);
    release({ status: 202 } as Response);
    await third;
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test('notify and the interval wait while a retry is pending', async () => {
    const { queue, fetchFn, flusher } = setup({ status: () => 503 });
    current = flusher;
    await fill(queue, 1);
    flusher.start();
    // Fail 4 times (t = 0, 2, 6, 14 s): the next retry is 16 s away, at t = 30 s,
    // so the interval tick at 15 s must not send.
    await flusher.flush();
    await jest.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 1);
    expect(fetchFn).toHaveBeenCalledTimes(4);

    await fill(queue, 25);
    flusher.notify();
    await jest.advanceTimersByTimeAsync(15_998);
    expect(fetchFn).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  test('stop clears all timers', async () => {
    const { queue, fetchFn, flusher } = setup({ status: () => 503 });
    current = flusher;
    await fill(queue, 1);
    flusher.start();
    await flusher.flush();
    expect(jest.getTimerCount()).toBe(2);
    flusher.stop();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('start twice keeps a single interval', async () => {
    const { queue, fetchFn, flusher } = setup();
    current = flusher;
    flusher.start();
    flusher.start();
    expect(jest.getTimerCount()).toBe(1);
    await fill(queue, 1);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test('never throws when context() throws; events stay queued', async () => {
    const { queue, fetchFn, flusher } = setup({
      context: () => {
        throw new Error('no context yet');
      },
    });
    current = flusher;
    await fill(queue, 2);
    await expect(flusher.flush()).resolves.toBeUndefined();
    expect(() => flusher.notify()).not.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(queue.size()).toBe(2);
  });
});
