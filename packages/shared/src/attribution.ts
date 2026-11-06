import type { Platform } from './payload';
import { classify, findKnownSource, type Channel } from './sources';
import { touchFromQuery, type Touch } from './url';

export type AttributionMethod = 'install_referrer' | 'search_ads' | 'deep_link' | 'reported' | 'organic';

export interface InstallAttribution {
  method: AttributionMethod;
  source: string;
  channel: Channel;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  ref: string | null;
  click_id: string | null;
  asa_campaign_id: number | null;
  asa_adgroup_id: number | null;
  asa_keyword_id: number | null;
  /** Ad-network ids from the click or deep link (Touch); they travel with the method that carried them. */
  campaign_id: string | null;
  adset_id: string | null;
  ad_id: string | null;
  fbclid: string | null;
  campaign_ids: string | null;
}

export interface AdServicesResult {
  attribution: boolean;
  campaignId?: number;
  adGroupId?: number;
  keywordId?: number;
}

/** The stored click (its own query values first) merged over its link. */
export interface LinkTouch extends Touch {
  click_id: string;
}

export const METHOD_PRIORITY: Record<AttributionMethod, number> = {
  install_referrer: 1,
  search_ads: 2,
  deep_link: 3,
  reported: 4,
  organic: 5,
};

function base(method: AttributionMethod, source: string, channel: Channel): InstallAttribution {
  return {
    method, source, channel,
    utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null,
    ref: null, click_id: null,
    asa_campaign_id: null, asa_adgroup_id: null, asa_keyword_id: null,
    campaign_id: null, adset_id: null, ad_id: null, fbclid: null, campaign_ids: null,
  };
}

function fromTouchWith(method: AttributionMethod, t: Touch): InstallAttribution {
  const { source, channel } = classify({ utmSource: t.utm_source, utmMedium: t.utm_medium, ref: t.ref });
  return {
    ...base(method, source, channel),
    utm_source: t.utm_source ?? null,
    utm_medium: t.utm_medium ?? null,
    utm_campaign: t.utm_campaign ?? null,
    utm_term: t.utm_term ?? null,
    utm_content: t.utm_content ?? null,
    ref: t.ref ?? null,
    click_id: t.click_id ?? null,
    campaign_id: t.campaign_id ?? null,
    adset_id: t.adset_id ?? null,
    ad_id: t.ad_id ?? null,
    fbclid: t.fbclid ?? null,
    campaign_ids: t.campaign_ids ?? null,
  };
}

export function organic(platform: Platform): InstallAttribution {
  return base('organic', platform === 'ios' ? 'App Store' : 'Google Play', 'Organic');
}

export function fromInstallReferrer(raw: string, link: LinkTouch | null): InstallAttribution | null {
  const parsed = touchFromQuery(raw);
  const t: Touch = link
    ? {
        utm_source: link.utm_source ?? parsed.utm_source,
        utm_medium: link.utm_medium ?? parsed.utm_medium,
        utm_campaign: link.utm_campaign ?? parsed.utm_campaign,
        utm_term: link.utm_term ?? parsed.utm_term,
        utm_content: link.utm_content ?? parsed.utm_content,
        ref: link.ref ?? parsed.ref,
        click_id: link.click_id,
        campaign_id: link.campaign_id ?? parsed.campaign_id,
        adset_id: link.adset_id ?? parsed.adset_id,
        ad_id: link.ad_id ?? parsed.ad_id,
        placement: link.placement ?? parsed.placement,
        fbclid: link.fbclid ?? parsed.fbclid,
        campaign_ids: link.campaign_ids ?? parsed.campaign_ids,
      }
    : parsed;
  if (t.utm_source?.toLowerCase() === 'google-play' && t.utm_medium?.toLowerCase() === 'organic') return null;
  // Without a source or ref there is nothing to attribute: treat as organic.
  if (!t.utm_source && !t.ref) return null;
  return fromTouchWith('install_referrer', t);
}

export function fromAdServices(r: AdServicesResult): InstallAttribution | null {
  if (!r.attribution) return null;
  return {
    ...base('search_ads', 'Apple Search Ads', 'Paid Search'),
    asa_campaign_id: r.campaignId ?? null,
    asa_adgroup_id: r.adGroupId ?? null,
    asa_keyword_id: r.keywordId ?? null,
  };
}

export function fromTouch(t: Touch, method: 'deep_link'): InstallAttribution {
  return fromTouchWith(method, t);
}

export function fromReported(answer: string): InstallAttribution {
  const known = findKnownSource(answer);
  if (known) return base('reported', known.name, known.channel);
  return base('reported', answer.trim().slice(0, 100), 'Referral');
}

export function mergeAttribution(current: InstallAttribution, candidate: InstallAttribution | null): InstallAttribution {
  if (!candidate) return current;
  return METHOD_PRIORITY[candidate.method] < METHOD_PRIORITY[current.method] ? candidate : current;
}

/** GET /api/v1/attribution?iid=… response. `resolved` is false while an Apple Search Ads token is still pending. */
export interface AttributionResponse {
  resolved: boolean;
  method: AttributionMethod;
  source: string;
  channel: Channel;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  asa_campaign_id: number | null;
  asa_adgroup_id: number | null;
  asa_keyword_id: number | null;
}
