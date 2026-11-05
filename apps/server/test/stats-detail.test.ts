import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, createApp, login } from './helpers';
import { insertEvent, insertPayment, seedStats, type SeedIds } from './fixtures/seed';

const HOUR = 3_600_000;

let cookie: string;
beforeAll(async () => {
  cookie = await login();
});
beforeEach(async () => {
  for (const t of ['apps', 'installs', 'sessions', 'events', 'payments', 'links', 'link_clicks']) await env.DB.prepare(`DELETE FROM ${t}`).run();
});

async function seeded(patch: Record<string, unknown> = {}): Promise<{ id: string; ids: SeedIds }> {
  const app = await createApp(cookie, patch);
  return { id: app.id, ids: await seedStats(env.DB, app) };
}

interface Customer {
  installId: string;
  name: string;
  emoji: string;
  email: string | null;
  total: number;
  payments: number;
  source: string;
  channel: string;
  matchedBy: string | null;
  firstSeen: number;
  firstPaymentAt: number;
  timeToConvertMs: number;
}
interface Item {
  kind: string;
  ts: number;
  label: string;
  detail?: string;
}
interface LinkRow {
  linkId: string;
  name: string | null;
  slug: string;
  clicks: number;
  androidClicks: number;
  iosClicks: number;
  installs: number;
  revenue: number;
}

describe('customers', () => {
  it('lists paying installs sorted by total desc with matchedBy and time to convert', async () => {
    const { id, ids } = await seeded();
    await env.DB.prepare(`UPDATE payments SET matched_by = 'attribute' WHERE id = ?`).bind(ids.payments.adsSearch).run();
    await env.DB.prepare(`UPDATE payments SET matched_by = 'user_id' WHERE id = ?`).bind(ids.payments.tiktokDirect).run();
    await env.DB.prepare(`UPDATE installs SET email = 'a@b.co' WHERE id = ?`).bind(ids.installs.ads).run();
    const rows = await (await call(`/api/apps/${id}/stats/customers?range=30d`, { cookie })).json<Customer[]>();
    expect(rows.map((r) => r.installId)).toEqual([ids.installs.ads, ids.installs.tiktok]);
    const [ads, tiktok] = rows;
    expect(ads).toMatchObject({ total: 1999, payments: 1, source: 'Search Ads', channel: 'Paid Search', matchedBy: 'attribute', email: 'a@b.co', timeToConvertMs: 15 * HOUR });
    expect(ads.name).toBeTruthy();
    expect(ads.emoji).toBeTruthy();
    expect(tiktok).toMatchObject({ total: 0, payments: 1, matchedBy: 'user_id', firstPaymentAt: ids.day + 24 * HOUR + HOUR });
    expect(tiktok.timeToConvertMs).toBe(tiktok.firstPaymentAt - tiktok.firstSeen);
  });

  it('hides sandbox payments unless show_sandbox, and honours filters', async () => {
    const { id, ids } = await seeded();
    await insertPayment(env.DB, id, { id: `${id}_sb`, ts: ids.day + 30 * HOUR, amount: 500, install_id: ids.installs.organic, environment: 'SANDBOX' }).run();
    const r1 = await (await call(`/api/apps/${id}/stats/customers`, { cookie })).json<Customer[]>();
    expect(r1.map((r) => r.installId)).not.toContain(ids.installs.organic);
    const r2 = await (await call(`/api/apps/${id}/stats/customers?f.platform=android`, { cookie })).json<Customer[]>();
    expect(r2.map((r) => r.installId)).toEqual([ids.installs.tiktok]);
    await call(`/api/apps/${id}`, { method: 'PATCH', cookie, json: { show_sandbox: 1 } });
    const r3 = await (await call(`/api/apps/${id}/stats/customers`, { cookie })).json<Customer[]>();
    expect(r3.map((r) => r.installId)).toContain(ids.installs.organic);
  });

  it('404 for unknown app, 400 for bad range', async () => {
    const { id } = await seeded();
    expect((await call('/api/apps/nope/stats/customers', { cookie })).status).toBe(404);
    expect((await call(`/api/apps/${id}/stats/customers?range=bogus`, { cookie })).status).toBe(400);
  });
});

describe('install timeline', () => {
  it('merges sessions, events and payments in ts order', async () => {
    const { id, ids } = await seeded();
    await insertEvent(env.DB, id, { id: 'ev_ping', install_id: ids.installs.tiktok, ts: ids.day + 10 * HOUR + 500, type: 'ping', name: 'x' }).run();
    await insertEvent(env.DB, id, { id: 'ev_dl', install_id: ids.installs.tiktok, ts: ids.day + 10 * HOUR + 4000, type: 'deep_link', name: 'app://x' }).run();
    await env.DB.prepare(`UPDATE installs SET asa_pending_token = 'secret' WHERE id = ?`).bind(ids.installs.tiktok).run();
    await env.DB.prepare(`UPDATE payments SET product_id = 'pro_monthly' WHERE id = ?`).bind(ids.payments.tiktokDirect).run();
    const res = await call(`/api/apps/${id}/installs/${ids.installs.tiktok}`, { cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{ install: Record<string, unknown>; timeline: Item[] }>();
    expect(body.install.id).toBe(ids.installs.tiktok);
    expect('asa_pending_token' in body.install).toBe(false);
    const ts = body.timeline.map((t) => t.ts);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(body.timeline.map((t) => t.kind)).toEqual(['install', 'session', 'screen', 'screen', 'event', 'deep_link', 'session', 'payment', 'payment']);
    expect(body.timeline[0].label).toBe('Installed via tiktok');
    expect(body.timeline[1]).toMatchObject({ label: 'Session · 1m 0s', detail: 'tiktok' });
    expect(body.timeline[6]).toMatchObject({ label: 'Session · 2m 0s' });
    expect(body.timeline[6].detail).toBeUndefined();
    expect(body.timeline[7]).toMatchObject({ label: '$9.99', detail: 'pro_monthly' });
    expect(body.timeline[8].label).toBe('Refund −$9.99');
  });

  it('keeps the newest 500 items, ascending', async () => {
    const { id, ids } = await seeded();
    const stmts = [];
    for (let i = 0; i < 600; i++) stmts.push(insertEvent(env.DB, id, { id: `bulk_${i}`, install_id: ids.installs.organic, ts: ids.day + 20 * HOUR + i, type: 'event', name: `e${i}` }));
    await env.DB.batch(stmts);
    const body = await (await call(`/api/apps/${id}/installs/${ids.installs.organic}`, { cookie })).json<{ timeline: Item[] }>();
    expect(body.timeline).toHaveLength(500);
    expect(body.timeline[0].label).toBe('e100');
    expect(body.timeline[499].label).toBe('e599');
  });

  it("timeline of another app's install is 404", async () => {
    const { ids } = await seeded();
    const other = await createApp(cookie);
    expect((await call(`/api/apps/${other.id}/installs/${ids.installs.tiktok}`, { cookie })).status).toBe(404);
  });
});

describe('link funnel', () => {
  it('counts clicks, attributed installs and their revenue', async () => {
    const { id, ids } = await seeded();
    const t = ids.day;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO links (id, app_id, slug, name, created_at) VALUES ('l1', ?, 'one', 'One', 1), ('l2', ?, 'two', 'Two', 1), ('l3', ?, 'zero', 'Zero', 1)`).bind(id, id, id),
      env.DB.prepare(
        `INSERT INTO link_clicks (id, link_id, app_id, ts, platform, install_id) VALUES
         ('c1','l1',?,?, 'android', ?), ('c2','l1',?,?, 'ios', ?), ('c3','l1',?,?, 'ios', NULL), ('c4','l1',?,?, 'ios', ?), ('c5','l2',?,?, 'ios', NULL),
         ('c_old','l1',?,?, 'ios', NULL)`,
      ).bind(id, t, ids.installs.tiktok, id, t, ids.installs.ads, id, t, id, t, ids.installs.ads, id, t, id, 1),
      env.DB.prepare(`UPDATE installs SET click_id = 'c1' WHERE id = ?`).bind(ids.installs.tiktok),
      env.DB.prepare(`UPDATE installs SET click_id = 'c2' WHERE id = ?`).bind(ids.installs.ads),
    ]);
    const rows = await (await call(`/api/apps/${id}/stats/links?range=30d`, { cookie })).json<LinkRow[]>();
    expect(rows.map((r) => r.slug)).toEqual(['one', 'two', 'zero']);
    expect(rows[0]).toMatchObject({ linkId: 'l1', name: 'One', clicks: 4, androidClicks: 1, iosClicks: 3, installs: 2, revenue: 999 - 999 + 1999 });
    expect(rows[1]).toMatchObject({ clicks: 1, installs: 0, revenue: 0 });
    expect(rows[2]).toMatchObject({ clicks: 0, androidClicks: 0, iosClicks: 0, installs: 0, revenue: 0 });
  });
});

describe('link funnel revenue attribution', () => {
  async function setup() {
    const { id, ids } = await seeded();
    const t = ids.day;
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO links (id, app_id, slug, name, created_at) VALUES ('l1', ?, 'one', 'One', 1)`).bind(id),
      // ads: two clicks on l1 by the same install, click_id NULL. organic: one click, payment later.
      env.DB.prepare(
        `INSERT INTO link_clicks (id, link_id, app_id, ts, platform, install_id) VALUES
         ('c1','l1',?,?, 'ios', ?), ('c2','l1',?,?, 'ios', ?), ('c3','l1',?,?, 'ios', ?)`,
      ).bind(id, t, ids.installs.ads, id, t + 1, ids.installs.ads, id, t, ids.installs.organic),
    ]);
    return { id, ids };
  }
  const links = async (id: string, qs = '') => (await call(`/api/apps/${id}/stats/links?${qs}`, { cookie })).json<LinkRow[]>();

  it('counts revenue for installs with a null click_id, once per install', async () => {
    const { id } = await setup();
    const [row] = await links(id);
    expect(row).toMatchObject({ clicks: 3, installs: 2, revenue: 1999 });
  });

  it('excludes sandbox payments and includes payments of every counted install', async () => {
    const { id, ids } = await setup();
    await insertPayment(env.DB, id, { id: `${id}_sb`, ts: ids.day + 30 * HOUR, amount: 500, install_id: ids.installs.organic, environment: 'SANDBOX' }).run();
    expect((await links(id))[0].revenue).toBe(1999);
    await insertPayment(env.DB, id, { id: `${id}_prod`, ts: ids.day + 31 * HOUR, amount: 700, install_id: ids.installs.organic }).run();
    expect((await links(id))[0].revenue).toBe(2699);
  });

  it('404 for unknown app and 400 for bad range', async () => {
    const { id } = await setup();
    expect((await call('/api/apps/nope/stats/links', { cookie })).status).toBe(404);
    expect((await call(`/api/apps/${id}/stats/links?range=bogus`, { cookie })).status).toBe(400);
  });
});

describe('timeline unknown app', () => {
  it('404', async () => {
    expect((await call('/api/apps/nope/installs/whatever_id', { cookie })).status).toBe(404);
  });
});

describe('customers sandbox-aware fields', () => {
  it('firstPaymentAt and matchedBy ignore sandbox rows and refunds', async () => {
    const { id, ids } = await seeded();
    await env.DB.prepare(`UPDATE payments SET matched_by = 'attribute' WHERE id = ?`).bind(ids.payments.adsSearch).run();
    await insertPayment(env.DB, id, { id: `${id}_early_sb`, ts: ids.day + 12 * HOUR, amount: 100, install_id: ids.installs.ads, environment: 'SANDBOX' }).run();
    await env.DB.prepare(`UPDATE payments SET matched_by = 'sandbox_match' WHERE id = ?`).bind(`${id}_early_sb`).run();
    const rows = await (await call(`/api/apps/${id}/stats/customers`, { cookie })).json<Customer[]>();
    const ads = rows.find((r) => r.installId === ids.installs.ads)!;
    expect(ads.firstPaymentAt).toBe(ids.day + 24 * HOUR + 2 * HOUR);
    expect(ads.matchedBy).toBe('attribute');
  });
});
