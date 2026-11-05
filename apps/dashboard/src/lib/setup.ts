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

/**
 * The privacy-policy template of step 6. It lists what appmetry collects so the deployer can paste it into a policy.
 * A starting point the deployer must review; not legal advice.
 */
export function privacyParagraph(appName: string, retentionMonths: number): string {
  const months = `${retentionMonths} month${retentionMonths === 1 ? '' : 's'}`;
  return `${appName} uses appmetry, an analytics tool that the developer hosts on their own Cloudflare account, to understand how the app is used and which marketing works. It collects: a random install id generated on your device (it does not use your advertising identifier, IDFA or GAID); your device model, operating system version, app version, language and timezone; and your approximate location at country, region and city level, worked out from your network request (your IP address is not stored). It records sessions, screen views and custom events. For attribution it records campaign and source details from tracked links, the Google Play install referrer and Apple Search Ads. Subscription and purchase events from RevenueCat are linked to your install id. If you sign in, a user id, and your email or name only if the app chooses to send them, may also be stored. Data is kept for ${months}. You can ask us to delete the data linked to you; purchase amounts and link-click counts are kept without any information that identifies you.`;
}
