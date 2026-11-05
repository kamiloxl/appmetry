import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv, Env } from './env';
import { hmacHex, signToken, verifyToken } from './lib/crypto';

/** Self-hosted, single owner: one password (ADMIN_PASSWORD) opens the dashboard. */

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_LOGIN_FAILURES = 10;
export const LOCKOUT_MS = 15 * 60_000;
export const AUTH_COOKIE = 'ad_auth';
const AUTH_DAYS = 30;
const SUBJECT = 'admin';

export const PASSWORD_MISSING_HINT =
  'Set ADMIN_PASSWORD (at least 12 characters) in Cloudflare → Workers → appmetry → Settings → Variables. For local development, copy .dev.vars.example to .dev.vars.';
export const PASSWORD_WEAK_HINT =
  'Set a stronger ADMIN_PASSWORD (at least 12 characters) in Cloudflare → Workers → appmetry → Settings → Variables';

let cachedKey: Promise<string> | null = null;

async function loadOrCreateKey(db: D1Database): Promise<string> {
  const read = () => db.prepare("SELECT value FROM meta WHERE key = 'session_key'").first<string>('value');
  const existing = await read();
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const key = btoa(String.fromCharCode(...bytes));
  // Two first requests may race: OR IGNORE keeps whichever key landed first, and both re-read it.
  await db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('session_key', ?)").bind(key).run();
  const stored = await read();
  if (!stored) throw new Error('session key could not be stored');
  return stored;
}

/**
 * Key that signs the login cookie: the SESSION_SECRET binding when set, otherwise a 32-byte random key
 * generated once and stored in D1 `meta`. Never a hard-coded fallback. Cached per isolate.
 */
export async function sessionKey(env: Env): Promise<string> {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (!cachedKey) {
    cachedKey = loadOrCreateKey(env.DB);
    cachedKey.catch(() => (cachedKey = null));
  }
  return cachedKey;
}

/** Forget the cached key, as a fresh isolate would. For tests. */
export function forgetSessionKey(): void {
  cachedKey = null;
}

function cookieOptions(c: Context<AppEnv>) {
  return {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax' as const,
    path: '/',
  };
}

export async function setSession(c: Context<AppEnv>): Promise<void> {
  const expires = Date.now() + AUTH_DAYS * 86_400_000;
  const token = await signToken(await sessionKey(c.env), `${SUBJECT}.${expires}`);
  setCookie(c, AUTH_COOKIE, token, { ...cookieOptions(c), maxAge: AUTH_DAYS * 86_400 });
}

export function clearSession(c: Context<AppEnv>): void {
  deleteCookie(c, AUTH_COOKIE, cookieOptions(c));
}

export async function isLoggedIn(c: Context<AppEnv>): Promise<boolean> {
  const token = getCookie(c, AUTH_COOKIE);
  if (!token) return false;
  const value = await verifyToken(await sessionKey(c.env), token);
  if (!value) return false;
  const [subject, expires] = value.split('.');
  return subject === SUBJECT && Number(expires) > Date.now();
}

/** 401 JSON unless the request carries a valid login cookie. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await isLoggedIn(c))) return c.json({ error: 'unauthorized' }, 401);
  await next();
};

// ---------- default-deny for /api/*

/**
 * The only /api routes reachable without a session. Everything else under /api/ requires login.
 * Later tasks add public routes here, never by skipping the guard.
 */
export const PUBLIC_API_ROUTES: readonly string[] = ['POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/auth/me'];
/** Path prefixes that are public for every method (incl. CORS preflight): SDK ingest/attribution and webhooks. */
export const PUBLIC_API_PREFIXES: readonly string[] = ['/api/v1/', '/api/webhooks/'];

export function isPublicApi(method: string, path: string): boolean {
  return PUBLIC_API_ROUTES.includes(`${method.toUpperCase()} ${path}`) || PUBLIC_API_PREFIXES.some((p) => path.startsWith(p));
}

/** Mounted on /api/*: requires a session unless the route is on the public allowlist. */
export const apiGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (isPublicApi(c.req.method, c.req.path)) return next();
  return requireAuth(c, next);
};

// ---------- login failures (per-IP lockout without storing IPs)

/** Keyed hash of the client IP, so the lockout works without storing the address (spec §7). */
export async function ipHash(env: Env, ip: string): Promise<string> {
  return hmacHex(await sessionKey(env), ip);
}

/** Delete failures that no longer count towards a lockout. Called on each failure and by the daily cron. */
export async function purgeLoginFailures(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare('DELETE FROM login_failures WHERE ts < ?').bind(now - LOCKOUT_MS).run();
}
