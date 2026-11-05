# appdash MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an open-source, self-hosted (Cloudflare free plan) revenue-first analytics product for Expo apps: SDK → Worker + D1 → desktop dashboard, with install attribution and RevenueCat revenue.

**Architecture:** pnpm monorepo. `packages/shared` holds the wire contract and the pure attribution logic. Both
`apps/server` (Hono Worker + D1, which also serves the dashboard) and `packages/sdk-expo` import it. The SDK batches
events offline. The server ingests them in one `db.batch`, resolves install attribution, matches RevenueCat payments
and serves stats to `apps/dashboard` (React, ported from Datadash at `../datalog`).

**Tech Stack:** TypeScript (strict), pnpm workspaces, Node 20+, Hono 4, Wrangler 4, D1, Vitest +
`@cloudflare/vitest-pool-workers`, Expo Modules API (Swift/Kotlin), jest-expo, React 18 + Vite + Tailwind 3 + Recharts.

**Spec:** `docs/superpowers/specs/2026-11-05-appdash-design.md`. Read it before starting any task.

**Datadash source to port from:** `/Users/kamilnowicz/Projects/datalog`. "Port" means: copy the file, delete
web/SaaS-only parts, and rename `site` to `app`.

## Global Constraints

- License MIT. All UI copy and docs in English. No IP addresses, IDFA/GAID or coordinates are stored anywhere.
- Deployable unit is the **repo root**: root `wrangler.jsonc`, root `build`/`deploy` scripts, root `.dev.vars.example` with only `ADMIN_PASSWORD` (≥ 12 chars). Migrations run by binding name `DB`. The session key is auto-generated in D1 `meta`. No CLI installer in MVP.
- Ids from the SDK match `/^[\w-]{8,64}$/`. App keys: `app_` + `randomId(16)`. RevenueCat secrets: `rcw_` + `randomId(24)`, shown once, stored as `sha256Hex`.
- Batch limits: 1–50 events, body ≤ 64 KB, `props` JSON ≤ 1024 chars, `name` ≤ 255 chars (deep link URL ≤ 500).
- Event `ts` clamp: drop events outside `[now − 7 days, now + 60 s]`.
- SDK defaults: session timeout 5 min in background; flush every 15 s, on background, or at ≥ 20 queued events; ≤ 50 events per request; queue cap 1000 (drop oldest); backoff 2 s doubling to 5 min.
- Private URL params stripped by the SDK and the server (case-insensitive): `email, e-mail, name, phone, password, pass, token, access_token, id_token, auth, code, secret, key, api_key, license_key, license`.
- Channels: `Direct | Organic | Organic Search | Organic Social | AI | Referral | Email | Paid | Paid Search` (Datadash's set, plus `Organic` for store installs and `Paid Search` for Apple Search Ads).
- Money: integer USD cents from RevenueCat `price`; refunds negative. `SANDBOX` is stored but excluded unless the app's `show_sandbox = 1`.
- RevenueCat attribute key: **`appdash_install_id`** (RevenueCat reserves the `$` prefix for its own attributes).
- RevenueCat attribution attributes set by `syncRevenueCat`:
  - `$mediaSource` = source
  - `$campaign` = utm_campaign ?? asa_campaign_id
  - `$adGroup` = asa_adgroup_id
  - `$ad` = utm_content
  - `$keyword` = utm_term ?? asa_keyword_id
- RevenueCat lifecycle event names: the `rc_*` table in spec §5. Health warning below 50% of 24 h production events carrying `appdash_install_id`.
- Retention default 25 months. Login lockout: 10 failures per IP in 15 min. Cron `0 3 * * *`.
- Every dashboard API route requires the session cookie. Every query is scoped by `app_id`. Prepared statements only.
- Filters in stats are **install-level** (source, channel, campaign, asa_campaign_id, platform, country, app_version, os_version, device_model). Sessions, active users and revenue are counted for installs that pass the filter.

## Review Focus

1. **Events for a session that the server has not seen yet.** A `screen` can arrive before its `session_start` (separate flushes, offline). Any event upserts the session; it must never be dropped. Tested in Task 6 (`creates session from a non-start event`).
2. **A batch retried after the server already committed it** (client timeout). Counters must not double. Tested in Task 6 (`retried batch does not double counters`).
3. **A purchase webhook that arrives before the install's first batch** (buy on first launch while offline). The payment stays unmatched until the cron or "Try matching again" re-runs matching. Tested in Task 9 (`rematch links payment after late install`) and Task 12 (cron rematches the last 7 days).
4. **One `app_user_id` on several installs** (two devices, reinstall). Match the most recent install by `last_seen`. Tested in Task 9 (`user_id match picks most recent install`).
5. **Install Referrer with a `click_id` from another app or a deleted link.** Do not link it. Use only the referrer's own utm values; with none present, the install stays organic. Tested in Task 7 (`ignores click_id of another app`).

---

## Milestone 0: repository

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.nvmrc` (`20`), `LICENSE` (MIT, "appdash contributors"), `README.md` (one-paragraph stub), `.github/workflows/ci.yml`
- Create: `packages/shared/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}`, `packages/shared/test/smoke.test.ts`

**Interfaces:**
- Produces: workspace packages `@appdash/shared`, `@appdash/server`, `@appdash/dashboard`, `@appdash/expo`; root scripts `test`, `typecheck`, `build`.

- [ ] **Step 1:** `pnpm-workspace.yaml` lists `packages/*`, `apps/*`, `examples/*`. Root `package.json` is `"private": true`, with scripts `test: pnpm -r test`, `typecheck: pnpm -r typecheck`, `build: pnpm -r build`, and `packageManager` pinned to the installed pnpm version.
- [ ] **Step 2:** `tsconfig.base.json` uses the `compilerOptions` of `../datalog/tsconfig.json` without `types`/`jsx`, plus `"declaration": true`. `.gitignore`: `node_modules, dist, .wrangler, .dev.vars, *.log, .expo, ios/build, android/build`.
- [ ] **Step 3:** `packages/shared/test/smoke.test.ts` asserts `expect(VERSION).toBe('0.1.0')`, with `VERSION` exported from `src/index.ts`. Run `pnpm install && pnpm --filter @appdash/shared test`. Expected: PASS.
- [ ] **Step 4:** CI runs on push and PR with Node 20: `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`.
- [ ] **Step 5:** Commit: `chore: monorepo scaffold`.

---

## Milestone 1: shared contract and attribution logic (`packages/shared`)

### Task 2: Wire payload, validation and URL cleaning

**Files:**
- Create: `packages/shared/src/payload.ts`, `packages/shared/src/url.ts`
- Test: `packages/shared/test/payload.test.ts`, `packages/shared/test/url.test.ts`

**Interfaces:**
- Produces:
```ts
export const EVENT_TYPES = ['install','session_start','screen','event','deep_link','identify','source','ping'] as const;
export type EventType = (typeof EVENT_TYPES)[number];
export type Platform = 'ios' | 'android';
export interface SdkEvent { id: string; type: EventType; ts: number; sid: string; name?: string; props?: Record<string, unknown> }
//  install.props:  { referrer?: string; referrerClickTs?: number; installBeginTs?: number; asaToken?: string }
//  screen/event/source.name = screen / event name / reported answer; deep_link.name = cleaned URL
//  identify.props: { userId?: string; email?: string; name?: string };  ping.props: { ms: number }
export interface BatchContext { iid: string; platform: Platform; osVersion: string; appVersion: string; build: string;
  deviceModel: string; locale: string; timezone: string; sdkVersion: string; bundleId: string }
export interface Batch { context: BatchContext; events: SdkEvent[] }
export type ValidateResult = { ok: true; batch: Batch; dropped: number } | { ok: false; error: string };
export function validateBatch(input: unknown): ValidateResult;
export const LIMITS = { maxEvents: 50, maxBodyBytes: 65536, maxPropsChars: 1024, maxName: 255, maxUrl: 500 };

export interface Touch { utm_source?: string; utm_medium?: string; utm_campaign?: string; utm_term?: string;
  utm_content?: string; ref?: string; click_id?: string }
export const PRIVATE_PARAM: RegExp;
export function stripPrivateParams(url: string): string;      // returns input unchanged if unparsable
export function extractTouch(url: string): Touch | null;      // null when no utm_*, ref, via (→ ref) or click_id
export function touchFromQuery(query: string): Touch;          // parses "a=b&c=d" (already URL-decoded once)
```

- [ ] **Step 1: Failing tests.**
  - `payload.test.ts`:
    - `accepts a valid batch`: one `screen` event gives `ok: true, dropped: 0`.
    - `rejects bad context`: `platform: 'web'` gives `ok: false`.
    - `rejects 0 or 51 events`.
    - `drops invalid events but keeps the batch`: one unknown `type` plus one good event gives `ok: true`, 1 event, `dropped: 1`.
    - `drops oversized props`: `props` of 1025 JSON chars is dropped.
    - `truncates name to 255`.
    - `rejects bad ids`: `sid: 'x'` is dropped.
  - `url.test.ts`:
    - `strips private params`: `myapp://x?email=a@b.c&utm_source=x&Token=1` becomes `myapp://x?utm_source=x`.
    - `extractTouch reads utm, ref, via, click_id`.
    - `extractTouch returns null for plain urls`.
    - `touchFromQuery parses a Play referrer`: `utm_source=google-play&utm_medium=organic` gives `{utm_source:'google-play', utm_medium:'organic'}`.
- [ ] **Step 2:** Run `pnpm --filter @appdash/shared test`. Expected: FAIL, modules missing.
- [ ] **Step 3:** Implement `payload.ts` and `url.ts` with the signatures above. Hand-written validation, no schema library: the package stays dependency-free. Port the `PRIVATE_PARAM` regex from `../datalog/public/js/script.js:66`. Re-export from `src/index.ts`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(shared): batch contract, validation, url cleaning`.

### Task 3: Source classification, friendly names, install attribution

**Files:**
- Create: `packages/shared/src/sources.ts` (port of `../datalog/src/shared/sources.ts`), `packages/shared/src/names.ts` (port verbatim), `packages/shared/src/attribution.ts`
- Test: `packages/shared/test/sources.test.ts`, `packages/shared/test/attribution.test.ts`

**Interfaces:**
- Consumes: `Touch`, `touchFromQuery` (Task 2).
- Produces:
```ts
export type Channel = 'Direct'|'Organic'|'Organic Search'|'Organic Social'|'AI'|'Referral'|'Email'|'Paid'|'Paid Search';
export function classify(t: { utmSource?: string|null; utmMedium?: string|null; ref?: string|null }): { source: string; channel: Channel };
export function friendlyName(id: string): { name: string; emoji: string; color: string };  // as in Datadash

export type AttributionMethod = 'install_referrer'|'search_ads'|'deep_link'|'reported'|'organic';
export interface InstallAttribution { method: AttributionMethod; source: string; channel: Channel;
  utm_source: string|null; utm_medium: string|null; utm_campaign: string|null; utm_term: string|null; utm_content: string|null;
  ref: string|null; click_id: string|null; asa_campaign_id: number|null; asa_adgroup_id: number|null; asa_keyword_id: number|null }
export interface AdServicesResult { attribution: boolean; campaignId?: number; adGroupId?: number; keywordId?: number }
export interface LinkTouch extends Touch { click_id: string }    // link row's utm/ref + the click id

export function organic(platform: Platform): InstallAttribution;          // 'App Store' | 'Google Play', channel 'Organic'
export function fromInstallReferrer(raw: string, link: LinkTouch | null): InstallAttribution | null;
export function fromAdServices(r: AdServicesResult): InstallAttribution | null;
export function fromTouch(t: Touch, method: 'deep_link'): InstallAttribution;
export function fromReported(answer: string): InstallAttribution;
export const METHOD_PRIORITY: Record<AttributionMethod, number>; // install_referrer 1, search_ads 2, deep_link 3, reported 4, organic 5
export function mergeAttribution(current: InstallAttribution, candidate: InstallAttribution | null): InstallAttribution;
```

- [ ] **Step 1: Failing tests.**
  - `sources.test.ts`:
    - Port the `classify` cases from `../datalog/test/core.test.ts`, keeping those that use utm/ref only. Drop referrer-domain cases.
    - Add `defaults to Direct/None` for an empty touch.
  - `attribution.test.ts`:
    - `organic('ios')` gives `{source:'App Store', channel:'Organic', method:'organic'}`.
    - `fromInstallReferrer` uses link utm when a link is given: `('click_id=c1&utm_source=x', {click_id:'c1', utm_source:'tiktok', utm_campaign:'launch'})` gives method `install_referrer`, source `TikTok`, utm_campaign `launch`, click_id `c1`.
    - `fromInstallReferrer` uses the referrer's utm when there is no link: `'utm_source=google&utm_medium=cpc&utm_campaign=g1'` gives channel `Paid`, utm_campaign `g1`.
    - `fromInstallReferrer` returns null for organic Play: `'utm_source=google-play&utm_medium=organic'` and `''` both give `null`.
    - `fromAdServices`: `{attribution:true, campaignId:5, adGroupId:6, keywordId:7}` gives source `Apple Search Ads`, channel `Paid Search`, ids set. `{attribution:false}` gives `null`.
    - `mergeAttribution` keeps the higher priority: current `install_referrer` with candidate `deep_link` keeps current; current `organic` with candidate `reported` takes candidate; current `deep_link` with candidate `reported` keeps current; a `null` candidate keeps current.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. In `classify`, drop `referrerDomain` from the Datadash version. `fromInstallReferrer` parses `raw` with `touchFromQuery`, then overlays the link's utm/ref when `link` is given. Organic means `utm_medium=organic` with `utm_source=google-play`, or no utm/ref/click_id at all.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then `pnpm --filter @appdash/shared typecheck`.
- [ ] **Step 5:** Commit: `feat(shared): source classification and install attribution rules`.

---

## Milestone 2: server (`apps/server`)

### Task 4: Worker skeleton, schema, auth

**Files:**
- Create: `wrangler.jsonc` and `.dev.vars.example` **at the repo root** (spec §2 "Deployment": the Deploy to Cloudflare button needs the root to be the deployable unit)
- Create: `apps/server/{package.json,tsconfig.json,vitest.config.ts}`, `apps/server/migrations/0001_init.sql`
- Modify: root `package.json` (scripts `dev`, `predev`, `deploy`; `cloudflare.bindings.ADMIN_PASSWORD.description`)
- Create: `apps/server/src/{index.ts,env.ts,auth.ts}`, `apps/server/src/lib/{crypto.ts,time.ts,ua.ts}`
- Test: `apps/server/test/setup.ts`, `apps/server/test/auth.test.ts`, `apps/server/test/lib.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks except the workspace.
- Produces:
```ts
interface Env { DB: D1Database; ASSETS: Fetcher; ADMIN_PASSWORD: string; SESSION_SECRET?: string; INGEST_LIMITER?: RateLimit }
interface AppRow { id; name; app_key; ios_bundle_id; android_package; app_store_url; play_store_url; web_url; timezone;
  rc_secret_hash; retention_months: number; show_sandbox: number; setup_state: string | null; created_at: number }
export async function sessionKey(env: Env): Promise<string>;  // env.SESSION_SECRET, else meta 'session_key' (created once: 32 random bytes, base64)
export const MIN_PASSWORD_LENGTH = 12;
type AppEnv = { Bindings: Env; Variables: { app: AppRow } };
export function getAppByKey(db, key): Promise<AppRow|null>;  export function getAppById(db, id): Promise<AppRow|null>;
export function forgetApp(app: AppRow): void;              // 60 s isolate cache as in Datadash env.ts
export const requireAuth: MiddlewareHandler<AppEnv>;       // 401 JSON when no valid cookie
export function platformFromUA(ua: string): 'ios'|'android'|'other';
// lib/crypto.ts exports randomId, signToken, verifyToken, sha256Hex, safeEqual (now exported), passwordsMatch
// lib/time.ts: port resolveRange, bucketLabels, startOfDay, tzOffset unchanged
export default { fetch: app.fetch, scheduled } satisfies ExportedHandler<Env>;
```

- [ ] **Step 1: `0001_init.sql`.**
  - Contains exactly the tables and indexes from spec §5, plus:
    - `apps.show_sandbox INTEGER NOT NULL DEFAULT 0`
    - `events.session_id` nullable
    - `installs.last_seen` index `(app_id, last_seen)`
    - `payments` index `(app_id, install_id)`
  - Counters `NOT NULL DEFAULT 0`. All times are INTEGER ms UTC.
- [ ] **Step 2: root `wrangler.jsonc` and scripts.**
  - name `appdash`, `main: apps/server/src/index.ts`, `compatibility_date` = today, observability on.
  - Assets: `assets.directory: apps/dashboard/dist`, `not_found_handling: single-page-application`, `run_worker_first: ["/api/*", "/l/*"]`.
  - D1 binding `DB`, `database_name: appdash`, placeholder id `00000000-0000-0000-0000-000000000000` (the Deploy button replaces it), `migrations_dir: apps/server/migrations`.
  - Cron `0 3 * * *`.
  - Rate limit binding `INGEST_LIMITER`, limit 120 per 60 s. Check the current config key with the `wrangler` skill.
  - `.dev.vars.example` contains only `ADMIN_PASSWORD=change-me-please` (≥ 12 characters).
  - Root `package.json` → `cloudflare.bindings.ADMIN_PASSWORD.description`: "At least 12 characters. You'll use it to log in to the dashboard."
  - Root scripts:
    - `predev`: create `apps/dashboard/dist/index.html` when missing, so `wrangler dev` starts before Task 20 exists
    - `dev`: `wrangler dev --port 8787`
    - `deploy`: `wrangler d1 migrations apply DB --remote && wrangler deploy` (binding name, not database name)
    - `build`: `pnpm --filter @appdash/dashboard build` (a no-op until Task 20)
- [ ] **Step 3: Failing tests.** Configure `vitest.config.ts` with `@cloudflare/vitest-pool-workers`, `wrangler.configPath: '../../wrangler.jsonc'`. `test/setup.ts` applies migrations via `readD1Migrations` + `applyD1Migrations`; follow the current package docs. Bindings: `ADMIN_PASSWORD=test-password-12`, no `SESSION_SECRET`.
  - `auth.test.ts`:
    - `wrong password returns 401`.
    - `right password sets an HttpOnly cookie and /api/auth/me returns loggedIn true`.
    - `11th failure within 15 min returns 429`.
    - `protected route without cookie returns 401` (use `GET /api/apps`, stubbed to `[]` in this task).
    - `missing ADMIN_PASSWORD returns 500 with setup hint`.
    - `ADMIN_PASSWORD shorter than 12 refuses login with 500 and the "set a stronger password" hint`.
    - `sessionKey generates one key in meta and reuses it`: two calls give the same value and `meta` has one row.
    - `SESSION_SECRET binding takes precedence over meta`.
    - `cookie signed before a key exists still verifies after`: login, then a second request in a new isolate (cleared cache) is still logged in.
  - `lib.test.ts`:
    - Port the `time` cases from `../datalog/test/core.test.ts`.
    - `platformFromUA`: an iPhone UA gives `ios`, an Android UA gives `android`, curl gives `other`.
- [ ] **Step 4:** Run `pnpm --filter @appdash/server test`. Expected: FAIL.
- [ ] **Step 5: Implement.**
  - Port `crypto.ts`: drop `verifyStandardWebhook` and `verifyStripeSignature`, export `safeEqual`.
  - Port `time.ts`.
  - Port login, logout, `me` and the lockout from `../datalog/src/worker/index.ts:27-75` and `auth.ts`. Keep self-hosted mode only. Cookie `ad_auth`, 30 days.
  - `scheduled` is an empty stub here; Task 12 fills it.
- [ ] **Step 6:** Run the tests. Expected: PASS. Then `pnpm --filter @appdash/server typecheck`.
- [ ] **Step 7:** Commit: `feat(server): worker skeleton, schema, password auth`.

### Task 5: Apps API

**Files:**
- Create: `apps/server/src/apps.ts`
- Modify: `apps/server/src/index.ts` (mount routes)
- Test: `apps/server/test/apps.test.ts`

**Interfaces:**
- Consumes: `requireAuth`, `randomId`, `sha256Hex`, `forgetApp` (Task 4).
- Produces routes, all `requireAuth`:
  - `GET /api/apps` returns `AppRow[]` without `rc_secret_hash`, with `has_rc_secret: boolean`.
  - `POST /api/apps {name}` returns `AppRow` (new `app_key`).
  - `PATCH /api/apps/:id` with partial `{name, ios_bundle_id, android_package, app_store_url, play_store_url, web_url, timezone, retention_months, show_sandbox}` returns `AppRow`.
  - `POST /api/apps/:id/rc-secret` returns `{ secret }`, shown once; only the hash is stored.
  - `DELETE /api/apps/:id` deletes the app and all its rows in every table.
  - Test helper: `test/helpers.ts` exports `login(): Promise<string /*cookie*/>` and `createApp(cookie, patch?): Promise<AppRow>`.

- [ ] **Step 1: Failing tests.**
  - `creates app with app_ key`.
  - `patch validates urls and timezone`: `app_store_url: 'javascript:x'` gives 400; an invalid IANA zone gives 400; `retention_months` outside 1–120 gives 400.
  - `rc-secret is returned once and stored hashed`: the DB value equals `sha256Hex(secret)`, and `GET` never contains the secret.
  - `delete removes child rows`: seed one row per table, then expect zero.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Accept only `https:` URLs. Validate the timezone with `Intl.DateTimeFormat(undefined,{timeZone})` in a try/catch. Call `forgetApp` after every mutation.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): apps management API`.

### Task 6: Batch ingestion

**Files:**
- Create: `apps/server/src/ingest.ts`
- Modify: `apps/server/src/index.ts` (add `POST /api/v1/batch` with CORS `*`, methods `POST, OPTIONS`)
- Test: `apps/server/test/ingest.test.ts`

**Interfaces:**
- Consumes: `validateBatch`, `LIMITS`, `extractTouch`, `stripPrivateParams`, `classify`, `organic` (shared); `getAppByKey` (Task 4).
- Produces:
```ts
export async function handleBatch(c: Context<AppEnv>): Promise<Response>;
export async function ingestBatch(db: D1Database, app: AppRow, batch: Batch, geo: Geo, now: number,
  onInstall?: OnInstall /* default no-op */): Promise<{ inserted: number; dropped: number }>;
export interface Geo { country: string|null; region: string|null; city: string|null }
// hook for Task 7, called once per install event that was newly inserted:
export type OnInstall = (installId: string, ev: SdkEvent) => Promise<void>;
```

- [ ] **Step 1: Failing tests.** All tests send via `SELF.fetch` with header `X-App-Key`.
  - `401 for unknown key`.
  - `413 over 64 KB`.
  - `400 for malformed json`.
  - `429 when limiter says no`: inject a stub `INGEST_LIMITER` returning `{success:false}`.
  - `403 when bundleId mismatches app.ios_bundle_id`, and `200 when the app has no bundle ids set`.
  - `install event creates organic install with context and geo`.
  - `creates session from a non-start event`: a batch with only a `screen` creates the session (`screens = 1`, `entry_screen` set).
  - `retried batch does not double counters`: the same batch twice gives `events` rows = N and `sessions.screens = 1`.
  - `drops events outside ts clamp`: `ts = now − 8 days` is dropped and `dropped` counts it.
  - `ping adds foreground ms capped at 10 min`.
  - `identify fills user_id/email(lowercased)/name with COALESCE`.
  - `deep_link sets session source but not install source after first session`.
  - `deep_link in first session upgrades organic install to deep_link`.
  - `source event upgrades organic install to reported only`.
  - `exit_screen tracks the latest screen by ts`.
  - `returns 202`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement `ingestBatch`.** The algorithm the tests do not fully pin:
  1. Sort events by `ts`. Clamp, then drop out-of-range events.
  2. Read existing event ids: `SELECT id FROM events WHERE app_id=? AND id IN (…)`. Process only unseen ids; this is what makes retries safe.
  3. Install row: `INSERT … ON CONFLICT DO UPDATE SET last_seen, app_version, os_version, device_model, locale`. Attribution columns are initialised from `organic(platform)` only on insert.
  4. Per `sid`, upsert the session: `INSERT OR IGNORE`, then `UPDATE` counters from the unseen events. `started_at = MIN(ts)`, `last_seen_at = MAX(ts)`, `exit_screen` = the last screen by ts. Session `source/channel` comes from the first `deep_link` touch in it via `classify`, else `Direct`.
  5. Insert unseen events (`deep_link` name passed through `stripPrivateParams`).
  6. Run steps 3–5 in one `db.batch`.
  7. After the batch:
     - For each unseen `install` event, call `onInstall`. It is a no-op until Task 7.
     - For a `deep_link` or `source` event, compute the candidate and write `mergeAttribution(current, candidate)` when the method changes. A deep link counts only if its session is the install's earliest session.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): batch ingestion with dedup and sessions`.

### Task 7: Install Referrer and Apple Search Ads attribution, attribution lookup

**Files:**
- Create: `apps/server/src/adservices.ts`, `apps/server/src/attribution.ts`
- Modify: `apps/server/src/ingest.ts` (wire `onInstall`), `apps/server/src/index.ts` (`GET /api/v1/attribution`, same CORS and limiter as the batch route), `packages/shared/src/attribution.ts` (add `AttributionResponse`)
- Test: `apps/server/test/attribution.test.ts`

**Interfaces:**
- Consumes: `fromInstallReferrer`, `fromAdServices`, `mergeAttribution` (shared); `OnInstall` (Task 6).
- Produces:
```ts
export type AdServicesOutcome = { status: 'ok'; result: AdServicesResult } | { status: 'retry' } | { status: 'invalid' };
export async function exchangeAdServicesToken(token: string, fetchFn?: typeof fetch,
  sleep?: (ms: number) => Promise<void>): Promise<AdServicesOutcome>;
export async function applyAttribution(db: D1Database, appId: string, installId: string, candidate: InstallAttribution | null): Promise<void>;
export function makeOnInstall(db: D1Database, app: AppRow, waitUntil: (p: Promise<unknown>) => void, now: number): OnInstall;
// GET /api/v1/attribution?iid=<id>, header X-App-Key → 200 AttributionResponse | 401 | 404 (unknown install)
export interface AttributionResponse { resolved: boolean /* false while asa_pending_token is set */; method: AttributionMethod;
  source: string; channel: Channel; utm_campaign: string|null; utm_content: string|null; utm_term: string|null;
  asa_campaign_id: number|null; asa_adgroup_id: number|null; asa_keyword_id: number|null }
```
`AttributionResponse` lives in `packages/shared/src/attribution.ts` so the SDK (Task 18) imports the same type.
- Apple contract (verified 2026-11-05):
  - `POST https://api-adservices.apple.com/api/v1/` with `Content-Type: text/plain` and the raw token as body.
  - 200 returns JSON `{attribution, orgId, campaignId, adGroupId, keywordId?, adId?, claimType, conversionType, …}`.
  - 400 means the token is invalid. 404 means not ready yet: retry every 5 s, at most 3 attempts. 500 means retry later.
  - Token TTL is 24 h.

- [ ] **Step 1: Failing tests.**
  - `referrer with known click_id links install and click`: create a link via SQL, ingest an install with `props.referrer='click_id=<id>'`. Expect method `install_referrer`, the link's utm values, and `link_clicks.install_id` set.
  - `ignores click_id of another app`: a link row with a different `app_id` and a referrer with only `click_id` leaves the install organic.
  - `exchangeAdServicesToken retries 404 three times 5 s apart then returns retry`: fake fetch, fake sleep records `[5000,5000]`.
  - `400 gives invalid`.
  - `200 attribution true sets search_ads`: fake fetch through `makeOnInstall`.
  - `retry outcome stores asa_pending_token and asa_pending_until = install ts + 24h`.
  - `search_ads does not override install_referrer`.
  - `attribution endpoint returns resolved install_referrer attribution`.
  - `attribution endpoint returns resolved false while asa token pending`.
  - `attribution endpoint 404 for unknown iid and for an iid of another app`.
  - `attribution endpoint 401 for unknown key`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - `makeOnInstall` reads the Android referrer synchronously. For the iOS token it calls `waitUntil(exchange…)`.
  - `applyAttribution` reads the current columns, calls `mergeAttribution`, and updates only when the result differs.
  - Set the `click_id` → `link_clicks.install_id` link only when the click row belongs to the same app.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): install referrer and Apple Search Ads attribution`.

### Task 8: Tracked links

**Files:**
- Create: `apps/server/src/links.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/links.test.ts`

**Interfaces:**
- Consumes: `platformFromUA`, `getAppById`, `randomId`.
- Produces:
  - `GET /l/:slug` returns 302.
  - Auth routes:
    - `GET /api/apps/:id/links` returns `Link[]`.
    - `POST /api/apps/:id/links {name, slug?, utm_source, utm_medium?, utm_campaign?, utm_content?, ref?}` returns `Link`. Slug matches `/^[a-z0-9-]{2,48}$/`; when omitted it is `randomId(4)`; 409 on duplicate.
    - `PATCH /api/apps/:id/links/:linkId` and `DELETE` (keeps clicks).
  - Click id format: `c_` + `randomId(10)`.

- [ ] **Step 1: Failing tests.**
  - `android ua redirects to play_store_url with encoded referrer`: Location starts with the app's `play_store_url` and contains `referrer=` + `encodeURIComponent('click_id=c_…&utm_source=tiktok&utm_campaign=launch')`. Append with `&` or `?` depending on the existing query.
  - `ios ua redirects to app_store_url`.
  - `desktop ua redirects to web_url, falling back to app_store_url`.
  - `records click with platform and country`.
  - `unknown slug returns 404`.
  - `link of an app with no store urls returns 404 with plain text`.
  - `slug validation and duplicate 409`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Insert the click with `ctx.waitUntil` so the redirect is not delayed. Response headers: `Cache-Control: no-store` and `Referrer-Policy: no-referrer`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): tracked links with Play install referrer`.

### Task 9: RevenueCat webhook, matching, credit, lifecycle events, health

**Files:**
- Create: `apps/server/src/revenuecat.ts`, `apps/server/src/credit.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/revenuecat.test.ts`, `apps/server/test/fixtures/rc.ts` (event factory)

**Interfaces:**
- Consumes: `getAppById`, `sha256Hex`, `safeEqual`.
- Produces:
```ts
export async function handleRevenueCat(c: Context<AppEnv>): Promise<Response>;   // POST /api/webhooks/revenuecat/:appId
export async function matchInstall(db, appId: string, ev: RcEvent): Promise<{ installId: string|null; matchedBy: 'attribute'|'user_id'|'install_id'|'none' }>;
export async function creditedSessionId(db, appId: string, installId: string, ts: number): Promise<string|null>;
export async function rematch(db, appId: string, sinceTs: number): Promise<number /*newly matched*/>;
export function lifecycleEventName(ev: RcEvent): string | null;   // mapping table in spec §5 "Subscription lifecycle events"
export async function rcHealth(db, appId: string, now: number): Promise<RcHealth>;
export interface RcHealth { lastEventAt: number|null; events24h: number; withInstallId24h: number; matched24h: number; warning: boolean }
// routes (auth): POST /api/apps/:id/payments/rematch → { matched: number };  GET /api/apps/:id/revenuecat/health → RcHealth
```
- RevenueCat contract (verified 2026-11-05):
  - Body `{ api_version, event }`.
  - Event fields: `id, type, app_user_id, original_app_user_id, aliases[], subscriber_attributes{key:{value,updated_at_ms}}, product_id, store, environment ('SANDBOX'|'PRODUCTION'), price (USD; 0 trial; negative refund; may be null), period_type, is_trial_conversion, cancel_reason, event_timestamp_ms, purchased_at_ms`.
  - Respond 200 on success. Anything else is retried up to 5 times. Deliveries are at least once, so dedup on `id`.

- [ ] **Step 1: Failing tests.**
  - Auth and dedup:
    - `401 without or with wrong Authorization`. Accept the header equal to the secret or `Bearer <secret>`.
    - `TEST event returns 200, is logged in rc_events, stores no payment or event, and is excluded from rcHealth`.
    - `duplicate id returns 200 once stored`.
  - What gets stored:
    - `INITIAL_PURCHASE price 9.99 stores 999 cents payment`.
    - `RENEWAL sets renewal = 1`.
    - `CANCELLATION with cancel_reason CUSTOMER_SUPPORT and price -9.99 stores refund -999`.
    - `CANCELLATION UNSUBSCRIBE stores no payment but an rc_subscription_cancelled event with props.reason`.
    - `INITIAL_PURCHASE TRIAL price 0 stores rc_trial_started event, no payment`.
    - `price null stores amount 0 and logs nothing personal`.
  - Lifecycle events:
    - `lifecycleEventName covers every row of the spec mapping table`: one assertion per row, plus `TRANSFER` gives `null`.
    - `matched event is stored with id rc_<event id>, session_id null, props product_id/store/price_usd`.
    - `unmatched event writes rc_events only`.
    - `every delivery is logged once in rc_events, including ignored types`.
  - Health:
    - `rcHealth counts last 24h production events, share with appdash_install_id and share matched`.
    - `rcHealth warning is true below 50% with at least one event, false with zero events`.
  - Matching:
    - `matches by subscriber_attributes.appdash_install_id`, with `matched_by` `attribute`.
    - `matches by aliases equal to installs.user_id`.
    - `user_id match picks most recent install`: two installs with the same `user_id` match the one with the larger `last_seen`.
    - `matches app_user_id equal to install id`.
    - `unmatched stores install_id null, matched_by none`.
  - Credit:
    - `credit goes to latest non-direct session before payment, else null`.
  - Rematch:
    - `rematch links payment after late install`: webhook first, then batch with identify, then `POST …/payments/rematch` returns `{matched:1}`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
  - Order per delivery: auth, then `INSERT OR IGNORE` into `rc_events` (when no row changed, return 200: a duplicate), then match, then payment row, then lifecycle event.
  - Payment types: `INITIAL_PURCHASE`, `RENEWAL`, `NON_RENEWING_PURCHASE`, and `CANCELLATION` with `cancel_reason === 'CUSTOMER_SUPPORT'`. Other types produce only the lifecycle event, or nothing.
  - `has_install_attr = 1` when `subscriber_attributes.appdash_install_id.value` is a non-empty string.
  - `ts = purchased_at_ms ?? event_timestamp_ms`. `amount = Math.round(price * 100)`.
  - `rematch` also backfills lifecycle events for newly matched installs.
  - Return 500 only when the DB write throws.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): RevenueCat webhook with install matching and credit`.

### Task 10: Stats API: overview, chart, breakdowns

**Files:**
- Create: `apps/server/src/stats/filters.ts`, `apps/server/src/stats/overview.ts`, `apps/server/src/stats/breakdown.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/stats.test.ts`, `apps/server/test/fixtures/seed.ts` (deterministic dataset builder)

**Interfaces:**
- Consumes: `resolveRange`, `bucketLabels`, `tzOffset` (Task 4 `lib/time.ts`).
- Produces (all `requireAuth`, query `?range=7d|30d|…|custom&from&to&interval=hour|day|week|month&f.<dim>=<value>`):
  - `GET /api/apps/:id/stats/overview` returns:
    ```ts
    { current: Totals; previous: Totals; series: { label: string; installs: number; revenue: number }[] }
    // Totals = { installs, activeUsers, sessions, revenue /*cents*/, payingInstalls, conversionRate, revenuePerInstall, avgSessionMs }
    ```
  - `GET /api/apps/:id/stats/breakdown?dim=<Dim>` returns `{ value: string; installs: number; revenue: number }[]`, top 50.
  - `type Dim = 'channel'|'source'|'campaign'|'asa_campaign_id'|'platform'|'country'|'app_version'|'os_version'|'device_model'|'screen'|'event'`.
  - `export function installFilterSql(q: URLSearchParams): { where: string; binds: unknown[] }`. Whitelisted dims only, so no injection.

- [ ] **Step 1: Failing tests** against the seeded dataset: 3 installs (1 tiktok link android, 1 Search Ads ios, 1 organic), 5 sessions, 2 payments + 1 refund.
  - `overview totals`: installs 3, revenue = sum of payments minus refund, payingInstalls 2, conversionRate 2/3.
  - `previous period is the same length immediately before`.
  - `series buckets in app timezone`: an Europe/Warsaw app puts a 23:30 UTC install on the next day.
  - `breakdown source credits revenue to credited session source when set, else install source`.
  - `filter f.platform=ios limits all metrics`.
  - `unknown filter dim is ignored`.
  - `sandbox payments excluded unless show_sandbox`.
  - `screen breakdown counts screen events`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement with the SQL patterns of `../datalog/src/worker/stats.ts`, with `installs` replacing `visitors` and `screen` events replacing pageviews. Unmatched payments are counted in totals and shown as source `Unknown` in breakdowns.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): overview and breakdown stats`.

### Task 11: Stats API: customers, install timeline, link funnel

**Files:**
- Create: `apps/server/src/stats/customers.ts`, `apps/server/src/stats/links.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/stats-detail.test.ts`

**Interfaces:**
- Consumes: `installFilterSql`, seed fixture (Task 10).
- Produces (auth):
  - `GET /api/apps/:id/stats/customers` returns `{ installId, name /*friendlyName*/, email, total, payments, source, channel, matchedBy, firstSeen, firstPaymentAt, timeToConvertMs }[]`.
  - `GET /api/apps/:id/installs/:installId` returns `{ install: InstallRow; timeline: ({kind:'install'|'session'|'screen'|'event'|'deep_link'|'payment'; ts; label; detail?})[] }`, newest 500 items.
  - `GET /api/apps/:id/stats/links` returns `{ linkId, name, slug, clicks, androidClicks, iosClicks, installs, revenue }[]`.

- [ ] **Step 1: Failing tests.**
  - `customers lists paying installs sorted by total desc with matchedBy and time to convert`.
  - `timeline merges sessions, events and payments in ts order`.
  - `timeline of another app's install is 404`.
  - `link funnel counts clicks, attributed installs and their revenue`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): customers, install timeline, link stats`.

### Task 12: Privacy operations and cron

**Files:**
- Create: `apps/server/src/privacy.ts`, `apps/server/src/cron.ts`
- Modify: `apps/server/src/index.ts` (`scheduled` calls `runDaily`)
- Test: `apps/server/test/privacy.test.ts`

**Interfaces:**
- Consumes: `exchangeAdServicesToken`, `applyAttribution` (Task 7); `rematch` (Task 9).
- Produces:
  - `DELETE /api/apps/:id/users?user_id=…|install_id=…` (auth) returns `{ installs: number }`.
  - `export async function eraseUser(db, appId, by: {userId?: string; installId?: string}): Promise<number>`
  - `export async function runDaily(env: Env, now: number, fetchFn?: typeof fetch): Promise<void>`

- [ ] **Step 1: Failing tests.**
  - `erase by user_id removes installs, sessions, events, nulls link_clicks.install_id and payments install_id/app_user_id, keeps amounts`.
  - `erase requires exactly one of user_id/install_id`: 400.
  - `runDaily deletes data older than retention_months per app`.
  - `runDaily deletes installs with no session in retention window`.
  - `runDaily retries pending ASA tokens younger than 24h and clears expired ones`.
  - `runDaily rematches unmatched payments from the last 7 days`.
  - `runDaily deletes rc_events older than 30 days`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Batch deletes in chunks of 500 ids so the free-plan CPU limit holds.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(server): data erasure and daily retention cron`.

### Task 13: Hardening and smoke test

**Files:**
- Create: `apps/server/src/errors.ts`, `apps/dashboard/public/_headers`, `scripts/smoke.mjs`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/test/hardening.test.ts`

**Interfaces:**
- Produces: `app.onError` returns `{ error: 'Internal error' }` with status 500 and logs `{ route, message }` without bodies or headers. `scripts/smoke.mjs <host>` exits 0 or 1.

- [ ] **Step 1: Failing tests.**
  - `thrown error returns generic 500 without stack`.
  - `api responses carry X-Content-Type-Options nosniff`.
  - `missing ADMIN_PASSWORD makes login and protected routes 500 (fail closed), never a default password`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `_headers` for `/*` sets:
    - `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`
    - `Strict-Transport-Security: max-age=31536000`
    - `X-Content-Type-Options: nosniff`
    - `Referrer-Policy: strict-origin-when-cross-origin`
  - `smoke.mjs` does, against a running `wrangler dev`:
    1. Logs in and creates an app.
    2. Posts a batch with `install`, `session_start`, `screen`, `identify{userId:'u1'}`.
    3. Sets an RC secret and posts an `INITIAL_PURCHASE` with `app_user_id:'u1'`.
    4. Asserts overview revenue 999 and one customer with `matchedBy:'user_id'`.
- [ ] **Step 4:** Run `pnpm --filter @appdash/server test`. Expected: PASS. Then start `pnpm run dev` (root) in the background with `.dev.vars` copied from `.dev.vars.example`, and run `ADMIN_PASSWORD=change-me-please node scripts/smoke.mjs http://localhost:8787`. Expected: `smoke ok`.
- [ ] **Step 5:** Commit: `feat(server): error handling, security headers, smoke test`.

---

## Milestone 3: SDK (`packages/sdk-expo`)

### Task 14: Queue, storage, transport

**Files:**
- Create: the package via `npx create-expo-module@latest packages/sdk-expo --no-example`. Name `@appdash/expo`, native module name `AppdashAttribution`. Delete the template view component.
- Create: `packages/sdk-expo/src/{storage.ts,queue.ts,transport.ts,flusher.ts}`
- Test: `packages/sdk-expo/src/__tests__/{queue.test.ts,transport.test.ts,flusher.test.ts}` (jest-expo preset, AsyncStorage jest mock)

**Interfaces:**
- Consumes: `SdkEvent`, `Batch`, `BatchContext`, `LIMITS` (shared, workspace dependency `@appdash/shared`).
- Produces:
```ts
export interface KV { get(k: string): Promise<string|null>; set(k: string, v: string): Promise<void>; remove(k: string): Promise<void> }
export function createStore(): KV;   // AsyncStorage; falls back to in-memory Map if a call throws
export class Queue { constructor(kv: KV, cap = 1000); load(): Promise<void>; enqueue(e: SdkEvent): Promise<void>;
  peek(n: number): SdkEvent[]; ack(ids: string[]): Promise<void>; size(): number; clear(): Promise<void> }  // key 'appdash:queue'
export type SendResult = 'ok' | 'retry' | 'drop';
export class Transport { constructor(o: { host: string; appKey: string; fetchFn?: typeof fetch }); send(b: Batch): Promise<SendResult> }
export class Flusher { constructor(o: { queue: Queue; transport: Transport; context: () => BatchContext;
  intervalMs?: number /*15000*/; threshold?: number /*20*/; now?: () => number }); start(): void; stop(): void;
  notify(): void /*after enqueue*/; flush(): Promise<void>; backoffMs(): number }
```

- [ ] **Step 1: Failing tests.**
  - Queue:
    - `queue persists and reloads`.
    - `queue drops oldest over cap`.
    - `ack removes only given ids`.
  - Transport (fetch mock):
    - `posts to <host>/api/v1/batch with X-App-Key and JSON`.
    - 2xx gives `ok`; 429, 503 and a network error give `retry`; 400 and 401 give `drop`.
  - Flusher (jest fake timers):
    - `flushes every 15 s`.
    - `flushes immediately at threshold 20`.
    - `sends at most 50 per request and loops until empty`.
    - `backoff doubles from 2 s to max 5 min then resets on ok`.
    - `drop acks the batch`.
    - `concurrent flush calls do not double send`.
- [ ] **Step 2:** Run `pnpm --filter @appdash/expo test`. Expected: FAIL.
- [ ] **Step 3:** Implement. No public method may throw; catch and swallow (log only when `debug`, which Task 15 wires in).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(sdk): offline queue, transport, flusher`.

### Task 15: Client API, sessions, consent

**Files:**
- Create: `packages/sdk-expo/src/{session.ts,context.ts,client.ts,index.ts}`
- Test: `packages/sdk-expo/src/__tests__/{session.test.ts,client.test.ts}`

**Interfaces:**
- Consumes: Task 14 classes; `expo-application`, `expo-device`, `expo-localization`, `react-native` `AppState`/`Platform`.
- Produces the public API exactly as spec §3:
```ts
export interface AppdashOptions { appKey: string; host: string; requireConsent?: boolean; sessionTimeoutMs?: number; debug?: boolean }
export const Appdash: { init(o: AppdashOptions): void; track(name: string, props?: Record<string, unknown>): void;
  screen(name: string): void; identify(p: { userId?: string; email?: string; name?: string }): void;
  reportSource(answer: string): void; optIn(): void; optOut(): void; installId(): Promise<string|null>; flush(): Promise<void> };
export class SessionTracker { constructor(timeoutMs: number, newId: () => string);
  onActive(now: number): { sid: string; started: boolean }; onBackground(now: number): { sid: string; foregroundMs: number } | null; current(): string|null }
// storage keys: 'appdash:iid', 'appdash:consent' ('granted'|'denied'), 'appdash:installed' ('1')
// hook for Task 17: client calls `collectInstallProps(): Promise<Record<string, unknown>>` (returns {} until Task 17)
```

- [ ] **Step 1: Failing tests.**
  - Session:
    - `first active starts a session`.
    - `background then active within 5 min keeps sid`.
    - `after 5 min starts a new sid`.
    - `foregroundMs sums only active time`.
  - Client:
    - `init enqueues install once ever and session_start`.
    - `AppState background enqueues ping with ms and flushes`.
    - `track/screen/identify enqueue typed events with current sid`.
    - `requireConsent: nothing stored or sent before optIn; optIn creates iid and install`.
    - `optOut clears queue, stops flushing and persists denied`.
    - `methods before init are no-ops and never throw`.
    - `installId returns persisted id`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Use `expo-crypto` `randomUUID()` for ids. Build the context from `Application.nativeApplicationVersion`, `nativeBuildVersion`, `applicationId`, `Device.modelName`, `Platform.Version`, `Localization.getLocales()[0].languageTag` and `getCalendars()[0].timeZone`. Set `sdkVersion` from `package.json`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(sdk): public API, sessions, consent`.

### Task 16: Deep links and automatic screens

**Files:**
- Create: `packages/sdk-expo/src/deeplink.ts`, `packages/sdk-expo/src/provider.tsx`
- Test: `packages/sdk-expo/src/__tests__/{deeplink.test.ts,provider.test.tsx}`

**Interfaces:**
- Consumes: `extractTouch`, `stripPrivateParams` (shared); `Appdash` internals (Task 15).
- Produces: `export function startDeepLinks(onLink: (url: string) => void): () => void` (uses `Linking.getInitialURL` + `Linking.addEventListener('url')`). `export function AppdashProvider(p: { children: ReactNode }): JSX.Element`. It calls `Appdash.screen(pathname)` when the `expo-router` `usePathname` value changes; it renders children unchanged when `expo-router` is not installed (guarded `require` in try/catch).

- [ ] **Step 1: Failing tests.**
  - `initial url with utm enqueues deep_link with cleaned url`.
  - `url without touch params is ignored`.
  - `private params never reach the queue`.
  - `provider tracks pathname changes once per change`.
  - `provider without expo-router renders children`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(sdk): deep link capture and expo-router screens`.

### Task 17: Native attribution module

**Files:**
- Modify: `packages/sdk-expo/ios/AppdashAttributionModule.swift`, `packages/sdk-expo/ios/AppdashAttribution.podspec` (`s.weak_frameworks = 'AdServices'`)
- Modify: `packages/sdk-expo/android/src/main/java/.../AppdashAttributionModule.kt`, `packages/sdk-expo/android/build.gradle` (`implementation "com.android.installreferrer:installreferrer:2.2"`)
- Create: `packages/sdk-expo/src/native.ts`
- Test: `packages/sdk-expo/src/__tests__/native.test.ts`

The module's own Gradle and podspec files carry the dependencies, so the spec's config plugin is not needed (YAGNI).

**Interfaces:**
- Produces:
  - Native async functions:
    - `getAdServicesToken(): String?` (iOS 14.3+, `AAAttribution.attributionToken()`, nil on throw).
    - `getInstallReferrer(): {referrer: String, clickTs: Double, installTs: Double}?` (Android; `InstallReferrerClient`, `endConnection()` after the read, null on any non-OK response code).
  - `native.ts`: `export async function collectInstallProps(): Promise<Record<string, unknown>>`. Returns `{asaToken}` on iOS and `{referrer, referrerClickTs, installBeginTs}` (ms) on Android. Returns `{}` when `requireOptionalNativeModule('AppdashAttribution')` is null (Expo Go). Replaces the Task 15 stub.

- [ ] **Step 1: Failing tests.**
  - `returns {} when native module missing`.
  - `maps android referrer seconds to ms`.
  - `returns asaToken on ios`.
  - `swallows native errors`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement `native.ts`, the Swift module and the Kotlin module.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then `cd packages/sdk-expo && npx expo-module build` (or the template's `build` script). Expected: no TS errors.
- [ ] **Step 5:** Commit: `feat(sdk): native AdServices and Install Referrer module`.

### Task 18: RevenueCat sync

**Files:**
- Create: `packages/sdk-expo/src/attribution.ts`, `packages/sdk-expo/src/revenuecat.ts`
- Modify: `packages/sdk-expo/src/client.ts` (expose `syncRevenueCat`), `packages/sdk-expo/src/index.ts`
- Test: `packages/sdk-expo/src/__tests__/{attribution.test.ts,revenuecat.test.ts}`

**Interfaces:**
- Consumes: `AttributionResponse` (shared, Task 7); `Transport` options `host`/`appKey` (Task 14); consent state and `installId()` (Task 15).
- Produces:
```ts
export class AttributionCache { constructor(kv: KV, o: { host: string; appKey: string; fetchFn?: typeof fetch });
  get(iid: string, waitMs: number): Promise<AttributionResponse | null>;   // cache key 'appdash:attribution', stored once resolved
  onResolved(cb: (a: AttributionResponse) => void): () => void }         // fires when a pending lookup resolves later
export interface RevenueCatLike { setAttributes(a: Record<string, string | null>): unknown;
  setMediaSource?(v: string | null): unknown; setCampaign?(v: string | null): unknown; setAdGroup?(v: string | null): unknown;
  setAd?(v: string | null): unknown; setKeyword?(v: string | null): unknown; syncAttributesAndOfferingsIfNeeded?(): Promise<unknown> }
export function rcAttributes(a: AttributionResponse): { mediaSource: string; campaign: string|null; adGroup: string|null; ad: string|null; keyword: string|null };
// Appdash.syncRevenueCat(purchases: RevenueCatLike, o?: { waitMs?: number /*3000*/ }): Promise<void>
```

- [ ] **Step 1: Failing tests.**
  - `attribution.test.ts`:
    - `returns cached resolved attribution without fetching`.
    - `fetches GET <host>/api/v1/attribution?iid= with X-App-Key and caches when resolved`.
    - `polls every 1 s until resolved or waitMs, then returns null`, with fake timers.
    - `keeps polling in background after waitMs (every 5 s, max 2 min) and fires onResolved once`.
    - `404 or network error returns null without throwing`.
  - `revenuecat.test.ts`:
    - `rcAttributes maps a link install`: `{source:'TikTok', utm_campaign:'launch', utm_content:'v2'}` gives `{mediaSource:'TikTok', campaign:'launch', ad:'v2'}`.
    - `rcAttributes maps Search Ads`: campaign, adGroup and keyword come from the asa ids as strings.
    - `syncRevenueCat sets appdash_install_id before attribution resolves`.
    - `syncRevenueCat sets only non-null attributes and calls syncAttributesAndOfferingsIfNeeded`.
    - `syncRevenueCat tolerates missing optional methods`: an object with only `setAttributes` works.
    - `late resolution re-applies attributes once`.
    - `no-op before consent and before init`.
    - `never throws when purchases methods throw`.
- [ ] **Step 2:** Run `pnpm --filter @appdash/expo test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Before writing anything, check the method names against the current `react-native-purchases` type definitions and fix `RevenueCatLike` if they differ.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(sdk): RevenueCat attribute sync`.

### Task 19: Example app and manual checklist

**Files:**
- Create: `examples/expo-demo/` (`npx create-expo-app@latest` with expo-router), `docs/manual-testing.md`

**Interfaces:**
- Consumes: `@appdash/expo` (workspace).

- [ ] **Step 1:** The demo has two tabs (Home, Paywall). Paywall calls `Appdash.track('paywall_shown')` and has a "Fake purchase" button that logs `Appdash.installId()`. Host and key come from `app.config.ts` `extra` via `EXPO_PUBLIC_APPDASH_HOST/KEY`.
- [ ] **Step 2:** Run `npx expo prebuild` and `npx expo run:ios` against `wrangler dev`. Confirm in the dashboard API (`/api/apps/:id/stats/overview`) that installs = 1, plus the session and screens. Repeat with `npx expo run:android`; the emulator reaches the host machine at `10.0.2.2:8787`.
- [ ] **Step 3:** In `docs/manual-testing.md`, write checklists with expected results for:
  - Play internal testing track with a `/l/<slug>` link (install shows method `install_referrer` and the link's campaign).
  - A real iOS device build (AdServices token present; Apple returns a test payload in developer mode).
  - Expo Go (no crash, attribution organic).
  - Airplane mode (events arrive after reconnect, no duplicates).
  - RevenueCat sandbox purchase with `syncRevenueCat`: the RevenueCat customer shows `appdash_install_id` and `$mediaSource`; the webhook event is matched with `attribute`; health shows 100% with install id.
- [ ] **Step 4:** Commit: `docs: example app and manual test checklist`.

---

## Milestone 4: dashboard (`apps/dashboard`)

Dashboard tasks test pure helpers with Vitest. Screens are verified in the browser preview against `wrangler dev` with seeded data. Add `apps/server/scripts/seed-demo.mjs`, ported from `../datalog/scripts/seed-demo.mjs`: 30 days, about 300 installs, mixed sources, about 20 payments.

### Task 20: Dashboard shell, login, apps

**Files:**
- Create: `apps/dashboard/{package.json,vite.config.ts,tailwind.config.js,postcss.config.js,index.html}`, `src/{main.tsx,App.tsx,styles.css}`, `src/lib/{api.ts,format.ts,query.ts}`
- Port: `src/components/{Panel,OverviewCard,Toolbar,Modal,Icons,Logo}.tsx` from `../datalog/src/dashboard/components`
- Create: `src/pages/{Login,Apps}.tsx`, `apps/server/scripts/seed-demo.mjs`
- Test: `apps/dashboard/test/{format.test.ts,query.test.ts}`

**Interfaces:**
- Consumes: server routes from Tasks 4, 5, 10.
- Produces:
  - `api.ts`: `api<T>(path: string, init?: RequestInit): Promise<T>`. Throws `ApiError{status}` and redirects to `/login` on 401.
  - `query.ts`: `toSearch(state: { range: string; from?: number; to?: number; interval?: string; filters: Record<string,string> }): string` and `fromSearch(s: string)`.
  - `format.ts`: `money(cents: number): string` (USD), `duration(ms)`, `pct(change: number|null)`.
  - Routes: `/login`, `/`, `/setup`, `/apps/:id`, `/apps/:id/customers`, `/apps/:id/links`, `/apps/:id/settings`, `/apps/:id/setup` (the last three are filled by Tasks 24–25).

- [ ] **Step 1: Failing tests.**
  - `money(999) is "$9.99"`.
  - `money(-999) is "-$9.99"`.
  - `duration(65000) is "1m 5s"`.
  - `pct(null) is "–"`.
  - `toSearch/fromSearch round-trip including f.<dim> filters`.
- [ ] **Step 2:** Run `pnpm --filter @appdash/dashboard test`. Expected: FAIL.
- [ ] **Step 3:** Implement the helpers and pages. `vite.config.ts` proxies `/api` and `/l` to `http://localhost:8787` and builds to `dist`. Apps page: list plus create form.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then `pnpm --filter @appdash/dashboard build`. Expected: `dist/index.html` exists.
- [ ] **Step 5:** With `wrangler dev` and the seed running, open the preview, log in, and create an app. Expected: the new app appears in the list.
- [ ] **Step 6:** Commit: `feat(dashboard): shell, login, apps list`.

### Task 21: Overview page

**Files:**
- Create: `apps/dashboard/src/pages/Overview.tsx`, `src/components/{Chart.tsx,FilterBar.tsx}`
- Test: `apps/dashboard/test/filters.test.ts`

**Interfaces:**
- Consumes: `/stats/overview`, `/stats/breakdown` (Task 10); `toSearch` (Task 20).
- Produces:
  - Overview with the 7 cards from spec §6 and the installs-line + revenue-bars chart. Ranges and ‹ › stepping use Datadash's `Toolbar`.
  - Panel groups: [Channel | Source | Campaign | Search Ads], [Platform | Country | App version | OS | Device], [Screens | Events].
  - Clicking a row adds `f.<dim>`; FilterBar chips remove it.
  - `export function toggleFilter(f: Record<string,string>, dim: string, value: string): Record<string,string>`.

- [ ] **Step 1: Failing test.** `toggleFilter adds, replaces and removes`.
- [ ] **Step 2:** Run the test. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then check the seeded app in the preview:
  - The cards show non-zero values with % changes.
  - Clicking `TikTok` in Source filters every card.
  - Zero console errors, checked with `read_console_messages`.
- [ ] **Step 5:** Commit: `feat(dashboard): overview with chart, panels, filters`.

### Task 22: Customers and install timeline

**Files:**
- Create: `apps/dashboard/src/pages/Customers.tsx`, `src/components/InstallModal.tsx` (adapted from `VisitorModal.tsx`)

**Interfaces:**
- Consumes: `/stats/customers`, `/installs/:installId`, `/payments/rematch` (Tasks 9, 11); `friendlyName` (shared).

- [ ] **Step 1:** Implement the table columns: name + emoji, email, total, payments, source, matched by, time to convert. Clicking a row opens `InstallModal` with the timeline. Add a "Try matching again" button that shows `{matched}`.
- [ ] **Step 2:** Verify in the preview on seeded data:
  - The rows are sorted by total.
  - The modal shows install → sessions → payment in order.
  - Zero console errors.
- [ ] **Step 3:** Commit: `feat(dashboard): customers journey and install timeline`.

### Task 23: Links page

**Files:**
- Create: `apps/dashboard/src/pages/Links.tsx`
- Test: `apps/dashboard/test/links.test.ts`

**Interfaces:**
- Consumes: links CRUD (Task 8), `/stats/links` (Task 11).
- Produces: `export function linkUrl(origin: string, slug: string): string` returning `${origin}/l/${slug}`, and `export function slugify(name: string): string` (lowercase, `[a-z0-9-]`, max 48).

- [ ] **Step 1: Failing tests.**
  - `slugify("Launch Tweet #1!") is "launch-tweet-1"`.
  - `linkUrl` builds the URL.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement the create form (name, auto slug, utm fields, ref) and a table with clicks (Android/iOS), installs and revenue, plus copy-link buttons. Add the note: "iOS installs from links are attributed only when the app is opened through the link (deep link) or via Apple Search Ads."
- [ ] **Step 4:** Run the tests. Expected: PASS. Then create a link in the preview and open `/l/<slug>` with a mobile user agent. Expected: 302 to the store.
- [ ] **Step 5:** Commit: `feat(dashboard): tracked links page`.

### Task 24: Settings page

**Files:**
- Create: `apps/dashboard/src/pages/Settings.tsx`, `src/lib/snippets.ts`
- Test: `apps/dashboard/test/snippets.test.ts`

**Interfaces:**
- Consumes: apps PATCH, rc-secret, erase, RevenueCat health (Tasks 5, 9, 12).
- Produces:
  - `export function installSnippet(host: string, appKey: string): string`: the `pnpm add @appdash/expo` / `npx expo install @appdash/expo` line, plus `Appdash.init`, `<AppdashProvider>`, and the RevenueCat line `await Appdash.syncRevenueCat(Purchases)` placed after `Purchases.configure` and before the first paywall.
  - `export function aiPrompt(host: string, appKey: string): string`: instructions for an AI coding assistant to install the SDK in an Expo project, ending with "Do not send email or name in identify() unless the app's privacy policy covers it."

- [ ] **Step 1: Failing tests.**
  - `snippet contains host, key and syncRevenueCat after Purchases.configure`.
  - `healthLabel`: `{lastEventAt:null}` gives "No events yet"; 40% gives a warning containing "40%".
  - `aiPrompt contains the privacy sentence`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3: Implement the sections.**
  - Install (snippet + Copy AI prompt).
  - Stores (bundle id, package, URLs).
  - RevenueCat:
    - Webhook URL `${origin}/api/webhooks/revenuecat/${id}` and a "Generate secret" button that shows the secret once with "Paste this as the Authorization header value in RevenueCat".
    - Health from `GET …/revenuecat/health`, rendered with `healthLabel(h: RcHealth): { text: string; warning: boolean }` (exported from `snippets.ts`). Example: "Last event 5 min ago · 92% carry appdash_install_id · 88% matched". Below 50% the warning reads "Call Appdash.syncRevenueCat(Purchases) on every app start".
  - Data: timezone, retention months, sandbox toggle.
  - Delete user data: input + confirm modal.
  - Danger zone: delete app.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then generate a secret in the preview. Expected: shown once; after reload only "Secret set" is visible.
- [ ] **Step 5:** Commit: `feat(dashboard): settings with install snippet, RevenueCat, privacy controls`.

### Task 25: Setup wizard

**Files:**
- Create: `apps/server/src/setup.ts`, `apps/dashboard/src/pages/Setup.tsx`, `apps/dashboard/src/lib/setup.ts`
- Modify: `apps/server/src/index.ts`; `apps/dashboard/src/App.tsx` (redirect after login); `apps/dashboard/src/pages/Settings.tsx` (checklist)
- Test: `apps/server/test/setup.test.ts`, `apps/dashboard/test/setup.test.ts`

**Interfaces:**
- Consumes:
  - `rc_events` and `RcHealth` (Task 9)
  - links API (Task 8)
  - `installSnippet`, `aiPrompt` (Task 24)
  - apps API (Task 5)
- Produces:
```ts
export type SetupStep = 'app'|'firstEvent'|'revenuecatWebhook'|'revenuecatSync'|'attribution'|'privacy';
export const SETUP_STEPS: SetupStep[];   // in this order
export interface StepStatus { done: boolean; skipped?: boolean; at?: number; detail?: string }
export interface SetupStatus { steps: Record<SetupStep, StepStatus>; current: SetupStep | null /* null = complete */ }
export async function setupStatus(db: D1Database, app: AppRow): Promise<SetupStatus>;  // server/src/setup.ts
// GET /api/apps/:id/setup → SetupStatus;  PATCH /api/apps/:id/setup {step, state:'done'|'skipped'|'reset'} → SetupStatus
// dashboard/src/lib/setup.ts:
export function nextStep(s: SetupStatus): SetupStep | null;
export function progressLabel(s: SetupStatus): string;   // "Setup 4/6"
```
- Detection rules (spec §6a):
  - `app` is done when the app exists.
  - `firstEvent`: earliest install. `detail` = `"<device_model>, <platform> <os_version>"`.
  - `revenuecatWebhook`: earliest `rc_events` row of any type, `TEST` included.
  - `revenuecatSync`: earliest `rc_events` row with `has_install_attr = 1`.
  - `attribution` and `privacy` are done only through PATCH.
  - A skip in `setup_state` beats detection. `reset` clears the stored state.

- [ ] **Step 1: Failing tests.**
  - `setup.test.ts` (server):
    - `new app: only app done, current firstEvent`.
    - `first batch marks firstEvent with device detail`.
    - `RevenueCat TEST event marks revenuecatWebhook`.
    - `event with appdash_install_id marks revenuecatSync`.
    - `skip revenuecat steps then current is attribution`.
    - `PATCH privacy done completes setup: current null`.
    - `PATCH unknown step is 400`.
    - `setup of another app's id is 404`.
  - `setup.test.ts` (dashboard):
    - `progressLabel counts done and skipped`.
    - `nextStep returns the first step neither done nor skipped`.
- [ ] **Step 2:** Run `pnpm --filter @appdash/server test` and `pnpm --filter @appdash/dashboard test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Server: `setup.ts` plus routes. Use 4 cheap `MIN(...)` queries and no new tables.
  - Wizard UI: one screen per step with Back/Skip/Continue.
  - Automatic steps poll `GET …/setup` every 3 s while visible, show a spinner with "Waiting for …", and switch to a green ✓ with `detail`.
  - Step contents, copy from spec §6a:
    - 2 (`firstEvent`) embeds `installSnippet` and `aiPrompt`.
    - 3 (`revenuecatWebhook`) has the webhook URL and the "Generate secret" button.
    - 5 (`attribution`) has an inline "create first link" form.
    - 6 (`privacy`) has timezone, retention and the `requireConsent` reminder.
  - Navigation:
    - After login with zero apps, redirect to `/setup`, starting at step 1.
    - With an incomplete app, show a banner "Finish setup (4/6)" linking to `/apps/:id/setup`.
    - Settings shows the checklist with a "Reset" action per step.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then, in the preview against `pnpm run dev` with an empty local DB:
  1. Log in. Expected: lands on `/setup` step 1.
  2. Create an app.
  3. Run `scripts/smoke.mjs`, which sends a batch and an RC event with the attribute. Expected: steps 2–4 turn ✓ within 3 s each.
  4. Finish steps 5–6. Expected: the banner disappears.
  5. Zero console errors.
- [ ] **Step 5:** Commit: `feat: first-run setup wizard`.

---

## Milestone 5: ship

### Task 26: README, deploy flow, release

**Files:**
- Modify: `README.md`, `package.json` (root scripts)
- Create: `.github/workflows/release-sdk.yml`, `packages/sdk-expo/README.md`

**Interfaces:**
- Produces:
  - Root scripts `seed` (`node apps/server/scripts/seed-demo.mjs` + `wrangler d1 execute DB --local --file …`) and `smoke`.
  - `build`, `deploy`, `dev` already exist from Task 4.
  - Always invoke them with `pnpm run …`: `pnpm deploy` is a built-in pnpm command.
  - A "Deploy to Cloudflare" button at the top of the README: `https://deploy.workers.cloudflare.com/?url=<public repo URL>`.

- [ ] **Step 1: README sections.**
  - "What it tracks".
  - "Deploy in 5 minutes": the button, then:
    1. Choose names.
    2. Enter `ADMIN_PASSWORD`.
    3. Wait for the build.
    4. Open the `*.workers.dev` URL.
    5. Follow the setup wizard.
    
    Add a screenshot of each Cloudflare screen.
  - "Updating": GitHub "Sync fork", which triggers Workers Builds.
  - "Manual deploy (no GitHub)": Datadash-style steps with `npx wrangler d1 create appdash --location weur`, a note on `--jurisdiction eu`, then `wrangler secret put ADMIN_PASSWORD` and `pnpm run deploy`. Check the flags with the `wrangler` skill.
  - "Data location". If the Deploy button cannot pin D1 to the EU, say so plainly, and tell EU/UK deployers to use the manual path or to create the D1 in the EU first and paste its id into the fork's `wrangler.jsonc`.
  - "Add the SDK", "Tracked links", "RevenueCat" (webhook setup, `syncRevenueCat` placement, what appears in RevenueCat Charts/Targeting, the lifecycle event list, the health check, and a note to confirm the RevenueCat plan includes webhooks), "Apple Search Ads", "Privacy" (controller role, consent mode, retention, erasure, Cloudflare DPA, sample privacy-policy paragraph), "Free plan limits" (spec §11 table), "Accuracy notes" (iOS link installs, Expo Go, reinstall = new install), "Local development".
- [ ] **Step 2:** `release-sdk.yml`: on tag `sdk-v*`, run `pnpm --filter @appdash/shared --filter @appdash/expo publish --provenance --access public` with `id-token: write`.
- [ ] **Step 3:** Run `pnpm typecheck && pnpm test`. Expected: all PASS. Push the repo to a public GitHub repo and click the Deploy button with a fresh Cloudflare account. Expected:
  - D1 is created automatically and migrations apply during the build.
  - Logging in with the entered password lands on the setup wizard.
  - `ADMIN_PASSWORD=… node scripts/smoke.mjs https://appdash.<you>.workers.dev` passes.

  Then run the manual path once (`pnpm run deploy`) on a second account. Expected: the same result.
- [ ] **Step 4:** Commit: `docs: README, deploy flow, SDK release workflow`.
