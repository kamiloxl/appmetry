import { Hono } from 'hono';
import { type AppEnv, type AppRow, forgetApp, getAppById } from './env';
import { randomId, sha256Hex } from './lib/crypto';

/** Dashboard CRUD for tracked apps. Mounted under /api/apps; the session guard in auth.ts already protects it. */
export const appsRoutes = new Hono<AppEnv>();

const URL_MAX = 500;
const ID_MAX = 255;
const NAME_MAX = 100;

/** Tables holding an `app_id` column. Deleted with the app. */
const CHILD_TABLES = ['installs', 'sessions', 'events', 'links', 'link_clicks', 'payments', 'rc_events'] as const;

type Parsed = { ok: true; value: string | number | null } | { ok: false; error: string };
const bad = (error: string): Parsed => ({ ok: false, error });
const good = (value: string | number | null): Parsed => ({ ok: true, value });

function parseName(v: unknown): Parsed {
  if (typeof v !== 'string') return bad('name must be a string');
  const name = v.trim();
  if (!name || name.length > NAME_MAX) return bad(`name must be 1-${NAME_MAX} characters`);
  return good(name);
}

function parseText(field: string) {
  return (v: unknown): Parsed => {
    if (v === null) return good(null);
    if (typeof v !== 'string') return bad(`${field} must be a string or null`);
    const s = v.trim();
    if (s.length > ID_MAX) return bad(`${field} must be at most ${ID_MAX} characters`);
    return good(s || null);
  };
}

function parseUrl(field: string) {
  return (v: unknown): Parsed => {
    if (v === null) return good(null);
    if (typeof v !== 'string') return bad(`${field} must be a string or null`);
    const s = v.trim();
    if (!s) return good(null);
    if (s.length > URL_MAX) return bad(`${field} must be at most ${URL_MAX} characters`);
    try {
      if (new URL(s).protocol !== 'https:') return bad(`${field} must be an https URL`);
    } catch {
      return bad(`${field} must be an https URL`);
    }
    return good(s);
  };
}

function parseTimezone(v: unknown): Parsed {
  if (typeof v !== 'string' || !v.trim()) return bad('timezone must be an IANA time zone');
  const tz = v.trim();
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    return bad('timezone must be an IANA time zone');
  }
  return good(tz);
}

function parseRetention(v: unknown): Parsed {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 120) {
    return bad('retention_months must be a whole number from 1 to 120');
  }
  return good(v);
}

function parseSandbox(v: unknown): Parsed {
  if (v === true || v === 1) return good(1);
  if (v === false || v === 0) return good(0);
  return bad('show_sandbox must be 0, 1 or a boolean');
}

const PATCHABLE: Record<string, (v: unknown) => Parsed> = {
  name: parseName,
  ios_bundle_id: parseText('ios_bundle_id'),
  android_package: parseText('android_package'),
  app_store_url: parseUrl('app_store_url'),
  play_store_url: parseUrl('play_store_url'),
  web_url: parseUrl('web_url'),
  timezone: parseTimezone,
  retention_months: parseRetention,
  show_sandbox: parseSandbox,
};

/** The row as the dashboard sees it: the secret hash never leaves the server. */
function publicApp(row: AppRow) {
  const { rc_secret_hash, ...rest } = row;
  return { ...rest, has_rc_secret: rc_secret_hash !== null };
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

appsRoutes.get('/api/apps', async (c) => {
  const rows = await c.env.DB.prepare('SELECT * FROM apps ORDER BY created_at, id').all<AppRow>();
  return c.json(rows.results.map(publicApp));
});

appsRoutes.post('/api/apps', async (c) => {
  const body = await readBody(c.req.raw);
  const name = parseName(body?.name);
  if (!name.ok) return c.json({ error: name.error }, 400);
  const row: AppRow = {
    id: randomId(12),
    name: name.value as string,
    app_key: `app_${randomId(16)}`,
    ios_bundle_id: null,
    android_package: null,
    app_store_url: null,
    play_store_url: null,
    web_url: null,
    timezone: 'UTC',
    rc_secret_hash: null,
    retention_months: 25,
    show_sandbox: 0,
    setup_state: null,
    created_at: Date.now(),
  };
  await c.env.DB.prepare(
    'INSERT INTO apps (id, name, app_key, timezone, retention_months, show_sandbox, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(row.id, row.name, row.app_key, row.timezone, row.retention_months, row.show_sandbox, row.created_at)
    .run();
  // Drop any cached "not found" for the new id/key.
  forgetApp(row);
  return c.json(publicApp(row), 201);
});

appsRoutes.patch('/api/apps/:id', async (c) => {
  const existing = await c.env.DB.prepare('SELECT * FROM apps WHERE id = ?').bind(c.req.param('id')).first<AppRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await readBody(c.req.raw);
  if (!body) return c.json({ error: 'expected a JSON object' }, 400);

  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [field, parse] of Object.entries(PATCHABLE)) {
    if (!(field in body)) continue;
    const r = parse(body[field]);
    if (!r.ok) return c.json({ error: r.error }, 400);
    sets.push(`${field} = ?`);
    values.push(r.value);
  }
  if (sets.length) {
    await c.env.DB.prepare(`UPDATE apps SET ${sets.join(', ')} WHERE id = ?`).bind(...values, existing.id).run();
  }
  forgetApp(existing);
  const updated = await getAppById(c.env.DB, existing.id);
  if (!updated) return c.json({ error: 'not found' }, 404);
  return c.json(publicApp(updated));
});

appsRoutes.post('/api/apps/:id/rc-secret', async (c) => {
  const existing = await c.env.DB.prepare('SELECT * FROM apps WHERE id = ?').bind(c.req.param('id')).first<AppRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  // Shown once. Only the hash is stored.
  const secret = `rcw_${randomId(24)}`;
  await c.env.DB.prepare('UPDATE apps SET rc_secret_hash = ? WHERE id = ?')
    .bind(await sha256Hex(secret), existing.id)
    .run();
  forgetApp(existing);
  return c.json({ secret });
});

appsRoutes.delete('/api/apps/:id', async (c) => {
  const existing = await c.env.DB.prepare('SELECT * FROM apps WHERE id = ?').bind(c.req.param('id')).first<AppRow>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  await c.env.DB.batch([
    ...CHILD_TABLES.map((t) => c.env.DB.prepare(`DELETE FROM ${t} WHERE app_id = ?`).bind(existing.id)),
    c.env.DB.prepare('DELETE FROM apps WHERE id = ?').bind(existing.id),
  ]);
  forgetApp(existing);
  return c.json({ ok: true });
});
