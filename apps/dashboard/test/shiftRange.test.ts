import { describe, expect, it } from 'vitest';
import { canShiftForward, shiftRange } from '../src/lib/shiftRange';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 5, 12);

describe('shiftRange', () => {
  it('steps a preset back by its own span', () => {
    expect(shiftRange({ range: '7d' }, -1, now)).toEqual({ range: 'custom', from: now - 14 * DAY, to: now - 7 * DAY });
    expect(shiftRange({ range: '24h' }, -1, now)).toEqual({ range: 'custom', from: now - 2 * DAY, to: now - DAY });
    expect(shiftRange({ range: '30d' }, -1, now)).toEqual({ range: 'custom', from: now - 60 * DAY, to: now - 30 * DAY });
  });

  it('steps an existing custom range both ways, keeping its length', () => {
    const cur = { range: 'custom', from: now - 20 * DAY, to: now - 10 * DAY };
    expect(shiftRange(cur, -1, now)).toEqual({ range: 'custom', from: now - 30 * DAY, to: now - 20 * DAY });
    expect(shiftRange(cur, 1, now)).toEqual({ range: 'custom', from: now - 10 * DAY, to: now });
  });

  it('clamps the end to now and refuses to start in the future', () => {
    const cur = { range: 'custom', from: now - 8 * DAY, to: now - 1 * DAY };
    expect(shiftRange(cur, 1, now)).toEqual({ range: 'custom', from: now - 1 * DAY, to: now });
    expect(shiftRange({ range: 'custom', from: now - DAY, to: now }, 1, now)).toBeNull();
    expect(shiftRange({ range: '7d' }, 1, now)).toBeNull();
  });

  it('has no span for "all"', () => {
    expect(shiftRange({ range: 'all' }, -1, now)).toBeNull();
  });
});

describe('canShiftForward', () => {
  it('is false at the present and true for a past custom range', () => {
    expect(canShiftForward({ range: '7d' }, now)).toBe(false);
    expect(canShiftForward({ range: 'custom', from: now - 14 * DAY, to: now - 7 * DAY }, now)).toBe(true);
    expect(canShiftForward({ range: 'custom', from: now - 7 * DAY, to: now - 1000 }, now)).toBe(false);
  });
});
