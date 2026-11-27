-- Documents the kit keeps (payments first: kit/pay's `payments` and `payments-refs`). One row per
-- document, its fields as JSON. src/infra/kit-store.js is the only thing that reads or writes it.

CREATE TABLE kit_documents (
  collection TEXT NOT NULL,
  key TEXT NOT NULL,
  fields TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (collection, key)
) WITHOUT ROWID;

-- Payments made before the kit kept them, so an order started on Square before this release can
-- still be settled or refunded. Their ids are the kit's: `order/<key>`.
INSERT INTO kit_documents (collection, key, fields)
SELECT 'payments', 'order/' || order_key, json_object(
  'state', CASE state WHEN 'refunded' THEN 'paid' ELSE state END,
  'cents', cents, 'currency', 'usd', 'ref', ref, 'url', url, 'payment', payment_id,
  'provider', provider, 'at', COALESCE(paid_at, created_at), 'attempt', 1,
  'refunded', CASE state WHEN 'refunded' THEN cents ELSE 0 END,
  'refunds', CASE state WHEN 'refunded' THEN 1 ELSE 0 END,
  'tries', json_object(ref, NULL), 'held', NULL, 'frame', NULL, 'reason', ''
)
FROM payments;

INSERT INTO kit_documents (collection, key, fields)
SELECT 'payments-refs', provider || ':' || ref, json_object('id', 'order/' || order_key)
FROM payments;
