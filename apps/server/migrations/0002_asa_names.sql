-- Display names for Apple Search Ads ids. AdServices reports only campaign, ad group and keyword ids; names come
-- from elsewhere (the demo seed today, an Apple Ads API sync later). Stats fall back to the id when no name is known.
CREATE TABLE asa_names (
  app_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('campaign', 'adgroup', 'keyword')),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, kind, id)
);
