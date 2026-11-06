import type { Env } from '../env';
import { open, parseKeys, type SealKeys } from '../lib/sealed';
import { madidContext, MAX_EVENT_AGE_MS, transientContext } from './enqueue';
import { getAdapter } from './registry';
import { forgetIntegrations } from './store';
import type { Classified, IntegrationConfig, OutboxEvent, PostbackInstall } from './types';

const DAY = 86_400_000;
/** Wait before attempt n+1 (index = attempts so far, capped at the last value). */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000] as const;
export const MAX_ATTEMPTS = 8;
/** A claimed row is invisible to other dispatchers for this long, so waitUntil and the cron never send it twice. */
const LEASE_MS = 120_000;
const FETCH_TIMEOUT_MS = 10_000;
const ERROR_MAX = 300;
/** Delivered, failed and skipped rows are kept this long for the delivery log. */
export const OUTBOX_KEEP_MS = 30 * DAY;
const PURGE_CHUNK = 500;

/** The sealing context of an integration's network credential. */
export const tokenContext = (integrationId: string) => `integration:${integrationId}:token`;

export interface DispatchDeps {
  fetchFn?: typeof fetch;
  now?: number;
}

export interface DispatchSummary {
  sent: number;
  retry: number;
  failed: number;
}

type Row = {
  id: string;
  app_id: string;
  integration_id: string;
  source_event_id: string;
  install_id: string | null;
  target_event: string;
  event_ts: number;
  value_cents: number | null;
  currency: string | null;
  transient_enc: string | null;
  attempts: number;
  provider: string | null;
  integration_status: string | null;
  config: string | null;
  token_enc: string | null;
  madid_enc: string | null;
  ios_bundle_id: string | null;
  android_package: string | null;
} & { [K in `i_${keyof PostbackInstall}`]: unknown };

const INSTALL_FIELDS = [
  'id', 'platform', 'first_seen', 'ad_consent', 'att_status', 'device_extinfo', 'os_version', 'app_version', 'device_model',
  'locale', 'source', 'channel', 'utm_source', 'campaign_id', 'adset_id', 'ad_id', 'fbclid', 'campaign_ids', 'user_id', 'email',
] as const satisfies ReadonlyArray<keyof PostbackInstall>;

/** Never let a credential reach the database or logs: drop token-looking query values and the token itself. */
export function redact(message: string, token?: string): string {
  let s = message.replace(/(access_token|token|key)=[^&\s"']+/gi, '$1=[redacted]');
  if (token) s = s.split(token).join('[redacted]');
  return s.slice(0, ERROR_MAX);
}

async function openOrNull(keys: SealKeys | null, value: string | null, context: string): Promise<string | null> {
  if (!value || !keys) return null;
  try {
    return await open(keys, value, context);
  } catch {
    return null;
  }
}

function parseConfig(json: string | null): IntegrationConfig {
  try {
    const v = JSON.parse(json ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

async function toEvent(row: Row, keys: SealKeys | null): Promise<OutboxEvent> {
  let install: PostbackInstall | null = null;
  if (row.i_id) {
    install = Object.fromEntries(INSTALL_FIELDS.map((f) => [f, row[`i_${f}`] ?? null])) as unknown as PostbackInstall;
  }
  const transientJson = await openOrNull(keys, row.transient_enc, transientContext(row.id));
  let transient: OutboxEvent['transient'] = null;
  if (transientJson) {
    try {
      const t = JSON.parse(transientJson);
      if (typeof t?.ip === 'string' && typeof t?.ua === 'string') transient = { ip: t.ip, ua: t.ua };
    } catch {
      // unreadable: send without it
    }
  }
  return {
    id: row.id,
    sourceEventId: row.source_event_id,
    targetEvent: row.target_event,
    eventTs: row.event_ts,
    valueCents: row.value_cents,
    currency: row.currency,
    install,
    bundleId: install?.platform === 'android' ? row.android_package : install?.platform === 'ios' ? row.ios_bundle_id : null,
    madid: row.install_id ? await openOrNull(keys, row.madid_enc, madidContext(row.app_id, row.install_id)) : null,
    transient,
  };
}

/** One request to a network, with the host allowlist, timeout and redaction. Also used by the test-event route. */
export async function send(
  adapterProvider: string,
  integrationId: string,
  config: IntegrationConfig,
  token: string,
  events: OutboxEvent[],
  fetchFn: typeof fetch,
): Promise<Classified> {
  const adapter = getAdapter(adapterProvider)!;
  let req: { url: string; init: RequestInit };
  try {
    req = await adapter.buildRequest({ integrationId, config, token }, events);
  } catch (err) {
    return { outcome: 'fatal', error: redact(`build failed: ${err instanceof Error ? err.message : 'unknown'}`, token) };
  }
  let host: string;
  try {
    host = new URL(req.url).hostname;
  } catch {
    return { outcome: 'fatal', error: 'invalid request url' };
  }
  if (!adapter.allowedHosts.includes(host)) return { outcome: 'fatal', error: `host not allowed: ${host}` };

  let res: Response;
  try {
    res = await fetchFn(req.url, { ...req.init, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { outcome: 'retry', error: redact(`network error: ${err instanceof Error ? err.name : 'unknown'}`, token) };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: classify by status alone
  }
  const c = adapter.classify(res.status, body);
  return c.error ? { ...c, error: redact(c.error, token) } : c;
}

/**
 * Send queued postbacks. Rows are claimed first (a lease on next_attempt_at), so concurrent dispatchers never send
 * the same row. Events of one integration go out in batches of the adapter's size. Outcomes: sent; retry with backoff
 * (failed after MAX_ATTEMPTS); fatal. A credential failure also marks the integration as `error`.
 * Query cost: one claim, one read, one write batch, plus one request per integration batch.
 */
export async function dispatch(env: Env, ids: string[], deps: DispatchDeps = {}): Promise<DispatchSummary> {
  const summary: DispatchSummary = { sent: 0, retry: 0, failed: 0 };
  if (!ids.length) return summary;
  const db = env.DB;
  const now = deps.now ?? Date.now();
  const fetchFn = deps.fetchFn ?? ((input, init) => fetch(input, init));
  const keys = parseKeys(env);

  const claimed = await db
    .prepare(
      `UPDATE postback_outbox SET next_attempt_at = ?
       WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND id IN (SELECT value FROM json_each(?))
       RETURNING id`,
    )
    .bind(now + LEASE_MS, now, JSON.stringify(ids))
    .all<{ id: string }>();
  if (!claimed.results.length) return summary;

  const { results: rows } = await db
    .prepare(
      `SELECT o.id, o.app_id, o.integration_id, o.source_event_id, o.install_id, o.target_event, o.event_ts, o.value_cents, o.currency,
              o.transient_enc, o.attempts,
              g.provider, g.status AS integration_status, g.config, g.capi_token_enc AS token_enc,
              n.madid_enc, ${INSTALL_FIELDS.map((f) => `n.${f} AS i_${f}`).join(', ')},
              a.ios_bundle_id, a.android_package
       FROM postback_outbox o
       LEFT JOIN apps a ON a.id = o.app_id
       LEFT JOIN integrations g ON g.id = o.integration_id AND g.app_id = o.app_id
       LEFT JOIN installs n ON n.app_id = o.app_id AND n.id = o.install_id
       WHERE o.id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(claimed.results.map((r) => r.id)))
    .all<Row>();

  const outcomes: Array<{ id: string; c: Classified }> = [];
  const brokenIntegrations = new Set<string>();
  const byIntegration = new Map<string, Row[]>();
  for (const r of rows) {
    const list = byIntegration.get(r.integration_id);
    if (list) list.push(r);
    else byIntegration.set(r.integration_id, [r]);
  }

  for (const [integrationId, list] of byIntegration) {
    const first = list[0];
    const all = (c: Classified) => list.forEach((r) => outcomes.push({ id: r.id, c }));
    const adapter = first.provider ? getAdapter(first.provider) : null;
    if (!first.provider || first.integration_status === 'disconnected') {
      all({ outcome: 'fatal', error: 'integration removed or disconnected' });
      continue;
    }
    if (!adapter) {
      all({ outcome: 'fatal', error: `no adapter for ${first.provider}` });
      continue;
    }
    if (first.integration_status !== 'active') {
      all({ outcome: 'retry', error: 'integration is not active' });
      continue;
    }
    if (!keys) {
      all({ outcome: 'retry', error: 'INTEGRATIONS_KEY is not set' });
      continue;
    }
    const token = await openOrNull(keys, first.token_enc, tokenContext(integrationId));
    if (!token) {
      all({ outcome: 'retry', error: 'credential missing or unreadable' });
      brokenIntegrations.add(integrationId);
      continue;
    }
    const config = parseConfig(first.config);
    const events = await Promise.all(list.map((r) => toEvent(r, keys)));
    for (let i = 0; i < events.length; i += adapter.maxBatch) {
      const chunk = events.slice(i, i + adapter.maxBatch);
      const c = await send(first.provider, integrationId, config, token, chunk, fetchFn);
      if (c.integrationError) brokenIntegrations.add(integrationId);
      for (const e of chunk) outcomes.push({ id: e.id, c });
    }
  }

  const stmts: D1PreparedStatement[] = [];
  const sentIds = outcomes.filter((o) => o.c.outcome === 'sent').map((o) => o.id);
  if (sentIds.length) {
    stmts.push(
      db
        .prepare(
          `UPDATE postback_outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, last_error = NULL, transient_enc = NULL,
             next_attempt_at = NULL
           WHERE id IN (SELECT value FROM json_each(?))`,
        )
        .bind(now, JSON.stringify(sentIds)),
    );
  }
  const attemptsOf = new Map(rows.map((r) => [r.id, r.attempts]));
  for (const { id, c } of outcomes) {
    if (c.outcome === 'sent') continue;
    const attempts = (attemptsOf.get(id) ?? 0) + 1;
    const fail = c.outcome === 'fatal' || attempts >= MAX_ATTEMPTS;
    if (fail) summary.failed += 1;
    else summary.retry += 1;
    stmts.push(
      db
        .prepare(
          `UPDATE postback_outbox SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?,
             transient_enc = CASE WHEN ? THEN NULL ELSE transient_enc END
           WHERE id = ?`,
        )
        .bind(
          fail ? 'failed' : 'pending',
          attempts,
          c.error ?? null,
          fail ? null : now + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)],
          fail ? 1 : 0,
          id,
        ),
    );
  }
  for (const integrationId of brokenIntegrations) {
    stmts.push(
      db.prepare(`UPDATE integrations SET status = 'error', updated_at = ? WHERE id = ? AND status = 'active'`).bind(now, integrationId),
    );
  }
  if (stmts.length) await db.batch(stmts);
  for (const r of rows) if (brokenIntegrations.has(r.integration_id)) forgetIntegrations(r.app_id);
  summary.sent = sentIds.length;
  return summary;
}

/**
 * Cron: expire rows the networks would reject, purge old log rows, then send what is due (oldest first).
 * `limit` caps the rows per run so the invocation stays within the query budget.
 */
export async function dispatchDue(env: Env, now: number, limit: number, deps: Omit<DispatchDeps, 'now'> = {}): Promise<DispatchSummary> {
  const db = env.DB;
  await db.batch([
    db
      .prepare(
        `UPDATE postback_outbox SET status = 'failed', last_error = 'expired before delivery', transient_enc = NULL, next_attempt_at = NULL
         WHERE status = 'pending' AND event_ts < ?`,
      )
      .bind(now - MAX_EVENT_AGE_MS),
    db
      .prepare(
        `DELETE FROM postback_outbox WHERE rowid IN (
           SELECT rowid FROM postback_outbox WHERE status != 'pending' AND created_at < ? LIMIT ${PURGE_CHUNK})`,
      )
      .bind(now - OUTBOX_KEEP_MS),
  ]);
  const { results } = await db
    .prepare(`SELECT id FROM postback_outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`)
    .bind(now, limit)
    .all<{ id: string }>();
  return dispatch(env, results.map((r) => r.id), { ...deps, now });
}
