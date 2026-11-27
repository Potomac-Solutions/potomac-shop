// Items out: our own CSV (round-trips through the importer), Shopify's product CSV (so leaving is as
// easy as arriving), and the product feeds Google Merchant Center and Meta's catalog fetch.
// Pure: items in, text out. Items here are the stored shape (see src/app/catalog.js `itemFromRow`).

import { toCsv } from './csv.js';
import { toColumn } from './fitment.js';
import { centsToAmount } from './text.js';

export const OUR_COLUMNS = ['sku', 'handle', 'title', 'description', 'price', 'compare_at', 'quantity', 'condition', 'category', 'brand', 'mpn', 'gtin', 'weight_g', 'images', 'status', 'lot', 'fitment'];

/** Our own CSV. Sold and held items export as active stock of zero and as held: a re-import never resurrects a sale. */
export function ourCsv(items) {
  return toCsv(OUR_COLUMNS, items.map((item) => [
    item.sku,
    item.handle,
    item.title,
    item.description,
    centsToAmount(item.priceCents),
    item.compareAtCents == null ? '' : centsToAmount(item.compareAtCents),
    item.quantity,
    item.condition,
    item.category,
    item.brand,
    item.mpn,
    item.gtin,
    item.weightGrams ?? '',
    item.images.join('|'),
    item.status === 'sold' || item.status === 'held' ? 'archived' : item.status,
    item.lotName ?? '',
    toColumn(item.fitment),
  ]));
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const paragraphs = (text) => String(text ?? '').split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p>${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');

const SHOPIFY_COLUMNS = ['Handle', 'Title', 'Body (HTML)', 'Vendor', 'Type', 'Tags', 'Published', 'Option1 Name', 'Option1 Value', 'Variant SKU', 'Variant Grams', 'Variant Inventory Tracker', 'Variant Inventory Qty', 'Variant Inventory Policy', 'Variant Fulfillment Service', 'Variant Price', 'Variant Compare At Price', 'Variant Requires Shipping', 'Variant Taxable', 'Variant Barcode', 'Image Src', 'Image Position', 'Status'];

/** Shopify's product CSV: one row per item, then a row per extra image. */
export function shopifyCsv(items, { vendor = '' } = {}) {
  const rows = [];
  for (const item of items) {
    const status = item.status === 'active' ? 'active' : item.status === 'draft' ? 'draft' : 'archived';
    rows.push([
      item.handle, item.title, paragraphs(item.description), item.brand || vendor, item.category, '', status === 'active' ? 'TRUE' : 'FALSE',
      'Title', 'Default Title', item.sku, item.weightGrams ?? 0, 'shopify', item.status === 'sold' ? 0 : item.quantity, 'deny', 'manual',
      centsToAmount(item.priceCents), item.compareAtCents == null ? '' : centsToAmount(item.compareAtCents), 'TRUE', 'TRUE', item.gtin,
      item.images[0] ?? '', item.images.length ? 1 : '', status,
    ]);
    item.images.slice(1).forEach((src, i) => {
      const row = Array(SHOPIFY_COLUMNS.length).fill('');
      row[0] = item.handle;
      row[20] = src;
      row[21] = i + 2;
      rows.push(row);
    });
  }
  return toCsv(SHOPIFY_COLUMNS, rows);
}

/** Images a browser and the feeds can show. iPhone HEIC photos can't be shown by most browsers or by Google and Meta. */
export const webImages = (images) => images.filter((src) => !/\.hei[cf](\?|$)/i.test(src));

/** Whether an item can be bought right now: listed, in stock, not held for someone. */
export const buyable = (item, now = Date.now()) =>
  item.status === 'active' && item.quantity > 0 && !(item.heldUntil && item.heldUntil > now);

// Feeds are flat text: no tabs or line breaks inside a value.
const flat = (text, max) => String(text ?? '').replace(/[\t\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

/**
 * Google Merchant Center's tab-separated product feed. Only listed items are in it; an item that
 * sells drops to "out of stock" on the next fetch and leaves the feed when it is archived.
 * A used part with no maker's part number says identifier_exists "no", as Google asks.
 */
export function googleFeed(items, { site, currency = 'USD', now = Date.now() }) {
  const header = ['id', 'title', 'description', 'link', 'image_link', 'additional_image_link', 'availability', 'price', 'sale_price', 'condition', 'brand', 'mpn', 'gtin', 'identifier_exists', 'product_type', 'shipping_weight'];
  const lines = items
    .filter((item) => item.status === 'active' || item.status === 'held' || item.status === 'sold')
    .map((item) => ({ ...item, images: webImages(item.images).map((src) => (src.startsWith('/') ? `${site}${src}` : src)) }))
    .filter((item) => item.images.length > 0)
    .map((item) => {
      const sale = item.compareAtCents != null;
      const known = Boolean(item.mpn || item.gtin);
      return [
        item.sku,
        flat(item.title, 150),
        flat(item.description || item.title, 5000),
        `${site}/parts/${item.handle}`,
        item.images[0],
        item.images.slice(1, 11).join(','),
        buyable(item, now) ? 'in_stock' : 'out_of_stock',
        `${centsToAmount(sale ? item.compareAtCents : item.priceCents)} ${currency}`,
        sale ? `${centsToAmount(item.priceCents)} ${currency}` : '',
        item.condition,
        known ? flat(item.brand, 70) : '',
        flat(item.mpn, 70),
        flat(item.gtin, 50),
        known ? 'yes' : 'no',
        flat(item.category, 750),
        item.weightGrams ? `${item.weightGrams} g` : '',
      ].join('\t');
    });
  return [header.join('\t'), ...lines].join('\n') + '\n';
}

/** Meta's catalog data feed (CSV). Meta asks for a brand on every item; unbranded parts carry the store's name. */
export function metaFeed(items, { site, business, currency = 'USD', now = Date.now() }) {
  const header = ['id', 'title', 'description', 'availability', 'condition', 'price', 'sale_price', 'link', 'image_link', 'additional_image_link', 'brand', 'mpn', 'gtin', 'product_type'];
  const rows = items
    .filter((item) => item.status === 'active' || item.status === 'held' || item.status === 'sold')
    .map((item) => ({ ...item, images: webImages(item.images).map((src) => (src.startsWith('/') ? `${site}${src}` : src)) }))
    .filter((item) => item.images.length > 0)
    .map((item) => {
      const sale = item.compareAtCents != null;
      return [
        item.sku,
        flat(item.title, 200),
        flat(item.description || item.title, 9999),
        buyable(item, now) ? 'in stock' : 'out of stock',
        item.condition,
        `${centsToAmount(sale ? item.compareAtCents : item.priceCents)} ${currency}`,
        sale ? `${centsToAmount(item.priceCents)} ${currency}` : '',
        `${site}/parts/${item.handle}`,
        item.images[0],
        item.images.slice(1, 21).join(','),
        flat(item.brand || business, 100),
        item.mpn,
        item.gtin,
        item.category,
      ];
    });
  return toCsv(header, rows);
}
