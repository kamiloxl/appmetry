# iOS probabilistic install attribution (opt-in)

Date: 2026-11-05. Status: design approved in conversation, awaiting written-spec review.

> **Update 2026-11-06.** Part 2 (`2026-11-06-ad-network-postbacks-design.md`) is implemented and changes this spec:
> - Migrations `0003_ad_signals.sql` and `0004_ad_links.sql` already add `installs.ad_consent`, `att_status`,
>   `campaign_id`, `adset_id`, `ad_id` and the `link_clicks` campaign columns, and the SDK already has `adConsent`,
>   `setAdConsent`, the ATT status and `deviceModelId` (as a `consent` event type, not `$ad_consent`). This spec's
>   migration becomes `0005_probabilistic.sql` and adds only `apps.probabilistic_ios`, `installs.match_ip_hash` and
>   `click_signals`.
> - iOS events go to Meta also without ATT authorization, with `advertiser_tracking_enabled = 0` and no device
>   identifiers (Meta AEM). The "authorized only" line in §1 no longer holds.
> - A probabilistic match should set `installs.link_id`, so `onDeferredDeepLink` works for fresh iOS installs.

## 1. Goal and context

Paid social campaigns (Meta first; TikTok and Snap later) send iOS users through a tracked link straight to the App Store, with no landing page. Today Appmetry cannot connect such a click to the install: on iOS an install is attributed only by Apple Search Ads (AdServices) or by a deep link opened after install. Meta traffic on iOS therefore lands in "Organic".

This spec adds an **opt-in, off-by-default probabilistic match** between an iOS link click and the first launch of the app, plus the per-click campaign parameters that paid campaigns need. It is the first part of the Meta integration. The second part, a separate spec, covers `fbc`, sending events to Meta's Conversions API and importing spend from the Marketing API.

Goals, as agreed:

- **Reporting in Appmetry**: iOS installs and revenue credited to the paid campaign and ad, so ROAS per campaign is visible.
- **Optimisation in Meta**: provided by the CAPI spec. That spec sends iOS events to Meta only for installs with ATT status `authorized`. This spec records the ATT status it needs.

Reference point: Appstack does the same. Its docs describe "advanced probabilistic matching" from click-time device data and the SDK, with no landing page.

### 1.1 Decisions taken

| Decision | Choice | Rejected alternatives |
|---|---|---|
| iOS matching method | Probabilistic, opt-in per app, off by default | Landing page plus clipboard: deterministic, but adds a screen before the store. Aggregate-only reporting from the network. |
| Ambiguity | Attribute only when every candidate points to the same campaign | "Best guess" by nearest timestamp |
| Window | 24 h from click to install | Longer windows: more false positives |
| Consent default | `adConsent` defaults to `false` | Default `true` when the app toggle is on |

### 1.2 Changed principle

The main spec (`2026-11-05-appdash-design.md`, attribution row) and the README say "No fingerprinting / probabilistic matching" and "No IP address … is stored". After this change they say:

- Deterministic methods are the default.
- An optional, off-by-default iOS probabilistic match exists. It keeps a keyed hash of the IP address, the iOS version, the device model and the language for at most 24 hours. Raw IP addresses are never stored.

### 1.3 Risks the operator accepts by turning it on

These are shown next to the toggle and in the README:

- **Apple**: the Apple Developer Program License Agreement and the ATT guidance forbid deriving data from a device to identify it, even with ATT permission. Many attribution vendors still match this way. The App Review risk is the app developer's.
- **UK GDPR / PECR**: an IP address is personal data. Reading device data in the SDK for advertising measurement is unlikely to be "strictly necessary". The install side therefore requires the app's consent (`adConsent`). The click side keeps a hashed IP for up to 24 h before any consent is possible. That needs a legitimate-interests assessment and a DPIA by whoever runs the instance.
- This spec is a technical design, not legal advice. Whoever runs the instance must have a data-protection review before turning the feature on in production.

## 2. Architecture and data flow

### 2.1 Click (`GET /l/:slug`)

All existing behaviour stays: platform from the user agent, store redirect, Play referrer on Android and the `link_clicks` row.

New, all platforms: campaign parameters from the click URL (section 3).

New, only when `platform === 'ios'` and `apps.probabilistic_ios = 1`:

1. Rate-limit by IP with the existing `INGEST_LIMITER`, key `link:<ip>`. When the limit is hit, still redirect, but skip the signals row.
2. Compute `ip_hash = hex(HMAC-SHA256(match_key, ip))`, where `ip` is `cf-connecting-ip`. An IPv6 address is used in full.
3. Parse the user agent with `signalsFromUA(ua)`:
   - **Meta in-app browser** (`FBAN/FBIOS`): `device_model` from `FBDV/` (for example `iPhone15,2`), `os_version` from `FBSV/` (major.minor), `locale` from `FBLC/`. `os_strong = 1`.
   - **Other browsers**: `os_version` from `CPU iPhone OS x_y` (major.minor). `os_strong = 0`, because recent Safari releases may report a reduced or frozen OS version. Check this during implementation. `device_model` and `locale` are null.
4. Insert into `click_signals` with `expires_at = ts + 24 h`, in the same `waitUntil` as the `link_clicks` insert.

The raw IP and the raw user agent are never written anywhere, including logs.

`match_key` is 32 random bytes, base64. It is created once, with `INSERT OR IGNORE`, in the `meta` table under the key `match_key`, the same way as `session_key` (`auth.ts`), and cached per isolate.

### 2.2 Install (`makeOnInstall` in `apps/server/src/attribution.ts`)

After the existing referrer and AdServices handling, for an iOS install, run `matchProbabilistic` when **all** of these hold:

- `apps.probabilistic_ios = 1`
- the install event has `props.adConsent === true`
- the install's `attribution_method` is `organic`, `reported` or null. A deterministic method is never replaced.
- `asa_pending_token` is null. If a Search Ads token is pending, its result wins. When the token resolves as "not Search Ads", `resolveAsaToken` calls `matchProbabilistic` with the IP hash saved for this purpose (see 2.4).

`matchProbabilistic(db, app, installId, ipHash, device)`:

1. Candidates:
   ```sql
   SELECT s.click_id, s.ts, s.os_version, s.os_strong, s.device_model,
          c.link_id, c.utm_campaign, c.utm_content, c.campaign_id, c.adset_id, c.ad_id
   FROM click_signals s JOIN link_clicks c ON c.id = s.click_id
   WHERE s.app_id = ? AND s.ip_hash = ? AND s.ts BETWEEN ? AND ? AND s.expires_at > ? AND c.install_id IS NULL
   ```
   The `ts` range is `[first_seen − 24 h, first_seen + 60 s]`. The 60 s allows for clock skew between the device's `first_seen` and the server.
2. Filter with the pure function `pickClick(candidates, device)` in `packages/shared/src/probabilistic.ts`:
   - If `os_strong = 1`, the candidate's `os_version` must equal the install's iOS major.minor.
   - If `device_model` is set, it must equal the install's `deviceModelId`.
   - If `os_strong = 0` and the major versions differ, drop the candidate.
3. Group the remaining candidates by `(link_id, campaign_id, utm_campaign, utm_content)`. If there is **exactly one group**, the winner is that group's latest click. If there are none or several, the result is no match.
4. On a match, in one batch:
   - Apply the attribution from the winning click with method `probabilistic`, using the existing `applyAttribution` path: source and channel from the link plus the click's UTM values, `click_id`, `campaign_id`, `adset_id`, `ad_id`.
   - `UPDATE link_clicks SET install_id = ? WHERE id = ? AND install_id IS NULL`
   - `DELETE FROM click_signals WHERE click_id = ?`

The install's IP is hashed in memory from the batch request's `cf-connecting-ip`. Section 2.4 describes the only case where the hash is kept.

### 2.3 Consent given after install (`$ad_consent`)

When `setAdConsent(true)` is called or the ATT status changes, the SDK sends an internal event `$ad_consent` with props `{ adConsent, att }`. The server:

- updates `installs.ad_consent` and `installs.att_status`;
- runs `matchProbabilistic` with the IP hash of **this** request, if the install is under 24 h old, is still eligible (2.2) and `adConsent` is now true.

### 2.4 Search Ads token pending

If an iOS install arrives with an AdServices token while `adConsent` is true and the toggle is on, the server stores `installs.match_ip_hash` together with `asa_pending_token`.

When the token resolves to "not Search Ads", `resolveAsaToken` runs `matchProbabilistic` with that hash. This happens on whichever path resolves it: the install hook's `waitUntil` or the cron retry. It always sets `match_ip_hash = NULL` when the token resolves or expires, so the hash lives at most 24 h. The match adds up to two queries (the candidate select and the apply batch), so `ASA_COST` in `cron.ts` goes up by two.

### 2.5 Method priority

`AttributionMethod` gains `'probabilistic'`. The new `METHOD_PRIORITY`:

| Method | Priority |
|---|---|
| install_referrer | 1 |
| search_ads | 2 |
| deep_link | 3 |
| probabilistic | 4 |
| reported | 5 |
| organic | 6 |

A deterministic deep link that arrives later replaces a probabilistic result. The reverse never happens.

## 3. Campaign parameters from the click URL (both platforms)

`/l/:slug` reads optional query parameters. Values longer than 200 characters are cut, empty values are ignored, and keys matching `PRIVATE_PARAM` are dropped:

| Parameter | Effect |
|---|---|
| `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` | Override the link's value for this click |
| `campaign_id`, `adset_id`, `ad_id`, `placement` | Stored on the click |

They are stored on new `link_clicks` columns. Attribution uses the click's value and falls back to the link's. On Android, `withReferrer` adds the same values to the Play Install Referrer, so `fromInstallReferrer` picks them up. The parser is `touchFromQuery`, extended with the four id fields.

The names are network-neutral (not `meta_*`), because TikTok and Snap offer equivalent URL macros.

In the dashboard, each link on the **Links** page gets a copyable "Meta URL parameters" string:

```
utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&placement={{placement}}
```

`utm_medium=paid_social` already classifies as channel `Paid` (`PAID_MEDIUM` in `sources.ts`).

## 4. SDK (`packages/sdk-expo`)

- `AppmetryOptions.adConsent?: boolean`, default `false`.
- `Appmetry.setAdConsent(granted: boolean)`. It persists `appmetry:ad_consent` and sends `$ad_consent` when the value or the ATT status changes. This is separate from `requireConsent` / `optIn()`. When analytics consent is withheld, nothing is sent at all, as today.
- Native iOS module: `getTrackingAuthorizationStatus(): 'authorized' | 'denied' | 'restricted' | 'notDetermined' | null`. It reads `ATTrackingManager.trackingAuthorizationStatus` (iOS 14+) and **never shows the prompt**. It returns null on Android or when the framework is unavailable.
- The install event props gain `adConsent` (boolean) and `att` (iOS only).
- Context gains `deviceModelId` (`Device.modelId`, for example `iPhone15,2`; iOS only). It is used for matching and is not stored on `installs`.
- On each foreground, the SDK re-reads the ATT status. If it changed since the last `$ad_consent` or install event, the SDK sends `$ad_consent`.
- The README gets a section on calling `setAdConsent` from the app's consent flow or after the ATT prompt, with the reasons from 1.3.

## 5. Data model (migration `0002_probabilistic.sql`)

```sql
ALTER TABLE apps ADD COLUMN probabilistic_ios INTEGER NOT NULL DEFAULT 0;

CREATE TABLE click_signals (
  click_id TEXT PRIMARY KEY,        -- = link_clicks.id
  app_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,            -- hex HMAC-SHA256(match_key, ip)
  os_version TEXT,                  -- major.minor
  os_strong INTEGER NOT NULL DEFAULT 0,
  device_model TEXT,                -- e.g. iPhone15,2 (Meta in-app browser only)
  locale TEXT,
  expires_at INTEGER NOT NULL
);
CREATE INDEX click_signals_match ON click_signals (app_id, ip_hash, ts);
CREATE INDEX click_signals_expiry ON click_signals (expires_at);

ALTER TABLE link_clicks ADD COLUMN utm_source TEXT;
ALTER TABLE link_clicks ADD COLUMN utm_medium TEXT;
ALTER TABLE link_clicks ADD COLUMN utm_campaign TEXT;
ALTER TABLE link_clicks ADD COLUMN utm_term TEXT;
ALTER TABLE link_clicks ADD COLUMN utm_content TEXT;
ALTER TABLE link_clicks ADD COLUMN campaign_id TEXT;
ALTER TABLE link_clicks ADD COLUMN adset_id TEXT;
ALTER TABLE link_clicks ADD COLUMN ad_id TEXT;
ALTER TABLE link_clicks ADD COLUMN placement TEXT;

ALTER TABLE installs ADD COLUMN campaign_id TEXT;
ALTER TABLE installs ADD COLUMN adset_id TEXT;
ALTER TABLE installs ADD COLUMN ad_id TEXT;
ALTER TABLE installs ADD COLUMN ad_consent INTEGER;      -- 0/1, latest known
ALTER TABLE installs ADD COLUMN att_status TEXT;         -- latest known
ALTER TABLE installs ADD COLUMN match_ip_hash TEXT;      -- only while an ASA token is pending (2.4)
```

`locale` is stored for diagnostics only. It is not a match criterion: device language and browser language often differ.

## 6. Retention, erasure, security

- **Retention**: the hourly cron runs `DELETE FROM click_signals WHERE expires_at < ?` once per run. It is global, costs one query and is reserved from `QUERY_BUDGET`. A signals row is also deleted as soon as it is matched. `match_ip_hash` lives at most 24 h (2.4).
- **Turning the toggle off**: `DELETE FROM click_signals WHERE app_id = ?` and `UPDATE installs SET match_ip_hash = NULL WHERE app_id = ?`.
- **Erasure**: `click_signals` has no install link, because matched rows are deleted. The new `installs` columns go with the install row. `eraseStatements` needs no change.
- **App deletion**: add `click_signals` to `CHILD_TABLES` in `apps/server/src/apps.ts`, so `DELETE /api/apps/:id` removes it too.
- **Security** (OWASP Top 10 2025):
  - *A02 Cryptographic Failures*: HMAC-SHA256 with a 256-bit random key. Residual risk: IPv4 has only 2³² values, so anyone holding both `match_key` and the table can reverse a hash. The 24 h TTL limits this, and the key never appears in logs or API responses.
  - *A04 Insecure Design / abuse*: the per-IP rate limit on `/l/:slug` when the feature is on. Forged clicks can only skew reports. They cannot reach any other data.
  - *A09 Logging*: no IP address, hash, user agent or `match_key` in logs or error messages.
  - *A01 Access control*: `/l/:slug` stays public. The toggle sits behind the existing session guard.
- **Data location**: unchanged (D1 location, see README). Nothing is sent to a third party by this spec.

## 7. Dashboard

- **App Settings**: toggle "iOS probabilistic matching (opt-in)", off by default. Turning it on needs a confirm dialog with the three risks from 1.3, and the dialog links to the README section. Turning it off clears the data (section 6).
- **Customer journey**: method label `Probabilistic`. The methods filter includes it.
- **Links**: per link, over the last 7 days, the number of iOS clicks with signals and the number of installs matched probabilistically. This shows the real match rate. It is a count over `link_clicks` joined to `installs`, with no new storage.
- **Links**: the copyable Meta URL parameters string (section 3).

## 8. Documentation

- README, "What it tracks": replace "There is no fingerprinting" with the wording from 1.2. Add a "Probabilistic matching (iOS, opt-in)" section: the data kept, the 24 h retention, the consent requirement, the Apple and UK GDPR/PECR notes, the DPIA recommendation, and a short privacy-notice paragraph that operators can adapt.
- Main spec: update the attribution row and the iOS redirect note (`app_store_url`: "installs attributable via Search Ads, a later deep link or, if enabled, probabilistic match").
- SDK README: `adConsent`, `setAdConsent`, ATT status.

## 9. Testing

- `packages/shared`: `pickClick`:
  - window edges, including the 60 s skew;
  - strong and weak OS versions;
  - device model match and mismatch;
  - one group with several clicks (latest wins);
  - two groups (no match);
  - no candidates.
- `signalsFromUA`: Meta in-app browser UAs (iPhone, iPad), Safari, Chrome iOS, missing fields.
- `touchFromQuery`: the new id fields, private parameters dropped, length caps.
- `apps/server`:
  - click with the toggle on writes `click_signals`; with the toggle off it writes nothing; when rate-limited it still redirects;
  - install with `adConsent=true` matches; with `adConsent=false` it does not;
  - deterministic method present means no override; ambiguous candidates mean no match; an expired signal means no match; a matched signal is deleted;
  - `$ad_consent` within 24 h matches; after 24 h it does not;
  - ASA pending, then "not Search Ads", then match from `match_ip_hash`, which is then cleared;
  - cron purge; toggle-off purge;
  - campaign parameters flow into Android referrer attribution.
- `packages/sdk-expo` (jest): `adConsent` and `att` on the install event; `setAdConsent` sends `$ad_consent` only on change; the ATT change detected on foreground; the native module returns null on Android.
- Manual: Meta in-app browser on a real iPhone, click then install from TestFlight, then check the match. Repeat with Safari.

## 10. Out of scope

- Sending events to Meta (CAPI), `fbc` / `fbp`, Marketing API spend import: Meta CAPI spec.
- Probabilistic matching on Android: the Play Install Referrer already covers it deterministically.
- Landing page or clipboard deterministic flow.
- SKAdNetwork / AdAttributionKit.
