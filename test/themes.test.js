// A store beside its business's own site: that site's look and words, the auto pack off.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { testMaker } from '@potomac-solutions/kit/fulfill/providers';
import { migrate, openDatabase } from '../src/infra/db.js';
import { createShop } from '../src/app/index.js';
import { createWeb } from '../src/web/server.js';
import { readConfig } from '../src/config.js';
import { themeOf } from '../src/themes.js';

let base;
let server;
let shop;
const config = readConfig({ STORE_THEME: 'gcadv', SITE_URL: 'https://garrettcountyadventures.com/', SESSION_SECRET: 'x'.repeat(40), PUBLIC_URL: 'https://shop.garrettcountyadventures.com' });

before(async () => {
  const db = openDatabase(':memory:');
  migrate(db);
  shop = createShop({ db, config, log: () => {}, makers: { printful: testMaker({ name: 'printful' }) } });
  const tee = shop.catalog.create({ title: 'Trail tee', priceCents: 2600, condition: 'new', maker: 'printful' }).item;
  shop.catalog.addSize(tee.id, { option: 'M', priceCents: 2600, makerRef: '1' });
  shop.catalog.addSize(tee.id, { option: '2XL', priceCents: 2900, makerRef: '2' });
  shop.catalog.act(tee.id, 'publish');
  ({ server } = createWeb({ shop, config }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('a theme is picked by name; anything else is the store this started as', () => {
  assert.equal(themeOf('GCADV').name, 'gcadv');
  assert.equal(themeOf('nope').name, 'rix');
  assert.equal(config.business, 'Garrett County Adventures');
  assert.equal(config.contactEmail, '', 'no contact address is made up');
  assert.equal(config.siteUrl, 'https://garrettcountyadventures.com');
  assert.equal(readConfig({}).theme.auto, true);
});

test('the shop wears the site: its stylesheet, header, footer and words; no car talk', async () => {
  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /href="\/static\/themes\/gcadv\.css"/);
  assert.match(page, /href="https:\/\/garrettcountyadventures\.com\/explore\.html">Adventure map/);
  assert.match(page, /Take a little of Garrett County home\./);
  assert.match(page, /Potomac Solutions/);
  assert.match(page, /href="\/products\/trail-tee"/);
  assert.match(page, /From \$26\.00/);
  assert.doesNotMatch(page, /RIX|DSM|EVO|parts/i);
  const item = await (await fetch(`${base}/products/trail-tee`)).text();
  assert.match(item, /From \$26\.00/);
  assert.match(item, /M \(\$26\.00\)/);
  assert.doesNotMatch(item, /SKU|Fits|DSM/);
  assert.equal((await fetch(`${base}/parts/trail-tee`)).status, 200, 'old addresses still work');
  assert.equal((await fetch(`${base}/static/themes/gcadv/tee.svg`)).status, 200);
});
