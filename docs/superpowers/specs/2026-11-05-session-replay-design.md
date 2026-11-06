# Session replay — design spec

Date: 2026-11-05 · Status: draft for review · Builds on [the MVP spec](2026-11-05-appdash-design.md)

## 1. Intent

**What:** let the person who runs an appmetry instance see what users do in their app: where they tap, where they
get stuck, and (in stage 2) a visual replay of a session, similar to PostHog session replay for mobile.

**Who:** the same indie developers and small teams as the MVP. They debug UX and paywall drop-off after the fact.
There is no live view and no support-agent playback.

**Delivery in two stages.** Each stage ships on its own and has its own implementation plan.

| Stage | What the user gets | New infrastructure | Rough effort |
| --- | --- | --- | --- |
| 1. Tap trail | Taps per screen (heatmap, top tapped elements, rage taps), taps in the customer journey | None (D1 `events`) | ~1 week |
| 2. Visual replay | Low-fps screenshot replay of sampled sessions, with taps and events on a timeline | R2 bucket (opt-in), native capture in the SDK | ~4–6 weeks |

**Success criteria**

1. Stage 1: with `captureTaps: true` the dashboard shows a tap heatmap for any screen and rage taps per session,
   with no change to the deploy flow and no native code.
2. Stage 2: a deployer who adds an R2 binding and turns replay on for an app can watch a sampled session within a
   minute of it ending, with every text input masked and, by default, all text masked.
3. Neither stage changes behaviour for existing installs that do not opt in. The one-click deploy keeps working
   without R2.
4. Both stages stay within the Cloudflare free plan at side-project scale (§6).

**Decisions taken**

| Topic | Decision |
| --- | --- |
| Replay technique | Screenshots (JPEG/WebP frames). No wireframe / view-hierarchy reconstruction, no rrweb. |
| Tap capture | JS only, via `AppmetryProvider`. Reused as the tap overlay in stage 2. |
| Element identity | `testID` only. Never text content or `accessibilityLabel` (both can hold user data). |
| Storage for frames | R2, opt-in by the deployer. Not in the default `wrangler.jsonc`. |
| Defaults | Everything off. Text inputs always masked; all text masked unless the deployer turns it off. |
| Control plane | Replay on/off, sample rate and masking are per-app settings in the dashboard, read by the SDK at runtime, so no app release is needed to stop recording. |

**Assumptions (correct me if wrong)**

- Targets iOS and Android dev builds / production apps. Expo Go and Expo web get stage 1 only.
- The single admin of an instance is the only viewer. No per-viewer accounts or view audit log.
- Low frame rate (≤ 2 fps, default 1) is good enough; smooth video is not a goal.

## 2. Architecture

```
SDK (JS)                                   Worker                                  Storage
──────────────────────────────────────────────────────────────────────────────────────────────
AppmetryProvider ── taps event ─────────▶ POST /api/v1/batch ───────────────────▶ D1 events (type 'taps')
                                                                                   
Replay controller ── GET config ────────▶ GET  /api/v1/replay/config ◀────────── D1 apps.replay_*
   │ start/stop/screen/tap
   ▼
Native recorder (Swift/Kotlin)
 capture → mask → encode → chunk file
 native uploader ─── .amr chunk ────────▶ POST /api/v1/replay/chunk ────────────▶ R2 REPLAYS + D1 replays

Dashboard ──────────── session cookie ──▶ /api/apps/:id/taps…, /replays…  ◀────── D1 + R2 (proxied)
```

New code, by package:

| Package | Stage 1 | Stage 2 |
| --- | --- | --- |
| `packages/shared` | `taps` event type, `validateTaps` | `.amr` chunk format: types, `parseChunk`, limits |
| `packages/sdk-expo/src` | `taps.ts` (classifier, rage, buffer), provider wrapper | `replay.ts` (config fetch, sampling, consent, native bridge) |
| `packages/sdk-expo/ios`, `android` | — | `AppmetryReplay` native module + `AppmetryMaskView` |
| `apps/server` | `stats/taps.ts`, timeline extension | `replay/ingest.ts`, `replay/routes.ts`, retention + erasure for R2, migration `0002` |
| `apps/dashboard` | Taps page (heatmap) | Replays list + player, settings section |

## 3. Stage 1: tap trail

### 3.1 SDK

```ts
Appmetry.init({ appKey, host, captureTaps: true }); // default false
<AppmetryProvider>{/* app */}</AppmetryProvider>     // also works without expo-router
```

- **Wrapper.** With `captureTaps` on, `AppmetryProvider` renders
  `<View style={{ flex: 1 }} onTouchStart onTouchEnd onTouchCancel>` instead of a `Fragment`. Touch events bubble
  in React Native, so the wrapper sees touches on every child without becoming the responder or blocking any
  gesture. With `captureTaps` off the provider stays a `Fragment` (no layout change).
- **Tap classifier.** A tap is one finger (`touches.length === 1` at start) released within 400 ms, after moving at
  most 10 pt. Drags, scrolls, long presses and multi-touch are ignored.
- **Coordinates.** `x`, `y` are integers 0–1000, relative to the window width and height (`Dimensions.get('window')`
  at tap time). The window size in pt (`w`, `h`) travels with the taps, so orientation is `w > h`. These are
  viewport coordinates: a tap on a scrolled list lands where it was on screen, not where it is in the list.
- **Element.** `testID` of the touched element, if it can be read (spike S1, §3.6); otherwise none. Labels are
  truncated to 40 characters.
- **Rage tap.** The third and later taps within 1 s, each within 30 pt of the first tap of the run, get `rage: 1`.
- **Screen.** Taps belong to the current screen name: the last expo-router pathname or `Appmetry.screen()` call;
  `(unknown)` before the first one.
- **Buffering.** Taps are buffered per screen view and sent as one `taps` event when the screen changes, the app goes
  to the background, or the next tap would push the event's props past `LIMITS.maxPropsChars` (1024). This keeps D1
  writes close to one row per screen view instead of one per tap.
- **Consent.** Taps follow the existing `enabled` flag: nothing is buffered before `optIn()` when `requireConsent`
  is on, and `optOut()` drops the buffer.
- Never throws into the host app (same rule as the rest of the SDK).

### 3.2 Wire format

`EVENT_TYPES` gains `'taps'`. One event per screen view:

```ts
{ id, sid, ts /* first tap */, type: 'taps', name: '/paywall', props: {
  w: 390, h: 844,                    // window size in pt
  l: ['buy_button', 'close'],        // distinct testIDs, at most 8
  t: [[512, 880, 0, 0, 0],           // [x, y, dtMs from ts, label index or -1, rage 0|1]
      [510, 882, 420, 0, 0]],
} }
```

`validateTaps(props)` in `packages/shared` checks: `w`, `h` integers 1–4000; `l` an array of at most 8 strings of at
most 40 characters; `t` an array of at most 100 tuples of five integers with `x`, `y` in 0–1000, `dtMs` in
0–600 000, label index −1 to `l.length − 1`, rage 0 or 1. An invalid `taps` event is dropped like any invalid
event; the rest of the batch is kept.

Compatibility: a server older than this change drops `taps` events as an unknown type and still returns 202. A new
server accepts batches from old SDKs unchanged.

### 3.3 Server

- **Ingest.** Stored as a normal `events` row (`type = 'taps'`). The session aggregates already count only `screen`
  and `event`, so taps change no existing stat. Retention and erasure cover them with no change, because they are
  `events` rows.
- **Heatmap.** `GET /api/apps/:id/stats/taps?screen=<name>&orientation=portrait|landscape` plus the existing filter
  and date-range parameters. The server reads the newest 5 000 matching `taps` rows (to protect the D1 read
  budget), expands `t` with `json_each`, and returns:
  - `grid`: counts in a 20 × 40 grid (portrait) or 40 × 20 grid (landscape)
  - `total` and `rage` counts
  - `labels`: the top 20 testIDs with tap and rage counts
  - `sampled: true` when the 5 000-row cap was hit
- **Screens with taps.** `GET /api/apps/:id/stats/taps/screens` lists screens by tap count for the screen picker.
- **Journey.** `installTimeline` adds, per screen view, `taps` and `rage` counts from the matching `taps` events.

### 3.4 Dashboard

- **Taps** page (`/apps/:id/taps`): screen picker, orientation toggle, and a heatmap drawn on a phone-shaped canvas
  using the median `w:h` of the data. It also shows a top-elements table (testID, taps, rage taps) and a rage-tap
  total with a link to sessions that have rage taps. It respects the global filter bar.
- **Customer journey modal:** screen rows show `· 12 taps` and a red `3 rage taps` badge.
- **Setup:** wizard step 2 snippet gets a `captureTaps: true` line with a comment. The privacy paragraph in
  `lib/setup.ts` mentions tap positions when the option is on.

### 3.5 Limits

- At most 100 taps and 8 labels per event; one `taps` event per screen view.
- One extra `events` row per screen view that had taps. A session with 10 screen views and 20 other events gets up
  to 10 more rows, so D1 writes grow by up to about 30% for apps that turn it on.

### 3.6 Spike S1: reading `testID` on Fabric (do first, half a day)

React Native 0.88 runs the new architecture only. Find out whether the touch event's target exposes the touched
element's `testID` through a supported API, such as the DOM-like node APIs. If only private internals (fiber
handles) expose it, use them behind try/catch, so a future React Native change degrades to "no label", never a
crash. If neither works, ship coordinates only and say so in the SDK README. The rest of stage 1 does not depend on
the outcome.

## 4. Stage 2: visual replay

### 4.1 Turning it on (three switches, all off by default)

1. **Deployer adds R2.** The bucket is not in the default `wrangler.jsonc`, so the one-click deploy keeps working
   for people who do not want replay and avoids any R2 activation step. The README documents:
   ```sh
   npx wrangler r2 bucket create appmetry-replays --jurisdiction eu   # EU data residency
   npx wrangler r2 bucket lifecycle add appmetry-replays expire-90d --expire-days 90  # backstop
   ```
   and the binding to add to the fork's `wrangler.jsonc`:
   `"r2_buckets": [{ "binding": "REPLAYS", "bucket_name": "appmetry-replays", "jurisdiction": "eu" }]`.
2. **Per-app settings** in the dashboard (Settings → Session replay). Disabled with an explanation when the
   `REPLAYS` binding is missing:

   | Column on `apps` | Default | Meaning |
   | --- | --- | --- |
   | `replay_enabled` | 0 | Kill switch, read by the SDK at runtime |
   | `replay_sample_pct` | 10 | Share of sessions recorded, 0–100 |
   | `replay_retention_days` | 30 | 1–90 |
   | `replay_mask_all_text` | 1 | Mask every text view, not only inputs |
   | `replay_mask_images` | 0 | Mask every image view |
   | `replay_daily_mb` | 300 | Upload quota per app per UTC day |

3. **App developer opts in** in the SDK: `Appmetry.init({ …, replay: { enabled: true } })`.

### 4.2 SDK public API

```ts
Appmetry.init({
  appKey, host,
  replay: {
    enabled: true,                 // default false
    requireConsent: true,          // default: same as the top-level requireConsent
    maxFps: 1,                     // 0.2–2
    maskAllText: false,            // can only make masking stricter than the server setting
    maskImages: false,             // same
    excludeScreens: ['/settings/billing', '/case/'], // prefix match on the screen name
  },
});
Appmetry.optInReplay(); Appmetry.optOutReplay();      // separate consent purpose, persisted
<AppmetryMask><CaseDetails /></AppmetryMask>          // always masked, whatever the settings
```

- `captureTaps` is forced on while a session is being recorded, because the player's tap overlay comes from
  stage 1 events.
- `optOut()` also stops replay and deletes local chunk files. `optOutReplay()` does the same for replay only.
- Without the native module (Expo Go, web) replay is off; with `debug: true` the SDK logs why.

### 4.3 Session start (JS controller, `replay.ts`)

On every session start the controller checks, in order:

1. Replay is enabled in the SDK.
2. Consent is granted (analytics, and replay when `replay.requireConsent` is on).
3. The native module is present.
4. The server config allows it: `GET /api/v1/replay/config` returns
   `{ enabled, samplePct, maskAllText, maskImages, maxFps }`. The response is cached in AsyncStorage for 6 hours.
   Any failure counts as "disabled".
5. The session is sampled. `hash(sessionId) mod 100 < samplePct` is deterministic, so a retry never flips the
   decision.

If every check passes, it calls `native.start({ host, appKey, iid, sid, maxFps, maskAllText, maskImages })`. The
effective masking is the stricter of the server and SDK values, and `maxFps` the lower. After that it forwards
`setScreen(name, excluded)` on each screen change and `notifyTap()` on each tap, and calls `native.stop()` on
background or session end. A `403 replay_disabled` from the chunk endpoint makes the native side stop and clears
the cached config, so a kill switch takes effect within one chunk.

### 4.4 Native recorder (`AppmetryReplay` Expo module, iOS + Android)

Capture, masking, encoding, chunking and upload all run natively, so no image bytes cross the JS bridge.

**Capture.** On a timer at `maxFps`, plus 250 ms after a tap and 300 ms after a screen change:

- iOS: on the main thread, render the key window with `drawHierarchy(in:afterScreenUpdates: false)` into a
  `UIGraphicsImageRenderer` scaled so the output is at most 360 px wide.
- Android: `PixelCopy.request(window, bitmap…)` into a bitmap at most 360 px wide. If the window has `FLAG_SECURE`,
  skip the frame and emit a `hidden` marker.
- The system keyboard draws in its own window and is never captured on either platform.

**Masking (fail closed).** Mask rectangles are collected on the main thread by walking the view tree. They are
painted as solid grey boxes onto the bitmap before encoding, so unmasked pixels never leave the capture context.

| Masked | iOS | Android |
| --- | --- | --- |
| Always | `UITextField`, `UITextView`, `isSecureTextEntry`, `AppmetryMaskView` | `EditText`, password input types, `AppmetryMaskView` |
| `maskAllText` | React Native paragraph/text views, `UILabel` | React Native text views, `TextView` |
| `maskImages` | `UIImageView` and React Native image views | `ImageView` and React Native image views |

- On Android, where the copy is asynchronous, rectangles are collected both before and after the copy, then the
  union is painted, padded by 4 px. This covers a view moving during the copy.
- If the walk throws or takes longer than 16 ms, the frame is dropped, never sent unmasked.
- `AppmetryMaskView` is a tiny native view exported by the module and wrapped by `<AppmetryMask>`. Detection is by
  class, so it does not depend on React Native internals.
- The exact React Native text and image view classes on 0.88 are checked during implementation (§10).

**Excluded screens.** While the current screen matches `excludeScreens`, no frames are captured; a `hidden` marker
is written instead and a `resume` marker when the user leaves.

**Encoding and de-duplication.** iOS: JPEG, quality 0.4. Android: lossy WebP, quality 40. Target is 15–30 KB a frame.
A 16 × 32 grayscale thumbnail hash skips frames identical to the previous one; the player holds the last frame.

**Chunking.** A chunk is closed every 15 s, or at 30 frames, or at 600 KB, whichever comes first, and on
background or stop. It is written to `<cache>/appmetry-replay/<sid>/<seq>.amr`.

**Upload.** A native uploader (`URLSession` / `HttpURLConnection` on a background thread) POSTs chunks in `seq`
order, with exponential backoff (2 s to 5 min). On `202` or `409` it deletes the file. On `403` it stops and
purges. On `400` or `413` it drops the chunk. On anything else it retries. Local cap: 10 MB and 24 hours; the
oldest chunks go first.

**Performance budget** (checked on an iPhone 12 and a mid-range Android such as a Pixel 6a):

- p95 main-thread time per capture of at most 8 ms
- no visible jank in the demo app's scroll test at 1 fps
- memory growth of at most 20 MB

If Android misses the budget, its default `maxFps` drops to 0.5.

### 4.5 Chunk format `.amr` v1

```
"AMR1" (4 bytes) | header length (u32 big-endian) | header (UTF-8 JSON, ≤ 8 KB) | frame bytes, concatenated
```

```ts
interface ChunkHeader {
  v: 1; iid: string; sid: string; seq: number /* 0–9999 */;
  platform: 'ios' | 'android'; bundleId: string;
  w: number; h: number;                       // window size in pt, matches tap coordinates
  frames: { ts: number; len: number; fmt: 'jpeg' | 'webp' }[];   // ≤ 60
  markers: { ts: number; kind: 'hidden' | 'resume' | 'background' | 'foreground' }[]; // ≤ 50
}
```

`parseChunk(bytes)` in `packages/shared` is used by both the server and the dashboard. It checks:

- the magic bytes, and a header length of at most 8 KB that lies within the body
- the header schema; ids use the same pattern as events
- that `Σ len` equals the remaining bytes exactly
- that each frame starts with the magic bytes for its `fmt` (JPEG `FF D8 FF`; WebP `RIFF????WEBP`)
- that all timestamps are within the event window (`now − 7 d … now + 60 s`)

It never trusts a length without a bounds check.

### 4.6 Server

**SDK routes** (public to `apiGuard`, authenticated with `X-App-Key`, CORS like `/api/v1/*`):

- `GET /api/v1/replay/config`: the app's replay settings, or `{ enabled: false }` when `REPLAYS` is missing.
  Sent with `Cache-Control: max-age=300`.
- `POST /api/v1/replay/chunk`: checks run in this order. The first one that fails decides the response.

  | Check | Response if it fails |
  | --- | --- |
  | Body size, at most 1 MB (content-length and a capped read) | 413 |
  | Known app key | 401 |
  | `REPLAY_LIMITER` (30 requests per 60 s per app key and IP) | 429 |
  | `REPLAYS` binding present | 503 `replay_unavailable` |
  | `replay_enabled` on | 403 `replay_disabled` |
  | `parseChunk` | 400 `invalid_chunk` |
  | Bundle id check (same rule as batches) | 403 |
  | Daily quota (`replay_usage`) | 429 `quota_exceeded` |

  If every check passes, the chunk is written to R2 at `{appId}/{iid}/{sid}/{seq:04}.amr` only if the key does not
  exist yet, so a retry is a no-op and a stolen app key cannot overwrite a chunk. After a new put, the server
  upserts `replays` and adds the bytes to `replay_usage` in one D1 batch, and returns 202. The upsert sets
  `chunks = MAX(chunks, seq + 1)` and `last_chunk_at = MAX(…)`, and adds `frames` and `bytes`. If the key
  already exists, the server returns 409 after an upsert that only creates the row if it is missing and applies the
  `MAX` columns, never the sums. That makes the upsert safe to repeat and never double-counts.

**D1 (migration `0002_replay.sql`).** Adds the `apps` columns from §4.1 and two tables:

```sql
CREATE TABLE replays (
  app_id TEXT NOT NULL, session_id TEXT NOT NULL, install_id TEXT NOT NULL,
  started_at INTEGER NOT NULL, last_chunk_at INTEGER NOT NULL,
  chunks INTEGER NOT NULL, frames INTEGER NOT NULL, bytes INTEGER NOT NULL,
  platform TEXT, w INTEGER, h INTEGER,
  PRIMARY KEY (app_id, session_id)
);
CREATE INDEX replays_started_at ON replays (app_id, started_at);
CREATE INDEX replays_install_id ON replays (app_id, install_id);

CREATE TABLE replay_usage (app_id TEXT NOT NULL, day TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (app_id, day));

CREATE TABLE replay_erasures (app_id TEXT NOT NULL, prefix TEXT NOT NULL, queued_at INTEGER NOT NULL, PRIMARY KEY (app_id, prefix));
```

The chunk can arrive before the session's events batch, so `replays` has no foreign key to `sessions`. The
dashboard joins with a left join.

**Dashboard routes** (session-guarded):

- `GET /api/apps/:id/replays`: replays joined to sessions (duration, screens, entry screen, source, country,
  platform, rage taps), with the global filters plus `hasRage`. Paginated.
- `GET /api/apps/:id/replays/:sid`: a manifest with the chunk count, `w`/`h`, and the session's `screen`, `event`
  and `taps` events.
- `GET /api/apps/:id/replays/:sid/chunks/:seq`: streams the R2 object with `Content-Type:
  application/octet-stream`, `Cache-Control: private, max-age=3600` and `nosniff`. The R2 key is built from the
  `app_id` in the database and the `install_id` in the `replays` row, never from client input.
  - The bucket is never public. No presigned URLs.

**Retention (hourly cron, existing `Budget`).** For each app, replays whose `started_at` is older than
`replay_retention_days` are deleted, R2 objects first (list the `{appId}/{iid}/{sid}/` prefix, then one `delete` of
up to 1 000 keys), then the row. `replay_usage` rows older than 7 days are deleted. The R2 lifecycle rule (90 days)
is the backstop for orphaned chunks, such as a chunk whose events never arrived.

**Erasure.** `eraseStatements` also deletes the matching `replays` rows. `eraseUser` then deletes the R2 prefix
`{appId}/{iid}/` for each erased install, within a request budget. Prefixes it cannot finish go into
`replay_erasures` and are finished by the next cron run. The API response reports `replaysPending` so the dashboard
can say "recordings will be deleted within the hour".

### 4.7 Dashboard

- **Replays** page (`/apps/:id/replays`): a list with date, duration, screens, entry screen, source, country,
  platform and a rage badge, filtered by the global filter bar. The Overview "Screens" panel and the Taps page link
  here, pre-filtered.
- **Player** (`/apps/:id/replays/:sid`):
  - It loads the manifest, then fetches chunks in `seq` order (two in flight) and parses them with `parseChunk`.
  - Frames are shown through `blob:` URLs created with the validated MIME type, and revoked on unmount.
  - The frame shown at time `t` is the last frame with `ts ≤ t`, drawn in a phone frame at the `w:h` aspect ratio.
  - Taps from stage 1 appear as a 600 ms ripple at `(x/1000·W, y/1000·H)`, red for rage taps.
  - Timeline:
    - Markers show screens, custom events and rage taps.
    - Background gaps are greyed out.
    - `hidden` spans show "Hidden by privacy settings".
  - Controls: play/pause, 1×/2×/4×, "skip inactivity" (gaps over 3 s with no frame or tap play in 0.5 s) and an
    event list that jumps to its time.
- **Customer journey modal:** sessions with a recording get a "Replay" link.
- **Taps page:** when a replay exists for the screen, its newest frame becomes the heatmap background.
- **CSP:** `apps/dashboard/public/_headers` changes `img-src 'self' data:` to `img-src 'self' data: blob:`.
- **Settings → Session replay:** the switches from §4.1. A "Delete all recordings for this app" button queues the
  `{appId}/` prefix in `replay_erasures`. The section links to the README steps when `REPLAYS` is missing.
- **Setup wizard step 6 (Privacy):** adds a replay paragraph to the generated privacy-policy text when replay is on.

## 5. Privacy (UK GDPR, PECR)

The deployer is the controller; appmetry is the tool. Screen recording is monitoring of behaviour and can show
anything a user sees, so the defaults are the strictest that still give a useful tool.

- **Opt-in at three levels:** the deployer (R2 and app setting), the developer (SDK option) and, when
  `requireConsent` is on, the end user, with a separate replay consent purpose (`optInReplay`). Taps follow analytics
  consent.
- **Masking by default:**
  - Inputs and `AppmetryMask` are always masked, and no setting can unmask them.
  - All text is masked by default.
  - Excluded screens produce no frames at all.
  - Masking happens on the device, before encoding.
  - The keyboard is never captured.
- **Minimisation:** at most 360 px wide, at most 2 fps, sampling (default 10%), testIDs only, no element text.
- **Retention:** 30 days by default, 90 at most. An R2 lifecycle rule enforces the maximum even if the cron fails.
- **Erasure:** "Delete user data" removes recordings in R2 (immediately or within the next hourly run) and the
  `replays` rows. Tap rows go with `events` as today.
- **Location:** the README tells deployers to create the bucket with `--jurisdiction eu`. Cloudflare's DPA applies
  as for D1.
- **DPIA:** the README and the settings section state that replay needs a DPIA before it is turned on in an app that
  handles special-category or otherwise sensitive data (health, legal, family, finance). For those apps they
  recommend keeping all text masked, and excluding screens that show case, health or payment details.
- **Transparency:** the privacy-policy paragraph generated in `lib/setup.ts` names screen recordings, masking,
  sampling and retention when replay is on.

## 6. Free plan budget

Assumptions: 3-minute average session, about 0.5 captured frames a second after de-duplication, 25 KB per frame.
That gives about 2.3 MB and 12 chunks per recorded session.

| Limit | Effect |
| --- | --- |
| R2 10 GB-month free | About 4 000 recorded sessions kept at once; with 30-day retention, about 130 recorded sessions a day |
| R2 1M Class A ops/month | 12 puts per session gives about 80k recorded sessions a month (not the binding limit) |
| Worker 100k requests/day | 12 uploads per recorded session plus viewing. At 10% sampling of 5 000 sessions a day: about 6 000 requests |
| D1 writes | Stage 1: one `taps` row per screen view. Stage 2: one `replays` upsert and one `replay_usage` upsert per chunk |
| `replay_daily_mb` | Default 300 MB a day, so 30-day retention holds at most about 9 GB, inside the free 10 GB. Longer retention needs a lower quota; the settings section warns when `retention_days × daily_mb` exceeds 10 GB |

The settings section shows the current R2 usage estimate (sum of `replays.bytes`) next to the free 10 GB.

## 7. Security (OWASP Top 10 2025)

| Risk | Control |
| --- | --- |
| A01 Broken access control | Private bucket. Every frame read goes through a session-guarded route. R2 keys are derived from database rows, never from request input. The app key can write but never read. |
| A02 Security misconfiguration | Replay is off without the binding (fail closed). The CSP adds only `blob:` for images. |
| A05 Injection | `parseChunk` checks bounds on every length, magic bytes per frame and the schema of the header JSON. Output is `application/octet-stream` with `nosniff`. Blob URLs are typed from the validated `fmt`. |
| A06 Insecure design (abuse of the public app key) | Per-app daily byte quota, `REPLAY_LIMITER`, a 1 MB chunk cap, frame and marker caps, the kill switch, and write-if-absent R2 puts (no overwrites). |
| A08 Integrity failures | Idempotent chunk keys. Sequence numbers are bounded. |
| A09 Logging | No frame bytes, testIDs or headers in logs; only counts and error codes. |
| A10 Exceptional conditions | Masking fails closed (drop the frame). The SDK never throws. A missing binding returns 503 and the SDK stops. |

Known limitation: anyone with the public app key can upload fake chunks for made-up sessions, within the quota.
Deployers can tighten `replay_daily_mb`.

OWASP LLM Top 10 and ISO/IEC 42001 do not apply: there is no AI component. If AI session summaries are added
later, they need their own review.

## 8. Error handling

- **SDK:** all replay and tap code is wrapped. Native errors are reported to JS as a status and logged only with
  `debug: true`. A failing recorder stops for the session; it never retries capture in a loop.
- **Server:** generic error codes as in §4.6. R2 failures return 503 so the SDK retries. D1 failures after a
  successful R2 put return 500; the SDK retry gets 409, and the 409 path creates the missing `replays` row (§4.6).
  That chunk's bytes are then missing from `replay_usage`, which is acceptable for a quota.
- **Dashboard:** a missing chunk is shown as a gap on the timeline, not as an error page.

## 9. Testing

- **`packages/shared`:** `validateTaps` edge cases. `parseChunk` with truncated bodies, header length past the end,
  `Σ len` mismatch, wrong magic bytes, oversized header, too many frames, and timestamps outside the window.
- **SDK (jest-expo):**
  - tap classifier (tap, drag, long press, multi-touch, cancel), rage runs, and buffering under the 1 KB limit
  - flush on screen change and background, and consent gating
  - replay controller: config cache and failure, deterministic sampling, `excludeScreens`, the stricter-masking
    merge, and `optOut` calling native purge
  - the native module is mocked
- **Native:**
  - Swift and Kotlin unit tests: chunk writer byte layout against `parseChunk` fixtures, mask rectangle collection
    on a synthetic view tree, and fail-closed drop on a walk error
  - manual checklist added to `docs/manual-testing.md`: masked input while scrolling, secure entry, `FLAG_SECURE`,
    keyboard, rotation, offline then online upload, background in the middle of a chunk, kill switch, the
    performance budget
- **Server (vitest pool workers with D1 and R2):**
  - chunk endpoint error order, quota, idempotent put and 409
  - config route with and without the binding
  - retention deletes R2 objects and then rows
  - erasure deletes prefixes and queues leftovers
  - dashboard routes need a session; chunk proxy headers
  - taps heatmap aggregation and the sampling cap
- **Dashboard:** chunk parsing to frames, frame-at-time lookup, skip-inactivity mapping, heatmap grid scaling.
- **E2E:** `scripts/smoke.mjs` sends a `taps` event and a fixture chunk, then reads the heatmap, manifest and chunk.

## 10. To verify during implementation

1. **Spike S1** (§3.6): reading `testID` on React Native 0.88.
2. Whether enabling R2 needs a payment method on the Cloudflare account. Third-party guides disagree. The design
   already keeps R2 out of the default deploy; the README states the requirement once it is confirmed.
3. R2 conditional put (`onlyIf`) for write-if-absent on the binding. Fallback: `head` then `put` (small race,
   acceptable).
4. The React Native 0.88 native view classes for text and images on both platforms, for the mask table in §4.4.
5. The performance budget on real mid-range Android hardware before the Android default `maxFps` is fixed.

## 11. Out of scope

Wireframe replay, live view, network and console capture in replays, AI summaries of sessions, per-viewer access or
view audit logs, replay for Expo web, element heatmaps for scrolled content (content coordinates), and dead-tap
detection.
