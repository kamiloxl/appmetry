-- Ad-network foundations (plan: ad-network postbacks, phase 0 + 1). All times are INTEGER ms since the epoch, UTC.

-- Ad consent and identifiers, set from the SDK's install / consent events. madid_enc is the IDFA (iOS, ATT authorized)
-- or GAID (Android), AES-GCM encrypted with INTEGRATIONS_KEY (src/lib/secrets.ts), stored only when ad_consent = 1.
ALTER TABLE installs ADD COLUMN ad_consent INTEGER; -- 1 | 0 | NULL (never reported)
ALTER TABLE installs ADD COLUMN ad_consent_ts INTEGER; -- ts of the SDK event that set it: an older event never wins
ALTER TABLE installs ADD COLUMN att_status TEXT; -- authorized | denied | restricted | notDetermined (iOS only)
ALTER TABLE installs ADD COLUMN madid_enc TEXT;
ALTER TABLE installs ADD COLUMN device_extinfo TEXT; -- JSON, no personal data: { modelId, w, h, density }
-- Per-click campaign parameters that travel with the attribution (ATTRIBUTION_COLUMNS in src/ingest.ts).
ALTER TABLE installs ADD COLUMN campaign_id TEXT;
ALTER TABLE installs ADD COLUMN adset_id TEXT;
ALTER TABLE installs ADD COLUMN ad_id TEXT;
ALTER TABLE installs ADD COLUMN fbclid TEXT;
ALTER TABLE installs ADD COLUMN campaign_ids TEXT; -- Meta AEM: opaque encrypted string from the ad's deep link

-- Click-level values from the tracked link's query string; they override the link's own values for this click.
ALTER TABLE link_clicks ADD COLUMN utm_source TEXT;
ALTER TABLE link_clicks ADD COLUMN utm_medium TEXT;
ALTER TABLE link_clicks ADD COLUMN utm_campaign TEXT;
ALTER TABLE link_clicks ADD COLUMN utm_term TEXT;
ALTER TABLE link_clicks ADD COLUMN utm_content TEXT;
ALTER TABLE link_clicks ADD COLUMN campaign_id TEXT;
ALTER TABLE link_clicks ADD COLUMN adset_id TEXT;
ALTER TABLE link_clicks ADD COLUMN ad_id TEXT;
ALTER TABLE link_clicks ADD COLUMN placement TEXT;
ALTER TABLE link_clicks ADD COLUMN fbclid TEXT;
ALTER TABLE link_clicks ADD COLUMN campaign_ids TEXT;

-- Ad links: in-app path for deep links / personalised journeys, and the integration the link was made for.
ALTER TABLE links ADD COLUMN deep_link_path TEXT;
ALTER TABLE links ADD COLUMN integration_id TEXT;

-- One row per connected ad network per app. Secrets are AES-GCM encrypted (src/lib/secrets.ts), never returned by the API.
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  provider TEXT NOT NULL, -- meta
  status TEXT NOT NULL DEFAULT 'draft', -- draft | active | error | disconnected
  send_scope TEXT NOT NULL DEFAULT 'all', -- all | attributed
  config TEXT NOT NULL DEFAULT '{}', -- JSON: { dataset_id, dataset_name, test_event_code, ... }
  capi_token_enc TEXT,
  oauth_token_enc TEXT,
  oauth_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (app_id, provider)
);

-- Appmetry event (install, rc_*, or a custom event name) → the network's event name.
CREATE TABLE integration_mappings (
  app_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  source_event TEXT NOT NULL,
  target_event TEXT NOT NULL,
  send_value INTEGER NOT NULL DEFAULT 1,
  locked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (integration_id, source_event)
);

-- Delivery queue and log. The unique key is the dedup id sent to the network (Meta event_id).
-- transient_enc holds the SDK request's IP and user agent (encrypted) only until the event is sent or expires.
CREATE TABLE postback_outbox (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  integration_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  install_id TEXT,
  target_event TEXT NOT NULL,
  event_ts INTEGER NOT NULL,
  value_cents INTEGER,
  currency TEXT,
  transient_enc TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  UNIQUE (integration_id, source_event_id, target_event)
);
CREATE INDEX postback_outbox_due ON postback_outbox (status, next_attempt_at);
CREATE INDEX postback_outbox_install ON postback_outbox (app_id, install_id);

-- Who changed which integration setting, and when. Never holds secrets.
CREATE TABLE integration_audit (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  integration_id TEXT,
  action TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX integration_audit_app_ts ON integration_audit (app_id, ts);
