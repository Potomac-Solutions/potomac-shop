// Taking payment on the payment platform's own page, so no card number ever reaches this store.
// The kit does the work: `kit/pay` makes sure a checkout is paid at most once, at the amount asked,
// however many times the buyer comes back or the webhook arrives, and `kit/pay/providers` speaks
// to Stripe, Square, PayPal, Authorize.net and Clover behind one name (PAY_PROVIDER). Until that
// platform's settings are all there, the kit's test page stands in: no money moves.
//
// The kit's payments live in the shop's own database (src/infra/kit-store.js). A checkout's
// payment is `checkout/<key>`; payments from before checkouts (one part at a time) are
// `order/<key>` and can still be refunded.

import { createPay, testProvider } from '@potomac-solutions/kit/pay';
import { choosePlatform, PLATFORM_NAMES } from '@potomac-solutions/kit/pay/providers';

export { PLATFORM_NAMES };

/** The platform PAY_PROVIDER names, if its settings are all there; otherwise the test page. */
export function choosePayments(env = {}, { fetch: fetcher } = {}) {
  const test = testProvider();
  const chosen = choosePlatform(env, { test, ...(fetcher ? { fetch: fetcher } : {}) });
  return { ...chosen, test, label: PLATFORM_NAMES[chosen.name] ?? chosen.name };
}

/**
 * The kit's payments over `store`. `wanted(id)` is the shop's say on whether a payment should
 * still be taken; a let-go checkout is only asked about, never charged (it matters for PayPal,
 * which takes the money when asked).
 */
export function createPayments({ store, provider, now = Date.now, wanted = () => true }) {
  return createPay({ provider, store, now, wanted });
}
