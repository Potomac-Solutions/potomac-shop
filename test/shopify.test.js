import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { migrate, openDatabase } from '../src/infra/db.js';
import { createCatalog } from '../src/app/catalog.js';
import { createShopifySync, shopifyClient } from '../src/app/shopify.js';

/** A Shopify store with products, variants and stock in memory, answering the GraphQL pos.js... shopify.js sends. */
function fakeShopify({ existing = [] } = {}) {
  const products = new Map();
  const stock = new Map(); // inventory item id → available
  const calls = [];
  const tokens = [];
  let next = 1;
  const add = ({ handle, variants }) => {
    const id = `gid://shopify/Product/${next++}`;
    products.set(id, { id, handle, title: handle, variants: variants.map((v) => ({ id: `gid://shopify/ProductVariant/${next++}`, sku: v.sku ?? '', title: v.title ?? 'Default Title', price: v.price ?? '0.00', inventoryItem: { id: `gid://shopify/InventoryItem/${next++}` } })) });
    return products.get(id);
  };
  for (const product of existing) add(product);
  const fetch = async (url, init) => {
    const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/admin/oauth/access_token')) {
      const form = new URLSearchParams(init.body);
      tokens.push(Object.fromEntries(form));
      return form.get('client_secret') === 'secret' ? reply(200, { access_token: `shpca_${tokens.length}`, expires_in: 86399 }) : reply(400, { error: 'invalid_client' });
    }
    const { query, variables } = JSON.parse(init.body);
    calls.push({ query, variables, token: init.headers['x-shopify-access-token'], url });
    if (query.includes('locations(first')) return reply(200, { data: { locations: { nodes: [{ id: 'gid://shopify/Location/77' }] } } });
    if (query.includes('products(first')) {
      const handle = /handle:'([^']+)'/.exec(variables.query)[1];
      const product = [...products.values()].find((p) => p.handle === handle);
      return reply(200, { data: { products: { nodes: product ? [{ id: product.id, variants: { nodes: product.variants } }] : [] } } });
    }
    if (query.includes('productSet(')) {
      const input = variables.input;
      let product = variables.identifier?.id ? products.get(variables.identifier.id) : null;
      if (!product) product = add({ handle: input.handle, variants: [{}] });
      Object.assign(product, { title: input.title, status: input.status, descriptionHtml: input.descriptionHtml, files: input.files ?? product.files });
      product.variants[0].price = input.variants[0].price;
      return reply(200, { data: { productSet: { product: { id: product.id, variants: { nodes: [{ id: product.variants[0].id, inventoryItem: product.variants[0].inventoryItem }] } }, userErrors: [] } } });
    }
    if (query.includes('inventoryItemUpdate')) {
      const variant = [...products.values()].flatMap((p) => p.variants).find((v) => v.inventoryItem.id === variables.id);
      Object.assign(variant, { sku: variables.input.sku, tracked: variables.input.tracked });
      return reply(200, { data: { inventoryItemUpdate: { inventoryItem: { id: variables.id }, userErrors: [] } } });
    }
    if (query.includes('productVariantsBulkUpdate')) {
      for (const v of variables.variants) products.get(variables.productId).variants.find((one) => one.id === v.id).price = v.price;
      return reply(200, { data: { productVariantsBulkUpdate: { productVariants: [], userErrors: [] } } });
    }
    if (query.includes('inventorySetQuantities')) {
      assert.match(query, /@idempotent\(key: \$key\)/);
      for (const q of variables.input.quantities) stock.set(q.inventoryItemId, q.quantity);
      return reply(200, { data: { inventorySetQuantities: { inventoryAdjustmentGroup: { id: 'x' }, userErrors: [] } } });
    }
    if (query.includes('nodes(ids')) {
      return reply(200, { data: { nodes: variables.ids.map((id) => ({ id, inventoryLevel: { quantities: [{ name: 'available', quantity: stock.get(id) ?? 0 }] } })) } });
    }
    return reply(400, { errors: [{ message: 'unknown query' }] });
  };
  return { fetch, products, stock, calls, tokens };
}

function setUp(options) {
  const db = openDatabase(':memory:');
  migrate(db);
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const catalog = createCatalog({ db, now });
  const shop = fakeShopify(options);
  const client = shopifyClient({ store: 'rix-racing.myshopify.com', clientId: 'cid', clientSecret: 'secret', fetch: shop.fetch, now });
  const sync = createShopifySync({ db, catalog, client, webhookSecret: 'secret', site: 'https://rix.example', vendor: 'Rix Racing', now });
  const inventoryOf = (handle) => db.prepare('SELECT inventory_item_id FROM shopify_links WHERE item_id = ?').get(catalog.get(handle).id).inventory_item_id;
  return { db, catalog, sync, shop, tick: (ms = 1000) => (clock += ms), inventoryOf };
}

const signed = (topic, order) => {
  const body = JSON.stringify(order);
  return { headers: { 'x-shopify-topic': topic, 'x-shopify-hmac-sha256': createHmac('sha256', 'secret').update(body).digest('base64') }, body };
};

test('a part listed here becomes a Shopify product with its photos, SKU, price and stock', async () => {
  const { catalog, sync, shop, inventoryOf } = setUp();
  const made = catalog.create({ title: '2g 95-99 AWD transfer case', priceCents: 35000, description: 'Pulled from a 95 Talon.\n\nNo leaks.', images: ['/media/7.jpg'] });
  catalog.act(made.item.id, 'publish');
  assert.deepEqual(await sync.flush(), { sent: 1 });
  assert.deepEqual(shop.tokens[0], { grant_type: 'client_credentials', client_id: 'cid', client_secret: 'secret' });
  const product = [...shop.products.values()][0];
  assert.deepEqual([product.title, product.status, product.variants[0].price, product.variants[0].sku, product.variants[0].tracked], ['2g 95-99 AWD transfer case', 'ACTIVE', '350.00', made.item.sku, true]);
  assert.equal(product.descriptionHtml, '<p>Pulled from a 95 Talon.</p><p>No leaks.</p>');
  assert.deepEqual(product.files, [{ originalSource: 'https://rix.example/media/7.jpg', contentType: 'IMAGE' }]);
  assert.equal(shop.stock.get(inventoryOf(made.item.handle)), 1);
  assert.deepEqual(await sync.flush(), { sent: 0 });
  // One token for every call until it nears its end.
  assert.equal(shop.tokens.length, 1);
});

test('drafts stay here until they’re listed', async () => {
  const { catalog, sync, shop } = setUp();
  catalog.create({ title: 'helper draft', priceCents: 100 });
  assert.deepEqual(await sync.flush(), { sent: 0 });
  assert.equal(shop.products.size, 0);
});

test('a product already in Shopify is linked by handle, never duplicated or rewritten', async () => {
  const { catalog, sync, shop, inventoryOf, tick } = setUp({
    existing: [
      { handle: 'belts', variants: [{ sku: 'RR-2', price: '225.00' }] },
      { handle: 'rix-gaskets', variants: [{ sku: 'RG-1', title: '1G', price: '9.00' }, { sku: 'RG-2', title: '2G', price: '11.00' }] },
    ],
  });
  catalog.commit('Handle,Title,Body (HTML),Variant Price,Variant SKU,Status,Option1 Name,Option1 Value\nbelts,2g 95-99 seat belts,<p><b>Mint</b></p>,225.00,RR-2,active,Title,Default Title\nrix-gaskets,Rix Gasket,,9.00,RG-1,active,Size,1G\nrix-gaskets,,,11.00,RG-2,,,2G\n');
  assert.deepEqual(await sync.flush(), { sent: 3 });
  assert.equal(shop.products.size, 2);
  assert.ok(!shop.calls.some((c) => c.query.includes('productSet(')));
  assert.equal(shop.stock.get(inventoryOf('belts')), 1);
  // A price change here reaches only that variant; the other variant is untouched.
  tick();
  catalog.edit(catalog.get('rix-gaskets-2g').id, { priceCents: 1200 });
  await sync.flush();
  const gaskets = [...shop.products.values()].find((p) => p.handle === 'rix-gaskets');
  assert.deepEqual(gaskets.variants.map((v) => v.price), ['9.00', '12.00']);
});

test('an order paid on Shopify marks the part sold here; a sale here sets Shopify to zero', async () => {
  const { catalog, sync, shop, db, tick, inventoryOf } = setUp();
  for (const title of ['2g 97-99 stalk', '1g gasket set']) catalog.act(catalog.create({ title, priceCents: 3500 }).item.id, 'publish');
  await sync.flush();
  const stalk = catalog.list({ q: 'stalk' })[0];
  const variant = db.prepare('SELECT variant_id FROM shopify_links WHERE item_id = ?').get(stalk.id).variant_id;
  assert.deepEqual(sync.heard({ headers: { 'x-shopify-topic': 'orders/paid', 'x-shopify-hmac-sha256': 'forged' }, body: '{}' }), { error: 'bad-signature' });
  sync.heard(signed('orders/paid', { id: 1, line_items: [{ variant_id: Number(variant.split('/').pop()), quantity: 1, price: '35.00' }] }));
  assert.deepEqual([catalog.get(stalk.id).status, catalog.get(stalk.id).soldVia], ['sold', 'Shopify']);
  tick();
  const gasket = catalog.list({ q: 'gasket' })[0];
  catalog.act(gasket.id, 'sell', { via: 'counter' });
  await sync.flush();
  assert.equal(shop.stock.get(inventoryOf(gasket.handle)), 0);
});

test('reconcile catches a Shopify sale whose webhook never came', async () => {
  const { catalog, sync, shop, inventoryOf } = setUp();
  const part = catalog.create({ title: '2g Ac condenser', priceCents: 12500 });
  catalog.act(part.item.id, 'publish');
  await sync.flush();
  shop.stock.set(inventoryOf(part.item.handle), 0);
  assert.deepEqual(await sync.reconcile(), { checked: 1 });
  assert.equal(catalog.get(part.item.id).status, 'sold');
});

test('refused credentials leave the parts waiting with Shopify’s reason', async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  const catalog = createCatalog({ db });
  catalog.act(catalog.create({ title: 'x part', priceCents: 100 }).item.id, 'publish');
  const shop = fakeShopify();
  const sync = createShopifySync({ db, catalog, client: shopifyClient({ store: 'rix-racing.myshopify.com', clientId: 'cid', clientSecret: 'wrong', fetch: shop.fetch }) });
  assert.deepEqual(await sync.flush(), { sent: 0 });
  assert.match(sync.status().error, /refused the app’s credentials/);
  assert.equal(sync.status().due, 1);
  assert.throws(() => shopifyClient({ store: 'rixracing.com' }), /myshopify\.com/);
});
