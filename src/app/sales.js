// Selling: a cart, a checkout on the payment platform's own page, and the orders that come out of
// it. The kit does the selling (kit/catalog, kit/cart, kit/checkout, kit/stages, kit/pay,
// kit/fulfill); this file fits it to the shop: who the buyer is, what they typed, who makes what,
// and what "sold" means here.
//
// Checking out takes the stock for every line at once, so two buyers can't both get the last one,
// and holds it for 30 minutes while the buyer pays. Paid: one order per maker starts (the store's
// own, Printful's, Lulu's) and a one-of-a-kind part is marked sold everywhere. Backed out or never
// paid: the stock goes back. Paid after the stock went back (the buyer sat on the payment page
// and the part sold at the counter): the payment is refunded and the checkout says so.
//
// A maker's order waits for the owner's OK before it goes to be made (or goes at once with
// `autoMake`). Its shipping is the maker's own price for the buyer's address, quoted before the
// buyer pays, and its tracking comes back from the maker.

import { randomBytes } from 'node:crypto';
import { createCatalog as kitCatalog } from '@potomac-solutions/kit/catalog';
import { createCart } from '@potomac-solutions/kit/cart';
import { createCheckout } from '@potomac-solutions/kit/checkout';
import { createStages } from '@potomac-solutions/kit/stages';

export const HOLD_MINUTES = 30;
export const ORDER_STEPS = ['paid', 'packed', 'sent'];
export const MAKER_LABELS = { printful: 'Printful', lulu: 'Lulu' };
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const KEY = /^[A-Za-z0-9_-]{24}$/;
const STATES = new Set(['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'PR']);

/** A new checkout key, for the hidden field on the checkout form. */
export const newCheckoutKey = () => randomBytes(18).toString('base64url');
export const isCheckoutKey = (key) => KEY.test(String(key ?? ''));

/**
 * What a buyer typed, checked. Shipping needs a US street address; `needsPhone` when a maker
 * ships it (Lulu won't ship without one). Answers { ok, buyer } or { error }.
 */
export function checkBuyer(form, { needsPhone = false } = {}) {
  const text = (name, max) => String(form[name] ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  const name = text('name', 100);
  const email = String(form.email ?? '').trim().toLowerCase().slice(0, 200);
  const phone = text('phone', 40);
  const delivery = form.delivery === 'ship' ? 'ship' : 'pickup';
  if (!name) return { error: 'no-name' };
  if (!EMAIL.test(email)) return { error: 'bad-email' };
  if (delivery === 'pickup') return { ok: true, buyer: { name, email, phone, delivery, address: '' } };
  const street1 = text('street1', 200);
  const street2 = text('street2', 200);
  const city = text('city', 100);
  const state = text('state', 2).toUpperCase();
  const zip = text('zip', 10);
  if (!street1 || !city) return { error: 'no-address' };
  if (!STATES.has(state)) return { error: 'bad-state' };
  if (!/^\d{5}(-\d{4})?$/.test(zip)) return { error: 'bad-zip' };
  if (needsPhone && phone.replace(/\D/g, '').length < 10) return { error: 'no-phone' };
  const address = `${street1}${street2 ? `, ${street2}` : ''}, ${city}, ${state} ${zip}`;
  return { ok: true, buyer: { name, email, phone, delivery, street1, street2, city, state, zip, address } };
}

/** The buyer as a maker's shipping address. */
const toAddress = (buyer) => ({ name: buyer.name, street1: buyer.street1, street2: buyer.street2 ?? '', city: buyer.city, state: buyer.state, postcode: buyer.zip, country: 'US', phone: buyer.phone ?? '', email: buyer.email });

export function createSales({ store, catalog, pay, fulfill = null, makers = [], site, autoMake = false, now = Date.now, log = () => {} }) {
  const kit = kitCatalog({ store });
  const cart = createCart({ store, catalog: kit, max: 20 });
  // Orders move paid → packed → sent (a maker's: paid → at the maker → shipped). A refund is a side step.
  const stages = createStages({ store, collection: 'orders', steps: ORDER_STEPS, from: { refunded: ['paid', 'packed'] }, may: () => true, now });
  const makerOf = (handle) => catalog.get(handle)?.maker ?? '';
  // Which makers are set up here (their settings are all there).
  const canMake = (maker) => Boolean(fulfill) && makers.includes(maker);
  const checkout = createCheckout({
    store,
    catalog: kit,
    cart,
    pay,
    stages,
    payingMs: HOLD_MINUTES * 60_000,
    now,
    // One order per maker: what the store ships itself, and what each maker prints and ships.
    group: (line) => makerOf(line.item),
    // A maker's shipping, quoted for the buyer's address before checkout (`shippingFor`).
    fees: ({ fields }) => (fields.shipping ?? []).map(({ group, label, cents }) => ({ label: `Shipping from ${MAKER_LABELS[group] ?? group}: ${label}`, cents, group })),
  });

  /** The shop's side of a paid checkout: one-of-a-kind parts sold everywhere; makers' orders waiting or sent. */
  async function recordSale(key) {
    const doc = checkout.get(key);
    for (const line of doc?.lines ?? []) {
      const item = catalog.get(line.item);
      if (!item) continue;
      catalog.act(item.id, 'soldOnline', { cents: line.total }, { who: `buyer ${doc.fields?.email ?? ''}`.trim() });
    }
    for (const orderKey of doc?.orders ?? []) {
      const order = store.get('orders', orderKey);
      if (!order?.group) continue;
      await store.write('orders', orderKey, { make: 'waiting' });
      if (autoMake) await sendToMaker(orderKey);
    }
  }

  /** After the platform answered: the sale recorded once, or a late payment given back. */
  async function settled(key, result) {
    if (result.ok && !result.again && result.orders) await recordSale(key);
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
    return { ...line, title: item?.title ?? line.name ?? line.item, option: item?.option ?? '', handle: parent?.handle ?? item?.handle ?? '', images: (parent ?? item)?.images ?? [], maker: item?.maker ?? '' };
  }

  /** What a cart's maker lines cost to ship to the buyer, one quote per maker, cheapest option. */
  async function shippingFor(lines, buyer) {
    const groups = new Map();
    for (const line of lines) {
      const item = catalog.get(line.item);
      if (!item?.maker) continue;
      if (!groups.has(item.maker)) groups.set(item.maker, []);
      groups.get(item.maker).push({ ref: item.makerRef, qty: line.qty, title: line.name, cents: line.cents });
    }
    const shipping = [];
    for (const [maker, made] of groups) {
      if (!canMake(maker)) return { error: 'maker-unavailable', maker };
      if (made.some((line) => !line.ref)) return { error: 'maker-unavailable', maker };
      const quoted = await fulfill.quote(maker, { lines: made, to: toAddress(buyer) });
      if (quoted.error) return { error: quoted.error === 'bad-address' ? 'bad-address' : 'no-shipping', maker };
      const [cheapest] = quoted.options;
      shipping.push({ group: maker, id: cheapest.id, label: cheapest.label, cents: cheapest.cents, days: cheapest.days ?? null });
    }
    return { ok: true, shipping };
  }

  /** The buyer and what shipping costs, checked against the cart as it is now. */
  async function prepare(owner, form) {
    const shown = cart.view(owner);
    if (!shown.lines.length) return { error: 'empty' };
    if (!shown.ready) return { error: 'gone' };
    const made = shown.lines.some((line) => makerOf(line.item));
    const checked = checkBuyer(form, { needsPhone: made });
    if (checked.error) return checked;
    if (made && checked.buyer.delivery !== 'ship') return { error: 'must-ship' };
    const quoted = made ? await shippingFor(shown.lines, checked.buyer) : { ok: true, shipping: [] };
    if (quoted.error) return quoted;
    const shippingCents = quoted.shipping.reduce((sum, one) => sum + one.cents, 0);
    return { ok: true, buyer: checked.buyer, shipping: quoted.shipping, made, cents: shown.cents + shippingCents };
  }

  /** Send a maker's order to be made: once, with the shipping the buyer paid for. */
  async function sendToMaker(orderKey) {
    const order = store.get('orders', orderKey);
    if (!order?.group) return { error: 'not-a-maker-order' };
    if (order.status !== 'paid') return { error: 'wrong-step' };
    const lines = [];
    for (const line of order.lines ?? []) {
      const item = catalog.get(line.item);
      if (!item?.makerRef) {
        await store.write('orders', orderKey, { make: 'refused', makeError: 'no-maker-ref' });
        return { error: 'no-maker-ref', item: line.item };
      }
      lines.push({ ref: item.makerRef, qty: line.qty, title: line.name, cents: line.cents });
    }
    const shipping = (order.shipping ?? []).find((one) => one.group === order.group)?.id ?? '';
    const placed = await fulfill.place(order.group, { id: `order/${orderKey}`, lines, to: toAddress(order), contact: order.email, shipping });
    if (placed.error) {
      await store.write('orders', orderKey, { make: 'refused', makeError: placed.error });
      log(`Order ${orderKey}: ${order.group} refused it (${placed.error}${placed.detail ? `: ${placed.detail}` : ''}).`);
      return placed;
    }
    await stages.advance(orderKey, 'packed', { set: { make: 'placed', makeError: '', makerRef: placed.ref } });
    return { ok: true, ref: placed.ref, again: Boolean(placed.again) };
  }

  /** What a maker said about one of its orders: shipped (with tracking), or stopped. */
  async function makerNews(result) {
    if (!result?.ok || !String(result.id ?? '').startsWith('order/')) return;
    const orderKey = result.id.slice('order/'.length);
    if (result.shipped) {
      await stages.advance(orderKey, 'sent', { set: { make: 'shipped', shipments: result.shipments ?? [] } });
    } else if (result.state === 'failed' || result.state === 'cancelled') {
      await store.write('orders', orderKey, { make: result.state, makeError: String(result.reason ?? '') });
    }
  }

  /** One order of a checkout, as the pages show it. */
  function orderView(orderKey) {
    const order = store.get('orders', orderKey);
    if (!order) return null;
    return { key: orderKey, maker: order.group ?? '', step: order.status, make: order.make ?? '', makeError: order.makeError ?? '', shipments: order.shipments ?? [], lines: (order.lines ?? []).map(dressed), fee: order.fee ?? 0, cents: order.cents ?? 0 };
  }

  /** A checkout as the buyer's page and the dashboard show it. */
  function view(key) {
    const doc = checkout.get(key);
    if (!doc) return null;
    const orders = (doc.orders ?? []).map(orderView).filter(Boolean);
    const refunded = orders.length && orders.every((one) => one.step === 'refunded');
    const state = doc.state === 'paid' ? (refunded ? 'refunded' : 'paid') : doc.refund ?? (doc.state === 'failed' ? 'cancelled' : doc.state === 'paying' && now() - doc.at > HOLD_MINUTES * 60_000 ? 'abandoned' : doc.state);
    const { shipping = [], ...fields } = doc.fields ?? {};
    // The buyer's fields first: their `state` is a US state, and the checkout's own `state` wins.
    return {
      ...fields,
      key,
      state,
      step: orders[0]?.step ?? null,
      orders,
      owner: doc.owner,
      lines: (doc.lines ?? []).map(dressed),
      fees: doc.fees ?? [],
      shipping,
      cents: doc.cents,
      createdAt: doc.at,
      note: doc.refundError ? `Refund needed by hand: ${doc.refundError}` : '',
    };
  }

  return {
    /** Whether a maker can take orders here. */
    canMake,

    /** The buyer's cart, each line with its item's handle and photo. */
    cart(owner) {
      const shown = cart.view(owner);
      return { ...shown, lines: shown.lines.map(dressed), made: shown.lines.some((line) => makerOf(line.item)) };
    },
    add: (owner, handle, qty = 1) => cart.add(owner, String(handle), qty),
    set: (owner, handle, qty) => cart.set(owner, String(handle), qty),

    /** What the buyer will pay: the cart and, for made-to-order lines, the makers' shipping. Writes nothing. */
    review: (owner, form) => (owner ? prepare(owner, form) : Promise.resolve({ error: 'empty' })),

    /**
     * Check out the cart: the stock is taken, then off to the payment page. `expect` is the
     * total the buyer was shown; if shipping changed since, `price-changed` with the new review.
     */
    async start(owner, form, { key, expect = null }) {
      if (!owner) return { error: 'empty' };
      if (!isCheckoutKey(key)) return { error: 'no-key' };
      const ready = await prepare(owner, form);
      if (ready.error) return ready;
      if (expect !== null && ready.cents !== expect) return { error: 'price-changed', review: ready };
      const lines = cart.view(owner).lines;
      const description = lines.length === 1 ? `${lines[0].name}${lines[0].qty > 1 ? ` × ${lines[0].qty}` : ''}` : `${lines.length} items`;
      const placed = await checkout.place(owner, {
        key,
        fields: { ...ready.buyer, shipping: ready.shipping },
        contact: ready.buyer.email,
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
      if (result.ok && result.orders && !result.again) await recordSale(key);
      return { ok: true, checkout: view(key) };
    },

    /** Checkouts left on the payment page past the hold: stock back, or the sale if it was paid. Makers' orders refreshed. */
    async sweep() {
      const done = await checkout.sweep();
      for (const one of done) if (one.ok && one.orders && !one.again) await recordSale(one.key);
      if (fulfill) {
        for (const order of store.under('orders')) {
          if (order.make !== 'placed') continue;
          await makerNews(await fulfill.refresh(`order/${order.key}`));
        }
      }
      return done;
    },

    /** A maker's webhook. `{ error: 'bad-signature' }` is a request to refuse. */
    async heardMaker(maker, request) {
      if (!fulfill) return { ignore: true };
      const result = await fulfill.heard(maker, request);
      if (result.error === 'bad-signature') return result;
      await makerNews(result);
      return { ok: true };
    },

    /** For the kit's payments: may the platform still take money for this id? */
    wanted: (id) => checkout.wanted(id),

    get: view,

    /** The owner's OK: send a maker's order to be made. */
    sendToMaker,

    /** Move the store's own order along: packed, sent. Owners only (the web layer checks). */
    async advance(orderKey, to) {
      const order = store.get('orders', orderKey);
      if (!order) return { error: 'missing' };
      if (order.group) return { error: 'maker-order' };
      return stages.advance(orderKey, to, {});
    },

    /** Checkouts for the dashboard, newest first. Paying and not-paid ones included, so nothing is hidden. */
    list({ limit = 100 } = {}) {
      return store.under('checkouts').sort((a, b) => b.at - a.at).slice(0, limit).map((doc) => view(doc.key));
    },
  };
}
