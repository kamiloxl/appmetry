const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** USD cents to "$9.99". Negatives (refunds) read "-$9.99" with an ASCII hyphen. */
export function money(cents: number): string {
  return usd.format(cents / 100);
}

/** Compact USD for big chart numbers: "$12.3k". Falls back to `money` below $10k. */
export function moneyCompact(cents: number): string {
  const v = cents / 100;
  if (Math.abs(v) < 10_000) return money(cents);
  const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(v)).toLowerCase();
  return `${v < 0 ? '-' : ''}$${compact}`;
}

/** Milliseconds to "42s", "1m 5s", "1h 5m". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)} days`;
}

/** A change ratio (0.12 = twelve percent up) as "+12%". `null` means there was nothing to compare with. */
export function pct(change: number | null): string {
  if (change === null || !Number.isFinite(change)) return '–';
  const v = Math.round(change * 100);
  return `${v > 0 ? '+' : ''}${v}%`;
}

export function number(n: number): string {
  if (n >= 10_000) return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n).toLowerCase();
  return new Intl.NumberFormat('en').format(Math.round(n));
}

export function dateLabel(ts: number): string {
  return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(ts);
}

/** Relative change of `cur` against `prev` (0.12 = twelve percent up; |prev| is the denominator so a negative `prev` keeps the sign); null when `prev` is 0, so there is nothing to compare with. */
export function pctChange(cur: number, prev: number): number | null {
  return prev ? (cur - prev) / Math.abs(prev) : null;
}
