import type { StatsCtx } from './filters';

export interface LinkFunnelRow {
  linkId: string;
  name: string | null;
  slug: string;
  clicks: number;
  androidClicks: number;
  iosClicks: number;
  installs: number;
  revenue: number;
}

/** Per-link funnel for clicks in range: clicks, attributed installs and the revenue those installs made. One batch of 4 reads. */
export async function linkFunnel(ctx: StatsCtx): Promise<LinkFunnelRow[]> {
  const { db, app, range, filter } = ctx;
  const f = filter.where;
  const [links, clicks, installs, revenue] = await db.batch([
    db.prepare('SELECT id, name, slug FROM links WHERE app_id = ?').bind(app.id),
    db
      .prepare(
        `SELECT link_id, COUNT(*) AS clicks,
                SUM(CASE WHEN platform = 'android' THEN 1 ELSE 0 END) AS android,
                SUM(CASE WHEN platform = 'ios' THEN 1 ELSE 0 END) AS ios
         FROM link_clicks WHERE app_id = ? AND ts >= ? AND ts < ? GROUP BY link_id`,
      )
      .bind(app.id, range.from, range.to),
    db
      .prepare(
        `SELECT c.link_id, COUNT(DISTINCT c.install_id) AS installs
         FROM link_clicks c LEFT JOIN installs i ON i.app_id = c.app_id AND i.id = c.install_id
         WHERE c.app_id = ? AND c.ts >= ? AND c.ts < ? AND c.install_id IS NOT NULL${f} GROUP BY c.link_id`,
      )
      .bind(app.id, range.from, range.to, ...filter.binds),
    db
      .prepare(
        `SELECT c.link_id, SUM(p.amount) AS revenue
         FROM (SELECT DISTINCT link_id, install_id FROM link_clicks
               WHERE app_id = ? AND ts >= ? AND ts < ? AND install_id IS NOT NULL) c
         JOIN payments p ON p.app_id = ? AND p.install_id = c.install_id
         LEFT JOIN installs i ON i.app_id = p.app_id AND i.id = p.install_id
         WHERE p.ts >= ? AND p.ts < ?${ctx.sandbox}${f} GROUP BY c.link_id`,
      )
      .bind(app.id, range.from, range.to, app.id, range.from, range.to, ...filter.binds),
  ]);
  const by = <T extends { link_id: string }>(r: { results: unknown[] }) => new Map((r.results as T[]).map((x) => [x.link_id, x]));
  const cm = by<{ link_id: string; clicks: number; android: number; ios: number }>(clicks);
  const im = by<{ link_id: string; installs: number }>(installs);
  const rm = by<{ link_id: string; revenue: number }>(revenue);
  return (links.results as { id: string; name: string | null; slug: string }[])
    .map((l) => ({
      linkId: l.id,
      name: l.name,
      slug: l.slug,
      clicks: cm.get(l.id)?.clicks ?? 0,
      androidClicks: cm.get(l.id)?.android ?? 0,
      iosClicks: cm.get(l.id)?.ios ?? 0,
      installs: im.get(l.id)?.installs ?? 0,
      revenue: rm.get(l.id)?.revenue ?? 0,
    }))
    .sort((a, b) => b.clicks - a.clicks || a.slug.localeCompare(b.slug));
}
