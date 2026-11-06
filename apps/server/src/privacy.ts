import { Hono } from 'hono';
import { getAppById, type AppEnv } from './env';

/** Ids per statement. Ids travel as one JSON array parameter (D1 allows only 100 bound variables per query). */
export const ERASE_CHUNK = 500;

/**
 * Statements that remove the given installs' personal data, in order: detach link clicks, anonymise payments and
 * rc_events (amounts, timestamps and product fields stay), then delete queued/logged ad-network postbacks, events,
 * sessions and the installs (which also removes their sealed advertising id).
 * Everything is scoped by `app_id`. `ids.length` must be at most ERASE_CHUNK.
 */
export function eraseStatements(db: D1Database, appId: string, ids: string[]): D1PreparedStatement[] {
  const json = JSON.stringify(ids);
  const inIds = 'IN (SELECT value FROM json_each(?))';
  return [
    db.prepare(`UPDATE link_clicks SET install_id = NULL WHERE app_id = ? AND install_id ${inIds}`).bind(appId, json),
    db
      .prepare(
        `UPDATE payments SET install_id = NULL, app_user_id = NULL, session_id = NULL, matched_by = 'erased'
         WHERE app_id = ? AND install_id ${inIds}`,
      )
      .bind(appId, json),
    db.prepare(`UPDATE rc_events SET install_id = NULL, app_user_id = NULL WHERE app_id = ? AND install_id ${inIds}`).bind(appId, json),
    // RevenueCat app_user_id can equal the install id (anonymous matching), also on rows that never matched.
    db.prepare(`UPDATE payments SET app_user_id = NULL WHERE app_id = ? AND app_user_id ${inIds}`).bind(appId, json),
    db.prepare(`UPDATE rc_events SET app_user_id = NULL WHERE app_id = ? AND app_user_id ${inIds}`).bind(appId, json),
    db.prepare(`DELETE FROM postback_outbox WHERE app_id = ? AND install_id ${inIds}`).bind(appId, json),
    db.prepare(`DELETE FROM events WHERE app_id = ? AND install_id ${inIds}`).bind(appId, json),
    db.prepare(`DELETE FROM sessions WHERE app_id = ? AND install_id ${inIds}`).bind(appId, json),
    db.prepare(`DELETE FROM installs WHERE app_id = ? AND id ${inIds}`).bind(appId, json),
  ];
}

/**
 * GDPR erasure of one user (all installs with that `user_id`) or one install. Returns the number of installs removed.
 * With a `user_id` it also clears `app_user_id` on all payments and rc_events of the app with that RevenueCat `app_user_id`.
 */
export async function eraseUser(db: D1Database, appId: string, by: { userId?: string; installId?: string }): Promise<number> {
  let ids: string[];
  if (by.userId) {
    const { results } = await db.prepare('SELECT id FROM installs WHERE app_id = ? AND user_id = ?').bind(appId, by.userId).all<{ id: string }>();
    ids = results.map((r) => r.id);
  } else if (by.installId) {
    const { results } = await db.prepare('SELECT id FROM installs WHERE app_id = ? AND id = ?').bind(appId, by.installId).all<{ id: string }>();
    ids = results.map((r) => r.id);
  } else {
    return 0;
  }

  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < ids.length; i += ERASE_CHUNK) statements.push(...eraseStatements(db, appId, ids.slice(i, i + ERASE_CHUNK)));
  if (by.userId) {
    statements.push(
      db.prepare('UPDATE payments SET app_user_id = NULL WHERE app_id = ? AND app_user_id = ?').bind(appId, by.userId),
      db.prepare('UPDATE rc_events SET app_user_id = NULL WHERE app_id = ? AND app_user_id = ?').bind(appId, by.userId),
    );
  }
  if (statements.length) await db.batch(statements);
  return ids.length;
}

/** Mounted by index.ts; the session guard in auth.ts already protects /api/*. */
export const privacyRoutes = new Hono<AppEnv>();

privacyRoutes.delete('/api/apps/:id/users', async (c) => {
  const app = await getAppById(c.env.DB, c.req.param('id'));
  if (!app) return c.json({ error: 'not found' }, 404);
  const userId = c.req.query('user_id');
  const installId = c.req.query('install_id');
  if (!userId === !installId) return c.json({ error: 'provide exactly one of user_id or install_id' }, 400);
  const installs = await eraseUser(c.env.DB, app.id, { userId: userId || undefined, installId: installId || undefined });
  return c.json({ installs });
});
