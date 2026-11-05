#!/usr/bin/env node
// End-to-end smoke test against a running `wrangler dev` (or a deployed Worker).
// Usage: ADMIN_PASSWORD=... node scripts/smoke.mjs http://localhost:8787
const host = (process.argv[2] ?? '').replace(/\/+$/, '');
const password = process.env.ADMIN_PASSWORD;
if (!host || !password) {
  console.error('usage: ADMIN_PASSWORD=... node scripts/smoke.mjs <host>');
  process.exit(1);
}

// Unique ids per run so the script can be repeated against the same local database.
const run = Date.now().toString(36);
const now = Date.now();
let cookie = '';

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function api(path, { method = 'GET', headers = {}, json } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  if (json !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(host + path, { method, headers: h, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, res };
}

function expectOk(r, what) {
  assert(r.status >= 200 && r.status < 300, `${what} -> HTTP ${r.status} ${typeof r.body === 'string' ? r.body.slice(0, 200) : JSON.stringify(r.body)}`);
  return r.body;
}

try {
  // 1. Log in, create an app.
  const login = await api('/api/auth/login', { method: 'POST', json: { password } });
  expectOk(login, 'login');
  const setCookie = login.res.headers.get('set-cookie') ?? '';
  assert(setCookie.includes('ad_auth='), 'login sets the ad_auth cookie');
  cookie = setCookie.split(';')[0];

  const app = expectOk(await api('/api/apps', { method: 'POST', json: { name: `Smoke ${run}` } }), 'create app');
  assert(app.id && app.app_key, 'app has id and app_key');

  // 2. SDK batch: install, session_start, screen, identify.
  const iid = `smoke-iid-${run}`;
  const sid = `smoke-sid-${run}`;
  const ev = (n, type, extra = {}) => ({ id: `smoke-ev-${run}-${n}`, type, ts: now - 5000 + n * 100, sid, ...extra });
  const batch = {
    context: {
      iid,
      platform: 'ios',
      osVersion: '18.0',
      appVersion: '1.0.0',
      build: '1',
      deviceModel: 'iPhone16,1',
      locale: 'en-US',
      timezone: 'Europe/Warsaw',
      sdkVersion: '0.1.0',
      bundleId: 'com.example.smoke',
    },
    events: [
      ev(1, 'install'),
      ev(2, 'session_start'),
      ev(3, 'screen', { name: 'Home' }),
      ev(4, 'identify', { props: { userId: 'u1' } }),
    ],
  };
  const batchRes = await api('/api/v1/batch', { method: 'POST', headers: { 'X-App-Key': app.app_key }, json: batch });
  expectOk(batchRes, 'batch');

  // 3. RevenueCat secret and an INITIAL_PURCHASE for u1.
  const { secret } = expectOk(await api(`/api/apps/${app.id}/rc-secret`, { method: 'POST' }), 'rc-secret');
  assert(typeof secret === 'string' && secret, 'rc secret returned');
  const hook = await api(`/api/webhooks/revenuecat/${app.id}`, {
    method: 'POST',
    headers: { Authorization: secret },
    json: {
      api_version: '1.0',
      event: {
        id: `smoke-rc-${run}`,
        type: 'INITIAL_PURCHASE',
        app_user_id: 'u1',
        price: 9.99,
        period_type: 'NORMAL',
        product_id: 'smoke_monthly',
        store: 'APP_STORE',
        environment: 'PRODUCTION',
        purchased_at_ms: now - 1000,
        event_timestamp_ms: now - 1000,
      },
    },
  });
  expectOk(hook, 'webhook');

  // 4. Stats: revenue 999 cents, one customer matched by user_id.
  const overview = expectOk(await api(`/api/apps/${app.id}/stats/overview?range=7d`), 'overview');
  assert(overview.current.revenue === 999, `overview revenue is 999 (got ${overview.current.revenue})`);
  const customers = expectOk(await api(`/api/apps/${app.id}/stats/customers?range=7d`), 'customers');
  assert(Array.isArray(customers) && customers.length === 1, `exactly one customer (got ${customers.length})`);
  assert(customers[0].matchedBy === 'user_id', `customer matchedBy user_id (got ${customers[0].matchedBy})`);

  console.log('smoke ok');
} catch (err) {
  console.error(`smoke FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
