# Changelog

## Unreleased

Payments, the cart and checkout run on the Potomac kit.

- A cart: add parts or sizes, change how many, check out once. Checkout is the kit's (`kit/catalog`, `kit/cart`, `kit/checkout`): every line's stock taken at once, held 30 minutes on the payment page, put back if the buyer backs out or never pays (swept every two minutes). Replaces "Buy it" for one part; old `/parts/<handle>/buy` addresses go to the part.
- Sizes: an item's sizes each have their own price and stock; owners add them on the item's page. Made-to-order items never run out. Listing an item with sizes or made to order doesn't need stock of its own.
- Orders are the kit's (`kit/stages`): paid → packed → sent, moved from the Orders page. The old single-part `orders` table stays for history.
- The kit's `items` are the store's own `items` table (`shopStore`): the kit only ever changes an item's count.

- Checkout uses `kit/pay` and `kit/pay/providers`: Stripe, Square, PayPal, Authorize.net and Clover behind `PAY_PROVIDER`, the kit's test page until that platform is set up. Replaces the store's own Square code.
- The kit's payments live in the store's database (`kit_documents`, migration 003); payments started before this release move over and still settle and refund.
- A cancelled order is only asked about, never charged (matters for PayPal).
- The kit is a dependency, from its private repository at a pinned commit; see "Installing the kit" in the README.

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
