// Two-way stock with the point of sale at the counter (Square). Parts listed here are created as
// items in Square's item library, so the counter can ring them up; a sale at the counter marks the
// part sold here, which takes it out of the store and the feeds; a sale here sets the counter's
// stock to zero.
//
// Who owns what:
//   this store   title, description, price and photos (sent to Square; edits in Square are overwritten)
//   both         stock: a lower count at the counter is a sale there; anything sold, held, unlisted
//                or removed here counts as zero at the counter
//
// Changes go out by `flush` (run on a timer): every part changed since it was last sent is sent
// again. Changes come in by Square's inventory webhook, and by `reconcile` (a timer too) for any
// webhook that never arrived.
//
// Written from Square's Catalog and Inventory API references and tested against a faked Square;
// run it against Square's sandbox before using it at a real counter.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { buyable } from '../domain/exports.js';

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Square's Catalog and Inventory calls this needs, over plain HTTPS. */
export function squareCatalog({ token, location, sandbox = false, version = '2025-01-23', fetch: fetcher = fetch }) {
  const base = sandbox ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
  async function call(path, body) {
    const response = await fetcher(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'square-version': version, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status >= 300) {
      const detail = (data.errors ?? []).map((e) => e.detail ?? e.code).join('; ') || `HTTP ${response.status}`;
      throw Object.assign(new Error(detail), { status: response.status });
    }
    return data;
  }
  return {
    location,
    /** Create or update items (with their variations). Answers the objects as Square now has them. */
    upsert: (objects) => call('/v2/catalog/batch-upsert', { idempotency_key: randomUUID(), batches: [{ objects }] }),
    /** Items as Square has them now (for their current versions). */
    retrieve: (objectIds) => call('/v2/catalog/batch-retrieve', { object_ids: objectIds, include_related_objects: false }),
    /** Set counts: [{ variationId, quantity }]. */
    setCounts: (counts, now = Date.now()) =>
      call('/v2/inventory/changes/batch-create', {
        idempotency_key: randomUUID(),
        ignore_unchanged_counts: true,
        changes: counts.map(({ variationId, quantity }) => ({
          type: 'PHYSICAL_COUNT',
          physical_count: { catalog_object_id: variationId, location_id: location, state: 'IN_STOCK', quantity: String(quantity), occurred_at: new Date(now).toISOString() },
        })),
      }),
    /** Current in-stock counts at this location for these variations, every page. */
    async counts(variationIds) {
      const all = [];
      for (let i = 0; i < variationIds.length; i += 500) {
        let cursor;
        do {
          const data = await call('/v2/inventory/counts/batch-retrieve', { catalog_object_ids: variationIds.slice(i, i + 500), location_ids: [location], states: ['IN_STOCK'], ...(cursor ? { cursor } : {}) });
          all.push(...(data.counts ?? []));
          cursor = data.cursor;
        } while (cursor);
      }
      return all;
    },
  };
}

/** The Square item (and its one variation) for a part, ready for batch-upsert. */
export function squareObjects(item, link, location) {
  const itemId = link?.object_id || `#item-${item.id}`;
  const variationId = link?.variation_id || `#var-${item.id}`;
  const variation = {
    type: 'ITEM_VARIATION',
    id: variationId,
    ...(link?.variation_version ? { version: link.variation_version } : {}),
    present_at_all_locations: true,
    item_variation_data: {
      item_id: itemId,
      name: 'Regular',
      sku: item.sku.slice(0, 255),
      pricing_type: 'FIXED_PRICING',
      price_money: { amount: item.priceCents, currency: 'USD' },
      // Sent every time: an update without it turns stock tracking off.
      track_inventory: true,
      location_overrides: [{ location_id: location, track_inventory: true }],
    },
  };
  return [{
    type: 'ITEM',
    id: itemId,
    ...(link?.object_version ? { version: link.object_version } : {}),
    present_at_all_locations: true,
    item_data: { name: item.title.slice(0, 512), description: item.description.slice(0, 4096), variations: [variation] },
  }];
}

/** What the counter should show in stock for a part: its quantity while it can be bought here, else zero. */
export const counterQuantity = (item, now) => (buyable(item, now) ? item.quantity : 0);

export function createPosSync({ db, catalog, square, webhookKey = '', webhookUrl = '', now = Date.now, log = () => {} }) {
  const linkOf = db.prepare('SELECT * FROM pos_links WHERE item_id = ?');
  const byVariation = db.prepare('SELECT * FROM pos_links WHERE variation_id = ?');
  let running = null;

  /** Parts to send: listed ones not yet in Square, and any linked part changed since it was sent. */
  function due(limit = 50) {
    return db.prepare(`SELECT items.id FROM items LEFT JOIN pos_links ON pos_links.item_id = items.id
      WHERE (pos_links.item_id IS NULL AND items.status IN ('active', 'held'))
         OR (pos_links.item_id IS NOT NULL AND (pos_links.needs_push = 1 OR items.updated_at > COALESCE(pos_links.synced_at, 0)))
      ORDER BY items.updated_at LIMIT ?`).all(limit).map((row) => row.id);
  }

  /** Send changed parts to Square: their item, then their count. One batch at a time. */
  async function flush() {
    if (running) return running;
    running = (async () => {
      let sent = 0;
      for (let round = 0; round < 20; round += 1) {
        const ids = due();
        if (!ids.length) break;
        const stamp = now();
        const items = ids.map((id) => catalog.get(id)).filter(Boolean);
        try {
          const objects = items.flatMap((item) => squareObjects(item, linkOf.get(item.id), square.location));
          const result = await square.upsert(objects);
          const temp = new Map((result.id_mappings ?? []).map((m) => [m.client_object_id, m.object_id]));
          const saved = new Map((result.objects ?? []).map((o) => [o.id, o]));
          const counts = [];
          for (const item of items) {
            const before = linkOf.get(item.id);
            const objectId = before?.object_id || temp.get(`#item-${item.id}`);
            const variationId = before?.variation_id || temp.get(`#var-${item.id}`);
            const object = saved.get(objectId);
            const variation = object?.item_data?.variations?.find((v) => v.id === variationId);
            const quantity = counterQuantity(item, stamp);
            db.prepare(`INSERT INTO pos_links (item_id, object_id, object_version, variation_id, variation_version, sent_quantity, needs_push, last_error, synced_at)
              VALUES (?, ?, ?, ?, ?, ?, 0, '', ?)
              ON CONFLICT (item_id) DO UPDATE SET object_id = excluded.object_id, object_version = excluded.object_version, variation_id = excluded.variation_id,
                variation_version = excluded.variation_version, sent_quantity = excluded.sent_quantity, needs_push = 0, last_error = '', synced_at = excluded.synced_at`)
              .run(item.id, objectId, object?.version ?? null, variationId, variation?.version ?? null, quantity, stamp);
            counts.push({ variationId, quantity });
          }
          await square.setCounts(counts, stamp);
          sent += items.length;
        } catch (error) {
          // Someone changed these items in Square's dashboard since: take Square's current versions
          // (our title and price still win) and let the next round send again.
          if (/version/i.test(error.message) && error.status < 500) {
            const linked = items.map((item) => linkOf.get(item.id)).filter((link) => link?.object_id);
            try {
              const { objects = [] } = await square.retrieve(linked.map((link) => link.object_id));
              for (const object of objects) {
                const link = linked.find((one) => one.object_id === object.id);
                const variation = object.item_data?.variations?.find((v) => v.id === link?.variation_id);
                if (link) db.prepare('UPDATE pos_links SET object_version = ?, variation_version = ?, needs_push = 1 WHERE item_id = ?').run(object.version ?? null, variation?.version ?? null, link.item_id);
              }
              if (objects.length && round < 19) continue;
            } catch {
              // Fall through: kept due with the reason shown.
            }
          }
          // Keep them due, and say why on the Channels page.
          for (const item of items) {
            db.prepare(`INSERT INTO pos_links (item_id, needs_push, last_error, synced_at) VALUES (?, 1, ?, ?)
              ON CONFLICT (item_id) DO UPDATE SET needs_push = 1, last_error = excluded.last_error`).run(item.id, String(error.message).slice(0, 300), 0);
          }
          log(`Square sync: ${error.message}`);
          break;
        }
      }
      return { sent };
    })();
    try {
      return await running;
    } finally {
      running = null;
    }
  }

  /**
   * What the counter says a part's count is now. Lower than ours: sold at the counter. Higher while
   * the part is listed: restocked there. Anything else here (sold, held, unlisted) wins, and is sent again.
   */
  function counted(variationId, quantity) {
    const link = byVariation.get(variationId);
    if (!link) return { ignore: true };
    const item = catalog.get(link.item_id);
    if (!item) return { ignore: true };
    const ours = counterQuantity(item, now());
    const theirs = Math.max(0, Math.floor(Number(quantity)));
    if (!Number.isFinite(theirs) || theirs === ours) return { ok: true, same: true };
    if (theirs < ours) {
      const result = catalog.act(item.id, 'sell', { quantity: ours - theirs, via: 'counter (Square)' }, { who: 'Square' });
      if (result.error) log(`Square sync: counter sale of ${item.sku} not recorded (${result.error})`);
      return { ok: true, sold: ours - theirs };
    }
    if (item.status === 'active') {
      catalog.edit(item.id, { quantity: theirs }, { who: 'Square' });
      return { ok: true, restocked: theirs };
    }
    db.prepare('UPDATE pos_links SET needs_push = 1 WHERE item_id = ?').run(item.id);
    return { ok: true, resent: true };
  }

  /** Square's inventory webhook. `bad-signature` is a request to refuse. */
  function heard({ headers, body }) {
    if (!webhookKey || !webhookUrl) return { ignore: true };
    const expected = createHmac('sha256', webhookKey).update(webhookUrl + body).digest('base64');
    if (!same(headers['x-square-hmacsha256-signature'] ?? '', expected)) return { error: 'bad-signature' };
    let event;
    try {
      event = JSON.parse(body);
    } catch {
      return { ignore: true };
    }
    if (event?.type !== 'inventory.count.updated') return { ignore: true };
    const counts = event?.data?.object?.inventory_counts ?? [];
    const results = counts
      .filter((c) => c.location_id === square.location && c.state === 'IN_STOCK' && (c.catalog_object_type ?? 'ITEM_VARIATION') === 'ITEM_VARIATION')
      .map((c) => counted(c.catalog_object_id, c.quantity));
    return { ok: true, results };
  }

  /** Read every linked part's count from Square and settle differences (for webhooks that never came). */
  async function reconcile() {
    const links = db.prepare("SELECT variation_id FROM pos_links WHERE variation_id != '' AND needs_push = 0").all().map((row) => row.variation_id);
    if (!links.length) return { checked: 0 };
    const counts = await square.counts(links);
    const seen = new Set();
    for (const c of counts) {
      seen.add(c.catalog_object_id);
      counted(c.catalog_object_id, c.quantity);
    }
    // No count at all for a variation means zero at the counter.
    for (const id of links) if (!seen.has(id)) counted(id, 0);
    return { checked: links.length };
  }

  /** For the Channels page. */
  function status() {
    const row = db.prepare("SELECT COUNT(*) AS linked, SUM(needs_push) AS waiting, SUM(last_error != '') AS failing, MAX(synced_at) AS last FROM pos_links").get();
    const error = db.prepare("SELECT last_error FROM pos_links WHERE last_error != '' ORDER BY item_id LIMIT 1").get()?.last_error ?? '';
    return { linked: row.linked ?? 0, waiting: row.waiting ?? 0, failing: row.failing ?? 0, last: row.last, error, due: due(1000).length };
  }

  /** Run `flush` and `reconcile` on timers. Returns a stop function. */
  function start({ flushMs = 15_000, reconcileMs = 5 * 60_000 } = {}) {
    const safely = (job) => () => job().catch((error) => log(`Square sync: ${error.message}`));
    const timers = [setInterval(safely(flush), flushMs), setInterval(safely(reconcile), reconcileMs)];
    for (const timer of timers) timer.unref?.();
    return () => timers.forEach(clearInterval);
  }

  return { flush, reconcile, heard, counted, status, start, due };
}
