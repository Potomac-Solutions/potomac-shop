// Everything the web layer and the scripts need, built from one open database.
import { createCatalog } from './catalog.js';
import { createOrders } from './orders.js';
import { createPhotos } from './photos.js';
import { createDrafts } from './drafts.js';
import { createAccounts } from './accounts.js';
import { choosePayments, createPayments } from './payments.js';
import { createPosSync, squareCatalog } from './pos.js';

export function createShop({ db, config, now = Date.now, fetch: fetcher = fetch, log = console.log }) {
  const catalog = createCatalog({ db, now });
  const accounts = createAccounts({ db, secure: config.production, now });
  const platform = choosePayments(config.env ?? {}, { fetch: fetcher });
  const payments = createPayments({ db, provider: platform.provider, now });
  const orders = createOrders({ db, catalog, payments, site: config.publicUrl, now, log });
  const photos = createPhotos({ db, catalog, now });
  const drafts = createDrafts({ db, catalog, photos, ...config.ai, fetch: fetcher, now, business: config.business });
  // Stock with the counter: POS_SYNC=square, on the same Square account as payments.
  const env = config.env ?? {};
  const pos = String(env.POS_SYNC ?? '').trim().toLowerCase() === 'square' && env.PAY_SQUARE_TOKEN && env.PAY_SQUARE_LOCATION
    ? createPosSync({
        db,
        catalog,
        square: squareCatalog({ token: env.PAY_SQUARE_TOKEN.trim(), location: env.PAY_SQUARE_LOCATION.trim(), sandbox: /^(1|true|yes)$/i.test(String(env.PAY_SQUARE_SANDBOX ?? '')), ...(env.PAY_SQUARE_VERSION ? { version: env.PAY_SQUARE_VERSION.trim() } : {}), fetch: fetcher }),
        webhookKey: (env.PAY_SQUARE_WEBHOOK_KEY ?? '').trim(),
        webhookUrl: (env.PAY_SQUARE_WEBHOOK_URL ?? '').trim(),
        now,
        log,
      })
    : null;
  return { db, catalog, accounts, platform, test: platform.test, payments, orders, photos, drafts, pos };
}
