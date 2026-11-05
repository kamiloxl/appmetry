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
  it('touchFromQuery parses a Play referrer', () => {
    expect(touchFromQuery('utm_source=google-play&utm_medium=organic')).toEqual({ utm_source: 'google-play', utm_medium: 'organic' });
  });
});
