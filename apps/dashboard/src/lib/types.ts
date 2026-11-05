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

/** GET /api/apps/:id/stats/customers row. `total` is USD cents with refunds netted; source and channel may be null. */
export interface Customer {
  installId: string;
  name: string;
  emoji: string;
  email: string | null;
  total: number;
  payments: number;
  source: string | null;
  channel: string | null;
  matchedBy: string | null;
  firstSeen: number;
  firstPaymentAt: number;
  timeToConvertMs: number;
}

export type TimelineKind = 'install' | 'session' | 'screen' | 'event' | 'deep_link' | 'payment';

export interface TimelineItem {
  kind: TimelineKind;
  ts: number;
  label: string;
  detail?: string;
}

/** GET /api/apps/:id/installs/:installId. `install` is the raw installs row (snake_case columns). */
export interface InstallDetail {
  install: Record<string, unknown>;
  timeline: TimelineItem[];
}

/** POST /api/apps/:id/payments/rematch. */
export interface RematchResult {
  matched: number;
  remaining: number;
}

/** GET /api/apps/:id/links item (the raw links row). Optional fields are null when left blank. */
export interface TrackedLink {
  id: string;
  app_id: string;
  slug: string;
  name: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  ref: string | null;
  created_at: number;
}

/** GET /api/apps/:id/stats/links row. Links with no clicks are included. `revenue` is USD cents. */
export interface LinkStat {
  linkId: string;
  name: string | null;
  slug: string;
  clicks: number;
  androidClicks: number;
  iosClicks: number;
  installs: number;
  revenue: number;
}
