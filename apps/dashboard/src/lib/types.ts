// Response shapes of the Worker API, declared here on purpose: the browser bundle never imports server code (ruling R4).
// Keep in sync with apps/server/src (apps.ts, stats/*).

export type { Channel } from '@appmetry/shared';

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
  /** Installs that started a RevenueCat trial in the period. */
  trials: number;
  /** Installs whose trial converted to paid in the period. */
  trialsConverted: number;
  /** trials / installs of the period. */
  trialRate: number;
}

export interface Overview {
  current: Totals;
  previous: Totals;
  series: { label: string; installs: number; revenue: number; trials: number }[];
}

export interface BreakdownRow {
  value: string;
  installs: number;
  revenue: number;
  /** Installs that started a trial in the range; 0 for screen / event. */
  trials: number;
  /** Installs whose trial converted to paid in the range; 0 for screen / event. */
  trialsConverted: number;
  /** Search Ads name for the id in `value`, when known. */
  label?: string;
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

/** GET /api/apps/:id/revenuecat/health. Counts cover the last 24 h of production deliveries. */
export interface RcHealth {
  lastEventAt: number | null;
  events24h: number;
  withInstallId24h: number;
  matched24h: number;
  /** True when fewer than 50% of the 24 h events carry appmetry_install_id. */
  warning: boolean;
}

/** POST /api/apps/:id/rc-secret. The only time the secret is visible. */
export interface RcSecret {
  secret: string;
}

/** DELETE /api/apps/:id/users. */
export interface EraseResult {
  installs: number;
}

/** Wizard steps in order. Mirrors apps/server/src/setup.ts (R4: no server imports in the browser bundle). */
export type SetupStep = 'app' | 'firstEvent' | 'revenuecatWebhook' | 'revenuecatSync' | 'attribution' | 'privacy';

/** One wizard step as GET /api/apps/:id/setup reports it. `at` is epoch ms; `detail` is e.g. "iPhone16,1, ios 18.1". */
export interface StepStatus {
  done: boolean;
  skipped?: boolean;
  at?: number;
  detail?: string;
}

/** GET/PATCH /api/apps/:id/setup. `current` is the first step neither done nor skipped; null means setup is complete. */
export interface SetupStatus {
  steps: Record<SetupStep, StepStatus>;
  current: SetupStep | null;
}

// ---------- ad-network integrations (server: apps/server/src/integrations/routes.ts)

export type IntegrationStatus = 'draft' | 'active' | 'error' | 'disconnected';
export type SendScope = 'all' | 'attributed';

export interface Mapping {
  source_event: string;
  target_event: string;
  send_value: boolean;
  locked: boolean;
}

export interface DeliveryStats {
  sent_24h: number;
  failed_24h: number;
  pending: number;
  last_sent_at: number | null;
  last_error: string | null;
}

export interface Integration {
  id: string;
  provider: string;
  status: IntegrationStatus;
  send_scope: SendScope;
  dataset_id: string | null;
  dataset_name: string | null;
  test_event_code: string | null;
  share_hashed_email: boolean;
  terms_accepted_at: number | null;
  has_token: boolean;
  keys_configured: boolean;
  /** First setting still needed before activation, or null. */
  missing: string | null;
  mappings: Mapping[];
  target_events: string[];
  stats: DeliveryStats;
  created_at: number;
  updated_at: number;
}

export interface IntegrationList {
  providers: Array<{ provider: string; name: string }>;
  keys_configured: boolean;
  integrations: Integration[];
}

export interface EventCatalog {
  builtin: string[];
  custom: Array<{ name: string; count_30d: number }>;
}

export interface Delivery {
  id: string;
  source_event_id: string;
  target_event: string;
  event_ts: number;
  value_cents: number | null;
  currency: string | null;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
}

export interface TestEventResult {
  ok: boolean;
  outcome: 'sent' | 'retry' | 'fatal';
  error: string | null;
  target_event: string;
}
