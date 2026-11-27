# Potomac Shop

A small commerce engine that runs as a whole store or beside an existing site. Its one job: get stock listed, sold everywhere it should be, and taken down the moment it sells.

Shown here as **Rix Racing** (DSM and EVO parts, Morgantown, WV), with Ricky's OK: the demo starts from his real listings in Shopify's export format, so it begins the way a real move off Shopify begins.

## Two ways to use it

- **The whole store.** Potomac Shop is the store buyers see: pages, checkout, feeds.
- **A listing tool for a Shopify store.** The Shopify store stays the store buyers see, and Potomac Shop is where parts are photographed, drafted and priced. Listed parts are published into Shopify; a sale on Shopify, at the counter or here takes the part down everywhere. Set `STOREFRONT_URL` to the Shopify store and the pages here send buyers there.

## What it does today (0.4.0)

- **Import from another store.** Shopify (classic and newer export columns), WooCommerce, BigCommerce, Magento / Adobe Commerce, and our own CSV. The platform is recognised from the header row. A preview shows every row as new, update or skipped (with the reason) before anything changes. Each import is one batch that can be undone, unless something in it changed since.
- **Sell once.** Draft → listed → on hold → sold, or removed. A sold part leaves the store and the feeds, and no import can bring it back. Holds run out on their own.
- **Fitment from titles.** "2g 95-99 …", "1G 1990 …", "1991-1994 …", "GVR4", "Evo 8/9", "AWD" are read into structured fitment (platform, years, models, drive). The owner can correct it. The store has a shop-by-vehicle picker.
- **Donor cars.** Log a car with what was paid; its parts show what it has paid back.
- **Channels.** `/feeds/google.tsv` (Google Merchant Center: used condition, `identifier_exists` no when there's no maker's part number) and `/feeds/meta.csv` (Meta catalog: unbranded parts carry the store's name). iPhone HEIC photos are left out of both, because browsers, Google and Meta can't show them. Product structured data on every part page. A copy-ready listing for Facebook Marketplace and forums, which don't take listings from store software.
- **Export.** Our CSV (round-trips exactly) and Shopify's product CSV, so leaving is as easy as arriving.
- **Phone-first dashboard.** What's waiting, what's listed, on hold and sold, what needs a photo or fitment, orders to fill, and recent activity.
- **Checkout.** "Buy it" holds the part for 30 minutes and sends the buyer to the payment platform's own page (a Square payment link; a test page of our own until Square's settings are set). No card number reaches the store. Paid means sold everywhere. If the part sold at the counter while the buyer paid, the payment is refunded and the order says so. Pickup, or shipping quoted afterwards.
- **Staff accounts.** An owner and the people they invite, by one-time links. Owners do everything; helpers photograph and draft parts but can't list, sell, change listed parts, import or see orders. Passwords are scrypt hashes; only hashes of sessions and links are stored; five wrong tries lock that device out of that email for 15 minutes.
- **Photos from the phone.** Taken or chosen on the part's page, kept with the database, served at `/media/…`. HEIC is refused with how to fix it (iPhone converts when choosing from Photos).
- **AI drafts.** "Draft it with AI" sends the part's photos, the donor car and the owner's notes to Claude, and fills in the title (in the shop's own style), details, category and fitment. Drafts only, the price is never touched, and a monthly budget stops it.

- **The counter (Square point of sale).** With `POS_SYNC=square`, listed parts are created in Square's item library (one item per part, rung up by SKU) with their stock. A sale at the counter marks the part sold here, out of the store and the feeds, within seconds by Square's webhook or within 5 minutes by a check of Square's counts. A sale, hold or unlisting here sets the counter's stock to zero. A restock at the counter raises the quantity of a listed part. Titles and prices are set here and overwrite edits made in Square.

- **Shopify.** With `SHOPIFY_STORE` and an app's credentials, parts listed here become Shopify products (photos, details, price, SKU, stock). Products already in Shopify (imported from its CSV) are matched by their Shopify handle and only get price and stock from here, so nothing made in Shopify is rewritten or duplicated. An order paid on Shopify (its `orders/paid` webhook, or a check of Shopify's stock every 5 minutes) marks the part sold here and at the counter.

Shopify's code was written from Shopify's GraphQL Admin API reference and tested against a faked Shopify; try it on a development store first. Square's code (payments and the counter) follows Square's API reference and is tested against a faked Square; run a sandbox payment, refund and counter sale before using it for real.

Not yet: eBay Motors, Clover, buyer accounts, shipping rates. See `docs/plan.md`.

WooCommerce, BigCommerce and Magento follow their documented export columns and have tests against sample files, but no real export from each has been through them yet.

## Run it

Needs Node 22.13 or later. No dependencies.

```sh
npm test
npm run demo                 # wipes data/demo.db, imports the Rix fixture, starts on :3000
npm start                    # a real store: data/potomac-shop.db
npm run import -- products_export.csv            # preview an export
npm run import -- products_export.csv --commit   # import it
```

The dashboard is at `/admin`. A new store prints a one-time link for the first owner in the server log; the owner invites everyone else from **People**. In the demo the sign-ins are on the sign-in page (owner `ricky@rix.example` / `rix-owner-demo`, helper `helper@rix.example` / `rix-helper-demo`).

## Configuration

| Variable | What it is |
| --- | --- |
| `PUBLIC_URL` | The store's address (https in production); the feeds link to it |
| `SESSION_SECRET` | Signs form tokens and messages (32+ characters in production) |
| `TRUSTED_PROXIES` | How many proxies add to X-Forwarded-For (1 on Railway, the default in production) |
| `PAY_PROVIDER` | `square`; unset, or Square's settings incomplete, means the test payment page |
| `PAY_SQUARE_TOKEN`, `PAY_SQUARE_LOCATION`, `PAY_SQUARE_WEBHOOK_KEY`, `PAY_SQUARE_WEBHOOK_URL`, `PAY_SQUARE_SANDBOX` | Square's access token, location, webhook signature key and the webhook address (`<PUBLIC_URL>/pay/webhook`); `PAY_SQUARE_SANDBOX=1` for Square's sandbox |
| `POS_SYNC` | `square` keeps stock in step with Square's point of sale, on the same Square settings. The access token needs item and inventory read and write permissions; subscribe the webhook to `payment.updated` and `inventory.count.updated` |
| `SHOPIFY_STORE` | The Shopify store's `*.myshopify.com` address, to list into |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | A Shopify Dev Dashboard app in the store's own organization, with product and inventory read and write permissions. The store gets its own 24-hour access tokens with them. (Or `SHOPIFY_ACCESS_TOKEN` from an app made in the Shopify admin before 2026.) |
| `SHOPIFY_LOCATION_ID`, `SHOPIFY_API_VERSION`, `SHOPIFY_WEBHOOK_SECRET` | The location stock is kept at (default: the store's first), the API version (`2026-10`), and the webhook secret (default: the client secret). Point Shopify's *Order payment* webhook at `<PUBLIC_URL>/shopify/webhook` |
| `STOREFRONT_URL` | Listing-tool mode: the store buyers see (the Shopify store). The pages here redirect there, by product handle |
| `ANTHROPIC_API_KEY` | Turns on AI drafts |
| `AI_MODEL`, `AI_MONTHLY_DOLLARS`, `AI_INPUT_PER_MTOK`, `AI_OUTPUT_PER_MTOK` | The model (`claude-haiku-5-5`), the monthly budget ($10), and its price per million tokens (set these to the model's real price) |
| `DATABASE_PATH` | SQLite file; point it at a volume (`data/potomac-shop.db`) |
| `BUSINESS_NAME`, `BUSINESS_TAGLINE`, `BUSINESS_PLACE` | Shown in the store |
| `CONTACT_EMAIL`, `CONTACT_FACEBOOK` | Where "Ask about this part" goes |
| `DEMO=1` | Shows the demo bar and sign-in; set by `npm run demo` |

Production refuses to start without `SESSION_SECRET` and an https `PUBLIC_URL`. Staff cookies are `__Host-` cookies in production, so the store must be served over https.

## The public demo on Railway

`railway.json` starts `npm run demo` with the "always" restart policy. The demo exits once a day at 4 am Eastern and comes back with fresh data. It needs no volume. Set `PUBLIC_URL` (https://rix.potomac.solutions) and `NODE_ENV=production`; the demo makes its own sign-ins and secret. It seeds one paid order through the test payment page.

## Layout

```
src/domain   pure rules: CSV, other platforms' exports, fitment, item states, feeds
src/app      catalog, orders, photos, AI drafts: SQL plus the rules, one transaction per change, activity log
src/infra    SQLite and migrations
src/web      HTTP: the store and the dashboard, server-rendered, working without script
public/      styles and the dashboard's small script
fixtures/    rix-racing-shopify.csv, 80 of Rix's real listings in Shopify's export format
```

The fixture was built from Rix Racing's public storefront (titles, prices, photo addresses). Categories in it were filled in by keyword for the demo. The real import will come from Ricky's own Shopify export.
