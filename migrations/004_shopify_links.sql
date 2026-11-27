-- Each part's product in a Shopify store this store lists into: the product, its variant and the
-- variant's inventory item (stock is set on that), and whether it needs sending again.
CREATE TABLE shopify_links (
  item_id INTEGER PRIMARY KEY REFERENCES items (id),
  product_id TEXT NOT NULL DEFAULT '',
  variant_id TEXT NOT NULL DEFAULT '',
  inventory_item_id TEXT NOT NULL DEFAULT '',
  owned INTEGER NOT NULL DEFAULT 0,          -- 1: created from here, so its title and details are ours to send
  sent_quantity INTEGER,
  needs_push INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  synced_at INTEGER
);
CREATE INDEX shopify_links_variant ON shopify_links (variant_id);
CREATE INDEX shopify_links_inventory ON shopify_links (inventory_item_id);

-- Where an imported part came from, as that platform names it (a Shopify product's handle), so it
-- can be found there again even when its handle here differs (one part per Shopify variant).
ALTER TABLE items ADD COLUMN source_ref TEXT NOT NULL DEFAULT '';
