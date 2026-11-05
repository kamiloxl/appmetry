import { describe, expect, it } from 'vitest';
import { fromSearch, toSearch } from '../src/lib/query';

describe('toSearch / fromSearch', () => {
  it('round-trips range, interval and f.<dim> filters', () => {
    const state = { range: '7d', interval: 'day', filters: { channel: 'Paid Search', country: 'US' } };
    const s = toSearch(state);
    expect(s).toContain('f.channel=Paid+Search');
    expect(s).toContain('range=7d');
    expect(fromSearch(s)).toEqual(state);
  });

  it('round-trips a custom range in milliseconds', () => {
    const state = { range: 'custom', from: 1_700_000_000_000, to: 1_700_086_400_000, filters: {} };
    expect(fromSearch(toSearch(state))).toEqual(state);
  });

  it('accepts a leading ? and falls back to 30d', () => {
    expect(fromSearch('')).toEqual({ range: '30d', filters: {} });
    expect(fromSearch('?f.platform=ios')).toEqual({ range: '30d', filters: { platform: 'ios' } });
  });

  it('ignores unknown ranges, bad numbers and unknown filter dimensions', () => {
    expect(fromSearch('range=bogus&from=abc&f.nope=x&f.channel=Direct')).toEqual({ range: '30d', filters: { channel: 'Direct' } });
  });

  it('omits empty values', () => {
    expect(toSearch({ range: '30d', filters: { channel: '' } })).toBe('range=30d');
  });
});
