import type { Context } from 'hono';
import {
  classify,
  extractTouch,
  fromReported,
  fromTouch,
  LIMITS,
  mergeAttribution,
  organic,
  stripPrivateParams,
  validateBatch,
  type AttributionMethod,
  type Batch,
  type InstallAttribution,
  type SdkEvent,
} from '@appdash/shared';
import { sanitizeInstallProps, makeOnInstall } from './attribution';
import { getAppByKey, type AppEnv, type AppRow } from './env';

/** City-level location from `request.cf`. Nothing else about the request is stored (spec §7). */
export interface Geo {
  country: string | null;
  region: string | null;
  city: string | null;
}

/**
 * Called for every valid `install` event in a batch, new or already stored, after the batch is committed.
 * Retries therefore re-run it: implementations must be idempotent.
 */
export type OnInstall = (installId: string, ev: SdkEvent) => Promise<void>;

const noopOnInstall: OnInstall = async () => {};

const DAY = 86_400_000;
/** Events outside `[now − 7 days, now + 60 s]` are dropped (global constraints). */
export const MAX_PAST_MS = 7 * DAY;
export const MAX_FUTURE_MS = 60_000;
/** One ping reports at most 10 minutes of foreground time. */
export const MAX_PING_MS = 600_000;
/** Cap for identify values (userId, email, name). */
export const MAX_IDENTITY_CHARS = 200;

/** Loose shape check so obviously bogus keys never reach the database or the app cache. */
const APP_KEY_RE = /^app_[0-9a-z]{8,64}$/;

// ---------- HTTP

type Failure = { status: 400 | 401 | 403 | 413 | 429; error: string };

/** Read the body as text, giving up as soon as it passes `max` bytes (chunked bodies have no content-length). */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function geoFrom(req: Request): Geo {
  const cf = (req as Request & { cf?: Record<string, unknown> }).cf;
  const pick = (k: string) => {
    const v = cf?.[k];
    return typeof v === 'string' && v ? v.slice(0, 100) : null;
  };
  return { country: pick('country'), region: pick('region'), city: pick('city') };
}

/** `context.bundleId` must match the app's bundle id / package for that platform, when one is set. */
function bundleMatches(app: AppRow, batch: Batch): boolean {
  const { platform, bundleId } = batch.context;
  if (platform === 'ios' && app.ios_bundle_id) return bundleId === app.ios_bundle_id;
  if (platform === 'android' && app.android_package) return bundleId === app.android_package;
  return true;
}

/**
 * POST /api/v1/batch. Public route (the SDK has no session): authenticates with the `X-App-Key` header.
 * Order: 413 size → 400 JSON → 401 key → 429 rate limit → 400 schema → 403 bundle id → 202.
 */
export async function handleBatch(c: Context<AppEnv>): Promise<Response> {
  const fail = (f: Failure) => c.json({ error: f.error }, f.status);

  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > LIMITS.maxBodyBytes) return fail({ status: 413, error: 'payload_too_large' });
  const text = await readCapped(c.req.raw, LIMITS.maxBodyBytes);
  if (text === null) return fail({ status: 413, error: 'payload_too_large' });

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return fail({ status: 400, error: 'invalid_json' });
  }

  const appKey = c.req.header('x-app-key') ?? '';
  const app = APP_KEY_RE.test(appKey) ? await getAppByKey(c.env.DB, appKey) : null;
  if (!app) return fail({ status: 401, error: 'unknown_app_key' });

  // Without the binding (e.g. a local dev setup that lacks it) ingestion is not rate-limited.
  // The IP is only part of the limiter key; it is never stored.
  if (c.env.INGEST_LIMITER) {
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const { success } = await c.env.INGEST_LIMITER.limit({ key: `${appKey}:${ip}` });
    if (!success) return fail({ status: 429, error: 'rate_limited' });
  }

  const v = validateBatch(body);
  if (!v.ok) return fail({ status: 400, error: v.error });
  if (!bundleMatches(app, v.batch)) return fail({ status: 403, error: 'bundle_id_mismatch' });

  const now = Date.now();
  const onInstall = makeOnInstall(c.env.DB, app, c.executionCtx.waitUntil.bind(c.executionCtx), now);
  const result = await ingestBatch(c.env.DB, app, v.batch, geoFrom(c.req.raw), now, onInstall);
  return c.json({ inserted: result.inserted, dropped: result.dropped + v.dropped }, 202);
}

// ---------- ingestion

function cleanIdentity(v: unknown, lower = false): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim().slice(0, MAX_IDENTITY_CHARS);
  if (!s) return null;
  return lower ? s.toLowerCase() : s;
}

const orNull = (s: string) => (s ? s : null);

/** Stored form of an event. Deep links lose private params; identity values live on the install only. */
function storedEvent(e: SdkEvent): { name: string | null; props: string | null } {
  if (e.type === 'identify') return { name: null, props: null };
  const name = e.name === undefined ? null : e.type === 'deep_link' ? stripPrivateParams(e.name) : e.name;
  if (e.type === 'install' && e.props) {
    // The AdServices token is a credential: it never reaches `events.props`. The referrer loses private params.
    const props = sanitizeInstallProps(e.props);
    return { name, props: Object.keys(props).length ? JSON.stringify(props) : null };
  }
  return { name, props: e.props ? JSON.stringify(e.props) : null };
}

export const ATTRIBUTION_COLUMNS = [
  'source', 'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'click_id',
  'asa_campaign_id', 'asa_adgroup_id', 'asa_keyword_id',
] as const;

function attributionValues(a: InstallAttribution): Array<string | number | null> {
  // The asa_* columns are TEXT: bind ids as strings, or D1 stores them as REAL ("22.0").
  return [a.method, ...ATTRIBUTION_COLUMNS.map((k) => (k.startsWith('asa_') && a[k] !== null ? String(a[k]) : a[k]))];
}

export type InstallAttrRow = Record<(typeof ATTRIBUTION_COLUMNS)[number], string | null> & { attribution_method: string | null };

export function rowToAttribution(row: InstallAttrRow): InstallAttribution {
  const num = (v: string | null) => (v === null || v === '' ? null : Number(v));
  return {
    method: (row.attribution_method ?? 'organic') as AttributionMethod,
    source: row.source ?? '',
    channel: (row.channel ?? 'Organic') as InstallAttribution['channel'],
    utm_source: row.utm_source,
    utm_medium: row.utm_medium,
    utm_campaign: row.utm_campaign,
    utm_term: row.utm_term,
    utm_content: row.utm_content,
    ref: row.ref,
    click_id: row.click_id,
    asa_campaign_id: num(row.asa_campaign_id),
    asa_adgroup_id: num(row.asa_adgroup_id),
    asa_keyword_id: num(row.asa_keyword_id),
  };
}

/**
 * Session aggregates are recomputed from the stored events, so a retried or overlapping batch can never double-count.
 * One pass over the session's events for the counters and bounds, plus two indexed lookups for entry/exit screens
 * (`events_session_type_ts`). Nameless screens never blank entry/exit.
 */
const RECOMPUTE_SESSION = `
UPDATE sessions SET
  (started_at, last_seen_at, screens, events, duration) = (
    SELECT MIN(sessions.started_at,   COALESCE(MIN(e.ts), sessions.started_at)),
           MAX(sessions.last_seen_at, COALESCE(MAX(e.ts), sessions.last_seen_at)),
           COALESCE(SUM(e.type = 'screen'), 0),
           COALESCE(SUM(e.type = 'event'), 0),
           COALESCE(SUM(CASE WHEN e.type = 'ping'
             THEN MIN(MAX(COALESCE(CAST(json_extract(e.props, '$.ms') AS INTEGER), 0), 0), ${MAX_PING_MS}) ELSE 0 END), 0)
    FROM events e WHERE e.app_id = ?1 AND e.session_id = ?2),
  entry_screen = (SELECT name FROM events WHERE app_id = ?1 AND session_id = ?2 AND type = 'screen' AND name IS NOT NULL
                  ORDER BY ts ASC, id ASC LIMIT 1),
  exit_screen  = (SELECT name FROM events WHERE app_id = ?1 AND session_id = ?2 AND type = 'screen' AND name IS NOT NULL
                  ORDER BY ts DESC, id DESC LIMIT 1)
WHERE app_id = ?1 AND id = ?2`;

type LinkTouch = { e: SdkEvent; touch: NonNullable<ReturnType<typeof extractTouch>> };

/** Deep links in `events` (ts order) that carry a touch, read from the cleaned URL. */
function deepLinkTouches(events: SdkEvent[]): LinkTouch[] {
  const out: LinkTouch[] = [];
  for (const e of events) {
    if (e.type !== 'deep_link' || !e.name) continue;
    const touch = extractTouch(stripPrivateParams(e.name));
    if (touch) out.push({ e, touch });
  }
  return out;
}

/**
 * Write one validated batch. Idempotent: events already stored (same `(app_id, id)`) are skipped, and session
 * aggregates are derived from stored events, so retries and out-of-order batches converge on the same rows.
 */
export async function ingestBatch(
  db: D1Database,
  app: AppRow,
  batch: Batch,
  geo: Geo,
  now: number,
  onInstall: OnInstall = noopOnInstall,
): Promise<{ inserted: number; dropped: number }> {
  const ctx = batch.context;
  const iid = ctx.iid;

  // 1. Sort by ts, clamp, and drop duplicate ids within the batch.
  let dropped = 0;
  const inBatch = new Set<string>();
  const events: SdkEvent[] = [];
  for (const e of [...batch.events].sort((a, b) => a.ts - b.ts)) {
    if (e.ts < now - MAX_PAST_MS || e.ts > now + MAX_FUTURE_MS) {
      dropped += 1;
      continue;
    }
    if (inBatch.has(e.id)) continue;
    inBatch.add(e.id);
    events.push(e);
  }
  if (!events.length) return { inserted: 0, dropped };

  // 2. Skip events we already have: this is what makes a retried batch safe.
  const existing = await db
    .prepare(`SELECT id FROM events WHERE app_id = ? AND id IN (${events.map(() => '?').join(', ')})`)
    .bind(app.id, ...events.map((e) => e.id))
    .all<{ id: string }>();
  const known = new Set(existing.results.map((r) => r.id));
  const fresh = events.filter((e) => !known.has(e.id));
  if (!fresh.length) {
    // Everything is stored already, but a previous attempt may have died before the attribution follow-up.
    await runOnInstall(onInstall, iid, events);
    await upgradeAttribution(db, app.id, iid, events);
    return { inserted: 0, dropped };
  }

  const firstTs = fresh[0].ts;
  const lastTs = fresh[fresh.length - 1].ts;
  const stmts: D1PreparedStatement[] = [];

  // 3. Install: attribution starts organic on insert only; later batches refresh last_seen and device context.
  const org = organic(ctx.platform);
  stmts.push(
    db
      .prepare(
        `INSERT INTO installs (app_id, id, platform, first_seen, last_seen, app_version, os_version, device_model, locale,
           country, region, city, attribution_method, ${ATTRIBUTION_COLUMNS.join(', ')})
         VALUES (${Array(25).fill('?').join(', ')})
         ON CONFLICT (app_id, id) DO UPDATE SET
           first_seen = MIN(first_seen, excluded.first_seen),
           last_seen = MAX(last_seen, excluded.last_seen),
           app_version = excluded.app_version,
           os_version = excluded.os_version,
           device_model = excluded.device_model,
           locale = excluded.locale`,
      )
      .bind(
        app.id, iid, ctx.platform, firstTs, lastTs,
        orNull(ctx.appVersion), orNull(ctx.osVersion), orNull(ctx.deviceModel), orNull(ctx.locale),
        geo.country, geo.region, geo.city,
        ...attributionValues(org),
      ),
  );

  // 4a. Sessions: created by whichever event arrives first (not only session_start).
  const bySession = new Map<string, SdkEvent[]>();
  for (const e of fresh) {
    const list = bySession.get(e.sid);
    if (list) list.push(e);
    else bySession.set(e.sid, [e]);
  }
  for (const [sid, list] of bySession) {
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO sessions (app_id, id, install_id, started_at, last_seen_at, app_version, os_version, platform,
             country, region, city, source, channel)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Direct', 'Direct')`,
        )
        .bind(
          app.id, sid, iid, list[0].ts, list[list.length - 1].ts,
          orNull(ctx.appVersion), orNull(ctx.osVersion), ctx.platform, geo.country, geo.region, geo.city,
        ),
    );
  }

  // 5. Events. INSERT OR IGNORE also covers two copies of a batch racing past step 2.
  const eventStmtAt = new Map<string, number>();
  for (const e of fresh) {
    const { name, props } = storedEvent(e);
    eventStmtAt.set(e.id, stmts.length);
    stmts.push(
      db
        .prepare('INSERT OR IGNORE INTO events (app_id, id, session_id, install_id, ts, type, name, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(app.id, e.id, e.sid, iid, e.ts, e.type, name, props),
    );
  }

  // 4b. Session source from its first deep link with a touch (only while still Direct), then aggregates.
  for (const [sid, list] of bySession) {
    const first = deepLinkTouches(list)[0];
    if (first) {
      const { source, channel } = classify({ utmSource: first.touch.utm_source, utmMedium: first.touch.utm_medium, ref: first.touch.ref });
      if (channel !== 'Direct') {
        stmts.push(
          db
            .prepare(
              `UPDATE sessions SET source = ?, channel = ?, utm_source = ?, utm_medium = ?, utm_campaign = ?, ref = ?
               WHERE app_id = ? AND id = ? AND source = 'Direct'`,
            )
            .bind(
              source, channel,
              first.touch.utm_source ?? null, first.touch.utm_medium ?? null, first.touch.utm_campaign ?? null, first.touch.ref ?? null,
              app.id, sid,
            ),
        );
      }
    }
    stmts.push(db.prepare(RECOMPUTE_SESSION).bind(app.id, sid));
  }

  // identify: COALESCE so a missing field never erases a stored value. Applied in ts order.
  for (const e of fresh) {
    if (e.type !== 'identify') continue;
    const p = e.props ?? {};
    const userId = cleanIdentity(p.userId);
    const email = cleanIdentity(p.email, true);
    const name = cleanIdentity(p.name);
    if (userId === null && email === null && name === null) continue;
    stmts.push(
      db
        .prepare('UPDATE installs SET user_id = COALESCE(?, user_id), email = COALESCE(?, email), name = COALESCE(?, name) WHERE app_id = ? AND id = ?')
        .bind(userId, email, name, app.id, iid),
    );
  }

  // 6. One transaction for the whole batch.
  const results = await db.batch(stmts);
  const inserted = fresh.filter((e) => (results[eventStmtAt.get(e.id)!].meta.changes ?? 0) > 0);

  // 7a. Install hook, for every install event in the batch (retries included; the hook is idempotent).
  await runOnInstall(onInstall, iid, events);

  // 7b. Attribution upgrades from every valid event in the batch, not only new ones: if a previous attempt
  // committed and then died, its retry still applies the upgrade. mergeAttribution makes this idempotent.
  await upgradeAttribution(db, app.id, iid, events);

  return { inserted: inserted.length, dropped };
}

async function runOnInstall(onInstall: OnInstall, iid: string, events: SdkEvent[]): Promise<void> {
  for (const e of events) {
    if (e.type !== 'install') continue;
    try {
      await onInstall(iid, e);
    } catch (err) {
      // The events are committed; a retry runs the hook again, so failing the request would not help.
      console.error('onInstall failed', err instanceof Error ? err.message : 'unknown error');
    }
  }
}

/** Apply a reported source, or a deep link in the install's earliest session, when it beats the current method. */
async function upgradeAttribution(db: D1Database, appId: string, iid: string, events: SdkEvent[]): Promise<void> {
  const sources = events.filter((e) => e.type === 'source' && e.name && e.name.trim());
  const links = deepLinkTouches(events);
  if (!sources.length && !links.length) return;

  const candidates: Array<{ ts: number; a: InstallAttribution }> = sources.map((e) => ({ ts: e.ts, a: fromReported(e.name!) }));
  if (links.length) {
    const earliest = await db
      .prepare('SELECT id FROM sessions WHERE app_id = ? AND install_id = ? ORDER BY started_at ASC, id ASC LIMIT 1')
      .bind(appId, iid)
      .first<string>('id');
    for (const { e, touch } of links) {
      if (e.sid === earliest) candidates.push({ ts: e.ts, a: fromTouch(touch, 'deep_link') });
    }
  }
  candidates.sort((x, y) => x.ts - y.ts);
  await mergeIntoInstall(db, appId, iid, candidates.map((c) => c.a));
}

/**
 * Merge candidates (in order) into the install's stored attribution; a stronger method wins (mergeAttribution).
 * The write is guarded on the method that was read, so a concurrent stronger attribution (e.g. AdServices) is never
 * overwritten; on a lost race the row is re-read and merged again.
 */
export async function mergeIntoInstall(
  db: D1Database, appId: string, iid: string, candidates: Array<InstallAttribution | null>,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db
      .prepare(`SELECT attribution_method, ${ATTRIBUTION_COLUMNS.join(', ')} FROM installs WHERE app_id = ? AND id = ?`)
      .bind(appId, iid)
      .first<InstallAttrRow>();
    if (!row) return;
    const current = rowToAttribution(row);
    let merged = current;
    for (const a of candidates) merged = mergeAttribution(merged, a);
    if (merged.method === current.method) return;

    const res = await db
      .prepare(
        `UPDATE installs SET attribution_method = ?, ${ATTRIBUTION_COLUMNS.map((k) => `${k} = ?`).join(', ')}
         WHERE app_id = ? AND id = ? AND attribution_method IS ?`,
      )
      .bind(...attributionValues(merged), appId, iid, row.attribution_method)
      .run();
    if ((res.meta.changes ?? 0) > 0) return;
  }
}
