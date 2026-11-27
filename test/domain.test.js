import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell, parseCsv, parseCsvObjects, toCsv } from '../src/domain/csv.js';
import { htmlToText, slugify, toCents, unprotect } from '../src/domain/text.js';
import { describe as describeFit, fits, fromColumn, fromTitle, toColumn } from '../src/domain/fitment.js';
import { detect, readExport } from '../src/domain/sources.js';
import { googleFeed, metaFeed, ourCsv, shopifyCsv } from '../src/domain/exports.js';
import { hold, payoff, publish, sell } from '../src/domain/items.js';

test('CSV: quotes, commas, line breaks inside quotes, BOM, CRLF', () => {
  const rows = parseCsv('﻿a,b,c\r\n"1,5","say ""hi""","two\nlines"\r\n\r\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1,5', 'say "hi"', 'two\nlines']]);
  const { headers, rows: objects } = parseCsvObjects(' sku ,title\nA,Turbo\n');
  assert.deepEqual(headers, ['sku', 'title']);
  assert.deepEqual(objects, [{ sku: 'A', title: 'Turbo' }]);
});

test('CSV: written cells that a spreadsheet would run are kept as text, and read back as written', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell('-10an fittings'), "'-10an fittings");
  assert.equal(csvCell(-5), '-5');
  const text = toCsv(['title'], [['-10an fittings, 16 valve']]);
  assert.equal(unprotect(parseCsvObjects(text).rows[0].title), '-10an fittings, 16 valve');
});

test('money, slugs and other stores’ HTML', () => {
  assert.equal(toCents('$1,234.5'), 123450);
  assert.equal(toCents('34.95'), 3495);
  assert.equal(toCents('abc'), null);
  assert.equal(toCents(''), null);
  assert.equal(slugify('2G 95-99 Seat Belts & Latches!'), '2g-95-99-seat-belts-and-latches');
  assert.equal(htmlToText('<p>Clean &amp; tested</p><script>alert(1)</script><ul><li>One</li><li>Two&#x27;s</li></ul>'), 'Clean & tested\n• One\n• Two\'s');
});

test('fitment from the way Rix Racing writes titles', () => {
  const cases = [
    ['2g 95-99 manual shifter base & shifter OEM', [{ platform: '2G', from: 1995, to: 1999 }]],
    ['2g 97-99 headlight turn signal switch stalk', [{ platform: '2G', from: 1997, to: 1999 }]],
    ['1991-1994 cluster', [{ platform: '1G', from: 1991, to: 1994 }]],
    ['1G 1990 DSM 6-Bolt 4G63 Oil Filter Housing', [{ platform: '1G', from: 1990, to: 1990 }]],
    ['1ga 1990 sunroof latch assembly', [{ platform: '1G', from: 1990, to: 1990 }]],
    ['1998 Eagle Talon TSI FWD Auto 135k miles', [{ platform: '2G', from: 1998, to: 1998 }]],
    ['2g 1g GVR4 Quick Release Hood Hinges made by FBF', [{ platform: '1G' }, { platform: '2G' }, { platform: 'GVR4' }]],
    ['-10an fittings 16 valve cover DSM', [{ platform: '1G' }, { platform: '2G' }]],
    ['-8an fittings Mitsubishi valve cover blue/black letters', []],
    ['Evo 8/9 intercooler piping', [{ platform: 'EVO89' }]],
    ['Evo X downpipe', [{ platform: 'EVOX' }]],
  ];
  for (const [title, expected] of cases) {
    const got = fromTitle(title);
    assert.equal(got.length, expected.length, title);
    expected.forEach((want, i) => assert.deepEqual(Object.fromEntries(Object.keys(want).map((k) => [k, got[i][k]])), want, title));
  }
  const talon = fromTitle('1995 Eagle Talon TSI AWD roller')[0];
  assert.deepEqual(talon.models, ['Talon']);
  assert.equal(talon.drive, 'AWD');
  assert.equal(describeFit(talon), '1995 Talon (AWD)');
});

test('fitment matches what a buyer picks, and survives our CSV column', () => {
  const belts = fromTitle('2g 95-99 eclipse or talon gray seat belts');
  assert.ok(fits(belts, { platform: '2G', year: 1997 }));
  assert.ok(fits(belts, { platform: '2G', model: 'Talon' }));
  assert.ok(!fits(belts, { platform: '1G' }));
  assert.ok(!fits(fromTitle('1998 Eagle Talon TSI FWD'), { platform: '2G', year: 1998, drive: 'AWD' }));
  for (const title of ['2g 97-99 stalk', '1995 Eagle Talon TSI AWD roller', '2g 1g GVR4 hinges', 'Evo X downpipe']) {
    const fitment = fromTitle(title);
    assert.deepEqual(fromColumn(toColumn(fitment)), fitment, title);
  }
});

const SHOPIFY_CLASSIC = [
  'Handle,Title,Body (HTML),Vendor,Type,Tags,Published,Option1 Name,Option1 Value,Variant SKU,Variant Grams,Variant Inventory Qty,Variant Price,Variant Compare At Price,Variant Barcode,Image Src,Image Position,Status',
  '2g-95-99-manual-shifter-base-shifter-oem,2g 95-99 manual shifter base & shifter OEM,<p>Pulled from a <b>running</b> car</p>,Rix Racing,Drivetrain,,TRUE,Title,Default Title,RR-1001,900,1,50.00,,,https://cdn.example/a.png,1,active',
  '2g-95-99-manual-shifter-base-shifter-oem,,,,,,,,,,,,,,,https://cdn.example/b.png,2,',
  'rix-gaskets,Rix Gasket,,Rix Racing,Gaskets,,TRUE,Size,1G,RG-1,,5,9.00,,,https://cdn.example/g.png,1,active',
  'rix-gaskets,,,,,,,,2G,RG-2,,0,11.00,,,,,',
  'old-draft,Old draft part,,Rix Racing,,,FALSE,Title,Default Title,,,,"1,200.00",1500.00,,,,draft',
].join('\n');

test('Shopify classic export: images gathered, variants split, drafts kept as drafts, store name not a brand', () => {
  const { source, drafts } = readExport(SHOPIFY_CLASSIC, { ignoreBrand: 'Rix Racing' });
  assert.equal(source, 'shopify');
  assert.equal(drafts.length, 4);
  const [shifter, gasket1, gasket2, draft] = drafts;
  assert.equal(shifter.sku, 'RR-1001');
  assert.equal(shifter.priceCents, 5000);
  assert.equal(shifter.description, 'Pulled from a running car');
  assert.deepEqual(shifter.images, ['https://cdn.example/a.png', 'https://cdn.example/b.png']);
  assert.equal(shifter.brand, '');
  assert.equal(shifter.condition, 'used');
  assert.equal(shifter.weightGrams, 900);
  assert.equal(shifter.fitment[0].platform, '2G');
  assert.equal(gasket1.title, 'Rix Gasket – 1G');
  assert.equal(gasket1.handle, 'rix-gaskets-1g');
  assert.equal(gasket2.quantity, 0);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.priceCents, 120000);
  assert.equal(draft.compareAtCents, 150000);
  assert.ok(drafts.every((d) => d.problems.length === 0));
});

test('Shopify newer export columns are read the same way', () => {
  const csv = 'Title,URL handle,Description,Vendor,Type,Published on online store,Status,SKU,Price,Compare-at price,Inventory quantity,Product image URL\n1g Mass Airflow Sensor,1g-mass-airflow-sensor,,Rix Racing,,TRUE,Active,MAF-1,65.00,,,https://cdn.example/maf.png\n';
  const { source, drafts } = readExport(csv);
  assert.equal(source, 'shopify');
  assert.equal(drafts[0].priceCents, 6500);
  assert.equal(drafts[0].quantity, 1);
  assert.equal(drafts[0].fitment[0].platform, '1G');
});

test('problems are reported per row, never imported quietly', () => {
  const csv = 'sku,title,price,fitment\nA,,10,\nB,Turbo,ten,\nB,Turbo again,12,\n';
  const { drafts } = readExport(csv);
  assert.deepEqual(drafts.map((d) => d.problems.length > 0), [true, true, true]);
  assert.match(drafts[2].problems[0], /appears twice/);
});

test('WooCommerce, BigCommerce and Magento exports are recognised and read', () => {
  const woo = 'ID,Type,SKU,Name,Published,Description,Stock,Sale price,Regular price,Categories,Images,Parent,Attribute 1 value(s)\n10,variable,BELT,Seat belt,1,Gray belts,,,,Interior > Belts,https://x/1.jpg,,\n11,variation,BELT-F,,1,,1,,225,,,id:10,Front\n12,simple,MAF,1g MAF,1,,2,60,65,Engine,https://x/2.jpg,,\n';
  const w = readExport(woo);
  assert.equal(w.source, 'woocommerce');
  assert.deepEqual(w.drafts.map((d) => d.title), ['Seat belt – Front', '1g MAF']);
  assert.deepEqual(w.drafts[0].images, ['https://x/1.jpg']);
  assert.equal(w.drafts[1].priceCents, 6000);
  assert.equal(w.drafts[1].compareAtCents, 6500);

  const bc = 'Item Type,Product ID,Product Name,Product Code/SKU,Brand Name,Product Description,Price,Sale Price,Current Stock Level,Category,Product Image URL - 1\nProduct,1,2g Ac condenser,AC-1,,<p>Good</p>,125,0,1,Cooling,https://x/ac.jpg\nSKU,,,AC-1-B,,,,,,,\n';
  const b = readExport(bc);
  assert.equal(b.source, 'bigcommerce');
  assert.equal(b.drafts.length, 1);
  assert.equal(b.drafts[0].priceCents, 12500);
  assert.equal(b.drafts[0].compareAtCents, null);

  const mg = 'sku,store_view_code,attribute_set_code,product_type,name,description,price,special_price,qty,url_key,base_image,additional_images,product_online\nTB-1,,Default,simple,Turbo TD05,,400,,1,turbo-td05,/t/d/td05.jpg,"/t/d/2.jpg,/t/d/3.jpg",1\nTB-1,es,Default,simple,Turbo (es),,,,,,,,\n';
  const m = readExport(mg, { imageBase: 'https://shop.example/media/catalog/product/' });
  assert.equal(m.source, 'magento');
  assert.equal(m.drafts.length, 1);
  assert.deepEqual(m.drafts[0].images, ['https://shop.example/media/catalog/product/t/d/td05.jpg', 'https://shop.example/media/catalog/product/t/d/2.jpg', 'https://shop.example/media/catalog/product/t/d/3.jpg']);
  assert.equal(detect(['foo', 'bar']), null);
});

const stored = (over = {}) => ({
  sku: 'RR-1', handle: 'shifter', title: '-10an valve cover, 16 valve', description: 'Coated black\n\nExposed letters', priceCents: 37500, compareAtCents: null,
  quantity: 1, condition: 'used', category: 'Engine', brand: '', mpn: '', gtin: '', weightGrams: 3000, images: ['https://x/1.png', 'https://x/2.png'],
  status: 'active', heldUntil: null, fitment: fromTitle('16 valve cover DSM'), lotName: '', ...over,
});

test('our CSV round-trips through the importer', () => {
  const items = [stored(), stored({ sku: 'RR-2', handle: 'belts', title: '2g 95-99 belts', compareAtCents: 25000, priceCents: 22500, status: 'draft' })];
  const { source, drafts } = readExport(ourCsv(items));
  assert.equal(source, 'ours');
  for (const [i, draft] of drafts.entries()) {
    for (const key of ['sku', 'handle', 'title', 'description', 'priceCents', 'compareAtCents', 'quantity', 'condition', 'images', 'status', 'fitment']) {
      assert.deepEqual(draft[key], items[i][key], `${key} of ${items[i].sku}`);
    }
  }
});

test('Shopify CSV out reads back in as the same items', () => {
  const items = [stored()];
  const { drafts } = readExport(shopifyCsv(items, { vendor: 'Rix Racing' }), { ignoreBrand: 'Rix Racing' });
  assert.equal(drafts[0].title, items[0].title);
  assert.equal(drafts[0].description, 'Coated black\nExposed letters');
  assert.deepEqual(drafts[0].images, items[0].images);
  assert.equal(drafts[0].priceCents, 37500);
});

test('Google feed: used, no identifiers says so, sold drops out of stock, no image no listing', () => {
  const now = 1_000;
  const feed = googleFeed([stored(), stored({ sku: 'RR-2', status: 'sold', quantity: 0 }), stored({ sku: 'RR-3', images: [] }), stored({ sku: 'RR-4', status: 'held', heldUntil: 5_000 })], { site: 'https://rix.example', now });
  const [header, ...lines] = feed.trim().split('\n').map((line) => line.split('\t'));
  const col = (line, name) => line[header.indexOf(name)];
  assert.equal(lines.length, 3);
  assert.equal(col(lines[0], 'condition'), 'used');
  assert.equal(col(lines[0], 'identifier_exists'), 'no');
  assert.equal(col(lines[0], 'availability'), 'in_stock');
  assert.equal(col(lines[0], 'link'), 'https://rix.example/parts/shifter');
  assert.equal(col(lines[1], 'availability'), 'out_of_stock');
  assert.equal(col(lines[2], 'availability'), 'out_of_stock');
  assert.ok(!feed.includes('Coated black\n'));
});

test('Meta feed gives unbranded parts the store’s name', () => {
  const { rows } = parseCsvObjects(metaFeed([stored()], { site: 'https://rix.example', business: 'Rix Racing' }));
  assert.equal(rows[0].brand, 'Rix Racing');
  assert.equal(rows[0].price, '375.00 USD');
  assert.equal(rows[0].availability, 'in stock');
});

test('items sell once, holds keep others out, lots add up', () => {
  const item = stored();
  assert.deepEqual(publish({ ...item, status: 'draft' }), { ok: true, patch: { status: 'active' } });
  const sold = sell(item, { via: 'counter', now: 9 });
  assert.equal(sold.patch.status, 'sold');
  assert.equal(sold.patch.soldVia, 'counter');
  assert.deepEqual(sell({ ...item, ...sold.patch }, { now: 10 }), { error: 'already-sold' });
  assert.deepEqual(sell({ ...item, quantity: 3 }, { quantity: 2, now: 1 }).patch, { quantity: 1, status: 'active', heldUntil: null });
  assert.deepEqual(hold(item, { until: 5, now: 10 }), { error: 'bad-time' });
  const result = payoff({ costCents: 50000 }, [{ ...item, ...sold.patch }, stored({ priceCents: 10000 })]);
  assert.deepEqual(result, { costCents: 50000, soldCents: 37500, listedCents: 10000, net: -12500, soldCount: 1, count: 2 });
});
