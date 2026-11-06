import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installFilterSql } from '../src/stats/filters';
import { call, createApp, login } from './helpers';
import { insertEvent, insertInstall, insertPayment, seedStats, type SeedIds } from './fixtures/seed';

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
  trials: number;
  trialsConverted: number;
  trialRate: number;
}
interface Overview {
  current: Totals;
  previous: Totals;
  series: { label: string; installs: number; revenue: number; trials: number }[];
}
type Row = { value: string; installs: number; revenue: number; trials: number; trialsConverted: number; label?: string };

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
    expect(current).toEqual({
      installs: 0, activeUsers: 0, sessions: 0, revenue: 0, payingInstalls: 0, conversionRate: 0, revenuePerInstall: 0, avgSessionMs: 0,
      trials: 0, trialsConverted: 0, trialRate: 0,
    });
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
    expect(by['Direct']).toEqual({ value: 'Direct', installs: 0, revenue: 999, trials: 0, trialsConverted: 0 });
    expect(by['Search Ads']).toEqual({ value: 'Search Ads', installs: 1, revenue: 1999, trials: 0, trialsConverted: 0 });
    expect(by['tiktok']).toEqual({ value: 'tiktok', installs: 1, revenue: -999, trials: 0, trialsConverted: 0 });
    expect(by['Organic']).toEqual({ value: 'Organic', installs: 1, revenue: 0, trials: 0, trialsConverted: 0 });
  });

  it('unmatched payments count in totals and show as Unknown, unless filtered', async () => {
    const { id, ids } = await seeded();
    await insertPayment(env.DB, id, { id: 'pay_unmatched', ts: ids.day + DAY + 5 * 3_600_000, amount: 300 }).run();
    expect((await overview(id)).current.revenue).toBe(2299);
    const rows = await breakdown(id, 'source');
    expect(rows.find((r) => r.value === 'Unknown')).toEqual({ value: 'Unknown', installs: 0, revenue: 300, trials: 0, trialsConverted: 0 });
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
    expect(rows).toEqual([{ value: 'ios', installs: 1, revenue: 1999, trials: 0, trialsConverted: 0 }]);
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
      { value: 'Home', installs: 3, revenue: 0, trials: 0, trialsConverted: 0 },
      { value: 'Paywall', installs: 2, revenue: 0, trials: 0, trialsConverted: 0 },
    ]);
    expect(await breakdown(id, 'event')).toEqual([{ value: 'tap', installs: 1, revenue: 0, trials: 0, trialsConverted: 0 }]);
  });

  it('breakdown by campaign, asa_campaign_id and country; null shows (none)', async () => {
    const { id } = await seeded();
    const camp = await breakdown(id, 'campaign');
    expect(camp.find((r) => r.value === 'spring')).toMatchObject({ installs: 1, revenue: -999 });
    expect(camp.find((r) => r.value === '(none)')?.installs).toBe(2);
    expect((await breakdown(id, 'asa_campaign_id')).find((r) => r.value === '123')).toEqual({ value: '123', installs: 1, revenue: 1999, trials: 0, trialsConverted: 0 });
    const country = await breakdown(id, 'country');
    expect(country).toHaveLength(3);
  });

  describe('trials', () => {
    const trial = (appId: string, id: string, install_id: string, ts: number, name = 'rc_trial_started', props?: Record<string, unknown>) =>
      insertEvent(env.DB, appId, { id, install_id, ts, type: 'event', name, props: props ?? { product_id: 'pro', store: 'APP_STORE', price_usd: 0 } });

    it('breakdown by Search Ads campaign counts trial starts and conversions per install', async () => {
      const { id, ids } = await seeded();
      const t = ids.day + DAY;
      await env.DB.batch([
        trial(id, 'rc_t1', ids.installs.ads, t),
        trial(id, 'rc_t1b', ids.installs.ads, t + 1000), // same install twice counts once
        trial(id, 'rc_c1', ids.installs.ads, t + 2000, 'rc_trial_converted'),
        trial(id, 'rc_t2', ids.installs.organic, t),
      ]);
      const asa = await breakdown(id, 'asa_campaign_id');
      expect(asa.find((r) => r.value === '123')).toMatchObject({ installs: 1, trials: 1, trialsConverted: 1 });
      expect(asa.find((r) => r.value === '(none)')).toMatchObject({ installs: 2, trials: 1, trialsConverted: 0 });
      // Source follows the install's attribution for trials.
      expect((await breakdown(id, 'source')).find((r) => r.value === 'Search Ads')).toMatchObject({ trials: 1 });
    });

    it('overview totals, previous period and filters', async () => {
      const { id, ids } = await seeded();
      await env.DB.batch([
        trial(id, 'rc_t1', ids.installs.ads, ids.day + DAY),
        trial(id, 'rc_t2', ids.installs.tiktok, ids.day + DAY),
        trial(id, 'rc_c1', ids.installs.ads, ids.day + 2 * DAY, 'rc_trial_converted'),
        trial(id, 'rc_old', ids.installs.organic, ids.day - 40 * DAY), // previous 30-day period
      ]);
      const { current, previous, series } = await overview(id);
      expect(current).toMatchObject({ trials: 2, trialsConverted: 1 });
      // Both trials started on the same day; conversions are not trial starts.
      expect(series.filter((s) => s.trials > 0).map((s) => s.trials)).toEqual([2]);
      expect(series.reduce((n, s) => n + s.trials, 0)).toBe(2);
      expect(current.trialRate).toBeCloseTo(2 / 3);
      expect(previous.trials).toBe(1);
      expect((await overview(id, 'range=30d&f.asa_campaign_id=123')).current).toMatchObject({ trials: 1, trialsConverted: 1, trialRate: 1 });
    });

    it('a trial of an install from before the range still gets a breakdown row', async () => {
      const { id, ids } = await seeded();
      await insertInstall(env.DB, id, { id: 'inst_old_asa', platform: 'ios', country: 'GB', source: 'Search Ads', channel: 'Paid Search', asa_campaign_id: '777', first_seen: ids.day - 60 * DAY }).run();
      await trial(id, 'rc_old_inst', 'inst_old_asa', ids.day + DAY).run();
      expect((await breakdown(id, 'asa_campaign_id')).find((r) => r.value === '777')).toEqual({ value: '777', installs: 0, revenue: 0, trials: 1, trialsConverted: 0 });
    });

    it('sandbox trials are excluded unless show_sandbox', async () => {
      const { id, ids } = await seeded();
      await trial(id, 'rc_sbx', ids.installs.ads, ids.day + DAY, 'rc_trial_started', { product_id: 'pro', sandbox: true }).run();
      expect((await overview(id)).current.trials).toBe(0);
      await call(`/api/apps/${id}`, { method: 'PATCH', cookie, json: { show_sandbox: true } });
      expect((await overview(id)).current.trials).toBe(1);
    });
  });
});

describe('Search Ads keywords and ad groups', () => {
  it('breakdown by keyword and ad group carries installs, revenue and trials; keyword filters every metric', async () => {
    const { id, ids } = await seeded();
    const t = ids.day + DAY;
    const asa = { platform: 'ios', country: 'GB', source: 'Search Ads', channel: 'Paid Search', asa_campaign_id: '123' };
    await env.DB.batch([
      insertInstall(env.DB, id, { ...asa, id: 'inst_kw_a1', asa_adgroup_id: '20', asa_keyword_id: '301', first_seen: t }),
      insertInstall(env.DB, id, { ...asa, id: 'inst_kw_a2', asa_adgroup_id: '20', asa_keyword_id: '301', first_seen: t }),
      insertInstall(env.DB, id, { ...asa, id: 'inst_kw_b1', asa_adgroup_id: '20', asa_keyword_id: '302', first_seen: t }),
      insertPayment(env.DB, id, { id: `${id}_kw_pay1`, ts: t + 1000, amount: 4999, install_id: 'inst_kw_a1' }),
      insertPayment(env.DB, id, { id: `${id}_kw_pay2`, ts: t + 2000, amount: 999, install_id: 'inst_kw_b1' }),
      insertEvent(env.DB, id, { id: 'rc_kw_t1', install_id: 'inst_kw_a2', ts: t, type: 'event', name: 'rc_trial_started' }),
    ]);
    const kw = await breakdown(id, 'asa_keyword_id');
    expect(kw.find((r) => r.value === '301')).toEqual({ value: '301', installs: 2, revenue: 4999, trials: 1, trialsConverted: 0 });
    expect(kw.find((r) => r.value === '302')).toEqual({ value: '302', installs: 1, revenue: 999, trials: 0, trialsConverted: 0 });
    expect((await breakdown(id, 'asa_adgroup_id')).find((r) => r.value === '20')).toMatchObject({ installs: 3, revenue: 5998, trials: 1 });
    const { current } = await overview(id, 'range=30d&f.asa_keyword_id=301');
    expect(current).toMatchObject({ installs: 2, revenue: 4999, trials: 1 });
  });

  it('labels Search Ads ids with asa_names of the same app and kind; unknown ids keep no label', async () => {
    const { id, ids } = await seeded();
    const other = await createApp(cookie);
    const asa = { platform: 'ios', country: 'GB', source: 'Search Ads', channel: 'Paid Search', asa_campaign_id: '123', asa_adgroup_id: '20' };
    const name = (app: string, kind: string, nid: string, n: string) =>
      env.DB.prepare('INSERT INTO asa_names (app_id, kind, id, name, updated_at) VALUES (?, ?, ?, ?, 1)').bind(app, kind, nid, n);
    await env.DB.batch([
      insertInstall(env.DB, id, { ...asa, id: 'inst_lbl_1', asa_keyword_id: '301', first_seen: ids.day + DAY }),
      insertInstall(env.DB, id, { ...asa, id: 'inst_lbl_2', asa_keyword_id: '302', first_seen: ids.day + DAY }),
      name(id, 'keyword', '301', 'sleep sounds'),
      name(id, 'adgroup', '301', 'not a keyword'), // other kind, same id
      name(other.id, 'keyword', '302', 'other app'), // other app
      name(id, 'campaign', '123', 'Category – Sleep'),
    ]);
    const kw = await breakdown(id, 'asa_keyword_id');
    expect(kw.find((r) => r.value === '301')?.label).toBe('sleep sounds');
    expect(kw.find((r) => r.value === '302')).not.toHaveProperty('label');
    expect((await breakdown(id, 'asa_campaign_id')).find((r) => r.value === '123')?.label).toBe('Category – Sleep');
    expect((await breakdown(id, 'source')).every((r) => r.label === undefined)).toBe(true);
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
