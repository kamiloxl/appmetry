# appmetry

SDK for [appmetry](https://github.com/kamiloxl/appmetry): self-hosted, revenue-first analytics for Expo apps. It gives you sessions, screens, custom events, install attribution and RevenueCat revenue matching, with an offline queue.

## Install

```sh
npx expo install appmetry @react-native-async-storage/async-storage expo-application expo-crypto expo-device expo-linking expo-localization
```

`expo-router` is optional (automatic screen tracking). Attribution (Android Install Referrer, Apple Search Ads) needs a native module, so build a development build (`npx expo run:ios`, `run:android` or EAS). See below for Expo Go.

## Init

```tsx
import { Appmetry, AppmetryProvider } from 'appmetry';

Appmetry.init({
  appKey: 'app_xxx',                          // from the appmetry dashboard
  host: 'https://appmetry.you.workers.dev',
  requireConsent: false,                      // true: collect nothing until optIn()
  sessionTimeoutMs: 5 * 60_000,
  debug: false,
});
```

Call `init` once at startup, outside components. The SDK never throws into your app.

## AppmetryProvider

Wrap your root layout to track screens automatically through `expo-router`:

```tsx
export default function RootLayout() {
  return (
    <AppmetryProvider>
      <Stack />
    </AppmetryProvider>
  );
}
```

## Events

```ts
Appmetry.screen('Settings');                       // manual screen (React Navigation users)
Appmetry.track('paywall_shown', { variant: 'b' }); // props must stay under 1 KB of JSON
Appmetry.identify({ userId: 'u_123' });            // email and name are optional personal data
Appmetry.reportSource('tiktok');                   // answer to "how did you hear about us?"
```

Prefer an opaque `userId` and leave out email and name unless you need them.

## Consent

```ts
Appmetry.init({ appKey, host, requireConsent: true });
// later, after the user agrees:
Appmetry.optIn();
// to stop and clear the local queue:
Appmetry.optOut();
```

With `requireConsent: true` nothing is stored or sent until `optIn()`.

## RevenueCat

Call it after `Purchases.configure`, inside an async function (no top-level await), and before your first paywall:

```ts
import Purchases from 'react-native-purchases';

async function setupPurchases() {
  Purchases.configure({ apiKey: 'appl_...' });
  await Appmetry.syncRevenueCat(Purchases);
}
```

It sets the `appmetry_install_id` attribute and RevenueCat's `$mediaSource`, `$campaign`, `$adGroup`, `$ad` and `$keyword`. Do this on every app start. Also add the appmetry webhook in RevenueCat (see the main README).

## Expo Go

Expo Go has no native module: attribution inputs are skipped silently and installs are organic. Sessions, screens, events and RevenueCat sync still work.

## Other

`await Appmetry.installId()` and `await Appmetry.flush()` are available. The install id is a random UUID, never IDFA/GAID, so no ATT prompt is needed. A reinstall is a new install.

Licensed under FSL-1.1-MIT (source-available; each version becomes MIT two years after release). Using it in your own apps, including commercial apps, is allowed; offering a competing commercial product or service is not. See [LICENSE](LICENSE).
