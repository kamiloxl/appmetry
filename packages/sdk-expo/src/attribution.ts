import type { AttributionResponse } from '@appmetry/shared';

import { log } from './log';
import type { KV } from './storage';

export const ATTRIBUTION_KEY = 'appmetry:attribution';
const FOREGROUND_INTERVAL_MS = 1000;
const BACKGROUND_INTERVAL_MS = 5000;
const BACKGROUND_MAX_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 5000;

type Poll = { kind: 'resolved'; a: AttributionResponse } | { kind: 'pending' } | { kind: 'fatal' };

/**
 * Looks up the install's resolved source on the server and caches it once resolved.
 * Never throws. A resolved lookup is stored under `appmetry:attribution` together with its iid.
 */
export class AttributionCache {
  private readonly base: string;
  private readonly appKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly kv: KV;
  private readonly listeners = new Set<(a: AttributionResponse) => void>();
  private readonly pollers = new Set<string>();
  private readonly sleepers = new Set<{ timer: ReturnType<typeof setTimeout>; resolve: () => void }>();
  /** Bumped by stop(): everything started before it stops quietly and writes nothing. */
  private epoch = 0;

  constructor(kv: KV, o: { host: string; appKey: string; fetchFn?: typeof fetch }) {
    this.kv = kv;
    this.base = String(o.host).replace(/\/+$/, '');
    this.appKey = o.appKey;
    this.fetchFn = o.fetchFn ?? ((input, init) => fetch(input, init));
  }

  /** Fires when a lookup that was still pending after `get` returned resolves later. Returns an unsubscribe. */
  onResolved(cb: (a: AttributionResponse) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Cancels every poll and sleeping timer. A later `get` starts fresh. */
  stop(): void {
    this.epoch += 1;
    this.pollers.clear();
    for (const s of [...this.sleepers]) {
      clearTimeout(s.timer);
      s.resolve();
    }
    this.sleepers.clear();
  }

  async get(iid: string, waitMs: number): Promise<AttributionResponse | null> {
    const epoch = this.epoch;
    try {
      const cached = await this.readCache(iid);
      if (cached) return cached;
      if (epoch !== this.epoch) return null;
      const deadline = Date.now() + waitMs;
      let r = await this.poll(iid, epoch);
      while (r.kind === 'pending' && Date.now() < deadline) {
        await this.sleep(Math.min(FOREGROUND_INTERVAL_MS, deadline - Date.now()));
        if (epoch !== this.epoch) return null;
        r = await this.poll(iid, epoch);
      }
      if (r.kind === 'resolved') return r.a;
      if (r.kind === 'pending' && epoch === this.epoch) this.startBackground(iid, epoch);
      return null;
    } catch (err) {
      log('attribution lookup failed', err);
      return null;
    }
  }

  private async readCache(iid: string): Promise<AttributionResponse | null> {
    try {
      const raw = await this.kv.get(ATTRIBUTION_KEY);
      if (!raw) return null;
      const v = JSON.parse(raw) as { iid?: unknown; attribution?: AttributionResponse };
      if (v && v.iid === iid && v.attribution && v.attribution.resolved === true) return v.attribution;
    } catch {
      // unreadable cache: treat as missing
    }
    return null;
  }

  private startBackground(iid: string, epoch: number): void {
    if (this.pollers.has(iid)) return;
    this.pollers.add(iid);
    void (async () => {
      try {
        for (let elapsed = 0; elapsed < BACKGROUND_MAX_MS; elapsed += BACKGROUND_INTERVAL_MS) {
          await this.sleep(BACKGROUND_INTERVAL_MS);
          if (epoch !== this.epoch) return;
          const r = await this.poll(iid, epoch);
          if (epoch !== this.epoch) return;
          if (r.kind === 'fatal') return;
          if (r.kind === 'resolved') {
            for (const cb of [...this.listeners]) {
              try {
                cb(r.a);
              } catch (err) {
                log('onResolved listener failed', err);
              }
            }
            return;
          }
        }
      } catch (err) {
        log('attribution background poll failed', err);
      } finally {
        if (epoch === this.epoch) this.pollers.delete(iid);
      }
    })();
  }

  /** One request. Stores the result when resolved (unless stop() ran meanwhile). */
  private async poll(iid: string, epoch: number): Promise<Poll> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          controller?.abort();
          resolve('timeout');
        }, REQUEST_TIMEOUT_MS);
      });
      const request = this.fetchFn(`${this.base}/api/v1/attribution?iid=${encodeURIComponent(iid)}`, {
        method: 'GET',
        headers: { 'X-App-Key': this.appKey },
        signal: controller?.signal,
      });
      request.catch(() => {}); // a late rejection after the timeout must not be unhandled
      const res = await Promise.race([request, timeout]);
      if (res === 'timeout') return { kind: 'pending' };
      if (res.status === 401) return { kind: 'fatal' };
      if (res.status !== 200) return { kind: 'pending' }; // 404: the install batch may not have arrived yet
      const body = (await res.json()) as AttributionResponse;
      if (!body || body.resolved !== true) return { kind: 'pending' };
      if (epoch !== this.epoch) return { kind: 'pending' };
      await this.kv.set(ATTRIBUTION_KEY, JSON.stringify({ iid, attribution: body }));
      return { kind: 'resolved', a: body };
    } catch (err) {
      log('attribution request failed', err);
      return { kind: 'pending' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const s = {
        timer: setTimeout(() => {
          this.sleepers.delete(s);
          resolve();
        }, ms),
        resolve,
      };
      this.sleepers.add(s);
    });
  }
}
