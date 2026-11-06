import { type Dim, INSTALL_DIMS, type StatsCtx, isInstallDim } from './filters';
import { TRIAL_COUNTS, trialsFrom } from './trials';

export interface BreakdownRow {
  value: string;
  installs: number;
  revenue: number;
  /** Installs that started a trial in the range (RevenueCat `rc_trial_started`). Always 0 for screen / event. */
  trials: number;
  /** Installs whose trial converted to paid in the range (`rc_trial_converted`). Always 0 for screen / event. */
  trialsConverted: number;
  /** Display name for a Search Ads id (`asa_names`), when one is known. `value` stays the id, for filtering. */
  label?: string;
}

const LIMIT = 50;

/** Search Ads dimensions and their `asa_names.kind`. */
const ASA_KIND = { asa_campaign_id: 'campaign', asa_adgroup_id: 'adgroup', asa_keyword_id: 'keyword' } as const;
const NONE = '(none)';
const UNKNOWN = 'Unknown';

/** Dimensions whose revenue follows the credited session (when the payment has one) instead of the install. */
const SESSION_CREDIT = { source: 's.source', channel: 's.channel', campaign: 's.utm_campaign' } as const;

/** Top 50 values of one dimension with installs, revenue and trials (and names for Search Ads ids). One batch of 3–4 reads. */
export async function breakdown(ctx: StatsCtx, dim: Dim): Promise<BreakdownRow[]> {
  const { db, app, range, filter } = ctx;
  const f = filter.where;
  const args = [app.id, range.from, range.to];

  if (!isInstallDim(dim)) {
    // screen / event: distinct installs that fired the event; revenue is not attributed to events.
    const res = await db
      .prepare(
        `SELECT COALESCE(e.name, '${NONE}') AS value, COUNT(DISTINCT e.install_id) AS installs
         FROM events e LEFT JOIN installs i ON i.app_id = e.app_id AND i.id = e.install_id
         WHERE e.app_id = ? AND e.type = ? AND e.ts >= ? AND e.ts < ?${f}
         GROUP BY value ORDER BY installs DESC, value LIMIT ${LIMIT}`,
      )
      .bind(app.id, dim, range.from, range.to, ...filter.binds)
      .all<{ value: string; installs: number }>();
    return res.results.map((r) => ({ ...r, revenue: 0, trials: 0, trialsConverted: 0 }));
  }

  const col = `i.${INSTALL_DIMS[dim]}`;
  const credited = dim in SESSION_CREDIT ? SESSION_CREDIT[dim as keyof typeof SESSION_CREDIT] : null;
  // Credited session wins; else the install; a payment with neither is "Unknown".
  const revenueValue = credited
    ? `COALESCE(CASE WHEN s.id IS NOT NULL THEN ${credited} ELSE ${col} END,
                CASE WHEN s.id IS NULL AND i.id IS NULL THEN '${UNKNOWN}' ELSE '${NONE}' END)`
    : `COALESCE(${col}, CASE WHEN i.id IS NULL THEN '${UNKNOWN}' ELSE '${NONE}' END)`;
  const sessionJoin = credited ? 'LEFT JOIN sessions s ON s.app_id = p.app_id AND s.id = p.session_id' : '';

  const asaKind = dim in ASA_KIND ? ASA_KIND[dim as keyof typeof ASA_KIND] : null;
  const [ins, rev, tri, names] = await db.batch([
    db
      .prepare(
        `SELECT COALESCE(${col}, '${NONE}') AS value, COUNT(*) AS installs
         FROM installs i WHERE i.app_id = ? AND i.first_seen >= ? AND i.first_seen < ?${f} GROUP BY value`,
      )
      .bind(...args, ...filter.binds),
    db
      .prepare(
        `SELECT ${revenueValue} AS value, SUM(p.amount) AS revenue
         FROM payments p LEFT JOIN installs i ON i.app_id = p.app_id AND i.id = p.install_id ${sessionJoin}
         WHERE p.app_id = ? AND p.ts >= ? AND p.ts < ?${ctx.sandbox}${f} GROUP BY value`,
      )
      .bind(...args, ...filter.binds),
    db.prepare(`SELECT COALESCE(${col}, '${NONE}') AS value, ${TRIAL_COUNTS} ${trialsFrom(ctx)} GROUP BY value`).bind(...args, ...filter.binds),
    ...(asaKind ? [db.prepare('SELECT id, name FROM asa_names WHERE app_id = ? AND kind = ?').bind(app.id, asaKind)] : []),
  ]);

  // Values that only earned revenue or trials (installed before the range) still get a row.
  const rows = new Map<string, BreakdownRow>();
  const row = (value: string) => {
    let r = rows.get(value);
    if (!r) rows.set(value, (r = { value, installs: 0, revenue: 0, trials: 0, trialsConverted: 0 }));
    return r;
  };
  for (const r of ins.results as { value: string; installs: number }[]) row(r.value).installs = r.installs;
  for (const r of rev.results as { value: string; revenue: number }[]) row(r.value).revenue += r.revenue;
  for (const r of tri.results as { value: string; trials: number; converted: number }[]) {
    const x = row(r.value);
    x.trials = r.trials;
    x.trialsConverted = r.converted;
  }
  if (names) {
    const byId = new Map((names.results as { id: string; name: string }[]).map((n) => [n.id, n.name]));
    for (const r of rows.values()) {
      const name = byId.get(r.value);
      if (name) r.label = name;
    }
  }
  return [...rows.values()]
    .sort((a, b) => b.installs - a.installs || b.trials - a.trials || b.revenue - a.revenue || (a.value < b.value ? -1 : 1))
    .slice(0, LIMIT);
}
