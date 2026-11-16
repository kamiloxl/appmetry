import { randomId } from '../lib/crypto';
import { seal, type SealKeys } from '../lib/sealed';
import { getAdapter } from './registry';
import { activeIntegrations } from './store';
import type { PostbackInstall, SourceEvent } from './types';

const DAY = 86_400_000;
/** Ad networks reject events older than this (Meta: 7 days). */
export const MAX_EVENT_AGE_MS = 7 * DAY;

export const INSTALL_COLUMNS = [
  'id', 'platform', 'first_seen', 'ad_consent', 'att_status', 'device_extinfo', 'os_version', 'app_version', 'device_model',
  'locale', 'source', 'channel', 'utm_source', 'campaign_id', 'adset_id', 'ad_id', 'fbclid', 'campaign_ids', 'user_id', 'email',
] as const;

/** The sealing context for an install's advertising id: the value only opens for this app and install. */
export const madidContext = (appId: string, iid: string) => `install:${appId}:${iid}:madid`;

/** Sealing context of an outbox row's IP / user agent. */
export const transientContext = (outboxId: string) => `outbox:${outboxId}:transient`;

/** The stable dedup id of an install's install event: the same however often (or late) it is queued. */
export const installSourceId = (installId: string) => `install_${installId}`;

/**
 * IP and user agent are kept only where the network may use them: Android with consent, or iOS with ATT authorized.
 * With ATT denied, iOS events are sent without device identifiers (Meta AEM).
 */
const mayKeepTransient = (i: PostbackInstall) => i.platform === 'android' || i.att_status === 'authorized';

/**
 * Queue app events for every active integration that maps them. An event is queued only when:
 * the install gave ad consent; the integration maps the event name; the event is under 7 days old; a sandbox
 * purchase only while the integration has a test event code; and with send_scope 'attributed', the network
 * brought the install. Idempotent: the outbox is unique on (integration, source event, target event).
 *
 * Returns the ids of newly queued rows, for an immediate dispatch. Costs one query for the integrations (cached),
 * one for the installs and one batch, and nothing at all when the app has no active integration.
 */
export async function enqueuePostbacks(
  db: D1Database,
  keys: SealKeys | null,
  appId: string,
  events: SourceEvent[],
  now: number,
): Promise<string[]> {
  if (!events.length) return [];
  const integrations = await activeIntegrations(db, appId);
  const wanted = integrations.filter((it) => events.some((e) => it.mappings.has(e.name)));
  if (!wanted.length) return [];

  const installIds = [...new Set(events.map((e) => e.installId))];
  const { results } = await db
    .prepare(`SELECT ${INSTALL_COLUMNS.join(', ')} FROM installs WHERE app_id = ? AND id IN (SELECT value FROM json_each(?))`)
    .bind(appId, JSON.stringify(installIds))
    .all<PostbackInstall>();
  const installs = new Map(results.map((r) => [r.id, r]));

  const stmts: D1PreparedStatement[] = [];
  const ids: string[] = [];
  for (const it of wanted) {
    const adapter = getAdapter(it.provider);
    if (!adapter) continue;
    for (const e of events) {
      const mapping = it.mappings.get(e.name);
      const install = installs.get(e.installId);
      if (!mapping || !install || install.ad_consent !== 1) continue;
      const ts = e.ts ?? install.first_seen;
      if (now - ts > MAX_EVENT_AGE_MS) continue;
      if (e.sandbox && !it.config.test_event_code) continue;
      if (it.send_scope === 'attributed' && !adapter.isAttributedTo(install)) continue;

      const id = randomId(12);
      const transient = e.transient && keys && mayKeepTransient(install) ? await seal(keys, JSON.stringify(e.transient), transientContext(id)) : null;
      const value = mapping.send_value && typeof e.valueCents === 'number' && e.valueCents > 0 ? e.valueCents : null;
      ids.push(id);
      stmts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO postback_outbox
               (id, app_id, integration_id, source_event_id, install_id, target_event, event_ts, value_cents, currency, transient_enc,
                status, attempts, next_attempt_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
          )
          .bind(id, appId, it.id, e.id, e.installId, mapping.target_event, ts, value, value === null ? null : (e.currency ?? 'USD'), transient, now, now),
      );
    }
  }
  if (!stmts.length) return [];
  const res = await db.batch(stmts);
  return ids.filter((_, i) => (res[i].meta.changes ?? 0) > 0);
}
