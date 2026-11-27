// Taking payment for an order on the payment platform's own page, so no card number ever reaches
// this store. The kit does the work: `kit/pay` makes sure an order is paid at most once, at the
// amount asked, however many times the buyer comes back or the webhook arrives, and
// `kit/pay/providers` speaks to Stripe, Square, PayPal, Helcim, Authorize.net and Clover behind
// one name (PAY_PROVIDER). This file only fits the kit to the shop's orders: an order's payment is
// the kit's `order/<key>`, kept in the shop's own database (src/infra/kit-store.js).
//
// Until PAY_PROVIDER's settings are all there, the kit's test page stands in: no money moves.

import { createPay, testProvider } from '@potomac-solutions/kit/pay';
import { choosePlatform, PLATFORM_NAMES } from '@potomac-solutions/kit/pay/providers';
import { sqliteStore } from '../infra/kit-store.js';

export { PLATFORM_NAMES };

const ID = 'order/';
const idOf = (key) => `${ID}${key}`;
const keyOf = (id) => (String(id ?? '').startsWith(ID) ? String(id).slice(ID.length) : null);

/** The platform PAY_PROVIDER names, if its settings are all there; otherwise the test page. */
export function choosePayments(env = {}, { fetch: fetcher } = {}) {
  const test = testProvider();
  const chosen = choosePlatform(env, { test, ...(fetcher ? { fetch: fetcher } : {}) });
  return { ...chosen, test, label: PLATFORM_NAMES[chosen.name] ?? chosen.name };
}

/**
 * Payments for orders. `wanted(key)` is the shop's say on whether an order should still be paid;
 * a cancelled one is only asked about, never taken (it matters for PayPal, which takes the money
 * when asked).
 */
export function createPayments({ db, provider, now = Date.now, wanted = () => true }) {
  const store = sqliteStore(db);
  const pay = createPay({ provider, store, now, wanted: (id) => keyOf(id) === null || wanted(keyOf(id)) });

  return {
    /** The payment for an order as the kit keeps it, or null. */
    get: (key) => pay.paid(idOf(key)),

    /** Open the payment page for an order (asked again soon after, the same page). */
    async start({ key, cents, name, email, back, cancel }) {
      const started = await pay.start({ id: idOf(key), cents, description: String(name ?? '').slice(0, 120), email: email ?? '', back, cancel: cancel ?? back });
      if (started.error) return { error: started.error };
      if (!started.url) return { error: 'unsupported-platform' }; // A frame platform (Helcim) needs a page this store doesn't serve yet.
      return { ok: true, url: started.url, ref: started.ref, ...(started.again ? { again: true } : {}) };
    },

    /** Ask the platform whether an order was paid, and record it once. */
    async settle(key) {
      const settled = await pay.settle({ id: idOf(key) });
      if (settled.error) return { error: settled.error === 'not-paid-over' ? 'not-paid' : settled.error, ...(settled.payment ? { paymentId: settled.payment } : {}) };
      return { ok: true, again: Boolean(settled.again), paymentId: settled.payment };
    },

    /** A webhook: which order it is about, settled. `bad-signature` is a request to refuse. */
    async heard(request) {
      const heard = await pay.heard(request);
      if (heard.error === 'bad-signature') return heard;
      if (heard.ignore || !keyOf(heard.id)) return { ignore: true };
      if (heard.error) return { error: heard.error, key: keyOf(heard.id) };
      return { ok: true, again: Boolean(heard.again), paymentId: heard.payment, key: keyOf(heard.id) };
    },

    /** Give a paid order's money back, all of it. */
    async refund(key) {
      const made = await pay.refund({ id: idOf(key) });
      return made.ok ? { ok: true, ref: made.ref } : { error: made.error };
    },
  };
}
