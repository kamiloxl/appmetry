import type { Batch } from '@appdash/shared';

import { log } from './log';

/** `ok`: accepted. `retry`: keep the events and try later. `drop`: the server will never accept them. */
export type SendResult = 'ok' | 'retry' | 'drop';

export interface TransportOptions {
  host: string;
  appKey: string;
  fetchFn?: typeof fetch;
  /** Abort a request that has not completed after this long. Default 30 s. */
  timeoutMs?: number;
}

export const REQUEST_TIMEOUT_MS = 30_000;

const TIMED_OUT = Symbol('timeout');
const ABORTED = Symbol('aborted');

/** POSTs one batch to `<host>/api/v1/batch`. Never throws. */
export class Transport {
  private readonly url: string;
  private readonly appKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly aborters = new Set<() => void>();

  constructor(o: TransportOptions) {
    this.url = `${String(o.host).replace(/\/+$/, '')}/api/v1/batch`;
    this.appKey = o.appKey;
    // Late-bound so tests and polyfills that replace global fetch are honoured.
    this.fetchFn = o.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = o.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Cancels every request in flight; each resolves to `retry`. Later sends are unaffected. */
  abort(): void {
    for (const a of [...this.aborters]) {
      try {
        a();
      } catch {
        // ignore
      }
    }
  }

  async send(b: Batch): Promise<SendResult> {
    let body: string;
    try {
      body = JSON.stringify(b);
    } catch (err) {
      log('transport: batch is not serializable, dropping it', err);
      return 'drop';
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let release = () => {};
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      // Race the timer too: React Native's fetch does not always honour the abort signal.
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => {
          controller?.abort();
          resolve(TIMED_OUT);
        }, this.timeoutMs);
      });
      const aborted = new Promise<typeof ABORTED>((resolve) => {
        const a = () => {
          controller?.abort();
          resolve(ABORTED);
        };
        this.aborters.add(a);
        release = () => this.aborters.delete(a);
      });
      const res = await Promise.race([
        this.fetchFn(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-App-Key': this.appKey },
          body,
          signal: controller?.signal,
        }),
        timeout,
        aborted,
      ]);
      if (res === ABORTED) return 'retry';
      if (res === TIMED_OUT) {
        log(`transport: no response after ${this.timeoutMs} ms, will retry`);
        return 'retry';
      }
      return classify(res.status);
    } catch (err) {
      log('transport: network error', err);
      return 'retry';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      release();
    }
  }
}

function classify(status: number): SendResult {
  if (status >= 200 && status < 300) return 'ok';
  // 408 Request Timeout and 425 Too Early are transient; 429 is rate limiting.
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'retry';
  if (status >= 400) {
    log(`transport: server rejected batch with ${status}, dropping it`);
    return 'drop';
  }
  return 'retry';
}
