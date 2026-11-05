import type { SdkEvent } from '@appdash/shared';

import { log } from './log';
import type { KV } from './storage';

export const QUEUE_KEY = 'appdash:queue';

const isEvent = (v: unknown): v is SdkEvent =>
  typeof v === 'object' && v !== null && typeof (v as SdkEvent).id === 'string';

/**
 * Persistent FIFO of events waiting to be sent, stored as a JSON array under `appdash:queue`.
 * The in-memory array is the source of truth; every change is written in full, and writes are
 * chained so they reach storage in order and the last write always holds the latest state.
 */
export class Queue {
  private items: SdkEvent[] = [];
  private chain: Promise<void> = Promise.resolve();
  private loadCalled = false;
  private epoch = 0; // bumped by clear(), so an in-flight load does not restore cleared events

  constructor(
    private readonly kv: KV,
    private readonly cap = 1000
  ) {}

  /** Restores persisted events. Corrupt or unreadable data starts empty. Keeps events enqueued meanwhile. */
  load(): Promise<void> {
    this.loadCalled = true;
    const epoch = this.epoch;
    return this.serialize(async () => {
      let stored: SdkEvent[] = [];
      try {
        const raw = await this.kv.get(QUEUE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        stored = Array.isArray(parsed) ? parsed.filter(isEvent) : [];
      } catch (err) {
        log('queue: could not read stored events, starting empty', err);
      }
      if (epoch !== this.epoch) return; // cleared after this load was requested
      const pending = this.items;
      const known = new Set(pending.map((e) => e.id));
      this.items = [...stored.filter((e) => !known.has(e.id)), ...pending];
      this.trim();
      if (pending.length > 0) await this.write();
    });
  }

  enqueue(e: SdkEvent): Promise<void> {
    try {
      JSON.stringify(e); // an unserializable event would block every later write: refuse it
      this.items.push(e);
      this.trim();
    } catch (err) {
      log('queue: enqueue failed', err);
    }
    return this.persist();
  }

  /** The `n` oldest events, without removing them. */
  peek(n: number): SdkEvent[] {
    return this.items.slice(0, Math.max(0, Math.floor(n) || 0));
  }

  ack(ids: string[]): Promise<void> {
    try {
      const done = new Set(ids);
      this.items = this.items.filter((e) => !done.has(e.id));
    } catch (err) {
      log('queue: ack failed', err);
    }
    return this.persist();
  }

  size(): number {
    return this.items.length;
  }

  clear(): Promise<void> {
    this.items = [];
    this.epoch += 1;
    return this.serialize(() => this.kv.remove(QUEUE_KEY));
  }

  private trim(): void {
    const over = this.items.length - this.cap;
    if (over > 0) {
      this.items.splice(0, over);
      log(`queue: over cap ${this.cap}, dropped ${over} oldest event(s)`);
    }
  }

  private persist(): Promise<void> {
    // Writing before the first load would overwrite events persisted by an earlier run.
    // load() merges them with what is in memory and writes the result.
    if (!this.loadCalled) return this.load();
    return this.serialize(() => this.write());
  }

  private write(): Promise<void> {
    return this.kv.set(QUEUE_KEY, JSON.stringify(this.items));
  }

  /** Runs `task` after every earlier storage operation. The returned promise never rejects. */
  private serialize(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task).then(
      () => undefined,
      (err: unknown) => log('queue: storage operation failed', err)
    );
    this.chain = next;
    return next;
  }
}
