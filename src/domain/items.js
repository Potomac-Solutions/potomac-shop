// What can happen to an item, as pure rules. Each returns { ok: true, patch } (the fields to change)
// or { error: code }. The application layer saves the patch; the words for each code are the page's.
//
//   draft ──publish──▶ active ──hold──▶ held
//     ▲                  │  ▲            │
//     └──unpublish───────┘  └──release───┘
//   active/held ──sell──▶ sold (or stays active while stock is left)
//   anything but sold ──archive──▶ archived ──restore──▶ draft

export const STATUSES = Object.freeze(['draft', 'active', 'held', 'sold', 'archived']);

const ok = (patch) => ({ ok: true, patch });

export function publish(item) {
  if (item.status !== 'draft') return { error: 'not-draft' };
  // Made to order, or bought through its sizes: no stock count of its own to check.
  if (!item.madeToOrder && !item.sizes?.length && item.quantity < 1) return { error: 'no-stock' };
  if (item.priceCents == null || item.priceCents <= 0) return { error: 'no-price' };
  return ok({ status: 'active' });
}

export function unpublish(item) {
  if (item.status !== 'active') return { error: 'not-active' };
  return ok({ status: 'draft' });
}

/** Keep an item for one buyer until `until` (a time in ms). Nobody else can buy it meanwhile. */
export function hold(item, { until, now }) {
  if (item.status !== 'active') return { error: 'not-active' };
  if (!(until > now)) return { error: 'bad-time' };
  return ok({ status: 'held', heldUntil: until });
}

export function release(item) {
  if (item.status !== 'held') return { error: 'not-held' };
  return ok({ status: 'active', heldUntil: null });
}

/** A hold that has run out is treated as released. */
export const lapsed = (item, now) => item.status === 'held' && item.heldUntil != null && item.heldUntil <= now;

/**
 * Sell `quantity` of an item through `via` (the site, the counter, eBay...). The last one sold
 * marks it sold everywhere; while stock is left it stays listed.
 */
export function sell(item, { quantity = 1, cents = item.priceCents, via = 'site', now }) {
  if (item.status !== 'active' && item.status !== 'held') return { error: item.status === 'sold' ? 'already-sold' : 'not-for-sale' };
  if (!Number.isInteger(quantity) || quantity < 1) return { error: 'bad-quantity' };
  if (quantity > item.quantity) return { error: 'not-enough' };
  const left = item.quantity - quantity;
  if (left > 0) return ok({ quantity: left, status: 'active', heldUntil: null });
  return ok({ quantity: 0, status: 'sold', heldUntil: null, soldCents: cents * quantity, soldAt: now, soldVia: via });
}

/**
 * The last one sold online: checkout already took the stock (the count is 0), so this only marks
 * it sold everywhere. An item with stock left, a size or a made-to-order item stays listed.
 */
export function soldOnline(item, { cents = item.priceCents, now }) {
  if (item.status !== 'active') return { error: 'not-for-sale' };
  if (item.parentId || item.madeToOrder || item.quantity > 0) return { error: 'still-listed' };
  return ok({ status: 'sold', heldUntil: null, soldCents: cents, soldAt: now, soldVia: 'site' });
}

export function archive(item) {
  if (item.status === 'archived') return { error: 'already-archived' };
  return ok({ status: 'archived', heldUntil: null });
}

export function restore(item) {
  if (item.status !== 'archived') return { error: 'not-archived' };
  return ok({ status: 'draft' });
}

/** What a lot (a donor car) has paid back: its cost against what its parts sold for. */
export function payoff(lot, items) {
  const sold = items.filter((item) => item.status === 'sold');
  const soldCents = sold.reduce((sum, item) => sum + (item.soldCents ?? 0), 0);
  const listedCents = items.filter((item) => item.status === 'active' || item.status === 'held').reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
  return { costCents: lot.costCents, soldCents, listedCents, net: soldCents - lot.costCents, soldCount: sold.length, count: items.length };
}
