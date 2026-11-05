import { friendlyName } from '@appmetry/shared';
import type { StatsCtx } from './filters';

export interface Customer {
  installId: string;
  name: string;
  emoji: string;
  email: string | null;
  total: number;
  payments: number;
  source: string | null;
  channel: string | null;
  matchedBy: string | null;
  firstSeen: number;
  firstPaymentAt: number;
  timeToConvertMs: number;
}

const LIMIT = 200;

/** Installs with at least one payment in range, biggest spenders first. One query. */
export async function customers(ctx: StatsCtx): Promise<Customer[]> {
  const { db, app, range, filter } = ctx;
  const sb2 = ctx.sandbox.replaceAll('p.', 'p2.');
  const sb3 = ctx.sandbox.replaceAll('p.', 'p3.');
  const res = await db
    .prepare(
      `SELECT i.id AS installId, i.email AS email, i.source AS source, i.channel AS channel, i.first_seen AS firstSeen,
              SUM(p.amount) AS total,
              SUM(CASE WHEN p.kind = 'payment' THEN 1 ELSE 0 END) AS payments,
              (SELECT MIN(p2.ts) FROM payments p2 WHERE p2.app_id = i.app_id AND p2.install_id = i.id${sb2}) AS firstPaymentAt,
              (SELECT p3.matched_by FROM payments p3 WHERE p3.app_id = i.app_id AND p3.install_id = i.id AND p3.kind = 'payment'${sb3}
                 ORDER BY p3.ts DESC, p3.id DESC LIMIT 1) AS matchedBy
       FROM payments p JOIN installs i ON i.app_id = p.app_id AND i.id = p.install_id
       WHERE p.app_id = ? AND p.ts >= ? AND p.ts < ?${ctx.sandbox}${filter.where}
       GROUP BY i.id ORDER BY total DESC, i.id LIMIT ${LIMIT}`,
    )
    .bind(app.id, range.from, range.to, ...filter.binds)
    .all<Omit<Customer, 'name' | 'emoji' | 'timeToConvertMs'>>();
  return res.results.map((r) => {
    const { name, emoji } = friendlyName(r.installId);
    return { ...r, name, emoji, timeToConvertMs: r.firstPaymentAt - r.firstSeen };
  });
}

export interface TimelineItem {
  kind: 'install' | 'session' | 'screen' | 'event' | 'deep_link' | 'payment';
  ts: number;
  label: string;
  detail?: string;
}

const MAX_ITEMS = 500;

const money = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** The install row plus its newest 500 timeline items, ascending. Null when the install is not in this app. */
export async function installTimeline(
  db: D1Database,
  appId: string,
  installId: string,
): Promise<{ install: Record<string, unknown>; timeline: TimelineItem[] } | null> {
  const [inst, sess, evs, pays] = await db.batch([
    db.prepare('SELECT * FROM installs WHERE app_id = ? AND id = ?').bind(appId, installId),
    db
      .prepare('SELECT started_at, duration, source FROM sessions WHERE app_id = ? AND install_id = ? ORDER BY started_at DESC LIMIT ?')
      .bind(appId, installId, MAX_ITEMS),
    db
      .prepare(
        `SELECT ts, type, name FROM events WHERE app_id = ? AND install_id = ? AND type IN ('screen', 'event', 'deep_link')
         ORDER BY ts DESC LIMIT ?`,
      )
      .bind(appId, installId, MAX_ITEMS),
    db
      .prepare('SELECT ts, kind, amount, product_id FROM payments WHERE app_id = ? AND install_id = ? ORDER BY ts DESC LIMIT ?')
      .bind(appId, installId, MAX_ITEMS),
  ]);
  const install = inst.results[0] as Record<string, unknown> | undefined;
  if (!install) return null;
  delete install.asa_pending_token;

  const items: TimelineItem[] = [{ kind: 'install', ts: install.first_seen as number, label: `Installed via ${install.source ?? 'Direct'}` }];
  for (const s of sess.results as { started_at: number; duration: number; source: string | null }[]) {
    const item: TimelineItem = { kind: 'session', ts: s.started_at, label: `Session · ${formatDuration(s.duration)}` };
    if (s.source && s.source !== 'Direct') item.detail = s.source;
    items.push(item);
  }
  for (const e of evs.results as { ts: number; type: TimelineItem['kind']; name: string | null }[]) {
    items.push({ kind: e.type, ts: e.ts, label: e.name ?? e.type });
  }
  for (const p of pays.results as { ts: number; kind: string; amount: number; product_id: string | null }[]) {
    const refund = p.kind === 'refund' || p.amount < 0;
    const item: TimelineItem = { kind: 'payment', ts: p.ts, label: refund ? `Refund −${money(p.amount)}` : money(p.amount) };
    if (p.product_id) item.detail = p.product_id;
    items.push(item);
  }
  // Array.sort is stable, so ties keep install, session, event, payment order.
  items.sort((a, b) => a.ts - b.ts);
  return { install, timeline: items.slice(-MAX_ITEMS) };
}
