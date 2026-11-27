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
