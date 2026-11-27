# Potomac Shop

A small commerce engine that runs as a whole store or beside an existing site. Its one job: get stock listed, sold everywhere it should be, and taken down the moment it sells.

Shown here as **Rix Racing** (DSM and EVO parts, Morgantown, WV), with Ricky's OK: the demo starts from his real listings in Shopify's export format, so it begins the way a real move off Shopify begins.

## What it does today (0.1.0)

- **Import from another store.** Shopify (classic and newer export columns), WooCommerce, BigCommerce, Magento / Adobe Commerce, and our own CSV. The platform is recognised from the header row. A preview shows every row as new, update or skipped (with the reason) before anything changes. Each import is one batch that can be undone, unless something in it changed since.
- **Sell once.** Draft → listed → on hold → sold, or removed. A sold part leaves the store and the feeds, and no import can bring it back. Holds run out on their own.
- **Fitment from titles.** "2g 95-99 …", "1G 1990 …", "1991-1994 …", "GVR4", "Evo 8/9", "AWD" are read into structured fitment (platform, years, models, drive). The owner can correct it. The store has a shop-by-vehicle picker.
- **Donor cars.** Log a car with what was paid; its parts show what it has paid back.
- **Channels.** `/feeds/google.tsv` (Google Merchant Center: used condition, `identifier_exists` no when there's no maker's part number) and `/feeds/meta.csv` (Meta catalog: unbranded parts carry the store's name). iPhone HEIC photos are left out of both, because browsers, Google and Meta can't show them. Product structured data on every part page. A copy-ready listing for Facebook Marketplace and forums, which don't take listings from store software.
- **Export.** Our CSV (round-trips exactly) and Shopify's product CSV, so leaving is as easy as arriving.
- **Phone-first dashboard.** What's waiting, what's listed, on hold and sold, what needs a photo or fitment, and recent activity.

Not yet: checkout (Square through the kit's `pay`), staff accounts (the kit's `staff`), photos uploaded from the phone, AI-drafted descriptions, eBay Motors, and Square and Clover stock sync. See `docs/plan.md`.

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

The dashboard is at `/admin`. In the demo the password is shown on the sign-in page (`rix-owner-demo`).

## Configuration

| Variable | What it is |
| --- | --- |
| `PUBLIC_URL` | The store's address (https in production); the feeds link to it |
| `OWNER_PASSWORD` | The owner's sign-in until staff accounts come from the kit (12+ characters in production) |
| `SESSION_SECRET` | Signs the sign-in cookie and messages (32+ characters in production) |
| `DATABASE_PATH` | SQLite file; point it at a volume (`data/potomac-shop.db`) |
| `BUSINESS_NAME`, `BUSINESS_TAGLINE`, `BUSINESS_PLACE` | Shown in the store |
| `CONTACT_EMAIL`, `CONTACT_FACEBOOK` | Where "Ask about this part" goes |
| `DEMO=1` | Shows the demo bar and sign-in; set by `npm run demo` |

Production refuses to start without `SESSION_SECRET`, `OWNER_PASSWORD` and an https `PUBLIC_URL`.

## The public demo on Railway

`railway.json` starts `npm run demo` with the "always" restart policy. The demo exits once a day at 4 am Eastern and comes back with fresh data. It needs no volume. Set `PUBLIC_URL` (rix.potomac.solutions) and `NODE_ENV=production`; the demo sets its own owner password.

## Layout

```
src/domain   pure rules: CSV, other platforms' exports, fitment, item states, feeds
src/app      the catalog service: SQL plus the rules, one transaction per change, activity log
src/infra    SQLite and migrations
src/web      HTTP: the store and the dashboard, server-rendered, working without script
public/      styles and the dashboard's small script
fixtures/    rix-racing-shopify.csv, 80 of Rix's real listings in Shopify's export format
```

The fixture was built from Rix Racing's public storefront (titles, prices, photo addresses). Categories in it were filled in by keyword for the demo. The real import will come from Ricky's own Shopify export.
