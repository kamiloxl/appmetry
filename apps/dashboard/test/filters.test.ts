import { describe, expect, it } from 'vitest';
import { toggleFilter } from '../src/lib/filters';
import { pctChange } from '../src/lib/format';

describe('toggleFilter', () => {
  it('adds, replaces and removes', () => {
    const none = {};
    const added = toggleFilter(none, 'source', 'TikTok');
    expect(added).toEqual({ source: 'TikTok' });
    expect(none).toEqual({}); // input is not mutated

    expect(toggleFilter(added, 'source', 'Google')).toEqual({ source: 'Google' });
    expect(toggleFilter(added, 'country', 'US')).toEqual({ source: 'TikTok', country: 'US' });
    expect(toggleFilter(added, 'source', 'TikTok')).toEqual({});
  });
});

describe('pctChange', () => {
  it('is the relative change, and null when the previous value is 0', () => {
    expect(pctChange(150, 100)).toBe(0.5);
    expect(pctChange(50, 100)).toBe(-0.5);
    expect(pctChange(0, 100)).toBe(-1);
    expect(pctChange(10, 0)).toBeNull();
    expect(pctChange(0, 0)).toBeNull();
  });
});
