import { describe, expect, it } from 'vitest';
import { passwordsMatch, randomId, safeEqual, sha256Hex, signToken, verifyToken } from '../src/lib/crypto';
import { bucketLabels, resolveRange, startOfDay, tzOffset } from '../src/lib/time';
import { platformFromUA } from '../src/lib/ua';

describe('time ranges', () => {
  const now = Date.UTC(2026, 9, 23, 12, 0); // 23 Oct 2026 12:00 UTC
  it('computes timezone offsets', () => {
    expect(tzOffset('Asia/Kolkata', now)).toBe(330 * 60_000);
    expect(tzOffset('UTC', now)).toBe(0);
  });
  it('starts "today" at local midnight', () => {
    const r = resolveRange({ period: 'today' }, 'Asia/Kolkata', 0, now);
    expect(r.from).toBe(Date.UTC(2026, 9, 22, 18, 30));
    expect(r.granularity).toBe('hour');
  });
  it('last 30 days covers 30 local days', () => {
    const r = resolveRange({ period: '30d' }, 'UTC', 0, now);
    expect(r.from).toBe(startOfDay(now, 'UTC') - 29 * 86_400_000);
    expect(bucketLabels(r, 0)).toHaveLength(30);
  });
  it('custom ranges include the whole last day', () => {
    const r = resolveRange({ period: 'custom', from: '2026-10-01', to: '2026-10-07' }, 'UTC', 0, now);
    expect(r.to - r.from).toBe(7 * 86_400_000);
  });
  it('weekly buckets start on Monday', () => {
    const r = resolveRange({ period: '30d', granularity: 'week' }, 'UTC', 0, now);
    for (const l of bucketLabels(r, 0)) expect(new Date(l + 'T00:00:00Z').getUTCDay()).toBe(1);
  });
});

describe('platformFromUA', () => {
  it('detects iOS', () => {
    expect(
      platformFromUA(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      ),
    ).toBe('ios');
    expect(platformFromUA('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15')).toBe('ios');
  });
  it('detects Android', () => {
    expect(
      platformFromUA(
        'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('android');
  });
  it('treats everything else as other', () => {
    expect(platformFromUA('curl/8.7.1')).toBe('other');
    expect(platformFromUA('')).toBe('other');
    expect(platformFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15')).toBe('other');
  });
});

describe('crypto', () => {
  it('signs and verifies tokens', async () => {
    const t = await signToken('secret', 'admin.123');
    expect(await verifyToken('secret', t)).toBe('admin.123');
    expect(await verifyToken('other', t)).toBeNull();
    expect(await verifyToken('secret', t + 'x')).toBeNull();
    expect(await verifyToken('secret', undefined)).toBeNull();
  });
  it('compares in constant time and hashes', async () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(await passwordsMatch('test-password-12', 'test-password-12')).toBe(true);
    expect(await passwordsMatch('test-password-12', 'test-password-13')).toBe(false);
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(randomId(10)).toMatch(/^[0-9a-z]{20}$/);
  });
});
