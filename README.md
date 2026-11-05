# appdash

appdash is a source-available, self-hosted, revenue-first analytics product for Expo apps. It shows which acquisition sources and in-app behaviour actually drive revenue. It runs on your own free Cloudflare account (Workers + D1), with a React dashboard and an Expo SDK (`@appdash/expo`). No central appdash server exists and no telemetry is sent to the appdash project.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kamiloxl/appdash)

> The Deploy button creates the D1 database in Cloudflare's automatic location, which cannot be pinned to the EU. If your users are in the UK/EU, read [Data location](#data-location) before you click it.

## What it tracks

- **Installs, sessions, screens, custom events**, with device, OS, app version, locale, timezone and city-level geo. No IP address, IDFA/GAID or coordinates are stored.
- **Install attribution**: tracked links plus Android Install Referrer, Apple Search Ads (AdServices), deep links and a self-reported source. There is no fingerprinting.
- **Revenue**: RevenueCat webhooks matched to installs and credited to a source (last non-direct touch). Money is stored as integer USD cents; refunds are negative.
- **Dashboard**: overview cards, installs and revenue chart, panels by channel, source, campaign, platform, country and more, a customer journey view, tracked links and per-app settings.

## Deploy in 5 minutes

1. Click **Deploy to Cloudflare** above and connect GitHub. Cloudflare forks the repo into your account.
2. Choose names for the Worker, the repository and the D1 database (the defaults are fine).
3. Enter `ADMIN_PASSWORD` (at least 12 characters). You use it to log in.
4. Wait for the build. Cloudflare pre-fills the build and deploy commands from `package.json`. Keep the deploy command `pnpm run deploy` if Cloudflare shows it: it applies the D1 migrations and then deploys. D1 itself is provisioned from `wrangler.jsonc`.
5. Open the `https://appdash.<your-subdomain>.workers.dev` URL, log in and follow the setup wizard. It takes you to a verified first event and a verified RevenueCat webhook.

Screenshots of the Cloudflare screens are not included yet.

### Updating

In your fork on GitHub click **Sync fork** then **Update branch**. The push triggers Workers Builds, which rebuilds, applies new migrations and deploys. With a manual deploy, `git pull upstream main` and run `pnpm run deploy` again.

### Manual deploy (no GitHub)

Requires Node 22.12 or newer and pnpm.

```sh
pnpm install
npx wrangler login
npx wrangler d1 create appdash --location weur     # or: --jurisdiction eu (see Data location)
# paste the printed database_id into wrangler.jsonc (d1_databases[0].database_id)
npx wrangler secret put ADMIN_PASSWORD             # at least 12 characters
pnpm run build
pnpm run deploy
```

Always write `pnpm run deploy`: plain `pnpm deploy` is a different, built-in pnpm command. `pnpm run deploy` applies D1 migrations (by the `DB` binding) and then runs `wrangler deploy`.

### Data location

The Deploy button provisions D1 automatically and offers no way to choose a location or jurisdiction, so you cannot pin the database to the EU that way. Cloudflare picks a location near the first request. Worker code itself runs globally.

If you must keep data in the EU/UK, use one of these instead:

- **Manual path** above with `--jurisdiction eu` (use it for EU data residency). `--location weur` is only a location hint, not a guarantee.
- **Your own fork with Workers Builds** (instead of the one-click button):
  1. Fork the repo on GitHub.
  2. Create the D1 with `npx wrangler d1 create appdash --jurisdiction eu`.
  3. Edit `database_id` in the fork's `wrangler.jsonc` and commit.
  4. In Cloudflare go to Workers & Pages → Create → Import a repository and pick the fork.
  5. Set the deploy command to `pnpm run deploy` and add the `ADMIN_PASSWORD` variable/secret.

Cloudflare's [Data Processing Addendum](https://www.cloudflare.com/cloudflare-customer-dpa/) applies to your account. Review it and the transfer terms with your own advisers.

## Add the SDK

```sh
npx expo install @appdash/expo @react-native-async-storage/async-storage expo-application expo-crypto expo-device expo-linking expo-localization
```

```tsx
import { Appdash, AppdashProvider } from '@appdash/expo';

Appdash.init({ appKey: 'app_xxx', host: 'https://appdash.you.workers.dev' });
// wrap your root layout in <AppdashProvider> for automatic screen tracking with Expo Router
```

The wizard shows a ready-made snippet and an AI prompt for your app. Full SDK reference: [packages/sdk-expo/README.md](packages/sdk-expo/README.md). A working app is in [examples/expo-demo](examples/expo-demo).

## Tracked links

Create links in the dashboard (**Links**). `/l/<slug>` records a click, then redirects:

- **Android**: to the Play Store with a `referrer` carrying the click id and UTM values (Install Referrer attribution, deterministic).
- **iOS**: to the App Store. See the iOS note under [Accuracy notes](#accuracy-notes).
- **Other**: to the web URL.

## RevenueCat

1. In the dashboard open your app's settings (or wizard step 3) and generate a webhook secret. It is shown once and stored hashed.
2. In RevenueCat go to **Project settings → Integrations → Webhooks**. Paste the webhook URL and paste the secret as the **Authorization header** value. Click **Send test event**; the wizard turns green.
3. In your app, call `Appdash.syncRevenueCat(Purchases)` **after** `Purchases.configure`, inside an async function, and before the first paywall loads.

Notes:

- Confirm your RevenueCat plan includes webhooks.
- Use **one RevenueCat project per appdash app**: RevenueCat event ids are globally unique and are used for de-duplication.
- `syncRevenueCat` sets the `appdash_install_id` subscriber attribute and RevenueCat's attribution attributes (`$mediaSource`, `$campaign`, `$adGroup`, `$ad`, `$keyword`), so RevenueCat Charts, customer filters and paywall Targeting can segment by appdash source and campaign.
- Lifecycle events appear in the Events panel and customer timeline: `rc_trial_started`, `rc_intro_started`, `rc_subscription_started`, `rc_trial_converted`, `rc_subscription_renewed`, `rc_in_app_purchase`, `rc_refunded`, `rc_subscription_cancelled`, `rc_subscription_uncancelled`, `rc_billing_issue`, `rc_subscription_expired`, `rc_product_changed`.
- **Health check**: app settings show the last event, event count, and the share of the last 24 h of production events that carry `appdash_install_id` or matched an install. Below 50% a warning appears, usually because `syncRevenueCat` is not called on every app start, or an old app version is in use.
- Sandbox purchases are stored but hidden unless you enable the sandbox toggle.
- After an `optOut`, RevenueCat attributes stay on the RevenueCat customer. If you need them removed, do that in RevenueCat.

## Apple Search Ads

No setup. On iOS the SDK reads an AdServices token on first launch and the server exchanges it with Apple. Attribution needs a development build or production app (not Expo Go) and a real device for a genuine token. Apple receives only the token.

## Privacy

This section is a starting point, not legal advice.

- **You are the controller.** The person who deploys an instance decides why and how the data is used. appdash is only the tool.
- **Consent (UK GDPR / PECR).** Storing or reading data on the device may need consent. Use `Appdash.init({ requireConsent: true })`: nothing is stored or sent until `Appdash.optIn()`, and `Appdash.optOut()` stops collection and clears the queue on the device. It does not delete data already sent to the server; use Settings → Delete user data for that.
- **What is collected.** A random install id (not IDFA/GAID); device model, OS version, app version, language and timezone; country, region and city derived from the request (the IP is not stored); sessions, screens and custom events; campaign and source details from tracked links, the Play install referrer and Apple Search Ads; RevenueCat purchase events linked to the install id; and, if you call `identify`, a user id and optionally email and name. Private URL parameters (`email`, `token`, `code`, ...) are stripped before anything is stored. The setup wizard (step 6) offers a privacy-policy paragraph that lists this; it is generated in [apps/dashboard/src/lib/setup.ts](apps/dashboard/src/lib/setup.ts).
- **Personal data.** `app_user_id` (RevenueCat) and `identify` email/name are personal data. Send an opaque `userId` rather than an email or name. The erase endpoint takes the id in the query string (`DELETE /api/apps/:id/users`), so avoid emails as ids: they would land in request logs.
- **Retention.** Per-app `retention_months`, default 25. An hourly job (each app at most once per 23 h) deletes events, sessions and link clicks older than the cutoff. It then deletes installs whose last activity is older than the cutoff and that have no session left. For those installs, link clicks are detached, and their payments lose install id, `app_user_id` and session id and get `matched_by = erased`, and their RevenueCat delivery logs lose install id and `app_user_id`, but the rows stay. Payments are never deleted by retention. RevenueCat delivery logs are deleted after 30 days.
- **Erasure.** Settings → Delete user data, by `user_id` or install id. It deletes the matching installs with their sessions and events, detaches their link clicks (the click rows stay), and clears, on their payments, the install id, RevenueCat `app_user_id` and session id (`matched_by` becomes `erased`), and on their delivery logs the install id and `app_user_id`. Payment rows (amount, timestamp, product, store) are kept for accounting without identifying fields. With a `user_id` it also clears `app_user_id` on all payments and delivery logs of that app with that RevenueCat `app_user_id`.
- **Location and processor.** See [Data location](#data-location) and Cloudflare's DPA. GitHub holds your fork; npm serves the SDK at build time; RevenueCat sends webhooks in.
- If your app handles sensitive personal data (for example health, legal or family matters), do a DPIA before sending emails or names through `identify`, and prefer an opaque `userId`.

## Security

- **Rate limits**: ingestion (`/api/v1/*`) is limited to 120 requests per 60 s per IP and app key. The tracked links (`/l/*`) and the RevenueCat webhook are **not** rate limited here: add a Cloudflare WAF rate-limiting rule for those paths.
- The `ratelimits` binding in `wrangler.jsonc` uses `namespace_id` `"1001"`. It must be unique within your Cloudflare account. If another Worker already uses it, change it to another positive integer string.
- `ADMIN_PASSWORD` must be at least 12 characters, otherwise login is refused. Login locks out an IP after 10 failures in 15 minutes.
- The app key is public (as in every client-side analytics tool), so anyone can send fake events; limits, size caps and an optional bundle-id check mitigate it.
- No telemetry is sent to the appdash project.

## Free plan limits

| Limit | Meaning |
| --- | --- |
| 100k Worker requests/day | Batching puts many events in one request; dashboard assets are free static files |
| 100k D1 rows written/day | About 2 writes per event, so roughly 40-50k events/day |
| 5M D1 rows read/day | Dashboard loads at side-project scale |
| 5 GB D1 storage | Years of data at small scale; the retention job caps growth |

## Accuracy notes

- **iOS installs from links** are attributed only through a deep link open or Apple Search Ads. A tracked link to the App Store counts the click, not the install.
- **Expo Go** has no native module: you get organic attribution only (everything else works). Use a development build for Install Referrer and AdServices.
- **A reinstall counts as a new install.**
- **Timezones**: stats use one timezone offset per range, so a range that crosses a DST change can misplace up to an hour.
- An organic install on an iOS simulator shows **App Store**.
- **Editing a link's UTM values changes the attribution of past clicks** from that link.

## Local development

```sh
pnpm install
cp .dev.vars.example .dev.vars    # sets ADMIN_PASSWORD
pnpm run dev                      # http://localhost:8787 (applies local migrations first)
pnpm run seed                     # fills the local DB with 30 days of demo data
pnpm test                         # all workspaces
ADMIN_PASSWORD=... pnpm run smoke http://localhost:8787
```

`pnpm run smoke` runs `scripts/smoke.mjs` (batch, stats, webhook, journey) against a running server.

The example app in [examples/expo-demo](examples/expo-demo) and the checks in [docs/manual-testing.md](docs/manual-testing.md) exercise the SDK on real builds. `pod install` may need `LANG=en_US.UTF-8` in your environment. Android verification is pending: there is no JDK in CI yet.

## Before first release

Maintainer checklist:

- [ ] Add the `NPM_TOKEN` repository secret (npm automation token).
- [ ] Add screenshots of the Cloudflare deploy screens to the "Deploy in 5 minutes" section.

## Releasing the SDK

Only `@appdash/expo` is published (`@appdash/shared` is bundled into it and private). Add an npm automation token as the repository secret `NPM_TOKEN`, then push a tag such as `sdk-v0.1.0`. The workflow in `.github/workflows/release-sdk.yml` checks that the tag matches the SDK version in `packages/sdk-expo/package.json`, then builds and publishes with provenance.

## License

appdash is licensed under the [Functional Source License, Version 1.1, MIT Future License](LICENSE) (FSL-1.1-MIT). It is source-available, not OSI open source.

- **You may** use, copy, modify and redistribute it for any purpose other than a Competing Use. That includes running it to measure your own apps, including commercial apps, plus internal use, non-commercial education and research, and professional services for a licensee.
- **You may not**, without a commercial license, make it available to others in a commercial product or service that substitutes for appdash or offers substantially similar functionality (for example selling it, or a hosted appdash-like analytics service).
- **Each version becomes MIT** two years after its release.

For a commercial license, open an issue or contact the maintainer. Portions adapted from Datadash remain under the MIT License; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). This summary is not legal advice; the [LICENSE](LICENSE) text governs.
