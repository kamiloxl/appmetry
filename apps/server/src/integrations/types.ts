/**
 * Ad-network postbacks: shared types. An adapter per network (Meta first) turns queued outbox rows into the
 * network's HTTP request and classifies its answer. Everything else (eligibility, queueing, retries, secrets) is
 * network-neutral and lives in enqueue.ts / dispatch.ts.
 */

export type SendScope = 'all' | 'attributed';
export type IntegrationStatus = 'draft' | 'active' | 'error' | 'disconnected';

export interface IntegrationConfig {
  dataset_id?: string;
  dataset_name?: string;
  test_event_code?: string;
  [k: string]: unknown;
}

export interface Mapping {
  source_event: string;
  target_event: string;
  send_value: boolean;
  locked: boolean;
}

export interface ActiveIntegration {
  id: string;
  app_id: string;
  provider: string;
  send_scope: SendScope;
  config: IntegrationConfig;
  /** source_event → mapping */
  mappings: Map<string, Mapping>;
}

/** An app event that may be sent to ad networks. */
export interface SourceEvent {
  /** Stable dedup id (sent as the network's event id): `install_<iid>`, the SDK event id, or `rc_<RevenueCat id>`. */
  id: string;
  installId: string;
  /** Mapping key: 'install', a custom event name, or an rc_* lifecycle name. */
  name: string;
  /** Event time; null = the install's first_seen (used for the install event). */
  ts: number | null;
  valueCents?: number | null;
  currency?: string | null;
  /** RevenueCat sandbox purchase: only sent while the integration has a test event code. */
  sandbox?: boolean;
  /** IP and user agent of the SDK request that carried the event, kept sealed until the event is sent. */
  transient?: { ip: string; ua: string } | null;
}

/** The install facts adapters and eligibility rules read. */
export interface PostbackInstall {
  id: string;
  platform: string | null;
  first_seen: number;
  ad_consent: number | null;
  att_status: string | null;
  device_extinfo: string | null;
  os_version: string | null;
  app_version: string | null;
  device_model: string | null;
  locale: string | null;
  source: string | null;
  channel: string | null;
  utm_source: string | null;
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  fbclid: string | null;
  campaign_ids: string | null;
  user_id: string | null;
  email: string | null;
}

/** One queued event, opened for sending: sealed values are decrypted, never stored back. */
export interface OutboxEvent {
  id: string;
  sourceEventId: string;
  targetEvent: string;
  eventTs: number;
  valueCents: number | null;
  currency: string | null;
  install: PostbackInstall | null;
  /** IDFA / GAID, only when stored (consent, and ATT authorized on iOS). */
  madid: string | null;
  transient: { ip: string; ua: string } | null;
}

export interface SendContext {
  integrationId: string;
  config: IntegrationConfig;
  /** The network credential (e.g. Meta CAPI access token). Never logged or stored in plain text. */
  token: string;
}

export type Outcome = 'sent' | 'retry' | 'fatal';

export interface Classified {
  outcome: Outcome;
  /** Short reason, already free of credentials. */
  error?: string;
  /** The credential or configuration is broken: mark the integration as `error` until the user reconnects. */
  integrationError?: boolean;
}

export interface PostbackAdapter {
  provider: string;
  /** Most events in one request. */
  maxBatch: number;
  /** Hosts the adapter may call (checked before every request). */
  allowedHosts: readonly string[];
  /** For send_scope = 'attributed': did this network bring the install? */
  isAttributedTo(install: PostbackInstall): boolean;
  /** One request for up to `maxBatch` events of one integration. */
  buildRequest(ctx: SendContext, events: OutboxEvent[]): Promise<{ url: string; init: RequestInit }>;
  classify(status: number, body: unknown): Classified;
}
