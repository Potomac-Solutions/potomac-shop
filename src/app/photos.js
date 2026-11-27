// Photos taken in the yard, kept with the database (so a backup has them, and the demo needs no
// disk). The type is read from the bytes, never from what the browser claimed.

export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** What kind of image these bytes are, or null. HEIC is named so the page can say what to do. */
export function sniff(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length > 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (bytes.length > 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)$/.test(bytes.subarray(8, 12).toString('latin1'))) return 'image/heic';
  return null;
}

export const photoPath = (id, type) => `/media/${id}.${EXT[type]}`;

export function createPhotos({ db, catalog, now = Date.now }) {
  /** Add photos to an item, in order. Answers { ok, added } or { error }. Nothing is kept if any is refused. */
  function add(itemId, files, { who = 'owner' } = {}) {
    const item = catalog.get(itemId);
    if (!item) return { error: 'not-found' };
    const kinds = files.map((file) => sniff(file.bytes));
    if (kinds.includes('image/heic')) return { error: 'heic' };
    if (kinds.some((kind) => !kind)) return { error: 'not-image' };
    if (files.some((file) => file.bytes.length > MAX_PHOTO_BYTES)) return { error: 'too-big' };
    if (item.images.length + files.length > 24) return { error: 'too-many' };
    const insert = db.prepare('INSERT INTO photos (item_id, type, bytes, created_at) VALUES (?, ?, ?, ?)');
    const added = files.map((file, i) => photoPath(Number(insert.run(itemId, kinds[i], file.bytes, now()).lastInsertRowid), kinds[i]));
    const result = catalog.edit(itemId, { images: [...item.images, ...added] }, { who });
    return result.error ? result : { ok: true, added };
  }

  /** A photo's bytes, for /media/<id>.<ext>. */
  function get(id) {
    const row = db.prepare('SELECT type, bytes FROM photos WHERE id = ?').get(id);
    return row ? { type: row.type, bytes: Buffer.from(row.bytes) } : null;
  }

  /** The photos stored here for an item, as data an AI draft can read (largest first left out past `max`). */
  function forItem(item, { max = 4, maxBytes = 3_700_000 } = {}) {
    return item.images
      .map((src) => /^\/media\/(\d+)\./.exec(src)?.[1])
      .filter(Boolean)
      .map((id) => get(Number(id)))
      .filter((photo) => photo && photo.bytes.length <= maxBytes)
      .slice(0, max);
  }

  /** Take one photo off an item (the stored copy goes too). */
  function remove(itemId, src, { who = 'owner' } = {}) {
    const item = catalog.get(itemId);
    if (!item || !item.images.includes(src)) return { error: 'not-found' };
    const id = /^\/media\/(\d+)\./.exec(src)?.[1];
    if (id) db.prepare('DELETE FROM photos WHERE id = ? AND item_id = ?').run(Number(id), itemId);
    return catalog.edit(itemId, { images: item.images.filter((one) => one !== src) }, { who });
  }

  return { add, get, forItem, remove };
}
