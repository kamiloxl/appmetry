import type { BatchContext, EventType, SdkEvent } from '@appdash/shared';
import { randomUUID } from 'expo-crypto';
import { AppState } from 'react-native';

import { buildContext, mobilePlatform } from './context';
import { Flusher } from './flusher';
import { log, setDebug } from './log';
import { collectInstallProps } from './native';
import { Queue } from './queue';
import { SessionTracker } from './session';
import { createStore, type KV } from './storage';
import { Transport } from './transport';
import { version as SDK_VERSION } from '../package.json';

export interface AppdashOptions {
  appKey: string;
  host: string;
  /** When true, nothing is stored or sent until `optIn()` is called. */
  requireConsent?: boolean;
  /** Time in the background after which a new session starts. Default 5 min. */
  sessionTimeoutMs?: number;
  debug?: boolean;
}

export interface AppdashApi {
  init(o: AppdashOptions): void;
  track(name: string, props?: Record<string, unknown>): void;
  screen(name: string): void;
  identify(p: { userId?: string; email?: string; name?: string }): void;
  reportSource(answer: string): void;
  optIn(): void;
  optOut(): void;
  installId(): Promise<string | null>;
  flush(): Promise<void>;
}

const KEY_IID = 'appdash:iid';
const KEY_CONSENT = 'appdash:consent';
const KEY_INSTALLED = 'appdash:installed';
const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60_000;
const MAX_NAME = 255;
const MAX_SOURCE = 100;
const MAX_USER_ID = 200;
const MAX_PROPS_CHARS = 1024;

/** Test seams. Production code uses the defaults. */
export interface AppdashDeps {
  store?: KV;
  appState?: {
    currentState: string;
    addEventListener(type: 'change', cb: (s: string) => void): { remove(): void };
  };
  fetchFn?: typeof fetch;
  newId?: () => string;
  now?: () => number;
  os?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

const clean = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().slice(0, max);
  return t === '' ? undefined : t;
};

export function createAppdash(deps: AppdashDeps = {}): AppdashApi {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? randomUUID;

  let initialized = false;
  let disabled = false;
  /** Tasks run one after another, so calls made during async setup are replayed in order. */
  let chain: Promise<unknown> | null = null;

  let opts: AppdashOptions;
  let store: KV;
  let queue: Queue;
  let flusher: Flusher;
  let tracker: SessionTracker;
  let platform: 'ios' | 'android';

  let enabled = false; // consent allows collection
  let activated = false; // iid exists, flusher running, listener attached
  let iid: string | null = null;
  let subscription: { remove(): void } | null = null;

  const appState = () => deps.appState ?? (AppState as unknown as NonNullable<AppdashDeps['appState']>);

  function run<T>(task: () => Promise<T> | T): Promise<T | undefined> {
    if (!chain) return Promise.resolve(undefined);
    const next = chain.then(async () => {
      try {
        return await task();
      } catch (err) {
        log('task failed', err);
        return undefined;
      }
    });
    chain = next;
    return next;
  }

  async function emit(type: EventType, ts: number, extra: { name?: string; props?: Record<string, unknown>; sid?: string } = {}) {
    if (!enabled || !activated) return;
    let sid = extra.sid ?? tracker.current();
    if (!sid) {
      // An event arrived before the app was ever foregrounded (headless start): open a session for it.
      const r = tracker.onActive(ts);
      sid = r.sid;
      if (r.started) await queueEvent({ id: newId(), type: 'session_start', ts, sid });
    }
    const e: SdkEvent = { id: newId(), type, ts, sid };
    if (extra.name !== undefined) e.name = extra.name;
    if (extra.props !== undefined) e.props = extra.props;
    await queueEvent(e);
  }

  async function queueEvent(e: SdkEvent) {
    await queue.enqueue(e);
    flusher.notify();
  }

  function onAppState(state: string) {
    const ts = now();
    void run(async () => {
      if (!enabled) return;
      if (state === 'active') {
        const r = tracker.onActive(ts);
        if (r.started) await emit('session_start', ts, { sid: r.sid });
      } else if (state === 'background') {
        const r = tracker.onBackground(ts);
        if (r) {
          await emit('ping', ts, { sid: r.sid, props: { ms: r.foregroundMs } });
          await flusher.flush();
        }
      }
    });
  }

  /** Creates the install id, queues install (once ever) and session_start, starts flushing. */
  async function activate() {
    if (activated) return;
    await queue.load();
    let id = await store.get(KEY_IID);
    if (!id) {
      id = newId();
      await store.set(KEY_IID, id);
    }
    iid = id;
    activated = true;
    const ts = now();
    if ((await store.get(KEY_INSTALLED)) !== '1') {
      let props: Record<string, unknown> = {};
      try {
        props = (await collectInstallProps()) ?? {};
      } catch (err) {
        log('collectInstallProps failed', err);
      }
      const e: SdkEvent = { id: newId(), type: 'install', ts, sid: tracker.current() ?? newId() };
      if (Object.keys(props).length > 0) e.props = props;
      // install belongs to the session that is about to start, so open it first.
      if (appState().currentState === 'active') {
        const r = tracker.onActive(ts);
        e.sid = r.sid;
        await queueEvent(e);
        if (r.started) await emit('session_start', ts, { sid: r.sid });
      } else {
        await queueEvent(e);
      }
      await store.set(KEY_INSTALLED, '1');
    } else if (appState().currentState === 'active') {
      const r = tracker.onActive(ts);
      if (r.started) await emit('session_start', ts, { sid: r.sid });
    }
    subscription?.remove();
    subscription = appState().addEventListener('change', onAppState);
    flusher.start();
    await flusher.flush(); // start() alone would not retry a batch that failed before an opt-out
  }

  async function setup() {
    const stored = await store.get(KEY_CONSENT);
    enabled = stored === 'granted' || (stored !== 'denied' && !opts.requireConsent);
    if (enabled) await activate();
    else log('no consent: collection is off');
  }

  return {
    init(o) {
      try {
        if (initialized) {
          log('init called again, ignoring');
          return;
        }
        initialized = true;
        setDebug(o?.debug === true);
        const p = mobilePlatform(deps.os);
        if (!p) {
          disabled = true;
          log('unsupported platform, SDK disabled');
          return;
        }
        platform = p;
        opts = o;
        store = deps.store ?? createStore();
        queue = new Queue(store);
        tracker = new SessionTracker(o.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS, newId);
        const transport = new Transport({ host: o.host, appKey: o.appKey, fetchFn: deps.fetchFn });
        flusher = new Flusher({
          queue,
          transport,
          context: (): BatchContext => {
            if (!iid) throw new Error('no install id');
            return buildContext(iid, platform, SDK_VERSION);
          },
        });
        chain = Promise.resolve();
        void run(setup);
      } catch (err) {
        disabled = true;
        chain = null;
        log('init failed', err);
      }
    },

    track(name, props) {
      const ts = now();
      void run(() => {
        const n = clean(name, MAX_NAME);
        if (!n) return;
        let p: Record<string, unknown> | undefined;
        if (props !== undefined) {
          try {
            if (isPlainObject(props) && JSON.stringify(props).length <= MAX_PROPS_CHARS) p = props;
            else log('track: props dropped (not a plain object or over 1024 chars)');
          } catch {
            log('track: props dropped (not serializable)');
          }
        }
        return emit('event', ts, { name: n, props: p });
      });
    },

    screen(name) {
      const ts = now();
      void run(() => {
        const n = clean(name, MAX_NAME);
        if (n) return emit('screen', ts, { name: n });
      });
    },

    identify(p) {
      const ts = now();
      void run(() => {
        const userId = clean(p?.userId, MAX_USER_ID);
        const email = clean(p?.email, MAX_NAME);
        const name = clean(p?.name, MAX_NAME);
        const props: Record<string, unknown> = {};
        if (userId) props.userId = userId;
        if (email) props.email = email;
        if (name) props.name = name;
        if (Object.keys(props).length > 0) return emit('identify', ts, { props });
      });
    },

    reportSource(answer) {
      const ts = now();
      void run(() => {
        const n = clean(answer, MAX_SOURCE);
        if (n) return emit('source', ts, { name: n });
      });
    },

    optIn() {
      void run(async () => {
        await store.set(KEY_CONSENT, 'granted');
        enabled = true;
        await activate();
      });
    },

    optOut() {
      void run(async () => {
        enabled = false;
        activated = false;
        flusher.stop();
        subscription?.remove();
        subscription = null;
        await queue.clear();
        await store.set(KEY_CONSENT, 'denied');
        await store.remove(KEY_IID);
        await store.remove(KEY_INSTALLED);
        iid = null;
        // Privacy reset: the next opt-in is a fresh install with a fresh session.
        tracker = new SessionTracker(opts.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS, newId);
      });
    },

    async installId() {
      if (disabled) return null;
      return (await run(() => (enabled && activated ? iid : null))) ?? null;
    },

    async flush() {
      await run(() => (enabled && activated ? flusher.flush() : undefined));
    },
  };
}

/** The app-wide instance. */
export const Appdash: AppdashApi = createAppdash();
