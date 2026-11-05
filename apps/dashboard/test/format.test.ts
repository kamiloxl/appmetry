import { describe, expect, it } from 'vitest';
import { duration, money, pct } from '../src/lib/format';

describe('money', () => {
  it('formats USD cents', () => {
    expect(money(999)).toBe('$9.99');
    expect(money(0)).toBe('$0.00');
    expect(money(123456)).toBe('$1,234.56');
  });
  it('puts an ASCII hyphen before the dollar sign for negatives (refunds)', () => {
    expect(money(-999)).toBe('-$9.99');
  });
});

describe('duration', () => {
  it('formats milliseconds as s / m s / h m', () => {
    expect(duration(65000)).toBe('1m 5s');
    expect(duration(0)).toBe('0s');
    expect(duration(42_000)).toBe('42s');
    expect(duration(3_900_000)).toBe('1h 5m');
  });
});

describe('pct', () => {
  it('shows an en dash when there is nothing to compare', () => {
    expect(pct(null)).toBe('–');
  });
  it('formats a change ratio with its sign', () => {
    expect(pct(0.124)).toBe('+12%');
    expect(pct(-0.05)).toBe('-5%');
    expect(pct(0)).toBe('0%');
  });
});
