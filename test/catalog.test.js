import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, openDatabase } from '../src/infra/db.js';
import { createCatalog } from '../src/app/catalog.js';
import { readExport } from '../src/domain/sources.js';

function setUp() {
  const db = openDatabase(':memory:');
  migrate(db);
  let clock = 1_000_000;
  const catalog = createCatalog({ db, now: () => clock });
  return { db, catalog, tick: (ms = 1000) => (clock += ms), at: () => clock };
}

const SHOPIFY = [
  'Handle,Title,Body (HTML),Vendor,Type,Published,Variant SKU,Variant Inventory Qty,Variant Price,Image Src,Status',
  'shifter,2g 95-99 manual shifter base & shifter OEM,,Rix Racing,Drivetrain,TRUE,RR-1,1,50.00,https://cdn.example/a.png,active',
  'belts,2g 95-99 eclipse or talon gray seat belts,,Rix Racing,Interior,TRUE,RR-2,1,225.00,https://cdn.example/b.png,active',
  'cluster,1991-1994 cluster,,Rix Racing,Interior,TRUE,RR-3,1,45.00,,active',
  'broken,,,Rix Racing,,TRUE,RR-4,1,10.00,,active',
].join('\n');

test('preview shows what would happen and changes nothing', () => {
  const { catalog } = setUp();
  const plan = catalog.preview(SHOPIFY, { ignoreBrand: 'Rix Racing' });
  assert.equal(plan.source, 'shopify');
  assert.deepEqual([plan.creates, plan.updates, plan.skips], [3, 0, 1]);
  assert.equal(catalog.list().length, 0);
});

test('import, re-import updates by SKU, and undo puts everything back', () => {
  const { catalog, tick } = setUp();
  const first = catalog.commit(SHOPIFY, { ignoreBrand: 'Rix Racing' }, { filename: 'products_export.csv' });
  assert.equal(first.ok, true);
  assert.equal(catalog.list().length, 3);
  assert.equal(catalog.get('shifter').priceCents, 5000);

  tick();
  const second = catalog.commit(SHOPIFY.replace('50.00', '55.00'), { ignoreBrand: 'Rix Racing' });
  assert.deepEqual([second.plan.creates, second.plan.updates], [0, 3]);
  assert.equal(catalog.get('shifter').priceCents, 5500);

  tick();
  assert.equal(catalog.undo(second.batchId).ok, true);
  assert.equal(catalog.get('shifter').priceCents, 5000);
  assert.deepEqual(catalog.undo(second.batchId), { error: 'already-undone' });
  tick();
  assert.equal(catalog.undo(first.batchId).ok, true);
  assert.equal(catalog.list().length, 0);
});

test('undo is refused once something in the batch has changed since', () => {
  const { catalog, tick } = setUp();
  const { batchId } = catalog.commit(SHOPIFY);
  tick();
  catalog.act(catalog.get('belts').id, 'sell', { via: 'counter' });
  assert.deepEqual(catalog.undo(batchId), { error: 'changed-since', count: 1 });
});

test('a sold part is never brought back by a file, and a held one keeps its hold', () => {
  const { catalog, tick, at } = setUp();
  catalog.commit(SHOPIFY);
  tick();
  catalog.act(catalog.get('shifter').id, 'sell', { via: 'site' });
  catalog.act(catalog.get('belts').id, 'hold', { until: at() + 60_000 });
  tick();
  const again = catalog.commit(SHOPIFY);
  assert.equal(again.plan.rows.find((r) => r.draft.sku === 'RR-1').action, 'skip');
  assert.equal(catalog.get('shifter').status, 'sold');
  assert.equal(catalog.get('belts').status, 'held');
});

test('holds run out on their own; sold parts leave the feeds’ stock', () => {
  const { catalog, tick, at } = setUp();
  catalog.commit(SHOPIFY);
  const belts = catalog.get('belts');
  catalog.act(belts.id, 'hold', { until: at() + 5_000 });
  assert.equal(catalog.get('belts').status, 'held');
  tick(6_000);
  assert.equal(catalog.get('belts').status, 'active');
  catalog.act(catalog.get('shifter').id, 'sell', {});
  const feed = catalog.exportAs('google', { site: 'https://rix.example' });
  assert.match(feed, /RR-1\t.*out_of_stock/);
  assert.match(feed, /RR-2\t.*in_stock/);
  assert.doesNotMatch(feed, /RR-3/); // no photo, not in the feed
});

test('shop by vehicle, words, and the export reads back in', () => {
  const { catalog } = setUp();
  catalog.commit(SHOPIFY);
  assert.deepEqual(catalog.list({ vehicle: { platform: '1G' } }).map((i) => i.sku), ['RR-3']);
  assert.deepEqual(catalog.list({ vehicle: { platform: '2G', model: 'Talon' } }).map((i) => i.sku).sort(), ['RR-1', 'RR-2']);
  assert.deepEqual(catalog.list({ q: 'belts' }).map((i) => i.sku), ['RR-2']);
  assert.deepEqual(catalog.list({ q: '100%_' }), []);
  const { source, drafts } = readExport(catalog.exportAs('csv'));
  assert.equal(source, 'ours');
  assert.equal(drafts.length, 3);
});

test('new items start as drafts; lots add up what their parts sold for', () => {
  const { catalog } = setUp();
  const lot = catalog.createLot({ name: '1995 Talon TSi AWD donor', costCents: 80000 });
  const part = catalog.create({ title: '2g turbo outlet', priceCents: 15000, lotId: lot.id });
  assert.equal(part.item.status, 'draft');
  assert.deepEqual(catalog.act(part.item.id, 'sell', {}), { error: 'not-for-sale' });
  catalog.act(part.item.id, 'publish');
  catalog.act(part.item.id, 'sell', { via: 'ebay' });
  const [shown] = catalog.lots();
  assert.equal(shown.payoff.soldCents, 15000);
  assert.equal(shown.payoff.net, -65000);
  assert.ok(catalog.activity({ itemId: part.item.id }).some((a) => a.action === 'sell' && a.detail === 'via ebay'));
});
