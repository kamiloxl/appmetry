import { describe, expect, it } from 'vitest';
import {
  organic, fromInstallReferrer, fromAdServices, fromTouch, fromReported, mergeAttribution,
} from '../src/attribution';

describe('organic', () => {
  it('ios', () => {
    expect(organic('ios')).toMatchObject({ source: 'App Store', channel: 'Organic', method: 'organic', click_id: null });
  });
  it('android', () => {
    expect(organic('android')).toMatchObject({ source: 'Google Play', channel: 'Organic', method: 'organic' });
  });
});

describe('fromInstallReferrer', () => {
  it('link utm overrides referrer', () => {
    const a = fromInstallReferrer('click_id=c1&utm_source=x', { click_id: 'c1', utm_source: 'tiktok', utm_campaign: 'launch' });
    expect(a).toMatchObject({ method: 'install_referrer', source: 'TikTok', utm_campaign: 'launch', click_id: 'c1' });
  });
  it('uses referrer utm without link', () => {
    expect(fromInstallReferrer('utm_source=google&utm_medium=cpc&utm_campaign=g1', null)).toMatchObject({ channel: 'Paid', utm_campaign: 'g1' });
  });
  it('null for organic', () => {
    expect(fromInstallReferrer('utm_source=google-play&utm_medium=organic', null)).toBeNull();
    expect(fromInstallReferrer('', null)).toBeNull();
  });
  it('click-level values beat the link and the referrer; ad ids travel with the attribution', () => {
    const a = fromInstallReferrer('click_id=c1&utm_source=x&campaign_id=1', {
      click_id: 'c1', utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'spring', campaign_id: '120', adset_id: '121', ad_id: '122', fbclid: 'IwAR',
    });
    expect(a).toMatchObject({ channel: 'Paid', utm_campaign: 'spring', campaign_id: '120', adset_id: '121', ad_id: '122', fbclid: 'IwAR', campaign_ids: null });
  });
  it('reads ad ids from the referrer when there is no link', () => {
    expect(fromInstallReferrer('utm_source=meta&utm_medium=paid_social&campaign_id=7&ad_id=9', null)).toMatchObject({ campaign_id: '7', ad_id: '9', adset_id: null });
  });
  it('returns null for click_id-only referrer without link', () => {
    expect(fromInstallReferrer('click_id=abc', null)).toBeNull();
  });
  it('returns null for campaign-only referrer', () => {
    expect(fromInstallReferrer('utm_campaign=x', null)).toBeNull();
  });
  it('link without utm keeps referrer utm_source', () => {
    expect(fromInstallReferrer('utm_source=tiktok', { click_id: 'c1' })).toMatchObject({ source: 'TikTok', click_id: 'c1' });
  });
  it('organic Play marker is case-insensitive', () => {
    expect(fromInstallReferrer('utm_source=Google-Play&utm_medium=Organic', null)).toBeNull();
  });
});

describe('fromAdServices', () => {
  it('attributed', () => {
    expect(fromAdServices({ attribution: true, campaignId: 5, adGroupId: 6, keywordId: 7 })).toMatchObject({
      source: 'Apple Search Ads', channel: 'Paid Search', method: 'search_ads',
      asa_campaign_id: 5, asa_adgroup_id: 6, asa_keyword_id: 7,
    });
  });
  it('not attributed', () => {
    expect(fromAdServices({ attribution: false })).toBeNull();
  });
});

describe('fromTouch / fromReported', () => {
  it('deep link', () => {
    expect(fromTouch({ utm_source: 'x', ref: 'r', click_id: 'c' }, 'deep_link')).toMatchObject({
      method: 'deep_link', source: 'X', ref: 'r', click_id: 'c', asa_campaign_id: null,
    });
    expect(fromTouch({ utm_source: 'meta', campaign_ids: 'ARFx', fbclid: 'IwAR' }, 'deep_link')).toMatchObject({ campaign_ids: 'ARFx', fbclid: 'IwAR' });
  });
  it('reported known and unknown', () => {
    expect(fromReported('TikTok')).toMatchObject({ method: 'reported', source: 'TikTok', channel: 'Organic Social' });
    expect(fromReported('  my friend  ')).toMatchObject({ source: 'my friend', channel: 'Referral' });
    expect(fromReported('a'.repeat(200)).source).toHaveLength(100);
  });
});

describe('mergeAttribution', () => {
  const ir = fromInstallReferrer('utm_source=x', null)!;
  const dl = fromTouch({ utm_source: 'x' }, 'deep_link');
  const rep = fromReported('foo');
  it('keeps higher priority', () => {
    expect(mergeAttribution(ir, dl)).toBe(ir);
    expect(mergeAttribution(organic('ios'), rep)).toBe(rep);
    expect(mergeAttribution(dl, rep)).toBe(dl);
    expect(mergeAttribution(dl, null)).toBe(dl);
  });
});
