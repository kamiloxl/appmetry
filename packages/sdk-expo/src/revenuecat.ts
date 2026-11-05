import type { AttributionResponse } from '@appdash/shared';

import { log } from './log';

/**
 * The subset of the `react-native-purchases` default export (checked against v11.0.1, where all of these
 * are static methods) that appdash uses. Pass `Purchases` itself.
 */
export interface RevenueCatLike {
  setAttributes(a: Record<string, string | null>): unknown;
  setMediaSource?(v: string | null): unknown;
  setCampaign?(v: string | null): unknown;
  setAdGroup?(v: string | null): unknown;
  setAd?(v: string | null): unknown;
  setKeyword?(v: string | null): unknown;
  syncAttributesAndOfferingsIfNeeded?(): Promise<unknown>;
}

const str = (v: string | number | null | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : s; // RevenueCat deletes an attribute set to null or ''
};

export function rcAttributes(a: AttributionResponse): {
  mediaSource: string;
  campaign: string | null;
  adGroup: string | null;
  ad: string | null;
  keyword: string | null;
} {
  return {
    mediaSource: a.source,
    campaign: str(a.utm_campaign) ?? str(a.asa_campaign_id),
    adGroup: str(a.asa_adgroup_id),
    ad: str(a.utm_content),
    keyword: str(a.utm_term) ?? str(a.asa_keyword_id),
  };
}

async function safe(what: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log(`revenuecat ${what} failed`, err);
  }
}

/** Writes the install id into the RevenueCat customer. Never throws. */
export async function applyInstallId(p: RevenueCatLike, iid: string): Promise<void> {
  await safe('setAttributes', () => p.setAttributes({ appdash_install_id: iid }));
}

/** Sets the non-null attribution attributes, then syncs so Targeting sees them. Never throws. */
export async function applyAttribution(p: RevenueCatLike, a: AttributionResponse): Promise<void> {
  const r = rcAttributes(a);
  const set = async (name: string, v: string | null) => {
    if (v === null || v === '') return;
    // The setters are static methods on the Purchases class: call them as methods, not detached.
    await safe(name, () => (p as unknown as Record<string, ((x: string) => unknown) | undefined>)[name]?.(v));
  };
  await set('setMediaSource', str(r.mediaSource));
  await set('setCampaign', r.campaign);
  await set('setAdGroup', r.adGroup);
  await set('setAd', r.ad);
  await set('setKeyword', r.keyword);
  await safe('syncAttributesAndOfferingsIfNeeded', () => p.syncAttributesAndOfferingsIfNeeded?.());
}
