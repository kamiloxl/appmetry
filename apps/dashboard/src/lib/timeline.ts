import type { TimelineItem, TimelineKind } from './types';

export interface DayGroup {
  /** YYYY-MM-DD in the zone used for grouping. */
  key: string;
  label: string;
  items: TimelineItem[];
}

/** Groups items (already ascending) by calendar day in `timeZone` (default: the browser's). Order is preserved. */
export function groupByDay(items: TimelineItem[], timeZone?: string): DayGroup[] {
  const key = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const label = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const groups: DayGroup[] = [];
  for (const item of items) {
    const k = key.format(item.ts);
    let g = groups[groups.length - 1];
    if (!g || g.key !== k) {
      g = { key: k, label: label.format(item.ts).replace(',', ''), items: [] };
      groups.push(g);
    }
    g.items.push(item);
  }
  return groups;
}

export type BadgeTone = 'good' | 'ok' | 'bad';

/** How a payment was tied to an install: the attribute is the strongest link, none means unmatched. */
export function matchedByBadge(matchedBy: string | null): { label: string; tone: BadgeTone } {
  switch (matchedBy) {
    case 'attribute':
      return { label: 'attribute', tone: 'good' };
    case 'user_id':
    case 'install_id':
      return { label: matchedBy, tone: 'ok' };
    default:
      return { label: 'none', tone: 'bad' };
  }
}

export const KIND_META: Record<TimelineKind, { icon: string; color: string; name: string }> = {
  install: { icon: '⬇', color: 'bg-sky-100 text-sky-700', name: 'Install' },
  session: { icon: '▶', color: 'bg-stone-100 text-stone-600', name: 'Session' },
  screen: { icon: '▭', color: 'bg-indigo-100 text-indigo-700', name: 'Screen' },
  event: { icon: '★', color: 'bg-violet-100 text-violet-700', name: 'Event' },
  deep_link: { icon: '↗', color: 'bg-amber-100 text-amber-700', name: 'Deep link' },
  payment: { icon: '$', color: 'bg-emerald-100 text-emerald-700', name: 'Payment' },
};
