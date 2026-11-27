import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { migrate, openDatabase } from '../src/infra/db.js';
import { createCatalog } from '../src/app/catalog.js';
import { createPosSync, squareCatalog } from '../src/app/pos.js';

/** A Square that keeps an item library and counts in memory, answering the calls pos.js makes. */
function fakeSquare({ fail = false } = {}) {
  const objects = new Map();
  const counts = new Map(); // variation id → quantity
  const calls = [];
  let next = 1;
  let version = 1000;
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body);
    calls.push({ path, body, headers: init.headers });
    const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (fail) return reply(401, { errors: [{ code: 'UNAUTHORIZED', detail: 'This request could not be authorized.' }] });
    if (path === '/v2/catalog/batch-upsert') {
      const id_mappings = [];
      const out = [];
      const real = (id) => {
        if (!id.startsWith('#')) return id;
        const made = `SQ${next++}`;
        id_mappings.push({ client_object_id: id, object_id: made });
        return made;
      };
      for (const item of body.batches[0].objects) {
        const existing = item.id.startsWith('#') ? null : objects.get(item.id);
        if (existing && existing.version !== item.version) return reply(400, { errors: [{ code: 'VERSION_MISMATCH', detail: 'Object version does not match.' }] });
        const itemId = real(item.id);
        const variations = item.item_data.variations.map((v) => ({ ...v, id: real(v.id), version: ++version, item_variation_data: { ...v.item_variation_data, item_id: itemId } }));
        const saved = { ...item, id: itemId, version: ++version, item_data: { ...item.item_data, variations } };
        objects.set(itemId, saved);
        out.push(saved);
      }
      return reply(200, { objects: out, id_mappings });
    }
    if (path === '/v2/catalog/batch-retrieve') return reply(200, { objects: body.object_ids.map((id) => objects.get(id)).filter(Boolean) });
    if (path === '/v2/inventory/changes/batch-create') {
      for (const change of body.changes) counts.set(change.physical_count.catalog_object_id, Number(change.physical_count.quantity));
      return reply(200, { counts: [] });
    }
    if (path === '/v2/inventory/counts/batch-retrieve') {
      return reply(200, { counts: body.catalog_object_ids.filter((id) => counts.has(id)).map((id) => ({ catalog_object_id: id, catalog_object_type: 'ITEM_VARIATION', state: 'IN_STOCK', location_id: 'LOC1', quantity: String(counts.get(id)) })) });
    }
    return reply(404, {});
  };
  return { fetch, objects, counts, calls };
}

function setUp(options) {
  const db = openDatabase(':memory:');
  migrate(db);
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const catalog = createCatalog({ db, now });
  catalog.commit('Handle,Title,Variant Price,Variant SKU,Image Src,Status,Variant Inventory Qty\nbelts,2g 95-99 seat belts,225.00,RR-2,,active,1\nstalk,2g 97-99 stalk,35.00,RR-3,,active,1\ngaskets,1g gasket set,50.00,RR-4,,active,4\ndraft,Not ready,10.00,RR-5,,draft,1\n');
  const sq = fakeSquare(options);
  const pos = createPosSync({ db, catalog, square: squareCatalog({ token: 'EAAA', location: 'LOC1', sandbox: true, fetch: sq.fetch }), webhookKey: 'key', webhookUrl: 'https://rix.example/pay/webhook', now });
  const variationOf = (handle) => db.prepare('SELECT variation_id FROM pos_links WHERE item_id = ?').get(catalog.get(handle).id).variation_id;
  return { db, catalog, pos, sq, tick: (ms = 1000) => (clock += ms), variationOf };
}

const signed = (body) => ({ headers: { 'x-square-hmacsha256-signature': createHmac('sha256', 'key').update(`https://rix.example/pay/webhook${body}`).digest('base64') }, body });
const countEvent = (variation, quantity) => JSON.stringify({ type: 'inventory.count.updated', data: { object: { inventory_counts: [{ catalog_object_id: variation, catalog_object_type: 'ITEM_VARIATION', state: 'IN_STOCK', location_id: 'LOC1', quantity: String(quantity) }] } } });

test('listed parts go into Square’s item library with their stock; drafts don’t', async () => {
  const { pos, sq, variationOf } = setUp();
  assert.deepEqual(await pos.flush(), { sent: 3 });
  const upsert = sq.calls.find((c) => c.path === '/v2/catalog/batch-upsert');
  assert.equal(upsert.headers.authorization, 'Bearer EAAA');
  const belts = upsert.body.batches[0].objects.find((o) => o.item_data.name === '2g 95-99 seat belts');
  const variation = belts.item_data.variations[0].item_variation_data;
  assert.deepEqual([variation.sku, variation.price_money.amount, variation.track_inventory], ['RR-2', 22500, true]);
  assert.equal(sq.counts.get(variationOf('belts')), 1);
  assert.equal(sq.counts.get(variationOf('gaskets')), 4);
  assert.ok(![...sq.objects.values()].some((o) => o.item_data.name === 'Not ready'));
  assert.deepEqual(await pos.flush(), { sent: 0 });
});

test('a price change here is sent again with Square’s versions, keeping stock tracking on', async () => {
  const { pos, sq, catalog, tick } = setUp();
  await pos.flush();
  tick();
  catalog.edit(catalog.get('stalk').id, { priceCents: 4000 });
  assert.deepEqual(await pos.flush(), { sent: 1 });
  const last = sq.calls.filter((c) => c.path === '/v2/catalog/batch-upsert').at(-1).body.batches[0].objects[0];
  assert.ok(last.version);
  assert.ok(last.item_data.variations[0].version);
  assert.equal(last.item_data.variations[0].item_variation_data.price_money.amount, 4000);
  assert.equal(last.item_data.variations[0].item_variation_data.track_inventory, true);
});

test('a sale at the counter marks the part sold here, out of the store and feeds', async () => {
  const { pos, catalog, variationOf } = setUp();
  await pos.flush();
  assert.deepEqual(pos.heard({ headers: { 'x-square-hmacsha256-signature': 'forged' }, body: countEvent(variationOf('belts'), 0) }), { error: 'bad-signature' });
  assert.equal(catalog.get('belts').status, 'active');
  pos.heard(signed(countEvent(variationOf('belts'), 0)));
  const belts = catalog.get('belts');
  assert.deepEqual([belts.status, belts.soldVia], ['sold', 'counter (Square)']);
  // Our own count coming back to us changes nothing.
  pos.heard(signed(countEvent(variationOf('stalk'), 1)));
  assert.equal(catalog.get('stalk').status, 'active');
  // Two of four gaskets sold at the counter.
  pos.heard(signed(countEvent(variationOf('gaskets'), 2)));
  assert.deepEqual([catalog.get('gaskets').quantity, catalog.get('gaskets').status], [2, 'active']);
});

test('a sale here sets the counter’s stock to zero; a restock there raises ours', async () => {
  const { pos, catalog, sq, tick, variationOf } = setUp();
  await pos.flush();
  tick();
  catalog.act(catalog.get('stalk').id, 'sell', { via: 'site' });
  await pos.flush();
  assert.equal(sq.counts.get(variationOf('stalk')), 0);
  pos.heard(signed(countEvent(variationOf('gaskets'), 9)));
  assert.equal(catalog.get('gaskets').quantity, 9);
});

test('reconcile catches a counter sale whose webhook never came', async () => {
  const { pos, catalog, sq, variationOf } = setUp();
  await pos.flush();
  sq.counts.set(variationOf('belts'), 0);
  assert.deepEqual(await pos.reconcile(), { checked: 3 });
  assert.equal(catalog.get('belts').status, 'sold');
});

test('when Square refuses, the parts stay waiting and the reason is shown', async () => {
  const { pos } = setUp({ fail: true });
  assert.deepEqual(await pos.flush(), { sent: 0 });
  const status = pos.status();
  assert.equal(status.due, 3);
  assert.match(status.error, /could not be authorized/);
});

test('an item changed in Square’s dashboard is sent again with Square’s new version', async () => {
  const { pos, sq, catalog, tick } = setUp();
  await pos.flush();
  // Someone edits the stalk in Square: its version moves on.
  const [id, object] = [...sq.objects].find(([, o]) => o.item_data.name === '2g 97-99 stalk');
  sq.objects.set(id, { ...object, version: object.version + 50, item_data: { ...object.item_data, name: 'renamed at the counter' } });
  tick();
  catalog.edit(catalog.get('stalk').id, { priceCents: 3900 });
  assert.deepEqual(await pos.flush(), { sent: 1 });
  assert.equal(sq.objects.get(id).item_data.name, '2g 97-99 stalk');
  assert.equal(pos.status().error, '');
});
