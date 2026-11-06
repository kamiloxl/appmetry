import { type Context, Hono } from 'hono';
import { creditedSessionId, creditSql, installAttr, matchInstall, type MatchedBy, userIdMatchSql } from './credit';
import { type AppEnv, getAppById } from './env';
import { readCapped } from './ingest';
import { safeEqual, sha256Hex } from './lib/crypto';

/**
 * RevenueCat webhook (spec §5 "Payment matching", "Subscription lifecycle events", "Integration health").
 * RevenueCat retries anything but a 200 and delivers at least once, so every delivery is deduplicated on its id.
 */

/** A RevenueCat webhook event (body `{ api_version, event }`). Fields are untrusted and read defensively. */
export interface RcEvent {
  id: string;
  type: string;
  app_user_id?: unknown;
  original_app_user_id?: unknown;
  aliases?: unknown;
  subscriber_attributes?: unknown;
  product_id?: unknown;
  store?: unknown;
  /** 'SANDBOX' | 'PRODUCTION' */
  environment?: unknown;
  /** USD; 0 for trials, negative for refunds, may be null. */
  price?: unknown;
  period_type?: unknown;
  is_trial_conversion?: unknown;
  cancel_reason?: unknown;
  event_timestamp_ms?: unknown;
  purchased_at_ms?: unknown;
}

export interface RcHealth {
  lastEventAt: number | null;
  events24h: number;
  withInstallId24h: number;
  matched24h: number;
  warning: boolean;
}

const MAX_BODY_BYTES = 256 * 1024;
const APP_ID_RE = /^[\w-]{1,64}$/;
const ID_MAX = 255;
const TYPE_MAX = 64;
const TEXT_MAX = 255;
const DAY_MS = 86_400_000;
/** Below this share of 24 h production events carrying `appmetry_install_id`, the dashboard warns. */
const HEALTH_MIN_SHARE = 0.5;

const PAYMENT_TYPES = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE']);

const text = (v: unknown, max = TEXT_MAX): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const isRefund = (ev: RcEvent) => ev.type === 'CANCELLATION' && ev.cancel_reason === 'CUSTOMER_SUPPORT';

/** Our event name for a RevenueCat event type (spec §5 mapping table), or null for types that are only logged. */
export function lifecycleEventName(ev: RcEvent): string | null {
  switch (ev.type) {
    case 'INITIAL_PURCHASE':
      if (ev.period_type === 'TRIAL') return 'rc_trial_started';
      if (ev.period_type === 'INTRO') return 'rc_intro_started';
      return 'rc_subscription_started';
    case 'RENEWAL':
      return ev.is_trial_conversion === true ? 'rc_trial_converted' : 'rc_subscription_renewed';
    case 'NON_RENEWING_PURCHASE':
      return 'rc_in_app_purchase';
    case 'CANCELLATION':
      return isRefund(ev) ? 'rc_refunded' : 'rc_subscription_cancelled';
    case 'UNCANCELLATION':
      return 'rc_subscription_uncancelled';
    case 'BILLING_ISSUE':
      return 'rc_billing_issue';
    case 'EXPIRATION':
      return 'rc_subscription_expired';
    case 'PRODUCT_CHANGE':
      return 'rc_product_changed';
    default:
      return null;
  }
}

/** USD cents for an event: `price` × 100, null as 0, refunds always negative. */
function amountCents(ev: RcEvent): number {
  const cents = Math.round((num(ev.price) ?? 0) * 100);
  if (cents === 0) return 0;
  return isRefund(ev) ? -Math.abs(cents) : cents;
}

/** The payments row values for revenue-bearing events, or null. Trial starts are events, not revenue. */
function paymentFor(ev: RcEvent): { kind: 'payment' | 'refund'; amount: number; renewal: 0 | 1 } | null {
  const refund = isRefund(ev);
  if (!refund && !PAYMENT_TYPES.has(ev.type)) return null;
  if (ev.type === 'INITIAL_PURCHASE' && ev.period_type === 'TRIAL') return null;
  return { kind: refund ? 'refund' : 'payment', amount: amountCents(ev), renewal: ev.type === 'RENEWAL' ? 1 : 0 };
}

function lifecycleInsert(
  db: D1Database,
  appId: string,
  eventId: string,
  installId: string,
  ts: number,
  name: string,
  propsJson: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO events (app_id, id, session_id, install_id, ts, type, name, props)
       VALUES (?, ?, NULL, ?, ?, 'event', ?, ?)`,
    )
    .bind(appId, `rc_${eventId}`, installId, ts, name, propsJson);
}

/** POST /api/webhooks/revenuecat/:appId. Public to the session guard; authenticates with the webhook secret. */
export async function handleRevenueCat(c: Context<AppEnv>): Promise<Response> {
  const db = c.env.DB;

  // 1. Auth. The Authorization header is never logged.
  const appId = c.req.param('appId') ?? '';
  const app = APP_ID_RE.test(appId) ? await getAppById(db, appId) : null;
  const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!app || !app.rc_secret_hash || !token || !safeEqual(await sha256Hex(token), app.rc_secret_hash)) {
    return c.json({ error: 'invalid_webhook_secret' }, 401);
  }

  // 2. Body: ≤ 256 KB, JSON, with event.id and event.type. Never logged.
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return c.json({ error: 'payload_too_large' }, 413);
  const raw = await readCapped(c.req.raw, MAX_BODY_BYTES);
  if (raw === null) return c.json({ error: 'payload_too_large' }, 413);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const ev = body && typeof body === 'object' ? (body as { event?: unknown }).event : null;
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return c.json({ error: 'missing_event' }, 400);
  const { id, type } = ev as { id?: unknown; type?: unknown };
  if (typeof id !== 'string' || !id || id.length > ID_MAX || typeof type !== 'string' || !type || type.length > TYPE_MAX) {
    return c.json({ error: 'missing_event_id_or_type' }, 400);
  }
  const event = ev as RcEvent;

  const now = Date.now();
  const rcTs = num(event.event_timestamp_ms) ?? num(event.purchased_at_ms) ?? now;
  const environment = text(event.environment, 32) ?? 'PRODUCTION';
  // Only the install id is read from subscriber_attributes; email and the rest are never stored.
  const hasInstallAttr = installAttr(event) ? 1 : 0;

  // 3. Dedup. Answer a redelivery before doing any work for it.
  const seen = await db.prepare('SELECT 1 AS ok FROM rc_events WHERE id = ?').bind(id).first<number>('ok');
  if (seen) return c.json({ ok: true, duplicate: true });

  // 4. Match, credit and build the writes. TEST events (RevenueCat's "Send test event") are only logged.
  let installId: string | null = null;
  let matchedBy: MatchedBy = 'none';
  let appUserId: string | null = null;
  let lifecycleName: string | null = null;
  let lifecycleProps: string | null = null;
  const statements: D1PreparedStatement[] = [];
  if (type !== 'TEST') {
    ({ installId, matchedBy } = await matchInstall(db, app.id, event));
    appUserId = text(event.app_user_id);
    const productId = text(event.product_id);
    const store = text(event.store, 64);

    const pay = paymentFor(event);
    if (pay) {
      // A refund is dated when it happened; a purchase when it was bought.
      const evTs = num(event.event_timestamp_ms);
      const purchasedTs = num(event.purchased_at_ms);
      const ts = (pay.kind === 'refund' ? (evTs ?? purchasedTs) : (purchasedTs ?? evTs)) ?? now;
      const sessionId = installId ? await creditedSessionId(db, app.id, installId, ts) : null;
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO payments
               (id, app_id, ts, kind, amount, event_type, product_id, store, environment, app_user_id, install_id, session_id, matched_by, renewal)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(id, app.id, ts, pay.kind, pay.amount, type, productId, store, environment, appUserId, installId, sessionId, matchedBy, pay.renewal),
      );
    }

    // Name and props are kept on the rc_events row too, so a later rematch backfills exactly this event.
    lifecycleName = lifecycleEventName(event);
    if (lifecycleName) {
      // price_usd follows the stored amount, so payments and events agree.
      const props: Record<string, unknown> = { product_id: productId, store, price_usd: amountCents(event) / 100 };
      if (lifecycleName === 'rc_subscription_cancelled') props.reason = text(event.cancel_reason, 64);
      // Lets stats drop sandbox trials like sandbox payments (show_sandbox). Production props stay unchanged.
      if (environment === 'SANDBOX') props.sandbox = true;
      lifecycleProps = JSON.stringify(props);
      if (installId) statements.push(lifecycleInsert(db, app.id, id, installId, rcTs, lifecycleName, lifecycleProps));
    }
  }

  // 5. One atomic batch: if any write fails nothing is stored, so RevenueCat's retry is processed in full.
  //    INSERT OR IGNORE keeps a concurrent duplicate delivery from writing twice.
  const logRow = db
    .prepare(
      `INSERT OR IGNORE INTO rc_events
         (id, app_id, ts, type, environment, has_install_attr, install_id, app_user_id, lifecycle_name, lifecycle_props)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, app.id, rcTs, type, environment, hasInstallAttr, installId, appUserId, lifecycleName, lifecycleProps);
  let results: D1Result[];
  try {
    results = await db.batch([logRow, ...statements]);
  } catch (err) {
    // No body, header or bound value is logged.
    console.error('revenuecat webhook: database write failed', err instanceof Error ? err.name : 'unknown');
    return c.json({ error: 'internal error' }, 500);
  }
  if (results[0].meta.changes === 0) return c.json({ ok: true, duplicate: true });
  return c.json({ ok: true });
}

/** Integration health over the last 24 h of production deliveries. TEST events never count. */
export async function rcHealth(db: D1Database, appId: string, now: number): Promise<RcHealth> {
  const [counts, last] = await db.batch<{ events: number; with_attr: number | null; matched: number } | { last: number | null }>([
    db
      .prepare(
        `SELECT COUNT(*) AS events, SUM(has_install_attr) AS with_attr, COUNT(install_id) AS matched
         FROM rc_events WHERE app_id = ? AND ts >= ? AND environment = 'PRODUCTION' AND type != 'TEST'`,
      )
      .bind(appId, now - DAY_MS),
    db.prepare(`SELECT MAX(ts) AS last FROM rc_events WHERE app_id = ? AND type != 'TEST'`).bind(appId),
  ]);
  const row = counts.results[0] as { events: number; with_attr: number | null; matched: number };
  const events24h = row.events;
  const withInstallId24h = row.with_attr ?? 0;
  return {
    lastEventAt: (last.results[0] as { last: number | null }).last ?? null,
    events24h,
    withInstallId24h,
    matched24h: row.matched,
    warning: events24h > 0 && withInstallId24h / events24h < HEALTH_MIN_SHARE,
  };
}

/** Default and maximum number of rc_events one rematch call handles. */
const REMATCH_LIMIT = 20;
const REMATCH_MAX = 200;

/**
 * Unmatched rc_events of the app that steps 2–3 of matching can now link: a non-anonymous app_user_id that equals an
 * install's user_id or id, over `rc_events r`. Shared by the candidate query and the `remaining` count.
 * Binds: app id, sinceTs.
 */
const REMATCH_WHERE = `WHERE r.app_id = ? AND r.install_id IS NULL AND r.ts >= ? AND r.type != 'TEST'
    AND r.app_user_id IS NOT NULL AND r.app_user_id NOT LIKE '$RCAnonymousID:%'
    AND EXISTS (SELECT 1 FROM installs i WHERE i.app_id = r.app_id AND (i.user_id = r.app_user_id OR i.id = r.app_user_id))`;

export interface RematchResult {
  /** rc_events newly linked to an install in this call. */
  matched: number;
  /** Candidates still matchable after this call (call again to continue). */
  remaining: number;
}

/**
 * "Try matching again": links unmatched RevenueCat deliveries since `sinceTs` to installs that appeared later.
 * The attribute is not stored, so this uses the stored app_user_id (matching steps 2 and 3). Each match sets
 * rc_events.install_id, the payment's install, matched_by and credit (if the delivery was a payment), and inserts
 * the lifecycle event from the stored name and props. At most `limit` deliveries per call, in a fixed number of
 * queries: one read, one write batch, one count.
 */
export async function rematch(db: D1Database, appId: string, sinceTs: number, limit = REMATCH_LIMIT): Promise<RematchResult> {
  const take = Math.min(Math.max(1, Math.floor(limit)), REMATCH_MAX);
  const { results } = await db
    .prepare(
      `WITH c AS (
         SELECT r.id, r.ts, r.lifecycle_name, r.lifecycle_props, p.ts AS pay_ts,
           (${userIdMatchSql('r.app_id', 'r.app_user_id')}) AS by_user,
           (SELECT i.id FROM installs i WHERE i.app_id = r.app_id AND i.id = r.app_user_id) AS by_install
         FROM rc_events r LEFT JOIN payments p ON p.app_id = r.app_id AND p.id = r.id
         ${REMATCH_WHERE}
         ORDER BY r.ts, r.id LIMIT ?
       ), m AS (
         SELECT c.*, COALESCE(c.by_user, c.by_install) AS install_id,
           CASE WHEN c.by_user IS NOT NULL THEN 'user_id' ELSE 'install_id' END AS matched_by
         FROM c
       )
       SELECT m.id, m.ts, m.lifecycle_name, m.lifecycle_props, m.pay_ts, m.install_id, m.matched_by,
         CASE WHEN m.pay_ts IS NULL THEN NULL ELSE (${creditSql('?', 'm.install_id', 'm.pay_ts')}) END AS session_id
       FROM m WHERE m.install_id IS NOT NULL`,
    )
    .bind(appId, sinceTs, take, appId)
    .all<{
      id: string;
      ts: number;
      lifecycle_name: string | null;
      lifecycle_props: string | null;
      pay_ts: number | null;
      install_id: string;
      matched_by: MatchedBy;
      session_id: string | null;
    }>();

  const statements: D1PreparedStatement[] = [];
  const rcUpdates: number[] = [];
  for (const r of results) {
    rcUpdates.push(statements.length);
    statements.push(
      db.prepare('UPDATE rc_events SET install_id = ? WHERE app_id = ? AND id = ? AND install_id IS NULL').bind(r.install_id, appId, r.id),
    );
    if (r.pay_ts !== null) {
      statements.push(
        db
          .prepare('UPDATE payments SET install_id = ?, matched_by = ?, session_id = ? WHERE app_id = ? AND id = ? AND install_id IS NULL')
          .bind(r.install_id, r.matched_by, r.session_id, appId, r.id),
      );
    }
    if (r.lifecycle_name) {
      statements.push(lifecycleInsert(db, appId, r.id, r.install_id, r.ts, r.lifecycle_name, r.lifecycle_props ?? '{}'));
    }
  }

  let matched = 0;
  if (statements.length) {
    const res = await db.batch(statements);
    for (const i of rcUpdates) matched += res[i].meta.changes;
  }
  const remaining =
    (await db.prepare(`SELECT COUNT(*) AS n FROM rc_events r ${REMATCH_WHERE}`).bind(appId, sinceTs).first<number>('n')) ?? 0;
  return { matched, remaining };
}

// ---------- dashboard routes (login required by apiGuard)

export const revenuecatRoutes = new Hono<AppEnv>();

revenuecatRoutes.post('/api/apps/:id/payments/rematch', async (c) => {
  const app = await getAppById(c.env.DB, c.req.param('id'));
  if (!app) return c.json({ error: 'not found' }, 404);
  return c.json(await rematch(c.env.DB, app.id, 0));
});

revenuecatRoutes.get('/api/apps/:id/revenuecat/health', async (c) => {
  const app = await getAppById(c.env.DB, c.req.param('id'));
  if (!app) return c.json({ error: 'not found' }, 404);
  return c.json(await rcHealth(c.env.DB, app.id, Date.now()));
});
