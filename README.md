# Potomac Shop

A small commerce engine that runs as a whole store or beside an existing site. Its one job: get stock listed, sold everywhere it should be, and taken down the moment it sells.

Shown here as **Rix Racing** (DSM and EVO parts, Morgantown, WV), with Ricky's OK: the demo starts from his real listings in Shopify's export format, so it begins the way a real move off Shopify begins.

## What it does today (0.2.0)

- **Import from another store.** Shopify (classic and newer export columns), WooCommerce, BigCommerce, Magento / Adobe Commerce, and our own CSV. The platform is recognised from the header row. A preview shows every row as new, update or skipped (with the reason) before anything changes. Each import is one batch that can be undone, unless something in it changed since.
- **Sell once.** Draft → listed → on hold → sold, or removed. A sold part leaves the store and the feeds, and no import can bring it back. Holds run out on their own.
- **Fitment from titles.** "2g 95-99 …", "1G 1990 …", "1991-1994 …", "GVR4", "Evo 8/9", "AWD" are read into structured fitment (platform, years, models, drive). The owner can correct it. The store has a shop-by-vehicle picker.
- **Donor cars.** Log a car with what was paid; its parts show what it has paid back.
- **Channels.** `/feeds/google.tsv` (Google Merchant Center: used condition, `identifier_exists` no when there's no maker's part number) and `/feeds/meta.csv` (Meta catalog: unbranded parts carry the store's name). iPhone HEIC photos are left out of both, because browsers, Google and Meta can't show them. Product structured data on every part page. A copy-ready listing for Facebook Marketplace and forums, which don't take listings from store software.
- **Export.** Our CSV (round-trips exactly) and Shopify's product CSV, so leaving is as easy as arriving.
- **Phone-first dashboard.** What's waiting, what's listed, on hold and sold, what needs a photo or fitment, orders to fill, and recent activity.
- **Cart and checkout.** Buyers add parts, or a size of a shirt or hat, to a cart and check out once. Checking out takes the stock for every line at once (two buyers can't both get the last one), holds it for 30 minutes and sends the buyer to the payment platform's own page (Stripe Checkout, a Square payment link, PayPal and the others the kit supports, chosen by `PAY_PROVIDER`; the kit's test page until that platform's settings are set). No card number reaches the store. Paid: a one-of-a-kind part is sold everywhere and the order waits to be packed and sent. Backed out or never paid: the stock goes back. Paid after the hold ran out and the part sold at the counter: the payment is refunded and the order says so. Pickup, or shipping quoted afterwards.
- **Sizes and made to order.** An item can have sizes (S, M, L; 7¼, 7½), each with its own price and stock; the store lists the item and the buyer picks a size. A made-to-order item (printed when bought) has no stock count and never runs out.
- **Staff accounts.** An owner and the people they invite, by one-time links. Owners do everything; helpers photograph and draft parts but can't list, sell, change listed parts, import or see orders. Passwords are scrypt hashes; only hashes of sessions and links are stored; five wrong tries lock that device out of that email for 15 minutes.
- **Photos from the phone.** Taken or chosen on the part's page, kept with the database, served at `/media/…`. HEIC is refused with how to fix it (iPhone converts when choosing from Photos).
- **AI drafts.** "Draft it with AI" sends the part's photos, the donor car and the owner's notes to Claude, and fills in the title (in the shop's own style), details, category and fitment. Drafts only, the price is never touched, and a monthly budget stops it.

Payments run on the Potomac kit (`kit/pay`): it makes sure an order is paid once, at the amount asked, and speaks to each platform. The platforms' code follows their published APIs and is tested against fakes; run a sandbox payment before taking real money.

Not yet: eBay Motors, Square and Clover stock sync, buyer accounts, shipping rates, sizes in imports and exports. See `docs/plan.md`.

WooCommerce, BigCommerce and Magento follow their documented export columns and have tests against sample files, but no real export from each has been through them yet.

## Run it

Needs Node 22.13 or later. One dependency: the Potomac kit (`@potomac-solutions/kit`), installed from its private GitHub repository at a pinned commit, so `npm ci` needs read access to `Potomac-Solutions/potomac-kit` (see "Installing the kit").

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
| `PAY_PROVIDER` | `stripe`, `square`, `paypal`, `authorizenet` or `clover`; unset, or that platform's settings incomplete, means the test payment page. Its webhook goes to `<PUBLIC_URL>/pay/webhook` |
| `PAY_STRIPE_KEY`, `PAY_STRIPE_WEBHOOK_SECRET` | Stripe's secret key (`sk_test_…` is the sandbox) and the webhook's signing secret; subscribe the webhook to `checkout.session.completed` and `checkout.session.async_payment_succeeded` |
| `PAY_SQUARE_TOKEN`, `PAY_SQUARE_LOCATION`, `PAY_SQUARE_WEBHOOK_KEY`, `PAY_SQUARE_WEBHOOK_URL`, `PAY_SQUARE_SANDBOX` | Square's access token, location, webhook signature key and the webhook address; `PAY_SQUARE_SANDBOX=1` for Square's sandbox |
| Other platforms | The kit's `PAY_PAYPAL_*`, `PAY_AUTHORIZENET_*` and `PAY_CLOVER_*` settings (its README, "Paying on a platform's page"). Helcim pays in a frame this store doesn't serve yet |
| `ANTHROPIC_API_KEY` | Turns on AI drafts |
| `AI_MODEL`, `AI_MONTHLY_DOLLARS`, `AI_INPUT_PER_MTOK`, `AI_OUTPUT_PER_MTOK` | The model (`claude-haiku-5-5`), the monthly budget ($10), and its price per million tokens (set these to the model's real price) |
| `DATABASE_PATH` | SQLite file; point it at a volume (`data/potomac-shop.db`) |
| `BUSINESS_NAME`, `BUSINESS_TAGLINE`, `BUSINESS_PLACE` | Shown in the store |
| `CONTACT_EMAIL`, `CONTACT_FACEBOOK` | Where "Ask about this part" goes |
| `DEMO=1` | Shows the demo bar and sign-in; set by `npm run demo` |

Production refuses to start without `SESSION_SECRET` and an https `PUBLIC_URL`. Staff cookies are `__Host-` cookies in production, so the store must be served over https.

## Installing the kit

`package.json` names the kit as `github:Potomac-Solutions/potomac-kit#<commit>`. To move to a newer kit, change the commit there and run `npm install`, then `npm test`.

Anywhere without your GitHub sign-in (Railway, CI) needs a read-only token. Make a fine-grained GitHub token with **Contents: read** on `Potomac-Solutions/potomac-kit` only, and give git the token through these variables (Railway's build sees service variables):

| Variable | Value |
| --- | --- |
| `GIT_CONFIG_COUNT` | `2` |
| `GIT_CONFIG_KEY_0` | `url.https://x-access-token:<token>@github.com/.insteadOf` |
| `GIT_CONFIG_VALUE_0` | `ssh://git@github.com/` |
| `GIT_CONFIG_KEY_1` | `url.https://x-access-token:<token>@github.com/.insteadOf` |
| `GIT_CONFIG_VALUE_1` | `https://github.com/` |

The lockfile records the kit as an ssh address; the first pair turns that into https with the token.

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
