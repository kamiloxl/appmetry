import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installFilterSql } from '../src/stats/filters';
import { call, createApp, login } from './helpers';
import { insertInstall, insertPayment, seedStats, type SeedIds } from './fixtures/seed';

const DAY = 86_400_000;

let cookie: string;
beforeAll(async () => {
  cookie = await login();
});
beforeEach(async () => {
  for (const t of ['apps', 'installs', 'sessions', 'events', 'payments']) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

interface Totals {
  installs: number;
  activeUsers: number;
  sessions: number;
  revenue: number;
  payingInstalls: number;
  conversionRate: number;
  revenuePerInstall: number;
  avgSessionMs: number;
}
interface Overview {
  current: Totals;
  previous: Totals;
  series: { label: string; installs: number; revenue: number }[];
}
type Row = { value: string; installs: number; revenue: number };

async function seeded(patch: Record<string, unknown> = {}): Promise<{ id: string; ids: SeedIds }> {
  const app = await createApp(cookie, patch);
  return { id: app.id, ids: await seedStats(env.DB, app) };
}
const overview = async (id: string, qs = 'range=30d') => (await call(`/api/apps/${id}/stats/overview?${qs}`, { cookie })).json<Overview>();
const breakdown = async (id: string, dim: string, qs = 'range=30d') =>
  (await call(`/api/apps/${id}/stats/breakdown?dim=${dim}&${qs}`, { cookie })).json<Row[]>();

describe('stats API', () => {
  it('requires a session and a known app', async () => {
    expect((await call('/api/apps/x/stats/overview')).status).toBe(401);
    expect((await call('/api/apps/nope/stats/overview', { cookie })).status).toBe(404);
    expect((await call('/api/apps/nope/stats/breakdown?dim=source', { cookie })).status).toBe(404);
  });

  it('validates query parameters', async () => {
    const { id } = await seeded();
    expect((await call(`/api/apps/${id}/stats/overview?range=bogus`, { cookie })).status).toBe(400);
    expect((await call(`/api/apps/${id}/stats/overview?range=custom`, { cookie })).status).toBe(400);
    expect((await call(`/api/apps/${id}/stats/overview?interval=minute`, { cookie })).status).toBe(400);
    expect((await call(`/api/apps/${id}/stats/breakdown?dim=email`, { cookie })).status).toBe(400);
    expect((await call(`/api/apps/${id}/stats/breakdown`, { cookie })).status).toBe(400);
  });

  it('overview totals', async () => {
    const { id } = await seeded();
    const { current } = await overview(id);
    expect(current.installs).toBe(3);
    expect(current.activeUsers).toBe(3);
    expect(current.sessions).toBe(5);
    expect(current.revenue).toBe(999 + 1999 - 999);
    expect(current.payingInstalls).toBe(2);
    expect(current.conversionRate).toBeCloseTo(2 / 3);
    expect(current.revenuePerInstall).toBeCloseTo(1999 / 3);
    expect(current.avgSessionMs).toBe(120_000);
  });

  it('empty app returns zeros, not NaN', async () => {
    const app = await createApp(cookie);
    const { current, series } = await overview(app.id);
    expect(current).toEqual({ installs: 0, activeUsers: 0, sessions: 0, revenue: 0, payingInstalls: 0, conversionRate: 0, revenuePerInstall: 0, avgSessionMs: 0 });
    expect(series.length).toBeGreaterThan(25);
  });

  it('previous period is the same length immediately before', async () => {
    const { id } = await seeded();
    const now = Date.now();
    await env.DB.batch([
      insertInstall(env.DB, id, { id: 'inst_prev_0001', platform: 'ios', country: 'US', source: 'Organic', channel: 'Organic', first_seen: now - 35 * DAY }),
      insertPayment(env.DB, id, { id: 'pay_prev', ts: now - 35 * DAY, amount: 500, install_id: 'inst_prev_0001' }),
      insertInstall(env.DB, id, { id: 'inst_old_0001', platform: 'ios', country: 'US', source: 'Organic', channel: 'Organic', first_seen: now - 100 * DAY }),
    ]);
    const r = await overview(id, 'range=7d');
    expect(r.current.installs).toBe(3);
    expect(r.previous.installs).toBe(0);
    const r30 = await overview(id, 'range=30d');
    expect(r30.current.installs).toBe(3);
    expect(r30.previous.installs).toBe(1);
    expect(r30.previous.revenue).toBe(500);
    expect(r30.previous.payingInstalls).toBe(1);
    // custom range: previous ends exactly at `from`
    const from = now - 10 * DAY;
    const c = await overview(id, `range=custom&from=${from}&to=${now}`);
    expect(c.current.installs).toBe(3);
  });

  it('series buckets in app timezone', async () => {
    const app = await createApp(cookie, { timezone: 'Europe/Warsaw' });
    const day = Math.floor(Date.now() / DAY) * DAY - 3 * DAY;
    await insertInstall(env.DB, app.id, {
      id: 'inst_late_0001',
      platform: 'ios',
      country: 'PL',
      source: 'Organic',
      channel: 'Organic',
      first_seen: day + 23.5 * 3_600_000,
    }).run();
    const { series } = await overview(app.id, 'range=7d');
    const withInstalls = series.filter((s) => s.installs > 0);
    expect(withInstalls).toHaveLength(1);
    expect(withInstalls[0].label).toBe(new Date(day + DAY).toISOString().slice(0, 10));
    expect(series.every((s) => typeof s.revenue === 'number')).toBe(true);

    const utc = await createApp(cookie);
    await insertInstall(env.DB, utc.id, { id: 'inst_late_0002', platform: 'ios', country: 'PL', source: 'Organic', channel: 'Organic', first_seen: day + 23.5 * 3_600_000 }).run();
    const u = (await overview(utc.id, 'range=7d')).series.filter((s) => s.installs > 0);
    expect(u[0].label).toBe(new Date(day).toISOString().slice(0, 10));
  });

  it('series carries installs and revenue per bucket', async () => {
    const { id, ids } = await seeded();
    const { series } = await overview(id);
    const d0 = new Date(ids.day).toISOString().slice(0, 10);
    const d1 = new Date(ids.day + DAY).toISOString().slice(0, 10);
    expect(series.find((s) => s.label === d0)).toMatchObject({ installs: 3, revenue: 0 });
    expect(series.find((s) => s.label === d1)).toMatchObject({ installs: 0, revenue: 1999 });
  });

  it('breakdown source credits revenue to credited session source when set, else install source', async () => {
    const { id } = await seeded();
    const rows = await breakdown(id, 'source');
    const by = Object.fromEntries(rows.map((r) => [r.value, r]));
    expect(by['Direct']).toEqual({ value: 'Direct', installs: 0, revenue: 999 });
    expect(by['Search Ads']).toEqual({ value: 'Search Ads', installs: 1, revenue: 1999 });
    expect(by['tiktok']).toEqual({ value: 'tiktok', installs: 1, revenue: -999 });
    expect(by['Organic']).toEqual({ value: 'Organic', installs: 1, revenue: 0 });
  });

  it('unmatched payments count in totals and show as Unknown, unless filtered', async () => {
    const { id, ids } = await seeded();
    await insertPayment(env.DB, id, { id: 'pay_unmatched', ts: ids.day + DAY + 5 * 3_600_000, amount: 300 }).run();
    expect((await overview(id)).current.revenue).toBe(2299);
    const rows = await breakdown(id, 'source');
    expect(rows.find((r) => r.value === 'Unknown')).toEqual({ value: 'Unknown', installs: 0, revenue: 300 });
    const platformRows = await breakdown(id, 'platform');
    expect(platformRows.find((r) => r.value === 'Unknown')?.revenue).toBe(300);
    // With a filter active, unmatched payments are excluded.
    expect((await overview(id, 'range=30d&f.platform=ios')).current.revenue).toBe(1999);
    expect((await breakdown(id, 'source', 'range=30d&f.platform=ios')).find((r) => r.value === 'Unknown')).toBeUndefined();
  });

  it('filter f.platform=ios limits all metrics', async () => {
    const { id } = await seeded();
    const { current, series } = await overview(id, 'range=30d&f.platform=ios');
    expect(current.installs).toBe(2);
    expect(current.activeUsers).toBe(2);
    expect(current.sessions).toBe(3);
    expect(current.revenue).toBe(1999);
    expect(current.payingInstalls).toBe(1);
    expect(current.conversionRate).toBeCloseTo(1 / 2);
    expect(series.reduce((n, s) => n + s.installs, 0)).toBe(2);
    const rows = await breakdown(id, 'platform', 'range=30d&f.country=GB');
    expect(rows).toEqual([{ value: 'ios', installs: 1, revenue: 1999 }]);
  });

  it('unknown filter dim is ignored', async () => {
    const { id } = await seeded();
    const { current } = await overview(id, 'range=30d&f.bogus=x&f.email=a');
    expect(current.installs).toBe(3);
    expect(current.revenue).toBe(1999);
  });

  it('sandbox payments excluded unless show_sandbox', async () => {
    const { id, ids } = await seeded();
    await insertPayment(env.DB, id, { id: 'pay_sbx', ts: ids.day + DAY + 4 * 3_600_000, amount: 700, install_id: ids.installs.ads, environment: 'SANDBOX' }).run();
    expect((await overview(id)).current.revenue).toBe(1999);
    const on = await createApp(cookie, { show_sandbox: 1 });
    const seed2 = await seedStats(env.DB, on);
    await insertPayment(env.DB, on.id, { id: 'pay_sbx2', ts: seed2.day + DAY + 4 * 3_600_000, amount: 700, install_id: seed2.installs.ads, environment: 'SANDBOX' }).run();
    expect((await overview(on.id)).current.revenue).toBe(2699);
  });

  it('screen breakdown counts screen events', async () => {
    const { id } = await seeded();
    expect(await breakdown(id, 'screen')).toEqual([
      { value: 'Home', installs: 3, revenue: 0 },
      { value: 'Paywall', installs: 2, revenue: 0 },
    ]);
    expect(await breakdown(id, 'event')).toEqual([{ value: 'tap', installs: 1, revenue: 0 }]);
  });

  it('breakdown by campaign, asa_campaign_id and country; null shows (none)', async () => {
    const { id } = await seeded();
    const camp = await breakdown(id, 'campaign');
    expect(camp.find((r) => r.value === 'spring')).toMatchObject({ installs: 1, revenue: -999 });
    expect(camp.find((r) => r.value === '(none)')?.installs).toBe(2);
    expect((await breakdown(id, 'asa_campaign_id')).find((r) => r.value === '123')).toEqual({ value: '123', installs: 1, revenue: 1999 });
    const country = await breakdown(id, 'country');
    expect(country).toHaveLength(3);
  });
});

describe('installFilterSql', () => {
  it('whitelists dims and parameterises values', () => {
    const q = new URLSearchParams({ 'f.platform': 'ios', 'f.campaign': 'x', 'f.screen': 'Home', 'f.evil; DROP': '1', 'f.country': 'a'.repeat(300) });
    const { where, binds } = installFilterSql(q);
    expect(where).toContain('i.platform = ?');
    expect(where).toContain('i.utm_campaign = ?');
    expect(where).not.toContain('screen');
    expect(where).not.toContain('DROP');
    expect(binds).toHaveLength(3);
    expect(binds).toContain('a'.repeat(200));
  });
  it('is empty with no filters', () => {
    expect(installFilterSql(new URLSearchParams('range=7d'))).toEqual({ where: '', binds: [] });
  });
});
