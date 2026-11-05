import { describe, expect, it } from 'vitest';
import { groupByDay, matchedByBadge } from '../src/lib/timeline';
import type { TimelineItem } from '../src/lib/types';

const item = (ts: number, label = 'x'): TimelineItem => ({ kind: 'event', ts, label });

describe('groupByDay', () => {
  it('returns no groups for no items', () => {
    expect(groupByDay([], 'UTC')).toEqual([]);
  });

  it('groups by calendar day in the given zone and keeps order', () => {
    const a = item(Date.UTC(2026, 0, 1, 23, 30), 'a');
    const b = item(Date.UTC(2026, 0, 2, 0, 15), 'b');
    const c = item(Date.UTC(2026, 0, 2, 9, 0), 'c');
    const groups = groupByDay([a, b, c], 'UTC');
    expect(groups.map((g) => g.key)).toEqual(['2026-01-01', '2026-01-02']);
    expect(groups[0]!.items).toEqual([a]);
    expect(groups[1]!.items).toEqual([b, c]);
  });

  it('uses local midnight, not UTC midnight', () => {
    const a = item(Date.UTC(2026, 0, 1, 23, 30));
    // 23:30 UTC is already the next day in Warsaw (UTC+1).
    expect(groupByDay([a], 'Europe/Warsaw')[0]!.key).toBe('2026-01-02');
    expect(groupByDay([a], 'UTC')[0]!.key).toBe('2026-01-01');
  });

  it('labels a group with a readable date', () => {
    const g = groupByDay([item(Date.UTC(2026, 2, 5, 12))], 'UTC')[0]!;
    expect(g.label).toBe('Thu 5 Mar 2026');
  });
});

describe('matchedByBadge', () => {
  it('maps each match kind to a label and tone', () => {
    expect(matchedByBadge('attribute')).toEqual({ label: 'attribute', tone: 'good' });
    expect(matchedByBadge('user_id')).toEqual({ label: 'user_id', tone: 'ok' });
    expect(matchedByBadge('install_id')).toEqual({ label: 'install_id', tone: 'ok' });
    expect(matchedByBadge('none')).toEqual({ label: 'none', tone: 'bad' });
  });

  it('treats null and unknown values as none', () => {
    expect(matchedByBadge(null)).toEqual({ label: 'none', tone: 'bad' });
    expect(matchedByBadge('erased')).toEqual({ label: 'none', tone: 'bad' });
  });
});
