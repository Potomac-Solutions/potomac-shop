// Listing into a Shopify store that stays the store buyers see. Potomac Shop is where parts are
// photographed, drafted and priced; Shopify is where they're sold online. Stock stays in step:
//
//   a part listed here         → a Shopify product (one variant, by SKU), with its stock
//   a part sold here or at the counter, held, unlisted or removed → Shopify's stock set to zero
//   an order paid on Shopify   → the part marked sold here (and so at the counter)
//
// Two kinds of product, kept apart on purpose:
//   owned     created from here: title, details, price, photos and status are sent with productSet
//   existing  already in Shopify (imported from its CSV, linked by handle): only price and stock
//             are sent. productSet replaces a product's whole variant list, so it is never used on
//             a product made in Shopify, whose other variants it would delete.
//
// Written from Shopify's GraphQL Admin API reference and tested against a faked Shopify; run it on
// a development store before pointing it at a real one.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { buyable } from '../domain/exports.js';
import { centsToAmount } from '../domain/text.js';

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const asHtml = (text) => String(text ?? '').split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
/** The number at the end of a Shopify GID ("gid://shopify/ProductVariant/123" → "123"). */
const numeric = (gid) => String(gid ?? '').split('/').pop();

/**
 * Shopify's Admin GraphQL API for one store. Either a long-lived `token` (an app made in the
 * Shopify admin before 2026), or a Dev Dashboard app's `clientId` and `clientSecret`, exchanged
 * for a token that lasts 24 hours and is fetched again before it runs out.
 */
export function shopifyClient({ store, token = '', clientId = '', clientSecret = '', version = '2026-10', fetch: fetcher = fetch, now = Date.now }) {
  const host = String(store).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(host)) throw new TypeError('SHOPIFY_STORE must be the store’s myshopify.com address');
  let current = token ? { value: token, until: Infinity } : null;

  async function accessToken() {
    if (current && current.until - 60_000 > now()) return current.value;
    if (!clientId || !clientSecret) throw new Error('Shopify needs an access token, or a client ID and secret');
    const response = await fetcher(`https://${host}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.access_token) throw Object.assign(new Error(`Shopify refused the app’s credentials (${data.error_description ?? data.error ?? `HTTP ${response.status}`})`), { status: response.status });
    current = { value: data.access_token, until: now() + Number(data.expires_in ?? 86_399) * 1000 };
    return current.value;
  }

  async function gql(query, variables = {}) {
    const response = await fetcher(`https://${host}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-shopify-access-token': await accessToken() },
      body: JSON.stringify({ query, variables }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) current = token ? current : null;
    if (!response.ok || data.errors?.length) {
      const detail = (data.errors ?? []).map((e) => e.message).join('; ') || `HTTP ${response.status}`;
      throw Object.assign(new Error(detail), { status: response.status });
    }
    return data.data;
  }

  /** Fail on a mutation's userErrors, with Shopify's own words. */
  const checked = (payload) => {
    const errors = payload?.userErrors ?? [];
    if (errors.length) throw new Error(errors.map((e) => e.message).join('; '));
    return payload;
  };

  return { host, gql, checked };
}

const SET_PRODUCT = `mutation set($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
  productSet(input: $input, identifier: $identifier, synchronous: true) {
    product { id variants(first: 1) { nodes { id inventoryItem { id } } } }
    userErrors { field message }
  }
}`;
const FIND_BY_HANDLE = `query find($query: String!) {
  products(first: 1, query: $query) { nodes { id variants(first: 100) { nodes { id sku title inventoryItem { id } } } } }
}`;
const SET_ITEM = `mutation item($id: ID!, $input: InventoryItemInput!) {
  inventoryItemUpdate(id: $id, input: $input) { inventoryItem { id } userErrors { field message } }
}`;
const SET_PRICE = `mutation price($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
  productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id } userErrors { field message } }
}`;
const SET_STOCK = `mutation stock($input: InventorySetQuantitiesInput!, $key: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { id } userErrors { field message } }
}`;
const LOCATION = `query { locations(first: 1) { nodes { id } } }`;
const LEVELS = `query levels($ids: [ID!]!, $location: ID!) {
  nodes(ids: $ids) { ... on InventoryItem { id inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } } }
}`;

/** What Shopify should show in stock: the quantity while it can be bought here, else zero. */
export const shopifyQuantity = (item, now) => (buyable(item, now) ? item.quantity : 0);

export function createShopifySync({ db, catalog, client, locationId = '', webhookSecret = '', site = '', vendor = '', now = Date.now, log = () => {} }) {
  const linkOf = db.prepare('SELECT * FROM shopify_links WHERE item_id = ?');
  let location = locationId ? (locationId.startsWith('gid://') ? locationId : `gid://shopify/Location/${locationId}`) : '';
  let running = null;

  async function where() {
    if (location) return location;
    const data = await client.gql(LOCATION);
    location = data?.locations?.nodes?.[0]?.id ?? '';
    if (!location) throw new Error('The Shopify store has no location to keep stock at');
    return location;
  }

  function due(limit = 25) {
    return db.prepare(`SELECT items.id FROM items LEFT JOIN shopify_links ON shopify_links.item_id = items.id
      WHERE (shopify_links.item_id IS NULL AND items.status IN ('active', 'held'))
         OR (shopify_links.item_id IS NOT NULL AND (shopify_links.needs_push = 1 OR items.updated_at > COALESCE(shopify_links.synced_at, 0)))
      ORDER BY items.updated_at LIMIT ?`).all(limit).map((row) => row.id);
  }

  /** The Shopify product a part imported from Shopify came from, matched by handle (and SKU or option for several variants). */
  async function existing(item) {
    const handle = item.sourceRef || item.handle;
    const data = await client.gql(FIND_BY_HANDLE, { query: `handle:'${handle.replace(/'/g, '')}'` });
    const product = data?.products?.nodes?.[0];
    if (!product) return null;
    const variants = product.variants.nodes;
    const variant = variants.length === 1 ? variants[0] : variants.find((v) => v.sku && v.sku === item.sku) ?? variants.find((v) => item.title.endsWith(` – ${v.title}`));
    return variant ? { product_id: product.id, variant_id: variant.id, inventory_item_id: variant.inventoryItem.id, owned: 0 } : null;
  }

  /** Create or update a product made from here: everything about it is ours. */
  async function sendOwned(item, link) {
    const status = item.status === 'archived' ? 'ARCHIVED' : item.status === 'draft' ? 'DRAFT' : 'ACTIVE';
    const input = {
      title: item.title,
      handle: item.handle,
      descriptionHtml: asHtml(item.description),
      productType: item.category,
      vendor: item.brand || vendor,
      status,
      productOptions: [{ name: 'Title', values: [{ name: 'Default Title' }] }],
      variants: [{
        ...(link?.variant_id ? { id: link.variant_id } : {}),
        optionValues: [{ optionName: 'Title', name: 'Default Title' }],
        price: centsToAmount(item.priceCents),
        compareAtPrice: item.compareAtCents == null ? null : centsToAmount(item.compareAtCents),
        inventoryPolicy: 'DENY',
      }],
      // Photos go up once, when the product is made; Shopify fetches them from our addresses.
      ...(link?.product_id ? {} : { files: item.images.filter((src) => !/\.hei[cf](\?|$)/i.test(src)).slice(0, 10).map((src) => ({ originalSource: src.startsWith('/') ? `${site}${src}` : src, contentType: 'IMAGE' })) }),
    };
    const data = await client.gql(SET_PRODUCT, { input, ...(link?.product_id ? { identifier: { id: link.product_id } } : {}) });
    const product = client.checked(data.productSet).product;
    const variant = product.variants.nodes[0];
    const made = { product_id: product.id, variant_id: variant.id, inventory_item_id: variant.inventoryItem.id, owned: 1 };
    // SKU and stock tracking live on the variant's inventory item.
    client.checked((await client.gql(SET_ITEM, { id: made.inventory_item_id, input: { sku: item.sku, tracked: true } })).inventoryItemUpdate);
    return made;
  }

  /** A product made in Shopify: only its price is ours to change. */
  async function sendExisting(item, link) {
    const data = await client.gql(SET_PRICE, {
      productId: link.product_id,
      variants: [{ id: link.variant_id, price: centsToAmount(item.priceCents), compareAtPrice: item.compareAtCents == null ? null : centsToAmount(item.compareAtCents) }],
    });
    client.checked(data.productVariantsBulkUpdate);
    return link;
  }

  async function setStock(entries, stamp) {
    if (!entries.length) return;
    const at = await where();
    const input = {
      name: 'available',
      reason: 'correction',
      // No compare-and-swap: this store is the one that knows what's left.
      quantities: entries.map(({ inventoryItemId, quantity }) => ({ inventoryItemId, locationId: at, quantity, changeFromQuantity: null })),
    };
    client.checked((await client.gql(SET_STOCK, { input, key: `ps-${stamp}-${randomUUID()}` })).inventorySetQuantities);
  }

  /** Send changed parts to Shopify. Parts imported from Shopify are linked to their product, never duplicated. */
  async function flush() {
    if (running) return running;
    running = (async () => {
      let sent = 0;
      for (let round = 0; round < 20; round += 1) {
        const ids = due();
        if (!ids.length) break;
        const stamp = now();
        const stock = [];
        let failed = false;
        for (const id of ids) {
          const item = catalog.get(id);
          if (!item) continue;
          try {
            let link = linkOf.get(id);
            if (!link?.product_id) {
              const found = item.source === 'shopify' ? await existing(item) : null;
              if (item.source === 'shopify' && !found) throw new Error(`No Shopify product with the handle ${item.sourceRef || item.handle}`);
              link = found ?? null;
            }
            const made = link?.owned === 0 ? await sendExisting(item, link) : await sendOwned(item, link?.product_id ? link : null);
            const quantity = shopifyQuantity(item, stamp);
            db.prepare(`INSERT INTO shopify_links (item_id, product_id, variant_id, inventory_item_id, owned, sent_quantity, needs_push, last_error, synced_at)
              VALUES (?, ?, ?, ?, ?, ?, 0, '', ?)
              ON CONFLICT (item_id) DO UPDATE SET product_id = excluded.product_id, variant_id = excluded.variant_id, inventory_item_id = excluded.inventory_item_id,
                owned = excluded.owned, sent_quantity = excluded.sent_quantity, needs_push = 0, last_error = '', synced_at = excluded.synced_at`)
              .run(id, made.product_id, made.variant_id, made.inventory_item_id, made.owned, quantity, stamp);
            stock.push({ inventoryItemId: made.inventory_item_id, quantity });
            sent += 1;
          } catch (error) {
            failed = true;
            db.prepare(`INSERT INTO shopify_links (item_id, needs_push, last_error, synced_at) VALUES (?, 1, ?, ?)
              ON CONFLICT (item_id) DO UPDATE SET needs_push = 1, last_error = excluded.last_error, synced_at = excluded.synced_at`).run(id, String(error.message).slice(0, 300), stamp);
            log(`Shopify sync: ${item.sku}: ${error.message}`);
            if (error.status === 401 || error.status === 403) break;
          }
        }
        try {
          await setStock(stock, stamp);
        } catch (error) {
          failed = true;
          for (const { inventoryItemId } of stock) db.prepare("UPDATE shopify_links SET needs_push = 1, last_error = ? WHERE inventory_item_id = ?").run(String(error.message).slice(0, 300), inventoryItemId);
          log(`Shopify sync: stock: ${error.message}`);
        }
        if (failed) break;
      }
      return { sent };
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  /** Shopify says a part has `available` left. Fewer than ours: sold there. More while listed: restocked. */
  function counted(link, available) {
    const item = catalog.get(link.item_id);
    if (!item) return { ignore: true };
    const ours = shopifyQuantity(item, now());
    const theirs = Math.max(0, Math.floor(Number(available)));
    if (!Number.isFinite(theirs) || theirs === ours) return { ok: true, same: true };
    if (theirs < ours) {
      const result = catalog.act(item.id, 'sell', { quantity: ours - theirs, via: 'Shopify' }, { who: 'Shopify' });
      if (result.error) log(`Shopify sync: sale of ${item.sku} not recorded (${result.error})`);
      return { ok: true, sold: ours - theirs };
    }
    if (item.status === 'active') {
      catalog.edit(item.id, { quantity: theirs }, { who: 'Shopify' });
      return { ok: true, restocked: theirs };
    }
    db.prepare('UPDATE shopify_links SET needs_push = 1 WHERE item_id = ?').run(item.id);
    return { ok: true, resent: true };
  }

  /** Shopify's webhooks: `orders/paid` marks what sold. Signed with the app's client secret. */
  function heard({ headers, body }) {
    if (!webhookSecret) return { ignore: true };
    const expected = createHmac('sha256', webhookSecret).update(body).digest('base64');
    if (!same(headers['x-shopify-hmac-sha256'] ?? '', expected)) return { error: 'bad-signature' };
    if (headers['x-shopify-topic'] !== 'orders/paid') return { ignore: true };
    let order;
    try {
      order = JSON.parse(body);
    } catch {
      return { ignore: true };
    }
    const results = [];
    for (const line of order.line_items ?? []) {
      const link = db.prepare("SELECT * FROM shopify_links WHERE variant_id = ? OR variant_id LIKE ?").get(`gid://shopify/ProductVariant/${line.variant_id}`, `%/${numeric(line.variant_id)}`);
      if (!link) continue;
      const item = catalog.get(link.item_id);
      if (!item || !(item.status === 'active' || item.status === 'held')) continue;
      const result = catalog.act(item.id, 'sell', { quantity: Math.min(item.quantity, Math.max(1, Number(line.quantity) || 1)), via: 'Shopify', cents: Math.round(Number(line.price) * 100) || item.priceCents }, { who: 'Shopify' });
      results.push({ sku: item.sku, ...result });
    }
    return { ok: true, results };
  }

  /** Read every linked part's stock on Shopify and settle differences (for webhooks that never came). */
  async function reconcile() {
    const links = db.prepare("SELECT * FROM shopify_links WHERE inventory_item_id != '' AND needs_push = 0").all();
    if (!links.length) return { checked: 0 };
    const at = await where();
    for (let i = 0; i < links.length; i += 100) {
      const batch = links.slice(i, i + 100);
      const data = await client.gql(LEVELS, { ids: batch.map((l) => l.inventory_item_id), location: at });
      for (const node of data?.nodes ?? []) {
        const link = batch.find((l) => l.inventory_item_id === node?.id);
        const available = node?.inventoryLevel?.quantities?.find((q) => q.name === 'available')?.quantity;
        if (link && available != null) counted(link, available);
      }
    }
    return { checked: links.length };
  }

  function status() {
    const row = db.prepare("SELECT COUNT(*) AS linked, SUM(owned) AS owned, MAX(synced_at) AS last FROM shopify_links WHERE product_id != ''").get();
    const error = db.prepare("SELECT last_error FROM shopify_links WHERE last_error != '' ORDER BY synced_at DESC LIMIT 1").get()?.last_error ?? '';
    return { store: client.host, linked: row.linked ?? 0, owned: row.owned ?? 0, last: row.last, error, due: due(100_000).length };
  }

  function start({ flushMs = 20_000, reconcileMs = 5 * 60_000 } = {}) {
    const safely = (job) => () => job().catch((error) => log(`Shopify sync: ${error.message}`));
    const timers = [setInterval(safely(flush), flushMs), setInterval(safely(reconcile), reconcileMs)];
    for (const timer of timers) timer.unref?.();
    return () => timers.forEach(clearInterval);
  }

  return { flush, reconcile, heard, counted, status, start, due };
}
