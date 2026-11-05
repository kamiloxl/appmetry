import type { AppRow, Env } from './env';
import { resolveAsaToken } from './attribution';
import { ERASE_CHUNK, eraseStatements } from './privacy';
import { rematch } from './revenuecat';

const DAY = 86_400_000;
const MONTH_MS = 30.44 * DAY;
const RC_EVENTS_KEEP_MS = 30 * DAY;
const REMATCH_WINDOW_MS = 7 * DAY;
const ASA_PER_RUN = 10;
const REMATCH_CALLS_PER_APP = 5;
/** Workers Free allows 50 D1 queries per invocation; stop with headroom. */
export const QUERY_BUDGET = 40;
/** Rough query cost of resolveAsaToken (exchange + apply + clear) and of rematch. */
const ASA_COST = 3;
const REMATCH_COST = 3;

class Budget {
  used = 0;
  exhausted = false;
  /** Reserve `n` queries. False (and logged once) when they would not fit. */
  spend(n = 1): boolean {
    if (this.exhausted) return false;
    if (this.used + n > QUERY_BUDGET) {
      this.exhausted = true;
      console.warn('daily run budget reached');
      return false;
    }
    this.used += n;
    return true;
  }
}

/** Retention: old events, sessions and clicks, then installs with no session left (anonymising their payments first). */
async function retention(db: D1Database, app: AppRow, now: number, b: Budget): Promise<void> {
  const cutoff = now - app.retention_months * MONTH_MS;
  const rowidDeletes: Array<[string, string]> = [
    ['events', 'ts'],
    ['sessions', 'started_at'],
    ['link_clicks', 'ts'],
  ];
  for (const [table, col] of rowidDeletes) {
    for (;;) {
      if (!b.spend()) return;
      const res = await db
        .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE app_id = ? AND ${col} < ? LIMIT ${ERASE_CHUNK})`)
        .bind(app.id, cutoff)
        .run();
      if (res.meta.changes < ERASE_CHUNK) break;
    }
  }
  for (;;) {
    if (!b.spend()) return;
    const { results } = await db
      .prepare(
        `SELECT i.id FROM installs i WHERE i.app_id = ? AND i.last_seen < ?
           AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.app_id = i.app_id AND s.install_id = i.id) LIMIT ${ERASE_CHUNK}`,
      )
      .bind(app.id, cutoff)
      .all<{ id: string }>();
    if (!results.length) break;
    if (!b.spend()) return;
    await db.batch(eraseStatements(db, app.id, results.map((r) => r.id)));
    if (results.length < ERASE_CHUNK) break;
  }
}

async function asaTokens(db: D1Database, app: AppRow, now: number, b: Budget, fetchFn?: typeof fetch): Promise<void> {
  if (!b.spend()) return;
  await db
    .prepare(
      `UPDATE installs SET asa_pending_token = NULL, asa_pending_until = NULL
       WHERE app_id = ? AND asa_pending_token IS NOT NULL AND (asa_pending_until IS NULL OR asa_pending_until <= ?)`,
    )
    .bind(app.id, now)
    .run();
  if (!b.spend()) return;
  const { results } = await db
    .prepare(
      `SELECT id, asa_pending_token AS token, asa_pending_until AS until FROM installs
       WHERE app_id = ? AND asa_pending_token IS NOT NULL AND asa_pending_until > ? ORDER BY asa_pending_until LIMIT ${ASA_PER_RUN}`,
    )
    .bind(app.id, now)
    .all<{ id: string; token: string; until: number }>();
  for (const r of results) {
    if (!b.spend(ASA_COST)) return;
    try {
      await resolveAsaToken(db, app.id, r.id, r.token, r.until, { fetchFn });
    } catch (err) {
      console.error('daily run: ASA token retry failed', app.id, err instanceof Error ? err.message : 'unknown error');
    }
  }
}

async function rematchRecent(db: D1Database, app: AppRow, now: number, b: Budget): Promise<void> {
  for (let i = 0; i < REMATCH_CALLS_PER_APP; i++) {
    if (!b.spend(REMATCH_COST)) return;
    const { remaining } = await rematch(db, app.id, now - REMATCH_WINDOW_MS);
    if (remaining <= 0) return;
  }
}

/** Daily housekeeping for every app. One app failing never stops the others; the query budget ends the run early. */
export async function runDaily(env: Env, now: number, fetchFn?: typeof fetch): Promise<void> {
  const db = env.DB;
  const b = new Budget();
  b.spend();
  const { results: apps } = await db.prepare('SELECT * FROM apps').all<AppRow>();
  for (const app of apps) {
    if (b.exhausted) break;
    try {
      await retention(db, app, now, b);
      if (!b.spend()) break;
      await db.prepare('DELETE FROM rc_events WHERE app_id = ? AND ts < ?').bind(app.id, now - RC_EVENTS_KEEP_MS).run();
      await asaTokens(db, app, now, b, fetchFn);
      await rematchRecent(db, app, now, b);
    } catch (err) {
      console.error('daily run failed for app', app.id, err instanceof Error ? err.message : 'unknown error');
    }
  }
}
