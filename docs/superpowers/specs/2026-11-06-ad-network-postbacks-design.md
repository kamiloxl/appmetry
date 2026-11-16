# Ad-network postbacks (Meta Conversions API) and ad links

Date: 2026-11-06. Status: implemented on the `feat/integrations-pr1…pr7` branches. Part 2 of the Meta integration; part 1
is `2026-11-05-ios-probabilistic-attribution-design.md` (not implemented yet).

## 1. Goal

Paid campaigns learn from in-app conversions. The operator connects an ad network per app, maps appmetry events to the
network's events, and the server sends them server-to-server. Ad links carry campaign parameters and an in-app URL, so
installs and revenue land on the right campaign, ad set and ad, and a new install can open a matching first screen.

### 1.1 Decisions

| Topic | Decision |
|---|---|
| Networks | Meta first. A generic adapter interface (`apps/server/src/integrations/types.ts`); one file per network. |
| Connection | Facebook Login (optional, `META_APP_ID` / `META_APP_SECRET`) only lists datasets. The Conversions API token is pasted and stored encrypted. Manual dataset ID when no Meta app is configured. |
| Consent | Nothing is sent unless the install reported `adConsent: true` (SDK `setAdConsent`, default false). |
| iOS without ATT | Sent with `advertiser_tracking_enabled = 0`, without IDFA, IP or user agent; `campaign_ids` keeps Meta AEM working. This replaces part 1's "ATT authorized only". |
| Default scope | `all` events (Meta does its own attribution, including view-through); `attributed` is an option. |
| Delivery | D1 outbox, immediate send in `waitUntil`, retries from a 5-minute cron. No Queues binding, so the Deploy button needs nothing extra. |

## 2. Data flow

```
SDK batch ─┐                         ┌─ install (also when consent arrives later), custom events
RC webhook ┼─► enqueuePostbacks ─────┤  rc_* lifecycle events (value in USD)
rematch ───┘   (mapping, consent,    └─ rematched lifecycle events (cron sends them)
               scope, sandbox, ≤7 d)
                     │ INSERT OR IGNORE postback_outbox (unique: integration, source event, target event)
                     ▼
               dispatch (lease-claimed rows) ─► adapter.buildRequest ─► graph.facebook.com/v27.0/{dataset}/events
                     │ sent | retry (1m, 5m, 30m, 2h, 12h; failed after 8) | fatal (token errors flag the integration)
               cron */5: dispatchDue (50 rows), expire > 7 days, purge finished rows after 30 days
```

SDK event names `install` and `rc_*` are reserved: an app cannot `track('rc_trial_converted')` to fake a Purchase.

## 3. Meta payload (`apps/server/src/integrations/meta.ts`)

Checked against Meta's Conversions API for App Events docs on 2026-11-06.

- `action_source: "app"`, `event_id` = stable source id (`install_<iid>`, SDK event id, `rc_<id>`), `event_time` in seconds.
- `app_data`: `advertiser_tracking_enabled` (iOS: ATT authorized; Android: GAID available), `application_tracking_enabled: 1`,
  `extinfo` (16 strings, `i2`/`a2`, bundle id, version, OS, model, locale, screen), `campaign_ids` when known.
- `user_data`: `anon_id` = install id; `madid`, `client_ip_address`, `client_user_agent` only with tracking allowed;
  `external_id` = SHA-256(user id); `em` = SHA-256(normalised email) only with the integration's `share_hashed_email` (off by default).
- `custom_data`: `value` and `currency` when the mapping sends value and the amount is positive.
- Default mappings: `install → MobileAppInstall` (locked), trial start → `StartTrial`, subscription start → `Subscribe`,
  trial conversion and in-app purchase → `Purchase` with value.
- Not confirmed in Meta's docs (check with the first test event): the error body format (handled as Graph `error.code`),
  `StartTrial` / `Subscribe` as app events.

## 4. Ad links and deep links

- Links get an optional `deep_link_url` (`scheme://…`) and `integration_id`. The dashboard shows, per Meta ad link, the
  website URL (`/l/<slug>`), one shared URL-parameters string with Meta macros (`campaign_id={{campaign.id}}` …), and the
  ad's deep link: the in-app URL plus `amt_l=<slug>`.
- `/l/:slug` stores click-level UTM overrides and `campaign_id`, `adset_id`, `ad_id`, `placement`, `fbclid`, `campaign_ids`;
  on Android they also go into the Play referrer.
- A deep link with `amt_l` credits the open to that ad link (its UTM values and `link_id`).
- `/api/v1/attribution` returns `campaign_id`, `adset_id`, `ad_id` and `deep_link { url, link }`. The SDK's
  `onDeferredDeepLink` hands it to a new install once, within 24 h.
- Limit: a fresh iOS install is matched to an ad link only by the opt-in probabilistic match (part 1), which is not built.

## 5. Data model

Migrations `0003_ad_signals.sql` and `0004_ad_links.sql`:

- `installs`: `ad_consent`, `ad_consent_ts`, `att_status`, `madid_enc` (sealed), `device_extinfo`, `campaign_id`,
  `adset_id`, `ad_id`, `fbclid`, `campaign_ids`, `link_id`.
- `link_clicks`: click-level UTM and ad parameters. `links`: `deep_link_url`, `integration_id`.
- `integrations` (one per network per app; `capi_token_enc`, `oauth_token_enc` sealed), `integration_mappings`,
  `postback_outbox`, `integration_audit`.

Part 1's planned migration `0002_probabilistic.sql` must take the next free number (0005) and skip columns that now exist.

## 6. Security

- **Secrets** (`apps/server/src/lib/sealed.ts`): AES-256-GCM keyed by `INTEGRATIONS_KEY` (32 random bytes, base64), key id
  in the envelope for rotation (`INTEGRATIONS_KEY_PREVIOUS`), the row and field bound as additional data. Without the key
  integrations stay off; nothing is stored in plain text. Tokens are write-only in the API.
- **Outbound**: adapters declare allowed hosts (`graph.facebook.com`); redirects are not followed; 10 s timeout; tokens
  are removed from stored errors; dataset ids must be numeric.
- **Dashboard API**: behind the login cookie, scoped by app id, writes pass an Origin / Sec-Fetch-Site check, every
  settings change is audited by field name only.
- **Facebook Login**: `state` signed with the session key, 10-minute expiry, bound to app and integration and to a
  short-lived httpOnly nonce cookie; callback behind the login; the token goes in the `Authorization` header only.

| OWASP Top 10 (2025) | Where |
|---|---|
| A01 Broken access control | app-scoped routes, callback behind login |
| A02 Security misconfiguration | fail closed without `INTEGRATIONS_KEY` |
| A04 Cryptographic failures | AES-GCM with AAD, write-only tokens |
| A05 Injection | parameterised D1, validated names, ids and URLs |
| A07 Authentication failures | signed OAuth state and nonce cookie, CSRF check |
| A09 Logging failures | redaction, no PII in the delivery log, audit table |
| A10 SSRF-style outbound | host allowlist, numeric dataset id, no redirects |

OWASP LLM Top 10 and ISO/IEC 42001 do not apply: no AI component.

## 7. Privacy (UK GDPR, PECR)

Not legal advice. The operator is the controller and must review this before turning an integration on.

- **Lawful basis**: advertising measurement is not strictly necessary, so the app must ask for consent and call
  `setAdConsent(true)`; withdrawing clears the stored advertising id.
- **Transfer**: Meta processes data in the US under its Business Tools Terms; activation records the operator's
  acceptance. The operator documents the transfer (UK-US data bridge or IDTA) and covers it in a DPIA.
- **Minimisation**: IP and user agent only with tracking allowed, sealed and deleted once sent (or after 7 days);
  advertising id sealed; email off by default and hashed; delivery log without device data, deleted after 30 days.
- **Erasure**: deleting a user deletes their queued and logged postbacks and the install (with its sealed id). Data
  already sent to Meta is deleted through Meta.
- **Policy text**: the setup wizard's privacy paragraph adds the advertising-measurement disclosure when an integration is active.
