import { Hono, type Context } from 'hono';
import { sameOrigin } from '../auth';
import { getAppById, type AppEnv, type AppRow } from '../env';
import { randomId } from '../lib/crypto';
import { open, parseKeys, seal } from '../lib/sealed';
import { RC_LIFECYCLE_NAMES } from '../revenuecat';
import { send, tokenContext } from './dispatch';
import { getAdapter, PROVIDERS } from './registry';
import { forgetIntegrations } from './store';
import { CUSTOM_EVENT_RE, type IntegrationConfig, type Mapping, type OutboxEvent, type PostbackAdapter } from './types';

/**
 * Dashboard API for ad-network integrations. Behind the session guard (auth.ts); every route is scoped by app id,
 * and writes also pass the same-origin check. Credentials are write-only: responses say `has_token`, never the value.
 */
export const integrationRoutes = new Hono<AppEnv>();
integrationRoutes.use('/api/apps/:id/integrations', sameOrigin);
integrationRoutes.use('/api/apps/:id/integrations/*', sameOrigin);

const DAY = 86_400_000;
const MAX_MAPPINGS = 50;
const SOURCE_MAX = 255;
const TOKEN_RE = /^[\x21-\x7e]{20,1000}$/;
const TEST_CODE_RE = /^[A-Za-z0-9]{1,40}$/;
const DATASET_RE = /^\d{5,25}$/;
const NAME_MAX = 100;
const DELIVERIES_MAX = 200;

type IntegrationRow = {
  id: string;
  app_id: string;
  provider: string;
  status: string;
  send_scope: string;
  config: string;
  capi_token_enc: string | null;
  created_at: number;
  updated_at: number;
};

type Stats = { sent_24h: number; failed_24h: number; pending: number; last_sent_at: number | null; last_error: string | null };

function parseConfig(json: string | null): IntegrationConfig {
  try {
    const v = JSON.parse(json ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const auditStmt = (db: D1Database, appId: string, integrationId: string | null, action: string, now: number) =>
  db.prepare('INSERT INTO integration_audit (id, app_id, integration_id, action, ts) VALUES (?, ?, ?, ?, ?)').bind(randomId(12), appId, integrationId, action, now);

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const body = await req.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

async function loadApp(c: Context<AppEnv>): Promise<AppRow | null> {
  return getAppById(c.env.DB, c.req.param('id') ?? '');
}

async function loadIntegration(c: Context<AppEnv>, app: AppRow): Promise<IntegrationRow | null> {
  return c.env.DB.prepare('SELECT * FROM integrations WHERE id = ? AND app_id = ?').bind(c.req.param('iid') ?? '', app.id).first<IntegrationRow>();
}

async function mappingsOf(db: D1Database, row: IntegrationRow): Promise<Mapping[]> {
  const { results } = await db
    .prepare('SELECT source_event, target_event, send_value, locked FROM integration_mappings WHERE integration_id = ? AND app_id = ? ORDER BY locked DESC, source_event')
    .bind(row.id, row.app_id)
    .all<{ source_event: string; target_event: string; send_value: number; locked: number }>();
  return results.map((r) => ({ source_event: r.source_event, target_event: r.target_event, send_value: r.send_value === 1, locked: r.locked === 1 }));
}

/** What the dashboard sees. Never the credential. */
function publicIntegration(row: IntegrationRow, mappings: Mapping[], stats: Stats | undefined, keysConfigured: boolean) {
  const adapter = getAdapter(row.provider);
  const config = parseConfig(row.config);
  const hasToken = row.capi_token_enc !== null;
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    send_scope: row.send_scope,
    dataset_id: typeof config.dataset_id === 'string' ? config.dataset_id : null,
    dataset_name: typeof config.dataset_name === 'string' ? config.dataset_name : null,
    test_event_code: typeof config.test_event_code === 'string' ? config.test_event_code : null,
    share_hashed_email: config.share_hashed_email === true,
    terms_accepted_at: typeof config.terms_accepted_at === 'number' ? config.terms_accepted_at : null,
    has_token: hasToken,
    keys_configured: keysConfigured,
    missing: adapter?.missingConfig(config) ?? (hasToken ? null : 'token'),
    mappings,
    target_events: adapter?.targetEvents ?? [],
    stats: stats ?? { sent_24h: 0, failed_24h: 0, pending: 0, last_sent_at: null, last_error: null },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function statsFor(db: D1Database, appId: string, now: number): Promise<Map<string, Stats>> {
  const { results } = await db
    .prepare(
      `SELECT o.integration_id,
              SUM(o.status = 'sent' AND o.sent_at >= ?2) AS sent_24h,
              SUM(o.status = 'failed' AND o.created_at >= ?2) AS failed_24h,
              SUM(o.status = 'pending') AS pending,
              MAX(o.sent_at) AS last_sent_at,
              (SELECT x.last_error FROM postback_outbox x
                WHERE x.integration_id = o.integration_id AND x.app_id = ?1 AND x.last_error IS NOT NULL
                ORDER BY x.created_at DESC LIMIT 1) AS last_error
       FROM postback_outbox o WHERE o.app_id = ?1 GROUP BY o.integration_id`,
    )
    .bind(appId, now - DAY)
    .all<Stats & { integration_id: string }>();
  return new Map(results.map((r) => [r.integration_id, { sent_24h: r.sent_24h ?? 0, failed_24h: r.failed_24h ?? 0, pending: r.pending ?? 0, last_sent_at: r.last_sent_at, last_error: r.last_error }]));
}

async function respond(c: Context<AppEnv>, row: IntegrationRow, status: 200 | 201 = 200) {
  const db = c.env.DB;
  const [mappings, stats] = await Promise.all([mappingsOf(db, row), statsFor(db, row.app_id, Date.now())]);
  return c.json(publicIntegration(row, mappings, stats.get(row.id), parseKeys(c.env) !== null), status);
}

function defaultMappingStmts(db: D1Database, appId: string, integrationId: string, adapter: PostbackAdapter): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM integration_mappings WHERE integration_id = ? AND app_id = ?').bind(integrationId, appId),
    ...adapter.defaultMappings.map((m) =>
      db
        .prepare('INSERT INTO integration_mappings (app_id, integration_id, source_event, target_event, send_value, locked) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(appId, integrationId, m.source_event, m.target_event, m.send_value ? 1 : 0, m.locked ? 1 : 0),
    ),
  ];
}

// ---------- list / create

integrationRoutes.get('/api/apps/:id/integrations', async (c) => {
  const app = await loadApp(c);
  if (!app) return c.json({ error: 'not found' }, 404);
  const db = c.env.DB;
  const { results } = await db.prepare('SELECT * FROM integrations WHERE app_id = ? ORDER BY created_at').bind(app.id).all<IntegrationRow>();
  const stats = await statsFor(db, app.id, Date.now());
  const keys = parseKeys(c.env) !== null;
  const integrations = await Promise.all(results.map(async (r) => publicIntegration(r, await mappingsOf(db, r), stats.get(r.id), keys)));
  return c.json({ providers: PROVIDERS, keys_configured: keys, integrations });
});

integrationRoutes.post('/api/apps/:id/integrations', async (c) => {
  const app = await loadApp(c);
  if (!app) return c.json({ error: 'not found' }, 404);
  const body = await readBody(c.req.raw);
  const provider = typeof body?.provider === 'string' ? body.provider : '';
  const adapter = PROVIDERS.some((p) => p.provider === provider) ? getAdapter(provider) : null;
  if (!adapter) return c.json({ error: 'unknown provider' }, 400);

  const db = c.env.DB;
  const now = Date.now();
  const existing = await db.prepare('SELECT * FROM integrations WHERE app_id = ? AND provider = ?').bind(app.id, provider).first<IntegrationRow>();
  if (existing && existing.status !== 'disconnected') return c.json({ error: 'already_exists', id: existing.id }, 409);

  // A disconnected integration is reused (one per network per app): it starts over as a draft.
  const id = existing?.id ?? randomId(10);
  await db.batch([
    existing
      ? db
          .prepare(`UPDATE integrations SET status = 'draft', send_scope = 'all', config = '{}', capi_token_enc = NULL, oauth_token_enc = NULL, updated_at = ? WHERE id = ?`)
          .bind(now, id)
      : db
          .prepare(`INSERT INTO integrations (id, app_id, provider, status, send_scope, config, created_at, updated_at) VALUES (?, ?, ?, 'draft', 'all', '{}', ?, ?)`)
          .bind(id, app.id, provider, now, now),
    ...defaultMappingStmts(db, app.id, id, adapter),
    auditStmt(db, app.id, id, 'create', now),
  ]);
  forgetIntegrations(app.id);
  const row = await db.prepare('SELECT * FROM integrations WHERE id = ?').bind(id).first<IntegrationRow>();
  return respond(c, row!, 201);
});

// ---------- settings

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseNullable(v: unknown, re: RegExp, field: string): Parsed<string | null> {
  if (v === null || v === '') return { ok: true, value: null };
  if (typeof v !== 'string' || !re.test(v.trim())) return { ok: false, error: `${field} is not valid` };
  return { ok: true, value: v.trim() };
}

integrationRoutes.patch('/api/apps/:id/integrations/:iid', async (c) => {
  const app = await loadApp(c);
  if (!app) return c.json({ error: 'not found' }, 404);
  const row = await loadIntegration(c, app);
  if (!row || row.status === 'disconnected') return c.json({ error: 'not found' }, 404);
  const body = await readBody(c.req.raw);
  if (!body) return c.json({ error: 'expected a JSON object' }, 400);

  const config = parseConfig(row.config);
  const changed: string[] = [];
  let sendScope = row.send_scope;
  let tokenEnc: string | null | undefined;

  if ('dataset_id' in body) {
    const r = parseNullable(body.dataset_id, DATASET_RE, 'dataset_id');
    if (!r.ok) return c.json({ error: r.error }, 400);
    if (r.value === null) delete config.dataset_id;
    else config.dataset_id = r.value;
    changed.push('dataset_id');
  }
  if ('dataset_name' in body) {
    const v = body.dataset_name;
    if (v !== null && (typeof v !== 'string' || v.trim().length > NAME_MAX)) return c.json({ error: `dataset_name must be at most ${NAME_MAX} characters` }, 400);
    if (v === null || !v.trim()) delete config.dataset_name;
    else config.dataset_name = v.trim();
    changed.push('dataset_name');
  }
  if ('test_event_code' in body) {
    const r = parseNullable(body.test_event_code, TEST_CODE_RE, 'test_event_code');
    if (!r.ok) return c.json({ error: r.error }, 400);
    if (r.value === null) delete config.test_event_code;
    else config.test_event_code = r.value;
    changed.push('test_event_code');
  }
  if ('share_hashed_email' in body) {
    if (typeof body.share_hashed_email !== 'boolean') return c.json({ error: 'share_hashed_email must be a boolean' }, 400);
    config.share_hashed_email = body.share_hashed_email;
    changed.push('share_hashed_email');
  }
  if ('send_scope' in body) {
    if (body.send_scope !== 'all' && body.send_scope !== 'attributed') return c.json({ error: "send_scope must be 'all' or 'attributed'" }, 400);
    sendScope = body.send_scope;
    changed.push('send_scope');
  }
  if ('token' in body) {
    if (body.token === null) tokenEnc = null;
    else {
      if (typeof body.token !== 'string' || !TOKEN_RE.test(body.token.trim())) return c.json({ error: 'token is not valid' }, 400);
      const keys = parseKeys(c.env);
      if (!keys) return c.json({ error: 'integrations_key_missing' }, 503);
      tokenEnc = await seal(keys, body.token.trim(), tokenContext(row.id));
    }
    changed.push('token');
  }
  if (!changed.length) return respond(c, row);

  // An active integration that loses a required setting stops sending until it is activated again.
  const adapter = getAdapter(row.provider);
  const hasToken = tokenEnc === undefined ? row.capi_token_enc !== null : tokenEnc !== null;
  const incomplete = !hasToken || (adapter?.missingConfig(config) ?? null) !== null;
  const status = incomplete && row.status !== 'draft' ? 'draft' : row.status;

  const now = Date.now();
  const db = c.env.DB;
  await db.batch([
    db
      .prepare(`UPDATE integrations SET config = ?, send_scope = ?, status = ?, capi_token_enc = ${tokenEnc === undefined ? 'capi_token_enc' : '?'}, updated_at = ? WHERE id = ?`)
      .bind(...([JSON.stringify(config), sendScope, status, ...(tokenEnc === undefined ? [] : [tokenEnc]), now, row.id] as unknown[])),
    // Field names only: values (and the token) never reach the audit log.
    auditStmt(db, app.id, row.id, `update:${changed.join(',')}`, now),
  ]);
  forgetIntegrations(app.id);
  return respond(c, (await loadIntegration(c, app))!);
});

// ---------- mappings

integrationRoutes.put('/api/apps/:id/integrations/:iid/mappings', async (c) => {
  const app = await loadApp(c);
  if (!app) return c.json({ error: 'not found' }, 404);
  const row = await loadIntegration(c, app);
  if (!row || row.status === 'disconnected') return c.json({ error: 'not found' }, 404);
  const adapter = getAdapter(row.provider);
  if (!adapter) return c.json({ error: 'unknown provider' }, 400);
  const body = await readBody(c.req.raw);
  const list = body?.mappings;
  if (!Array.isArray(list) || list.length > MAX_MAPPINGS) return c.json({ error: `mappings must be an array of at most ${MAX_MAPPINGS}` }, 400);

  const out = new Map<string, Mapping>();
  for (const m of adapter.defaultMappings) if (m.locked) out.set(m.source_event, m);
  for (const item of list) {
    if (!item || typeof item !== 'object') return c.json({ error: 'each mapping must be an object' }, 400);
    const { source_event, target_event, send_value } = item as Record<string, unknown>;
    if (typeof source_event !== 'string' || !source_event.trim() || source_event.length > SOURCE_MAX) return c.json({ error: 'source_event is not valid' }, 400);
    const source = source_event.trim();
    if (source.startsWith('rc_') && !(RC_LIFECYCLE_NAMES as readonly string[]).includes(source)) return c.json({ error: `unknown RevenueCat event: ${source}` }, 400);
    if (typeof target_event !== 'string' || !(adapter.targetEvents.includes(target_event) || CUSTOM_EVENT_RE.test(target_event))) {
      return c.json({ error: 'target_event is not valid' }, 400);
    }
    if (send_value !== undefined && typeof send_value !== 'boolean') return c.json({ error: 'send_value must be a boolean' }, 400);
    const locked = out.get(source);
    if (locked?.locked) {
      if (locked.target_event !== target_event) return c.json({ error: `${source} is fixed to ${locked.target_event}` }, 400);
      continue;
    }
    if (out.has(source)) return c.json({ error: `duplicate source_event: ${source}` }, 400);
    out.set(source, { source_event: source, target_event, send_value: send_value === true, locked: false });
  }

  const db = c.env.DB;
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM integration_mappings WHERE integration_id = ? AND app_id = ?').bind(row.id, app.id),
    ...[...out.values()].map((m) =>
      db
        .prepare('INSERT INTO integration_mappings (app_id, integration_id, source_event, target_event, send_value, locked) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(app.id, row.id, m.source_event, m.target_event, m.send_value ? 1 : 0, m.locked ? 1 : 0),
    ),
    db.prepare('UPDATE integrations SET updated_at = ? WHERE id = ?').bind(now, row.id),
    auditStmt(db, app.id, row.id, 'mappings', now),
  ]);
  forgetIntegrations(app.id);
  return respond(c, (await loadIntegration(c, app))!);
});

// ---------- activate / test / disconnect

integrationRoutes.post('/api/apps/:id/integrations/:iid/activate', async (c) => {
  const app = await loadApp(c);
  if (!app) return c.json({ error: 'not found' }, 404);
  const row = await loadIntegration(c, app);
  if (!row || row.status === 'disconnected') return c.json({ error: 'not found' }, 404);
  if (!parseKeys(c.env)) return c.json({ error: 'integrations_key_missing' }, 503);
  const config = parseConfig(row.config);
  const missing = getAdapter(row.provider)?.missingConfig(config) ?? null;
  if (missing || !row.capi_token_enc) return c.json({ error: 'incomplete', missing: missing ?? 'token' }, 400);
  const body = await readBody(c.req.raw);
  // The operator confirms the network's business-tools terms (and so the data transfer) before anything is sent.
  if (typeof config.terms_accepted_at !== 'number' && body?.accept_terms !== true) return c.json({ error: 'terms_not_accepted' }, 400);

  const now = Date.now();
  if (typeof config.terms_accepted_at !== 'number') config.terms_accepted_at = now;
  const db = c.env.DB;
  await db.batch([
    db.prepare(`UPDATE integrations SET status = 'active', config = ?, updated_at = ? WHERE id = ?`).bind(JSON.stringify(config), now, row.id),
    auditStmt(db, app.id, row.id, 'activate', now),
  ]);
  forgetIntegrations(app.id);
  return respond(c, (await loadIntegration(c, app))!);
});

integrationRoutes.post('/api/apps/:id/integrations/:iid/test', async (c) => {
  const app = await loadApp(c);
  if (!app) return c.json({ error: 'not found' }, 404);
  const row = await loadIntegration(c, app);
  if (!row || row.status === 'disconnected') return c.json({ error: 'not found' }, 404);
  const adapter = getAdapter(row.provider);
  const keys = parseKeys(c.env);
  if (!adapter) return c.json({ error: 'unknown provider' }, 400);
  if (!keys) return c.json({ error: 'integrations_key_missing' }, 503);
  const config = parseConfig(row.config);
  const missing = adapter.missingConfig(config);
  if (missing || !row.capi_token_enc) return c.json({ error: 'incomplete', missing: missing ?? 'token' }, 400);
  // Without a test code the event would count as real: refuse.
  if (typeof config.test_event_code !== 'string' || !config.test_event_code) return c.json({ error: 'test_event_code_required' }, 400);

  const body = await readBody(c.req.raw);
  const target = typeof body?.target_event === 'string' ? body.target_event : adapter.defaultMappings[0]?.target_event;
  if (!target || !(adapter.targetEvents.includes(target) || CUSTOM_EVENT_RE.test(target))) return c.json({ error: 'target_event is not valid' }, 400);

  let token: string;
  try {
    token = await open(keys, row.capi_token_enc, tokenContext(row.id));
  } catch {
    return c.json({ error: 'credential_unreadable' }, 409);
  }
  const now = Date.now();
  const testId = `test_${randomId(8)}`;
  const event: OutboxEvent = {
    id: testId, sourceEventId: testId, targetEvent: target, eventTs: now, valueCents: target === 'Purchase' ? 100 : null, currency: 'USD',
    install: null, bundleId: app.ios_bundle_id ?? app.android_package, madid: null, transient: null,
  };
  const result = await send(row.provider, row.id, config, token, [event], (input, init) => fetch(input, init));
  await auditStmt(c.env.DB, app.id, row.id, `test:${result.outcome}`, now).run();
  return c.json({ ok: result.outcome === 'sent', outcome: result.outcome, error: result.error ?? null, target_event: target });
});

integrationRoutes.delete('/api/apps/:id/integrations/:iid', async (c) => {
  const app = await loadApp(c);
  if (!app) return c.json({ error: 'not found' }, 404);
  const row = await loadIntegration(c, app);
  if (!row || row.status === 'disconnected') return c.json({ error: 'not found' }, 404);
  const db = c.env.DB;
  const now = Date.now();
  await db.batch([
    db
      .prepare(`UPDATE integrations SET status = 'disconnected', capi_token_enc = NULL, oauth_token_enc = NULL, oauth_expires_at = NULL, updated_at = ? WHERE id = ?`)
      .bind(now, row.id),
    db
      .prepare(
        `UPDATE postback_outbox SET status = 'skipped', last_error = 'integration disconnected', transient_enc = NULL, next_attempt_at = NULL
         WHERE integration_id = ? AND app_id = ? AND status = 'pending'`,
      )
      .bind(row.id, app.id),
    auditStmt(db, app.id, row.id, 'disconnect', now),
  ]);
  forgetIntegrations(app.id);
  return c.json({ ok: true });
});

// ---------- delivery log and event catalog

integrationRoutes.get('/api/apps/:id/integrations/:iid/deliveries', async (c) => {
  const app = await loadApp(c);
  if (!app) return c.json({ error: 'not found' }, 404);
  const row = await loadIntegration(c, app);
  if (!row) return c.json({ error: 'not found' }, 404);
  const status = c.req.query('status');
  if (status && !['pending', 'sent', 'failed', 'skipped'].includes(status)) return c.json({ error: 'unknown status' }, 400);
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), DELIVERIES_MAX);
  // No install id, IP, user agent or advertising id: the log shows what was sent and how it went.
  const { results } = await c.env.DB
    .prepare(
      `SELECT id, source_event_id, target_event, event_ts, value_cents, currency, status, attempts, last_error, created_at, sent_at
       FROM postback_outbox WHERE integration_id = ? AND app_id = ? ${status ? 'AND status = ?' : ''}
       ORDER BY created_at DESC, id LIMIT ?`,
    )
    .bind(...([row.id, app.id, ...(status ? [status] : []), limit] as unknown[]))
    .all();
  return c.json(results);
});

integrationRoutes.get('/api/apps/:id/event-catalog', async (c) => {
  const app = await loadApp(c);
  if (!app) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB
    .prepare(
      `SELECT name, COUNT(*) AS n FROM events
       WHERE app_id = ? AND type = 'event' AND ts >= ? AND name IS NOT NULL AND name NOT LIKE 'rc\\_%' ESCAPE '\\'
       GROUP BY name ORDER BY n DESC, name LIMIT 200`,
    )
    .bind(app.id, Date.now() - 30 * DAY)
    .all<{ name: string; n: number }>();
  return c.json({
    builtin: ['install', ...RC_LIFECYCLE_NAMES],
    custom: results.filter((r) => r.name !== 'install').map((r) => ({ name: r.name, count_30d: r.n })),
  });
});
