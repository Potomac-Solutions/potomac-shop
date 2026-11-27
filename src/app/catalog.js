// The catalog service: what the pages and scripts call. It knows SQL and the domain rules, and
// nothing about HTTP. Every change writes an activity entry in the same transaction.

import { transaction } from '../infra/db.js';
import { readExport } from '../domain/sources.js';
import { fits, fromTitle } from '../domain/fitment.js';
import { googleFeed, metaFeed, ourCsv, shopifyCsv } from '../domain/exports.js';
import * as rules from '../domain/items.js';
import { slugify } from '../domain/text.js';

const COLUMNS = {
  sku: 'sku', handle: 'handle', title: 'title', description: 'description', priceCents: 'price_cents', compareAtCents: 'compare_at_cents',
  quantity: 'quantity', condition: 'condition', category: 'category', brand: 'brand', mpn: 'mpn', gtin: 'gtin', weightGrams: 'weight_grams',
  images: 'images', fitment: 'fitment', status: 'status', heldUntil: 'held_until', soldCents: 'sold_cents', soldAt: 'sold_at', soldVia: 'sold_via',
  lotId: 'lot_id', source: 'source', parentId: 'parent_id', option: 'option_label', madeToOrder: 'made_to_order',
};
const JSON_FIELDS = new Set(['images', 'fitment']);

/** A stored row to the item shape the domain and pages use. */
export function itemFromRow(row) {
  if (!row) return null;
  const item = { id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, lotName: row.lot_name ?? '' };
  for (const [field, column] of Object.entries(COLUMNS)) item[field] = JSON_FIELDS.has(field) ? JSON.parse(row[column] ?? '[]') : row[column];
  item.madeToOrder = Boolean(item.madeToOrder);
  return item;
}

const toColumnValue = (field, value) => (JSON_FIELDS.has(field) ? JSON.stringify(value ?? []) : field === 'madeToOrder' ? (value ? 1 : 0) : field === 'option' ? String(value ?? '') : value ?? null);

const ACTIONS = { publish: rules.publish, unpublish: rules.unpublish, hold: rules.hold, release: rules.release, sell: rules.sell, soldOnline: rules.soldOnline, archive: rules.archive, restore: rules.restore };

export function createCatalog({ db, now = Date.now }) {
  // A caller already inside a transaction (an order) passes `nested` so its step joins that one.
  const tx = (nested, work) => (nested ? work() : transaction(db, work));
  const select = `SELECT items.*, lots.name AS lot_name FROM items LEFT JOIN lots ON lots.id = items.lot_id`;
  const byId = db.prepare(`${select} WHERE items.id = ?`);
  const bySku = db.prepare(`${select} WHERE items.sku = ?`);
  const byHandle = db.prepare(`${select} WHERE items.handle = ?`);
  const log = db.prepare('INSERT INTO activity (at, who, action, item_id, detail) VALUES (?, ?, ?, ?, ?)');

  function insert(fields, at) {
    const keys = Object.keys(fields);
    const sql = `INSERT INTO items (${keys.map((k) => COLUMNS[k]).join(', ')}, created_at, updated_at) VALUES (${keys.map(() => '?').join(', ')}, ?, ?)`;
    return Number(db.prepare(sql).run(...keys.map((k) => toColumnValue(k, fields[k])), at, at).lastInsertRowid);
  }

  function update(id, fields, at) {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    db.prepare(`UPDATE items SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => toColumnValue(k, fields[k])), at, id);
  }

  /** A handle nobody else has: the wanted one, or it with -2, -3... */
  function freeHandle(wanted, ownId = null) {
    const base = slugify(wanted) || 'item';
    for (let n = 1; ; n += 1) {
      const handle = n === 1 ? base : `${base}-${n}`;
      const taken = byHandle.get(handle);
      if (!taken || taken.id === ownId) return handle;
    }
  }

  /** Holds that ran out go back on sale before anything reads the catalog. */
  function sweepHolds() {
    db.prepare("UPDATE items SET status = 'active', held_until = NULL, updated_at = ? WHERE status = 'held' AND held_until <= ?").run(now(), now());
  }

  const fieldsOf = (draft) => ({
    sku: draft.sku, title: draft.title, description: draft.description, priceCents: draft.priceCents, compareAtCents: draft.compareAtCents,
    quantity: draft.quantity, condition: draft.condition, category: draft.category, brand: draft.brand, mpn: draft.mpn, gtin: draft.gtin,
    weightGrams: draft.weightGrams, images: draft.images, fitment: draft.fitment, status: draft.status,
  });

  /** What an import would do, without doing it. */
  function preview(text, options = {}) {
    const { source, drafts } = readExport(text, options);
    const rows = drafts.map((draft) => {
      if (draft.problems.length) return { draft, action: 'skip' };
      const existing = itemFromRow(bySku.get(draft.sku));
      if (!existing) return { draft, action: 'create' };
      if (existing.status === 'sold') return { draft, action: 'skip', reason: 'Already sold here; a file never brings a sold part back.' };
      return { draft, action: 'update', existing };
    });
    const count = (action) => rows.filter((row) => row.action === action).length;
    return { source, rows, creates: count('create'), updates: count('update'), skips: count('skip') };
  }

  /** Import a file: every row that has no problem, in one transaction, as one batch that can be undone. */
  function commit(text, options = {}, { who = 'owner', filename = '' } = {}) {
    const plan = preview(text, options);
    if (!plan.source) return { error: 'unknown-format' };
    if (plan.creates + plan.updates === 0) return { error: 'nothing-to-import', plan };
    const at = now();
    const batchId = transaction(db, () => {
      const batch = Number(db.prepare('INSERT INTO import_batches (source, filename, created_count, updated_count, created_at) VALUES (?, ?, ?, ?, ?)').run(plan.source, filename, plan.creates, plan.updates, at).lastInsertRowid);
      const change = db.prepare('INSERT INTO import_changes (batch_id, item_id, before) VALUES (?, ?, ?)');
      for (const { draft, action, existing } of plan.rows) {
        if (action === 'create') {
          const id = insert({ ...fieldsOf(draft), handle: freeHandle(draft.handle), source: plan.source, lotId: options.lotId ?? null }, at);
          change.run(batch, id, null);
          log.run(at, who, 'imported', id, `Created from ${plan.source} (row ${draft.row})`);
        } else if (action === 'update') {
          const before = bySku.get(draft.sku);
          // A held item keeps its hold; the file can't put it back on sale under someone.
          const fields = fieldsOf(draft);
          if (existing.status === 'held') delete fields.status;
          update(existing.id, fields, at);
          change.run(batch, existing.id, JSON.stringify(before));
          log.run(at, who, 'imported', existing.id, `Updated from ${plan.source} (row ${draft.row})`);
        }
      }
      return batch;
    });
    return { ok: true, batchId, plan };
  }

  /** Take a batch back: created items removed, updated ones put back. Refused if anything in it changed since. */
  function undo(batchId, { who = 'owner' } = {}) {
    const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
    if (!batch) return { error: 'no-batch' };
    if (batch.undone_at) return { error: 'already-undone' };
    const changes = db.prepare('SELECT * FROM import_changes WHERE batch_id = ?').all(batchId);
    const touched = changes.filter((c) => {
      const row = db.prepare('SELECT updated_at FROM items WHERE id = ?').get(c.item_id);
      return row && row.updated_at > batch.created_at;
    });
    if (touched.length) return { error: 'changed-since', count: touched.length };
    const at = now();
    transaction(db, () => {
      for (const c of changes) {
        if (c.before == null) {
          db.prepare('DELETE FROM items WHERE id = ?').run(c.item_id);
          log.run(at, who, 'import undone', c.item_id, `Removed: batch ${batchId} had created it`);
        } else {
          const before = JSON.parse(c.before);
          const columns = Object.keys(before).filter((k) => k !== 'id' && k !== 'lot_name');
          db.prepare(`UPDATE items SET ${columns.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...columns.map((k) => before[k]), c.item_id);
          log.run(at, who, 'import undone', c.item_id, `Put back as it was before batch ${batchId}`);
        }
      }
      db.prepare('UPDATE import_batches SET undone_at = ? WHERE id = ?').run(at, batchId);
    });
    return { ok: true, count: changes.length };
  }

  const batches = () => db.prepare('SELECT * FROM import_batches ORDER BY id DESC LIMIT 20').all();

  /** Items, newest first, narrowed by status, words, and the vehicle a buyer picked. */
  function list({ status = null, q = '', vehicle = null, lotId = null, limit = 500, sizes = false } = {}) {
    sweepHolds();
    // Sizes are bought through the item they are sizes of, so lists show the item, not each size.
    const where = sizes ? [] : ['items.parent_id IS NULL'];
    const args = [];
    if (status) {
      const statuses = [].concat(status);
      where.push(`items.status IN (${statuses.map(() => '?').join(', ')})`);
      args.push(...statuses);
    }
    if (lotId) {
      where.push('items.lot_id = ?');
      args.push(lotId);
    }
    for (const word of String(q).trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
      where.push("(items.title LIKE ? ESCAPE '\\' OR items.sku LIKE ? ESCAPE '\\' OR items.category LIKE ? ESCAPE '\\')");
      const like = `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      args.push(like, like, like);
    }
    const sql = `${select}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY items.updated_at DESC, items.id DESC LIMIT ?`;
    const items = withSizes(db.prepare(sql).all(...args, vehicle ? 5000 : limit).map(itemFromRow));
    return vehicle ? items.filter((item) => fits(item.fitment, vehicle)).slice(0, limit) : items;
  }

  /** Each item with `sizes`: its sizes in the order they were added ([] for an item with none). */
  function withSizes(items) {
    const ids = items.filter((item) => !item.parentId).map((item) => item.id);
    const by = new Map(ids.map((id) => [id, []]));
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      for (const row of db.prepare(`${select} WHERE items.parent_id IN (${chunk.map(() => '?').join(', ')}) ORDER BY items.id`).all(...chunk)) by.get(row.parent_id).push(itemFromRow(row));
    }
    return items.map((item) => (item.parentId ? item : { ...item, sizes: by.get(item.id) ?? [] }));
  }

  function get(idOrHandle) {
    sweepHolds();
    const item = itemFromRow(typeof idOrHandle === 'number' ? byId.get(idOrHandle) : byHandle.get(String(idOrHandle)));
    return item && withSizes([item])[0];
  }

  /**
   * Add a size (or any option) to an item: its own stock and price, the item's title, photos and
   * words. It is on sale whenever the item is.
   */
  function addSize(parentId, { option, priceCents, quantity = 0, madeToOrder = false, sku = '' }, { who = 'owner' } = {}) {
    const label = String(option ?? '').trim().slice(0, 40);
    if (!label) return { error: 'no-option' };
    if (!Number.isInteger(priceCents) || priceCents < 0) return { error: 'bad-price' };
    if (!Number.isInteger(quantity) || quantity < 0) return { error: 'bad-quantity' };
    return transaction(db, () => {
      const parent = itemFromRow(byId.get(parentId));
      if (!parent || parent.parentId) return { error: 'not-found' };
      const taken = db.prepare('SELECT 1 FROM items WHERE parent_id = ? AND option_label = ?').get(parentId, label);
      if (taken) return { error: 'option-taken' };
      const at = now();
      const code = sku || `${parent.sku}-${slugify(label).toUpperCase() || at.toString(36).toUpperCase()}`;
      if (bySku.get(code)) return { error: 'sku-taken' };
      const id = insert({ sku: code, handle: freeHandle(`${parent.handle}-${label}`), title: parent.title, description: '', priceCents, quantity, condition: parent.condition, category: parent.category, brand: parent.brand, images: [], fitment: [], status: 'active', source: 'manual', parentId, option: label, madeToOrder }, at);
      log.run(at, who, 'size added', parentId, label);
      return { ok: true, item: itemFromRow(byId.get(id)) };
    });
  }

  /** Apply one of the domain's actions to an item: publish, hold, sell, archive... */
  function act(id, action, args = {}, { who = 'owner', nested = false } = {}) {
    const rule = ACTIONS[action];
    if (!rule) return { error: 'unknown-action' };
    return tx(nested, () => {
      sweepHolds();
      const found = itemFromRow(byId.get(id));
      const item = found && withSizes([found])[0];
      if (!item) return { error: 'not-found' };
      const result = rule(item, { ...args, now: now() });
      if (result.error) return result;
      update(id, result.patch, now());
      log.run(now(), who, action, id, args.via ? `via ${args.via}` : '');
      return { ok: true, item: itemFromRow(byId.get(id)) };
    });
  }

  /** Change what an item says: title, price, stock, fitment and the rest. Status changes go through `act`. */
  function edit(id, fields, { who = 'owner', nested = false } = {}) {
    const allowed = ['title', 'description', 'priceCents', 'compareAtCents', 'quantity', 'condition', 'category', 'brand', 'mpn', 'gtin', 'weightGrams', 'images', 'fitment', 'lotId', 'option', 'madeToOrder'];
    const patch = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
    if (patch.title != null && !String(patch.title).trim()) return { error: 'no-title' };
    if (patch.priceCents != null && (!Number.isInteger(patch.priceCents) || patch.priceCents < 0)) return { error: 'bad-price' };
    if (patch.quantity != null && (!Number.isInteger(patch.quantity) || patch.quantity < 0)) return { error: 'bad-quantity' };
    return tx(nested, () => {
      const item = itemFromRow(byId.get(id));
      if (!item) return { error: 'not-found' };
      update(id, patch, now());
      log.run(now(), who, 'edited', id, Object.keys(patch).join(', '));
      return { ok: true, item: itemFromRow(byId.get(id)) };
    });
  }

  /** A new item typed in (or drafted from a photo): it starts as a draft. */
  function create(fields, { who = 'owner' } = {}) {
    if (!String(fields.title ?? '').trim()) return { error: 'no-title' };
    if (!Number.isInteger(fields.priceCents) || fields.priceCents < 0) return { error: 'bad-price' };
    if (fields.quantity != null && (!Number.isInteger(fields.quantity) || fields.quantity < 0)) return { error: 'bad-quantity' };
    return transaction(db, () => {
      const at = now();
      const handle = freeHandle(fields.title);
      const sku = fields.sku || `PS-${at.toString(36).toUpperCase()}`;
      if (bySku.get(sku)) return { error: 'sku-taken' };
      const fitment = fields.fitment?.length ? fields.fitment : fromTitle(fields.title);
      const id = insert({ quantity: 1, condition: 'used', images: [], ...fields, fitment, sku, handle, status: 'draft', source: 'manual' }, at);
      log.run(at, who, 'created', id, '');
      return { ok: true, item: itemFromRow(byId.get(id)) };
    });
  }

  function activity({ itemId = null, limit = 50 } = {}) {
    return itemId
      ? db.prepare('SELECT * FROM activity WHERE item_id = ? ORDER BY id DESC LIMIT ?').all(itemId, limit)
      : db.prepare('SELECT activity.*, items.title FROM activity LEFT JOIN items ON items.id = activity.item_id ORDER BY activity.id DESC LIMIT ?').all(limit);
  }

  // Lots: a donor car (or any haul) and what it has paid back.
  function createLot({ name, vin = null, costCents = 0, details = {}, sourceNote = '' }, { who = 'owner' } = {}) {
    if (!String(name ?? '').trim()) return { error: 'no-name' };
    const at = now();
    const id = Number(db.prepare('INSERT INTO lots (name, vin, details, cost_cents, source_note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(name.trim(), vin, JSON.stringify(details), costCents, sourceNote, at).lastInsertRowid);
    log.run(at, who, 'lot created', null, name.trim());
    return { ok: true, id };
  }

  function lots() {
    return db.prepare('SELECT * FROM lots ORDER BY id DESC').all().map((lot) => {
      const shaped = { id: lot.id, name: lot.name, vin: lot.vin, costCents: lot.cost_cents, details: JSON.parse(lot.details), createdAt: lot.created_at };
      return { ...shaped, payoff: rules.payoff(shaped, list({ lotId: lot.id, limit: 5000 })) };
    });
  }

  /** Counts for the dashboard's first screen. */
  function summary() {
    sweepHolds();
    const counts = Object.fromEntries(rules.STATUSES.map((s) => [s, 0]));
    for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM items WHERE parent_id IS NULL GROUP BY status').all()) counts[row.status] = row.n;
    const noPhoto = db.prepare("SELECT COUNT(*) AS n FROM items WHERE parent_id IS NULL AND status = 'active' AND images = '[]'").get().n;
    const noFit = db.prepare("SELECT COUNT(*) AS n FROM items WHERE parent_id IS NULL AND status IN ('active', 'draft') AND fitment = '[]'").get().n;
    return { counts, noPhoto, noFit };
  }

  /** Every export the store offers, by name. */
  function exportAs(kind, { site = '', business = '' } = {}) {
    const items = list({ limit: 100_000 });
    if (kind === 'csv') return ourCsv(items);
    if (kind === 'shopify') return shopifyCsv(items, { vendor: business });
    if (kind === 'google') return googleFeed(items, { site, now: now() });
    if (kind === 'meta') return metaFeed(items, { site, business, now: now() });
    return null;
  }

  return { preview, commit, undo, batches, list, get, addSize, act, edit, create, activity, createLot, lots, summary, exportAs };
}
