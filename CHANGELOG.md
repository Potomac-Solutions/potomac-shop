# Changelog

## 0.2.0 (Nov 27, 2026)

Checkout, staff accounts, photos from the phone, AI drafts.

- Buy it: the part is held for 30 minutes while the buyer pays on the payment platform's page (Square payment links; a test page until Square's settings are set). Paid is sold everywhere; a part that sold at the counter mid-payment is refunded. Pickup or shipping quoted afterwards. Webhook at `/pay/webhook`.
- Orders page for the owner, and paid orders on Today.
- Staff accounts: invite links, owner and helper roles, scrypt passwords, sessions, new-password links, turning people off. Replaces the single owner password (`OWNER_PASSWORD` is gone).
- Photos taken or chosen on a part's page, stored in the database, served at `/media/`; HEIC refused with how to fix it. Stored photos go into the Google and Meta feeds with the store's address.
- Draft it with AI: Claude writes the title, details, category and fitment from the photos and donor car, within a monthly budget.
- The demo has owner and helper sign-ins (shown on the sign-in page, locked against changes) and a paid order.

## 0.1.0 (Nov 27, 2026)

First slice: import, sell once, fitment, feeds, the store and the owner's dashboard.

- Import from Shopify, WooCommerce, BigCommerce, Magento and our own CSV, with a preview and batch undo.
- Items move draft → listed → on hold → sold or removed; a sold part never comes back from a file.
- Fitment read from DSM-style titles; shop-by-vehicle in the store.
- Donor cars and what they've paid back.
- Google Merchant Center and Meta catalog feeds; product structured data; copy-ready Marketplace listing.
- Exports as our CSV and as Shopify's product CSV.
- Public demo seeded with 80 of Rix Racing's real listings, reset nightly.
