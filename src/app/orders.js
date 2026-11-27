// Buying a part: hold it, send the buyer to the payment platform's own page, and mark it sold
// everywhere once the platform says it's paid. `payments` makes sure an order is paid at most
// once; this makes sure a part is sold at most once.
//
// The one awkward case: a buyer is still on the payment page when the hold runs out and the part
// sells at the counter. Their payment is then refunded and the order says so.

import { randomBytes } from 'node:crypto';
import { transaction } from '../infra/db.js';
import { buyable } from '../domain/exports.js';

export const HOLD_MINUTES = 30;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

const shape = (row) =>
  row && {
    id: row.id, key: row.key, itemId: row.item_id, cents: row.cents, name: row.name, email: row.email, phone: row.phone,
    delivery: row.delivery, address: row.address, state: row.state, note: row.note, createdAt: row.created_at, paidAt: row.paid_at,
  };

/** What a buyer typed, checked. Answers { ok, order } or { error, field }. */
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

export function createOrders({ db, catalog, payments, site, now = Date.now, log = () => {} }) {
  const byKey = db.prepare('SELECT * FROM orders WHERE key = ?');

  /** Hold the part and open the payment page. Answers { ok, url, key } or { error }. */
  async function start(handle, form) {
    const checked = checkBuyer(form);
    if (checked.error) return checked;
    const item = catalog.get(handle);
    if (!item || !buyable(item, now())) return { error: 'gone' };
    const key = randomBytes(18).toString('base64url');
    // The hold and the order are one step: two buyers pressing at once can't both hold it.
    const opened = transaction(db, () => {
      const held = catalog.act(item.id, 'hold', { until: now() + HOLD_MINUTES * 60_000 }, { who: `buyer ${checked.buyer.email}`, nested: true });
      if (held.error) return { error: 'gone' };
      db.prepare('INSERT INTO orders (key, item_id, cents, name, email, phone, delivery, address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(key, item.id, item.priceCents, checked.buyer.name, checked.buyer.email, checked.buyer.phone, checked.buyer.delivery, checked.buyer.address, now());
      return { ok: true };
    });
    if (opened.error) return opened;
    const started = await payments.start({
      key,
      cents: item.priceCents,
      name: `${item.title} (${item.sku})`.slice(0, 120),
      back: `${site}/orders/${key}`,
      email: checked.buyer.email,
    });
    if (started.error) {
      cancel(key, 'payment page could not be opened');
      log(`Payment page refused for order ${key}: ${started.error}`);
      return { error: 'pay-unavailable' };
    }
    return { ok: true, key, url: started.url, ref: started.ref };
  }

  const get = (key) => shape(byKey.get(String(key)));

  /** Record a payment the platform confirmed: the order is paid and the part sold, or refunded. */
  async function paid(key) {
    const order = get(key);
    if (!order) return { error: 'no-order' };
    if (order.state === 'paid' || order.state === 'refunded' || order.state === 'refund-failed') return { ok: true, order, again: true };
    const sold = transaction(db, () => {
      const item = catalog.get(order.itemId);
      // Still held for this buyer, or (the hold ran out) still for sale to anyone: it's theirs.
      const result = item && (item.status === 'held' || item.status === 'active') ? catalog.act(order.itemId, 'sell', { via: 'site', cents: order.cents }, { who: `buyer ${order.email}`, nested: true }) : { error: 'already-sold' };
      if (result.error) return result;
      db.prepare("UPDATE orders SET state = 'paid', paid_at = ? WHERE key = ?").run(now(), key);
      return { ok: true };
    });
    if (sold.ok) return { ok: true, order: get(key) };
    // Sold some other way while they paid: give the money back.
    const refund = await payments.refund(key);
    const state = refund.ok ? 'refunded' : 'refund-failed';
    db.prepare('UPDATE orders SET state = ?, note = ? WHERE key = ?').run(state, refund.ok ? 'The part sold elsewhere while you paid; refunded in full.' : `Refund needed by hand: ${refund.error}`, key);
    log(`Order ${key}: part sold elsewhere during payment; ${state}.`);
    return { ok: true, order: get(key) };
  }

  /** The buyer came back from the payment page: ask the platform whether they paid. */
  async function back(key) {
    const order = get(key);
    if (!order) return { error: 'no-order' };
    if (order.state !== 'started') return { ok: true, order };
    const settled = await payments.settle(key);
    if (settled.ok) return paid(key);
    return { ok: true, order, waiting: settled.error === 'not-paid' };
  }

  /** A webhook from the platform. Answers { ok } for 200, { error: 'bad-signature' } for a refusal. */
  async function heard(request) {
    const result = await payments.heard(request);
    if (result.error === 'bad-signature') return result;
    if (result.ok && result.key) await paid(result.key);
    return { ok: true };
  }

  /** The buyer backed out, or the page couldn't open: let the part go. A paid order is never cancelled. */
  function cancel(key, note = 'cancelled by the buyer') {
    return transaction(db, () => {
      const order = get(key);
      if (!order) return { error: 'no-order' };
      if (order.state !== 'started') return { error: 'not-open', order };
      const item = catalog.get(order.itemId);
      if (item?.status === 'held') catalog.act(order.itemId, 'release', {}, { who: `buyer ${order.email}`, nested: true });
      db.prepare("UPDATE orders SET state = 'cancelled', note = ? WHERE key = ?").run(note, key);
      return { ok: true, order: get(key) };
    });
  }

  /** Orders for the dashboard, newest first, with the part's title. */
  const list = ({ limit = 100 } = {}) =>
    db.prepare('SELECT orders.*, items.title AS item_title, items.id AS item_id FROM orders JOIN items ON items.id = orders.item_id ORDER BY orders.id DESC LIMIT ?').all(limit).map((row) => ({ ...shape(row), itemTitle: row.item_title }));

  return { start, back, heard, cancel, get, list, paid };
}
