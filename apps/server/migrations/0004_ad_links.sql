-- Ad links (plan: ad-network postbacks, phase 5). The link's in-app target is a full URL (custom scheme or universal
-- link), not just a path, so it is renamed. installs.link_id remembers which tracked link brought the install.
ALTER TABLE links RENAME COLUMN deep_link_path TO deep_link_url;
ALTER TABLE installs ADD COLUMN link_id TEXT;
