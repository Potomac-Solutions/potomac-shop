-- Sizes and made-to-order items, for stores that aren't one-of-a-kind parts.
--
-- A size (or any option) is an item of its own, with its own stock and price, pointing at the item
-- it is a size of. The storefront lists only items with no parent; a parent with sizes is bought
-- through them. A made-to-order item (printed when bought) has no stock count: it never runs out.
-- The old single-item `orders` table stays for history; new orders are the kit's (kit_documents).

ALTER TABLE items ADD COLUMN parent_id INTEGER REFERENCES items (id);
ALTER TABLE items ADD COLUMN option_label TEXT NOT NULL DEFAULT '';
ALTER TABLE items ADD COLUMN made_to_order INTEGER NOT NULL DEFAULT 0 CHECK (made_to_order IN (0, 1));
CREATE INDEX items_parent ON items (parent_id);
