import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { BACKOFF_MS, dispatch, dispatchDue, MAX_ATTEMPTS, redact, tokenContext } from '../src/integrations/dispatch';
import { enqueuePostbacks, installSourceId, madidContext, transientContext } from '../src/integrations/enqueue';
import { registerAdapter } from '../src/integrations/registry';
import { forgetIntegrations } from '../src/integrations/store';
import type { Classified, OutboxEvent, PostbackAdapter, SendContext, SourceEvent } from '../src/integrations/types';
import { open, parseKeys, seal } from '../src/lib/sealed';
import { createApp, login } from './helpers';

const db = env.DB;
const keys = parseKeys(env as Env)!;
const DAY = 86_400_000;
const TOKEN = 'TOKEN-abc123-secret';
const IDFA = '6D92078A-8246-4BA4-AE5B-76104861E7DC';

/** A network that records what it was asked to send. */
const sentBatches: Array<{ ctx: SendContext; events: OutboxEvent[] }> = [];
const fake: PostbackAdapter = {
  provider: 'fake',
  maxBatch: 2,
  allowedHosts: ['fake.example'],
  isAttributedTo: (i) => i.utm_source === 'fake',
  async buildRequest(ctx, events) {
    sentBatches.push({ ctx, events });
    return { url: `https://fake.example/events?access_token=${ctx.token}`, init: { method: 'POST', body: JSON.stringify(events.map((e) => e.sourceEventId)) } };
  },
  classify(status, body): Classified {
    if (status >= 200 && status < 300) return { outcome: 'sent' };
    if (status === 429 || status >= 500) return { outcome: 'retry', error: `http ${status}` };
    const code = (body as { code?: number } | null)?.code;
    return { outcome: 'fatal', error: `http ${status} code ${code} token=${TOKEN}`, integrationError: code === 190 };
  },
};

let cookie: string;
beforeAll(async () => {
  cookie = await login();
  registerAdapter(fake);
});
beforeEach(async () => {
  sentBatches.length = 0;
  await db.batch(['postback_outbox', 'integrations', 'integration_mappings', 'installs'].map((t) => db.prepare(`DELETE FROM ${t}`)));
});

let seq = 0;
async function setup(opts: { scope?: 'all' | 'attributed'; status?: string; testCode?: string; consent?: number | null; platform?: string; att?: string } = {}) {
  const app = await createApp(cookie);
  const integrationId = `int-${++seq}`;
  const now = Date.now();
  const config = JSON.stringify(opts.testCode ? { test_event_code: opts.testCode } : {});
  await db.batch([
    db
      .prepare(
        `INSERT INTO integrations (id, app_id, provider, status, send_scope, config, capi_token_enc, created_at, updated_at)
         VALUES (?, ?, 'fake', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(integrationId, app.id, opts.status ?? 'active', opts.scope ?? 'all', config, await seal(keys, TOKEN, tokenContext(integrationId)), now, now),
    ...[
      ['install', 'fake_install', 0],
      ['rc_trial_converted', 'Purchase', 1],
      ['level_up', 'Achievement', 0],
    ].map(([s, t, v]) =>
      db.prepare('INSERT INTO integration_mappings (app_id, integration_id, source_event, target_event, send_value, locked) VALUES (?, ?, ?, ?, ?, 0)').bind(app.id, integrationId, s, t, v),
    ),
    db
      .prepare(
        `INSERT INTO installs (app_id, id, platform, first_seen, last_seen, ad_consent, att_status, madid_enc, utm_source, source, channel)
         VALUES (?, 'inst-1', ?, ?, ?, ?, ?, ?, 'other', 'Other', 'Referral')`,
      )
      .bind(app.id, opts.platform ?? 'ios', now - 1000, now, opts.consent === undefined ? 1 : opts.consent, opts.att ?? 'authorized',
            await seal(keys, IDFA, madidContext(app.id, 'inst-1')), ),
  ]);
  forgetIntegrations(app.id);
  return { app, integrationId, now };
}

const ev = (name: string, extra: Partial<SourceEvent> = {}): SourceEvent => ({ id: `src-${name}-${++seq}`, installId: 'inst-1', name, ts: Date.now() - 500, ...extra });
const outbox = (appId: string) => db.prepare('SELECT * FROM postback_outbox WHERE app_id = ? ORDER BY created_at, id').bind(appId).all<Record<string, unknown>>().then((r) => r.results);
const okFetch = (status = 200, body: unknown = { ok: true }) => {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
};

describe('enqueuePostbacks', () => {
  it('queues mapped events once, with value only where the mapping sends it', async () => {
    const { app, now } = await setup();
    const events = [ev('level_up'), ev('rc_trial_converted', { valueCents: 999 }), ev('unmapped')];
    const ids = await enqueuePostbacks(db, keys, app.id, events, now);
    expect(ids).toHaveLength(2);
    expect(await enqueuePostbacks(db, keys, app.id, events, now)).toEqual([]); // dedup
    const rows = await outbox(app.id);
    expect(rows.map((r) => [r.target_event, r.value_cents, r.currency, r.status])).toEqual(
      expect.arrayContaining([['Achievement', null, null, 'pending'], ['Purchase', 999, 'USD', 'pending']]),
    );
  });

  it('uses the install first_seen for the install event and a stable id', async () => {
    const { app, now } = await setup();
    await enqueuePostbacks(db, keys, app.id, [{ id: installSourceId('inst-1'), installId: 'inst-1', name: 'install', ts: null }], now);
    const [row] = await outbox(app.id);
    expect(row).toMatchObject({ source_event_id: 'install_inst-1', target_event: 'fake_install', event_ts: now - 1000 });
  });

  it('queues nothing without ad consent', async () => {
    for (const consent of [0, null]) {
      const { app, now } = await setup({ consent });
      expect(await enqueuePostbacks(db, keys, app.id, [ev('level_up')], now)).toEqual([]);
    }
  });

  it('skips inactive integrations, old events and sandbox events without a test code', async () => {
    const draft = await setup({ status: 'draft' });
    expect(await enqueuePostbacks(db, keys, draft.app.id, [ev('level_up')], draft.now)).toEqual([]);

    const { app, now } = await setup();
    expect(await enqueuePostbacks(db, keys, app.id, [ev('level_up', { ts: now - 8 * DAY })], now)).toEqual([]);
    expect(await enqueuePostbacks(db, keys, app.id, [ev('rc_trial_converted', { sandbox: true })], now)).toEqual([]);

    const testing = await setup({ testCode: 'TEST123' });
    expect(await enqueuePostbacks(db, keys, testing.app.id, [ev('rc_trial_converted', { sandbox: true })], testing.now)).toHaveLength(1);
  });

  it("send_scope 'attributed' only queues installs the network brought", async () => {
    const { app, now } = await setup({ scope: 'attributed' });
    expect(await enqueuePostbacks(db, keys, app.id, [ev('level_up')], now)).toEqual([]);
    await db.prepare(`UPDATE installs SET utm_source = 'fake' WHERE app_id = ?`).bind(app.id).run();
    expect(await enqueuePostbacks(db, keys, app.id, [ev('level_up')], now)).toHaveLength(1);
  });

  it('seals IP and user agent only for ATT authorized (iOS) or Android', async () => {
    const t = { ip: '198.51.100.4', ua: 'App/1 CFNetwork' };
    const ok = await setup({ att: 'authorized' });
    const [id] = await enqueuePostbacks(db, keys, ok.app.id, [ev('level_up', { transient: t })], ok.now);
    const row = (await outbox(ok.app.id))[0];
    expect(JSON.stringify(row)).not.toContain('198.51.100.4');
    expect(JSON.parse(await open(keys, row.transient_enc as string, transientContext(id)))).toEqual(t);

    const denied = await setup({ att: 'denied' });
    await enqueuePostbacks(db, keys, denied.app.id, [ev('level_up', { transient: t })], denied.now);
    expect((await outbox(denied.app.id))[0].transient_enc).toBeNull();

    const android = await setup({ platform: 'android', att: undefined });
    await db.prepare('UPDATE installs SET att_status = NULL WHERE app_id = ?').bind(android.app.id).run();
    await enqueuePostbacks(db, keys, android.app.id, [ev('level_up', { transient: t })], android.now);
    expect((await outbox(android.app.id))[0].transient_enc).not.toBeNull();
  });
});

describe('dispatch', () => {
  it('sends in adapter-sized batches with opened secrets and marks rows sent', async () => {
    const { app, now } = await setup();
    const t = { ip: '198.51.100.4', ua: 'UA' };
    const ids = await enqueuePostbacks(db, keys, app.id, [ev('level_up', { transient: t }), ev('level_up'), ev('level_up')], now);
    const f = okFetch();
    expect(await dispatch(env as Env, ids, { fetchFn: f.fn, now })).toEqual({ sent: 3, retry: 0, failed: 0 });
    expect(sentBatches.map((b) => b.events.length)).toEqual([2, 1]);
    expect(sentBatches[0].ctx.token).toBe(TOKEN);
    const all = sentBatches.flatMap((b) => b.events);
    expect(all.every((e) => e.madid === IDFA && e.install?.att_status === 'authorized')).toBe(true);
    expect(all.find((e) => e.transient)?.transient).toEqual(t);
    const rows = await outbox(app.id);
    expect(rows.every((r) => r.status === 'sent' && r.sent_at === now && r.transient_enc === null && r.attempts === 1)).toBe(true);
  });

  it('never sends a row twice, also when two dispatchers race', async () => {
    const { app, now } = await setup();
    const ids = await enqueuePostbacks(db, keys, app.id, [ev('level_up')], now);
    const f = okFetch();
    await Promise.all([dispatch(env as Env, ids, { fetchFn: f.fn, now }), dispatch(env as Env, ids, { fetchFn: f.fn, now })]);
    await dispatch(env as Env, ids, { fetchFn: f.fn, now: now + DAY });
    expect(f.calls).toHaveLength(1);
  });

  it('retries 5xx with backoff and fails after the last attempt', async () => {
    const { app, now } = await setup();
    const ids = await enqueuePostbacks(db, keys, app.id, [ev('level_up')], now);
    expect(await dispatch(env as Env, ids, { fetchFn: okFetch(503).fn, now })).toEqual({ sent: 0, retry: 1, failed: 0 });
    let [row] = await outbox(app.id);
    expect(row).toMatchObject({ status: 'pending', attempts: 1, next_attempt_at: now + BACKOFF_MS[0], last_error: 'http 503' });

    // Not due yet: nothing is sent.
    expect(await dispatch(env as Env, ids, { fetchFn: okFetch().fn, now: now + 1000 })).toEqual({ sent: 0, retry: 0, failed: 0 });

    let t = now;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      t += 13 * 3_600_000;
      await dispatch(env as Env, ids, { fetchFn: okFetch(500).fn, now: t });
    }
    [row] = await outbox(app.id);
    expect(row).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS, next_attempt_at: null });
  });

  it('a credential error fails the batch, flags the integration and never stores the token', async () => {
    const { app, integrationId, now } = await setup();
    const ids = await enqueuePostbacks(db, keys, app.id, [ev('level_up')], now);
    expect(await dispatch(env as Env, ids, { fetchFn: okFetch(400, { code: 190 }).fn, now })).toEqual({ sent: 0, retry: 0, failed: 1 });
    const [row] = await outbox(app.id);
    expect(row.status).toBe('failed');
    expect(String(row.last_error)).not.toContain(TOKEN);
    expect(await db.prepare('SELECT status FROM integrations WHERE id = ?').bind(integrationId).first('status')).toBe('error');
    // The flagged integration no longer queues new events.
    expect(await enqueuePostbacks(db, keys, app.id, [ev('level_up')], now)).toEqual([]);
  });

  it('network errors retry; rows of a disconnected integration fail without a request', async () => {
    const { app, integrationId, now } = await setup();
    const ids = await enqueuePostbacks(db, keys, app.id, [ev('level_up')], now);
    const boom = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await dispatch(env as Env, ids, { fetchFn: boom, now })).toEqual({ sent: 0, retry: 1, failed: 0 });

    await db.prepare(`UPDATE integrations SET status = 'disconnected' WHERE id = ?`).bind(integrationId).run();
    const f = okFetch();
    expect(await dispatch(env as Env, ids, { fetchFn: f.fn, now: now + DAY })).toEqual({ sent: 0, retry: 0, failed: 1 });
    expect(f.calls).toHaveLength(0);
  });

  it('refuses hosts the adapter did not allow', async () => {
    const { app, now } = await setup();
    const ids = await enqueuePostbacks(db, keys, app.id, [ev('level_up')], now);
    const original = fake.buildRequest;
    fake.buildRequest = async () => ({ url: 'https://evil.example/x', init: {} });
    try {
      const f = okFetch();
      expect(await dispatch(env as Env, ids, { fetchFn: f.fn, now })).toEqual({ sent: 0, retry: 0, failed: 1 });
      expect(f.calls).toHaveLength(0);
    } finally {
      fake.buildRequest = original;
    }
  });

  it('without INTEGRATIONS_KEY rows wait (retry) instead of being sent', async () => {
    const { app, now } = await setup();
    const ids = await enqueuePostbacks(db, keys, app.id, [ev('level_up')], now);
    const f = okFetch();
    expect(await dispatch({ ...(env as Env), INTEGRATIONS_KEY: undefined }, ids, { fetchFn: f.fn, now })).toEqual({ sent: 0, retry: 1, failed: 0 });
    expect(f.calls).toHaveLength(0);
  });
});

describe('dispatchDue', () => {
  it('sends due rows, expires rows older than 7 days and purges old log rows', async () => {
    const { app, now } = await setup();
    await enqueuePostbacks(db, keys, app.id, [ev('level_up')], now);
    const ins = (id: string, status: string, eventTs: number, createdAt: number) =>
      db
        .prepare(`INSERT INTO postback_outbox (id, app_id, integration_id, source_event_id, install_id, target_event, event_ts, status, next_attempt_at, created_at)
                  VALUES (?, ?, 'int-x', ?, 'inst-1', 'X', ?, ?, ?, ?)`)
        .bind(id, app.id, `s-${id}`, eventTs, status, createdAt, createdAt)
        .run();
    await ins('old-pending', 'pending', now - 8 * DAY, now - 8 * DAY);
    await ins('old-sent', 'sent', now - 40 * DAY, now - 40 * DAY);

    const f = okFetch();
    expect(await dispatchDue(env as Env, now + 1, 10, { fetchFn: f.fn })).toEqual({ sent: 1, retry: 0, failed: 0 });
    const rows = await outbox(app.id);
    expect(rows.find((r) => r.id === 'old-pending')).toMatchObject({ status: 'failed', last_error: 'expired before delivery' });
    expect(rows.find((r) => r.id === 'old-sent')).toBeUndefined();
  });
});

describe('redact', () => {
  it('removes token-looking query values and the token itself', () => {
    expect(redact(`GET /x?access_token=EAAG123&y=1 failed with EAAG123`, 'EAAG123')).toBe('GET /x?access_token=[redacted]&y=1 failed with [redacted]');
  });
});
