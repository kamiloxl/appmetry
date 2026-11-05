# Manual testing checklist

Unit tests cover the server and the SDK in isolation. These checks prove the pieces work together on real
builds, stores and devices. Run them before a release, and after any change to the SDK's native module,
the ingest API or the RevenueCat webhook.

Each item has steps and expected results. Tick an item only when every expected result holds.

## Setup used by every item

1. Start the server: `pnpm run dev` at the repo root (needs `.dev.vars`; copy it from `.dev.vars.example`).
   It listens on `http://localhost:8787`.
2. Log in and create an app, either in the dashboard or with the API:

   ```sh
   curl -s -c /tmp/appdash.cookies -X POST http://localhost:8787/api/auth/login \
     -H 'content-type: application/json' -d '{"password":"change-me-please"}'
   curl -s -b /tmp/appdash.cookies -X POST http://localhost:8787/api/apps \
     -H 'content-type: application/json' -d '{"name":"Expo demo"}'
   ```

   Keep `id` (the app id) and `app_key` from the response. Leave the bundle ids empty, or set both to
   `dev.appdash.demo`: a different value makes ingest answer `403 bundle_id_mismatch`.
3. Point the demo at it and install dependencies:

   ```sh
   pnpm install
   cd examples/expo-demo
   export EXPO_PUBLIC_APPDASH_HOST=http://localhost:8787   # Android emulator: http://10.0.2.2:8787
   export EXPO_PUBLIC_APPDASH_KEY=app_...
   ```

4. Read results with the same cookie:
   - Overview: `GET /api/apps/<id>/stats/overview?range=7d`
   - One install's timeline: `GET /api/apps/<id>/installs/<installId>`
   - RevenueCat health: `GET /api/apps/<id>/revenuecat/health`

   The install id is shown on the demo's Home tab, and the Paywall tab's "Fake purchase" button logs it.

For a device or store build, the server must be reachable from the phone: deploy it (`pnpm run deploy`)
or expose `wrangler dev` through a tunnel, and use that URL as `EXPO_PUBLIC_APPDASH_HOST`.

---

## 1. iOS simulator, development build (verified on this machine)

Last verified 2026-11-05: Xcode 27.2, iPhone 18 Pro simulator (iOS 27.2), Expo SDK 58.

Steps:
1. `npx expo prebuild --platform ios --clean` (CocoaPods needs a UTF-8 locale: `export LANG=en_US.UTF-8`).
2. `npx expo run:ios --device "<simulator name or udid>"`.
3. Open the Paywall tab, tap "Fake purchase", go back to Home.
4. Send the app to the background (`xcrun simctl launch <udid> com.apple.springboard` or swipe home),
   or wait 15 s for the periodic flush.
5. Read the overview and the install timeline.

Expected:
- The build succeeds, which proves the Swift `AppdashAttribution` module compiles and autolinks.
- Metro logs `[appdash]` debug lines and no red box.
- Overview: `current.installs` = 1 and `current.sessions` ≥ 1.
- Timeline: one `install` entry, a `session` entry with a duration (the duration comes from the `ping`
  sent on backgrounding), `screen` entries for `/` and `/paywall`, and events `paywall_shown` and
  `purchase_clicked`.
- The install has `platform` = `ios`, `attribution_method` = `organic`, channel `Organic`: the simulator
  has no AdServices token (Xcode logs "Attribution is only available on iOS or ipadOS", which shows the
  native module was called).

## 2. Android emulator, development build (not yet verified on this machine (no JDK))

This machine has no JDK and no Android SDK, so this item has never been run. Run it on a machine with
Android Studio before the first release.

Steps:
1. `npx expo prebuild --platform android --clean`.
2. Compile the Kotlin `AppdashAttribution` module (Install Referrer) on its own first, so a Kotlin error is
   not buried in the app build:

   ```sh
   cd android && ./gradlew :appdash_expo:compileDebugKotlin
   ```

   If the Gradle project name differs, list it with `./gradlew projects`.
3. Set `EXPO_PUBLIC_APPDASH_HOST=http://10.0.2.2:8787` (the emulator's alias for the host machine's
   `localhost`), then `npx expo run:android`.
4. Repeat steps 3 to 5 of item 1 (background with the Home button).

Expected:
- `compileDebugKotlin` and the app build succeed.
- The app starts and sends events over cleartext HTTP to `10.0.2.2` (Expo enables cleartext traffic in
  debug builds; if requests fail with a cleartext error, that is the cause).
- Overview: `installs` = 1, `sessions` ≥ 1. Timeline: as in item 1, with `platform` = `android`.
- Attribution is organic: a sideloaded build has no Play referrer (`getInstallReferrer` returns
  `utm_source=google-play&utm_medium=organic` or nothing).

## 3. Play internal testing track with a `/l/<slug>` link (not yet verified)

Steps:
1. Build a release AAB of an app using the SDK (for example the demo with `android.package` changed to
   your Play package) with `EXPO_PUBLIC_APPDASH_HOST` set to the deployed server, and upload it to the
   Play Console internal testing track. Add your Google account as a tester.
2. In appdash, set the app's Play Store URL (`PATCH /api/apps/<id>` with `play_store_url`) and create a
   tracked link: `POST /api/apps/<id>/links` with `{"slug":"demo-play","utm_source":"newsletter","utm_campaign":"launch"}`.
3. Uninstall the app from the test phone. Open `https://<server>/l/demo-play` on the phone.
4. Install from the Play page the link opens (the internal testing opt-in link must be accepted first),
   then open the app.

Expected:
- The link redirects to the Play listing with a `referrer=` parameter that carries the UTM values.
- The link's click count goes up (`GET /api/apps/<id>/stats/links`).
- The install's timeline shows attribution method `install_referrer`, source `newsletter` and campaign
  `launch`.
- The overview's source breakdown counts the install under that source.

## 4. Real iOS device build (not yet verified)

Steps:
1. Enable Developer Mode on the iPhone. Set `EXPO_PUBLIC_APPDASH_HOST` to a URL the phone can reach.
2. `npx expo run:ios --device` and choose the phone (a free or paid signing team is enough).
3. Open the app once, then background it.

Expected:
- The `install` event's props contain `asaToken` (a long Base64 string). The SDK never stores it;
  the server exchanges it with Apple.
- Apple answers a development build with its test payload (`attribution: true`, test campaign ids such as
  `1234567890`). The install shows attribution method `search_ads`, channel `Paid Search`, and the test
  campaign id. If Apple has not answered yet, the install keeps a pending token and is retried.
- No IDFA prompt appears: AdServices does not need App Tracking Transparency.

## 5. Expo Go (not yet verified)

Steps:
1. `npx expo start` in `examples/expo-demo` and open the project in Expo Go on a device or simulator.
2. Use both tabs, then background the app.

Expected:
- No crash and no red box. The native module is missing in Expo Go, so `requireOptionalNativeModule`
  returns null and the SDK skips it.
- Events arrive as in item 1.
- The install has no `asaToken` or referrer props, and its attribution is organic.

## 6. Airplane mode (not yet verified)

Steps:
1. Start with the app running on a device or simulator, connected. Note the current event count in the
   install timeline.
2. Turn on airplane mode (simulator: stop `wrangler dev` instead).
3. Switch tabs several times and tap "Fake purchase" a few times. Background and foreground the app.
4. Wait at least 30 s, then turn airplane mode off (or restart `wrangler dev`). Foreground the app and wait
   up to the backoff interval (it grows from 2 s up to 5 min; a foreground or background triggers a flush).

Expected:
- While offline the app keeps working and debug logs show failed sends with backoff, not a crash.
- After reconnecting, every event made offline appears in the timeline with its original timestamp.
- No event appears twice: each event id is stored once even if a batch was retried.
- Killing the app while offline and reopening it after reconnecting still delivers the queued events (the
  queue is persisted in AsyncStorage).

## 7. RevenueCat sandbox purchase with `syncRevenueCat` (not yet verified)

Steps:
1. In a test app (not the demo, which has no purchase SDK), add `react-native-purchases`, configure it
   with the RevenueCat public SDK key, then call `await Appdash.syncRevenueCat(Purchases)` after
   `Purchases.configure(...)`.
2. In appdash, create the webhook secret: `POST /api/apps/<id>/rc-secret`. In RevenueCat, add a webhook
   to `https://<server>/api/webhooks/revenuecat/<id>` with that secret as the Authorization header.
   Turn on "show sandbox" for the app in appdash so sandbox revenue is counted.
3. Make a sandbox purchase on a device (App Store sandbox account or Play license tester).

Expected:
- The RevenueCat customer page shows the attribute `appdash_install_id` equal to the app's install id,
  and `$mediaSource` equal to the install's source (plus `$campaign` etc. when the install has them).
- appdash receives the webhook (`INITIAL_PURCHASE`, environment `SANDBOX`), and the payment is matched to
  the install with `matched_by` = `attribute`.
- The install timeline shows the payment and the `rc_*` lifecycle event.
- RevenueCat health shows every event carrying the install id (100%) and no warning. Note that health
  counts production events only; to check it, repeat with a production purchase or read `withInstallId24h`
  against `events24h` after a production delivery.
