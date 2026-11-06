import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { sessionKey } from '../auth';
import { getAppById, type AppEnv, type Env } from '../env';
import { randomId, safeEqual, signToken, verifyToken } from '../lib/crypto';
import { open, parseKeys, seal } from '../lib/sealed';
import { META_GRAPH_VERSION } from './meta';
import { forgetIntegrations } from './store';

/**
 * Facebook Login for the Meta integration: the operator signs in once so the dashboard can list their datasets.
 * The Conversions API token stays a separate, pasted credential; this token only reads ad accounts and datasets.
 *
 * Needs META_APP_ID and META_APP_SECRET (a Meta app the operator owns). Without them the dashboard offers only
 * manual dataset entry. Both routes sit behind the login cookie (apiGuard): the callback is not public.
 *
 * CSRF / mix-up defence: `state` is signed with the session key, expires after 10 minutes, names the app and
 * integration, and carries a nonce that must match a short-lived httpOnly cookie set when the flow started.
 */
export const metaOAuthRoutes = new Hono<AppEnv>();

const GRAPH = 'https://graph.facebook.com';
const DIALOG = 'https://www.facebook.com';
export const META_OAUTH_SCOPES = 'ads_read,business_management';
const STATE_TTL_MS = 10 * 60_000;
const NONCE_COOKIE = 'meta_oauth_nonce';
const CALLBACK_PATH = '/api/integrations/meta/oauth/callback';
const FETCH_TIMEOUT_MS = 10_000;

export const oauthContext = (integrationId: string) => `integration:${integrationId}:oauth`;
export const oauthConfigured = (env: Env) => Boolean(env.META_APP_ID && env.META_APP_SECRET);

interface State {
  a: string; // app id
  i: string; // integration id
  n: string; // nonce
  e: number; // expires at
}

const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

async function signState(env: Env, st: State): Promise<string> {
  return signToken(await sessionKey(env), `meta-oauth.${b64url(JSON.stringify(st))}`);
}

async function readState(env: Env, token: string, now: number): Promise<State | null> {
  const value = await verifyToken(await sessionKey(env), token);
  if (!value?.startsWith('meta-oauth.')) return null;
  try {
    const st = JSON.parse(unb64url(value.slice('meta-oauth.'.length))) as State;
    if (typeof st.a !== 'string' || typeof st.i !== 'string' || typeof st.n !== 'string' || typeof st.e !== 'number') return null;
    return st.e > now ? st : null;
  } catch {
    return null;
  }
}

const redirectUri = (c: Context<AppEnv>) => `${new URL(c.req.url).origin}${CALLBACK_PATH}`;
const pagePath = (appId: string, result: string) => `/apps/${encodeURIComponent(appId)}/integrations/meta?oauth=${result}`;
const audit = (db: D1Database, appId: string, integrationId: string, action: string, now: number) =>
  db.prepare('INSERT INTO integration_audit (id, app_id, integration_id, action, ts) VALUES (?, ?, ?, ?, ?)').bind(randomId(12), appId, integrationId, action, now);

async function graphJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body };
}

// ---------- start

metaOAuthRoutes.get('/api/apps/:id/integrations/:iid/oauth/start', async (c) => {
  if (!oauthConfigured(c.env)) return c.json({ error: 'oauth_not_configured' }, 404);
  const app = await getAppById(c.env.DB, c.req.param('id'));
  if (!app) return c.json({ error: 'not found' }, 404);
  const row = await c.env.DB
    .prepare(`SELECT id FROM integrations WHERE id = ? AND app_id = ? AND provider = 'meta' AND status != 'disconnected'`)
    .bind(c.req.param('iid'), app.id)
    .first<{ id: string }>();
  if (!row) return c.json({ error: 'not found' }, 404);

  const nonce = randomId(16);
  const state = await signState(c.env, { a: app.id, i: row.id, n: nonce, e: Date.now() + STATE_TTL_MS });
  setCookie(c, NONCE_COOKIE, nonce, {
    httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Lax', path: CALLBACK_PATH, maxAge: STATE_TTL_MS / 1000,
  });
  const params = new URLSearchParams({
    client_id: c.env.META_APP_ID!, redirect_uri: redirectUri(c), state, scope: META_OAUTH_SCOPES, response_type: 'code',
  });
  return c.redirect(`${DIALOG}/${META_GRAPH_VERSION}/dialog/oauth?${params}`, 302);
});

// ---------- callback

metaOAuthRoutes.get(CALLBACK_PATH, async (c) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer'); // the URL carries the authorization code
  const now = Date.now();
  const st = await readState(c.env, c.req.query('state') ?? '', now);
  const cookieNonce = getCookie(c, NONCE_COOKIE) ?? '';
  deleteCookie(c, NONCE_COOKIE, { path: CALLBACK_PATH });
  // Without a valid state there is no trustworthy app to send the user back to.
  if (!st || !cookieNonce || !safeEqual(cookieNonce, st.n)) return c.json({ error: 'invalid_oauth_state' }, 400);
  if (!oauthConfigured(c.env)) return c.redirect(pagePath(st.a, 'not_configured'), 302);
  if (c.req.query('error')) return c.redirect(pagePath(st.a, 'denied'), 302);
  const code = c.req.query('code');
  if (!code) return c.redirect(pagePath(st.a, 'failed'), 302);

  const keys = parseKeys(c.env);
  if (!keys) return c.redirect(pagePath(st.a, 'key_missing'), 302);
  const db = c.env.DB;
  const row = await db
    .prepare(`SELECT id FROM integrations WHERE id = ? AND app_id = ? AND provider = 'meta' AND status != 'disconnected'`)
    .bind(st.i, st.a)
    .first<{ id: string }>();
  if (!row) return c.redirect(pagePath(st.a, 'failed'), 302);

  try {
    const base = { client_id: c.env.META_APP_ID!, client_secret: c.env.META_APP_SECRET! };
    const short = await graphJson(
      `${GRAPH}/${META_GRAPH_VERSION}/oauth/access_token?${new URLSearchParams({ ...base, redirect_uri: redirectUri(c), code })}`,
    );
    const shortToken = short.body?.access_token;
    if (short.status !== 200 || typeof shortToken !== 'string') return c.redirect(pagePath(st.a, 'failed'), 302);
    // Exchange for a long-lived token (about 60 days) so "Refresh datasets" keeps working.
    const long = await graphJson(
      `${GRAPH}/${META_GRAPH_VERSION}/oauth/access_token?${new URLSearchParams({ ...base, grant_type: 'fb_exchange_token', fb_exchange_token: shortToken })}`,
    );
    const token = typeof long.body?.access_token === 'string' ? long.body.access_token : shortToken;
    const expiresIn = Number((long.status === 200 ? long.body?.expires_in : short.body?.expires_in) ?? 0);
    const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null;
    await db.batch([
      db
        .prepare('UPDATE integrations SET oauth_token_enc = ?, oauth_expires_at = ?, updated_at = ? WHERE id = ? AND app_id = ?')
        .bind(await seal(keys, token, oauthContext(row.id)), expiresAt, now, row.id, st.a),
      audit(db, st.a, row.id, 'oauth_connect', now),
    ]);
    forgetIntegrations(st.a);
    return c.redirect(pagePath(st.a, 'connected'), 302);
  } catch (err) {
    console.error('meta oauth exchange failed', err instanceof Error ? err.name : 'unknown error');
    return c.redirect(pagePath(st.a, 'failed'), 302);
  }
});

// ---------- datasets ("Refresh datasets")

export interface MetaDataset {
  id: string;
  name: string;
  /** Where it was found: an ad account or business name. */
  owner: string | null;
}

type Edge<T> = { data?: T[] };
type Pixel = { id?: unknown; name?: unknown };

function collect(list: MetaDataset[], seen: Set<string>, pixels: Edge<Pixel> | undefined, owner: unknown) {
  for (const p of pixels?.data ?? []) {
    if (typeof p.id !== 'string' || !/^\d{5,25}$/.test(p.id) || seen.has(p.id)) continue;
    seen.add(p.id);
    list.push({ id: p.id, name: typeof p.name === 'string' ? p.name.slice(0, 100) : p.id, owner: typeof owner === 'string' ? owner.slice(0, 100) : null });
  }
}

metaOAuthRoutes.get('/api/apps/:id/integrations/:iid/datasets', async (c) => {
  const app = await getAppById(c.env.DB, c.req.param('id'));
  if (!app) return c.json({ error: 'not found' }, 404);
  const row = await c.env.DB
    .prepare(`SELECT id, oauth_token_enc FROM integrations WHERE id = ? AND app_id = ? AND provider = 'meta' AND status != 'disconnected'`)
    .bind(c.req.param('iid'), app.id)
    .first<{ id: string; oauth_token_enc: string | null }>();
  if (!row) return c.json({ error: 'not found' }, 404);
  if (!row.oauth_token_enc) return c.json({ error: 'oauth_not_connected' }, 409);
  let token: string;
  try {
    token = await open(parseKeys(c.env), row.oauth_token_enc, oauthContext(row.id));
  } catch {
    return c.json({ error: 'oauth_not_connected' }, 409);
  }

  // The token goes in the Authorization header, never in a URL that could be logged.
  const headers = { authorization: `Bearer ${token}` };
  const fields = (edge: string) => `${edge}{id,name}`;
  try {
    const [accounts, businesses] = await Promise.all([
      graphJson(`${GRAPH}/${META_GRAPH_VERSION}/me/adaccounts?fields=name,${fields('adspixels')}&limit=100`, { headers }),
      graphJson(`${GRAPH}/${META_GRAPH_VERSION}/me/businesses?fields=name,${fields('owned_pixels')}&limit=100`, { headers }),
    ]);
    const expired = [accounts, businesses].some((r) => (r.body?.error as { code?: unknown } | undefined)?.code === 190);
    if (expired) {
      await c.env.DB.prepare('UPDATE integrations SET oauth_token_enc = NULL, oauth_expires_at = NULL WHERE id = ?').bind(row.id).run();
      return c.json({ error: 'oauth_expired' }, 409);
    }
    if (accounts.status !== 200 && businesses.status !== 200) return c.json({ error: 'meta_unavailable' }, 502);

    const list: MetaDataset[] = [];
    const seen = new Set<string>();
    for (const acc of (accounts.body?.data as Array<{ name?: unknown; adspixels?: Edge<Pixel> }> | undefined) ?? []) collect(list, seen, acc.adspixels, acc.name);
    for (const biz of (businesses.body?.data as Array<{ name?: unknown; owned_pixels?: Edge<Pixel> }> | undefined) ?? []) collect(list, seen, biz.owned_pixels, biz.name);
    list.sort((x, y) => x.name.localeCompare(y.name));
    return c.json(list);
  } catch (err) {
    console.error('meta datasets failed', err instanceof Error ? err.name : 'unknown error');
    return c.json({ error: 'meta_unavailable' }, 502);
  }
});
