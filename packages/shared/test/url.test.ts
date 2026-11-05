import { describe, expect, it } from 'vitest';
import { extractTouch, stripPrivateParams, touchFromQuery } from '../src/url';

describe('url', () => {
  it('strips private params', () => {
    expect(stripPrivateParams('myapp://x?email=a@b.c&utm_source=x&Token=1')).toBe('myapp://x?utm_source=x');
    expect(stripPrivateParams('https://a.io/p?code=1#frag')).toBe('https://a.io/p#frag');
    expect(stripPrivateParams('not a url')).toBe('not a url');
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
