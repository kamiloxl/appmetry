import { type Context, Hono } from 'hono';
import { creditedSessionId, installAttr, matchInstall, type MatchedBy } from './credit';
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
/** Below this share of 24 h production events carrying `appdash_install_id`, the dashboard warns. */
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

/** The payments row values for revenue-bearing events, or null. Trial starts are events, not revenue. */
function paymentFor(ev: RcEvent): { kind: 'payment' | 'refund'; amount: number; renewal: 0 | 1 } | null {
  const refund = isRefund(ev);
  if (!refund && !PAYMENT_TYPES.has(ev.type)) return null;
  if (ev.type === 'INITIAL_PURCHASE' && ev.period_type === 'TRIAL') return null;
  const cents = Math.round((num(ev.price) ?? 0) * 100);
  if (refund) return { kind: 'refund', amount: cents === 0 ? 0 : -Math.abs(cents), renewal: 0 };
  return { kind: 'payment', amount: cents, renewal: ev.type === 'RENEWAL' ? 1 : 0 };
}

function lifecycleInsert(
  db: D1Database,
  appId: string,
  eventId: string,
  installId: string,
  ts: number,
  name: string,
  props: Record<string, unknown>,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO events (app_id, id, session_id, install_id, ts, type, name, props)
       VALUES (?, ?, NULL, ?, ?, 'event', ?, ?)`,
    )
    .bind(appId, `rc_${eventId}`, installId, ts, name, JSON.stringify(props));
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
  const statements: D1PreparedStatement[] = [];
  if (type !== 'TEST') {
    ({ installId, matchedBy } = await matchInstall(db, app.id, event));
    const price = num(event.price);
    const productId = text(event.product_id);
    const store = text(event.store, 64);

    const pay = paymentFor(event);
    if (pay) {
      const ts = num(event.purchased_at_ms) ?? num(event.event_timestamp_ms) ?? now;
      const sessionId = installId ? await creditedSessionId(db, app.id, installId, ts) : null;
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO payments
               (id, app_id, ts, kind, amount, event_type, product_id, store, environment, app_user_id, install_id, session_id, matched_by, renewal)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(id, app.id, ts, pay.kind, pay.amount, type, productId, store, environment, text(event.app_user_id), installId, sessionId, matchedBy, pay.renewal),
      );
    }

    const name = lifecycleEventName(event);
    if (name && installId) {
      const props: Record<string, unknown> = { product_id: productId, store, price_usd: price };
      if (name === 'rc_subscription_cancelled') props.reason = text(event.cancel_reason, 64);
      statements.push(lifecycleInsert(db, app.id, id, installId, rcTs, name, props));
    }
  }

  // 5. One atomic batch: if any write fails nothing is stored, so RevenueCat's retry is processed in full.
  //    INSERT OR IGNORE keeps a concurrent duplicate delivery from writing twice.
  const logRow = db
    .prepare('INSERT OR IGNORE INTO rc_events (id, app_id, ts, type, environment, has_install_attr, install_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, app.id, rcTs, type, environment, hasInstallAttr, installId);
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

/** Matched payments per D1 batch while rematching (up to three statements each). */
const REMATCH_CHUNK = 25;

/**
 * Re-run matching for unmatched payments since `sinceTs` ("Try matching again"). The attribute is not stored, so
 * this uses the stored app_user_id (steps 2 and 3). A newly matched payment gets its install, credit and
 * lifecycle event, and its rc_events row its install. Returns how many payments were newly matched.
 */
export async function rematch(db: D1Database, appId: string, sinceTs: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.ts, p.kind, p.amount, p.event_type, p.product_id, p.store, p.app_user_id, r.ts AS rc_ts
       FROM payments p LEFT JOIN rc_events r ON r.app_id = p.app_id AND r.id = p.id
       WHERE p.app_id = ? AND p.install_id IS NULL AND p.ts >= ? AND p.app_user_id IS NOT NULL
       ORDER BY p.ts, p.id`,
    )
    .bind(appId, sinceTs)
    .all<{
      id: string;
      ts: number;
      kind: string;
      amount: number;
      event_type: string | null;
      product_id: string | null;
      store: string | null;
      app_user_id: string;
      rc_ts: number | null;
    }>();

  // One group per matched payment; its first statement is the payments UPDATE.
  const groups: D1PreparedStatement[][] = [];
  for (const p of results) {
    const { installId, matchedBy } = await matchInstall(db, appId, { id: p.id, type: p.event_type ?? '', app_user_id: p.app_user_id });
    if (!installId) continue;
    const sessionId = await creditedSessionId(db, appId, installId, p.ts);
    const group = [
      db
        .prepare('UPDATE payments SET install_id = ?, matched_by = ?, session_id = ? WHERE app_id = ? AND id = ? AND install_id IS NULL')
        .bind(installId, matchedBy, sessionId, appId, p.id),
      db.prepare('UPDATE rc_events SET install_id = ? WHERE app_id = ? AND id = ? AND install_id IS NULL').bind(installId, appId, p.id),
    ];
    // Rebuild the lifecycle name from what the payment row keeps (period type and trial conversion are not stored).
    const name = lifecycleEventName({ id: p.id, type: p.event_type ?? '', cancel_reason: p.kind === 'refund' ? 'CUSTOMER_SUPPORT' : null });
    if (name) {
      const props = { product_id: p.product_id, store: p.store, price_usd: p.amount / 100 };
      group.push(lifecycleInsert(db, appId, p.id, installId, p.rc_ts ?? p.ts, name, props));
    }
    groups.push(group);
  }

  let matched = 0;
  for (let i = 0; i < groups.length; i += REMATCH_CHUNK) {
    const chunk = groups.slice(i, i + REMATCH_CHUNK);
    const res = await db.batch(chunk.flat());
    let at = 0;
    for (const group of chunk) {
      matched += res[at].meta.changes;
      at += group.length;
    }
  }
  return matched;
}

// ---------- dashboard routes (login required by apiGuard)

export const revenuecatRoutes = new Hono<AppEnv>();

revenuecatRoutes.post('/api/apps/:id/payments/rematch', async (c) => {
  const app = await getAppById(c.env.DB, c.req.param('id'));
  if (!app) return c.json({ error: 'not found' }, 404);
  return c.json({ matched: await rematch(c.env.DB, app.id, 0) });
});

revenuecatRoutes.get('/api/apps/:id/revenuecat/health', async (c) => {
  const app = await getAppById(c.env.DB, c.req.param('id'));
  if (!app) return c.json({ error: 'not found' }, 404);
  return c.json(await rcHealth(c.env.DB, app.id, Date.now()));
});
