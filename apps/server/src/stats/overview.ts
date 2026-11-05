import { bucketLabels, bucketSql } from '../lib/time';
import type { StatsCtx } from './filters';

export interface Totals {
  installs: number;
  activeUsers: number;
  sessions: number;
  /** USD cents, refunds subtracted. */
  revenue: number;
  payingInstalls: number;
  conversionRate: number;
  revenuePerInstall: number;
  avgSessionMs: number;
}

export interface Overview {
  current: Totals;
  previous: Totals;
  series: { label: string; installs: number; revenue: number }[];
}

// Installs `i` and payments `p` are always LEFT JOINed to what they need; the filter clause (see installFilterSql)
// rejects rows without an install, so unmatched payments only count when no filter is active.
const INSTALLS_SQL = (f: string) =>
  `FROM installs i WHERE i.app_id = ? AND i.first_seen >= ? AND i.first_seen < ?${f}`;
const SESSIONS_SQL = (f: string) =>
  `FROM sessions s LEFT JOIN installs i ON i.app_id = s.app_id AND i.id = s.install_id
   WHERE s.app_id = ? AND s.started_at >= ? AND s.started_at < ?${f}`;
const PAYMENTS_SQL = (f: string, sandbox: string) =>
  `FROM payments p LEFT JOIN installs i ON i.app_id = p.app_id AND i.id = p.install_id
   WHERE p.app_id = ? AND p.ts >= ? AND p.ts < ?${sandbox}${f}`;

interface Row {
  [k: string]: number | null;
}

function totals(installs: Row, sessions: Row, payments: Row): Totals {
  const n = installs.n ?? 0;
  const revenue = payments.revenue ?? 0;
  const paying = payments.paying ?? 0;
  return {
    installs: n,
    activeUsers: sessions.users ?? 0,
    sessions: sessions.n ?? 0,
    revenue,
    payingInstalls: paying,
    conversionRate: n ? paying / n : 0,
    revenuePerInstall: n ? revenue / n : 0,
    avgSessionMs: Math.round(sessions.avg ?? 0),
  };
}

/** Top numbers for the range and the previous period, plus the installs/revenue chart. One batch of 8 reads. */
export async function overview(ctx: StatsCtx): Promise<Overview> {
  const { db, range, app, filter } = ctx;
  const f = filter.where;
  const len = range.to - range.from;
  const periods = [
    [range.from, range.to],
    [range.from - len, range.from],
  ] as const;

  const stmts = periods.flatMap(([from, to]) => {
    const args = [app.id, from, to];
    return [
      db.prepare(`SELECT COUNT(*) AS n ${INSTALLS_SQL(f)}`).bind(...args, ...filter.binds),
      db
        .prepare(`SELECT COUNT(DISTINCT s.install_id) AS users, COUNT(*) AS n, AVG(s.duration) AS avg ${SESSIONS_SQL(f)}`)
        .bind(...args, ...filter.binds),
      db
        .prepare(
          `SELECT COALESCE(SUM(p.amount), 0) AS revenue,
                  COUNT(DISTINCT CASE WHEN p.kind = 'payment' AND p.amount > 0 THEN p.install_id END) AS paying
           ${PAYMENTS_SQL(f, ctx.sandbox)}`,
        )
        .bind(...args, ...filter.binds),
    ];
  });
  const args = [app.id, range.from, range.to];
  const ib = bucketSql('i.first_seen', range.granularity, ctx.offset);
  const pb = bucketSql('p.ts', range.granularity, ctx.offset);
  stmts.push(
    db.prepare(`SELECT ${ib} AS b, COUNT(*) AS n ${INSTALLS_SQL(f)} GROUP BY b`).bind(...args, ...filter.binds),
    db.prepare(`SELECT ${pb} AS b, SUM(p.amount) AS revenue ${PAYMENTS_SQL(f, ctx.sandbox)} GROUP BY b`).bind(...args, ...filter.binds),
  );

  const r = await db.batch(stmts);
  const first = (i: number) => (r[i].results[0] ?? {}) as Row;
  const installsBy = new Map((r[6].results as { b: string; n: number }[]).map((x) => [x.b, x.n]));
  const revenueBy = new Map((r[7].results as { b: string; revenue: number }[]).map((x) => [x.b, x.revenue]));
  return {
    current: totals(first(0), first(1), first(2)),
    previous: totals(first(3), first(4), first(5)),
    series: bucketLabels(range, ctx.offset).map((label) => ({
      label,
      installs: installsBy.get(label) ?? 0,
      revenue: revenueBy.get(label) ?? 0,
    })),
  };
}
