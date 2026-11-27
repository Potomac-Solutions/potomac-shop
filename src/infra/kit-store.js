// The kit's store contract over this shop's SQLite file (see the kit's README, "The store"):
//
//   get(collection, key)            one document's fields, or null      (synchronous)
//   under(collection, prefix = '')  [{ key, ...fields }] in key order    (synchronous)
//   write(collection, key, fields)  merge fields; stored before it returns
//
// node:sqlite is synchronous, so a write is on disk before `write` returns, which is what the
// kit's "exactly one wins" checks rest on. Called inside `transaction`, a write is part of it.

export function sqliteStore(db) {
  const one = db.prepare('SELECT fields FROM kit_documents WHERE collection = ? AND key = ?');
  const all = db.prepare('SELECT key, fields FROM kit_documents WHERE collection = ? AND substr(key, 1, length(?)) = ? ORDER BY key');
  const put = db.prepare('INSERT INTO kit_documents (collection, key, fields) VALUES (?, ?, ?) ON CONFLICT (collection, key) DO UPDATE SET fields = excluded.fields');
  const read = (collection, key) => {
    const row = one.get(collection, key);
    return row ? JSON.parse(row.fields) : null;
  };
  return {
    get: (collection, key) => read(String(collection), String(key)),
    under: (collection, prefix = '') => all.all(String(collection), String(prefix), String(prefix)).map((row) => ({ key: row.key, ...JSON.parse(row.fields) })),
    write(collection, key, fields) {
      const merged = { ...read(String(collection), String(key)), ...fields };
      put.run(String(collection), String(key), JSON.stringify(merged));
      return Promise.resolve();
    },
  };
}

/**
 * The kit's store with its `items` collection read from the shop's own `items` table, so the
 * kit's catalog, cart and checkout sell what the dashboard lists and nothing is kept twice.
 *
 *   items/<handle>   { name, unit, cents, left, active }
 *
 * `left` is the item's count, or null for a made-to-order item (it never runs out). An item is
 * on sale when it is listed (a size: when the item it is a size of is listed). An item with sizes
 * isn't bought itself: its sizes are. The kit writes only `left` (checkout taking stock, or putting
 * it back), and that is the only write this store accepts for `items`.
 */
export function shopStore(db, { collection = 'items', now = Date.now, onStock = () => {} } = {}) {
  const docs = sqliteStore(db);
  const byHandle = db.prepare(`SELECT items.*, parent.status AS parent_status,
      (SELECT COUNT(*) FROM items AS size WHERE size.parent_id = items.id) AS size_count
    FROM items LEFT JOIN items AS parent ON parent.id = items.parent_id WHERE items.handle = ?`);
  const handles = db.prepare('SELECT handle FROM items WHERE substr(handle, 1, length(?)) = ? ORDER BY handle');
  const setCount = db.prepare('UPDATE items SET quantity = ?, updated_at = ? WHERE id = ?');

  const view = (row) => {
    if (!row) return null;
    const listed = (row.parent_id ? row.parent_status : row.status) === 'active' && row.size_count === 0;
    return {
      name: row.option_label ? `${row.title} (${row.option_label})` : row.title,
      unit: 'each',
      cents: row.price_cents,
      left: row.made_to_order ? null : row.quantity,
      active: listed,
    };
  };

  return {
    get: (c, key) => (c === collection ? view(byHandle.get(String(key))) : docs.get(c, key)),
    under: (c, prefix = '') => (c === collection ? handles.all(String(prefix), String(prefix)).map(({ handle }) => ({ key: handle, ...view(byHandle.get(handle)) })) : docs.under(c, prefix)),
    write(c, key, fields) {
      if (c !== collection) return docs.write(c, key, fields);
      const row = byHandle.get(String(key));
      const names = Object.keys(fields);
      if (!row || names.length !== 1 || names[0] !== 'left') throw new Error(`The kit may only change an item's count (${key}: ${names.join(', ')})`);
      if (row.made_to_order) return Promise.resolve();
      if (!Number.isInteger(fields.left) || fields.left < 0) throw new Error(`Bad count for ${key}`);
      setCount.run(fields.left, now(), row.id);
      onStock({ id: row.id, handle: row.handle, from: row.quantity, to: fields.left });
      return Promise.resolve();
    },
  };
}
