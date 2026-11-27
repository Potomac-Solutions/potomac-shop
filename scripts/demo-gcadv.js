// The Garrett County Adventures shop, as a demo: Potomac Shop beside garrettcountyadventures.com
// in that site's theme, with stickers we mail ourselves and a tee, hat and the seasonal guide that
// the (test) printers make. Prices are placeholders; nothing is really sold.
import { rmSync } from 'node:fs';

process.env.DEMO = '1';
process.env.STORE_THEME ??= 'gcadv';
process.env.SITE_URL ??= 'https://garrettcountyadventures.com';
process.env.DATABASE_PATH ??= 'data/demo-gcadv.db';
process.env.SESSION_SECRET ??= (await import('node:crypto')).randomBytes(32).toString('base64url');

const { readConfig } = await import('../src/config.js');
const { migrate, openDatabase } = await import('../src/infra/db.js');
const { createShop } = await import('../src/app/index.js');

const config = readConfig();
for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.database}${suffix}`, { force: true });
const db = openDatabase(config.database);
migrate(db);
const shop = createShop({ db, config, log: () => {} });
const { catalog, accounts } = shop;

const logins = config.theme.demoLogins;
await accounts.accept(accounts.setupLink(), { email: logins.owner.email, name: logins.owner.name, password: logins.owner.password });
const invited = accounts.invite(accounts.list()[0], { email: logins.helper.email, name: logins.helper.name, role: 'helper' });
await accounts.accept(invited.token, { name: logins.helper.name, password: logins.helper.password });
// One paid order, through the same trip a buyer makes, so the Orders page has something to send to the printer.
const { newCheckoutKey } = await import('../src/app/sales.js');

const art = (name) => [`/static/themes/gcadv/${name}.svg`];
const listed = (result) => {
  if (result.error) throw new Error(result.error);
  catalog.act(result.item.id, 'publish');
  return result.item;
};

listed(catalog.create({ title: 'Trail sticker pack', priceCents: 600, quantity: 40, condition: 'new', category: 'Stickers', images: art('sticker'), description: 'Four weatherproof vinyl stickers for the water bottle, the cooler and the back window of the car that knows every county road.' }));

const tee = catalog.create({ title: 'Garrett County Adventures tee', priceCents: 2600, quantity: 0, condition: 'new', category: 'Shirts', images: art('tee'), maker: 'printful', costCents: 1350, description: 'A soft everyday tee with the rolling-hills mark on the front. Good for the trail, the lake and the drive home.' });
for (const [option, ref] of [['S', '5001'], ['M', '5002'], ['L', '5003'], ['XL', '5004'], ['2XL', '5005']]) catalog.addSize(tee.item.id, { option, priceCents: option === '2XL' ? 2900 : 2600, makerRef: ref });
listed(tee);

listed(catalog.create({ title: 'Trail hat', priceCents: 2400, quantity: 0, condition: 'new', category: 'Hats', images: art('hat'), maker: 'printful', makerRef: '5101', costCents: 1500, description: 'A low-profile hat with an embroidered patch. Keeps the sun off at the overlook and the drizzle off at Swallow Falls.' }));

listed(catalog.create({ title: 'Garrett County through the seasons', priceCents: 2400, quantity: 0, condition: 'new', category: 'Books', images: art('book'), maker: 'lulu', costCents: 900,
  makerRef: JSON.stringify({ pod_package_id: '0550X0850BWSTDPB060UW444GXX', cover: 'https://example.com/cover.pdf', interior: 'https://example.com/interior.pdf', page_count: 120 }),
  description: 'A printed field guide to the county through the year: where to go each season, trails, waterfalls, small towns and the places beyond the lake.' }));

const buyer = 'cart:demo-buyer';
await shop.sales.add(buyer, catalog.get(tee.item.id).sizes[1].handle, 1);
await shop.sales.add(buyer, 'trail-sticker-pack', 2);
const form = { name: 'Dana Whitfield', email: 'dana@example.com', phone: '304-555-0142', delivery: 'ship', street1: '12 Ridge Rd', city: 'Elkins', state: 'WV', zip: '26241' };
const review = await shop.sales.review(buyer, form);
const bought = await shop.sales.start(buyer, form, { key: newCheckoutKey(), expect: review.cents });
if (bought.ok) {
  shop.test.approve(new URL(bought.url, 'http://local').searchParams.get('ref'));
  await shop.sales.back(bought.key);
}

console.log('Demo: Garrett County Adventures shop seeded.');
db.close();
await import('../src/server.js');
