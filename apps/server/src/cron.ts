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
/** Query cost of resolveAsaToken (apply + clear + fetch, rounded up) and of rematch. */
const ASA_COST = 6; // 5 statements + 1 Apple fetch
const REMATCH_BASE = 6; // read, count, batch call, plus up to 3 for queueing ad-network postbacks; 3 statements per candidate
const REMATCH_PER_CANDIDATE = 3;
const REMATCH_LIMIT = 20;
const MIN_INTERVAL_MS = 23 * 3_600_000;
const META_PREFIX = 'cron_last_run:';

class Budget {
  used = 0;
  exhausted = false;
  constructor(readonly limit: number) {}
  get remaining(): number {
    return this.limit - this.used;
  }
  /** Reserve `n` queries. False (and logged once) when they would not fit. */
  spend(n = 1): boolean {
    if (this.exhausted) return false;
    if (this.used + n > this.limit) {
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
    const statements = eraseStatements(db, app.id, results.map((r) => r.id));
    if (!b.spend(statements.length)) return;
    await db.batch(statements);
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
      // One attempt, no wait: a 404 keeps the token and tomorrow's run tries again.
      await resolveAsaToken(db, app.id, r.id, r.token, r.until, { fetchFn, sleep: async () => {}, maxAttempts: 1 });
    } catch (err) {
      console.error('daily run: ASA token retry failed', app.id, err instanceof Error ? err.message : 'unknown error');
    }
  }
}

async function rematchRecent(db: D1Database, app: AppRow, now: number, b: Budget): Promise<void> {
  for (let i = 0; i < REMATCH_CALLS_PER_APP; i++) {
    // Reserve the worst case for the candidates we can afford, then refund what was not used.
    const limit = Math.min(REMATCH_LIMIT, Math.floor((b.remaining - REMATCH_BASE) / REMATCH_PER_CANDIDATE));
    if (limit < 1 || !b.spend(REMATCH_BASE + REMATCH_PER_CANDIDATE * limit)) {
      b.spend(b.limit + 1); // marks the budget as reached
      return;
    }
    const { matched, remaining } = await rematch(db, app.id, now - REMATCH_WINDOW_MS, limit);
    b.used -= REMATCH_PER_CANDIDATE * (limit - Math.min(limit, matched));
    if (remaining <= 0) return;
  }
}

/**
 * Hourly housekeeping. Each app is processed at most once per 23 h (least recently processed first), cheapest work
 * first, within a query budget. One app failing never stops the others; the budget ends the run early.
 */
export async function runDaily(env: Env, now: number, fetchFn?: typeof fetch, budget = QUERY_BUDGET): Promise<void> {
  const db = env.DB;
  const b = new Budget(budget);
  b.spend(2);
  const [{ results: apps }, { results: metaRows }] = await db.batch<never>([
    db.prepare('SELECT * FROM apps'),
    db.prepare('SELECT key, value FROM meta WHERE key LIKE ?').bind(`${META_PREFIX}%`),
  ]);
  const last = new Map((metaRows as unknown as Array<{ key: string; value: string }>).map((m) => [m.key.slice(META_PREFIX.length), Number(m.value)]));
  const due = (apps as unknown as AppRow[])
    .filter((a) => !last.has(a.id) || now - last.get(a.id)! >= MIN_INTERVAL_MS)
    .sort((x, y) => (last.get(x.id) ?? -1) - (last.get(y.id) ?? -1));
  for (const app of due) {
    if (b.exhausted || b.remaining < 1) {
      b.spend(b.limit + 1); // logs "daily run budget reached" if nobody has yet
      break;
    }
    try {
      if (b.spend()) await db.prepare('DELETE FROM rc_events WHERE app_id = ? AND ts < ?').bind(app.id, now - RC_EVENTS_KEEP_MS).run();
      await asaTokens(db, app, now, b, fetchFn);
      await rematchRecent(db, app, now, b);
      await retention(db, app, now, b);
    } catch (err) {
      console.error('daily run failed for app', app.id, err instanceof Error ? err.message : 'unknown error');
    }
    // Recorded even after an error or a budget stop, so one app cannot starve the others.
    b.used += 1;
    try {
      await db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').bind(META_PREFIX + app.id, String(now)).run();
    } catch (err) {
      console.error('daily run: could not record progress for app', app.id, err instanceof Error ? err.message : 'unknown error');
    }
  }
}
