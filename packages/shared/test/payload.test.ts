import { describe, expect, it } from 'vitest';
import { validateBatch } from '../src/payload';

const context = {
  iid: 'install-12345678', platform: 'ios', osVersion: '17.0', appVersion: '1.0.0', build: '1',
  deviceModel: 'iPhone15,2', locale: 'en-GB', timezone: 'Europe/London', sdkVersion: '0.1.0', bundleId: 'com.example.app',
};
const ev = (over: Record<string, unknown> = {}) => ({
  id: 'event-12345678', type: 'screen', ts: 1700000000000, sid: 'session-12345678', name: 'Home', ...over,
});

describe('validateBatch', () => {
  it('accepts a valid batch', () => {
    const r = validateBatch({ context, events: [ev()] });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.dropped).toBe(0); expect(r.batch.events).toHaveLength(1); }
  });
  it('accepts optional device extinfo fields and drops invalid ones', () => {
    const r = validateBatch({ context: { ...context, deviceModelId: 'iPhone15,2', screenWidth: 1179, screenHeight: 2556, screenDensity: 3 }, events: [ev()] });
    expect(r.ok && r.batch.context).toMatchObject({ deviceModelId: 'iPhone15,2', screenWidth: 1179, screenHeight: 2556, screenDensity: 3 });
    const bad = validateBatch({ context: { ...context, deviceModelId: 5, screenWidth: -1, screenHeight: 1e9, screenDensity: 'x' }, events: [ev()] });
    expect(bad.ok).toBe(true);
    if (bad.ok) {
      expect(bad.batch.context).not.toHaveProperty('deviceModelId');
      expect(bad.batch.context).not.toHaveProperty('screenWidth');
      expect(bad.batch.context).not.toHaveProperty('screenHeight');
      expect(bad.batch.context).not.toHaveProperty('screenDensity');
    }
  });
  it('accepts consent events', () => {
    const r = validateBatch({ context, events: [ev({ type: 'consent', name: undefined, props: { adConsent: true, att: 'authorized' } })] });
    expect(r.ok && r.batch.events[0].type).toBe('consent');
  });
  it('rejects bad context', () => {
    expect(validateBatch({ context: { ...context, platform: 'web' }, events: [ev()] }).ok).toBe(false);
    expect(validateBatch({ context: { ...context, locale: 5 }, events: [ev()] }).ok).toBe(false);
    expect(validateBatch({ context: { ...context, iid: 'x' }, events: [ev()] }).ok).toBe(false);
    expect(validateBatch(null).ok).toBe(false);
  });
  it('rejects 0 or 51 events', () => {
    expect(validateBatch({ context, events: [] }).ok).toBe(false);
    expect(validateBatch({ context, events: Array.from({ length: 51 }, () => ev()) }).ok).toBe(false);
    expect(validateBatch({ context, events: Array.from({ length: 50 }, () => ev()) }).ok).toBe(true);
  });
  it('drops invalid events but keeps the batch', () => {
    const r = validateBatch({ context, events: [ev({ type: 'nope' }), ev()] });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.batch.events).toHaveLength(1); expect(r.dropped).toBe(1); }
  });
  it('drops oversized props', () => {
    const big = { a: 'x'.repeat(1025 - 8) }; // {"a":"..."} = 1025 chars
    expect(JSON.stringify(big).length).toBe(1025);
    const r = validateBatch({ context, events: [ev({ props: big }), ev({ props: { a: 'x'.repeat(1016 - 8) } })] });
    expect(r.ok && r.dropped).toBe(1);
  });
  it('truncates name to 255', () => {
    const r = validateBatch({ context, events: [ev({ name: 'n'.repeat(300) })] });
    expect(r.ok && r.batch.events[0].name).toHaveLength(255);
  });
  it('truncates deep_link name to 500', () => {
    const r = validateBatch({ context, events: [ev({ type: 'deep_link', name: 'u'.repeat(600) })] });
    expect(r.ok && r.batch.events[0].name).toHaveLength(500);
  });
  it('rejects bad ids', () => {
    const r = validateBatch({ context, events: [ev({ sid: 'x' }), ev({ id: 'bad id!!!!!' }), ev()] });
    expect(r.ok && r.dropped).toBe(2);
  });
  it('drops non-finite ts', () => {
    const r = validateBatch({ context, events: [ev({ ts: 'now' }), ev({ ts: null })] });
    expect(r.ok && r.dropped).toBe(2);
  });
});
