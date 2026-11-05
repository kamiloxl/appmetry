import type { Batch } from '@appdash/shared';

import { Transport } from '../transport';

const batch: Batch = {
  context: {
    iid: 'install-1234',
    platform: 'ios',
    osVersion: '18.1',
    appVersion: '1.0.0',
    build: '1',
    deviceModel: 'iPhone 16',
    locale: 'en-GB',
    timezone: 'Europe/London',
    sdkVersion: '0.1.0',
    bundleId: 'com.example.app',
  },
  events: [{ id: 'event-0001', type: 'event', name: 'tap', ts: 1_700_000_000_000, sid: 'session-1' }],
};

function fetchReturning(status: number) {
  return jest.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({ status }) as Response);
}

describe('Transport', () => {
  test('posts to <host>/api/v1/batch with X-App-Key and JSON', async () => {
    const fetchFn = fetchReturning(202);
    const t = new Transport({ host: 'https://appdash.example.workers.dev', appKey: 'app_key123', fetchFn });
    await t.send(batch);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://appdash.example.workers.dev/api/v1/batch');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json', 'X-App-Key': 'app_key123' });
    expect(JSON.parse(init?.body as string)).toEqual(batch);
  });

  test('a trailing slash on host does not double the path separator', async () => {
    const fetchFn = fetchReturning(202);
    await new Transport({ host: 'https://h.example/', appKey: 'k', fetchFn }).send(batch);
    expect(fetchFn.mock.calls[0][0]).toBe('https://h.example/api/v1/batch');
  });

  test.each([200, 202, 204])('%i gives ok', async (status) => {
    const t = new Transport({ host: 'https://h.example', appKey: 'k', fetchFn: fetchReturning(status) });
    await expect(t.send(batch)).resolves.toBe('ok');
  });

  test.each([408, 425, 429, 500, 503])('%i gives retry', async (status) => {
    const t = new Transport({ host: 'https://h.example', appKey: 'k', fetchFn: fetchReturning(status) });
    await expect(t.send(batch)).resolves.toBe('retry');
  });

  test('a network error gives retry', async () => {
    const fetchFn = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const t = new Transport({ host: 'https://h.example', appKey: 'k', fetchFn });
    await expect(t.send(batch)).resolves.toBe('retry');
  });

  test('a request that never settles is aborted after 30 s and gives retry', async () => {
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchFn = jest.fn((_url: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => {}); // hangs and ignores the signal
      });
      const t = new Transport({ host: 'https://h.example', appKey: 'k', fetchFn });
      let result: string | undefined;
      void t.send(batch).then((r) => (result = r));

      await jest.advanceTimersByTimeAsync(29_999);
      expect(result).toBeUndefined();
      expect(signal?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(result).toBe('retry');
      expect(signal?.aborted).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a completed request leaves no timeout timer behind', async () => {
    jest.useFakeTimers();
    try {
      const t = new Transport({ host: 'https://h.example', appKey: 'k', fetchFn: fetchReturning(202) });
      await expect(t.send(batch)).resolves.toBe('ok');
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test.each([400, 401, 403, 404, 413])('%i gives drop', async (status) => {
    const t = new Transport({ host: 'https://h.example', appKey: 'k', fetchFn: fetchReturning(status) });
    await expect(t.send(batch)).resolves.toBe('drop');
  });

  test('an unserializable batch gives drop without calling fetch', async () => {
    const fetchFn = fetchReturning(202);
    const props: Record<string, unknown> = {};
    props.self = props;
    const bad: Batch = { ...batch, events: [{ ...batch.events[0], props }] };
    const t = new Transport({ host: 'https://h.example', appKey: 'k', fetchFn });
    await expect(t.send(bad)).resolves.toBe('drop');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
