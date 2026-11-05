import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { AppRow, Env } from '../src/env';
import { creditedSessionId, matchInstall } from '../src/credit';
import { lifecycleEventName, rcHealth, type RcEvent, rematch } from '../src/revenuecat';
import { BASE, call, createApp, login } from './helpers';
import { rcBody, rcEvent, type RcFixtureEvent, withInstallAttr } from './fixtures/rc';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let cookie: string;
beforeAll(async () => {
  cookie = await login();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fresh app with a RevenueCat webhook secret. */
async function setup(): Promise<{ app: AppRow; secret: string }> {
  const app = await createApp(cookie);
  const res = await call(`/api/apps/${app.id}/rc-secret`, { method: 'POST', cookie });
  const { secret } = await res.json<{ secret: string }>();
  return { app, secret };
}

/** POST a delivery to the webhook. `auth` is the raw Authorization header value (undefined = no header). */
function hook(app: AppRow, auth: string | undefined, event: RcFixtureEvent | unknown, raw?: string) {
  const headers: Record<string, string> = {};
  if (auth !== undefined) headers.authorization = auth;
  return call(`/api/webhooks/revenuecat/${app.id}`, {
    method: 'POST',
    headers,
    ...(raw !== undefined ? { body: raw } : { json: rcBody(event as RcFixtureEvent) }),
  });
}

async function addInstall(app: AppRow, id: string, patch: { user_id?: string; last_seen?: number; first_seen?: number } = {}) {
  const now = Date.now();
  await env.DB.prepare('INSERT INTO installs (app_id, id, first_seen, last_seen, user_id, source, channel) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(app.id, id, patch.first_seen ?? now - 10 * DAY, patch.last_seen ?? now - DAY, patch.user_id ?? null, 'App Store', 'Organic')
    .run();
}

async function addSession(app: AppRow, id: string, installId: string, startedAt: number, channel: string) {
  await env.DB.prepare(
    'INSERT INTO sessions (app_id, id, install_id, started_at, last_seen_at, source, channel) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(app.id, id, installId, startedAt, startedAt + 60_000, channel === 'Direct' ? 'Direct' : 'newsletter', channel)
    .run();
}

const payment = (id: string) => env.DB.prepare('SELECT * FROM payments WHERE id = ?').bind(id).first<Record<string, unknown>>();
const rcRow = (id: string) => env.DB.prepare('SELECT * FROM rc_events WHERE id = ?').bind(id).first<Record<string, unknown>>();
const lifecycle = (app: AppRow, eventId: string) =>
  env.DB.prepare('SELECT * FROM events WHERE app_id = ? AND id = ?').bind(app.id, `rc_${eventId}`).first<Record<string, unknown>>();
const count = (sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).first<number>('n');

describe('POST /api/webhooks/revenuecat/:appId: auth and dedup', () => {
  it('401 without or with wrong Authorization', async () => {
    const { app, secret } = await setup();
    const ev = rcEvent();
    expect((await hook(app, undefined, ev)).status).toBe(401);
    expect((await hook(app, 'wrong-secret', ev)).status).toBe(401);
    expect((await hook(app, `Bearer ${secret}x`, ev)).status).toBe(401);
    expect(await count('SELECT COUNT(*) AS n FROM rc_events WHERE app_id = ?', app.id)).toBe(0);

    // Accepts the secret as is, or with a Bearer prefix.
    expect((await hook(app, secret, ev)).status).toBe(200);
    expect((await hook(app, `Bearer ${secret}`, rcEvent())).status).toBe(200);

    // An app with no secret set, or an unknown app, is 401 too.
    const bare = await createApp(cookie);
    expect((await hook(bare, '', rcEvent())).status).toBe(401);
    expect((await hook(bare, 'anything', rcEvent())).status).toBe(401);
    expect((await hook({ ...app, id: 'no-such-app-000' }, secret, rcEvent())).status).toBe(401);
  });

  it('400 for invalid JSON or a missing event id/type, 413 above 256 KB', async () => {
    const { app, secret } = await setup();
    expect((await hook(app, secret, null, '{not json')).status).toBe(400);
    expect((await hook(app, secret, null, JSON.stringify({ api_version: '1.0' }))).status).toBe(400);
    expect((await hook(app, secret, null, JSON.stringify({ event: { type: 'RENEWAL' } }))).status).toBe(400);
    expect((await hook(app, secret, null, JSON.stringify({ event: { id: 'x-1' } }))).status).toBe(400);
    const big = JSON.stringify(rcBody(rcEvent({ padding: 'x'.repeat(300_000) })));
    expect((await hook(app, secret, null, big)).status).toBe(413);
  });

  it('TEST event returns 200, is logged in rc_events, stores no payment or event, and is excluded from rcHealth', async () => {
    const { app, secret } = await setup();
    await addInstall(app, 'install-test-01');
    const ev = withInstallAttr(rcEvent({ type: 'TEST' }), 'install-test-01');
    const res = await hook(app, secret, ev);
    expect(res.status).toBe(200);
    expect(await rcRow(ev.id)).toMatchObject({ app_id: app.id, type: 'TEST', environment: 'PRODUCTION' });
    expect(await payment(ev.id)).toBeNull();
    expect(await count('SELECT COUNT(*) AS n FROM events WHERE app_id = ?', app.id)).toBe(0);
    expect(await rcHealth(env.DB, app.id, Date.now())).toEqual({
      lastEventAt: null,
      events24h: 0,
      withInstallId24h: 0,
      matched24h: 0,
      warning: false,
    });
  });

  it('duplicate id returns 200 once stored', async () => {
    const { app, secret } = await setup();
    const ev = rcEvent();
    const first = await hook(app, secret, ev);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    const again = await hook(app, secret, { ...ev, price: 99.99 });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(await count('SELECT COUNT(*) AS n FROM payments WHERE id = ?', ev.id)).toBe(1);
    expect((await payment(ev.id))!.amount).toBe(999);
  });
});

describe('RevenueCat webhook: what gets stored', () => {
  it('INITIAL_PURCHASE price 9.99 stores 999 cents payment', async () => {
    const { app, secret } = await setup();
    const ev = rcEvent({ environment: 'SANDBOX' });
    expect((await hook(app, secret, ev)).status).toBe(200);
    expect(await payment(ev.id)).toMatchObject({
      app_id: app.id,
      ts: ev.purchased_at_ms,
      kind: 'payment',
      amount: 999,
      event_type: 'INITIAL_PURCHASE',
      product_id: 'pro_monthly',
      store: 'APP_STORE',
      environment: 'SANDBOX',
      app_user_id: ev.app_user_id,
      install_id: null,
      session_id: null,
      matched_by: 'none',
      renewal: 0,
    });
    expect(await rcRow(ev.id)).toMatchObject({ ts: ev.event_timestamp_ms, type: 'INITIAL_PURCHASE', environment: 'SANDBOX' });
  });

  it('environment defaults to PRODUCTION; ts falls back to event_timestamp_ms', async () => {
    const { app, secret } = await setup();
    const ev = rcEvent({ type: 'NON_RENEWING_PURCHASE', price: 4.5 });
    delete ev.environment;
    delete ev.purchased_at_ms;
    await hook(app, secret, ev);
    expect(await payment(ev.id)).toMatchObject({ environment: 'PRODUCTION', ts: ev.event_timestamp_ms, amount: 450 });
  });

  it('RENEWAL sets renewal = 1', async () => {
    const { app, secret } = await setup();
    const ev = rcEvent({ type: 'RENEWAL', price: 12.49 });
    await hook(app, secret, ev);
    expect(await payment(ev.id)).toMatchObject({ kind: 'payment', amount: 1249, renewal: 1, event_type: 'RENEWAL' });
  });

  it('CANCELLATION with cancel_reason CUSTOMER_SUPPORT and price -9.99 stores refund -999', async () => {
    const { app, secret } = await setup();
    const ev = rcEvent({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', price: -9.99 });
    await hook(app, secret, ev);
    expect(await payment(ev.id)).toMatchObject({ kind: 'refund', amount: -999, renewal: 0, event_type: 'CANCELLATION' });

    // A refund is negative even if RevenueCat sends a positive price.
    const pos = rcEvent({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', price: 9.99 });
    await hook(app, secret, pos);
    expect(await payment(pos.id)).toMatchObject({ kind: 'refund', amount: -999 });
  });

  it('refund ts is event_timestamp_ms when both timestamps are present; other payments use purchased_at_ms', async () => {
    const { app, secret } = await setup();
    const now = Date.now();
    const refund = rcEvent({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', price: -9.99, purchased_at_ms: now - 20 * DAY, event_timestamp_ms: now - HOUR });
    await hook(app, secret, refund);
    expect(await payment(refund.id)).toMatchObject({ kind: 'refund', ts: now - HOUR });
    const buy = rcEvent({ purchased_at_ms: now - 2 * HOUR, event_timestamp_ms: now - HOUR });
    await hook(app, secret, buy);
    expect(await payment(buy.id)).toMatchObject({ kind: 'payment', ts: now - 2 * HOUR });
  });

  it('refund credit uses the refund time', async () => {
    const { app, secret } = await setup();
    const now = Date.now();
    await addInstall(app, 'install-refund1');
    await addSession(app, 'session-before1', 'install-refund1', now - 20 * DAY, 'Email');
    await addSession(app, 'session-after-1', 'install-refund1', now - 5 * DAY, 'Paid');
    const refund = withInstallAttr(
      rcEvent({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', price: -9.99, purchased_at_ms: now - 10 * DAY, event_timestamp_ms: now - HOUR }),
      'install-refund1',
    );
    await hook(app, secret, refund);
    expect(await payment(refund.id)).toMatchObject({ session_id: 'session-after-1' });
  });

  it("a refund's price_usd is negative and matches the amount", async () => {
    const { app, secret } = await setup();
    await addInstall(app, 'install-refund2');
    const refund = withInstallAttr(rcEvent({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT', price: 9.99 }), 'install-refund2');
    await hook(app, secret, refund);
    const row = await lifecycle(app, refund.id);
    expect(row).toMatchObject({ name: 'rc_refunded' });
    expect(JSON.parse(row!.props as string).price_usd).toBe(-9.99);
    expect((await payment(refund.id))!.amount).toBe(-999);
  });

  it('CANCELLATION UNSUBSCRIBE stores no payment but an rc_subscription_cancelled event with props.reason', async () => {
    const { app, secret } = await setup();
    await addInstall(app, 'install-cancel-1');
    const ev = withInstallAttr(rcEvent({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE', price: 0 }), 'install-cancel-1');
    expect((await hook(app, secret, ev)).status).toBe(200);
    expect(await payment(ev.id)).toBeNull();
    const row = await lifecycle(app, ev.id);
    expect(row).toMatchObject({ name: 'rc_subscription_cancelled', install_id: 'install-cancel-1', type: 'event' });
    expect(JSON.parse(row!.props as string)).toEqual({ product_id: 'pro_monthly', store: 'APP_STORE', price_usd: 0, reason: 'UNSUBSCRIBE' });
  });

  it('INITIAL_PURCHASE TRIAL price 0 stores rc_trial_started event, no payment', async () => {
    const { app, secret } = await setup();
    await addInstall(app, 'install-trial-1');
    const ev = withInstallAttr(rcEvent({ period_type: 'TRIAL', price: 0 }), 'install-trial-1');
    await hook(app, secret, ev);
    expect(await payment(ev.id)).toBeNull();
    expect(await lifecycle(app, ev.id)).toMatchObject({ name: 'rc_trial_started' });
  });

  it('price null stores amount 0 and logs nothing personal', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const { app, secret } = await setup();
    await addInstall(app, 'install-null-01');
    const ev = withInstallAttr(rcEvent({ price: null, app_user_id: 'user-secret-77' }), 'install-null-01');
    const res = await hook(app, secret, ev);
    expect(res.status).toBe(200);
    expect(await payment(ev.id)).toMatchObject({ amount: 0, kind: 'payment' });
    expect(JSON.parse((await lifecycle(app, ev.id))!.props as string).price_usd).toBe(0);

    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    for (const secretBit of ['jane.doe@example.com', 'Jane Doe', secret, 'user-secret-77']) expect(logged).not.toContain(secretBit);

    // Nothing from subscriber_attributes other than the install id is stored.
    const stored = JSON.stringify([
      await payment(ev.id),
      await rcRow(ev.id),
      await lifecycle(app, ev.id),
      await env.DB.prepare('SELECT email, name FROM installs WHERE app_id = ?').bind(app.id).all(),
    ]);
    expect(stored).not.toContain('jane.doe@example.com');
    expect(stored).not.toContain('Jane Doe');
  });
});

describe('RevenueCat lifecycle events', () => {
  const name = (patch: Partial<RcEvent>) => lifecycleEventName({ id: 'x', type: 'INITIAL_PURCHASE', ...patch } as RcEvent);

  it('lifecycleEventName covers every row of the spec mapping table', () => {
    expect(name({ type: 'INITIAL_PURCHASE', period_type: 'TRIAL' })).toBe('rc_trial_started');
    expect(name({ type: 'INITIAL_PURCHASE', period_type: 'INTRO' })).toBe('rc_intro_started');
    expect(name({ type: 'INITIAL_PURCHASE', period_type: 'NORMAL' })).toBe('rc_subscription_started');
    expect(name({ type: 'INITIAL_PURCHASE', period_type: 'PROMOTIONAL' })).toBe('rc_subscription_started');
    expect(name({ type: 'RENEWAL', is_trial_conversion: true })).toBe('rc_trial_converted');
    expect(name({ type: 'RENEWAL', is_trial_conversion: false })).toBe('rc_subscription_renewed');
    expect(name({ type: 'NON_RENEWING_PURCHASE' })).toBe('rc_in_app_purchase');
    expect(name({ type: 'CANCELLATION', cancel_reason: 'CUSTOMER_SUPPORT' })).toBe('rc_refunded');
    expect(name({ type: 'CANCELLATION', cancel_reason: 'UNSUBSCRIBE' })).toBe('rc_subscription_cancelled');
    expect(name({ type: 'CANCELLATION', cancel_reason: 'BILLING_ERROR' })).toBe('rc_subscription_cancelled');
    expect(name({ type: 'UNCANCELLATION' })).toBe('rc_subscription_uncancelled');
    expect(name({ type: 'BILLING_ISSUE' })).toBe('rc_billing_issue');
    expect(name({ type: 'EXPIRATION' })).toBe('rc_subscription_expired');
    expect(name({ type: 'PRODUCT_CHANGE' })).toBe('rc_product_changed');
    expect(name({ type: 'TRANSFER' })).toBeNull();
    expect(name({ type: 'TEST' })).toBeNull();
    expect(name({ type: 'SUBSCRIPTION_PAUSED' })).toBeNull();
  });

  it('matched event is stored with id rc_<event id>, session_id null, props product_id/store/price_usd', async () => {
    const { app, secret } = await setup();
    await addInstall(app, 'install-life-01');
    const ev = withInstallAttr(rcEvent({ type: 'RENEWAL', is_trial_conversion: true, price: 19.99, store: 'PLAY_STORE' }), 'install-life-01');
    await hook(app, secret, ev);
    const row = await lifecycle(app, ev.id);
    expect(row).toMatchObject({
      id: `rc_${ev.id}`,
      type: 'event',
      name: 'rc_trial_converted',
      session_id: null,
      install_id: 'install-life-01',
      ts: ev.event_timestamp_ms,
    });
    expect(JSON.parse(row!.props as string)).toEqual({ product_id: 'pro_monthly', store: 'PLAY_STORE', price_usd: 19.99 });
  });

  it('unmatched event writes rc_events only', async () => {
    const { app, secret } = await setup();
    const ev = rcEvent({ type: 'EXPIRATION', price: null });
    await hook(app, secret, ev);
    expect(await rcRow(ev.id)).toMatchObject({
      type: 'EXPIRATION',
      install_id: null,
      has_install_attr: 0,
      app_user_id: ev.app_user_id,
      lifecycle_name: 'rc_subscription_expired',
    });
    expect(JSON.parse((await rcRow(ev.id))!.lifecycle_props as string)).toEqual({ product_id: 'pro_monthly', store: 'APP_STORE', price_usd: 0 });
    expect(await payment(ev.id)).toBeNull();
    expect(await count('SELECT COUNT(*) AS n FROM events WHERE app_id = ?', app.id)).toBe(0);
  });

  it('every delivery is logged once in rc_events, including ignored types', async () => {
    const { app, secret } = await setup();
    await addInstall(app, 'install-log-001');
    const evs = ['TRANSFER', 'SUBSCRIPTION_PAUSED', 'SOME_FUTURE_TYPE', 'BILLING_ISSUE'].map((type) =>
      withInstallAttr(rcEvent({ type }), 'install-log-001'),
    );
    for (const ev of evs) {
      expect((await hook(app, secret, ev)).status).toBe(200);
      expect((await hook(app, secret, ev)).status).toBe(200);
    }
    expect(await count('SELECT COUNT(*) AS n FROM rc_events WHERE app_id = ?', app.id)).toBe(4);
    expect(await count('SELECT COUNT(*) AS n FROM payments WHERE app_id = ?', app.id)).toBe(0);
    // Only BILLING_ISSUE has a lifecycle name.
    const names = await env.DB.prepare('SELECT name FROM events WHERE app_id = ?').bind(app.id).all<{ name: string }>();
    expect(names.results.map((r) => r.name)).toEqual(['rc_billing_issue']);
    expect(await rcRow(evs[0].id)).toMatchObject({ install_id: 'install-log-001', has_install_attr: 1 });
  });
});

describe('RevenueCat integration health', () => {
  it('rcHealth counts last 24h production events, share with appdash_install_id and share matched', async () => {
    const { app, secret } = await setup();
    await addInstall(app, 'install-health1');
    const now = Date.now();
    const deliveries = [
      withInstallAttr(rcEvent({ event_timestamp_ms: now - HOUR }), 'install-health1'), // attr + matched
      withInstallAttr(rcEvent({ event_timestamp_ms: now - 2 * HOUR }), 'no-such-install'), // attr, unmatched
      rcEvent({ event_timestamp_ms: now - 3 * HOUR, app_user_id: 'install-health1' }), // no attr, matched by install id
      rcEvent({ event_timestamp_ms: now - 4 * HOUR }), // neither
      withInstallAttr(rcEvent({ event_timestamp_ms: now - 30 * HOUR }), 'install-health1'), // older than 24 h
      withInstallAttr(rcEvent({ event_timestamp_ms: now - 10 * 60_000, environment: 'SANDBOX' }), 'install-health1'), // sandbox
      rcEvent({ type: 'TEST', event_timestamp_ms: now - 60_000 }), // test
    ];
    for (const ev of deliveries) expect((await hook(app, secret, ev)).status).toBe(200);

    expect(await rcHealth(env.DB, app.id, now)).toEqual({
      lastEventAt: now - 10 * 60_000, // sandbox counts for "last event", TEST does not
      events24h: 4,
      withInstallId24h: 2,
      matched24h: 2,
      warning: false,
    });

    const res = await call(`/api/apps/${app.id}/revenuecat/health`, { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ events24h: 4, withInstallId24h: 2, matched24h: 2, warning: false });
    expect((await call(`/api/apps/${app.id}/revenuecat/health`)).status).toBe(401);
    expect((await call('/api/apps/no-such-app-000/revenuecat/health', { cookie })).status).toBe(404);
  });

  it('rcHealth warning is true below 50% with at least one event, false with zero events', async () => {
    const { app, secret } = await setup();
    const now = Date.now();
    expect(await rcHealth(env.DB, app.id, now)).toEqual({
      lastEventAt: null,
      events24h: 0,
      withInstallId24h: 0,
      matched24h: 0,
      warning: false,
    });
    await hook(app, secret, withInstallAttr(rcEvent({ event_timestamp_ms: now - HOUR }), 'some-install-1'));
    await hook(app, secret, rcEvent({ event_timestamp_ms: now - HOUR }));
    await hook(app, secret, rcEvent({ event_timestamp_ms: now - HOUR }));
    const h = await rcHealth(env.DB, app.id, now);
    expect(h).toMatchObject({ events24h: 3, withInstallId24h: 1, warning: true });
    // Exactly 50% is not a warning.
    await hook(app, secret, withInstallAttr(rcEvent({ event_timestamp_ms: now - HOUR }), 'some-install-1'));
    expect((await rcHealth(env.DB, app.id, now)).warning).toBe(false);
  });
});

describe('RevenueCat install matching', () => {
  it('matches by subscriber_attributes.appdash_install_id', async () => {
    const { app, secret } = await setup();
    await addInstall(app, 'install-attr-01');
    await addInstall(app, 'install-attr-02', { user_id: 'user-attr' });
    const ev = withInstallAttr(rcEvent({ app_user_id: 'user-attr' }), 'install-attr-01');
    await hook(app, secret, ev);
    expect(await payment(ev.id)).toMatchObject({ install_id: 'install-attr-01', matched_by: 'attribute' });
    expect(await rcRow(ev.id)).toMatchObject({ install_id: 'install-attr-01', has_install_attr: 1 });

    // An attribute pointing at a missing install falls through to the next steps.
    const miss = withInstallAttr(rcEvent({ app_user_id: 'user-attr' }), 'install-gone-99');
    await hook(app, secret, miss);
    expect(await payment(miss.id)).toMatchObject({ install_id: 'install-attr-02', matched_by: 'user_id' });
  });

  it('matches by aliases equal to installs.user_id', async () => {
    const { app, secret } = await setup();
    await addInstall(app, 'install-alias-1', { user_id: 'user-alias' });
    const ev = rcEvent({ app_user_id: '$RCAnonymousID:abc', original_app_user_id: '$RCAnonymousID:abc', aliases: ['$RCAnonymousID:abc', 'user-alias'] });
    await hook(app, secret, ev);
    expect(await payment(ev.id)).toMatchObject({ install_id: 'install-alias-1', matched_by: 'user_id' });

    const viaOriginal = rcEvent({ app_user_id: '$RCAnonymousID:def', original_app_user_id: 'user-alias', aliases: [] });
    await hook(app, secret, viaOriginal);
    expect(await payment(viaOriginal.id)).toMatchObject({ install_id: 'install-alias-1', matched_by: 'user_id' });
  });

  it('user_id match picks most recent install', async () => {
    const { app, secret } = await setup();
    const now = Date.now();
    await addInstall(app, 'install-old-001', { user_id: 'user-two', last_seen: now - 5 * DAY });
    await addInstall(app, 'install-new-001', { user_id: 'user-two', last_seen: now - HOUR });
    await addInstall(app, 'install-mid-001', { user_id: 'user-two', last_seen: now - 2 * DAY });
    const ev = rcEvent({ app_user_id: 'user-two' });
    await hook(app, secret, ev);
    expect(await payment(ev.id)).toMatchObject({ install_id: 'install-new-001', matched_by: 'user_id' });
  });

  it('matches app_user_id equal to install id', async () => {
    const { app, secret } = await setup();
    await addInstall(app, 'install-as-user');
    const ev = rcEvent({ app_user_id: 'install-as-user' });
    await hook(app, secret, ev);
    expect(await payment(ev.id)).toMatchObject({ install_id: 'install-as-user', matched_by: 'install_id' });
  });

  it('unmatched stores install_id null, matched_by none', async () => {
    const { app, secret } = await setup();
    await addInstall(app, 'install-unmatch', { user_id: 'someone-else' });
    const ev = rcEvent({ app_user_id: 'nobody' });
    await hook(app, secret, ev);
    expect(await payment(ev.id)).toMatchObject({ install_id: null, matched_by: 'none', session_id: null });
  });

  it('all lookups are scoped by app', async () => {
    const { app: other } = await setup();
    await addInstall(other, 'install-other-1', { user_id: 'shared-user' });
    const { app } = await setup();
    expect(await matchInstall(env.DB, app.id, { id: 'e1', type: 'RENEWAL', app_user_id: 'shared-user' } as RcEvent)).toEqual({
      installId: null,
      matchedBy: 'none',
    });
    expect(
      await matchInstall(env.DB, app.id, {
        id: 'e2',
        type: 'RENEWAL',
        app_user_id: 'install-other-1',
        subscriber_attributes: { appdash_install_id: { value: 'install-other-1' } },
      } as RcEvent),
    ).toEqual({ installId: null, matchedBy: 'none' });
  });
});

describe('RevenueCat credit', () => {
  it('credit goes to latest non-direct session before payment, else null', async () => {
    const { app, secret } = await setup();
    const now = Date.now();
    await addInstall(app, 'install-credit1');
    expect(await creditedSessionId(env.DB, app.id, 'install-credit1', now)).toBeNull();

    await addSession(app, 'session-email-1', 'install-credit1', now - 3 * DAY, 'Email');
    await addSession(app, 'session-paid-01', 'install-credit1', now - 2 * DAY, 'Paid');
    await addSession(app, 'session-direct1', 'install-credit1', now - DAY, 'Direct');
    await addSession(app, 'session-later-1', 'install-credit1', now + HOUR, 'Referral');

    expect(await creditedSessionId(env.DB, app.id, 'install-credit1', now)).toBe('session-paid-01');
    expect(await creditedSessionId(env.DB, app.id, 'install-credit1', now - 2.5 * DAY)).toBe('session-email-1');
    expect(await creditedSessionId(env.DB, app.id, 'install-credit1', now - 4 * DAY)).toBeNull();
    // Scoped by app.
    const { app: other } = await setup();
    expect(await creditedSessionId(env.DB, other.id, 'install-credit1', now)).toBeNull();

    // The webhook stores the credit in payments.session_id.
    const ev = withInstallAttr(rcEvent({ purchased_at_ms: now - 1000 }), 'install-credit1');
    await hook(app, secret, ev);
    expect(await payment(ev.id)).toMatchObject({ install_id: 'install-credit1', session_id: 'session-paid-01' });
  });
});

describe('RevenueCat rematch', () => {
  it('rematch links payment after late install', async () => {
    const { app, secret } = await setup();
    const ev = rcEvent({ type: 'RENEWAL', app_user_id: 'late-user-01', price: 4.99 });
    await hook(app, secret, ev);
    expect(await payment(ev.id)).toMatchObject({ install_id: null, matched_by: 'none' });

    // The app sends its first batch, with identify, after RevenueCat already delivered the payment.
    const now = Date.now();
    const context = {
      iid: 'install-late-01',
      platform: 'ios',
      osVersion: '18.1',
      appVersion: '1.2.0',
      build: '42',
      deviceModel: 'iPhone16,1',
      locale: 'en-GB',
      timezone: 'Europe/London',
      sdkVersion: '0.1.0',
      bundleId: 'com.example.app',
    };
    const events = [
      { id: 'late-evt-000001', type: 'install', ts: now - 5000, sid: 'late-session-01' },
      { id: 'late-evt-000002', type: 'identify', ts: now - 4000, sid: 'late-session-01', props: { userId: 'late-user-01' } },
    ];
    const ctx = createExecutionContext();
    const batch = await worker.fetch(
      new Request(BASE + '/api/v1/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-App-Key': app.app_key, 'cf-connecting-ip': '198.51.100.9' },
        body: JSON.stringify({ context, events }),
      }),
      env as Env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(batch.status).toBe(202);

    expect((await call(`/api/apps/${app.id}/payments/rematch`, { method: 'POST' })).status).toBe(401);
    const res = await call(`/api/apps/${app.id}/payments/rematch`, { method: 'POST', cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ matched: 1, remaining: 0 });

    expect(await payment(ev.id)).toMatchObject({ install_id: 'install-late-01', matched_by: 'user_id' });
    expect(await rcRow(ev.id)).toMatchObject({ install_id: 'install-late-01' });
    const row = await lifecycle(app, ev.id);
    expect(row).toMatchObject({ name: 'rc_subscription_renewed', install_id: 'install-late-01', session_id: null, type: 'event' });
    expect(JSON.parse(row!.props as string)).toEqual({ product_id: 'pro_monthly', store: 'APP_STORE', price_usd: 4.99 });

    // Nothing left to match.
    const again = await call(`/api/apps/${app.id}/payments/rematch`, { method: 'POST', cookie });
    expect(await again.json()).toEqual({ matched: 0, remaining: 0 });
    expect((await call('/api/apps/no-such-app-000/payments/rematch', { method: 'POST', cookie })).status).toBe(404);
  });

  it('rematch only considers deliveries since sinceTs', async () => {
    const { app, secret } = await setup();
    const now = Date.now();
    const old = rcEvent({ app_user_id: 'since-user-01', event_timestamp_ms: now - 10 * DAY, purchased_at_ms: now - 10 * DAY });
    const recent = rcEvent({ app_user_id: 'since-user-01', event_timestamp_ms: now - DAY, purchased_at_ms: now - DAY });
    await hook(app, secret, old);
    await hook(app, secret, recent);
    await addInstall(app, 'install-since-1', { user_id: 'since-user-01' });
    expect(await rematch(env.DB, app.id, now - 7 * DAY)).toEqual({ matched: 1, remaining: 0 });
    expect(await payment(recent.id)).toMatchObject({ install_id: 'install-since-1', matched_by: 'user_id' });
    expect(await payment(old.id)).toMatchObject({ install_id: null, matched_by: 'none' });
    expect(await rematch(env.DB, app.id, 0)).toEqual({ matched: 1, remaining: 0 });
  });

  it('rematch is isolated per app', async () => {
    const { app, secret } = await setup();
    const { app: other } = await setup();
    const ev = rcEvent({ app_user_id: 'iso-user-0001' });
    await hook(app, secret, ev);
    await addInstall(other, 'install-iso-001', { user_id: 'iso-user-0001' });
    await addInstall(other, 'iso-user-0001');
    expect(await rematch(env.DB, app.id, 0)).toEqual({ matched: 0, remaining: 0 });
    expect(await rematch(env.DB, other.id, 0)).toEqual({ matched: 0, remaining: 0 });
    expect(await rcRow(ev.id)).toMatchObject({ install_id: null });
  });

  it("rematch sets the payment's session_id credit and matches app_user_id equal to an install id", async () => {
    const { app, secret } = await setup();
    const now = Date.now();
    const ev = rcEvent({ app_user_id: 'install-cred-02', purchased_at_ms: now - HOUR });
    await hook(app, secret, ev);
    await addInstall(app, 'install-cred-02');
    await addSession(app, 'session-cred-01', 'install-cred-02', now - DAY, 'Referral');
    await addSession(app, 'session-cred-02', 'install-cred-02', now - 2 * HOUR, 'Direct');
    expect(await rematch(env.DB, app.id, 0)).toEqual({ matched: 1, remaining: 0 });
    expect(await payment(ev.id)).toMatchObject({ install_id: 'install-cred-02', matched_by: 'install_id', session_id: 'session-cred-01' });
  });

  it('rematch backfills a payment-less rc_trial_started with the exact name', async () => {
    const { app, secret } = await setup();
    const ev = rcEvent({ period_type: 'TRIAL', price: 0, app_user_id: 'trial-user-01' });
    await hook(app, secret, ev);
    expect(await payment(ev.id)).toBeNull();
    await addInstall(app, 'install-trial-2', { user_id: 'trial-user-01' });
    expect(await rematch(env.DB, app.id, 0)).toEqual({ matched: 1, remaining: 0 });
    const row = await lifecycle(app, ev.id);
    expect(row).toMatchObject({ name: 'rc_trial_started', install_id: 'install-trial-2', ts: ev.event_timestamp_ms, session_id: null });
    expect(JSON.parse(row!.props as string)).toEqual({ product_id: 'pro_monthly', store: 'APP_STORE', price_usd: 0 });
    expect(await rcRow(ev.id)).toMatchObject({ install_id: 'install-trial-2' });
  });

  it('rematch backfills rc_trial_converted with the exact name', async () => {
    const { app, secret } = await setup();
    const ev = rcEvent({ type: 'RENEWAL', is_trial_conversion: true, price: 7.99, app_user_id: 'conv-user-01' });
    await hook(app, secret, ev);
    await addInstall(app, 'install-conv-01', { user_id: 'conv-user-01' });
    expect(await rematch(env.DB, app.id, 0)).toEqual({ matched: 1, remaining: 0 });
    const row = await lifecycle(app, ev.id);
    expect(row).toMatchObject({ name: 'rc_trial_converted' });
    expect(JSON.parse(row!.props as string).price_usd).toBe(7.99);
    expect(await payment(ev.id)).toMatchObject({ install_id: 'install-conv-01', renewal: 1 });
  });

  it('$RCAnonymousID: deliveries are never rematch candidates', async () => {
    const { app, secret } = await setup();
    const ev = rcEvent({ app_user_id: '$RCAnonymousID:abc123', original_app_user_id: '$RCAnonymousID:abc123', aliases: [] });
    await hook(app, secret, ev);
    // Even an install carrying that id is not linked by rematch.
    await addInstall(app, 'install-anon-01', { user_id: '$RCAnonymousID:abc123' });
    expect(await rematch(env.DB, app.id, 0)).toEqual({ matched: 0, remaining: 0 });
    expect(await rcRow(ev.id)).toMatchObject({ install_id: null });
  });

  it('rematch respects the limit and reports remaining', async () => {
    const { app, secret } = await setup();
    const now = Date.now();
    const evs = [3, 2, 1].map((h) => rcEvent({ app_user_id: 'limit-user-01', event_timestamp_ms: now - h * HOUR, purchased_at_ms: now - h * HOUR }));
    for (const ev of evs) await hook(app, secret, ev);
    await hook(app, secret, rcEvent({ type: 'TEST', app_user_id: 'limit-user-01' }));
    await addInstall(app, 'install-limit-1', { user_id: 'limit-user-01' });
    expect(await rematch(env.DB, app.id, 0, 2)).toEqual({ matched: 2, remaining: 1 });
    // Oldest first.
    expect(await payment(evs[0].id)).toMatchObject({ install_id: 'install-limit-1' });
    expect(await payment(evs[2].id)).toMatchObject({ install_id: null });
    expect(await rematch(env.DB, app.id, 0, 2)).toEqual({ matched: 1, remaining: 0 });
    expect(await rematch(env.DB, app.id, 0, 2)).toEqual({ matched: 0, remaining: 0 });
  });
});
