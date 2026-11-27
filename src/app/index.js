// Everything the web layer and the scripts need, built from one open database.
import { createCatalog } from './catalog.js';
import { createSales } from './sales.js';
import { createPhotos } from './photos.js';
import { createDrafts } from './drafts.js';
import { createAccounts } from './accounts.js';
import { choosePayments, createPayments } from './payments.js';
import { shopStore } from '../infra/kit-store.js';

export function createShop({ db, config, now = Date.now, fetch: fetcher = fetch, log = console.log }) {
  const catalog = createCatalog({ db, now });
  const accounts = createAccounts({ db, secure: config.production, now });
  // The kit's documents (carts, checkouts, orders, payments) in this database; its `items` are the shop's own.
  const store = shopStore(db, { now });
  const platform = choosePayments(config.env ?? {}, { fetch: fetcher });
  // A let-go checkout is only asked about, never charged (see createPayments).
  let sales;
  const pay = createPayments({ store, provider: platform.provider, now, wanted: (id) => (sales ? sales.wanted(id) : true) });
  sales = createSales({ store, catalog, pay, site: config.publicUrl, now, log });
  const photos = createPhotos({ db, catalog, now });
  const drafts = createDrafts({ db, catalog, photos, ...config.ai, fetch: fetcher, now, business: config.business });
  return { db, store, catalog, accounts, platform, test: platform.test, pay, sales, photos, drafts };
}
