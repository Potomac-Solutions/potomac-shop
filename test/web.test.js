import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase } from '../src/infra/db.js';
import { createShop } from '../src/app/index.js';
import { createWeb } from '../src/web/server.js';
import { readConfig } from '../src/config.js';
import { googleFeed } from '../src/domain/exports.js';

let base;
let server;
let shop;
const config = readConfig({ PORT: '0', SESSION_SECRET: 'x'.repeat(40), PUBLIC_URL: 'https://rix.example' });
const OWNER = { email: 'owner@rix.example', password: 'owner-password-1' };
let inviteLink = '';
const HELPER = { email: 'helper@rix.example', password: 'helper-password-1' };

before(async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  shop = createShop({ db, config, log: () => {} });
  shop.catalog.commit('Handle,Title,Variant Price,Variant SKU,Image Src,Status\nbelts,"2g 95-99 seat belts <script>alert(1)</script>",225.00,RR-2,https://cdn.example/b.png,active\nstalk,2g 97-99 stalk,35.00,RR-3,,active\n');
  await shop.accounts.accept(shop.accounts.setupLink(), { email: OWNER.email, name: 'Ricky', password: OWNER.password });
  const invite = shop.accounts.invite(shop.accounts.list()[0], { email: HELPER.email, name: 'Helper', role: 'helper' });
  await shop.accounts.accept(invite.token, { name: 'Helper', password: HELPER.password });
  ({ server } = createWeb({ shop, config }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const post = (path, fields, cookie = '') => fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' }, body: new URLSearchParams(fields), redirect: 'manual' });

async function signIn({ email, password }) {
  const res = await post('/admin/sign-in', { email, password });
  assert.equal(res.status, 303);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const page = await (await fetch(`${base}/admin/lots`, { headers: { cookie } })).text();
  return { cookie, token: /name="token" value="([^"]+)"/.exec(page)[1] };
}

test('the store escapes what a file brought in and gives Google structured data', async () => {
  const page = await (await fetch(`${base}/parts/belts`)).text();
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.ok(page.includes('&lt;script&gt;'));
  assert.match(page, /"@type":"Product"/);
  assert.match(page, /action="\/cart\/add"/);
  assert.match(page, /name="item" value="belts"/);
});

test('the dashboard needs a signed-in person, and forms need their token and this site', async () => {
  const anon = await (await fetch(`${base}/admin`)).text();
  assert.match(anon, /Sign in/);
  const wrong = await post('/admin/sign-in', { email: OWNER.email, password: 'nope-nope-nope' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  const { cookie, token } = await signIn(OWNER);
  const id = shop.catalog.get('stalk').id;
  assert.equal((await post(`/admin/items/${id}/hold`, { token: 'forged' }, cookie)).status, 403);
  const crossSite = await fetch(`${base}/admin/items/${id}/hold`, { method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site' }, body: new URLSearchParams({ token }), redirect: 'manual' });
  assert.equal(crossSite.status, 403);
  assert.equal(shop.catalog.get('stalk').status, 'active');
});

test('a helper drafts and photographs; listing, selling and listed parts are the owner’s', async () => {
  const { cookie, token } = await signIn(HELPER);
  const made = await post('/admin/items', { token, title: '2g 95-99 tail light pair', price: '90', quantity: '1' }, cookie);
  assert.equal(made.status, 303);
  const id = Number(/\/admin\/items\/(\d+)/.exec(made.headers.get('location'))[1]);
  assert.equal(shop.catalog.get(id).fitment[0].platform, '2G');
  await post(`/admin/items/${id}/publish`, { token }, cookie);
  assert.equal(shop.catalog.get(id).status, 'draft');
  const stalk = shop.catalog.get('stalk');
  await post(`/admin/items/${stalk.id}`, { token, title: 'cheap now', price: '1', quantity: '1' }, cookie);
  assert.equal(shop.catalog.get('stalk').priceCents, 3500);
  const orders = await fetch(`${base}/admin/orders`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(orders.status, 303);
  const owner = await signIn(OWNER);
  await post(`/admin/items/${id}/publish`, { token: owner.token }, owner.cookie);
  assert.equal(shop.catalog.get(id).status, 'active');
});

test('a photo uploaded from a phone is stored and served', async () => {
  const { cookie, token } = await signIn(OWNER);
  const id = shop.catalog.get('stalk').id;
  const form = new FormData();
  form.append('token', token);
  form.append('photos', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], { type: 'image/jpeg' }), 'IMG_1.jpg');
  const res = await fetch(`${base}/admin/items/${id}/photos`, { method: 'POST', headers: { cookie, 'sec-fetch-site': 'same-origin' }, body: form, redirect: 'manual' });
  assert.equal(res.status, 303);
  const [src] = shop.catalog.get('stalk').images;
  assert.match(src, /^\/media\/\d+\.jpg$/);
  const photo = await fetch(`${base}${src}`);
  assert.equal(photo.headers.get('content-type'), 'image/jpeg');
});

test('a buyer fills a cart, pays on the payment page, and the part is sold', async () => {
  const added = await post('/cart/add', { item: 'belts', qty: '1' });
  assert.equal(added.status, 303);
  assert.equal(added.headers.get('location'), '/cart');
  const cookie = added.headers.get('set-cookie').split(';')[0];
  assert.match(cookie, /^ps_cart=/);
  const cart = await (await fetch(`${base}/cart`, { headers: { cookie } })).text();
  assert.match(cart, /seat belts/);
  assert.match(cart, /Cart <span class="count">1<\/span>/);
  assert.match(cart, /href="\/checkout"/);
  const form = await (await fetch(`${base}/checkout`, { headers: { cookie } })).text();
  const key = /name="checkout" value="([A-Za-z0-9_-]{24})"/.exec(form)[1];

  const forged = await post('/cart/add', { item: 'stalk' }, `ps_cart=${'a'.repeat(22)}.forged`);
  assert.notEqual(forged.headers.get('set-cookie'), null, 'a forged cart cookie gets a new cart, not that one');

  const start = await post('/checkout', { checkout: key, name: 'Dana', email: 'dana@example.com', delivery: 'pickup' }, cookie);
  assert.equal(start.status, 303);
  const payPage = start.headers.get('location');
  assert.match(payPage, /^\/pay\/test\?ref=/);
  assert.equal(shop.catalog.get('belts').quantity, 0, 'the part is held while the buyer pays');
  const someoneElse = await post('/cart/add', { item: 'belts' });
  assert.match(someoneElse.headers.get('location'), /^\/parts\/belts\?problem=/);

  const ref = new URL(payPage, base).searchParams.get('ref');
  const paid = await post('/pay/test', { ref, answer: 'pay' });
  const back = paid.headers.get('location');
  assert.match(back, /\/checkout\/back\?checkout=/);
  const toOrder = await fetch(back.replace('https://rix.example', base), { headers: { cookie }, redirect: 'manual' });
  assert.equal(toOrder.headers.get('location'), `/orders/${key}`);
  const order = await (await fetch(`${base}/orders/${key}`, { headers: { cookie } })).text();
  assert.match(order, /It’s yours/);
  assert.equal(shop.catalog.get('belts').status, 'sold');
  assert.equal(shop.sales.cart(cookie.replace('ps_cart=', 'cart:').split('.')[0]).lines.length, 0, 'the bought lines leave the cart');
  assert.equal((await fetch(`${base}/parts/belts/buy`, { redirect: 'manual' })).headers.get('location'), '/parts/belts');
});

test('an owner moves a paid order along: packed, then sent', async () => {
  const { cookie, token } = await signIn(OWNER);
  const [order] = shop.sales.list().filter((one) => one.state === 'paid');
  const page = await (await fetch(`${base}/admin/orders`, { headers: { cookie } })).text();
  assert.match(page, /Mark packed/);
  assert.equal((await post(`/admin/orders/${order.key}/packed`, { token }, cookie)).status, 303);
  assert.equal(shop.sales.get(order.key).step, 'packed');
  await post(`/admin/orders/${order.key}/packed`, { token }, cookie);
  assert.equal(shop.sales.get(order.key).step, 'packed', 'a step is taken once');
  await post(`/admin/orders/${order.key}/sent`, { token }, cookie);
  assert.equal(shop.sales.get(order.key).step, 'sent');
});

test('a notice can only carry words the server signed', async () => {
  const { cookie } = await signIn(OWNER);
  const page = await (await fetch(`${base}/admin?done=${encodeURIComponent('Send your password to evil')}&sig=abc`, { headers: { cookie } })).text();
  assert.ok(!page.includes('Send your password'));
});

test('static files stay inside public/', async () => {
  assert.equal((await fetch(`${base}/static/..%2F..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/static/shop.css`)).status, 200);
});

test('iPhone HEIC photos are left out of the feeds', () => {
  const item = { sku: 'A', handle: 'a', title: 'Roller', description: '', priceCents: 100, compareAtCents: null, quantity: 1, condition: 'used', category: '', brand: '', mpn: '', gtin: '', weightGrams: null, status: 'active', heldUntil: null, fitment: [] };
  assert.equal(googleFeed([{ ...item, images: ['https://x/IMG-0022.heic?v=1'] }], { site: 'https://s' }).trim().split('\n').length, 1);
  assert.match(googleFeed([{ ...item, images: ['https://x/a.heic', 'https://x/b.png'] }], { site: 'https://s' }), /\thttps:\/\/x\/b\.png\t/);
});

test('an owner invites someone; the link works once and makes a helper', async () => {
  const owner = await signIn(OWNER);
  const page = await (await post('/admin/people/invite', { token: owner.token, email: 'new@rix.example', name: 'New', role: 'helper' }, owner.cookie)).text();
  const link = /value="(https:\/\/rix\.example\/admin\/accept\?link=[^"]+)"/.exec(page)[1].replace('https://rix.example', base);
  const accepted = await fetch(link.replace('?link=', '?link='), { redirect: 'manual' });
  assert.match(await accepted.text(), /Join Rix Racing/);
  const raw = new URL(link).searchParams.get('link');
  const made = await post('/admin/accept', { link: raw, name: 'New', password: 'new-password-1' });
  assert.equal(made.status, 303);
  assert.equal(shop.accounts.list().find((one) => one.email === 'new@rix.example').role, 'helper');
  const again = await post('/admin/accept', { link: raw, name: 'New', password: 'new-password-1' });
  assert.equal(again.status, 422);
  const helper = await signIn(HELPER);
  const refused = await post('/admin/people/invite', { token: helper.token, email: 'x@rix.example', role: 'owner' }, helper.cookie);
  assert.equal(refused.status, 303);
  assert.equal(shop.accounts.list().some((one) => one.email === 'x@rix.example'), false);
});
