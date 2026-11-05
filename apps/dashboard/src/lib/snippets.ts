import type { RcHealth } from './types';

/** The sentence every AI prompt ends with. */
export const PRIVACY_SENTENCE = "Do not send email or name in identify() unless the app's privacy policy covers it.";

export function installSnippet(host: string, appKey: string): string {
  return `# 1. Install
npx expo install @appdash/expo
# (pnpm add @appdash/expo works too; use a development build for install attribution, Expo Go works without it)

// 2. app/_layout.tsx
import { Appdash, AppdashProvider } from '@appdash/expo';
import Purchases from 'react-native-purchases';

Appdash.init({ appKey: '${appKey}', host: '${host}' });

export default function RootLayout() {
  return (
    <AppdashProvider>
      <Slot />
    </AppdashProvider>
  );
}

// 3. RevenueCat (optional): after Purchases.configure, before the first paywall
Purchases.configure({ apiKey: '<your RevenueCat public key>' });
await Appdash.syncRevenueCat(Purchases);
// ...show your first paywall after this line
`;
}

export function aiPrompt(host: string, appKey: string): string {
  return `Add appdash analytics to this Expo (React Native) project.

1. Install the SDK: run \`npx expo install @appdash/expo\`.
2. In the root layout (for example app/_layout.tsx), import \`Appdash\` and \`AppdashProvider\` from '@appdash/expo' and call \`Appdash.init({ appKey: '${appKey}', host: '${host}' })\` once at module level, outside any component.
3. Wrap the app's root component tree in \`<AppdashProvider>\`.
4. If the project uses react-native-purchases (RevenueCat), call \`await Appdash.syncRevenueCat(Purchases)\` right after \`Purchases.configure(...)\` and before the first paywall is shown. Skip this step otherwise.
5. Optionally, once the user signs in, call \`Appdash.identify({ userId })\` with an opaque user id from the app's own backend.

Note: install attribution (Play Install Referrer and Apple Search Ads) needs a development build (\`npx expo run:android\` / \`npx expo run:ios\` or an EAS development build). Expo Go works for everything else.

${PRIVACY_SENTENCE}
`;
}

const WARNING_FIX = 'Call Appdash.syncRevenueCat(Purchases) on every app start';

function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** One-line RevenueCat integration status. `now` is injectable for tests. */
export function healthLabel(h: RcHealth, now: number = Date.now()): { text: string; warning: boolean } {
  if (h.lastEventAt === null) return { text: 'No events yet', warning: false };
  if (h.events24h === 0) return { text: 'No production events in the last 24 h', warning: false };
  const share = Math.round((h.withInstallId24h / h.events24h) * 100);
  const matched = Math.round((h.matched24h / h.events24h) * 100);
  const when = h.lastEventAt >= now ? 'just now' : ago(now - h.lastEventAt);
  const base = `Last event ${when} · ${share}% carry appdash_install_id · ${matched}% matched`;
  return { text: h.warning ? `${base}. ${WARNING_FIX}` : base, warning: h.warning };
}
