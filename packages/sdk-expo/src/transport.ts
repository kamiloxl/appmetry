import type { Batch } from '@appdash/shared';

import { log } from './log';

/** `ok`: accepted. `retry`: keep the events and try later. `drop`: the server will never accept them. */
export type SendResult = 'ok' | 'retry' | 'drop';

export interface TransportOptions {
  host: string;
  appKey: string;
  fetchFn?: typeof fetch;
}

/** POSTs one batch to `<host>/api/v1/batch`. Never throws. */
export class Transport {
  private readonly url: string;
  private readonly appKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(o: TransportOptions) {
    this.url = `${String(o.host).replace(/\/+$/, '')}/api/v1/batch`;
    this.appKey = o.appKey;
    // Late-bound so tests and polyfills that replace global fetch are honoured.
    this.fetchFn = o.fetchFn ?? ((input, init) => fetch(input, init));
  }

  async send(b: Batch): Promise<SendResult> {
    let body: string;
    try {
      body = JSON.stringify(b);
    } catch (err) {
      log('transport: batch is not serializable, dropping it', err);
      return 'drop';
    }
    try {
      const res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-App-Key': this.appKey },
        body,
      });
      return classify(res.status);
    } catch (err) {
      log('transport: network error', err);
      return 'retry';
    }
  }
}

function classify(status: number): SendResult {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429 || status >= 500) return 'retry';
  if (status >= 400) {
    log(`transport: server rejected batch with ${status}, dropping it`);
    return 'drop';
  }
  return 'retry';
}
