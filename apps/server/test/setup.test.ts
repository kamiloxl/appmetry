import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { SETUP_STEPS, type SetupStatus } from '../src/setup';
import type { AppRow } from '../src/env';
import { call, createApp, login } from './helpers';
import { insertInstall } from './fixtures/seed';

let cookie: string;
beforeAll(async () => {
  cookie = await login();
});

const get = async (app: AppRow) => (await call(`/api/apps/${app.id}/setup`, { cookie })).json<SetupStatus>();
const patch = (app: AppRow, body: unknown) => call(`/api/apps/${app.id}/setup`, { method: 'PATCH', cookie, json: body });
const done = (s: SetupStatus) => SETUP_STEPS.filter((k) => s.steps[k].done);

const addRc = (app: AppRow, id: string, type: string, attr: boolean, ts = Date.now()) =>
  env.DB.prepare('INSERT INTO rc_events (id, app_id, ts, type, has_install_attr) VALUES (?,?,?,?,?)').bind(id, app.id, ts, type, attr ? 1 : 0).run();

describe('GET /api/apps/:id/setup', () => {
  it('requires a session', async () => {
    const app = await createApp(cookie);
    expect((await call(`/api/apps/${app.id}/setup`)).status).toBe(401);
  });

  it('new app: only app done, current firstEvent', async () => {
    const app = await createApp(cookie);
    const s = await get(app);
    expect(done(s)).toEqual(['app']);
    expect(s.current).toBe('firstEvent');
    expect(Object.keys(s.steps)).toEqual([...SETUP_STEPS]);
  });

  it('first batch marks firstEvent with device detail', async () => {
    const app = await createApp(cookie);
    const t = Date.now() - 1000;
    await insertInstall(env.DB, app.id, { id: 'install-0001', platform: 'ios', country: 'GB', source: 'Direct', channel: 'Direct', first_seen: t }).run();
    await insertInstall(env.DB, app.id, { id: 'install-0002', platform: 'android', country: 'GB', source: 'Direct', channel: 'Direct', first_seen: t + 500 }).run();
    const s = await get(app);
    expect(s.steps.firstEvent).toEqual({ done: true, at: t, detail: 'Phone1, ios 17.0' });
    expect(s.current).toBe('revenuecatWebhook');
  });

  it('RevenueCat TEST event marks revenuecatWebhook', async () => {
    const app = await createApp(cookie);
    const t = Date.now() - 5000;
    await addRc(app, `${app.id}-rc1`, 'TEST', false, t);
    const s = await get(app);
    expect(s.steps.revenuecatWebhook).toMatchObject({ done: true, at: t });
    expect(s.steps.revenuecatSync.done).toBe(false);
  });

  it('event with appmetry_install_id marks revenuecatSync', async () => {
    const app = await createApp(cookie);
    await addRc(app, `${app.id}-rc1`, 'INITIAL_PURCHASE', true);
    const s = await get(app);
    expect(s.steps.revenuecatSync.done).toBe(true);
    expect(s.steps.revenuecatWebhook.done).toBe(true);
  });

  it('events of another app do not count', async () => {
    const a = await createApp(cookie);
    const b = await createApp(cookie);
    await addRc(a, `${a.id}-rc1`, 'TEST', true);
    expect(done(await get(b))).toEqual(['app']);
  });

  it('skip revenuecat steps then current is attribution', async () => {
    const app = await createApp(cookie);
    await insertInstall(env.DB, app.id, { id: 'install-0001', platform: 'ios', country: 'GB', source: 'Direct', channel: 'Direct', first_seen: Date.now() }).run();
    expect((await patch(app, { step: 'revenuecatWebhook', state: 'skipped' })).status).toBe(200);
    const res = await patch(app, { step: 'revenuecatSync', state: 'skipped' });
    const s = await res.json<SetupStatus>();
    expect(s.steps.revenuecatWebhook).toMatchObject({ done: false, skipped: true });
    expect(s.current).toBe('attribution');
    expect(await get(app)).toEqual(s);
  });

  it('a skip beats detection, reset restores it', async () => {
    const app = await createApp(cookie);
    await addRc(app, `${app.id}-rc1`, 'TEST', false);
    await patch(app, { step: 'revenuecatWebhook', state: 'skipped' });
    expect((await get(app)).steps.revenuecatWebhook).toMatchObject({ skipped: true });
    const s = await (await patch(app, { step: 'revenuecatWebhook', state: 'reset' })).json<SetupStatus>();
    expect(s.steps.revenuecatWebhook.done).toBe(true);
    expect(s.steps.revenuecatWebhook.skipped).toBeUndefined();
    const row = await env.DB.prepare('SELECT setup_state FROM apps WHERE id = ?').bind(app.id).first<string>('setup_state');
    expect(JSON.parse(row ?? '{}')).toEqual({});
  });

  it('PATCH privacy done completes setup: current null', async () => {
    const app = await createApp(cookie);
    await insertInstall(env.DB, app.id, { id: 'install-0001', platform: 'ios', country: 'GB', source: 'Direct', channel: 'Direct', first_seen: Date.now() }).run();
    await addRc(app, `${app.id}-rc1`, 'INITIAL_PURCHASE', true);
    await patch(app, { step: 'attribution', state: 'done' });
    const s = await (await patch(app, { step: 'privacy', state: 'done' })).json<SetupStatus>();
    expect(s.current).toBeNull();
    expect(done(s)).toEqual([...SETUP_STEPS]);
  });

  it('PATCH unknown step or state is 400', async () => {
    const app = await createApp(cookie);
    expect((await patch(app, { step: 'nope', state: 'done' })).status).toBe(400);
    expect((await patch(app, { step: 'privacy', state: 'maybe' })).status).toBe(400);
    expect((await patch(app, { step: 'app', state: 'skipped' })).status).toBe(400);
    expect((await patch(app, { step: 'app', state: 'done' })).status).toBe(400);
    expect((await call(`/api/apps/${app.id}/setup`, { method: 'PATCH', cookie, body: 'not json' })).status).toBe(400);
    expect((await patch(app, { step: '__proto__', state: 'done' })).status).toBe(400);
  });

  it('setup of another app\'s id is 404', async () => {
    expect((await call('/api/apps/does-not-exist/setup', { cookie })).status).toBe(404);
    expect((await call('/api/apps/does-not-exist/setup', { method: 'PATCH', cookie, json: { step: 'privacy', state: 'done' } })).status).toBe(404);
  });

  it('app stays done even if a stored state says skipped', async () => {
    const app = await createApp(cookie);
    await env.DB.prepare('UPDATE apps SET setup_state = ? WHERE id = ?').bind(JSON.stringify({ app: 'skipped' }), app.id).run();
    const s = await get(app);
    expect(s.steps.app).toMatchObject({ done: true });
    expect(s.steps.app.skipped).toBeUndefined();
    expect(s.current).toBe('firstEvent');
  });

  it('PATCH setup does not touch other app columns', async () => {
    const app = await createApp(cookie, { timezone: 'Europe/London' });
    await patch(app, { step: 'privacy', state: 'done' });
    const row = await env.DB.prepare('SELECT timezone, name FROM apps WHERE id = ?').bind(app.id).first<{ timezone: string; name: string }>();
    expect(row).toEqual({ timezone: 'Europe/London', name: 'Test App' });
  });
});
