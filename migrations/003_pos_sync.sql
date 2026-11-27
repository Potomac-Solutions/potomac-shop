-- Each part's twin in the point of sale (Square): its item and variation there, the versions Square
-- last gave us (an update must name them), and whether it needs sending again.
CREATE TABLE pos_links (
  item_id INTEGER PRIMARY KEY REFERENCES items (id),
  provider TEXT NOT NULL DEFAULT 'square',
  object_id TEXT NOT NULL DEFAULT '',
  object_version INTEGER,
  variation_id TEXT NOT NULL DEFAULT '',
  variation_version INTEGER,
  sent_quantity INTEGER,
  needs_push INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  synced_at INTEGER
);
CREATE INDEX pos_links_variation ON pos_links (variation_id);
CREATE INDEX pos_links_dirty ON pos_links (needs_push);
