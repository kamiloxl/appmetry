import { sha256Hex } from '../lib/crypto';
import type { Classified, IntegrationConfig, Mapping, OutboxEvent, PostbackAdapter, PostbackInstall } from './types';

/**
 * Meta Conversions API for App Events (developers.facebook.com/documentation/ads-commerce/conversions-api/app-events).
 * One request per dataset with up to 1000 events. The dataset must be linked to the app in Events Manager.
 *
 * Checked against Meta's docs on 2026-11-06: endpoint, required fields, extinfo layout (16 strings, i2 / a2),
 * anon_id / madid unhashed, em and external_id hashed, test_event_code at the top level, MobileAppInstall.
 * The docs give no error format; classify() follows the Graph API's `error.code` convention.
 */

export const META_GRAPH_VERSION = 'v27.0';
const HOST = 'graph.facebook.com';
const DATASET_RE = /^\d{5,25}$/;

/** Standard events offered in the mapping dropdown (custom names are accepted too). */
export const META_STANDARD_EVENTS = [
  'MobileAppInstall', 'Purchase', 'Subscribe', 'StartTrial', 'CompleteRegistration', 'AddPaymentInfo', 'AddToCart',
  'AddToWishlist', 'InitiateCheckout', 'Lead', 'Search', 'ViewContent', 'Contact', 'SubmitApplication', 'Schedule', 'Donate',
] as const;

const m = (source_event: string, target_event: string, send_value = false, locked = false): Mapping => ({ source_event, target_event, send_value, locked });

/** Hosts whose traffic counts as Meta for send_scope = 'attributed'. */
const META_SOURCES = new Set(['meta', 'facebook', 'fb', 'instagram', 'ig', 'messenger', 'audience network', 'threads']);

export interface MetaEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: 'app';
  app_data: {
    advertiser_tracking_enabled: 0 | 1;
    application_tracking_enabled: 0 | 1;
    extinfo: string[];
    campaign_ids?: string;
  };
  user_data: {
    anon_id: string;
    madid?: string;
    client_ip_address?: string;
    client_user_agent?: string;
    external_id?: string[];
    em?: string[];
  };
  custom_data?: { value: number; currency: string };
}

type Extinfo = { modelId?: unknown; w?: unknown; h?: unknown; density?: unknown };

function parseExtinfo(json: string | null): Extinfo {
  try {
    const v = JSON.parse(json ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/** The 16 extinfo values, in Meta's order. Unknown values are empty strings. */
function extinfo(i: PostbackInstall | null, bundleId: string | null): string[] {
  const x = parseExtinfo(i?.device_extinfo ?? null);
  const version = i?.app_version ?? '';
  return [
    i?.platform === 'android' ? 'a2' : 'i2', // 0 version
    bundleId ?? '', // 1 app package name
    version, // 2 short version
    version, // 3 long version
    i?.os_version ?? '', // 4 OS version
    str(x.modelId) || (i?.device_model ?? ''), // 5 device model
    (i?.locale ?? '').replace('-', '_'), // 6 locale
    '', // 7 timezone abbreviation
    '', // 8 carrier
    str(x.w), // 9 screen width
    str(x.h), // 10 screen height
    str(x.density), // 11 screen density
    '', // 12 CPU cores
    '', // 13 external storage size
    '', // 14 free space
    '', // 15 device timezone
  ];
}

/**
 * One CAPI app event. Without ATT authorization (iOS) the event carries no device identifier, IP or user agent:
 * Meta measures it in aggregate (AEM, via campaign_ids). Personal data is only sent hashed, and email only when the
 * integration opts in (`share_hashed_email`).
 */
export async function buildMetaEvent(e: OutboxEvent, config: IntegrationConfig): Promise<MetaEvent> {
  const i = e.install;
  const tracking: 0 | 1 = i?.platform === 'android' ? (e.madid ? 1 : 0) : i?.att_status === 'authorized' ? 1 : 0;
  const out: MetaEvent = {
    event_name: e.targetEvent,
    event_time: Math.floor(e.eventTs / 1000),
    event_id: e.sourceEventId,
    action_source: 'app',
    app_data: { advertiser_tracking_enabled: tracking, application_tracking_enabled: 1, extinfo: extinfo(i, e.bundleId) },
    user_data: { anon_id: i?.id ?? e.sourceEventId },
  };
  if (i?.campaign_ids) out.app_data.campaign_ids = i.campaign_ids;
  if (tracking === 1) {
    if (e.madid) out.user_data.madid = e.madid;
    if (e.transient) {
      out.user_data.client_ip_address = e.transient.ip;
      out.user_data.client_user_agent = e.transient.ua;
    }
  }
  if (i?.user_id) out.user_data.external_id = [await sha256Hex(i.user_id)];
  if (config.share_hashed_email === true && i?.email) out.user_data.em = [await sha256Hex(i.email.trim().toLowerCase())];
  if (e.valueCents !== null && e.valueCents > 0) out.custom_data = { value: e.valueCents / 100, currency: e.currency ?? 'USD' };
  return out;
}

const RETRY_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80004]);
const CREDENTIAL_CODES = new Set([10, 102, 190, 200]);

export const meta: PostbackAdapter = {
  provider: 'meta',
  maxBatch: 1000,
  allowedHosts: [HOST],
  targetEvents: META_STANDARD_EVENTS,
  defaultMappings: [
    m('install', 'MobileAppInstall', false, true),
    m('rc_trial_started', 'StartTrial'),
    m('rc_subscription_started', 'Subscribe', true),
    m('rc_trial_converted', 'Purchase', true),
    m('rc_in_app_purchase', 'Purchase', true),
  ],

  missingConfig: (c) => (typeof c.dataset_id === 'string' && DATASET_RE.test(c.dataset_id) ? null : 'dataset_id'),

  isAttributedTo(i) {
    const named = [i.source, i.utm_source].some((v) => v && META_SOURCES.has(v.trim().toLowerCase()));
    return named || !!i.fbclid || !!i.campaign_ids;
  },

  async buildRequest(ctx, events) {
    const dataset = ctx.config.dataset_id;
    if (typeof dataset !== 'string' || !DATASET_RE.test(dataset)) throw new Error('dataset id must be numeric');
    const body: { data: MetaEvent[]; test_event_code?: string } = {
      data: await Promise.all(events.map((e) => buildMetaEvent(e, ctx.config))),
    };
    if (typeof ctx.config.test_event_code === 'string' && ctx.config.test_event_code) body.test_event_code = ctx.config.test_event_code;
    return {
      url: `https://${HOST}/${META_GRAPH_VERSION}/${dataset}/events?access_token=${encodeURIComponent(ctx.token)}`,
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    };
  },

  classify(status, body): Classified {
    if (status >= 200 && status < 300) return { outcome: 'sent' };
    const e = (body as { error?: { message?: unknown; code?: unknown; error_subcode?: unknown; fbtrace_id?: unknown } } | null)?.error;
    const code = typeof e?.code === 'number' ? e.code : null;
    const sub = typeof e?.error_subcode === 'number' ? `/${e.error_subcode}` : '';
    const msg = typeof e?.message === 'string' ? e.message.slice(0, 200) : 'no error message';
    const trace = typeof e?.fbtrace_id === 'string' ? ` [fbtrace ${e.fbtrace_id}]` : '';
    const error = `Meta ${status}${code !== null ? ` (code ${code}${sub})` : ''}: ${msg}${trace}`;
    if (status === 429 || status >= 500 || (code !== null && RETRY_CODES.has(code))) return { outcome: 'retry', error };
    if (status === 401 || (code !== null && CREDENTIAL_CODES.has(code))) return { outcome: 'fatal', error, integrationError: true };
    return { outcome: 'fatal', error };
  },
};
