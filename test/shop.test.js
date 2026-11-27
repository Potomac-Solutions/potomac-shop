import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase } from '../src/infra/db.js';
import { createShop } from '../src/app/index.js';
import { newCheckoutKey } from '../src/app/sales.js';
import { readConfig } from '../src/config.js';
import { sniff } from '../src/app/photos.js';
import { parseMultipart, boundaryOf } from '../src/web/multipart.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(8)]);

function setUp({ env = {}, fetch } = {}) {
  const db = openDatabase(':memory:');
  migrate(db);
  let clock = 1_800_000_000_000;
  const config = readConfig({ PUBLIC_URL: 'https://rix.example', SESSION_SECRET: 'x'.repeat(40), ...env });
  const shop = createShop({ db, config, now: () => clock, fetch, log: () => {} });
  shop.catalog.commit('Handle,Title,Variant Price,Variant SKU,Image Src,Status\nbelts,2g 95-99 seat belts,225.00,RR-2,https://cdn.example/b.png,active\nstalk,2g 97-99 stalk,35.00,RR-3,,active\n');
  return { shop, db, tick: (ms) => (clock += ms), at: () => clock };
}
const buyer = { name: 'Dana', email: 'dana@example.com', delivery: 'pickup' };
const refOf = (url) => new URL(url, 'http://local').searchParams.get('ref');

async function checkOut(shop, owner, items, form = buyer) {
  for (const [handle, qty] of items) assert.equal((await shop.sales.add(owner, handle, qty)).ok, true, handle);
  return shop.sales.start(owner, form, { key: newCheckoutKey() });
}

test('buying: stock is taken while the buyer pays, a one-of-a-kind part sold everywhere once paid', async () => {
  const { shop } = setUp();
  const { sales, catalog, test: testPay } = shop;
  const started = await checkOut(shop, 'cart:a', [['belts', 1]]);
  assert.equal(started.ok, true);
  assert.match(started.url, /^\/pay\/test\?ref=test_/);
  assert.equal(catalog.get('belts').quantity, 0);
  assert.equal((await sales.add('cart:b', 'belts', 1)).error, 'sold-out', 'nobody else can put the last one in a cart');

  const notYet = await sales.back(started.key);
  assert.equal(notYet.waiting, true);
  assert.equal(notYet.checkout.state, 'paying');

  testPay.approve(refOf(started.url));
  const paid = await sales.back(started.key);
  assert.equal(paid.checkout.state, 'paid');
  assert.equal(paid.checkout.step, 'paid');
  assert.equal(catalog.get('belts').status, 'sold');
  assert.equal(catalog.get('belts').soldVia, 'site');
  assert.equal((await sales.back(started.key)).checkout.state, 'paid', 'coming back again changes nothing');
  assert.equal(sales.cart('cart:a').lines.length, 0);
  assert.match(catalog.exportAs('google', { site: 'https://rix.example' }), /RR-2\t.*out_of_stock/);
});

test('a cart with several items and sizes is one checkout, all or nothing', async () => {
  const { shop } = setUp();
  const { catalog, sales, test: testPay } = shop;
  const tee = catalog.create({ title: 'Trail tee', priceCents: 2500, quantity: 0, condition: 'new' });
  const small = catalog.addSize(tee.item.id, { option: 'S', priceCents: 2500, quantity: 2 });
  const large = catalog.addSize(tee.item.id, { option: 'L', priceCents: 2700, quantity: 0, madeToOrder: true });
  assert.equal(catalog.addSize(tee.item.id, { option: 'S', priceCents: 2500 }).error, 'option-taken');
  assert.equal(catalog.act(tee.item.id, 'publish').ok, true, 'an item with sizes lists without stock of its own');
  assert.deepEqual(catalog.get(tee.item.id).sizes.map((one) => one.option), ['S', 'L']);
  assert.ok(!catalog.list({ status: 'active' }).some((one) => one.parentId), 'lists show the item, not each size');
  assert.equal((await sales.add('cart:a', tee.item.handle, 1)).error, 'gone', 'the item itself is bought through its sizes');

  const started = await checkOut(shop, 'cart:a', [[small.item.handle, 2], [large.item.handle, 3], ['stalk', 1]]);
  assert.equal(started.ok, true);
  assert.equal(sales.get(started.key).cents, 2 * 2500 + 3 * 2700 + 3500);
  assert.equal(catalog.get(small.item.id).quantity, 0);
  assert.equal(catalog.get(large.item.id).quantity, 0, 'made to order: never counted down');
  testPay.approve(refOf(started.url));
  await sales.back(started.key);
  assert.equal(catalog.get(small.item.id).status, 'active', 'a size stays listed');
  assert.equal(catalog.get(tee.item.id).status, 'active');
  assert.equal(catalog.get('stalk').status, 'sold');

  // Someone else's cart had the last small: checkout refuses the whole cart, takes nothing.
  await catalog.edit(small.item.id, { quantity: 1 });
  await sales.add('cart:b', small.item.handle, 1);
  await sales.add('cart:c', small.item.handle, 1);
  await sales.add('cart:c', large.item.handle, 1);
  assert.equal((await sales.start('cart:b', buyer, { key: newCheckoutKey() })).ok, true);
  const refused = await sales.start('cart:c', buyer, { key: newCheckoutKey() });
  assert.equal(refused.error, 'gone');
  assert.equal(sales.cart('cart:c').ready, false);
});

test('a buyer who backs out lets the stock go; an abandoned checkout is swept back', async () => {
  const { shop, tick } = setUp();
  const started = await checkOut(shop, 'cart:a', [['belts', 1]]);
  assert.equal((await shop.sales.cancel('cart:b', started.key)).error, 'not-yours');
  assert.equal((await shop.sales.cancel('cart:a', started.key)).checkout.state, 'cancelled');
  assert.equal(shop.catalog.get('belts').quantity, 1);
  const again = await shop.sales.start('cart:a', buyer, { key: newCheckoutKey() });
  assert.equal(again.ok, true, 'the cart kept its line');
  tick(31 * 60_000);
  await shop.sales.sweep();
  assert.equal(shop.catalog.get('belts').quantity, 1);
  assert.equal(shop.sales.get(again.key).state, 'cancelled');
});

test('if the part sold at the counter after the hold ran out and the buyer paid anyway, the payment is refunded', async () => {
  const { shop, tick } = setUp();
  const started = await checkOut(shop, 'cart:a', [['belts', 1]]);
  tick(31 * 60_000);
  await shop.sales.sweep();
  const belts = shop.catalog.get('belts');
  assert.equal(shop.catalog.act(belts.id, 'sell', { via: 'counter' }).ok, true);
  shop.test.approve(refOf(started.url));
  const result = await shop.sales.back(started.key);
  assert.equal(result.checkout.state, 'refunded');
  assert.equal(shop.catalog.get('belts').soldVia, 'counter');
});

test('the buyer’s details are checked before anything is taken', async () => {
  const { shop } = setUp();
  await shop.sales.add('cart:a', 'belts', 1);
  assert.deepEqual(await shop.sales.start('cart:a', { ...buyer, email: 'nope' }, { key: newCheckoutKey() }), { error: 'bad-email' });
  assert.deepEqual(await shop.sales.start('cart:a', { ...buyer, delivery: 'ship', address: '' }, { key: newCheckoutKey() }), { error: 'no-address' });
  assert.equal(shop.catalog.get('belts').quantity, 1);
});

test('the kit may change an item’s count and nothing else', () => {
  const { shop } = setUp();
  assert.equal(shop.store.get('items', 'belts').left, 1);
  assert.throws(() => shop.store.write('items', 'belts', { cents: 1 }), /only change an item's count/);
});

test('photos: kinds read from the bytes, HEIC named, stored photos go into the feed with the store’s address', () => {
  const { shop } = setUp();
  assert.equal(sniff(JPEG), 'image/jpeg');
  assert.equal(sniff(HEIC), 'image/heic');
  assert.equal(sniff(Buffer.from('<svg>')), null);
  const stalk = shop.catalog.get('stalk');
  assert.deepEqual(shop.photos.add(stalk.id, [{ bytes: HEIC }]), { error: 'heic' });
  assert.deepEqual(shop.photos.add(stalk.id, [{ bytes: Buffer.from('GIF89a') }]), { error: 'not-image' });
  const added = shop.photos.add(stalk.id, [{ bytes: JPEG }]);
  assert.equal(added.ok, true);
  assert.match(added.added[0], /^\/media\/\d+\.jpg$/);
  assert.deepEqual(shop.photos.get(Number(/\d+/.exec(added.added[0])[0])).bytes, JPEG);
  assert.match(shop.catalog.exportAs('google', { site: 'https://rix.example' }), /https:\/\/rix\.example\/media\/\d+\.jpg/);
});

test('multipart uploads are read without a library', () => {
  const boundary = boundaryOf('multipart/form-data; boundary=----x1');
  const body = Buffer.concat([
    Buffer.from('------x1\r\nContent-Disposition: form-data; name="token"\r\n\r\nabc\r\n'),
    Buffer.from('------x1\r\nContent-Disposition: form-data; name="photos"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'),
    JPEG,
    Buffer.from('\r\n------x1\r\nContent-Disposition: form-data; name="photos"; filename=""\r\n\r\n\r\n------x1--\r\n'),
  ]);
  const { fields, files } = parseMultipart(body, boundary);
  assert.equal(fields.get('token'), 'abc');
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].bytes, JPEG);
  assert.throws(() => parseMultipart(Buffer.from('nothing'), boundary), /no parts/);
});

test('AI drafts: written from the photos into a draft, price untouched, cost counted, budget kept', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), key: init.headers['x-api-key'] });
    return new Response(JSON.stringify({
      model: 'claude-haiku-5-5',
      usage: { input_tokens: 2000, output_tokens: 300 },
      content: [{ type: 'text', text: 'Here: {"title":"2g 95-99 headlight turn signal stalk","description":"OEM stalk. Clean.","category":"Electrical & tuning","condition":"used","fits":"2G DSM 1997-1999 Eclipse Talon","notes":"Part number not readable."}' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { shop } = setUp({ env: { ANTHROPIC_API_KEY: 'sk-test', AI_MONTHLY_DOLLARS: '1' }, fetch });
  const made = shop.catalog.create({ title: 'stalk thing', priceCents: 3500 });
  assert.deepEqual(await shop.drafts.draft(made.item.id), { error: 'no-photos' });
  shop.photos.add(made.item.id, [{ bytes: JPEG }]);
  const drafted = await shop.drafts.draft(made.item.id);
  assert.equal(drafted.ok, true);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].key, 'sk-test');
  assert.equal(calls[0].body.messages[0].content[0].type, 'image');
  assert.equal(drafted.item.title, '2g 95-99 headlight turn signal stalk');
  assert.equal(drafted.item.priceCents, 3500);
  assert.equal(drafted.item.status, 'draft');
  assert.deepEqual(drafted.item.fitment.map((f) => [f.platform, f.from, f.to]), [['2G', 1997, 1999]]);
  assert.equal(drafted.notes, 'Part number not readable.');
  // 2000 × $1 + 300 × $5 per million tokens = $0.0035
  assert.equal(shop.drafts.budget().spent, 0.0035);
  // A listed part isn't redrafted.
  shop.catalog.act(made.item.id, 'publish');
  assert.deepEqual(await shop.drafts.draft(made.item.id), { error: 'not-draft' });
});

test('AI drafts are off without a key and stop at the budget', async () => {
  const { shop } = setUp();
  assert.equal(shop.drafts.enabled, false);
  const made = shop.catalog.create({ title: 'x', priceCents: 100 });
  assert.deepEqual(await shop.drafts.draft(made.item.id), { error: 'ai-off' });
  const budgeted = setUp({ env: { ANTHROPIC_API_KEY: 'sk-test', AI_MONTHLY_DOLLARS: '0' }, fetch: async () => assert.fail('no call over budget') });
  const part = budgeted.shop.catalog.create({ title: 'x', priceCents: 100 });
  budgeted.shop.photos.add(part.item.id, [{ bytes: JPEG }]);
  assert.deepEqual(await budgeted.shop.drafts.draft(part.item.id), { error: 'over-budget' });
});
