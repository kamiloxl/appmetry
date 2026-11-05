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
  it('mentions retention, the random install id and no advertising id', async () => {
    const { privacyParagraph } = await import('../src/lib/setup');
    const p = privacyParagraph('Demo', 25);
    expect(p).toContain('25 months');
    expect(p).toContain('random install id');
    expect(p).toContain('IDFA or GAID');
    expect(privacyParagraph('Demo', 1)).toContain('1 month.');
  });
});
