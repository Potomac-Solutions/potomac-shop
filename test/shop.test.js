import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase } from '../src/infra/db.js';
import { createShop } from '../src/app/index.js';
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

test('buying: the part is held while the buyer pays, sold everywhere once paid, never twice', async () => {
  const { shop } = setUp();
  const { orders, catalog, test: testPay } = shop;
  const started = await orders.start('belts', buyer);
  assert.equal(started.ok, true);
  assert.match(started.url, /^\/pay\/test\?ref=test_/);
  assert.equal(catalog.get('belts').status, 'held');
  assert.deepEqual(await orders.start('belts', { ...buyer, email: 'other@example.com' }), { error: 'gone' });

  const notYet = await orders.back(started.key);
  assert.equal(notYet.waiting, true);
  assert.equal(catalog.get('belts').status, 'held');

  testPay.approve(started.ref);
  const paid = await orders.back(started.key);
  assert.equal(paid.order.state, 'paid');
  assert.equal(catalog.get('belts').status, 'sold');
  assert.equal(catalog.get('belts').soldVia, 'site');
  assert.equal((await orders.back(started.key)).order.state, 'paid');
  assert.match(catalog.exportAs('google', { site: 'https://rix.example' }), /RR-2\t.*out_of_stock/);
});

test('a buyer who backs out lets the part go; a paid order can’t be cancelled', async () => {
  const { shop } = setUp();
  const started = await shop.orders.start('belts', buyer);
  assert.equal(shop.orders.cancel(started.key).ok, true);
  assert.equal(shop.catalog.get('belts').status, 'active');
  const again = await shop.orders.start('belts', buyer);
  shop.test.approve(again.ref);
  await shop.orders.back(again.key);
  assert.equal(shop.orders.cancel(again.key).error, 'not-open');
});

test('if the part sold at the counter while the buyer paid, the payment is refunded', async () => {
  const { shop, tick } = setUp();
  const started = await shop.orders.start('belts', buyer);
  tick(31 * 60_000); // the hold runs out
  const belts = shop.catalog.get('belts');
  assert.equal(belts.status, 'active');
  shop.catalog.act(belts.id, 'sell', { via: 'counter' });
  shop.test.approve(started.ref);
  const result = await shop.orders.back(started.key);
  assert.equal(result.order.state, 'refunded');
  assert.equal(shop.catalog.get('belts').soldVia, 'counter');
});

test('the buyer’s details are checked before anything is held', async () => {
  const { shop } = setUp();
  assert.deepEqual(await shop.orders.start('belts', { ...buyer, email: 'nope' }), { error: 'bad-email' });
  assert.deepEqual(await shop.orders.start('belts', { ...buyer, delivery: 'ship', address: '' }), { error: 'no-address' });
  assert.equal(shop.catalog.get('belts').status, 'active');
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
