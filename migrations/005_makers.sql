-- Who makes an item. Empty: the store ships it itself. 'printful' or 'lulu': printed when bought
-- and shipped by that maker (kit/fulfill). `maker_ref` is what the maker knows it by (a Printful
-- sync variant id; for Lulu the book's package id, files and page count as JSON). `cost_cents` is
-- what the maker charges for one, so the dashboard can show what a sale made.

ALTER TABLE items ADD COLUMN maker TEXT NOT NULL DEFAULT '' CHECK (maker IN ('', 'printful', 'lulu'));
ALTER TABLE items ADD COLUMN maker_ref TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN cost_cents INTEGER CHECK (cost_cents IS NULL OR cost_cents >= 0);
