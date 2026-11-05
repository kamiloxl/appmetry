-- appdash schema (spec §5). All times are INTEGER milliseconds since the epoch, UTC.

CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  app_key TEXT NOT NULL UNIQUE,
  ios_bundle_id TEXT,
  android_package TEXT,
  app_store_url TEXT,
  play_store_url TEXT,
  web_url TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  rc_secret_hash TEXT,
  retention_months INTEGER NOT NULL DEFAULT 25,
  show_sandbox INTEGER NOT NULL DEFAULT 0,
  setup_state TEXT, -- JSON, spec §6a
  created_at INTEGER NOT NULL
);

-- Instance-level values, e.g. the generated session key.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE installs (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  platform TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  app_version TEXT,
  os_version TEXT,
  device_model TEXT,
  locale TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  source TEXT,
  channel TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_term TEXT,
  utm_content TEXT,
  ref TEXT,
  click_id TEXT,
  attribution_method TEXT, -- install_referrer | search_ads | deep_link | reported | organic
  asa_campaign_id TEXT,
  asa_adgroup_id TEXT,
  asa_keyword_id TEXT,
  asa_pending_token TEXT,
  asa_pending_until INTEGER,
  user_id TEXT,
  email TEXT,
  name TEXT,
  PRIMARY KEY (app_id, id)
);
CREATE INDEX installs_first_seen ON installs (app_id, first_seen);
CREATE INDEX installs_user_id ON installs (app_id, user_id);
CREATE INDEX installs_last_seen ON installs (app_id, last_seen);

CREATE TABLE sessions (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  install_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  duration INTEGER NOT NULL DEFAULT 0,
  screens INTEGER NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  entry_screen TEXT,
  exit_screen TEXT,
  app_version TEXT,
  os_version TEXT,
  platform TEXT,
  country TEXT,
  region TEXT,
  city TEXT,
  source TEXT, -- from deep link, else 'Direct'
  channel TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  ref TEXT,
  PRIMARY KEY (app_id, id)
);
CREATE INDEX sessions_started_at ON sessions (app_id, started_at);
CREATE INDEX sessions_install_id ON sessions (app_id, install_id);

CREATE TABLE events (
  app_id TEXT NOT NULL,
  id TEXT NOT NULL,
  session_id TEXT,
  install_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  name TEXT,
  props TEXT, -- JSON
  PRIMARY KEY (app_id, id)
);
CREATE INDEX events_ts ON events (app_id, ts);
CREATE INDEX events_session_id ON events (app_id, session_id);

CREATE TABLE links (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  ref TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE link_clicks (
  id TEXT PRIMARY KEY, -- = click_id
  link_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  platform TEXT,
  country TEXT,
  install_id TEXT
);
CREATE INDEX link_clicks_ts ON link_clicks (app_id, ts);
CREATE INDEX link_clicks_link_id ON link_clicks (link_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY, -- RevenueCat event id
  app_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL, -- payment | refund
  amount INTEGER NOT NULL DEFAULT 0, -- USD cents, refunds < 0
  event_type TEXT,
  product_id TEXT,
  store TEXT,
  environment TEXT,
  app_user_id TEXT,
  install_id TEXT,
  session_id TEXT,
  matched_by TEXT,
  renewal INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX payments_ts ON payments (app_id, ts);
CREATE INDEX payments_app_user_id ON payments (app_id, app_user_id);
CREATE INDEX payments_install_id ON payments (app_id, install_id);

-- RevenueCat delivery log: dedup for every RC event type + integration health.
CREATE TABLE rc_events (
  id TEXT PRIMARY KEY, -- RevenueCat event id
  app_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT,
  environment TEXT,
  has_install_attr INTEGER NOT NULL DEFAULT 0,
  install_id TEXT
);
CREATE INDEX rc_events_ts ON rc_events (app_id, ts);

-- Wrong-password attempts for the per-IP lockout. No IP is stored: ip_hash is HMAC-SHA256(session key, IP), hex.
-- Rows older than 15 minutes are purged on the next failure and by the daily cron.
CREATE TABLE login_failures (
  ip_hash TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX login_failures_ip_hash_ts ON login_failures (ip_hash, ts);
