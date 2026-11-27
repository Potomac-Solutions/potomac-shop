// Reading another platform's product export into our items. Pure: CSV text in, item drafts out.
//
// `detect` names the platform from the file's headers. `readExport` turns the rows into drafts:
//   { sku, handle, title, description, priceCents, compareAtCents, quantity, condition, category,
//     brand, mpn, gtin, weightGrams, images, status, fitment, row, problems }
// A draft with problems is shown in the preview and never imported.
//
// Shopify is read from real exports (the classic columns and the newer ones). WooCommerce,
// BigCommerce and Magento follow their documented export columns and are marked as such in the
// README until a real export from each has been through them.

import { parseCsvObjects } from './csv.js';
import { fromColumn, fromTitle } from './fitment.js';
import { htmlToText, slugify, toCents, unprotect } from './text.js';

export const SOURCES = Object.freeze({
  ours: 'Potomac Shop',
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  bigcommerce: 'BigCommerce',
  magento: 'Magento / Adobe Commerce',
});

const has = (headers, ...names) => names.every((name) => headers.includes(name));

/** Which platform made this export, from its header row; null when we don't recognise it. */
export function detect(headers) {
  if (has(headers, 'sku', 'title', 'price', 'fitment')) return 'ours';
  if (has(headers, 'Handle', 'Variant Price') || has(headers, 'URL handle', 'Price')) return 'shopify';
  if (has(headers, 'Name', 'Regular price') && headers.includes('Type')) return 'woocommerce';
  if (headers.includes('Product Code/SKU') || has(headers, 'Product ID', 'Code', 'Name', 'Price')) return 'bigcommerce';
  if (has(headers, 'sku', 'name', 'price') && (headers.includes('store_view_code') || headers.includes('attribute_set_code'))) return 'magento';
  return null;
}

/** The first non-empty value among a row's columns with these names. */
const pick = (row, ...names) => {
  for (const name of names) {
    const value = row[name];
    if (value != null && String(value).trim() !== '') return unprotect(String(value).trim());
  }
  return '';
};

const yes = (value) => /^(true|yes|1|active|publish|published|visible)$/i.test(String(value ?? '').trim());

const CONDITIONS = { new: 'new', used: 'used', refurbished: 'refurbished' };

/** A condition column's value, or one guessed from the title, or the import's default. */
function conditionOf(value, title, fallback) {
  const said = CONDITIONS[String(value ?? '').trim().toLowerCase()];
  if (said) return said;
  if (/\b(brand\s+)?new\b/i.test(title) && !/\blike\s+new\b/i.test(title)) return 'new';
  return fallback;
}

function weightGrams(value, unit) {
  const n = Number(String(value ?? '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const factor = { g: 1, kg: 1000, lb: 453.592, lbs: 453.592, oz: 28.3495 }[String(unit || 'g').trim().toLowerCase()] ?? 1;
  return Math.round(n * factor);
}

const urlList = (text) => String(text ?? '').split(/[,|]\s*/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));

/** Check a draft and fill in what can be worked out. */
function finish(draft, options) {
  const problems = [];
  if (!draft.title) problems.push('No title.');
  if (draft.priceCents == null) problems.push('No price, or a price that isn’t a number.');
  if (draft.quantity != null && (!Number.isInteger(draft.quantity) || draft.quantity < 0)) problems.push('Quantity isn’t a whole number.');
  const handle = draft.handle || slugify(draft.title);
  const fitment = options.fitment === false ? [] : draft.fitment ?? fromTitle(draft.title);
  return {
    sku: draft.sku || handle,
    handle,
    title: draft.title,
    description: draft.description ?? '',
    priceCents: draft.priceCents,
    compareAtCents: draft.compareAtCents && draft.compareAtCents > (draft.priceCents ?? 0) ? draft.compareAtCents : null,
    quantity: draft.quantity ?? 1,
    condition: draft.condition ?? options.condition,
    category: draft.category ?? '',
    brand: options.ignoreBrand && draft.brand?.toLowerCase() === options.ignoreBrand.toLowerCase() ? '' : (draft.brand ?? ''),
    mpn: draft.mpn ?? '',
    gtin: draft.gtin ?? '',
    weightGrams: draft.weightGrams ?? null,
    images: draft.images ?? [],
    status: draft.status ?? 'active',
    sourceRef: draft.sourceRef ?? '',
    fitment,
    row: draft.row,
    problems,
  };
}

function shopify(rows, options) {
  // One product is several rows with the same handle: the first carries the product, later rows
  // add variants (with their own price) or only another image.
  const byHandle = new Map();
  rows.forEach((row, index) => {
    const handle = pick(row, 'Handle', 'URL handle');
    if (!handle) return;
    if (!byHandle.has(handle)) byHandle.set(handle, { product: row, rows: [] });
    byHandle.get(handle).rows.push({ row, line: index + 2 });
  });
  const drafts = [];
  for (const [handle, { product, rows: group }] of byHandle) {
    const images = group.map(({ row }) => pick(row, 'Image Src', 'Product image URL')).filter(Boolean);
    const title = pick(product, 'Title');
    const variants = group.filter(({ row }) => pick(row, 'Variant Price', 'Price') !== '');
    const many = variants.length > 1;
    const status = pick(product, 'Status').toLowerCase();
    const published = pick(product, 'Published', 'Published on online store');
    for (const [i, { row, line }] of variants.entries()) {
      const option = pick(row, 'Option1 Value', 'Option1 value');
      const named = many && option && option !== 'Default Title';
      drafts.push(finish({
        sku: pick(row, 'Variant SKU', 'SKU') || (many ? `${handle}-${i + 1}` : handle),
        handle: many ? `${handle}-${slugify(option) || i + 1}` : handle,
        title: named ? `${title} – ${option}` : title,
        description: htmlToText(pick(product, 'Body (HTML)', 'Description')),
        priceCents: toCents(pick(row, 'Variant Price', 'Price')),
        compareAtCents: toCents(pick(row, 'Variant Compare At Price', 'Compare-at price')),
        quantity: quantityOf(pick(row, 'Variant Inventory Qty', 'Inventory quantity')),
        condition: conditionOf(pick(product, 'Google Shopping / Condition'), title, options.condition),
        category: pick(product, 'Type', 'Product Category', 'Product category'),
        brand: pick(product, 'Vendor'),
        mpn: pick(row, 'Google Shopping / MPN') || pick(product, 'Google Shopping / MPN'),
        gtin: pick(row, 'Variant Barcode', 'Barcode'),
        weightGrams: weightGrams(pick(row, 'Variant Grams', 'Weight value (grams)'), 'g'),
        images: [pick(row, 'Variant Image', 'Variant image URL'), ...images].filter((src, at, all) => src && all.indexOf(src) === at),
        status: status === 'draft' ? 'draft' : status === 'archived' ? 'archived' : published && !yes(published) ? 'draft' : 'active',
        sourceRef: handle,
        row: line,
      }, options));
    }
  }
  return drafts;
}

/** An inventory count. Blank means "not tracked": for a used part that is one of it. */
function quantityOf(text) {
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : NaN;
}

function woocommerce(rows, options) {
  const parents = new Map();
  for (const row of rows) if (/variable/i.test(row.Type)) {
    parents.set(`id:${row.ID}`, row);
    if (row.SKU) parents.set(row.SKU, row);
  }
  return rows.flatMap((row, index) => {
    const type = String(row.Type ?? '').toLowerCase();
    if (type.includes('variable') || type.includes('grouped') || type.includes('external')) return [];
    const parent = type.includes('variation') ? parents.get(pick(row, 'Parent')) : null;
    const base = parent ? pick(parent, 'Name') : '';
    const attrs = [1, 2, 3].map((n) => pick(row, `Attribute ${n} value(s)`)).filter(Boolean).join(', ');
    const title = pick(row, 'Name') || [base, attrs].filter(Boolean).join(' – ');
    const regular = toCents(pick(row, 'Regular price'));
    const sale = toCents(pick(row, 'Sale price'));
    return [finish({
      sku: pick(row, 'SKU'),
      title,
      description: htmlToText(pick(row, 'Description', 'Short description') || (parent ? pick(parent, 'Description') : '')),
      priceCents: sale ?? regular,
      compareAtCents: sale != null ? regular : null,
      quantity: quantityOf(pick(row, 'Stock')),
      condition: conditionOf('', title, options.condition),
      category: pick(row, 'Categories').split(',')[0]?.split('>').pop()?.trim() ?? '',
      brand: pick(row, 'Brands'),
      gtin: pick(row, 'GTIN, UPC, EAN, or ISBN'),
      weightGrams: weightGrams(pick(row, 'Weight (lbs)'), 'lb') ?? weightGrams(pick(row, 'Weight (kg)'), 'kg'),
      images: urlList(pick(row, 'Images') || (parent ? pick(parent, 'Images') : '')),
      status: yes(pick(row, 'Published')) || pick(row, 'Published') === '' ? 'active' : 'draft',
      row: index + 2,
    }, options)];
  });
}

function bigcommerce(rows, options) {
  return rows.flatMap((row, index) => {
    const kind = pick(row, 'Item Type');
    if (kind && !/^product$/i.test(kind)) return [];
    const title = pick(row, 'Product Name', 'Name');
    const price = toCents(pick(row, 'Price'));
    const sale = toCents(pick(row, 'Sale Price'));
    const images = Object.keys(row).filter((key) => /^(Product Image URL|Product Image File|Image URL)/i.test(key)).map((key) => row[key]).filter((src) => /^https?:\/\//i.test(src));
    return [finish({
      sku: pick(row, 'Product Code/SKU', 'Code'),
      title,
      description: htmlToText(pick(row, 'Product Description', 'Description')),
      priceCents: sale && sale > 0 ? sale : price,
      compareAtCents: sale && sale > 0 ? price : toCents(pick(row, 'Retail Price')),
      quantity: quantityOf(pick(row, 'Current Stock Level', 'Stock Level')),
      condition: conditionOf(pick(row, 'Product Condition', 'Condition'), title, options.condition),
      category: pick(row, 'Category').split(/[;|]/)[0]?.split('/').pop()?.trim() ?? '',
      brand: pick(row, 'Brand Name', 'Brand'),
      mpn: pick(row, 'Manufacturer Part Number', 'MPN'),
      gtin: pick(row, 'Product UPC/EAN', 'GTIN', 'UPC'),
      weightGrams: weightGrams(pick(row, 'Product Weight', 'Weight'), options.weightUnit ?? 'lb'),
      images,
      status: pick(row, 'Product Visible?', 'Product Visible') === '' || yes(pick(row, 'Product Visible?', 'Product Visible')) || /^y$/i.test(pick(row, 'Product Visible?', 'Product Visible')) ? 'active' : 'draft',
      row: index + 2,
    }, options)];
  });
}

function magento(rows, options) {
  const base = String(options.imageBase ?? '').replace(/\/+$/, '');
  const image = (path) => (!path ? '' : /^https?:\/\//i.test(path) ? path : base ? `${base}/${path.replace(/^\/+/, '')}` : '');
  return rows.flatMap((row, index) => {
    if (pick(row, 'store_view_code')) return []; // a store view's translation, not a product
    if (/^(configurable|bundle|grouped)$/i.test(pick(row, 'product_type'))) return [];
    const title = pick(row, 'name');
    const price = toCents(pick(row, 'price'));
    const special = toCents(pick(row, 'special_price'));
    return [finish({
      sku: pick(row, 'sku'),
      handle: slugify(pick(row, 'url_key')),
      title,
      description: htmlToText(pick(row, 'description', 'short_description')),
      priceCents: special ?? price,
      compareAtCents: special != null ? price : null,
      quantity: quantityOf(pick(row, 'qty')),
      condition: conditionOf('', title, options.condition),
      category: pick(row, 'categories').split(',')[0]?.split('/').pop()?.trim() ?? '',
      brand: pick(row, 'manufacturer', 'brand'),
      mpn: pick(row, 'mpn'),
      weightGrams: weightGrams(pick(row, 'weight'), options.weightUnit ?? 'lb'),
      images: [image(pick(row, 'base_image')), ...pick(row, 'additional_images').split(',').map((p) => image(p.trim()))].filter((src, at, all) => src && all.indexOf(src) === at),
      status: pick(row, 'product_online') === '0' ? 'draft' : 'active',
      row: index + 2,
    }, options)];
  });
}

function ours(rows, options) {
  return rows.map((row, index) => finish({
    sku: pick(row, 'sku'),
    handle: pick(row, 'handle'),
    title: pick(row, 'title'),
    description: pick(row, 'description'),
    priceCents: toCents(pick(row, 'price')),
    compareAtCents: toCents(pick(row, 'compare_at')),
    quantity: quantityOf(pick(row, 'quantity')),
    condition: CONDITIONS[pick(row, 'condition').toLowerCase()] ?? options.condition,
    category: pick(row, 'category'),
    brand: pick(row, 'brand'),
    mpn: pick(row, 'mpn'),
    gtin: pick(row, 'gtin'),
    weightGrams: Number(pick(row, 'weight_g')) || null,
    images: urlList(pick(row, 'images')),
    status: ['draft', 'active', 'archived'].includes(pick(row, 'status')) ? pick(row, 'status') : 'active',
    fitment: fromColumn(pick(row, 'fitment')),
    row: index + 2,
  }, options));
}

const READERS = { ours, shopify, woocommerce, bigcommerce, magento };

/**
 * Read an export. `options.condition` is the condition for rows that don't say (a used-parts store
 * says 'used'); `options.ignoreBrand` drops a "brand" that is really the store's own name (Shopify
 * fills Vendor with it); `options.imageBase` is the store address Magento's image paths hang off.
 */
export function readExport(text, options = {}) {
  const settings = { condition: 'used', ...options };
  const { headers, rows } = parseCsvObjects(text);
  const source = settings.source ?? detect(headers);
  if (!source || !READERS[source]) return { source: null, headers, drafts: [] };
  const drafts = READERS[source](rows, settings);
  // Two rows with the same SKU or handle in one file: the later one is a problem, not a silent overwrite.
  const seenSku = new Set();
  const seenHandle = new Set();
  for (const draft of drafts) {
    if (seenSku.has(draft.sku)) draft.problems.push(`SKU ${draft.sku} appears twice in this file.`);
    if (seenHandle.has(draft.handle)) draft.problems.push(`Handle ${draft.handle} appears twice in this file.`);
    seenSku.add(draft.sku);
    seenHandle.add(draft.handle);
  }
  return { source, headers, drafts };
}
