import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../src/index';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { runDaily } from '../src/cron';
import { eraseUser } from '../src/privacy';
import { call, createApp, login } from './helpers';
import { insertEvent, insertInstall, insertPayment, insertSession } from './fixtures/seed';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MONTH = 30.44 * DAY;
const db = env.DB;
let cookie: string;

beforeAll(async () => {
  cookie = await login();
});

beforeEach(async () => {
  // runDaily walks every app and has a query budget, so each test starts from an empty instance.
  await db.batch(
    [...['installs', 'sessions', 'events', 'links', 'link_clicks', 'payments', 'rc_events', 'postback_outbox', 'apps'].map((t) => db.prepare(`DELETE FROM ${t}`)), db.prepare("DELETE FROM meta WHERE key LIKE 'cron_last_run:%'")],
  );
});

afterEach(() => vi.restoreAllMocks());

const row1 = async (sql: string, ...args: unknown[]) => (await db.prepare(sql).bind(...args).all()).results[0] ?? null;
const n = (sql: string, ...args: unknown[]) => db.prepare(sql).bind(...args).first<number>('n');

async function addInstall(appId: string, id: string, ts: number, userId?: string) {
  await insertInstall(db, appId, { id, platform: 'ios', country: 'GB', source: 'Direct', channel: 'Direct', first_seen: ts }).run();
  if (userId) await db.prepare('UPDATE installs SET user_id = ?, email = ?, name = ? WHERE app_id = ? AND id = ?').bind(userId, 'a@b.c', 'Ann', appId, id).run();
}
const addRc = (appId: string, id: string, ts: number, installId: string | null, appUserId: string | null) =>
  db.prepare('INSERT INTO rc_events (id, app_id, ts, type, install_id, app_user_id) VALUES (?,?,?,?,?,?)').bind(id, appId, ts, 'INITIAL_PURCHASE', installId, appUserId).run();
const setPaymentUser = (id: string, u: string) => db.prepare('UPDATE payments SET app_user_id = ? WHERE id = ?').bind(u, id).run();

describe('erasure', () => {
  it('erase by user_id removes installs, sessions, events, nulls link_clicks.install_id and payments ids, keeps amounts', async () => {
    const app = await createApp(cookie);
    const now = Date.now();
    await addInstall(app.id, 'install-user-1', now, 'user-42');
    await addInstall(app.id, 'install-user-2', now, 'user-42');
    await addInstall(app.id, 'install-other-1', now, 'user-99');
    await insertSession(db, app.id, { id: 'sess-0001', install_id: 'install-user-1', started_at: now, duration: 1, source: 'Direct', channel: 'Direct' }).run();
    await insertEvent(db, app.id, { id: 'ev-0001', install_id: 'install-user-1', ts: now, type: 'screen', name: 'Home' }).run();
    await insertEvent(db, app.id, { id: 'ev-0002', install_id: 'install-other-1', ts: now, type: 'screen', name: 'Home' }).run();
    await db.prepare('INSERT INTO link_clicks (id, link_id, app_id, ts, install_id) VALUES (?,?,?,?,?)').bind('click-1', 'l1', app.id, now, 'install-user-2').run();
    await insertPayment(db, app.id, { id: `${app.id}_p1`, ts: now, amount: 999, install_id: 'install-user-1', session_id: 'sess-0001' }).run();
    await insertPayment(db, app.id, { id: `${app.id}_p2`, ts: now, amount: 500, install_id: 'install-other-1' }).run();
    await setPaymentUser(`${app.id}_p1`, 'user-42');
    await addRc(app.id, `${app.id}_rc1`, now, 'install-user-1', 'user-42');

    const res = await call(`/api/apps/${app.id}/users?user_id=user-42`, { method: 'DELETE', cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ installs: 2 });

    expect(await n('SELECT COUNT(*) AS n FROM installs WHERE app_id = ?', app.id)).toBe(1);
    expect(await n('SELECT COUNT(*) AS n FROM sessions WHERE app_id = ?', app.id)).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM events WHERE app_id = ?', app.id)).toBe(1);
    expect(await db.prepare('SELECT install_id FROM link_clicks WHERE id = ?').bind('click-1').first('install_id')).toBeNull();
    const p1 = await db.prepare('SELECT * FROM payments WHERE id = ?').bind(`${app.id}_p1`).first<Record<string, unknown>>();
    expect(p1).toMatchObject({ install_id: null, app_user_id: null, session_id: null, matched_by: 'erased', amount: 999, kind: 'payment' });
    expect(await db.prepare('SELECT install_id FROM payments WHERE id = ?').bind(`${app.id}_p2`).first('install_id')).toBe('install-other-1');
    expect(await row1('SELECT install_id, app_user_id FROM rc_events WHERE id = ?', `${app.id}_rc1`)).toEqual({ install_id: null, app_user_id: null });
  });

  it('erase deletes queued ad-network postbacks and the sealed advertising id of erased installs only', async () => {
    const app = await createApp(cookie);
    const now = Date.now();
    await addInstall(app.id, 'install-ad-1', now, 'user-ad');
    await addInstall(app.id, 'install-ad-2', now, 'user-keep');
    await db.prepare('UPDATE installs SET madid_enc = ? WHERE app_id = ?').bind('v1.x.y.z', app.id).run();
    const outbox = (id: string, installId: string) =>
      db
        .prepare(`INSERT INTO postback_outbox (id, app_id, integration_id, source_event_id, install_id, target_event, event_ts, created_at)
                  VALUES (?, ?, 'int-1', ?, ?, 'Purchase', ?, ?)`)
        .bind(id, app.id, `src-${id}`, installId, now, now)
        .run();
    await outbox('pb-1', 'install-ad-1');
    await outbox('pb-2', 'install-ad-2');

    expect(await eraseUser(db, app.id, { userId: 'user-ad' })).toBe(1);
    expect(await n('SELECT COUNT(*) AS n FROM postback_outbox WHERE app_id = ? AND install_id = ?', app.id, 'install-ad-1')).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM postback_outbox WHERE app_id = ? AND install_id = ?', app.id, 'install-ad-2')).toBe(1);
    expect(await n('SELECT COUNT(*) AS n FROM installs WHERE app_id = ? AND madid_enc IS NOT NULL', app.id)).toBe(1);
  });

  it('erase by user_id also nulls app_user_id on unmatched payments and rc_events', async () => {
    const app = await createApp(cookie);
    const now = Date.now();
    await insertPayment(db, app.id, { id: `${app.id}_u1`, ts: now, amount: 100 }).run();
    await setPaymentUser(`${app.id}_u1`, 'user-7');
    await insertPayment(db, app.id, { id: `${app.id}_u2`, ts: now, amount: 100 }).run();
    await setPaymentUser(`${app.id}_u2`, 'user-8');
    await addRc(app.id, `${app.id}_r1`, now, null, 'user-7');
    await addRc(app.id, `${app.id}_r2`, now, null, 'user-8');
    const res = await call(`/api/apps/${app.id}/users?user_id=user-7`, { method: 'DELETE', cookie });
    expect(await res.json()).toEqual({ installs: 0 });
    expect(await row1('SELECT app_user_id, amount FROM payments WHERE id = ?', `${app.id}_u1`)).toEqual({ app_user_id: null, amount: 100 });
    expect(await db.prepare('SELECT app_user_id FROM payments WHERE id = ?').bind(`${app.id}_u2`).first('app_user_id')).toBe('user-8');
    expect(await db.prepare('SELECT app_user_id FROM rc_events WHERE id = ?').bind(`${app.id}_r1`).first('app_user_id')).toBeNull();
    expect(await db.prepare('SELECT app_user_id FROM rc_events WHERE id = ?').bind(`${app.id}_r2`).first('app_user_id')).toBe('user-8');
  });

  it('erase by install_id targets one install, scoped to the app', async () => {
    const a = await createApp(cookie);
    const b = await createApp(cookie);
    const now = Date.now();
    await addInstall(a.id, 'install-same-1', now);
    await addInstall(b.id, 'install-same-1', now);
    expect(await eraseUser(db, a.id, { installId: 'install-same-1' })).toBe(1);
    expect(await n('SELECT COUNT(*) AS n FROM installs WHERE app_id = ?', a.id)).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM installs WHERE app_id = ?', b.id)).toBe(1);
  });

  it('erasure also nulls app_user_id equal to an erased install id on unmatched rows', async () => {
    const app = await createApp(cookie);
    const now = Date.now();
    await addInstall(app.id, 'install-anon-001', now);
    await insertPayment(db, app.id, { id: `${app.id}_a1`, ts: now, amount: 100 }).run();
    await setPaymentUser(`${app.id}_a1`, 'install-anon-001');
    await addRc(app.id, `${app.id}_ar1`, now, null, 'install-anon-001');
    await eraseUser(db, app.id, { installId: 'install-anon-001' });
    expect(await db.prepare('SELECT app_user_id FROM payments WHERE id = ?').bind(`${app.id}_a1`).first('app_user_id')).toBeNull();
    expect(await db.prepare('SELECT app_user_id FROM rc_events WHERE id = ?').bind(`${app.id}_ar1`).first('app_user_id')).toBeNull();
  });

  it('erase requires exactly one of user_id/install_id, and a known app', async () => {
    const app = await createApp(cookie);
    expect((await call(`/api/apps/${app.id}/users`, { method: 'DELETE', cookie })).status).toBe(400);
    expect((await call(`/api/apps/${app.id}/users?user_id=a&install_id=b`, { method: 'DELETE', cookie })).status).toBe(400);
    expect((await call(`/api/apps/nope/users?user_id=a`, { method: 'DELETE', cookie })).status).toBe(404);
    expect((await call(`/api/apps/${app.id}/users?user_id=a`, { method: 'DELETE' })).status).toBe(401);
  });
});

describe('runDaily', () => {
  it('deletes data older than retention_months per app', async () => {
    const now = Date.now();
    const a = await createApp(cookie, { retention_months: 1 });
    const b = await createApp(cookie); // 25 months
    const old = now - 2 * MONTH;
    for (const app of [a, b]) {
      await addInstall(app.id, 'install-keep-1', now);
      await insertEvent(db, app.id, { id: 'ev-old-01', install_id: 'install-keep-1', ts: old, type: 'screen', name: 'Home' }).run();
      await insertEvent(db, app.id, { id: 'ev-new-01', install_id: 'install-keep-1', ts: now, type: 'screen', name: 'Home' }).run();
      await insertSession(db, app.id, { id: 'sess-old-1', install_id: 'install-keep-1', started_at: old, duration: 1, source: 'Direct', channel: 'Direct' }).run();
      await db.prepare('INSERT INTO link_clicks (id, link_id, app_id, ts) VALUES (?,?,?,?)').bind(`click-${app.id}`, 'l1', app.id, old).run();
    }
    await runDaily(env, now);
    expect(await n('SELECT COUNT(*) AS n FROM events WHERE app_id = ?', a.id)).toBe(1);
    expect(await n('SELECT COUNT(*) AS n FROM sessions WHERE app_id = ?', a.id)).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM link_clicks WHERE app_id = ?', a.id)).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM events WHERE app_id = ?', b.id)).toBe(2);
    expect(await n('SELECT COUNT(*) AS n FROM sessions WHERE app_id = ?', b.id)).toBe(1);
    expect(await n('SELECT COUNT(*) AS n FROM link_clicks WHERE app_id = ?', b.id)).toBe(1);
  });

  it('deletes installs with no session in the retention window, NULLing payment ids first', async () => {
    const now = Date.now();
    const app = await createApp(cookie, { retention_months: 1 });
    const old = now - 2 * MONTH;
    await addInstall(app.id, 'install-stale-1', old, 'user-1');
    await addInstall(app.id, 'install-live-01', old);
    await addInstall(app.id, 'install-fresh-1', now);
    await insertSession(db, app.id, { id: 'sess-live-1', install_id: 'install-live-01', started_at: now, duration: 1, source: 'Direct', channel: 'Direct' }).run();
    await insertPayment(db, app.id, { id: `${app.id}_sp`, ts: old, amount: 700, install_id: 'install-stale-1' }).run();
    await setPaymentUser(`${app.id}_sp`, 'user-1');
    await addRc(app.id, `${app.id}_sr`, now, 'install-stale-1', 'user-1');
    await runDaily(env, now);
    const ids = (await db.prepare('SELECT id FROM installs WHERE app_id = ? ORDER BY id').bind(app.id).all<{ id: string }>()).results.map((r) => r.id);
    expect(ids).toEqual(['install-fresh-1', 'install-live-01']);
    expect(await row1('SELECT install_id, app_user_id, matched_by, amount FROM payments WHERE id = ?', `${app.id}_sp`)).toEqual({
      install_id: null, app_user_id: null, matched_by: 'erased', amount: 700,
    });
    expect(await row1('SELECT install_id, app_user_id FROM rc_events WHERE id = ?', `${app.id}_sr`)).toEqual({ install_id: null, app_user_id: null });
  });

  it('deletes rc_events older than 30 days', async () => {
    const now = Date.now();
    const app = await createApp(cookie);
    await addRc(app.id, `${app.id}_old`, now - 31 * DAY, null, null);
    await addRc(app.id, `${app.id}_new`, now - 29 * DAY, null, null);
    await runDaily(env, now);
    const rows = (await db.prepare('SELECT id FROM rc_events WHERE app_id = ?').bind(app.id).all<{ id: string }>()).results.map((r) => r.id);
    expect(rows).toEqual([`${app.id}_new`]);
  });

  it('retries pending ASA tokens younger than 24h and clears expired ones without fetching', async () => {
    const now = Date.now();
    const app = await createApp(cookie);
    await addInstall(app.id, 'install-live-asa', now);
    await addInstall(app.id, 'install-exp-asa1', now);
    const pend = (id: string, until: number) =>
      db.prepare('UPDATE installs SET asa_pending_token = ?, asa_pending_until = ? WHERE app_id = ? AND id = ?').bind(`tok-${id}`, until, app.id, id).run();
    await pend('install-live-asa', now + DAY / 2);
    await pend('install-exp-asa1', now - 1000);
    const calls: string[] = [];
    const fetchFn = (async (_u: unknown, init?: RequestInit) => {
      calls.push(String(init?.body));
      return new Response(JSON.stringify({ attribution: true, campaignId: 123, adGroupId: 4, keywordId: 5 }), { status: 200 });
    }) as unknown as typeof fetch;
    await runDaily(env, now, fetchFn);
    expect(calls).toEqual(['tok-install-live-asa']);
    const row = (id: string) => db.prepare('SELECT * FROM installs WHERE app_id = ? AND id = ?').bind(app.id, id).first<Record<string, unknown>>();
    const live = await row('install-live-asa');
    expect(live).toMatchObject({ asa_pending_token: null, asa_pending_until: null, attribution_method: 'search_ads', asa_campaign_id: '123' });
    expect(await row('install-exp-asa1')).toMatchObject({ asa_pending_token: null, asa_pending_until: null });
  });

  it('keeps the token when Apple says retry', async () => {
    const now = Date.now();
    const app = await createApp(cookie);
    await addInstall(app.id, 'install-retry-1', now);
    await db.prepare('UPDATE installs SET asa_pending_token = ?, asa_pending_until = ? WHERE app_id = ?').bind('tok', now + DAY / 2, app.id).run();
    await runDaily(env, now, (async () => new Response('', { status: 500 })) as unknown as typeof fetch);
    expect(await db.prepare('SELECT asa_pending_token AS t FROM installs WHERE app_id = ?').bind(app.id).first('t')).toBe('tok');
  });

  it('rematches unmatched payments from the last 7 days', async () => {
    const now = Date.now();
    const app = await createApp(cookie);
    await insertPayment(db, app.id, { id: `${app.id}_rm`, ts: now - DAY, amount: 999 }).run();
    await addRc(app.id, `${app.id}_rm`, now - DAY, null, 'user-late');
    await db.prepare('UPDATE payments SET app_user_id = ? WHERE id = ?').bind('user-late', `${app.id}_rm`).run();
    await addInstall(app.id, 'install-late-01', now, 'user-late');
    await runDaily(env, now);
    expect(await row1('SELECT install_id, matched_by FROM payments WHERE id = ?', `${app.id}_rm`)).toEqual({ install_id: 'install-late-01', matched_by: 'user_id' });
  });

  it('an error in one app does not stop the next', async () => {
    const now = Date.now();
    const a = await createApp(cookie);
    const b = await createApp(cookie);
    await addRc(b.id, `${b.id}_old`, now - 31 * DAY, null, null);
    const failing = {
      prepare: (sql: string) => {
        const stmt = db.prepare(sql);
        return new Proxy(stmt, {
          get: (t, k) => {
            if (k === 'bind') return (...args: unknown[]) => { if (args[0] === a.id) throw new Error('boom'); return t.bind(...args); };
            const v = (t as unknown as Record<string | symbol, unknown>)[k];
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
          },
        });
      },
      batch: (s: D1PreparedStatement[]) => db.batch(s),
    } as unknown as D1Database;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runDaily({ ...env, DB: failing } as Env, now);
    expect(await n('SELECT COUNT(*) AS n FROM rc_events WHERE app_id = ?', b.id)).toBe(0);
    expect(err).toHaveBeenCalledWith('daily run failed for app', a.id, 'boom');
  });

  it('stops at the query budget and serves the remaining apps on the next hourly run', async () => {
    const now = Date.now();
    for (let i = 0; i < 6; i++) await createApp(cookie);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const served = () => n("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'cron_last_run:%'");
    await runDaily(env, now, undefined, 35);
    expect(warn).toHaveBeenCalledWith('daily run budget reached');
    const first = await served();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(6);
    await runDaily(env, now + HOUR, undefined, 35);
    expect(await served()).toBe(6);
  });

  it('skips an app processed less than 23 h ago', async () => {
    const now = Date.now();
    const app = await createApp(cookie);
    await addRc(app.id, `${app.id}_old`, now - 31 * DAY, null, null);
    await runDaily(env, now);
    await addRc(app.id, `${app.id}_old2`, now - 31 * DAY, null, null);
    await runDaily(env, now + 22 * HOUR);
    expect(await n('SELECT COUNT(*) AS n FROM rc_events WHERE app_id = ?', app.id)).toBe(1);
    await runDaily(env, now + 23 * HOUR);
    expect(await n('SELECT COUNT(*) AS n FROM rc_events WHERE app_id = ?', app.id)).toBe(0);
  });

  it('processes the least recently processed app first, missing keys before any', async () => {
    const now = Date.now();
    const a = await createApp(cookie);
    const b = await createApp(cookie);
    const c = await createApp(cookie);
    const setLast = (id: string, ts: number) => db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').bind(`cron_last_run:${id}`, String(ts)).run();
    await setLast(a.id, now - 30 * HOUR);
    await setLast(b.id, now - 40 * HOUR);
    // c has no key. Budget of 13 fits the 2 setup queries plus exactly one idle app (11).
    for (const x of [a, b, c]) await addRc(x.id, `${x.id}_old`, now - 31 * DAY, null, null);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runDaily(env, now, undefined, 13);
    expect(await n('SELECT COUNT(*) AS n FROM rc_events WHERE app_id = ?', c.id)).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM rc_events WHERE app_id = ?', b.id)).toBe(1);
    await runDaily(env, now + HOUR, undefined, 13);
    expect(await n('SELECT COUNT(*) AS n FROM rc_events WHERE app_id = ?', b.id)).toBe(0);
    expect(await n('SELECT COUNT(*) AS n FROM rc_events WHERE app_id = ?', a.id)).toBe(1);
  });

  it('a 404 from Apple in cron keeps the token after exactly one fetch and never sleeps', async () => {
    const now = Date.now();
    const app = await createApp(cookie);
    await addInstall(app.id, 'install-404-asa1', now);
    await db.prepare('UPDATE installs SET asa_pending_token = ?, asa_pending_until = ? WHERE app_id = ?').bind('tok404', now + DAY / 2, app.id).run();
    let fetches = 0;
    const timers = vi.spyOn(globalThis, 'setTimeout');
    await runDaily(env, now, (async () => { fetches++; return new Response('', { status: 404 }); }) as unknown as typeof fetch);
    expect(fetches).toBe(1);
    expect(timers.mock.calls.filter(([, ms]) => ms === 5000)).toHaveLength(0);
    expect(await db.prepare('SELECT asa_pending_token AS t FROM installs WHERE app_id = ?').bind(app.id).first('t')).toBe('tok404');
  });

  it('the scheduled handler still runs runDaily when the login-failure purge throws', async () => {
    const now = Date.now();
    const app = await createApp(cookie);
    await addRc(app.id, `${app.id}_old`, now - 31 * DAY, null, null);
    const wrapped = {
      ...env,
      DB: {
        prepare: (sql: string) => {
          if (sql.includes('login_failures')) throw new Error('purge boom');
          return db.prepare(sql);
        },
        batch: (s: D1PreparedStatement[]) => db.batch(s),
      },
    } as unknown as Env;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: now, cron: '0 * * * *' }), wrapped, ctx);
    await waitOnExecutionContext(ctx);
    expect(await n('SELECT COUNT(*) AS n FROM rc_events WHERE app_id = ?', app.id)).toBe(0);
  });
});
