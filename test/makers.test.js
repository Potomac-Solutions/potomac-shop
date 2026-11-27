// Print on demand: a printer's lines ship from the printer, priced to the buyer's address before
// they pay, sent to be made on the owner's OK, and tracked back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testMaker } from '@potomac-solutions/kit/fulfill/providers';
import { migrate, openDatabase } from '../src/infra/db.js';
import { createShop } from '../src/app/index.js';
import { newCheckoutKey, checkBuyer } from '../src/app/sales.js';
import { readConfig } from '../src/config.js';

const BOOK = JSON.stringify({ pod_package_id: '0550X0850BWSTDPB060UW444GXX', cover: 'https://files.example/cover.pdf', interior: 'https://files.example/interior.pdf', page_count: 120 });
const buyer = { name: 'Dana Whitfield', email: 'dana@example.com', phone: '304-555-0142', delivery: 'ship', street1: '12 Ridge Rd', city: 'Elkins', state: 'wv', zip: '26241' };
const refOf = (url) => new URL(url, 'http://local').searchParams.get('ref');

function setUp({ env = {}, makers } = {}) {
  const db = openDatabase(':memory:');
  migrate(db);
  const printful = testMaker({ name: 'printful' });
  const lulu = testMaker({ name: 'lulu' });
  const config = readConfig({ PUBLIC_URL: 'https://shop.example', SESSION_SECRET: 'x'.repeat(40), ...env });
  const shop = createShop({ db, config, log: () => {}, makers: makers ?? { printful, lulu } });
  const { catalog } = shop;
  catalog.commit('Handle,Title,Variant Price,Variant SKU,Status\nsticker,Trail sticker,4.00,ST-1,active\n');
  catalog.edit(catalog.get('sticker').id, { quantity: 50 });
  const tee = catalog.create({ title: 'Trail tee', priceCents: 2500, condition: 'new', maker: 'printful' }).item;
  const m = catalog.addSize(tee.id, { option: 'M', priceCents: 2500, makerRef: '4001' }).item;
  const l = catalog.addSize(tee.id, { option: 'L', priceCents: 2500, makerRef: '4002' }).item;
  catalog.act(tee.id, 'publish');
  const book = catalog.create({ title: 'Garrett County through the seasons', priceCents: 2400, condition: 'new', maker: 'lulu', makerRef: BOOK, costCents: 900 }).item;
  catalog.act(book.id, 'publish');
  return { shop, printful, lulu, tee, m, l, book };
}

async function fill(shop, owner, lines) {
  for (const [handle, qty] of lines) assert.equal((await shop.sales.add(owner, handle, qty)).ok, true, handle);
}

test('a buyer’s shipping address is checked: a US street, state and ZIP; a phone when a printer ships it', () => {
  assert.equal(checkBuyer(buyer, { needsPhone: true }).buyer.address, '12 Ridge Rd, Elkins, WV 26241');
  assert.equal(checkBuyer({ ...buyer, state: 'XX' }).error, 'bad-state');
  assert.equal(checkBuyer({ ...buyer, zip: '2624' }).error, 'bad-zip');
  assert.equal(checkBuyer({ ...buyer, street1: '' }).error, 'no-address');
  assert.equal(checkBuyer({ ...buyer, phone: '' }, { needsPhone: true }).error, 'no-phone');
  assert.equal(checkBuyer({ ...buyer, phone: '' }).ok, true);
  assert.equal(checkBuyer({ ...buyer, delivery: 'pickup', street1: '' }).ok, true);
});

test('a printer’s items are made to order: they never run out, and their sizes follow the printer', () => {
  const { shop, tee, m, book } = setUp();
  assert.equal(shop.catalog.get(tee.id).maker, 'printful');
  assert.deepEqual([shop.catalog.get(m.id).maker, shop.catalog.get(m.id).madeToOrder, shop.catalog.get(m.id).makerRef], ['printful', true, '4001']);
  assert.equal(shop.catalog.get(book.id).madeToOrder, true);
  assert.equal(shop.store.get('items', m.handle).left, null);
  assert.equal(shop.catalog.edit(book.id, { maker: 'acme' }).error, 'bad-maker');
});

test('checkout: the printers’ shipping to the buyer’s address, then one order per maker', async () => {
  const { shop, printful, lulu, m, l, book } = setUp();
  const { sales, test: testPay } = shop;
  await fill(shop, 'cart:a', [[m.handle, 2], [l.handle, 1], [book.handle, 1], ['sticker', 3]]);
  assert.equal(sales.cart('cart:a').made, true);
  assert.equal((await sales.review('cart:a', { ...buyer, delivery: 'pickup' })).error, 'must-ship');
  assert.equal((await sales.review('cart:a', { ...buyer, phone: '' })).error, 'no-phone');

  const review = await sales.review('cart:a', buyer);
  assert.deepEqual(review.shipping.map((one) => [one.group, one.cents]).sort(), [['lulu', 500], ['printful', 700]]);
  const items = 3 * 2500 + 2400 + 3 * 400;
  assert.equal(review.cents, items + 700 + 500);

  assert.equal((await sales.start('cart:a', buyer, { key: newCheckoutKey(), expect: review.cents - 1 })).error, 'price-changed');
  const started = await sales.start('cart:a', buyer, { key: newCheckoutKey(), expect: review.cents });
  assert.equal(started.ok, true);
  assert.equal(sales.get(started.key).cents, review.cents);
  testPay.approve(refOf(started.url));
  const paid = (await sales.back(started.key)).checkout;
  assert.equal(paid.state, 'paid');
  const byMaker = Object.fromEntries(paid.orders.map((one) => [one.maker, one]));
  assert.deepEqual(Object.keys(byMaker).sort(), ['', 'lulu', 'printful']);
  assert.deepEqual([byMaker.printful.fee, byMaker.lulu.fee, byMaker[''].fee], [700, 500, 0], 'each printer’s shipping is on its own order');
  assert.deepEqual([byMaker.printful.make, byMaker.lulu.make, byMaker[''].make], ['waiting', 'waiting', ''], 'printers wait for the owner’s OK');
  assert.equal(printful.placed().length + lulu.placed().length, 0);

  // The owner's OK: sent once, with the refs, the address and the shipping the buyer paid for.
  const sent = await sales.sendToMaker(byMaker.printful.key);
  assert.equal(sent.ok, true);
  assert.equal((await sales.sendToMaker(byMaker.printful.key)).error, 'wrong-step', 'it has gone already');
  const [made] = printful.placed();
  assert.deepEqual(made.lines.map((line) => [line.ref, line.qty]).sort(), [['4001', 2], ['4002', 1]]);
  assert.equal(shop.fulfill.get(`order/${byMaker.printful.key}`).to.postcode, '26241');
  assert.equal(shop.fulfill.get(`order/${byMaker.printful.key}`).shipping, 'STANDARD');
  assert.equal(sales.get(started.key).orders.find((one) => one.maker === 'printful').make, 'placed');
  assert.equal((await sales.advance(byMaker.printful.key, 'sent')).error, 'maker-order', 'a printer’s order is marked sent by the printer');

  // Printful's webhook names the order; the printer is asked, and the tracking comes back.
  printful.advance(made.ref, 'shipped', { carrier: 'USPS', tracking: '9400111', url: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111' });
  assert.deepEqual(await sales.heardMaker('printful', { body: JSON.stringify({ ref: made.ref }) }), { ok: true });
  const shipped = sales.get(started.key).orders.find((one) => one.maker === 'printful');
  assert.deepEqual([shipped.step, shipped.make, shipped.shipments[0].tracking], ['sent', 'shipped', '9400111']);

  // Lulu's goes the same way; with no webhook, the sweep asks.
  await sales.sendToMaker(byMaker.lulu.key);
  const [job] = lulu.placed();
  assert.equal(job.lines[0].ref, BOOK);
  lulu.advance(job.ref, 'shipped', { carrier: 'UPS', tracking: '1Z9', url: 'https://www.ups.com/track?tracknum=1Z9' });
  await sales.sweep();
  assert.equal(sales.get(started.key).orders.find((one) => one.maker === 'lulu').step, 'sent');
});

test('a printer that isn’t set up, or a product with no printer id, can’t be checked out', async () => {
  const { shop, m } = setUp({ makers: { lulu: testMaker({ name: 'lulu' }) } });
  await fill(shop, 'cart:a', [[m.handle, 1]]);
  assert.equal((await shop.sales.review('cart:a', buyer)).error, 'maker-unavailable');
  const other = setUp();
  other.shop.catalog.edit(other.m.id, { makerRef: '' });
  await fill(other.shop, 'cart:b', [[other.m.handle, 1]]);
  assert.equal((await other.shop.sales.review('cart:b', buyer)).error, 'maker-unavailable');
});

test('with MAKER_AUTO=1 a printer’s order goes to be made as soon as it’s paid', async () => {
  const { shop, printful, m } = setUp({ env: { MAKER_AUTO: '1' } });
  await fill(shop, 'cart:a', [[m.handle, 1]]);
  const review = await shop.sales.review('cart:a', buyer);
  const started = await shop.sales.start('cart:a', buyer, { key: newCheckoutKey(), expect: review.cents });
  shop.test.approve(refOf(started.url));
  await shop.sales.back(started.key);
  assert.equal(printful.placed().length, 1);
  assert.equal(shop.sales.get(started.key).orders[0].make, 'placed');
});

test('a refused send keeps the reason for the owner and can be sent again', async () => {
  const { shop, printful, m } = setUp();
  await fill(shop, 'cart:a', [[m.handle, 1]]);
  const review = await shop.sales.review('cart:a', buyer);
  const started = await shop.sales.start('cart:a', buyer, { key: newCheckoutKey(), expect: review.cents });
  shop.test.approve(refOf(started.url));
  const [order] = (await shop.sales.back(started.key)).checkout.orders;
  const place = printful.place;
  printful.place = async () => ({ error: 'maker-refused-key' });
  assert.equal((await shop.sales.sendToMaker(order.key)).error, 'maker-refused-key');
  assert.deepEqual([shop.sales.get(started.key).orders[0].make, shop.sales.get(started.key).orders[0].makeError], ['refused', 'maker-refused-key']);
  printful.place = place;
  assert.equal((await shop.sales.sendToMaker(order.key)).ok, true);
});

test('over HTTP: the checkout shows the printer’s shipping before paying, and makers’ webhooks are heard', async () => {
  const { createWeb } = await import('../src/web/server.js');
  const { shop, m } = setUp();
  const { server } = createWeb({ shop, config: readConfig({ PUBLIC_URL: 'https://shop.example', SESSION_SECRET: 'x'.repeat(40) }) });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  const post = (path, fields, cookie = '') => fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' }, body: new URLSearchParams(fields), redirect: 'manual' });
  try {
    const added = await post('/cart/add', { item: m.handle, qty: '1' });
    const cookie = added.headers.get('set-cookie').split(';')[0];
    const form = await (await fetch(`${base}/checkout`, { headers: { cookie } })).text();
    assert.match(form, /See shipping and total/);
    assert.doesNotMatch(form, /value="pickup"/, 'a printer’s item can’t be picked up');
    const key = /name="checkout" value="([^"]+)"/.exec(form)[1];
    const review = await (await post('/checkout', { ...buyer, checkout: key, step: 'review' }, cookie)).text();
    assert.match(review, /Check and pay/);
    assert.match(review, /Shipping from Printful: Standard \(test\)/);
    assert.match(review, /\$30\.00/);
    const expect = /name="expect" value="(\d+)"/.exec(review)[1];
    assert.equal(expect, '3000');
    const skipped = await post('/checkout', { ...buyer, checkout: key, step: 'pay' }, cookie);
    assert.equal(skipped.status, 422, 'paying without seeing shipping is sent back');
    const paid = await post('/checkout', { ...buyer, checkout: key, step: 'pay', expect }, cookie);
    assert.match(paid.headers.get('location'), /^\/pay\/test\?ref=/);
    assert.equal((await post('/makers/printful', JSON.stringify({ ref: 'nobody' }))).status, 200);
    assert.notEqual((await fetch(`${base}/makers/acme`, { method: 'POST', body: '{}' })).status, 200, 'only the makers it knows');
  } finally {
    server.close();
  }
});
