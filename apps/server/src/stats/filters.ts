import type { Context } from 'hono';
import type { AppEnv, AppRow } from '../env';
import { type Granularity, type Range, PERIODS, resolveRange, tzOffset } from '../lib/time';

const DAY = 86_400_000;
const FILTER_VALUE_MAX = 200;
const CUSTOM_MAX_DAYS = 1830;
const GRANULARITIES: readonly Granularity[] = ['hour', 'day', 'week', 'month'];

export type Dim =
  | 'channel'
  | 'source'
  | 'campaign'
  | 'asa_campaign_id'
  | 'platform'
  | 'country'
  | 'app_version'
  | 'os_version'
  | 'device_model'
  | 'screen'
  | 'event';

/** Install-level dimensions: dashboard name -> column on `installs` (alias `i`). Only these may reach SQL. */
export const INSTALL_DIMS = {
  channel: 'channel',
  source: 'source',
  campaign: 'utm_campaign',
  asa_campaign_id: 'asa_campaign_id',
  platform: 'platform',
  country: 'country',
  app_version: 'app_version',
  os_version: 'os_version',
  device_model: 'device_model',
} as const satisfies Record<string, string>;

export type InstallDim = keyof typeof INSTALL_DIMS;

export const isInstallDim = (d: string): d is InstallDim => Object.hasOwn(INSTALL_DIMS, d);
export const isDim = (d: string): d is Dim => isInstallDim(d) || d === 'screen' || d === 'event';

/**
 * `AND i.<col> = ?` clauses for `f.<dim>` query params. Whitelisted install dims only (screen and event are not
 * filters; unknown keys are ignored). Assumes the installs alias `i`, LEFT JOINed where rows might lack an install:
 * an active filter also requires the install row to exist, so unmatched payments drop out.
 * The value `(none)` (what breakdowns show for NULL) selects NULL.
 */
export function installFilterSql(q: URLSearchParams): { where: string; binds: unknown[] } {
  const parts: string[] = [];
  const binds: unknown[] = [];
  for (const dim of Object.keys(INSTALL_DIMS) as InstallDim[]) {
    const v = q.get(`f.${dim}`);
    if (v === null) continue;
    const col = INSTALL_DIMS[dim];
    if (v === '(none)') parts.push(`i.${col} IS NULL`);
    else {
      parts.push(`i.${col} = ?`);
      binds.push(v.slice(0, FILTER_VALUE_MAX));
    }
  }
  if (!parts.length) return { where: '', binds: [] };
  return { where: ` AND i.id IS NOT NULL AND ${parts.join(' AND ')}`, binds };
}

export interface StatsCtx {
  db: D1Database;
  app: AppRow;
  range: Range;
  offset: number;
  filter: { where: string; binds: unknown[] };
  /** SQL fragment excluding sandbox payments (alias `p`), empty when the app shows them. */
  sandbox: string;
}

const parseMs = (s: string | undefined): number | null => {
  if (s === undefined || !/^\d{1,16}$/.test(s)) return null;
  return Number(s);
};

/** Parse range/interval/filters from the request. Returns an error message for a 400. */
export function statsContext(c: Context<AppEnv>, app: AppRow, now = Date.now()): StatsCtx | { error: string } {
  const q = c.req.query();
  const period = q.range ?? '30d';
  if (!(PERIODS as readonly string[]).includes(period)) return { error: `range must be one of ${PERIODS.join(', ')}` };
  if (q.interval !== undefined && !GRANULARITIES.includes(q.interval as Granularity)) {
    return { error: `interval must be one of ${GRANULARITIES.join(', ')}` };
  }
  let range: Range;
  if (period === 'custom') {
    const from = parseMs(q.from);
    const to = parseMs(q.to);
    if (from === null || to === null) return { error: 'custom range needs from and to in milliseconds' };
    if (to <= from) return { error: 'to must be after from' };
    if (to - from > CUSTOM_MAX_DAYS * DAY) return { error: `custom range is limited to ${CUSTOM_MAX_DAYS} days` };
    const span = to - from;
    const auto: Granularity = span <= 2 * DAY + 3_600_000 ? 'hour' : span <= 120 * DAY ? 'day' : span <= 400 * DAY ? 'week' : 'month';
    const g = (q.interval as Granularity | undefined) ?? auto;
    range = { from, to, granularity: g === 'hour' && span > 7 * DAY ? auto : g };
  } else {
    range = resolveRange({ period, granularity: q.interval }, app.timezone, app.created_at, now);
  }
  const url = new URL(c.req.url);
  const filter = installFilterSql(url.searchParams);
  return {
    db: c.env.DB,
    app,
    range,
    offset: tzOffset(app.timezone, range.to),
    filter,
    sandbox: app.show_sandbox ? '' : ` AND (p.environment IS NULL OR p.environment != 'SANDBOX')`,
  };
}
