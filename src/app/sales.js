// Selling: a cart, a checkout on the payment platform's own page, and the orders that come out of
// it. The kit does the selling (kit/catalog, kit/cart, kit/checkout, kit/stages, kit/pay); this file
// fits it to the shop: who the buyer is, what they typed, and what "sold" means here.
//
// Checking out takes the stock for every line at once, so two buyers can't both get the last one,
// and holds it for 30 minutes while the buyer pays. Paid: the orders start and a one-of-a-kind
// part is marked sold everywhere. Backed out or never paid: the stock goes back. Paid after the
// stock went back (the buyer sat on the payment page and the part sold at the counter): the
// payment is refunded and the checkout says so.

import { randomBytes } from 'node:crypto';
import { createCatalog as kitCatalog } from '@potomac-solutions/kit/catalog';
import { createCart } from '@potomac-solutions/kit/cart';
import { createCheckout } from '@potomac-solutions/kit/checkout';
import { createStages } from '@potomac-solutions/kit/stages';

export const HOLD_MINUTES = 30;
export const ORDER_STEPS = ['paid', 'packed', 'sent'];
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const KEY = /^[A-Za-z0-9_-]{24}$/;

/** A new checkout key, for the hidden field on the checkout form. */
export const newCheckoutKey = () => randomBytes(18).toString('base64url');
export const isCheckoutKey = (key) => KEY.test(String(key ?? ''));

/** What a buyer typed, checked. Answers { ok, buyer } or { error }. */
export function checkBuyer(form) {
  const name = String(form.name ?? '').trim().slice(0, 100);
  const email = String(form.email ?? '').trim().toLowerCase().slice(0, 200);
  const phone = String(form.phone ?? '').trim().slice(0, 40);
  const delivery = form.delivery === 'ship' ? 'ship' : 'pickup';
  const address = String(form.address ?? '').trim().slice(0, 500);
  if (!name) return { error: 'no-name' };
  if (!EMAIL.test(email)) return { error: 'bad-email' };
  if (delivery === 'ship' && address.length < 10) return { error: 'no-address' };
  return { ok: true, buyer: { name, email, phone, delivery, address: delivery === 'ship' ? address : '' } };
}

export function createSales({ store, catalog, pay, site, now = Date.now, log = () => {} }) {
  const kit = kitCatalog({ store });
  const cart = createCart({ store, catalog: kit, max: 20 });
  // Orders move paid → packed → sent; a refund is a side step. The owner moves them (`may`).
  const stages = createStages({ store, collection: 'orders', steps: ORDER_STEPS, from: { refunded: ['paid', 'packed'] }, may: () => true, now });
  const checkout = createCheckout({ store, catalog: kit, cart, pay, stages, payingMs: HOLD_MINUTES * 60_000, now });

  /** The shop's side of a paid checkout: one-of-a-kind parts sold everywhere, every line logged. */
  function recordSale(key) {
    const doc = checkout.get(key);
    for (const line of doc?.lines ?? []) {
      const item = catalog.get(line.item);
      if (!item) continue;
      catalog.act(item.id, 'soldOnline', { cents: line.total }, { who: `buyer ${doc.fields?.email ?? ''}`.trim() });
    }
  }

  /** After the platform answered: the sale recorded once, or a late payment given back. */
  async function settled(key, result) {
    if (result.ok && !result.again) recordSale(key);
    if (result.error === 'paid-after-cancel') {
      const refund = await pay.refund({ id: `checkout/${key}` });
      await store.write('checkouts', key, { refund: refund.ok ? 'refunded' : 'refund-failed', refundError: refund.ok ? '' : String(refund.error ?? '') });
      log(`Checkout ${key}: paid after its stock went back; ${refund.ok ? 'refunded' : `refund needed by hand (${refund.error})`}.`);
    }
    return result;
  }

  /** A line as a page shows it, with the item's handle, photo and size. */
  function dressed(line) {
    const item = catalog.get(line.item);
    const parent = item?.parentId ? catalog.get(item.parentId) : null;
    return { ...line, title: item?.title ?? line.name ?? line.item, option: item?.option ?? '', handle: parent?.handle ?? item?.handle ?? '', images: (parent ?? item)?.images ?? [] };
  }

  /** A checkout as the buyer's page and the dashboard show it. */
  function view(key) {
    const doc = checkout.get(key);
    if (!doc) return null;
    const order = doc.orders?.[0] ? store.get('orders', doc.orders[0]) : null;
    const state = doc.state === 'paid' ? (order?.status === 'refunded' ? 'refunded' : 'paid') : doc.refund ?? (doc.state === 'failed' ? 'cancelled' : doc.state === 'paying' && now() - doc.at > HOLD_MINUTES * 60_000 ? 'abandoned' : doc.state);
    return { key, state, step: order?.status ?? null, owner: doc.owner, lines: (doc.lines ?? []).map(dressed), cents: doc.cents, ...(doc.fields ?? {}), createdAt: doc.at, paidAt: order?.paid ?? null, note: doc.refundError ? `Refund needed by hand: ${doc.refundError}` : '' };
  }

  return {
    /** The buyer's cart, each line with its item's handle and photo. */
    cart(owner) {
      const shown = cart.view(owner);
      return { ...shown, lines: shown.lines.map(dressed) };
    },
    add: (owner, handle, qty = 1) => cart.add(owner, String(handle), qty),
    set: (owner, handle, qty) => cart.set(owner, String(handle), qty),

    /** Check out the cart: the stock is taken, then off to the payment page. */
    async start(owner, form, { key }) {
      if (!owner) return { error: 'empty' };
      if (!isCheckoutKey(key)) return { error: 'no-key' };
      const checked = checkBuyer(form);
      if (checked.error) return checked;
      const lines = cart.view(owner).lines;
      const description = lines.length === 1 ? `${lines[0].name}${lines[0].qty > 1 ? ` × ${lines[0].qty}` : ''}` : `${lines.length} items`;
      const placed = await checkout.place(owner, {
        key,
        fields: checked.buyer,
        contact: checked.buyer.email,
        description: description.slice(0, 120),
        back: `${site}/checkout/back`,
        cancel: `${site}/checkout/cancel`,
      });
      if (placed.error === 'not-ready' || placed.error === 'sold-out' || placed.error === 'gone') return { error: 'gone', lines: placed.lines };
      if (placed.error === 'empty' || placed.error === 'not-yours') return { error: placed.error };
      if (placed.error) {
        log(`Checkout ${key}: payment page refused (${placed.error}).`);
        return { error: placed.error === 'in-progress' ? 'in-progress' : 'pay-unavailable' };
      }
      if (placed.paid || placed.again) return { ok: true, key, paid: true };
      if (!placed.pay?.url) return { error: 'pay-unavailable' };
      return { ok: true, key, url: placed.pay.url };
    },

    /** Back from the payment page: ask the platform, and record the sale once it's paid. */
    async back(key) {
      if (!isCheckoutKey(key) || !checkout.get(key)) return { error: 'no-checkout' };
      const result = await checkout.finish(key);
      await settled(key, result);
      return { ok: true, checkout: view(key), waiting: result.error === 'not-paid' };
    },

    /** The platform's webhook. `{ error: 'bad-signature' }` is a request to refuse. */
    async heard(request) {
      const result = await checkout.heard(request);
      if (result.error === 'bad-signature') return result;
      if (result.key) await settled(result.key, result);
      return { ok: true };
    },

    /** The buyer backed out: the stock goes back, unless the platform says it was paid meanwhile. */
    async cancel(owner, key) {
      const doc = isCheckoutKey(key) ? checkout.get(key) : null;
      if (!doc) return { error: 'no-checkout' };
      if (doc.owner !== owner) return { error: 'not-yours' };
      const result = await checkout.cancel(owner, key);
      if (result.ok && result.orders && !result.again) recordSale(key);
      return { ok: true, checkout: view(key) };
    },

    /** Checkouts left on the payment page past the hold: stock back, or the sale if it was paid. */
    async sweep() {
      const done = await checkout.sweep();
      for (const one of done) if (one.ok && one.orders && !one.again) recordSale(one.key);
      return done;
    },

    /** For the kit's payments: may the platform still take money for this id? */
    wanted: (id) => checkout.wanted(id),

    get: view,

    /** Move an order along: packed, sent. Owners only (the web layer checks). */
    advance: (key, to) => stages.advance(key, to, {}),

    /** Checkouts for the dashboard, newest first. Paying and not-paid ones included, so nothing is hidden. */
    list({ limit = 100 } = {}) {
      return store.under('checkouts').sort((a, b) => b.at - a.at).slice(0, limit).map((doc) => view(doc.key));
    },
  };
}
