// Range stepping (‹ ›). The Overview response carries no resolved range, so presets are turned into a rolling window
// ending at `now`, of the same span the server uses (calendar-day alignment is not reproduced). Stepping always
// produces an explicit custom range in epoch milliseconds, which is what the stats routes take (`to` exclusive).

const DAY = 86_400_000;

export interface RangeLike {
  range: string;
  from?: number;
  to?: number;
}

const PRESET_SPAN: Record<string, number> = {
  today: DAY,
  yesterday: DAY,
  '24h': DAY,
  '48h': 2 * DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
  '12m': 365 * DAY,
};

/** The window currently shown, or null when it cannot be known on the client ("all"). */
function window(cur: RangeLike, now: number): { from: number; to: number } | null {
  if (cur.range === 'custom') {
    if (cur.from !== undefined && cur.to !== undefined && cur.to > cur.from) return { from: cur.from, to: cur.to };
    return null;
  }
  const span = PRESET_SPAN[cur.range];
  return span === undefined ? null : { from: now - span, to: now };
}

/** The previous (-1) or next (+1) window of the same length; null when there is none (unknown span, or it would start in the future). */
export function shiftRange(cur: RangeLike, dir: -1 | 1, now: number): { range: 'custom'; from: number; to: number } | null {
  const w = window(cur, now);
  if (!w) return null;
  const span = w.to - w.from;
  const from = w.from + dir * span;
  if (from >= now) return null;
  return { range: 'custom', from, to: Math.min(from + span, now) };
}

/** › is enabled only when the shown window ended more than a minute ago (like Datadash's canForward). */
export function canShiftForward(cur: RangeLike, now: number): boolean {
  const w = window(cur, now);
  return w !== null && w.to < now - 60_000 && shiftRange(cur, 1, now) !== null;
}
