import type { Integration, IntegrationStatus, Mapping } from './types';

/** Readable names for the server's built-in events. Custom events show as typed. */
const EVENT_LABELS: Record<string, string> = {
  install: 'Install',
  rc_trial_started: 'Trial started',
  rc_intro_started: 'Intro offer started',
  rc_subscription_started: 'Subscription started',
  rc_trial_converted: 'Trial converted',
  rc_subscription_renewed: 'Subscription renewed',
  rc_in_app_purchase: 'In-app purchase',
  rc_refunded: 'Refund',
  rc_subscription_cancelled: 'Subscription cancelled',
  rc_subscription_uncancelled: 'Subscription uncancelled',
  rc_billing_issue: 'Billing issue',
  rc_subscription_expired: 'Subscription expired',
  rc_product_changed: 'Product changed',
};

export function eventLabel(name: string): string {
  const label = EVENT_LABELS[name];
  if (!label) return name;
  return name.startsWith('rc_') ? `${label} (RevenueCat)` : label;
}

export const STATUS_LABELS: Record<IntegrationStatus, string> = {
  draft: 'Not active',
  active: 'Active',
  error: 'Needs attention',
  disconnected: 'Disconnected',
};

/** Server error codes → what the user can do about them. Unknown codes pass through. */
const ERRORS: Record<string, string> = {
  integrations_key_missing: 'The server has no INTEGRATIONS_KEY secret. Add one (32 random bytes, base64) in Cloudflare and try again.',
  terms_not_accepted: 'Confirm the Meta Business Tools Terms first.',
  test_event_code_required: 'Add a test event code from Events Manager → Test events first, so the test does not count as a real conversion.',
  credential_unreadable: 'The saved token cannot be read. Paste it again.',
  already_exists: 'This network is already connected.',
  cross_origin_request: 'The request came from another site and was blocked.',
  oauth_not_connected: 'Connect with Facebook first.',
  oauth_expired: 'The Facebook connection expired. Connect again.',
  meta_unavailable: 'Meta did not answer. Try again in a moment.',
};

/** The banner after returning from Facebook (`?oauth=…`), or null. */
export function oauthNotice(result: string | null): { ok: boolean; text: string } | null {
  switch (result) {
    case 'connected':
      return { ok: true, text: 'Connected to Facebook. Choose a dataset below.' };
    case 'denied':
      return { ok: false, text: 'Facebook access was not granted. You can still enter the dataset ID by hand.' };
    case 'key_missing':
      return { ok: false, text: errorText('integrations_key_missing') };
    case 'not_configured':
      return { ok: false, text: 'This server has no Meta app (META_APP_ID / META_APP_SECRET). Enter the dataset ID by hand.' };
    case 'failed':
      return { ok: false, text: 'Connecting to Facebook failed. Try again.' };
    default:
      return null;
  }
}

export function errorText(code: string): string {
  return ERRORS[code] ?? code;
}

/** What still blocks activation, in the order the page asks for it. */
export function activationBlockers(i: Pick<Integration, 'keys_configured' | 'dataset_id' | 'has_token'>): string[] {
  const out: string[] = [];
  if (!i.keys_configured) out.push('Server secret INTEGRATIONS_KEY');
  if (!i.dataset_id) out.push('Dataset ID');
  if (!i.has_token) out.push('Conversions API access token');
  return out;
}

/** An editable mapping row. `source_event` is '' until chosen. */
export type MappingRow = Mapping & { key: string };

let rowSeq = 0;
export const toRows = (mappings: Mapping[]): MappingRow[] => mappings.map((m) => ({ ...m, key: `r${++rowSeq}` }));
export const newRow = (): MappingRow => ({ source_event: '', target_event: '', send_value: false, locked: false, key: `r${++rowSeq}` });

/** The first problem with the edited rows, or null when they can be saved. */
export function mappingProblem(rows: MappingRow[]): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    const source = r.source_event.trim();
    if (!source) return 'Choose an app event for every row.';
    if (!r.target_event.trim()) return `Choose a network event for ${eventLabel(source)}.`;
    if (!r.locked && !/^[A-Za-z0-9_ -]{1,40}$/.test(r.target_event)) return `“${r.target_event}” is not a valid event name (letters, digits, space, _ and -, up to 40).`;
    if (seen.has(source)) return `${eventLabel(source)} is mapped twice.`;
    seen.add(source);
  }
  return null;
}

/** Body for PUT …/mappings. Locked rows are fixed by the server and left out. */
export function mappingPayload(rows: MappingRow[]) {
  return rows.filter((r) => !r.locked).map((r) => ({ source_event: r.source_event.trim(), target_event: r.target_event.trim(), send_value: r.send_value }));
}

export function sameMappings(rows: MappingRow[], saved: Mapping[]): boolean {
  const norm = (list: Array<Pick<Mapping, 'source_event' | 'target_event' | 'send_value'>>) =>
    JSON.stringify(list.map((m) => [m.source_event.trim(), m.target_event.trim(), m.send_value]).sort());
  return norm(rows) === norm(saved);
}

/** App events offered for a row: built-ins, then recent custom events, then whatever the row already holds. */
export function sourceOptions(builtin: string[], custom: string[], current: string): string[] {
  const list = [...builtin, ...custom.filter((c) => !builtin.includes(c))];
  return current && !list.includes(current) ? [...list, current] : list;
}

/** Events Manager URL of a dataset (opens the Test events tab when one is given). */
export function eventsManagerUrl(datasetId: string | null): string {
  return datasetId ? `https://business.facebook.com/events_manager2/list/dataset/${encodeURIComponent(datasetId)}/test_events` : 'https://business.facebook.com/events_manager2';
}
