import type { RcEvent } from './revenuecat';

/** RevenueCat attribute the SDK's `syncRevenueCat` sets to the appdash install id. */
export const INSTALL_ATTR = 'appdash_install_id';

export type MatchedBy = 'attribute' | 'user_id' | 'install_id' | 'none';

/** Ids never exceed this; longer values cannot match and are not looked up. */
const ID_MAX = 255;
/** At most this many user ids per lookup (app_user_id, original_app_user_id, aliases), well under D1's bind limit. */
const MAX_USER_IDS = 50;

const idValue = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= ID_MAX ? v : null);

/** The `appdash_install_id` attribute value, or null when absent or not a non-empty string. */
export function installAttr(ev: RcEvent): string | null {
  const attrs = ev.subscriber_attributes;
  if (!attrs || typeof attrs !== 'object') return null;
  const attr = (attrs as Record<string, unknown>)[INSTALL_ATTR];
  if (!attr || typeof attr !== 'object') return null;
  const value = (attr as { value?: unknown }).value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function installExists(db: D1Database, appId: string, id: string): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS ok FROM installs WHERE app_id = ? AND id = ?').bind(appId, id).first<number>('ok')) === 1;
}

/**
 * Link a RevenueCat event to an install of this app (spec §5 "Payment matching"):
 * 1. `appdash_install_id` attribute is an install id → `attribute`
 * 2. app_user_id / original_app_user_id / aliases equals `installs.user_id`, most recently seen install → `user_id`
 * 3. app_user_id is an install id → `install_id`
 * 4. otherwise `none`.
 */
export async function matchInstall(
  db: D1Database,
  appId: string,
  ev: RcEvent,
): Promise<{ installId: string | null; matchedBy: MatchedBy }> {
  const attr = idValue(installAttr(ev));
  if (attr && (await installExists(db, appId, attr))) return { installId: attr, matchedBy: 'attribute' };

  const appUserId = idValue(ev.app_user_id);
  const aliases = Array.isArray(ev.aliases) ? ev.aliases : [];
  const userIds = [...new Set([appUserId, idValue(ev.original_app_user_id), ...aliases.map(idValue)])]
    .filter((v): v is string => v !== null)
    .slice(0, MAX_USER_IDS);
  if (userIds.length) {
    const byUser = await db
      .prepare(
        `SELECT id FROM installs WHERE app_id = ? AND user_id IN (${userIds.map(() => '?').join(', ')})
         ORDER BY last_seen DESC, id DESC LIMIT 1`,
      )
      .bind(appId, ...userIds)
      .first<string>('id');
    if (byUser) return { installId: byUser, matchedBy: 'user_id' };
  }

  if (appUserId && (await installExists(db, appId, appUserId))) return { installId: appUserId, matchedBy: 'install_id' };
  return { installId: null, matchedBy: 'none' };
}

/**
 * The session a payment is credited to: the install's latest session with a non-direct source that started at or
 * before the payment. Null means the payment is credited to the install's own attribution (spec §5 "Credit").
 */
export async function creditedSessionId(db: D1Database, appId: string, installId: string, ts: number): Promise<string | null> {
  return db
    .prepare(
      `SELECT id FROM sessions WHERE app_id = ? AND install_id = ? AND channel != 'Direct' AND started_at <= ?
       ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .bind(appId, installId, ts)
    .first<string>('id');
}
