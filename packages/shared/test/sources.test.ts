import { describe, expect, it } from 'vitest';
import { classify } from '../src/sources';
import { friendlyName } from '../src/names';

describe('classify', () => {
  it('maps utm_source to a known source', () => {
    expect(classify({ utmSource: 'chatgpt.com' })).toMatchObject({ source: 'ChatGPT', channel: 'AI' });
  });
  it('ref wins over nothing and maps known names', () => {
    expect(classify({ ref: 'producthunt' })).toMatchObject({ source: 'Product Hunt' });
    expect(classify({ ref: 'my-newsletter-42' })).toEqual({ source: 'my-newsletter-42', channel: 'Referral' });
  });
  it('detects paid and email mediums', () => {
    expect(classify({ utmSource: 'google', utmMedium: 'cpc' }).channel).toBe('Paid');
    expect(classify({ utmSource: 'buttondown', utmMedium: 'email' }).channel).toBe('Email');
  });
  it('defaults to Direct/None', () => {
    expect(classify({})).toEqual({ source: 'Direct/None', channel: 'Direct' });
  });
  it('does not expose referrerDomain', () => {
    expect(classify({ utmSource: 'x' })).not.toHaveProperty('referrerDomain');
  });
});

describe('friendlyName', () => {
  it('is stable per id', () => {
    expect(friendlyName('abc')).toEqual(friendlyName('abc'));
    expect(friendlyName('abc').name).toMatch(/^\w+ \w+$/);
  });
});
