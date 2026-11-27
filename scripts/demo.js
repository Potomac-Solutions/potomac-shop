// The public demo: wipe the database, import Rix Racing's listings from the fixture (a Shopify
// export, so the demo starts the way a real move off Shopify starts), make the demo sign-ins, add
// a donor car with parts waiting to be listed and one paid order, then start the store. Railway
// runs this with DEMO=1; it resets nightly.
import { readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
process.env.DEMO = '1';
process.env.DATABASE_PATH ??= 'data/demo.db';
// A fresh secret each start is fine for the demo: it resets nightly and signs everyone out anyway.
process.env.SESSION_SECRET ??= randomBytes(32).toString('base64url');

const { readConfig } = await import('../src/config.js');
const { migrate, openDatabase } = await import('../src/infra/db.js');
const { createShop } = await import('../src/app/index.js');
const { DEMO_LOGINS } = await import('../src/web/admin.js');

const config = readConfig();
const file = config.database;
for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
const db = openDatabase(file);
migrate(db);
const day = 86_400_000;
let clock = Date.now() - 10 * day;
const shop = createShop({ db, config, now: () => clock, log: () => {} });
const { catalog, accounts, sales, test } = shop;

// The sign-ins shown on the demo's sign-in page.
await accounts.accept(accounts.setupLink(), { email: DEMO_LOGINS.owner.email, name: DEMO_LOGINS.owner.name, password: DEMO_LOGINS.owner.password });
const owner = accounts.list()[0];
const invited = accounts.invite(owner, { email: DEMO_LOGINS.helper.email, name: DEMO_LOGINS.helper.name, role: 'helper' });
await accounts.accept(invited.token, { name: DEMO_LOGINS.helper.name, password: DEMO_LOGINS.helper.password });

const csv = readFileSync(join(here, '..', 'fixtures', 'rix-racing-shopify.csv'), 'utf8');
const imported = catalog.commit(csv, { ignoreBrand: 'Rix Racing', condition: 'used' }, { who: 'Ricky', filename: 'products_export_1.csv' });
console.log(`Demo: imported ${imported.plan.creates} parts from the Shopify export.`);

// A donor car that came home this week, with some parts already sold and a few waiting to be listed.
clock += 7 * day;
const lot = catalog.createLot({ name: '1995 Talon TSi AWD, Kona Blue', costCents: 120_000, details: { year: 1995, model: 'Talon TSi AWD' } }, { who: 'Ricky' });
for (const [title, price, category] of [
  ['2g 95-99 Talon TSi AWD rear axles pair', 18000, 'Drivetrain'],
  ['2g 95-99 AWD transfer case', 35000, 'Drivetrain'],
  ['2g 95-99 Talon tail light pair', 9000, 'Exterior'],
]) {
  clock += 3_600_000;
  catalog.create({ title, priceCents: price, category, lotId: lot.id }, { who: 'Shop helper' });
}
for (const handle of ['2g-dsm-volk-rear-toe-arms-with-boots-awd', 'act-2100-pressure-plate']) {
  const item = catalog.get(handle);
  if (item) catalog.edit(item.id, { lotId: lot.id }, { who: 'Ricky' });
}
clock += day;
const counter = catalog.get('act-2100-pressure-plate');
if (counter) catalog.act(counter.id, 'sell', { via: 'counter' }, { who: 'Ricky' });

// One part bought online, through the same payment trip a buyer makes (the test page, here).
clock += 3_600_000;
const { newCheckoutKey } = await import('../src/app/sales.js');
const buyer = 'cart:demo-buyer';
await sales.add(buyer, '2g-95-99-manual-shifter-base-shifter-oem', 1);
const bought = await sales.start(buyer, { name: 'Dana Whitfield', email: 'dana@example.com', phone: '304-555-0142', delivery: 'ship', address: '12 Ridge Rd, Elkins, WV 26241' }, { key: newCheckoutKey() });
if (bought.ok) {
  test.approve(new URL(bought.url, 'http://local').searchParams.get('ref'));
  await sales.back(bought.key);
}
const held = catalog.get('2g-quick-connect-manual-harness');
if (held) catalog.act(held.id, 'hold', { until: Date.now() + 2 * day }, { who: 'Ricky' });
db.close();

await import('../src/server.js');
