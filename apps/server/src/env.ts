export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Dashboard login password, at least 12 characters (Cloudflare → Workers → appmetry → Settings → Variables). */
  ADMIN_PASSWORD: string;
  /** Optional key for signing the login cookie. When unset, a random key is generated once and kept in `meta`. */
  SESSION_SECRET?: string;
  /** Workers Rate Limiting binding for ingestion (120 requests / 60 s per key). */
  INGEST_LIMITER?: RateLimit;
  /** 32 random bytes, base64. Encrypts ad-network tokens and advertising ids (src/lib/sealed.ts). Unset = integrations off. */
  INTEGRATIONS_KEY?: string;
  /** The previous INTEGRATIONS_KEY during a key rotation, so older values still open. */
  INTEGRATIONS_KEY_PREVIOUS?: string;
}

export interface AppRow {
  id: string;
  name: string;
  app_key: string;
  ios_bundle_id: string | null;
  android_package: string | null;
  app_store_url: string | null;
  play_store_url: string | null;
  web_url: string | null;
  timezone: string;
  rc_secret_hash: string | null;
  retention_months: number;
  show_sandbox: number;
  /** JSON, spec §6a. */
  setup_state: string | null;
  created_at: number;
}

export type AppEnv = { Bindings: Env; Variables: { app: AppRow } };

const CACHE_MS = 60_000;
const byKey = new Map<string, { app: AppRow | null; at: number }>();
const byId = new Map<string, { app: AppRow | null; at: number }>();

async function cached(
  cache: Map<string, { app: AppRow | null; at: number }>,
  k: string,
  load: () => Promise<AppRow | null>,
): Promise<AppRow | null> {
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.app;
  const app = await load();
  cache.set(k, { app, at: Date.now() });
  return app;
}

/** Apps change rarely; cache them per isolate for 60 s so ingestion costs one fewer read per batch. */
export function getAppByKey(db: D1Database, key: string): Promise<AppRow | null> {
  return cached(byKey, key, () => db.prepare('SELECT * FROM apps WHERE app_key = ?').bind(key).first<AppRow>());
}

export function getAppById(db: D1Database, id: string): Promise<AppRow | null> {
  return cached(byId, id, () => db.prepare('SELECT * FROM apps WHERE id = ?').bind(id).first<AppRow>());
}

/** Drop an app from this isolate's cache after it changes. */
export function forgetApp(app: AppRow): void {
  byKey.delete(app.app_key);
  byId.delete(app.id);
}
