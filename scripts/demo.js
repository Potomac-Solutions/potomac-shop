// The public demo: wipe the database, import Rix Racing's listings from the fixture (a Shopify
// export, so the demo starts the way a real move off Shopify starts), add a donor car with parts
// waiting to be listed, then start the store. Railway runs this with DEMO=1; it resets nightly.
import { readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, openDatabase } from '../src/infra/db.js';
import { createCatalog } from '../src/app/catalog.js';

const here = dirname(fileURLToPath(import.meta.url));
process.env.DEMO = '1';
process.env.DATABASE_PATH ??= 'data/demo.db';
process.env.OWNER_PASSWORD ??= 'rix-owner-demo';
// A fresh secret each start is fine for the demo: it resets nightly and signs everyone out anyway.
process.env.SESSION_SECRET ??= randomBytes(32).toString('base64url');
const file = process.env.DATABASE_PATH;

for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
const db = openDatabase(file);
migrate(db);
const day = 86_400_000;
let clock = Date.now() - 10 * day;
const catalog = createCatalog({ db, now: () => clock });

const csv = readFileSync(join(here, '..', 'fixtures', 'rix-racing-shopify.csv'), 'utf8');
const imported = catalog.commit(csv, { ignoreBrand: 'Rix Racing', condition: 'used' }, { who: 'Ricky', filename: 'products_export_1.csv' });
console.log(`Demo: imported ${imported.plan.creates} parts from the Shopify export.`);

// A donor car that came home this week, with some parts already sold and a few waiting to be listed.
clock += 7 * day;
const lot = catalog.createLot({ name: '1995 Talon TSi AWD, Kona Blue', costCents: 120_000, vin: null, details: { year: 1995, model: 'Talon TSi AWD' } }, { who: 'Ricky' });
for (const [title, price, category] of [
  ['2g 95-99 Talon TSi AWD rear axles pair', 18000, 'Drivetrain'],
  ['2g 95-99 AWD transfer case', 35000, 'Drivetrain'],
  ['2g 95-99 Talon tail light pair', 9000, 'Exterior'],
]) {
  clock += 3_600_000;
  catalog.create({ title, priceCents: price, category, lotId: lot.id }, { who: 'Ricky' });
}
for (const handle of ['2g-dsm-volk-rear-toe-arms-with-boots-awd', 'act-2100-pressure-plate']) {
  const item = catalog.get(handle);
  if (!item) continue;
  catalog.edit(item.id, { lotId: lot.id }, { who: 'Ricky' });
}
clock += day;
const sold = catalog.get('act-2100-pressure-plate');
if (sold) catalog.act(sold.id, 'sell', { via: 'counter' }, { who: 'Ricky' });
const held = catalog.get('2g-quick-connect-manual-harness');
if (held) catalog.act(held.id, 'hold', { until: Date.now() + 2 * day }, { who: 'Ricky' });
db.close();

await import('../src/server.js');
