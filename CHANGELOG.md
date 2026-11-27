# Changelog

## 0.4.0 (Nov 27, 2026)

A listing tool for a Shopify store, for a business that keeps Shopify as the store buyers see.

- Parts listed here become Shopify products with `productSet`: photos (once, when made), details, price, status, and SKU and stock tracking on the variant's inventory item. Changes are sent every 20 seconds, or at once from Channels.
- Products already in Shopify are found by their Shopify handle (kept at import, so one part per Shopify variant still finds its product) and only get price and stock; `productSet` is never used on them, since it replaces a product's whole variant list.
- An order paid on Shopify (`orders/paid`, signed with the app's secret) marks the part sold here, and so at the counter; a check of Shopify's stock every 5 minutes catches missed webhooks. Sold, held, unlisted or removed here is zero on Shopify.
- Connects with a Dev Dashboard app's client ID and secret (24-hour tokens, fetched again before they run out) or an admin-made app's token.
- `STOREFRONT_URL` sends buyers from the pages here to the Shopify store.
- Fixed: two parts saved in the same millisecond got the same made-up SKU.

## 0.3.0 (Nov 27, 2026)

Two-way stock with Square's point of sale (`POS_SYNC=square`).

- Listed parts are created in Square's item library, one item with one variation per part, by SKU and price, with stock tracking on. Changed parts are sent again every 15 seconds; a button on Channels sends at once.
- A sale at the counter (Square's `inventory.count.updated` webhook, or a check of Square's counts every 5 minutes) marks the part sold here, so it leaves the store and the feeds. A part sold, held, unlisted or removed here counts as zero at the counter. A restock there raises a listed part's quantity.
- An item edited in Square's dashboard is sent again with Square's current version; titles and prices set here win.
- Channels shows what's in Square, what's waiting and Square's last refusal.

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
