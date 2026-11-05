// Range, interval and filters live in the URL so a refresh or a shared link keeps them. The same names are the
// query parameters of the stats routes (range, from, to, interval, f.<dim>), so toSearch() can be sent as-is.

export interface QueryState {
  range: string;
  /** Epoch milliseconds, only for range = custom. */
  from?: number;
  to?: number;
  interval?: string;
  /** Install-level filters by dimension: `{ channel: 'Paid Search' }` becomes `f.channel=Paid+Search`. */
  filters: Record<string, string>;
}

export const RANGES = ['today', 'yesterday', '24h', '48h', '7d', '30d', '90d', '12m', 'all', 'custom'] as const;
export const INTERVALS = ['hour', 'day', 'week', 'month'] as const;
/** Install-level dimensions the server accepts as filters. */
export const FILTER_DIMS = ['channel', 'source', 'campaign', 'asa_campaign_id', 'platform', 'country', 'app_version', 'os_version', 'device_model'] as const;

export const DEFAULT_RANGE = '30d';

const includes = (list: readonly string[], v: string | null): v is string => v !== null && list.includes(v);
const ms = (v: string | null): number | undefined => (v !== null && /^\d{1,16}$/.test(v) ? Number(v) : undefined);

/** Query string without the leading `?`. Empty values are left out. */
export function toSearch(state: QueryState): string {
  const p = new URLSearchParams();
  p.set('range', state.range);
  if (state.from !== undefined) p.set('from', String(state.from));
  if (state.to !== undefined) p.set('to', String(state.to));
  if (state.interval) p.set('interval', state.interval);
  for (const [dim, value] of Object.entries(state.filters)) if (value !== '') p.set(`f.${dim}`, value);
  return p.toString();
}

/** Inverse of toSearch. Accepts a leading `?`; unknown ranges, bad numbers and unknown dimensions are dropped. */
export function fromSearch(search: string): QueryState {
  const p = new URLSearchParams(search);
  const range = p.get('range');
  const interval = p.get('interval');
  const state: QueryState = { range: includes(RANGES, range) ? range : DEFAULT_RANGE, filters: {} };
  const from = ms(p.get('from'));
  const to = ms(p.get('to'));
  if (from !== undefined) state.from = from;
  if (to !== undefined) state.to = to;
  if (includes(INTERVALS, interval)) state.interval = interval;
  for (const dim of FILTER_DIMS) {
    const v = p.get(`f.${dim}`);
    if (v) state.filters[dim] = v;
  }
  return state;
}
