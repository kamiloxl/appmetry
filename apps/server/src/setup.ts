import { Hono } from 'hono';
import { forgetApp, getAppById, type AppEnv, type AppRow } from './env';

export type SetupStep = 'app' | 'firstEvent' | 'revenuecatWebhook' | 'revenuecatSync' | 'attribution' | 'privacy';
/** In wizard order. */
export const SETUP_STEPS: SetupStep[] = ['app', 'firstEvent', 'revenuecatWebhook', 'revenuecatSync', 'attribution', 'privacy'];

export interface StepStatus {
  done: boolean;
  skipped?: boolean;
  at?: number;
  detail?: string;
}
export interface SetupStatus {
  steps: Record<SetupStep, StepStatus>;
  /** First step that is neither done nor skipped; null when setup is complete. */
  current: SetupStep | null;
}

type Stored = Partial<Record<SetupStep, 'done' | 'skipped'>>;

function parseStored(json: string | null | undefined): Stored {
  if (!json) return {};
  try {
    const v: unknown = JSON.parse(json);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Stored = {};
    // `app` is always done once the app exists, so nothing is ever stored for it.
    for (const k of SETUP_STEPS) {
      if (k === 'app') continue;
      const s = (v as Record<string, unknown>)[k];
      if (s === 'done' || s === 'skipped') out[k] = s;
    }
    return out;
  } catch {
    return {};
  }
}

interface FirstInstall {
  first_seen: number;
  device_model: string | null;
  platform: string | null;
  os_version: string | null;
}

/**
 * Where setup stands, from four cheap reads in one round trip: the earliest install, the earliest RevenueCat event,
 * the earliest one that carried appmetry_install_id, and the stored state (read fresh, not from the per-isolate app cache,
 * so a skip made on another isolate is never missed). A stored `skipped`/`done` wins over detection.
 */
export async function setupStatus(db: D1Database, app: AppRow): Promise<SetupStatus> {
  const [install, anyRc, attrRc, state] = await db.batch([
    db
      .prepare('SELECT first_seen, device_model, platform, os_version FROM installs WHERE app_id = ? ORDER BY first_seen LIMIT 1')
      .bind(app.id),
    db.prepare('SELECT MIN(ts) AS at FROM rc_events WHERE app_id = ?').bind(app.id),
    db.prepare('SELECT MIN(ts) AS at FROM rc_events WHERE app_id = ? AND has_install_attr = 1').bind(app.id),
    db.prepare('SELECT setup_state FROM apps WHERE id = ?').bind(app.id),
  ]);
  const first = (install.results[0] as FirstInstall | undefined) ?? null;
  const stored = parseStored((state.results[0] as { setup_state: string | null } | undefined)?.setup_state ?? app.setup_state);
  const webhookAt = (anyRc.results[0] as { at: number | null } | undefined)?.at ?? null;
  const syncAt = (attrRc.results[0] as { at: number | null } | undefined)?.at ?? null;

  const device = first ? [first.device_model, [first.platform, first.os_version].filter(Boolean).join(' ')].filter(Boolean).join(', ') : '';
  const detected: Record<SetupStep, StepStatus> = {
    app: { done: true, at: app.created_at },
    firstEvent: first ? { done: true, at: first.first_seen, ...(device ? { detail: device } : {}) } : { done: false },
    revenuecatWebhook: webhookAt !== null ? { done: true, at: webhookAt } : { done: false },
    revenuecatSync: syncAt !== null ? { done: true, at: syncAt } : { done: false },
    attribution: { done: false },
    privacy: { done: false },
  };

  const steps = {} as Record<SetupStep, StepStatus>;
  for (const k of SETUP_STEPS) {
    const s = stored[k];
    if (s === 'skipped') steps[k] = { ...detected[k], done: false, skipped: true };
    else if (s === 'done') steps[k] = { ...detected[k], done: true };
    else steps[k] = detected[k];
  }
  const current = SETUP_STEPS.find((k) => !steps[k].done && !steps[k].skipped) ?? null;
  return { steps, current };
}

/** Mounted by index.ts; the session guard in auth.ts already protects /api/*. */
export const setupRoutes = new Hono<AppEnv>();

setupRoutes.get('/api/apps/:id/setup', async (c) => {
  const app = await getAppById(c.env.DB, c.req.param('id'));
  if (!app) return c.json({ error: 'not found' }, 404);
  return c.json(await setupStatus(c.env.DB, app));
});

setupRoutes.patch('/api/apps/:id/setup', async (c) => {
  const app = await getAppById(c.env.DB, c.req.param('id'));
  if (!app) return c.json({ error: 'not found' }, 404);
  const body = (await c.req.json().catch(() => null)) as { step?: unknown; state?: unknown } | null;
  const step = SETUP_STEPS.find((k) => k === body?.step);
  if (body?.step === 'app') return c.json({ error: 'the app step is always done' }, 400);
  const state = body?.state;
  if (!step) return c.json({ error: `step must be one of ${SETUP_STEPS.join(', ')}` }, 400);
  if (state !== 'done' && state !== 'skipped' && state !== 'reset') return c.json({ error: 'state must be done, skipped or reset' }, 400);

  // Read-modify-write on one small JSON value: the wizard is single-user, so last write wins.
  const current = parseStored(await c.env.DB.prepare('SELECT setup_state FROM apps WHERE id = ?').bind(app.id).first<string>('setup_state'));
  if (state === 'reset') delete current[step];
  else current[step] = state;
  await c.env.DB.prepare('UPDATE apps SET setup_state = ? WHERE id = ?').bind(JSON.stringify(current), app.id).run();
  forgetApp(app);
  return c.json(await setupStatus(c.env.DB, app));
});
