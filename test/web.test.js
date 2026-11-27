import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase } from '../src/infra/db.js';
import { createCatalog } from '../src/app/catalog.js';
import { createWeb } from '../src/web/server.js';
import { readConfig } from '../src/config.js';
import { googleFeed } from '../src/domain/exports.js';

let base;
let server;
let catalog;
const config = readConfig({ PORT: '0', OWNER_PASSWORD: 'test-owner-password', SESSION_SECRET: 'x'.repeat(40), PUBLIC_URL: 'https://rix.example' });

before(async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  catalog = createCatalog({ db });
  catalog.commit('Handle,Title,Variant Price,Variant SKU,Image Src,Status\nbelts,"2g 95-99 seat belts <script>alert(1)</script>",225.00,RR-2,https://cdn.example/b.png,active\n');
  ({ server } = createWeb({ catalog, config }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function signIn() {
  const res = await fetch(`${base}/admin/sign-in`, { method: 'POST', body: new URLSearchParams({ password: 'test-owner-password' }), redirect: 'manual' });
  assert.equal(res.status, 303);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const page = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
  const token = /name="token" value="([^"]+)"/.exec(page)[1];
  return { cookie, token };
}

test('the store escapes what a file brought in and gives Google structured data', async () => {
  const page = await (await fetch(`${base}/parts/belts`)).text();
  assert.ok(!page.includes('<script>alert(1)</script>'));
  assert.ok(page.includes('&lt;script&gt;'));
  assert.match(page, /"@type":"Product"/);
  assert.match(page, /\\u003cscript>/);
});

test('the dashboard needs the owner, a wrong password gets nothing, and forms need their token', async () => {
  assert.equal((await fetch(`${base}/admin`, { redirect: 'manual' })).status, 303);
  const wrong = await fetch(`${base}/admin/sign-in`, { method: 'POST', body: new URLSearchParams({ password: 'nope' }), redirect: 'manual' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get('set-cookie'), null);
  const { cookie, token } = await signIn();
  const id = catalog.get('belts').id;
  const forged = await fetch(`${base}/admin/items/${id}/sell`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ token: 'forged' }), redirect: 'manual' });
  assert.equal(forged.status, 403);
  assert.equal(catalog.get('belts').status, 'active');
  const sold = await fetch(`${base}/admin/items/${id}/sell`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ token }), redirect: 'manual' });
  assert.equal(sold.status, 303);
  assert.equal(catalog.get('belts').status, 'sold');
  const feed = await (await fetch(`${base}/feeds/google.tsv`)).text();
  assert.match(feed, /RR-2\t.*out_of_stock/);
});

test('a notice can only carry words the server signed', async () => {
  const { cookie } = await signIn();
  const page = await (await fetch(`${base}/admin?n=${encodeURIComponent('Send your password to evil')}&s=abc`, { headers: { cookie } })).text();
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
