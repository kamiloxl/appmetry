import type { SetupStatus, SetupStep } from './types';

/** In wizard order. */
export const SETUP_STEPS: SetupStep[] = ['app', 'firstEvent', 'revenuecatWebhook', 'revenuecatSync', 'attribution', 'privacy'];

export const STEP_TITLES: Record<SetupStep, string> = {
  app: 'App',
  firstEvent: 'Install the SDK',
  revenuecatWebhook: 'RevenueCat webhook',
  revenuecatSync: 'RevenueCat sync',
  attribution: 'Attribution',
  privacy: 'Privacy',
};

/** Steps the user may skip (spec 6a: the RevenueCat steps for apps without RevenueCat, plus the optional attribution step). */
export const SKIPPABLE: SetupStep[] = ['revenuecatWebhook', 'revenuecatSync', 'attribution'];

/** Steps that verify themselves by polling the status endpoint. */
export const AUTO_STEPS: SetupStep[] = ['firstEvent', 'revenuecatWebhook', 'revenuecatSync'];

const finished = (s: SetupStatus, k: SetupStep) => s.steps[k].done || Boolean(s.steps[k].skipped);

/** First step that is neither done nor skipped; null when setup is complete. */
export function nextStep(s: SetupStatus): SetupStep | null {
  return SETUP_STEPS.find((k) => !finished(s, k)) ?? null;
}

/** Done or skipped steps out of six. */
export function progressCount(s: SetupStatus): number {
  return SETUP_STEPS.filter((k) => finished(s, k)).length;
}

/** "Setup 4/6": done and skipped steps both count. */
export function progressLabel(s: SetupStatus): string {
  return `Setup ${progressCount(s)}/${SETUP_STEPS.length}`;
}

/** The privacy-policy template of step 6. A starting point the deployer must review; not legal advice. */
export function privacyParagraph(appName: string, retentionMonths: number): string {
  const months = `${retentionMonths} month${retentionMonths === 1 ? '' : 's'}`;
  return `${appName} uses appdash, an analytics tool that we host ourselves on Cloudflare, to measure installs, sessions, screen views and purchases. It identifies an installation with a random install id generated on your device. It does not use your advertising identifier (IDFA or GAID). We keep this data for ${months}. You can ask us to delete the data linked to you at any time.`;
}
