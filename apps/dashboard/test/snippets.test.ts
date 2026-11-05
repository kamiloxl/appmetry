import { describe, expect, it } from 'vitest';
import { aiPrompt, healthLabel, installSnippet } from '../src/lib/snippets';
import type { RcHealth } from '../src/lib/types';

const NOW = 1_700_000_000_000;
const health = (o: Partial<RcHealth>): RcHealth => ({ lastEventAt: null, events24h: 0, withInstallId24h: 0, matched24h: 0, warning: false, ...o });

describe('installSnippet', () => {
  const s = installSnippet('https://stats.example.com', 'app_abc123');
  it('contains host, key and syncRevenueCat after Purchases.configure', () => {
    expect(s).toContain('https://stats.example.com');
    expect(s).toContain('app_abc123');
    expect(s).toContain('npx expo install @appdash/expo');
    expect(s).toContain('<AppdashProvider>');
    expect(s.indexOf('await Appdash.syncRevenueCat(Purchases)')).toBeGreaterThan(s.indexOf('Purchases.configure'));
  });
  it('places syncRevenueCat before the first paywall', () => {
    expect(s.toLowerCase().lastIndexOf('paywall')).toBeGreaterThan(s.indexOf('syncRevenueCat'));
  });
});

describe('aiPrompt', () => {
  const p = aiPrompt('https://stats.example.com', 'app_abc123');
  it('contains the privacy sentence last', () => {
    expect(p.trimEnd().endsWith("Do not send email or name in identify() unless the app's privacy policy covers it.")).toBe(true);
  });
  it('is self-contained', () => {
    expect(p).toContain('npx expo install @appdash/expo');
    expect(p).toContain('https://stats.example.com');
    expect(p).toContain('app_abc123');
    expect(p).toContain('AppdashProvider');
    expect(p).toContain('syncRevenueCat');
    expect(p).toContain('development build');
  });
});

describe('healthLabel', () => {
  it('says there are no events yet', () => {
    expect(healthLabel(health({ lastEventAt: null }), NOW)).toEqual({ text: 'No events yet', warning: false });
  });
  it('formats the healthy case', () => {
    const r = healthLabel(health({ lastEventAt: NOW - 5 * 60_000, events24h: 100, withInstallId24h: 92, matched24h: 88 }), NOW);
    expect(r).toEqual({ text: 'Last event 5 min ago · 92% carry appdash_install_id · 88% matched', warning: false });
  });
  it('warns below 50% with the 40% figure and the fix', () => {
    const r = healthLabel(health({ lastEventAt: NOW - 60_000, events24h: 10, withInstallId24h: 4, matched24h: 2, warning: true }), NOW);
    expect(r.warning).toBe(true);
    expect(r.text).toContain('40%');
    expect(r.text).toContain('Call Appdash.syncRevenueCat(Purchases) on every app start');
  });
  it('does not divide by zero when there are no production events in 24 h', () => {
    const r = healthLabel(health({ lastEventAt: NOW - 3 * 86_400_000, events24h: 0 }), NOW);
    expect(r).toEqual({ text: 'No production events in the last 24 h', warning: false });
  });
});
