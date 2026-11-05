> Note: the product was renamed from appdash to Appmetry after this document was written.

# appdash — design spec (MVP)

Date: 2026-11-05 · Status: draft for review · Working name: **appdash** (rename freely)

## 1. Intent

**What:** "Datadash for mobile apps". Open-source, revenue-first analytics for mobile apps, self-hosted on a free
Cloudflare account. It answers: *where did my users come from, what do they do in the app, and which source made me
money?*

**Who:** indie developers and small teams shipping Expo / React Native apps who sell subscriptions through RevenueCat.

**Success criteria for the MVP**

1. A developer deploys their own instance in ~5 minutes with the **Deploy to Cloudflare** button and one password
   field. A first-run **setup wizard** in the dashboard then takes them to a verified first event and a verified
   RevenueCat webhook (§6a). A manual `wrangler` path stays in the README.
2. Adding `@appdash/expo` plus three lines of code gives sessions, screens, custom events and install context.
3. Installs are attributed via tracked links + Android Install Referrer (deterministic), Apple Search Ads (AdServices),
   deep links and a self-reported source.
4. RevenueCat payments are matched to installs and credited to a source; the dashboard shows revenue by source.
5. Runs within Cloudflare's free plan at side-project scale (≈40–50k events/day).

**Decisions taken in brainstorming**

| Topic | Decision |
| --- | --- |
| Product goal | Revenue-first attribution (Datadash for apps) |
| Revenue source | RevenueCat webhook only |
| Install attribution | Tracked links + Play Install Referrer + Apple Search Ads AdServices + deep links + self-reported source. **No fingerprinting / probabilistic matching.** |
| Deployment | Self-host on the deployer's own Cloudflare account, single admin password (like Datadash). Installed via the Deploy to Cloudflare button, then a setup wizard. No SaaS mode and no CLI installer in MVP. No central appdash server, no telemetry. |
| Dashboard | Desktop web dashboard in the Datadash style |
| Codebase | New pnpm monorepo; port proven pieces from `../datalog` (Datadash) |
| "Mobile first" means | The tracked product is a mobile app; the SDK is the primary integration surface |

## 2. Architecture

```
mobile data log/                 (pnpm workspaces, TypeScript everywhere, FSL-1.1-MIT)
├─ packages/sdk-expo             @appdash/expo — published to npm
│   ├─ src/                      queue, sessions, screens, public API, Expo Router provider
│   ├─ ios/ android/             Expo Module "AppdashAttribution": AdServices token / Install Referrer
├─ packages/shared               payload types + validation, source classification, friendly names
├─ apps/server                   Hono on Cloudflare Workers + D1; also serves the dashboard as static assets
├─ apps/dashboard                React + Vite + Tailwind + Recharts
└─ examples/expo-demo            Expo app used for manual end-to-end testing
```

Runtime: one Worker (`apps/server`) with a D1 binding `DB`, static assets from `apps/dashboard/dist`
(`run_worker_first: ["/api/*", "/l/*"]`), a daily cron, and a Rate Limiting binding for ingestion.

### Deployment (Deploy to Cloudflare button)

Cloudflare's button forks the repo into the user's GitHub/GitLab, provisions the resources declared in the Wrangler
config (D1 included), builds with Workers Builds and deploys. It does not support a subdirectory that depends on
siblings, so **the deployable unit is the repository root**:
- Root `wrangler.jsonc` points at the server and dashboard:
  - `main: apps/server/src/index.ts`
  - `assets.directory: apps/dashboard/dist`
  - `migrations_dir: apps/server/migrations`
  - default D1 name `appdash`, binding `DB`, placeholder id that Cloudflare replaces
- Root `package.json` scripts:
  - `build`: `pnpm --filter @appdash/dashboard build`
  - `deploy`: `wrangler d1 migrations apply DB --remote && wrangler deploy` (migrations by **binding** name, as Cloudflare recommends)
- Root `.dev.vars.example` lists one secret, `ADMIN_PASSWORD`. Its description in `package.json` →
  `cloudflare.bindings` says "At least 12 characters. You'll use it to log in to the dashboard."
- **No `SESSION_SECRET` to set.** On first use the Worker generates a 32-byte random key and stores it in D1 table
  `meta(key PK, value)`. If `SESSION_SECRET` is set as a secret, it takes precedence.
- After deploy, the user opens `https://appdash.<subdomain>.workers.dev`, logs in, and lands in the setup wizard.
- Updates: the forked repo builds on push. The README explains pulling upstream changes, via GitHub "Sync fork" or `git pull upstream`.
- Data location: whether auto-provisioned D1 can be pinned to the EU is checked during implementation. If it can't,
  the README documents creating the D1 in the EU first and pasting its id.

What leaves the deployer's account: Apple receives only the AdServices token; RevenueCat sends webhooks in; GitHub
holds the fork; npm serves the SDK at app build time. Nothing is sent to the appdash project.

**Ported from Datadash** (copied, then adapted — no shared package between the repos):
`lib/crypto.ts` (HMAC sessions, constant-time compare, random ids), `lib/time.ts` (timezone bucketing),
`shared/names.ts` (friendly names), password login + IP lockout from `index.ts`, dashboard layout components
(`Panel`, `OverviewCard`, `Toolbar`, `Modal`, `VisitorModal` → `InstallModal`), stats query patterns from `stats.ts`.

**Not ported:** Dodo, Stripe, Google OAuth, billing, landing page, browser tracker, live globe, exports.

## 3. SDK (`@appdash/expo`)

### Public API

```ts
import { Appdash, AppdashProvider } from '@appdash/expo';

Appdash.init({
  appKey: 'app_xxx',                         // public key from the dashboard
  host: 'https://appdash.you.workers.dev',
  requireConsent: false,                      // true → collect nothing until optIn()
  sessionTimeoutMs: 5 * 60_000,               // background time that ends a session
  debug: false,
});

<AppdashProvider>{/* app */}</AppdashProvider>  // auto screen tracking via expo-router usePathname (if installed)
Appdash.screen('Settings');                      // manual screen (React Navigation users)
Appdash.track('paywall_shown', { variant: 'b' });
Appdash.identify({ userId: 'u_123', email?: string, name?: string });
Appdash.reportSource('tiktok');                  // answer from the app's own "how did you hear about us?" UI
Appdash.optIn(); Appdash.optOut();               // persisted; optOut clears the queue
await Appdash.installId();
await Appdash.syncRevenueCat(Purchases);         // after Purchases.configure, before the first paywall (§3 RevenueCat sync)
await Appdash.flush();
```

### Behaviour

- **Install id**: UUID v4 created on first launch, stored in AsyncStorage. Never IDFA/GAID, so no ATT prompt.
  Reinstall = new install.
- **Session**: starts when `AppState` becomes `active` and no session is open or the app was backgrounded longer than
  `sessionTimeoutMs`. Session id = UUID. Foreground time is accumulated and sent as `ping` deltas on background.
- **Events** carry: `id` (UUID), `type`, `name`, `props`, `ts` (client ms), `sid`, `iid`.
  Types: `install`, `session_start`, `screen`, `event`, `deep_link`, `identify`, `source`, `ping`.
- **Context** (sent once per batch, not per event): platform, OS version, app version, build number, device model,
  locale, timezone, SDK version, bundle id / package name.
- **Queue**: persisted in AsyncStorage, cap 1000 events (drop oldest). Flush every 15 s, on `background`, and when
  ≥20 events are queued. Max 50 events per request. Exponential backoff (2 s → 5 min) on network / 5xx; drop the batch
  on 4xx other than 429.
- **First launch** enqueues `install` with attribution inputs from the native module when available:
  Android → raw Install Referrer string + click/install timestamps; iOS → AdServices token.
- **Deep links** (`expo-linking`, initial URL + `url` events): if the URL has `utm_*`, `ref`, `via` or `click_id`,
  enqueue `deep_link` with the cleaned URL. Private params (`email`, `name`, `phone`, `password`, `token`, `code`,
  `secret`, `key`, …, same list as Datadash `PRIVATE_PARAM`) are stripped before anything is stored or sent.
- **Expo Go / missing native module**: attribution inputs are skipped silently; everything else works.
- **Consent**: with `requireConsent: true`, nothing is written to storage or sent until `optIn()`; the install id is
  created at opt-in.

### RevenueCat sync

Modelled on Appstack's RevenueCat integration, but built only on RevenueCat's public SDK methods.
`@appdash/expo` does not depend on `react-native-purchases`: the app passes its `Purchases` object in.

`Appdash.syncRevenueCat(purchases, { waitMs = 3000 })`:
1. Immediately calls `purchases.setAttributes({ appdash_install_id })`. This is the hard link between our install and
   the RevenueCat customer.
2. Reads the install's attribution: from the local cache, or from `GET /api/v1/attribution`, waiting at most `waitMs`.
3. When resolved, sets RevenueCat's attribution attributes:
   - `setMediaSource(source)`
   - `setCampaign(utm_campaign ?? asa_campaign_id)`
   - `setAdGroup(asa_adgroup_id)`
   - `setAd(utm_content)`
   - `setKeyword(utm_term ?? asa_keyword_id)`

   Null values are skipped.
4. Calls `purchases.syncAttributesAndOfferingsIfNeeded()` when the method exists, so RevenueCat Targeting sees the
   campaign before the paywall loads.

If the attribution resolves later in the same run (Search Ads can take seconds), the SDK applies step 3 again on its
own. Attribution is cached in AsyncStorage once resolved. Before consent the whole call is a no-op.

Result: RevenueCat Charts, customer filters and paywall Targeting can segment by our source and campaign. Every
webhook event carries `appdash_install_id`.

RevenueCat method names are verified against the current `react-native-purchases` during implementation.

### Native module (Expo Modules API)

- iOS: `AAAttribution.attributionToken()` (iOS 14.3+), returns `null` on error / unsupported.
- Android: `InstallReferrerClient` → `{ referrer, clickTs, installTs }`, returns `null` on error; called once.
- The module's own `build.gradle` adds `com.android.installreferrer:installreferrer:2.2` and its podspec weak-links `AdServices`, so no config plugin is needed. Requires a dev build.

## 4. Server (`apps/server`)

### Endpoints

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/batch` | `X-App-Key` (public) | Ingest up to 50 events + context. Body ≤ 64 KB. Returns 202. |
| `GET /api/v1/attribution?iid=` | `X-App-Key` (public) | One install's attribution for the SDK: `{ resolved, method, source, channel, utm_campaign, utm_content, utm_term, asa_campaign_id, asa_adgroup_id, asa_keyword_id }`. 404 if the install is unknown. `resolved: false` while a Search Ads token is pending. |
| `GET /l/:slug` | none | Tracked link: record click, redirect by platform |
| `POST /api/webhooks/revenuecat/:appId` | `Authorization` header == app's RC secret | Payment events |
| `POST /api/auth/login`, `/logout`, `GET /me` | password → HMAC session cookie | Dashboard login (ported) |
| `GET/POST /api/apps…`, `/api/links…`, `/api/stats/…`, `DELETE /api/apps/:id/users` | session | Dashboard API |
| `GET /api/apps/:id/setup` | session | Setup wizard status: `{ steps: { app, firstEvent, revenuecatWebhook, revenuecatSync, attribution, privacy }: { done: boolean, at?: number, detail?: string }, current }` |
| `PATCH /api/apps/:id/setup` | session | Mark a manual step done or skipped: `{ step, state: 'done' \| 'skipped' }` |

### Ingestion (`/api/v1/batch`)

1. Rate limit by IP + app key (Workers Rate Limiting binding); 429 when exceeded.
2. Validate with the shared schema; reject unknown types, oversized props (>1 KB JSON), bad ids.
3. Look up app by key; check `context.bundleId` matches `ios_bundle_id` / `android_package` when those are set.
4. Clamp each `ts` to `[now − 7 days, now + 60 s]`; drop events outside.
5. Geo from `request.cf` (country, region, city). No IP and no coordinates are stored.
6. Build one `db.batch`: upsert install, upsert sessions, `INSERT OR IGNORE` events (PK `(app_id, id)` dedups
   retries), update session counters only for newly inserted events.
7. `install` event with attribution inputs → resolve attribution (§5). AdServices exchange runs in
   `ctx.waitUntil` with up to 3 retries (Apple may return 404 for the first seconds); on failure it is stored as
   `asa_pending` with the token, and the daily cron retries tokens younger than 24 h.

### Tracked links (`/l/:slug`)

Insert `link_clicks` row with a new `click_id`, platform (from UA), country. Redirect:
- Android → `play_store_url` + `&referrer=` URL-encoded `click_id=<id>&utm_source=…&utm_campaign=…`
- iOS → `app_store_url` (clicks counted; installs attributable only via Search Ads or a later deep link)
- other → `web_url` (or app store page if unset)

### Cron (daily, 03:00 UTC)

- Retry pending AdServices tokens.
- Delete events, sessions and link clicks older than the app's `retention_months` (default 25). Installs with no
  session in that period are deleted too.
- Delete `rc_events` older than 30 days.

## 5. Data model (D1)

```sql
apps(id PK, name, app_key UNIQUE, ios_bundle_id, android_package, app_store_url, play_store_url, web_url,
     timezone DEFAULT 'UTC', rc_secret_hash, retention_months DEFAULT 25, show_sandbox DEFAULT 0,
     setup_state TEXT /* JSON, §6a */, created_at)

meta(key PK, value)   -- instance-level values, e.g. the generated session key

installs(app_id, id, PK(app_id,id), platform, first_seen, last_seen, app_version, os_version, device_model,
         locale, country, region, city,
         source, channel, utm_source, utm_medium, utm_campaign, utm_term, utm_content, ref, click_id,
         attribution_method,  -- install_referrer | search_ads | deep_link | reported | organic
         asa_campaign_id, asa_adgroup_id, asa_keyword_id, asa_pending_token, asa_pending_until,
         user_id, email, name)
  INDEX (app_id, first_seen), (app_id, user_id)

sessions(app_id, id, PK(app_id,id), install_id, started_at, last_seen_at, duration, screens, events,
         entry_screen, exit_screen, app_version, os_version, platform, country, region, city,
         source, channel, utm_source, utm_medium, utm_campaign, ref)   -- from deep link, else 'Direct'
  INDEX (app_id, started_at), (app_id, install_id)

events(app_id, id, PK(app_id,id), session_id, install_id, ts, type, name, props)
  INDEX (app_id, ts), (app_id, session_id)

links(id PK, app_id, slug UNIQUE, name, utm_source, utm_medium, utm_campaign, utm_content, ref, created_at)
link_clicks(id PK /* = click_id */, link_id, app_id, ts, platform, country, install_id)
  INDEX (app_id, ts), (link_id)

payments(id PK /* RevenueCat event id */, app_id, ts, kind /* payment|refund */, amount /* USD cents, refunds < 0 */,
         event_type, product_id, store, environment, app_user_id, install_id, session_id, matched_by,
         renewal INTEGER)
  INDEX (app_id, ts), (app_id, app_user_id)

rc_events(id PK /* RevenueCat event id */, app_id, ts, type, environment, has_install_attr INTEGER,
          install_id)   -- delivery log: dedup for every RC event type + integration health
  INDEX (app_id, ts)

login_failures(ip, ts)  INDEX (ip, ts)
```

### Install attribution (resolved once, first match wins)

1. Install Referrer contains `click_id` of a known link → copy link's `utm_*`/`ref`, set `link_clicks.install_id`;
   method `install_referrer`. Referrer with `utm_*` but no `click_id` (e.g. Google Ads) → use those utm values.
   `utm_source=google-play&utm_medium=organic` → organic.
2. AdServices response `attribution: true` → source `Apple Search Ads`, channel `Paid search`, store ids;
   method `search_ads`.
3. `deep_link` event in the install's first session → its utm/ref/click_id; method `deep_link`.
4. `source` event (`reportSource`) → source = answer (normalised via `shared/sources`); method `reported`.
   Only fills an install that is still organic.
5. Otherwise organic: source `App Store` / `Google Play`, channel `Organic`.

Later deep links set the **session's** source (re-engagement); the install's attribution never changes except
step 4 filling an organic install.

### Payment matching (RevenueCat)

Counted event types: `INITIAL_PURCHASE`, `RENEWAL`, `NON_RENEWING_PURCHASE` (payments) and refunds
(`CANCELLATION` events RevenueCat marks as refunds, stored with negative amount). Trial starts (price 0) are stored as
`events` rows, not revenue. Amount = RevenueCat's USD `price`. `SANDBOX` rows are stored and hidden by default.
Exact field names are verified against RevenueCat's webhook docs during implementation.

Match order → `matched_by`:
1. `subscriber_attributes.appdash_install_id.value` → `attribute`
2. `app_user_id`, `original_app_user_id` or `aliases[]` equals `installs.user_id` (most recent install) → `user_id`
3. `app_user_id` equals an install id → `install_id`
4. else `install_id = NULL`, `matched_by = 'none'` (counts in revenue totals, no source)

**Credit**: last non-direct touch before the payment, among (a) the install's attribution at `first_seen` and
(b) sessions with a non-direct source. Stored in `payments.session_id` (NULL = credited to install attribution).
A "Try matching again" action re-runs matching for unmatched payments.

### Subscription lifecycle events

Every RevenueCat delivery is first written to `rc_events`, which is the dedup check for all types. When the event
matches an install, it is also stored as an `events` row: `type = 'event'`, `id = 'rc_' + event.id`,
`session_id = NULL`, `props = { product_id, store, price_usd }`. It then shows up in the Events panel and on the
timeline, filterable by source and campaign.

| RevenueCat event | Our event name |
| --- | --- |
| `INITIAL_PURCHASE`, `period_type` `TRIAL` | `rc_trial_started` |
| `INITIAL_PURCHASE`, `period_type` `INTRO` | `rc_intro_started` |
| `INITIAL_PURCHASE`, other period types | `rc_subscription_started` |
| `RENEWAL` with `is_trial_conversion` | `rc_trial_converted` |
| `RENEWAL` | `rc_subscription_renewed` |
| `NON_RENEWING_PURCHASE` | `rc_in_app_purchase` |
| `CANCELLATION`, `cancel_reason` `CUSTOMER_SUPPORT` | `rc_refunded` |
| `CANCELLATION`, other reasons | `rc_subscription_cancelled` (`props.reason`) |
| `UNCANCELLATION` | `rc_subscription_uncancelled` |
| `BILLING_ISSUE` | `rc_billing_issue` |
| `EXPIRATION` | `rc_subscription_expired` |
| `PRODUCT_CHANGE` | `rc_product_changed` |

Other types are logged in `rc_events` and otherwise ignored. Revenue rules (above) are unchanged. `TEST` events
(RevenueCat's "Send test event" button) are logged so the setup wizard can detect them, and are excluded from health.

### Integration health

Computed from `rc_events` over the last 24 h, with sandbox events excluded:
- time of the last event
- number of events
- share of events carrying `appdash_install_id`
- share of events matched to an install

The dashboard warns when fewer than 50% carry the attribute, as Appstack does. The usual cause is
`syncRevenueCat` not being called on every app start, or an old app version.

## 6. Dashboard (`apps/dashboard`)

Desktop layout ported from Datadash.

- **Overview cards** with % change vs previous period: installs, active users, sessions, revenue, conversion rate
  (paying installs ÷ installs), revenue per install, average session duration.
- **Chart**: installs (line) + revenue (bars); hourly/daily/weekly/monthly; Datadash date ranges with ‹ ›.
- **Panels**: Channel / Source / Campaign / Search Ads campaign · Platform / Country / App version / OS / Device ·
  Screens / Events. Clicking a row filters the whole dashboard.
- **Customers (Journey)**: paying installs with amount, source, `matched_by`, time to convert; modal timeline
  (install → sessions → screens/events → payments). Friendly names ("brown fox").
- **Links**: create/edit tracked links; table of clicks → attributed installs → revenue per link.
- **Settings** per app: app key, install snippet + "Copy AI prompt", store URLs, bundle id/package, RevenueCat
  webhook URL + secret (shown once, stored hashed), timezone, retention months, sandbox toggle,
  delete user data (by `user_id` or install id), RevenueCat integration health (§5) with a warning below 50%.

Out of MVP: retention cohorts, funnels, live globe, CSV/Power BI exports, Search Ads campaign names,
multi-user / SaaS mode, other SDKs (bare RN, Swift, Kotlin, Flutter), CLI installer (`npx create-appdash`).

## 6a. Setup wizard

Shown after login whenever an instance has no apps, and per app until every step is `done` or `skipped`. Afterwards
it lives in Settings as a "Setup 4/6" checklist. Steps that can verify themselves do it by polling
`GET /api/apps/:id/setup` every 3 s while the step is open. State is stored in `apps.setup_state` (JSON).

| # | Step | User does | Done when (automatic unless marked manual) |
| --- | --- | --- | --- |
| 1 | App | Name, iOS bundle id, Android package, store URLs (optional) | App created |
| 2 | Install SDK | Copies snippet or "Copy AI prompt"; builds the app | First batch received → shows "✓ First install: <device>, <OS>" |
| 3 | RevenueCat webhook | Pastes URL + generated secret in RevenueCat, clicks "Send test event" | `TEST` (or any) event in `rc_events` → "✓ Webhook works" |
| 4 | RevenueCat sync | Adds `Appdash.syncRevenueCat(Purchases)` | First RC event with `appdash_install_id` → "✓ Install id reaches RevenueCat". Skippable: shows "waiting for first purchase". |
| 5 | Attribution | Optional first tracked link. Reads notes: Search Ads needs no setup; Install Referrer needs a dev build; deep link scheme | Manual "Continue" |
| 6 | Privacy | Timezone, retention months, reminder about `requireConsent` and the privacy-policy paragraph | Manual "Finish" |

Steps 3–4 can be skipped for apps without RevenueCat. Skipping is reversible from the checklist.

## 7. Privacy (UK GDPR, PECR)

The person deploying an instance is the controller for their app's users; appdash is the tool.

- **Consent**: `requireConsent` mode; `optOut()` stops collection and clears the local queue. README explains when
  consent is needed under PECR for on-device storage/access.
- **Minimisation**: no IP, IDFA/GAID or coordinates; city-level geo; private URL params stripped in the SDK;
  `props` ≤ 1 KB; `email`/`name` optional (`userId` alone is enough for matching).
- **Retention**: per-app `retention_months` (default 25) enforced by the cron.
- **Erasure**: delete-by-`user_id`/install-id removes the install, sessions, events, link-click links and
  nulls identity fields on payments (payment amounts stay for accounting).
- **Location/transfer**: README tells deployers to create D1 with an EU location hint/jurisdiction and points to
  Cloudflare's DPA; Workers execute globally.
- **Sensitive apps**: if the app handles sensitive personal data, sending emails/names via `identify()` needs a DPIA
  first; prefer an opaque `userId`.

## 8. Security (OWASP Top 10 2025)

| Risk | Control |
| --- | --- |
| A01 Broken access control | `app_key` only writes events; every dashboard route requires a session; all queries scoped by `app_id` |
| A02 Security misconfiguration | CSP, HSTS, `X-Content-Type-Options` via `_headers`; no stack traces in responses |
| A03 Software supply chain | Lockfile, minimal deps, SDK published with `npm publish --provenance` from CI |
| A04 Cryptographic failures | HMAC-signed session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`); RC secret stored as SHA-256 hash, constant-time compare |
| A05 Injection | Prepared statements only; shared schema validation; React escaping in dashboard |
| A07 Authentication failures | Password login with per-IP lockout (10 failures / 15 min), ported from Datadash. `ADMIN_PASSWORD` shorter than 12 characters → login refused with a "set a stronger password in Cloudflare → Settings → Variables" message |
| A08 Integrity failures | Webhook authenticated; event ids dedup replays |
| A09 Logging & alerting | Workers observability on; no PII in logs |
| A10 Mishandling exceptional conditions | Fail closed on missing `ADMIN_PASSWORD`/bindings; session key auto-generated in D1 (never a hard-coded fallback); ingestion errors return generic codes |

Known limitation: the public app key lets anyone send fake events (true of all client-side analytics). Mitigated by
rate limiting, size limits and the bundle-id check.

OWASP LLM Top 10 and ISO/IEC 42001 do not apply: the MVP has no AI component.

## 9. Error handling

- SDK never throws into the host app: all public methods catch internally and log only when `debug: true`.
- SDK storage failures fall back to an in-memory queue.
- Server returns 202 for accepted batches (even if some events were dropped as invalid/duplicate), 400 for
  malformed batches, 401 for unknown app key, 413 for oversized bodies, 429 for rate limits.
- RevenueCat webhook returns 200 for duplicates and ignored event types, 401 for bad auth, 500 only on DB failure
  (so RevenueCat retries).

## 10. Testing

- `packages/shared`: Vitest — source classification, attribution resolution (each of the 5 steps), payload
  validation, URL cleaning.
- `apps/server`: Vitest + `@cloudflare/vitest-pool-workers` with real D1 — batch ingest, dedup on retry,
  timestamp clamping, bundle-id check, link redirects per platform, RevenueCat webhook for each match path and
  refunds, credit logic, auth/lockout, erasure, retention cron.
- `packages/sdk-expo`: jest-expo with mocked `AppState`, AsyncStorage, `fetch`, `expo-linking` — queue
  persistence, flush triggers, backoff, session boundaries, consent mode, private-param stripping, `syncRevenueCat`
  (immediate install-id attribute, late attribution re-applied, missing methods tolerated).
- E2E: `scripts/smoke.mjs` against `wrangler dev` (batch → stats → webhook → customer journey);
  `examples/expo-demo` on iOS simulator and Android emulator.
- Manual checklist (documented): Install Referrer via Play internal testing track; AdServices token on a real
  iOS device.

## 11. Free plan budget

| Limit | Meaning |
| --- | --- |
| 100k Worker requests/day | Batching → many events per request; dashboard assets are free static files |
| 100k D1 rows written/day | ≈2 writes per event → ≈40–50k events/day |
| 5M D1 rows read/day | Dashboard loads at side-project scale |
| 5 GB D1 storage | Years of data at small scale; retention cron caps growth |
