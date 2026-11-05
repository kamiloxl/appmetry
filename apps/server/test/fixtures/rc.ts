/**
 * RevenueCat webhook fixtures. Field names follow RevenueCat's webhook payload (verified 2026-11-05):
 * body `{ api_version, event }`, prices in USD, timestamps in ms.
 */

export interface RcFixtureEvent {
  id: string;
  type: string;
  app_user_id?: string | null;
  original_app_user_id?: string | null;
  aliases?: string[];
  subscriber_attributes?: Record<string, { value: string; updated_at_ms: number }>;
  product_id?: string | null;
  store?: string | null;
  environment?: 'SANDBOX' | 'PRODUCTION';
  price?: number | null;
  period_type?: string | null;
  is_trial_conversion?: boolean;
  cancel_reason?: string | null;
  event_timestamp_ms?: number;
  purchased_at_ms?: number;
  [k: string]: unknown;
}

let seq = 0;

/** A production INITIAL_PURCHASE ($9.99, NORMAL period) with a fresh id. Patch any field, `null` included. */
export function rcEvent(patch: Partial<RcFixtureEvent> = {}): RcFixtureEvent {
  seq += 1;
  const now = Date.now();
  return {
    id: `rc-evt-${crypto.randomUUID()}-${seq}`,
    type: 'INITIAL_PURCHASE',
    app_user_id: '$RCAnonymousID:0000000000000000',
    original_app_user_id: '$RCAnonymousID:0000000000000000',
    aliases: ['$RCAnonymousID:0000000000000000'],
    subscriber_attributes: {
      $email: { value: 'jane.doe@example.com', updated_at_ms: now - 5000 },
      $displayName: { value: 'Jane Doe', updated_at_ms: now - 5000 },
    },
    product_id: 'pro_monthly',
    store: 'APP_STORE',
    environment: 'PRODUCTION',
    price: 9.99,
    currency: 'USD',
    price_in_purchased_currency: 9.99,
    period_type: 'NORMAL',
    is_trial_conversion: false,
    cancel_reason: null,
    event_timestamp_ms: now - 1000,
    purchased_at_ms: now - 2000,
    expiration_at_ms: now + 30 * 86_400_000,
    country_code: 'PL',
    transaction_id: '2000000000000001',
    ...patch,
  };
}

/** Add the appdash install id attribute (what `syncRevenueCat` sets in the app). */
export function withInstallAttr(ev: RcFixtureEvent, installId: string): RcFixtureEvent {
  return {
    ...ev,
    subscriber_attributes: { ...ev.subscriber_attributes, appdash_install_id: { value: installId, updated_at_ms: Date.now() - 3000 } },
  };
}

/** The webhook body RevenueCat posts. */
export function rcBody(event: RcFixtureEvent): { api_version: string; event: RcFixtureEvent } {
  return { api_version: '1.0', event };
}
