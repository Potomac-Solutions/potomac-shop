-- People who run the store, orders and their payments, photos kept with the database, and what
-- AI drafting has cost.

CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'helper')),
  hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Only a hash of each session id and link token is kept: a copy of the database signs nobody in.
CREATE TABLE sessions (
  hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts (id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE links (
  hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'invite', 'reset')),
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'helper',
  account_id INTEGER,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- One order buys one part. `key` is the unguessable part of the order's address (/orders/<key>).
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  item_id INTEGER NOT NULL REFERENCES items (id),
  cents INTEGER NOT NULL CHECK (cents > 0),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  delivery TEXT NOT NULL CHECK (delivery IN ('pickup', 'ship')),
  address TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'paid', 'cancelled', 'refunded', 'refund-failed')),
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX orders_item ON orders (item_id);

-- An order's payment on the payment platform: its page, the platform's own order, and once paid,
-- the payment to refund against. Paid once, at the amount asked.
CREATE TABLE payments (
  order_key TEXT PRIMARY KEY REFERENCES orders (key),
  provider TEXT NOT NULL,
  ref TEXT NOT NULL,
  url TEXT NOT NULL,
  cents INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'started' CHECK (state IN ('started', 'paid', 'refunded')),
  payment_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE UNIQUE INDEX payments_ref ON payments (provider, ref);

CREATE TABLE photos (
  id INTEGER PRIMARY KEY,
  item_id INTEGER REFERENCES items (id),
  type TEXT NOT NULL CHECK (type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX photos_item ON photos (item_id);

CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  item_id INTEGER,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  micro_dollars INTEGER NOT NULL
);
