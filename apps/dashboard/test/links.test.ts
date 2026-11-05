import { describe, expect, it } from 'vitest';
import { linkUrl, slugify } from '../src/pages/Links';

describe('slugify', () => {
  it('lowercases and keeps only a-z, 0-9 and hyphens', () => {
    expect(slugify('Launch Tweet #1!')).toBe('launch-tweet-1');
  });
  it('trims stray hyphens and caps at 48 characters', () => {
    expect(slugify('  --Hello   World--  ')).toBe('hello-world');
    expect(slugify('a'.repeat(80))).toHaveLength(48);
    expect(slugify('x'.repeat(47) + ' yyy').endsWith('-')).toBe(false);
  });
});

describe('linkUrl', () => {
  it('builds origin + /l/ + slug', () => {
    expect(linkUrl('https://dash.example.com', 'launch-tweet-1')).toBe('https://dash.example.com/l/launch-tweet-1');
  });
});
