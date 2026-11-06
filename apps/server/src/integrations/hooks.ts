import type { SdkEvent } from '@appmetry/shared';
import type { AppRow, Env } from '../env';
import { parseKeys } from '../lib/sealed';
import { dispatch } from './dispatch';
import { enqueuePostbacks, installSourceId } from './enqueue';
import type { SourceEvent } from './types';

const UA_MAX = 512;

/** Names the server reserves for its own events: an SDK `track()` with one of them never reaches an ad network. */
export const isReservedName = (name: string) => name === 'install' || name.startsWith('rc_');

/**
 * Ad-network events from one ingested SDK batch: the install (also when consent arrives later, so an install that
 * was skipped without consent is sent once consent is given) and custom events. `events` are the newly stored ones.
 */
export function sdkSourceEvents(iid: string, events: SdkEvent[], transient: SourceEvent['transient']): SourceEvent[] {
  const out: SourceEvent[] = [];
  let install = false;
  for (const e of events) {
    if (e.type === 'install') install = true;
    else if (e.type === 'consent' && e.props?.adConsent === true) install = true;
    else if (e.type === 'event' && e.name && !isReservedName(e.name)) {
      out.push({ id: e.id, installId: iid, name: e.name, ts: e.ts, transient });
    }
  }
  if (install) out.unshift({ id: installSourceId(iid), installId: iid, name: 'install', ts: null, transient });
  return out;
}

/** The request's IP and user agent, for networks that use them for matching. Kept sealed, only until sent. */
export function transientFrom(req: Request): SourceEvent['transient'] {
  const ip = req.headers.get('cf-connecting-ip');
  const ua = req.headers.get('user-agent');
  return ip && ua ? { ip, ua: ua.slice(0, UA_MAX) } : null;
}

/** Queue and immediately try to send. Runs in waitUntil: never throws, the cron retries what is left. */
export async function queueAndSend(env: Env, app: AppRow, events: SourceEvent[], now: number): Promise<void> {
  if (!events.length) return;
  try {
    const ids = await enqueuePostbacks(env.DB, parseKeys(env), app.id, events, now);
    if (ids.length) await dispatch(env, ids, { now });
  } catch (err) {
    console.error('ad-network postbacks failed', err instanceof Error ? err.name : 'unknown error');
  }
}
