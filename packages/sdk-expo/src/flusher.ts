import { LIMITS, type Batch, type BatchContext, type SdkEvent } from '@appdash/shared';

import { log } from './log';
import type { Queue } from './queue';
import type { SendResult, Transport } from './transport';

export const BACKOFF_MIN_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

export interface FlusherOptions {
  queue: Queue;
  transport: Transport;
  context: () => BatchContext;
  /** Periodic flush interval. Default 15 s. */
  intervalMs?: number;
  /** Queue size at which `notify()` flushes immediately. Default 20. */
  threshold?: number;
  /** Clock, injectable for tests. Reserved; scheduling uses timers. */
  now?: () => number;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Sends queued events in batches of at most 50 (and at most 64 KB), oldest first.
 * One flush runs at a time. On `retry` it backs off exponentially from 2 s to 5 min;
 * while a retry is pending, `notify()` and the interval do not send. Never throws.
 */
export class Flusher {
  private readonly queue: Queue;
  private readonly transport: Transport;
  private readonly context: () => BatchContext;
  private readonly intervalMs: number;
  private readonly threshold: number;
  private readonly now: () => number;

  private inflight: Promise<void> | null = null;
  private backoff = BACKOFF_MIN_MS;
  private retryTimer: Timer | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private epoch = 0; // bumped by stop(): a run started earlier must not ack or retry

  constructor(o: FlusherOptions) {
    this.queue = o.queue;
    this.transport = o.transport;
    this.context = o.context;
    this.intervalMs = o.intervalMs ?? 15_000;
    this.threshold = o.threshold ?? 20;
    this.now = o.now ?? Date.now;
  }

  start(): void {
    try {
      this.stopped = false;
      if (this.intervalTimer) return;
      this.intervalTimer = setInterval(() => {
        if (!this.retryTimer) void this.flush();
      }, this.intervalMs);
    } catch (err) {
      log('flusher: start failed', err);
    }
  }

  stop(): void {
    try {
      this.stopped = true;
      this.epoch += 1;
      this.inflight = null;
      this.transport.abort();
      if (this.intervalTimer) clearInterval(this.intervalTimer);
      this.intervalTimer = null;
      this.clearRetry();
    } catch (err) {
      log('flusher: stop failed', err);
    }
  }

  /** Call after each enqueue: flushes now once the queue reaches the threshold, unless backing off. */
  notify(): void {
    try {
      if (this.queue.size() >= this.threshold && !this.retryTimer) void this.flush();
    } catch (err) {
      log('flusher: notify failed', err);
    }
  }

  /** Sends until the queue is empty or the server asks to retry. Concurrent calls share one run. */
  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const run = this.run()
      .catch((err: unknown) => log('flusher: flush failed', err))
      .finally(() => {
        if (this.inflight === run) this.inflight = null;
      });
    this.inflight = run;
    return run;
  }

  /** Delay before the next retry if the next attempt fails. */
  backoffMs(): number {
    return this.backoff;
  }

  private async run(): Promise<void> {
    const epoch = this.epoch;
    while (this.queue.size() > 0 && epoch === this.epoch) {
      let events: SdkEvent[] = [];
      let result: SendResult;
      try {
        const context = this.context();
        events = this.nextBatch(context);
        result = await this.transport.send({ context, events });
      } catch (err) {
        log('flusher: could not build or send batch', err);
        result = 'retry';
      }
      if (epoch !== this.epoch) return; // stopped meanwhile: leave the queue alone
      if (result === 'retry') {
        this.scheduleRetry();
        return;
      }
      // ok or drop: either way these events are done.
      await this.queue.ack(events.map((e) => e.id));
      this.backoff = BACKOFF_MIN_MS;
      this.clearRetry();
    }
  }

  /** Oldest events, at most LIMITS.maxEvents, halved until the body fits LIMITS.maxBodyBytes. */
  private nextBatch(context: BatchContext): SdkEvent[] {
    let events = this.queue.peek(LIMITS.maxEvents);
    while (events.length > 1 && bodyBytes({ context, events }) > LIMITS.maxBodyBytes) {
      events = events.slice(0, Math.ceil(events.length / 2));
    }
    return events;
  }

  private scheduleRetry(): void {
    this.clearRetry();
    if (this.stopped) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
    log(`flusher: retrying in ${delay} ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.flush();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}

function bodyBytes(batch: Batch): number {
  try {
    return utf8Length(JSON.stringify(batch));
  } catch {
    return 0; // unserializable: let the transport drop it
  }
}

function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4; // surrogate pair
      i++;
    } else bytes += 3;
  }
  return bytes;
}
