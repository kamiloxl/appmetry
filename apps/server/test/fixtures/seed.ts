import type { AppRow } from '../../src/env';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** UTC midnight of the day containing `at`. */
export const utcDay = (at: number) => Math.floor(at / DAY) * DAY;

export interface SeedIds {
  /** UTC midnight, three days before `now`. All seeded rows sit on this day or the next. */
  day: number;
  installs: { tiktok: string; ads: string; organic: string };
  sessions: { tiktok1: string; tiktok2: string; ads1: string; ads2: string; organic1: string };
  payments: { tiktokDirect: string; adsSearch: string; tiktokRefund: string };
}

interface InstallRow {
  id: string;
  platform: string;
  country: string;
  source: string;
  channel: string;
  utm_campaign?: string;
  asa_campaign_id?: string;
  asa_adgroup_id?: string;
  asa_keyword_id?: string;
  first_seen: number;
}

export function insertInstall(db: D1Database, appId: string, r: InstallRow) {
  return db
    .prepare(
      `INSERT INTO installs (app_id, id, platform, first_seen, last_seen, app_version, os_version, device_model, country, source, channel, utm_campaign,
                            asa_campaign_id, asa_adgroup_id, asa_keyword_id)
       VALUES (?, ?, ?, ?, ?, '1.0.0', '17.0', 'Phone1', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(appId, r.id, r.platform, r.first_seen, r.first_seen, r.country, r.source, r.channel, r.utm_campaign ?? null,
          r.asa_campaign_id ?? null, r.asa_adgroup_id ?? null, r.asa_keyword_id ?? null);
}

export function insertSession(
  db: D1Database,
  appId: string,
  r: { id: string; install_id: string; started_at: number; duration: number; source: string; channel: string },
) {
  return db
    .prepare(
      `INSERT INTO sessions (app_id, id, install_id, started_at, last_seen_at, duration, source, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(appId, r.id, r.install_id, r.started_at, r.started_at + r.duration, r.duration, r.source, r.channel);
}

export function insertPayment(
  db: D1Database,
  appId: string,
  r: { id: string; ts: number; amount: number; install_id?: string | null; session_id?: string | null; environment?: string; kind?: string },
) {
  return db
    .prepare(
      `INSERT INTO payments (id, app_id, ts, kind, amount, environment, install_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(r.id, appId, r.ts, r.kind ?? (r.amount < 0 ? 'refund' : 'payment'), r.amount, r.environment ?? 'PRODUCTION', r.install_id ?? null, r.session_id ?? null);
}

export function insertEvent(
  db: D1Database,
  appId: string,
  r: { id: string; install_id: string; ts: number; type: string; name: string; props?: Record<string, unknown> },
) {
  return db
    .prepare(`INSERT INTO events (app_id, id, session_id, install_id, ts, type, name, props) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`)
    .bind(appId, r.id, r.install_id, r.ts, r.type, r.name, r.props ? JSON.stringify(r.props) : null);
}

/**
 * Deterministic dataset (relative to `now`): 3 installs, 5 sessions, 2 payments and 1 refund.
 *
 * - tiktok: android, US, source tiktok / Organic Social, campaign "spring"
 * - ads: ios, GB, source "Search Ads" / Paid Search, ASA campaign "123"
 * - organic: ios, DE, source Organic / Organic
 * - sessions: avg duration 120000 ms; 999 payment from tiktok credited to its Direct session,
 *   1999 payment from ads (no credited session), -999 refund from tiktok (no credited session)
 * - revenue total 1999; screens Home (3 installs), Paywall (2); event "tap" (1)
 */
export async function seedStats(db: D1Database, app: Pick<AppRow, 'id'>, now = Date.now()): Promise<SeedIds> {
  const day = utcDay(now) - 3 * DAY;
  const a = app.id;
  const ids: SeedIds = {
    day,
    installs: { tiktok: 'inst_tiktok_01', ads: 'inst_ads_0001', organic: 'inst_organic_1' },
    sessions: { tiktok1: 'sess_tiktok_1', tiktok2: 'sess_tiktok_2', ads1: 'sess_ads_0001', ads2: 'sess_ads_0002', organic1: 'sess_organic_1' },
    // payments.id is globally unique, so prefix with the app id.
    payments: { tiktokDirect: `${a}_pay_tiktok_direct`, adsSearch: `${a}_pay_ads_search`, tiktokRefund: `${a}_pay_tiktok_refund` },
  };
  const { installs: I, sessions: S, payments: P } = ids;
  await db.batch([
    insertInstall(db, a, { id: I.tiktok, platform: 'android', country: 'US', source: 'tiktok', channel: 'Organic Social', utm_campaign: 'spring', first_seen: day + 10 * HOUR }),
    insertInstall(db, a, { id: I.ads, platform: 'ios', country: 'GB', source: 'Search Ads', channel: 'Paid Search', asa_campaign_id: '123', first_seen: day + 11 * HOUR }),
    insertInstall(db, a, { id: I.organic, platform: 'ios', country: 'DE', source: 'Organic', channel: 'Organic', first_seen: day + 12 * HOUR }),
    insertSession(db, a, { id: S.tiktok1, install_id: I.tiktok, started_at: day + 10 * HOUR, duration: 60_000, source: 'tiktok', channel: 'Organic Social' }),
    insertSession(db, a, { id: S.tiktok2, install_id: I.tiktok, started_at: day + DAY, duration: 120_000, source: 'Direct', channel: 'Direct' }),
    insertSession(db, a, { id: S.ads1, install_id: I.ads, started_at: day + 11 * HOUR, duration: 30_000, source: 'Search Ads', channel: 'Paid Search' }),
    insertSession(db, a, { id: S.ads2, install_id: I.ads, started_at: day + DAY, duration: 90_000, source: 'Direct', channel: 'Direct' }),
    insertSession(db, a, { id: S.organic1, install_id: I.organic, started_at: day + 12 * HOUR, duration: 300_000, source: 'Direct', channel: 'Direct' }),
    insertPayment(db, a, { id: P.tiktokDirect, ts: day + DAY + HOUR, amount: 999, install_id: I.tiktok, session_id: S.tiktok2 }),
    insertPayment(db, a, { id: P.adsSearch, ts: day + DAY + 2 * HOUR, amount: 1999, install_id: I.ads }),
    insertPayment(db, a, { id: P.tiktokRefund, ts: day + DAY + 3 * HOUR, amount: -999, install_id: I.tiktok }),
    insertEvent(db, a, { id: 'ev_1', install_id: I.tiktok, ts: day + 10 * HOUR, type: 'screen', name: 'Home' }),
    insertEvent(db, a, { id: 'ev_2', install_id: I.ads, ts: day + 11 * HOUR, type: 'screen', name: 'Home' }),
    insertEvent(db, a, { id: 'ev_3', install_id: I.organic, ts: day + 12 * HOUR, type: 'screen', name: 'Home' }),
    insertEvent(db, a, { id: 'ev_4', install_id: I.tiktok, ts: day + 10 * HOUR + 1000, type: 'screen', name: 'Paywall' }),
    insertEvent(db, a, { id: 'ev_5', install_id: I.ads, ts: day + 11 * HOUR + 1000, type: 'screen', name: 'Paywall' }),
    insertEvent(db, a, { id: 'ev_6', install_id: I.ads, ts: day + 11 * HOUR + 2000, type: 'screen', name: 'Paywall' }),
    insertEvent(db, a, { id: 'ev_7', install_id: I.tiktok, ts: day + 10 * HOUR + 3000, type: 'event', name: 'tap' }),
  ]);
  return ids;
}
