// Everything the web layer and the scripts need, built from one open database.
import { createCatalog } from './catalog.js';
import { createOrders } from './orders.js';
import { createPhotos } from './photos.js';
import { createDrafts } from './drafts.js';
import { createAccounts } from './accounts.js';
import { choosePayments, createPayments } from './payments.js';

export function createShop({ db, config, now = Date.now, fetch: fetcher = fetch, log = console.log }) {
  const catalog = createCatalog({ db, now });
  const accounts = createAccounts({ db, secure: config.production, now });
  const platform = choosePayments(config.env ?? {}, { fetch: fetcher });
  const payments = createPayments({ db, provider: platform.provider, now });
  const orders = createOrders({ db, catalog, payments, site: config.publicUrl, now, log });
  const photos = createPhotos({ db, catalog, now });
  const drafts = createDrafts({ db, catalog, photos, ...config.ai, fetch: fetcher, now, business: config.business });
  return { db, catalog, accounts, platform, test: platform.test, payments, orders, photos, drafts };
}
