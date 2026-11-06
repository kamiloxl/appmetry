import { describe, expect, it } from 'vitest';
import { extractTouch, stripPrivateParams, touchFromQuery } from '../src/url';

describe('url', () => {
  it('strips private params', () => {
    expect(stripPrivateParams('myapp://x?email=a@b.c&utm_source=x&Token=1')).toBe('myapp://x?utm_source=x');
    expect(stripPrivateParams('https://a.io/p?code=1#frag')).toBe('https://a.io/p');
    expect(stripPrivateParams('not a url')).toBe('not a url');
  });
  it('drops fragment containing tokens', () => {
    expect(stripPrivateParams('myapp://cb#access_token=abc')).toBe('myapp://cb');
  });
  it('drops fragment after query', () => {
    expect(stripPrivateParams('https://a.io/p?utm_source=x#/r?token=y')).toBe('https://a.io/p?utm_source=x');
  });
  it('extractTouch ignores params only in the fragment', () => {
    expect(extractTouch('https://a.io/#utm_source=x&ref=y')).toBeNull();
    expect(extractTouch('https://a.io/?utm_source=a#utm_medium=b')).toEqual({ utm_source: 'a' });
  });
  it('extractTouch reads utm, ref, via, click_id', () => {
    expect(extractTouch('myapp://x?utm_source=a&utm_medium=b&utm_campaign=c&utm_term=d&utm_content=e&click_id=z&ref=r'))
      .toEqual({ utm_source: 'a', utm_medium: 'b', utm_campaign: 'c', utm_term: 'd', utm_content: 'e', click_id: 'z', ref: 'r' });
    expect(extractTouch('https://a.io/?via=friend')).toEqual({ ref: 'friend' });
  });
  it('extractTouch returns null for plain urls', () => {
    expect(extractTouch('https://a.io/page?x=1')).toBeNull();
    expect(extractTouch('myapp://home')).toBeNull();
  });
  it('reads ad-network campaign parameters', () => {
    expect(
      touchFromQuery('utm_source=meta&campaign_id=120&adset_id=121&ad_id=122&placement=Facebook_Mobile_Feed&fbclid=IwAR1&campaign_ids=ARFx'),
    ).toEqual({
      utm_source: 'meta', campaign_id: '120', adset_id: '121', ad_id: '122', placement: 'Facebook_Mobile_Feed', fbclid: 'IwAR1', campaign_ids: 'ARFx',
    });
    expect(extractTouch('myapp://onboarding?campaign_ids=ARFx')).toEqual({ campaign_ids: 'ARFx' });
  });
  it('caps ad parameter lengths and ignores unfilled ad macros', () => {
    const t = touchFromQuery(`ad_id=${'9'.repeat(300)}&campaign_ids=${'a'.repeat(2000)}&adset_id={{adset.id}}`);
    expect(t.ad_id).toHaveLength(200);
    expect(t.campaign_ids).toHaveLength(1000);
    expect(t.adset_id).toBeUndefined();
  });
  it('touchFromQuery parses a Play referrer', () => {
    expect(touchFromQuery('utm_source=google-play&utm_medium=organic')).toEqual({ utm_source: 'google-play', utm_medium: 'organic' });
  });
});
