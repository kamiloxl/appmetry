# @appdash/expo

SDK for [appdash](https://github.com/kamiloxl/appdash): self-hosted, revenue-first analytics for Expo apps. It gives you sessions, screens, custom events, install attribution and RevenueCat revenue matching, with an offline queue.

## Install

```sh
npx expo install @appdash/expo @react-native-async-storage/async-storage expo-application expo-crypto expo-device expo-linking expo-localization
```

`expo-router` is optional (automatic screen tracking). Attribution (Android Install Referrer, Apple Search Ads) needs a native module, so build a development build (`npx expo run:ios`, `run:android` or EAS). See below for Expo Go.

## Init

```tsx
import { Appdash, AppdashProvider } from '@appdash/expo';

Appdash.init({
  appKey: 'app_xxx',                          // from the appdash dashboard
  host: 'https://appdash.you.workers.dev',
  requireConsent: false,                      // true: collect nothing until optIn()
  sessionTimeoutMs: 5 * 60_000,
  debug: false,
});
```

Call `init` once at startup, outside components. The SDK never throws into your app.

## AppdashProvider

Wrap your root layout to track screens automatically through `expo-router`:

```tsx
export default function RootLayout() {
  return (
    <AppdashProvider>
      <Stack />
    </AppdashProvider>
  );
}
```

## Events

```ts
Appdash.screen('Settings');                       // manual screen (React Navigation users)
Appdash.track('paywall_shown', { variant: 'b' }); // props must stay under 1 KB of JSON
Appdash.identify({ userId: 'u_123' });            // email and name are optional personal data
Appdash.reportSource('tiktok');                   // answer to "how did you hear about us?"
```

Prefer an opaque `userId` and leave out email and name unless you need them.

## Consent

```ts
Appdash.init({ appKey, host, requireConsent: true });
// later, after the user agrees:
Appdash.optIn();
// to stop and clear the local queue:
Appdash.optOut();
```

With `requireConsent: true` nothing is stored or sent until `optIn()`.

## RevenueCat

Call it after `Purchases.configure`, inside an async function (no top-level await), and before your first paywall:

```ts
import Purchases from 'react-native-purchases';

async function setupPurchases() {
  Purchases.configure({ apiKey: 'appl_...' });
  await Appdash.syncRevenueCat(Purchases);
}
```

It sets the `appdash_install_id` attribute and RevenueCat's `$mediaSource`, `$campaign`, `$adGroup`, `$ad` and `$keyword`. Do this on every app start. Also add the appdash webhook in RevenueCat (see the main README).

## Expo Go

Expo Go has no native module: attribution inputs are skipped silently and installs are organic. Sessions, screens, events and RevenueCat sync still work.

## Other

`await Appdash.installId()` and `await Appdash.flush()` are available. The install id is a random UUID, never IDFA/GAID, so no ATT prompt is needed. A reinstall is a new install.

Licensed under FSL-1.1-MIT (source-available; each version becomes MIT two years after release). Using it in your own apps, including commercial apps, is allowed; offering a competing commercial product or service is not. See [LICENSE](LICENSE).
