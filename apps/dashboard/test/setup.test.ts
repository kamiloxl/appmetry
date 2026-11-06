import { describe, expect, it } from 'vitest';
import { nextStep, progressLabel, SETUP_STEPS } from '../src/lib/setup';
import type { SetupStatus, StepStatus } from '../src/lib/types';

function status(over: Partial<Record<(typeof SETUP_STEPS)[number], StepStatus>> = {}): SetupStatus {
  const steps = Object.fromEntries(SETUP_STEPS.map((s) => [s, { done: false }])) as SetupStatus['steps'];
  Object.assign(steps, over);
  return { steps, current: null };
}

describe('progressLabel', () => {
  it('counts done and skipped', () => {
    expect(progressLabel(status({ app: { done: true } }))).toBe('Setup 1/6');
    expect(progressLabel(status({ app: { done: true }, firstEvent: { done: true }, revenuecatWebhook: { done: false, skipped: true } }))).toBe('Setup 3/6');
    expect(progressLabel(status())).toBe('Setup 0/6');
  });
});

describe('nextStep', () => {
  it('returns the first step neither done nor skipped', () => {
    const s = status({ app: { done: true }, firstEvent: { done: true }, revenuecatWebhook: { done: false, skipped: true } });
    expect(nextStep(s)).toBe('revenuecatSync');
  });
  it('returns null when everything is done or skipped', () => {
    const all = Object.fromEntries(SETUP_STEPS.map((k, i) => [k, i % 2 ? { done: true } : { done: false, skipped: true }])) as SetupStatus['steps'];
    expect(nextStep({ steps: all, current: null })).toBeNull();
  });
});

describe('privacyParagraph', () => {
  it('discloses what is collected, retention and the deletion caveat', async () => {
    const { privacyParagraph } = await import('../src/lib/setup');
    const p = privacyParagraph('Demo', 25);
    for (const t of ['random install id', 'IDFA or GAID', 'device model', 'operating system version', 'country, region and city', 'IP address is not stored', 'screen views', 'tracked links', 'install referrer', 'Apple Search Ads', 'RevenueCat', 'user id', 'email or name', '25 months', 'purchase amounts and link-click counts are kept without']) {
      expect(p).toContain(t);
    }
    expect(privacyParagraph('Demo', 1)).toContain('1 month.');
  });

  it('with an active ad network, discloses the advertising id, sharing and transfer instead of denying them', async () => {
    const { privacyParagraph } = await import('../src/lib/setup');
    const p = privacyParagraph('Demo', 25, ['Meta']);
    expect(p).not.toContain('does not use your advertising identifier');
    for (const t of ['agree to advertising measurement', 'IDFA', 'only if you allow tracking', 'GAID', 'Meta', 'installs and purchases', 'IP address', 'outside the UK/EEA', 'withdraw']) {
      expect(p).toContain(t);
    }
  });
});
