-- The catalog: lots (a donor car, a haul, a pallet), the items they turn into, import batches that
-- can be undone, and an activity log of every change.

CREATE TABLE lots (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  vin TEXT,
  details TEXT NOT NULL DEFAULT '{}',        -- what the pack knows: year, model, engine, mileage
  cost_cents INTEGER NOT NULL DEFAULT 0,
  source_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  handle TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  compare_at_cents INTEGER,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  condition TEXT NOT NULL DEFAULT 'used' CHECK (condition IN ('new', 'used', 'refurbished')),
  category TEXT NOT NULL DEFAULT '',
  brand TEXT NOT NULL DEFAULT '',
  mpn TEXT NOT NULL DEFAULT '',
  gtin TEXT NOT NULL DEFAULT '',
  weight_grams INTEGER,
  images TEXT NOT NULL DEFAULT '[]',          -- JSON list of image addresses, first is the main one
  fitment TEXT NOT NULL DEFAULT '[]',         -- JSON list of { platform, from, to, models, drive }
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'held', 'sold', 'archived')),
  held_until INTEGER,
  sold_cents INTEGER,
  sold_at INTEGER,
  sold_via TEXT,
  lot_id INTEGER REFERENCES lots (id),
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX items_status ON items (status);
CREATE INDEX items_lot ON items (lot_id);

CREATE TABLE import_batches (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);

-- What each batch changed, so it can be undone: `before` is the item as it was, or NULL when the
-- batch created it.
CREATE TABLE import_changes (
  batch_id INTEGER NOT NULL REFERENCES import_batches (id),
  item_id INTEGER NOT NULL,
  before TEXT,
  PRIMARY KEY (batch_id, item_id)
);

CREATE TABLE activity (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  who TEXT NOT NULL,
  action TEXT NOT NULL,
  item_id INTEGER,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX activity_item ON activity (item_id);
