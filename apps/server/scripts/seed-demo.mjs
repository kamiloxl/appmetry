// Fills the LOCAL database with 30 days of fake app data so you can see the dashboard.
// Run from the repository root: `pnpm run seed`
// (= node apps/server/scripts/seed-demo.mjs && wrangler d1 execute DB --local --file .wrangler/seed.sql).
// Re-runnable: the demo app's rows are deleted first. Only the demo app is touched; other apps are left alone.
import { mkdirSync, writeFileSync } from 'node:fs';

const DAY = 86_400_000;
const now = Date.now();
const APP_ID = 'demo-app-0001';
const APP_KEY = 'app_demo000000000key'; // "app_" + 16 characters, like a real key

// Small deterministic PRNG: the same shape of data on every run (timestamps follow the clock).
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const weighted = (pairs) => {
  let r = rand() * pairs.reduce((a, [, w]) => a + w, 0);
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[0][0];
};
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const hex = (n) => Array.from({ length: n }, () => int(0, 15).toString(16)).join('');

const out = [];
/** Multi-row INSERTs, 50 rows per statement. */
function insert(table, cols, rows) {
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50).map((r) => `(${r.map(q).join(', ')})`);
    out.push(`INSERT INTO ${table} (${cols.join(', ')}) VALUES\n${chunk.join(',\n')};`);
  }
}

// ---------- reset (every table with an app_id column, then the app)
for (const t of ['events', 'sessions', 'installs', 'link_clicks', 'links', 'payments', 'rc_events', 'asa_names']) out.push(`DELETE FROM ${t} WHERE app_id = '${APP_ID}';`);
out.push(`DELETE FROM apps WHERE id = '${APP_ID}';`);

insert(
  'apps',
  ['id', 'name', 'app_key', 'ios_bundle_id', 'android_package', 'app_store_url', 'play_store_url', 'web_url', 'timezone', 'rc_secret_hash', 'retention_months', 'show_sandbox', 'setup_state', 'created_at'],
  [[APP_ID, 'Demo App', APP_KEY, 'com.example.demoapp', 'com.example.demoapp', 'https://apps.apple.com/app/id0000000000', 'https://play.google.com/store/apps/details?id=com.example.demoapp', null, 'UTC', hex(64), 25, 0, null, now - 31 * DAY]],
);

// ---------- tracked links (TikTok bio links)
const LINKS = [
  { id: 'demo-link-0001', slug: 'demo-tiktok-launch', name: 'TikTok: launch video', campaign: 'launch-video', content: 'bio-link' },
  { id: 'demo-link-0002', slug: 'demo-tiktok-pov', name: 'TikTok: POV trend', campaign: 'pov-trend', content: 'bio-link' },
  { id: 'demo-link-0003', slug: 'demo-newsletter', name: 'Newsletter', campaign: 'weekly-digest', content: 'footer-cta', source: 'newsletter', medium: 'email' },
];
insert(
  'links',
  ['id', 'app_id', 'slug', 'name', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'ref', 'created_at'],
  LINKS.map((l) => [l.id, APP_ID, l.slug, l.name, l.source ?? 'tiktok', l.medium ?? 'social', l.campaign, l.content, null, now - 29 * DAY]),
);

// ---------- installs
const COUNTRIES = [
  ['US', 'California', 'San Francisco', 'en-US'],
  ['US', 'New York', 'New York', 'en-US'],
  ['GB', 'England', 'London', 'en-GB'],
  ['DE', 'Berlin', 'Berlin', 'de-DE'],
  ['FR', 'Ile-de-France', 'Paris', 'fr-FR'],
  ['BR', 'Sao Paulo', 'Sao Paulo', 'pt-BR'],
  ['IN', 'Karnataka', 'Bengaluru', 'en-IN'],
  ['CA', 'Ontario', 'Toronto', 'en-CA'],
  ['ES', 'Madrid', 'Madrid', 'es-ES'],
  ['PL', 'Mazovia', 'Warsaw', 'pl-PL'],
];
const IOS_DEVICES = ['iPhone14,5', 'iPhone15,2', 'iPhone15,4', 'iPhone16,1', 'iPhone13,2'];
const ANDROID_DEVICES = ['Pixel 8', 'SM-S918B', 'SM-A546B', 'Pixel 7a', 'M2101K6G'];
const IOS_VERSIONS = ['17.5', '18.0', '18.1', '26.0'];
const ANDROID_VERSIONS = ['13', '14', '15'];
const APP_VERSIONS = [['1.2.0', 6], ['1.1.0', 3], ['1.0.3', 1]];
// Apple Search Ads: 3 campaigns, 5 ad groups, 13 keywords of a sleep and meditation app. AdServices reports ids
// only; the names go to asa_names. `w` is the keyword's share of Search Ads installs, `t` scales its trial rate and
// `c` its trial-to-paid rate, so keywords differ: brand and "insomnia help" convert well, "white noise" brings volume
// but few trials.
const ASA_CAMPAIGNS = { 1234500001: 'Brand – Exact', 1234500002: 'Category – Sleep', 1234500003: 'Category – Meditation' };
const ASA_ADGROUPS = { 2234500001: 'Brand', 2234500002: 'Sleep sounds', 2234500003: 'Sleep aid', 2234500004: 'Meditation', 2234500005: 'Anxiety & stress' };
const ASA = [
  ['1234500001', '2234500001', '3234500001', 'demo app', 6, 1.6, 1.3],
  ['1234500001', '2234500001', '3234500002', 'demo app sleep', 2, 1.5, 1.2],
  ['1234500002', '2234500002', '3234500003', 'sleep sounds', 8, 0.9, 0.8],
  ['1234500002', '2234500002', '3234500004', 'white noise', 7, 0.4, 0.5],
  ['1234500002', '2234500002', '3234500005', 'rain sounds', 3, 0.6, 0.6],
  ['1234500002', '2234500003', '3234500006', 'sleep app', 6, 1.2, 1.1],
  ['1234500002', '2234500003', '3234500007', 'insomnia help', 3, 1.4, 1.6],
  ['1234500002', '2234500003', '3234500008', 'sleep tracker', 4, 0.7, 0.6],
  ['1234500003', '2234500004', '3234500009', 'meditation app', 5, 1.0, 1.0],
  ['1234500003', '2234500004', '3234500010', 'guided meditation', 3, 1.1, 1.2],
  ['1234500003', '2234500004', '3234500011', 'mindfulness', 2, 0.6, 0.8],
  ['1234500003', '2234500005', '3234500012', 'anxiety relief', 3, 1.3, 1.4],
  ['1234500003', '2234500005', '3234500013', 'stress relief', 2, 0.8, 0.9],
].map(([campaign, adgroup, keyword, name, w, t, c]) => ({ campaign, adgroup, keyword, name, w, t, c }));

const INSTALL_COUNT = 500;
const installs = [];
const clicks = [];
let clickN = 0;
const base = (method, source, channel) => ({ method, source, channel, utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null, ref: null, click_id: null, asa: null });

for (let n = 1; n <= INSTALL_COUNT; n++) {
  // More installs towards the present, plus a TikTok spike about 10 days ago.
  const day = Math.min(29, Math.floor(30 * (1 - Math.sqrt(rand()))));
  const spike = rand() < 0.12;
  const d = spike ? int(9, 11) : day;
  const firstSeen = Math.min(now - 60_000, now - d * DAY - int(0, DAY - 1));

  const kind = spike ? 'tiktok' : weighted([['tiktok', 24], ['asa', 45], ['ios_organic', 22], ['android_organic', 25], ['deep_link', 4], ['reported', 3]]);
  const platform = kind === 'tiktok' || kind === 'android_organic' ? 'android' : kind === 'asa' || kind === 'ios_organic' ? 'ios' : weighted([['ios', 1], ['android', 1]]);
  let a = base('organic', platform === 'ios' ? 'App Store' : 'Google Play', 'Organic');
  if (kind === 'tiktok') {
    const link = spike ? LINKS[0] : pick(LINKS.slice(0, 2));
    const clickId = `demo-click-${String(++clickN).padStart(5, '0')}`;
    a = { ...base('install_referrer', 'TikTok', 'Organic Social'), utm_source: 'tiktok', utm_medium: 'social', utm_campaign: link.campaign, utm_content: link.content, click_id: clickId };
    clicks.push([clickId, link.id, APP_ID, firstSeen - int(20, 300) * 1000, 'android', null, `demo-install-${String(n).padStart(4, '0')}`]);
  } else if (kind === 'asa') {
    a = { ...base('search_ads', 'Apple Search Ads', 'Paid Search'), asa: weighted(ASA.map((k) => [k, k.w])) };
  } else if (kind === 'deep_link') {
    const nl = rand() < 0.6;
    a = nl
      ? { ...base('deep_link', 'newsletter', 'Email'), utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'weekly-digest', utm_content: 'footer-cta' }
      : { ...base('deep_link', 'Instagram', 'Organic Social'), utm_source: 'instagram', utm_medium: 'social', utm_campaign: 'story-swipe-up' };
  } else if (kind === 'reported') {
    a = base('reported', 'Reddit', 'Organic Social');
  }

  const [country, region, city, locale] = weighted(COUNTRIES.map((c, i) => [c, [30, 12, 12, 8, 6, 8, 8, 6, 5, 5][i]]));
  installs.push({
    n,
    id: `demo-install-${String(n).padStart(4, '0')}`,
    platform,
    firstSeen,
    appVersion: weighted(APP_VERSIONS),
    osVersion: pick(platform === 'ios' ? IOS_VERSIONS : ANDROID_VERSIONS),
    deviceModel: pick(platform === 'ios' ? IOS_DEVICES : ANDROID_DEVICES),
    locale, country, region, city, a,
    userId: null, email: null, name: null,
    lastSeen: firstSeen,
  });
}

// Link clicks that never turned into an installed app, so the links funnel has a top.
for (const l of LINKS.slice(0, 2)) {
  for (let i = 0; i < 60; i++) clicks.push([`demo-click-x${l.id.slice(-1)}${String(i).padStart(3, '0')}`, l.id, APP_ID, now - int(0, 29) * DAY - int(0, DAY - 1), weighted([['android', 3], ['ios', 2]]), pick(COUNTRIES)[0], null]);
}

// ---------- sessions and events
const SCREENS = ['Onboarding', 'Home', 'Home', 'Home', 'Paywall', 'Settings', 'Profile', 'Library'];
const EVENTS = ['onboarding_completed', 'paywall_viewed', 'item_saved', 'share_tapped', 'notification_opted_in'];
const sessions = [];
const events = [];
let sessN = 0;
let evtN = 0;
const addEvent = (inst, sid, ts, type, name, props = null) =>
  events.push([APP_ID, `demo-evt-${String(++evtN).padStart(6, '0')}`, sid, inst.id, ts, type, name, props === null ? null : JSON.stringify(props)]);

for (const inst of installs) {
  addEvent(inst, null, inst.firstSeen, 'install', null, { app_version: inst.appVersion });
  const count = weighted([[1, 30], [2, 25], [3, 20], [4, 12], [6, 8], [9, 5]]);
  let t = inst.firstSeen;
  for (let s = 0; s < count; s++) {
    // Later sessions land hours to days after the previous one, never in the future.
    if (s > 0) t += int(3, 60) * 3_600_000;
    if (t > now - 120_000) break;
    const sid = `demo-sess-${String(++sessN).padStart(5, '0')}`;
    const duration = int(15, 420) * 1000;
    const screens = [];
    for (let k = 0, m = int(1, 6); k < m; k++) screens.push(s === 0 && k === 0 ? 'Onboarding' : pick(SCREENS.slice(1)));
    let ts = t;
    addEvent(inst, sid, ts, 'session_start', null);
    const step = Math.max(1000, Math.floor(duration / (screens.length + 1)));
    let evCount = 0;
    for (const name of screens) {
      ts += step;
      addEvent(inst, sid, ts, 'screen', name);
      if (rand() < 0.35) {
        evCount++;
        addEvent(inst, sid, ts + 500, 'event', pick(EVENTS));
      }
    }
    // The install's first session carries the deep link it came from.
    const deep = s === 0 && inst.a.method === 'deep_link';
    if (deep) addEvent(inst, sid, t + 200, 'deep_link', `demoapp://promo?utm_source=${inst.a.utm_source}&utm_medium=${inst.a.utm_medium}&utm_campaign=${inst.a.utm_campaign}`);
    sessions.push({
      sid, inst, started: t, last: Math.min(now, t + duration), duration, screens: screens.length, events: evCount,
      entry: screens[0], exit: screens.at(-1),
      source: deep ? inst.a.source : 'Direct',
      channel: deep ? inst.a.channel : 'Direct',
      utm_source: deep ? inst.a.utm_source : null, utm_medium: deep ? inst.a.utm_medium : null, utm_campaign: deep ? inst.a.utm_campaign : null,
    });
    inst.lastSeen = Math.min(now, t + duration);
  }
}

// ---------- payments (RevenueCat-style): paying installs skew to Apple Search Ads and TikTok
const PRODUCTS = [
  { id: 'monthly_premium', cents: 999, w: 5 },
  { id: 'annual_premium', cents: 4999, w: 3 },
  { id: 'lifetime_premium', cents: 7999, w: 1 },
  { id: 'weekly_premium', cents: 499, w: 3 },
];
const PAYING = new Map(); // install -> first payment product
const payments = [];
const rcEvents = [];
let payN = 0;
const eligible = installs.filter((i) => i.firstSeen < now - 2 * DAY);
// Direct buyers (no trial). Search Ads keywords that convert well (`c`) bring more of them.
const buyRate = (i) => (i.a.method === 'search_ads' ? 0.12 * i.a.asa.c : i.a.method === 'install_referrer' ? 0.1 : 0.04);
const buyers = eligible.filter((i) => rand() < buyRate(i)).slice(0, 36);

function pay(inst, ts, product, eventType, opts = {}) {
  const id = `demo-rc-${String(++payN).padStart(4, '0')}`;
  const refund = opts.refund === true;
  const amount = refund ? -product.cents : product.cents;
  const kindName = refund ? 'rc_refunded' : opts.trialConversion ? 'rc_trial_converted' : eventType === 'RENEWAL' ? 'rc_subscription_renewed' : product.id === 'lifetime_premium' ? 'rc_in_app_purchase' : 'rc_subscription_started';
  const sess = inst ? sessions.filter((s) => s.inst === inst && s.started <= ts).at(-1) : null;
  // Credit like the server (creditSql): the latest non-direct session, else none (the install's own source).
  const credited = inst ? sessions.filter((s) => s.inst === inst && s.started <= ts && s.channel !== 'Direct').at(-1) : null;
  const appUserId = opts.noInstall ? '$RCAnonymousID:demo' + hex(12) : inst?.userId ?? `$RCAnonymousID:${hex(24)}`;
  payments.push([
    id, APP_ID, ts, refund ? 'refund' : 'payment', amount, eventType, product.id,
    inst?.platform === 'android' ? 'PLAY_STORE' : 'APP_STORE', opts.sandbox ? 'SANDBOX' : 'PRODUCTION', appUserId,
    opts.noInstall ? null : inst.id, credited ? credited.sid : null, opts.noInstall ? 'none' : opts.matchedBy ?? 'install_id', eventType === 'RENEWAL' ? 1 : 0,
  ]);
  rcEvents.push([
    id, APP_ID, ts, eventType, opts.sandbox ? 'SANDBOX' : 'PRODUCTION', opts.noInstall ? 0 : 1, opts.noInstall ? null : inst.id, appUserId, kindName,
    JSON.stringify({ product_id: product.id, price: Math.abs(amount) / 100, currency: 'USD' }),
  ]);
  if (inst) addEvent(inst, sess ? sess.sid : null, ts, 'event', kindName, { product_id: product.id });
  return id;
}

const NAMES = ['Jordan Lee', 'Mia Schmidt', 'Aisha Khan', 'Lucas Martin', 'Priya Sharma', 'Noah Kim', 'Emma Rossi', 'Sofia Garcia'];
buyers.forEach((inst, i) => {
  const product = weighted(PRODUCTS.map((p) => [p, p.w]));
  const first = Math.min(now - 3_600_000, inst.firstSeen + int(5, 4 * 24 * 60) * 60_000);
  if (i < NAMES.length) {
    // Identified users carry the RevenueCat app_user_id, so these match by user id.
    inst.userId = `user-${i + 1}`;
    inst.email = `${NAMES[i].toLowerCase().replace(' ', '.')}@example.com`;
    inst.name = NAMES[i];
  }
  PAYING.set(inst, product);
  pay(inst, first, product, product.id === 'lifetime_premium' ? 'NON_RENEWING_PURCHASE' : 'INITIAL_PURCHASE', { matchedBy: inst.userId ? 'user_id' : 'install_id' });
  // Weekly subscribers renew while they are still around.
  if (product.id === 'weekly_premium') {
    for (let r = 1; first + r * 7 * DAY < now - 3_600_000 && r <= 2; r++) pay(inst, first + r * 7 * DAY, product, 'RENEWAL');
  }
});
// Free trials: 7 days on the monthly or annual plan, much more common from Search Ads. A trial either converts
// (RENEWAL with is_trial_conversion → rc_trial_converted plus the first payment), is cancelled before it ends
// (rc_subscription_cancelled, then rc_subscription_expired), or is still running.
const TRIAL_DAYS = 7;
const TRIAL_PRODUCTS = [[PRODUCTS[0], 3], [PRODUCTS[1], 2]];
function rcLog(inst, ts, type, name, props) {
  const id = `demo-rc-${String(++payN).padStart(4, '0')}`;
  const sess = sessions.filter((s) => s.inst === inst && s.started <= ts).at(-1);
  rcEvents.push([id, APP_ID, ts, type, 'PRODUCTION', 1, inst.id, inst.userId ?? `$RCAnonymousID:${hex(24)}`, name, JSON.stringify(props)]);
  addEvent(inst, sess ? sess.sid : null, ts, 'event', name, props);
}
const trialRate = (i) => (i.a.method === 'search_ads' ? Math.min(0.85, 0.45 * i.a.asa.t) : i.a.method === 'install_referrer' ? 0.18 : 0.07);
for (const inst of eligible.filter((i) => !PAYING.has(i) && rand() < trialRate(i)).slice(0, 140)) {
  const product = weighted(TRIAL_PRODUCTS);
  const store = inst.platform === 'android' ? 'PLAY_STORE' : 'APP_STORE';
  const start = Math.min(now - 3_600_000, inst.firstSeen + int(2, 36 * 60) * 60_000);
  const end = start + TRIAL_DAYS * DAY;
  rcLog(inst, start, 'INITIAL_PURCHASE', 'rc_trial_started', { product_id: product.id, store, price_usd: 0 });
  if (end >= now) continue; // still in trial
  if (rand() < Math.min(0.9, 0.42 * (inst.a.asa?.c ?? 1))) {
    PAYING.set(inst, product);
    pay(inst, end, product, 'RENEWAL', { trialConversion: true });
  } else {
    const cancelAt = start + int(1, TRIAL_DAYS * 24 - 1) * 3_600_000;
    rcLog(inst, cancelAt, 'CANCELLATION', 'rc_subscription_cancelled', { product_id: product.id, store, price_usd: 0, reason: 'UNSUBSCRIBE' });
    rcLog(inst, end, 'EXPIRATION', 'rc_subscription_expired', { product_id: product.id, store, price_usd: 0 });
  }
}
// Two refunds (customer support), one sandbox test purchase, and one payment that never matched an install.
for (const inst of [...PAYING.keys()].slice(0, 2)) {
  const product = PAYING.get(inst);
  pay(inst, Math.min(now - 600_000, payments.find((p) => p[10] === inst.id)[2] + int(1, 3) * DAY), product, 'CANCELLATION', { refund: true });
}
pay(installs[0], now - 2 * DAY, PRODUCTS[0], 'INITIAL_PURCHASE', { sandbox: true });
pay(null, now - 5 * DAY, PRODUCTS[1], 'INITIAL_PURCHASE', { noInstall: true });

// ---------- write rows (installs last-seen is known now)
insert(
  'installs',
  ['app_id', 'id', 'platform', 'first_seen', 'last_seen', 'app_version', 'os_version', 'device_model', 'locale', 'country', 'region', 'city', 'source', 'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'click_id', 'attribution_method', 'asa_campaign_id', 'asa_adgroup_id', 'asa_keyword_id', 'asa_pending_token', 'asa_pending_until', 'user_id', 'email', 'name'],
  installs.map((i) => [
    APP_ID, i.id, i.platform, i.firstSeen, i.lastSeen, i.appVersion, i.osVersion, i.deviceModel, i.locale, i.country, i.region, i.city,
    i.a.source, i.a.channel, i.a.utm_source, i.a.utm_medium, i.a.utm_campaign, i.a.utm_term, i.a.utm_content, i.a.ref, i.a.click_id, i.a.method,
    i.a.asa?.campaign ?? null, i.a.asa?.adgroup ?? null, i.a.asa?.keyword ?? null, null, null, i.userId, i.email, i.name,
  ]),
);
insert(
  'sessions',
  ['app_id', 'id', 'install_id', 'started_at', 'last_seen_at', 'duration', 'screens', 'events', 'entry_screen', 'exit_screen', 'app_version', 'os_version', 'platform', 'country', 'region', 'city', 'source', 'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'ref'],
  sessions.map((s) => [
    APP_ID, s.sid, s.inst.id, s.started, s.last, s.duration, s.screens, s.events, s.entry, s.exit, s.inst.appVersion, s.inst.osVersion, s.inst.platform,
    s.inst.country, s.inst.region, s.inst.city, s.source, s.channel, s.utm_source, s.utm_medium, s.utm_campaign, null,
  ]),
);
insert('events', ['app_id', 'id', 'session_id', 'install_id', 'ts', 'type', 'name', 'props'], events);
insert('link_clicks', ['id', 'link_id', 'app_id', 'ts', 'platform', 'country', 'install_id'], clicks);
insert(
  'payments',
  ['id', 'app_id', 'ts', 'kind', 'amount', 'event_type', 'product_id', 'store', 'environment', 'app_user_id', 'install_id', 'session_id', 'matched_by', 'renewal'],
  payments,
);
insert('rc_events', ['id', 'app_id', 'ts', 'type', 'environment', 'has_install_attr', 'install_id', 'app_user_id', 'lifecycle_name', 'lifecycle_props'], rcEvents);
insert('asa_names', ['app_id', 'kind', 'id', 'name', 'updated_at'], [
  ...Object.entries(ASA_CAMPAIGNS).map(([id, name]) => [APP_ID, 'campaign', id, name, now]),
  ...Object.entries(ASA_ADGROUPS).map(([id, name]) => [APP_ID, 'adgroup', id, name, now]),
  ...ASA.map((k) => [APP_ID, 'keyword', k.keyword, k.name, now]),
]);

mkdirSync('.wrangler', { recursive: true });
writeFileSync('.wrangler/seed.sql', out.join('\n') + '\n');
const refunds = payments.filter((p) => p[3] === 'refund').length;
console.log(
  `Wrote .wrangler/seed.sql: 1 app, ${installs.length} installs, ${sessions.length} sessions, ${events.length} events, ${payments.length} payments (${refunds} refunds, 1 sandbox), ${clicks.length} link clicks, ${events.filter((e) => e[6] === 'rc_trial_started').length} trials, ${ASA.length} Search Ads keywords`,
);
