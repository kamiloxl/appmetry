import type { Context } from 'hono';
import {
  fromAdServices,
  fromInstallReferrer,
  stripPrivateParams,
  touchFromQuery,
  type AttributionResponse,
  type InstallAttribution,
  type LinkTouch,
  type SdkEvent,
} from '@appdash/shared';
import { exchangeAdServicesToken } from './adservices';
import { getAppByKey, type AppEnv, type AppRow } from './env';
import { ATTRIBUTION_COLUMNS, mergeIntoInstall, rowToAttribution, type InstallAttrRow, type OnInstall } from './ingest';

const DAY = 86_400_000;
const ID_RE = /^[\w-]{8,64}$/;
const APP_KEY_RE = /^app_[0-9a-z]{8,64}$/;

/** Referrer string without private params (`stripPrivateParams` only works after a `?`). */
export function cleanReferrer(raw: string): string {
  return stripPrivateParams('?' + raw).replace(/^\?/, '');
}

/** Install event props as stored: the AdServices token is dropped and the referrer is cleaned. */
export function sanitizeInstallProps(props: Record<string, unknown>): Record<string, unknown> {
  const { asaToken: _token, referrer, ...rest } = props;
  if (typeof referrer === 'string') {
    const clean = cleanReferrer(referrer);
    if (clean) return { ...rest, referrer: clean };
  }
  return rest;
}

/** Merge a candidate into the install; the stronger method wins (see `mergeIntoInstall`). */
export async function applyAttribution(
  db: D1Database, appId: string, installId: string, candidate: InstallAttribution | null,
): Promise<void> {
  if (!candidate) return;
  await mergeIntoInstall(db, appId, installId, [candidate]);
}

// ---------- Install Referrer

const orUndefined = (v: string | null) => (v ? v : undefined);

/** The link behind a click id, only when both rows belong to this app. Empty strings count as absent. */
async function linkForClick(db: D1Database, appId: string, clickId: string): Promise<LinkTouch | null> {
  const click = await db
    .prepare('SELECT link_id FROM link_clicks WHERE id = ? AND app_id = ?')
    .bind(clickId, appId)
    .first<{ link_id: string }>();
  if (!click) return null;
  const link = await db
    .prepare('SELECT utm_source, utm_medium, utm_campaign, utm_content, ref FROM links WHERE id = ? AND app_id = ?')
    .bind(click.link_id, appId)
    .first<Record<'utm_source' | 'utm_medium' | 'utm_campaign' | 'utm_content' | 'ref', string | null>>();
  if (!link) return null;
  return {
    click_id: clickId,
    utm_source: orUndefined(link.utm_source),
    utm_medium: orUndefined(link.utm_medium),
    utm_campaign: orUndefined(link.utm_campaign),
    utm_content: orUndefined(link.utm_content),
    ref: orUndefined(link.ref),
  };
}

async function applyReferrer(db: D1Database, appId: string, installId: string, referrer: string): Promise<void> {
  const clean = cleanReferrer(referrer);
  const clickId = touchFromQuery(clean).click_id;
  const link = clickId ? await linkForClick(db, appId, clickId) : null;
  if (link) {
    await db
      .prepare('UPDATE link_clicks SET install_id = ? WHERE id = ? AND app_id = ? AND install_id IS NULL')
      .bind(installId, link.click_id, appId)
      .run();
  }
  await applyAttribution(db, appId, installId, fromInstallReferrer(clean, link));
}

// ---------- Apple Search Ads

export interface AsaDeps {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Exchange an AdServices token and store the outcome. `ok` and `invalid` clear the pending fields; `retry` keeps the
 * token (the only place it is ever stored) until `pendingUntil`. Exported for the Task 12 cron that retries pending tokens.
 */
export async function resolveAsaToken(
  db: D1Database, appId: string, installId: string, token: string, pendingUntil: number, deps: AsaDeps = {},
): Promise<void> {
  const out = await exchangeAdServicesToken(token, deps.fetchFn, deps.sleep);
  if (out.status === 'retry') {
    await db
      .prepare('UPDATE installs SET asa_pending_token = ?, asa_pending_until = ? WHERE app_id = ? AND id = ?')
      .bind(token, pendingUntil, appId, installId)
      .run();
    return;
  }
  if (out.status === 'ok') await applyAttribution(db, appId, installId, fromAdServices(out.result));
  await db
    .prepare('UPDATE installs SET asa_pending_token = NULL, asa_pending_until = NULL WHERE app_id = ? AND id = ?')
    .bind(appId, installId)
    .run();
}

/**
 * Install hook. Runs for every install event, retries included, so it is idempotent: the referrer merge is guarded,
 * and the AdServices exchange is skipped once the install is attributed or while a live token is pending.
 */
export function makeOnInstall(
  db: D1Database, app: AppRow, waitUntil: (p: Promise<unknown>) => void, now: number, deps: AsaDeps = {},
): OnInstall {
  return async (installId, ev: SdkEvent) => {
    const props = ev.props ?? {};
    const inst = await db
      .prepare('SELECT platform, attribution_method, asa_pending_token, asa_pending_until FROM installs WHERE app_id = ? AND id = ?')
      .bind(app.id, installId)
      .first<{ platform: string; attribution_method: string | null; asa_pending_token: string | null; asa_pending_until: number | null }>();
    if (!inst) return;

    if (inst.platform === 'android' && typeof props.referrer === 'string' && props.referrer) {
      await applyReferrer(db, app.id, installId, props.referrer);
    }

    const token = props.asaToken;
    if (inst.platform !== 'ios' || typeof token !== 'string' || !token) return;
    if (inst.attribution_method === 'search_ads' || inst.attribution_method === 'install_referrer') return;
    if (inst.asa_pending_token && (inst.asa_pending_until ?? 0) > now) return;
    waitUntil(
      resolveAsaToken(db, app.id, installId, token, ev.ts + DAY, deps).catch((err) => {
        console.error('AdServices attribution failed', err instanceof Error ? err.message : 'unknown error');
      }),
    );
  };
}

// ---------- GET /api/v1/attribution

/** Public to apiGuard: authenticates with `X-App-Key`, like the batch route. */
export async function handleAttribution(c: Context<AppEnv>): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  const appKey = c.req.header('x-app-key') ?? '';
  const app = APP_KEY_RE.test(appKey) ? await getAppByKey(c.env.DB, appKey) : null;
  if (!app) return c.json({ error: 'unknown_app_key' }, 401);

  if (c.env.INGEST_LIMITER) {
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const { success } = await c.env.INGEST_LIMITER.limit({ key: `${appKey}:${ip}` });
    if (!success) return c.json({ error: 'rate_limited' }, 429);
  }

  const iid = c.req.query('iid') ?? '';
  if (!ID_RE.test(iid)) return c.json({ error: 'invalid_iid' }, 400);

  const row = await c.env.DB
    .prepare(`SELECT attribution_method, asa_pending_token, ${ATTRIBUTION_COLUMNS.join(', ')} FROM installs WHERE app_id = ? AND id = ?`)
    .bind(app.id, iid)
    .first<InstallAttrRow & { asa_pending_token: string | null }>();
  if (!row) return c.json({ error: 'not_found' }, 404);

  const a = rowToAttribution(row);
  const body: AttributionResponse = {
    resolved: row.asa_pending_token === null,
    method: a.method,
    source: a.source,
    channel: a.channel,
    utm_campaign: a.utm_campaign,
    utm_content: a.utm_content,
    utm_term: a.utm_term,
    asa_campaign_id: a.asa_campaign_id,
    asa_adgroup_id: a.asa_adgroup_id,
    asa_keyword_id: a.asa_keyword_id,
  };
  return c.json(body);
}
