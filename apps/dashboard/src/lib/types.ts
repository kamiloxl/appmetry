// Response shapes of the Worker API, declared here on purpose: the browser bundle never imports server code (ruling R4).
// Keep in sync with apps/server/src (apps.ts, stats/*).

export type { Channel } from '@appdash/shared';

/** GET /api/apps item. The RevenueCat secret hash never leaves the server; `has_rc_secret` says whether one is set. */
export interface AppInfo {
  id: string;
  name: string;
  app_key: string;
  ios_bundle_id: string | null;
  android_package: string | null;
  app_store_url: string | null;
  play_store_url: string | null;
  web_url: string | null;
  timezone: string;
  retention_months: number;
  show_sandbox: number;
  setup_state: string | null;
  created_at: number;
  has_rc_secret: boolean;
}

export interface Me {
  loggedIn: boolean;
}

export interface Totals {
  installs: number;
  activeUsers: number;
  sessions: number;
  /** USD cents, refunds subtracted. */
  revenue: number;
  payingInstalls: number;
  conversionRate: number;
  revenuePerInstall: number;
  avgSessionMs: number;
}

export interface Overview {
  current: Totals;
  previous: Totals;
  series: { label: string; installs: number; revenue: number }[];
}

export interface BreakdownRow {
  value: string;
  installs: number;
  revenue: number;
}
