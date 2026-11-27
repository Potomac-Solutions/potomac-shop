// HTTP in, pages out. It knows the catalog's functions and nothing about SQL.
import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromColumn, fromTitle } from '../domain/fitment.js';
import { toCents } from '../domain/text.js';
import { PLATFORMS } from '../domain/fitment.js';
import * as store from './store.js';
import * as admin from './admin.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', '..', 'public');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const MAX_BODY = 64 * 1024;
const IMPORT_BODY = 8 * 1024 * 1024; // a whole store's product CSV, percent-encoded
const SESSION_HOURS = 12;
const COOKIE = 'ps_owner';

const CSP = [
  "default-src 'self'",
  "img-src 'self' https: data:",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "script-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

export function createWeb({ catalog, config, now = Date.now }) {
  const sign = (text) => createHmac('sha256', config.secret).update(text).digest('base64url');
  const same = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
  };

  // The owner's session: "<expires>.<random>.<signature>" in an HttpOnly cookie. Forms carry a token
  // derived from it, so another site can't post to the dashboard on the owner's behalf.
  function session(req) {
    const cookie = Object.fromEntries(String(req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((pair) => {
      const at = pair.indexOf('=');
      return [pair.slice(0, at), pair.slice(at + 1)];
    }))[COOKIE];
    if (!cookie) return null;
    const [expires, nonce, mac] = cookie.split('.');
    if (!expires || !nonce || !mac || !same(mac, sign(`${expires}.${nonce}`)) || Number(expires) < now()) return null;
    return { value: cookie, token: sign(`csrf.${cookie}`) };
  }

  function newSession() {
    const expires = now() + SESSION_HOURS * 3_600_000;
    const nonce = randomBytes(16).toString('base64url');
    return `${expires}.${nonce}.${sign(`${expires}.${nonce}`)}`;
  }

  const cookieFlags = `Path=/; HttpOnly; SameSite=Lax${config.production ? '; Secure' : ''}`;

  // Sign-in attempts: at most 10 a minute from one address.
  const attempts = new Map();
  function tooMany(address) {
    const minute = Math.floor(now() / 60_000);
    const key = `${address}:${minute}`;
    const count = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, count);
    if (attempts.size > 5_000) attempts.clear();
    return count > 10;
  }

  function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
    res.writeHead(status, {
      'content-type': type,
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      ...extra,
    });
    res.end(String(body));
  }
  const page = (res, body, status = 200, extra = {}) => send(res, status, body, 'text/html; charset=utf-8', { 'cache-control': 'no-store', ...extra });
  const redirect = (res, to, extra = {}) => {
    res.writeHead(303, { location: to, ...extra });
    res.end();
  };

  // A one-line message after a form post rides in the address, signed so nobody can put words in it.
  const withNotice = (path, text) => `${path}${path.includes('?') ? '&' : '?'}n=${encodeURIComponent(text)}&s=${sign(`n.${text}`).slice(0, 16)}`;
  const noticeOf = (url) => {
    const text = url.searchParams.get('n');
    return text && same(url.searchParams.get('s') ?? '', sign(`n.${text}`).slice(0, 16)) ? text : '';
  };

  async function body(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('too big'), { status: 413 });
      chunks.push(chunk);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  }

  function itemFields(form) {
    const fitmentText = form.get('fitment')?.trim() ?? '';
    const title = form.get('title')?.trim() ?? '';
    const lot = Number(form.get('lot')) || null;
    return {
      title,
      priceCents: toCents(form.get('price')) ?? -1,
      compareAtCents: toCents(form.get('compare_at')),
      quantity: Number.isInteger(Number(form.get('quantity'))) && form.get('quantity') !== '' ? Number(form.get('quantity')) : -1,
      condition: ['used', 'new', 'refurbished'].includes(form.get('condition')) ? form.get('condition') : 'used',
      category: form.get('category')?.trim() ?? '',
      brand: form.get('brand')?.trim() ?? '',
      mpn: form.get('mpn')?.trim() ?? '',
      images: (form.get('images') ?? '').split(/\s+/).filter((src) => /^https:\/\//i.test(src)),
      description: form.get('description')?.trim() ?? '',
      fitment: fitmentText ? fromColumn(fitmentText) : fromTitle(title),
      lotId: lot,
    };
  }

  function vehicleFilter(url) {
    const platform = PLATFORMS[url.searchParams.get('platform')] ? url.searchParams.get('platform') : '';
    const year = Number(url.searchParams.get('year')) || null;
    return { platform, year: year ?? '', q: (url.searchParams.get('q') ?? '').slice(0, 100), vehicle: platform ? { platform, year } : null };
  }

  async function storefront(req, res, url) {
    const path = url.pathname;
    if (path === '/') return page(res, store.homePage({ config, items: catalog.list({ status: 'active', limit: 12 }), now: now() }));
    if (path === '/parts') {
      const filter = vehicleFilter(url);
      const items = catalog.list({ status: ['active', 'held'], q: filter.q, vehicle: filter.vehicle, limit: 300 });
      return page(res, store.listPage({ config, items, now: now(), filter }));
    }
    const part = /^\/parts\/([a-z0-9-]{1,100})$/.exec(path);
    if (part) {
      const item = catalog.get(part[1]);
      if (!item || item.status === 'draft' || item.status === 'archived') return page(res, store.notFoundPage({ config }), 404);
      return page(res, store.partPage({ config, item, now: now() }));
    }
    if (path === '/feeds/google.tsv') return send(res, 200, catalog.exportAs('google', { site: config.publicUrl }), 'text/tab-separated-values; charset=utf-8', { 'cache-control': 'max-age=300' });
    if (path === '/feeds/meta.csv') return send(res, 200, catalog.exportAs('meta', { site: config.publicUrl, business: config.business }), 'text/csv; charset=utf-8', { 'cache-control': 'max-age=300' });
    if (path === '/healthz') return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
    if (path === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /admin\n', 'text/plain; charset=utf-8');
    if (path.startsWith('/static/')) return staticFile(res, path.slice('/static/'.length));
    return page(res, store.notFoundPage({ config }), 404);
  }

  async function staticFile(res, name) {
    const file = normalize(join(PUBLIC, name));
    if (!file.startsWith(PUBLIC + '/') || !TYPES[extname(file)]) return send(res, 404, 'Not found', 'text/plain');
    try {
      return send(res, 200, await readFile(file), TYPES[extname(file)], { 'cache-control': 'max-age=3600' });
    } catch {
      return send(res, 404, 'Not found', 'text/plain');
    }
  }

  async function dashboard(req, res, url) {
    const path = url.pathname;
    const address = req.socket.remoteAddress ?? '';

    if (path === '/admin/sign-in') {
      if (req.method === 'GET') return page(res, admin.signInPage({ config }));
      if (req.method === 'POST') {
        const form = await body(req, MAX_BODY);
        if (tooMany(address)) return page(res, admin.signInPage({ config, problem: 'Too many tries. Wait a minute.' }), 429);
        if (!config.ownerPassword || !same(form.get('password') ?? '', config.ownerPassword)) return page(res, admin.signInPage({ config, problem: 'That password isn’t right.' }), 401);
        return redirect(res, '/admin', { 'set-cookie': `${COOKIE}=${newSession()}; ${cookieFlags}; Max-Age=${SESSION_HOURS * 3600}` });
      }
    }

    const who = session(req);
    if (!who) return redirect(res, '/admin/sign-in');
    const token = who.token;
    const notice = noticeOf(url);
    const t = now();

    let form = null;
    if (req.method === 'POST') {
      form = await body(req, path.startsWith('/admin/import') ? IMPORT_BODY : MAX_BODY);
      if (!same(form.get('token') ?? '', token)) return page(res, admin.signInPage({ config, problem: 'That form had expired. Sign in again.' }), 403);
    } else if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');

    if (path === '/admin/sign-out' && form) return redirect(res, '/admin/sign-in', { 'set-cookie': `${COOKIE}=; ${cookieFlags}; Max-Age=0` });

    if (path === '/admin' && !form) {
      return page(res, admin.dashboardPage({ config, token, notice, now: t, summary: catalog.summary(), drafts: catalog.list({ status: 'draft', limit: 10 }), recent: catalog.activity({ limit: 15 }) }));
    }

    if (path === '/admin/items' && !form) {
      const status = ['draft', 'active', 'held', 'sold', 'archived'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : '';
      const q = (url.searchParams.get('q') ?? '').slice(0, 100);
      const lotId = Number(url.searchParams.get('lot')) || null;
      let items = catalog.list({ status: status || null, q, lotId, limit: 500 });
      const need = url.searchParams.get('need');
      if (need === 'photo') items = items.filter((item) => item.images.length === 0);
      if (need === 'fitment') items = items.filter((item) => item.fitment.length === 0 && (item.status === 'active' || item.status === 'draft'));
      return page(res, admin.itemsPage({ config, token, items, filter: { status, q }, notice, now: t }));
    }

    if (path === '/admin/items/new' && !form) {
      return page(res, admin.itemPage({ config, token, item: { quantity: 1, condition: 'used', fitment: [], images: [] }, lots: catalog.lots(), history: [], now: t }));
    }

    if (path === '/admin/items' && form) {
      const fields = itemFields(form);
      const result = catalog.create(fields);
      if (result.error) return page(res, admin.itemPage({ config, token, item: { ...fields, priceCents: fields.priceCents < 0 ? null : fields.priceCents }, lots: catalog.lots(), history: [], problem: admin.SAY[result.error], now: t }), 422);
      return redirect(res, withNotice(`/admin/items/${result.item.id}`, 'Saved as a draft. List it when it’s ready.'));
    }

    const one = /^\/admin\/items\/(\d+)(?:\/(\w+))?$/.exec(path);
    if (one) {
      const id = Number(one[1]);
      const action = one[2];
      if (!action && !form) {
        const item = catalog.get(id);
        if (!item) return page(res, admin.itemsPage({ config, token, items: [], filter: { status: '', q: '' }, notice: 'That part doesn’t exist.', now: t }), 404);
        return page(res, admin.itemPage({ config, token, item, lots: catalog.lots(), history: catalog.activity({ itemId: id }), notice, now: t }));
      }
      if (!action && form) {
        const fields = itemFields(form);
        const result = catalog.edit(id, fields);
        if (result.error) {
          const item = catalog.get(id);
          return page(res, admin.itemPage({ config, token, item: { ...item, ...fields, priceCents: fields.priceCents < 0 ? null : fields.priceCents }, lots: catalog.lots(), history: catalog.activity({ itemId: id }), problem: admin.SAY[result.error], now: t }), 422);
        }
        return redirect(res, withNotice(`/admin/items/${id}`, 'Saved.'));
      }
      if (action && form) {
        const args = action === 'hold' ? { until: t + Math.min(Number(form.get('hours')) || 24, 24 * 14) * 3_600_000 } : action === 'sell' ? { via: 'counter' } : {};
        const result = catalog.act(id, action, args);
        const back = req.headers.referer && new URL(req.headers.referer, config.publicUrl).pathname.startsWith('/admin') ? new URL(req.headers.referer, config.publicUrl) : null;
        const to = back ? `${back.pathname}${back.search.replace(/[?&](n|s)=[^&]*/g, '')}` : `/admin/items/${id}`;
        const done = { publish: 'Listed. It’s in the store and the feeds.', unpublish: 'Unlisted.', hold: 'On hold.', release: 'Back on sale.', sell: 'Marked sold. It’s out of the store and the feeds.', archive: 'Removed from the store and the feeds.', restore: 'Brought back as a draft.' };
        return redirect(res, withNotice(to.replace(/\?$/, ''), result.error ? admin.SAY[result.error] ?? 'That didn’t work.' : done[action]));
      }
    }

    if (path === '/admin/import' && !form) {
      return page(res, admin.importPage({ config, token, notice, batches: catalog.batches(), now: t }));
    }
    if ((path === '/admin/import/preview' || path === '/admin/import/commit') && form) {
      const text = form.get('csv') ?? '';
      const options = { condition: form.get('condition') === 'new' ? 'new' : 'used', ignoreBrand: form.get('ignore_brand')?.trim() || undefined, imageBase: form.get('image_base')?.trim() || undefined };
      if (path.endsWith('/preview')) {
        const plan = catalog.preview(text, options);
        if (!plan.source) return page(res, admin.importPage({ config, token, problem: admin.SAY['unknown-format'], batches: catalog.batches(), now: t }), 422);
        return page(res, admin.importPage({ config, token, plan, text, options, batches: catalog.batches(), now: t }));
      }
      const result = catalog.commit(text, options, { filename: '' });
      if (result.error) return page(res, admin.importPage({ config, token, problem: admin.SAY[result.error], batches: catalog.batches(), now: t }), 422);
      return redirect(res, withNotice('/admin/items', `Imported: ${result.plan.creates} new, ${result.plan.updates} updated.`));
    }
    const undo = /^\/admin\/import\/(\d+)\/undo$/.exec(path);
    if (undo && form) {
      const result = catalog.undo(Number(undo[1]));
      return redirect(res, withNotice('/admin/import', result.error ? admin.SAY[result.error] : `Undone: ${result.count} parts put back.`));
    }

    if (path === '/admin/lots' && !form) return page(res, admin.lotsPage({ config, token, lots: catalog.lots(), notice }));
    if (path === '/admin/lots' && form) {
      const result = catalog.createLot({ name: form.get('name') ?? '', vin: (form.get('vin') ?? '').trim().toUpperCase() || null, costCents: toCents(form.get('cost')) ?? 0 });
      if (result.error) return page(res, admin.lotsPage({ config, token, lots: catalog.lots(), problem: admin.SAY[result.error] }), 422);
      return redirect(res, withNotice('/admin/lots', 'Car logged. Pick it as the donor when you list its parts.'));
    }

    if (path === '/admin/channels' && !form) return page(res, admin.channelsPage({ config, token, items: catalog.list({ limit: 100_000 }), now: t }));

    const exported = /^\/admin\/export\/(csv|shopify)$/.exec(path);
    if (exported && !form) {
      const name = exported[1] === 'csv' ? 'potomac-shop-products.csv' : 'shopify-products.csv';
      return send(res, 200, catalog.exportAs(exported[1], { business: config.business }), 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
    }

    return page(res, admin.itemsPage({ config, token, items: [], filter: { status: '', q: '' }, notice: 'That page doesn’t exist.', now: t }), 404);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return await dashboard(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
      return await storefront(req, res, url);
    } catch (error) {
      if (error.status === 413) return send(res, 413, 'That was too big to send.', 'text/plain; charset=utf-8');
      console.error(error);
      if (!res.headersSent) send(res, 500, 'Something went wrong on our side.', 'text/plain; charset=utf-8');
    }
  });
  return { server };
}
