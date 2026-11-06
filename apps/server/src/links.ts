import { Hono } from 'hono';
import { stripPrivateParams, touchFromQuery, type Touch } from '@appmetry/shared';
import { type AppEnv, type AppRow, getAppById } from './env';
import { randomId } from './lib/crypto';
import { platformFromUA } from './lib/ua';

/** Tracked links. `/l/:slug` is public; the CRUD under /api/apps/:id/links is protected by the session guard in auth.ts. */
export const linksRoutes = new Hono<AppEnv>();

const SLUG_RE = /^[a-z0-9-]{2,48}$/;
const NAME_MAX = 100;
const UTM_SOURCE_MAX = 100;
const OPTIONAL_MAX = 200;

type Link = {
  id: string;
  app_id: string;
  slug: string;
  name: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  ref: string | null;
  created_at: number;
};

type Parsed = { ok: true; value: string | null } | { ok: false; error: string };
const bad = (error: string): Parsed => ({ ok: false, error });

function required(field: string, max: number) {
  return (v: unknown): Parsed => {
    if (typeof v !== 'string') return bad(`${field} must be a string`);
    const s = v.trim();
    if (!s || s.length > max) return bad(`${field} must be 1-${max} characters`);
    return { ok: true, value: s };
  };
}

/** Optional text: blank or null is stored as NULL, so an empty string never overrides a referrer value later. */
function optional(field: string) {
  return (v: unknown): Parsed => {
    if (v === null || v === undefined) return { ok: true, value: null };
    if (typeof v !== 'string') return bad(`${field} must be a string or null`);
    const s = v.trim();
    if (s.length > OPTIONAL_MAX) return bad(`${field} must be at most ${OPTIONAL_MAX} characters`);
    return { ok: true, value: s || null };
  };
}

function parseSlug(v: unknown): Parsed {
  if (typeof v !== 'string') return bad('slug must be a string');
  const s = v.trim().toLowerCase();
  if (!SLUG_RE.test(s)) return bad('slug must be 2-48 characters: a-z, 0-9 and -');
  return { ok: true, value: s };
}

const FIELDS: Record<string, (v: unknown) => Parsed> = {
  name: required('name', NAME_MAX),
  utm_source: required('utm_source', UTM_SOURCE_MAX),
  utm_medium: optional('utm_medium'),
  utm_campaign: optional('utm_campaign'),
  utm_content: optional('utm_content'),
  ref: optional('ref'),
};

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(`${err.message} ${(err.cause as Error | undefined)?.message ?? ''}`);
}

// ---------- public redirect

/** Store URL for the visitor's platform, falling back to the next best URL the app has. */
function pickTarget(app: AppRow, platform: 'ios' | 'android' | 'other'): string | null {
  if (platform === 'ios') return app.app_store_url ?? app.web_url;
  if (platform === 'android') return app.play_store_url ?? app.web_url;
  return app.web_url ?? app.app_store_url ?? app.play_store_url;
}

/** Values a click's query string may set: UTM overrides and ad-network campaign parameters (spec §3). */
const CLICK_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'campaign_id', 'adset_id', 'ad_id', 'placement', 'fbclid', 'campaign_ids',
] as const;
type ClickParams = Partial<Record<(typeof CLICK_PARAMS)[number], string>>;

/** Click-level values from the request URL. Private params are dropped; UTM values are capped like link fields. */
function clickParams(url: string): ClickParams {
  const q = stripPrivateParams(url).split('?')[1] ?? '';
  const t: Touch = touchFromQuery(q);
  const out: ClickParams = {};
  for (const k of CLICK_PARAMS) {
    const v = t[k];
    if (v) out[k] = k.startsWith('utm_') ? v.slice(0, OPTIONAL_MAX) : v;
  }
  return out;
}

/** The Play Install Referrer value: URL-encoded once as a whole, appended to the store URL. Click values beat link values. */
function withReferrer(playUrl: string, clickId: string, link: Link, click: ClickParams): string {
  const params = new URLSearchParams({ click_id: clickId });
  const set = (k: string, v: string | null | undefined) => {
    if (v) params.set(k, v);
  };
  set('utm_source', click.utm_source ?? link.utm_source);
  set('utm_medium', click.utm_medium ?? link.utm_medium);
  set('utm_campaign', click.utm_campaign ?? link.utm_campaign);
  set('utm_term', click.utm_term);
  set('utm_content', click.utm_content ?? link.utm_content);
  set('ref', link.ref);
  for (const k of ['campaign_id', 'adset_id', 'ad_id', 'placement', 'fbclid', 'campaign_ids'] as const) set(k, click[k]);
  return `${playUrl}${playUrl.includes('?') ? '&' : '?'}referrer=${encodeURIComponent(params.toString())}`;
}

const plain = (body: string) => new Response(body, { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

linksRoutes.get('/l/:slug', async (c) => {
  const link = await c.env.DB.prepare('SELECT * FROM links WHERE slug = ?').bind(c.req.param('slug').toLowerCase()).first<Link>();
  if (!link) return plain('Not found');
  const app = await getAppById(c.env.DB, link.app_id);
  if (!app) return plain('Not found');

  const platform = platformFromUA(c.req.header('user-agent') ?? '');
  let target = pickTarget(app, platform);
  if (!target) return plain('Link not available');

  const clickId = `c_${randomId(10)}`;
  const params = clickParams(c.req.url);
  if (platform === 'android' && target === app.play_store_url) target = withReferrer(target, clickId, link, params);

  // Kept: platform, country and the campaign parameters from the link's query string. No IP, user agent or referrer.
  const country = (c.req.raw.cf?.country as string | undefined) ?? null;
  c.executionCtx.waitUntil(
    c.env.DB.prepare(
      `INSERT INTO link_clicks (id, link_id, app_id, ts, platform, country, ${CLICK_PARAMS.join(', ')})
       VALUES (${Array(6 + CLICK_PARAMS.length).fill('?').join(', ')})`,
    )
      .bind(clickId, link.id, app.id, Date.now(), platform, country, ...CLICK_PARAMS.map((k) => params[k] ?? null))
      .run()
      .catch((err) => console.error('link click insert failed', err)),
  );

  return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
});

// ---------- dashboard CRUD

linksRoutes.get('/api/apps/:id/links', async (c) => {
  const app = await getAppById(c.env.DB, c.req.param('id'));
  if (!app) return c.json({ error: 'not found' }, 404);
  const rows = await c.env.DB.prepare('SELECT * FROM links WHERE app_id = ? ORDER BY created_at DESC, id').bind(app.id).all<Link>();
  return c.json(rows.results);
});

linksRoutes.post('/api/apps/:id/links', async (c) => {
  const app = await getAppById(c.env.DB, c.req.param('id'));
  if (!app) return c.json({ error: 'not found' }, 404);
  const body = await readBody(c.req.raw);
  if (!body) return c.json({ error: 'expected a JSON object' }, 400);

  const values: Record<string, string | null> = {};
  for (const [field, parse] of Object.entries(FIELDS)) {
    const r = parse(body[field]);
    if (!r.ok) return c.json({ error: r.error }, 400);
    values[field] = r.value;
  }
  let slug = randomId(4);
  if (body.slug !== undefined && body.slug !== null) {
    const r = parseSlug(body.slug);
    if (!r.ok) return c.json({ error: r.error }, 400);
    slug = r.value as string;
  }

  const link: Link = {
    id: randomId(8),
    app_id: app.id,
    slug,
    name: values.name,
    utm_source: values.utm_source,
    utm_medium: values.utm_medium,
    utm_campaign: values.utm_campaign,
    utm_content: values.utm_content,
    ref: values.ref,
    created_at: Date.now(),
  };
  try {
    await c.env.DB.prepare(
      'INSERT INTO links (id, app_id, slug, name, utm_source, utm_medium, utm_campaign, utm_content, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(link.id, link.app_id, link.slug, link.name, link.utm_source, link.utm_medium, link.utm_campaign, link.utm_content, link.ref, link.created_at)
      .run();
  } catch (err) {
    if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409);
    throw err;
  }
  return c.json(link, 201);
});

linksRoutes.patch('/api/apps/:id/links/:linkId', async (c) => {
  const app = await getAppById(c.env.DB, c.req.param('id'));
  if (!app) return c.json({ error: 'not found' }, 404);
  const existing = await c.env.DB.prepare('SELECT * FROM links WHERE id = ? AND app_id = ?').bind(c.req.param('linkId'), app.id).first<Link>();
  if (!existing) return c.json({ error: 'not found' }, 404);
  const body = await readBody(c.req.raw);
  if (!body) return c.json({ error: 'expected a JSON object' }, 400);

  const sets: string[] = [];
  const values: Array<string | null> = [];
  for (const [field, parse] of [...Object.entries(FIELDS), ['slug', parseSlug] as const]) {
    if (!(field in body)) continue;
    const r = parse(body[field]);
    if (!r.ok) return c.json({ error: r.error }, 400);
    sets.push(`${field} = ?`);
    values.push(r.value);
  }
  if (sets.length) {
    try {
      await c.env.DB.prepare(`UPDATE links SET ${sets.join(', ')} WHERE id = ? AND app_id = ?`).bind(...values, existing.id, app.id).run();
    } catch (err) {
      if (isUniqueViolation(err)) return c.json({ error: 'slug_taken' }, 409);
      throw err;
    }
  }
  const updated = await c.env.DB.prepare('SELECT * FROM links WHERE id = ? AND app_id = ?').bind(existing.id, app.id).first<Link>();
  return c.json(updated);
});

// Clicks are kept: they hold install attribution that dashboards still report on.
linksRoutes.delete('/api/apps/:id/links/:linkId', async (c) => {
  const app = await getAppById(c.env.DB, c.req.param('id'));
  if (!app) return c.json({ error: 'not found' }, 404);
  const res = await c.env.DB.prepare('DELETE FROM links WHERE id = ? AND app_id = ?').bind(c.req.param('linkId'), app.id).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});
