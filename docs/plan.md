# Plan and decisions

The full plan is the "Potomac Shop — Commerce Side App Plan" doc in the Potomac Solutions project. This file keeps the decisions and where each milestone stands.

## Decisions (Nov 27, 2026)

- Name: Potomac Shop.
- Demo: Rix Racing, with Ricky's OK, at rix.potomac.solutions. Real prices and photos; fake orders reset daily.
- Payments: Square payment links for Rix (it also fits the POS story).

## Decisions (Nov 27, 2026, later)

- Potomac Shop runs on the Potomac kit: payments through `kit/pay` first, then stock counts, sizes and a cart through `kit/catalog`, `kit/cart` and `kit/checkout`. Each store picks its platform with `PAY_PROVIDER`.
- The kit is a private git dependency pinned to a commit. The repository stays public.
- Garrett County Adventures is the first general (non-auto) store and M5's real test: stickers, tees, hats and a seasonal guide book, beside garrettcountyadventures.com at shop.garrettcountyadventures.com, paid through Stripe.
- Carmakers' logos stay out; their names are used for fitment only.
- Built like the other demo apps (apex-auto): plain Node 22.13+, built-in SQLite, server-rendered pages that work without script, no dependencies.
- Shipping rules, Rix as a paying client and sales tax are still open.

## Milestones

| Milestone | Gate | Status |
| --- | --- | --- |
| M0 Discovery | Ricky's Shopify export in hand; decisions written down | Decisions written; **export still needed** |
| M1 Core and import | Rix's whole export imports with no lost rows and exports back identically | Built and tested against a fixture of 80 real listings; waiting on the real export |
| M2 Dashboard and storefront | One donor car listed end to end on a phone in one sitting, timed | Built (0.2.0): checkout on Square's page (test page until keys), staff accounts, phone photos, AI drafts. Still to do: deploy the demo, Square sandbox keys, an Anthropic key, and the timed run with Ricky |
| M3 Google and Meta | Feed passes in a test Merchant Center and Commerce Manager | Feeds built; not yet submitted to either |
| M4 POS and eBay | Square sale pulls the part everywhere within a minute (sandbox) | Not started |
| M5 Make it general | A non-auto store imports and sells with the auto pack off | Importers for all four platforms exist. Payments on the kit (any platform). Next: stock counts, sizes and a cart on the kit; side-app mode; Garrett County Adventures' store |
