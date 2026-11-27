// HTTP in, pages out. It knows the application's functions and nothing about SQL.
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLATFORMS, fromColumn, fromTitle } from '../domain/fitment.js';
import { toCents } from '../domain/text.js';
import { clientAddress, createNotices, crossSite, same } from './security.js';
import { boundaryOf, parseMultipart } from './multipart.js';
import { MAX_PHOTO_BYTES } from '../app/photos.js';
import { isCheckoutKey, newCheckoutKey } from '../app/sales.js';
import { raw } from './html.js';
import * as store from './store.js';
import * as admin from './admin.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, '..', '..', 'public');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const MAX_BODY = 64 * 1024;
const IMPORT_BODY = 8 * 1024 * 1024; // a whole store's product CSV, percent-encoded
const PHOTO_BODY = 8 * MAX_PHOTO_BYTES;

import { PLATFORM_NAMES } from '../app/payments.js';

// Payment platforms' pages are other sites: a buy form may be sent on to one (form-action https:).
const csp = () => [
  "default-src 'self'",
  "img-src 'self' https: data:",
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "script-src 'self'",
  "form-action 'self' https:",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join('; ');

export function createWeb({ shop, config, now = Date.now }) {
  const { catalog, accounts, sales, photos, drafts, platform, test } = shop;
  const baseConfig = config;
  const notices = createNotices(config.secret);
  const sign = (text) => createHmac('sha256', config.secret).update(text).digest('base64url');

  function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
    res.writeHead(status, { 'content-type': type, 'content-security-policy': csp(), 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : String(body));
  }
  const page = (res, body, status = 200, extra = {}) => send(res, status, body, 'text/html; charset=utf-8', { 'cache-control': 'no-store', ...extra });
  const redirect = (res, to) => {
    res.writeHead(303, { location: to });
    res.end();
  };
  /** Back to a page with a one-line message the server signed. */
  const done = (res, path, words, kind = 'done') => redirect(res, notices.to(path, words, kind));
  const noticeOf = (url) => {
    const { problem = '', done: ok = '' } = notices.read(url);
    return { notice: ok, problem };
  };

  async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('too big'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  const formOf = async (req, limit = MAX_BODY) => new URLSearchParams((await readBody(req, limit)).toString('utf8'));

  const tokenFor = (who) => sign(`csrf.${who.session}`).slice(0, 32);

  function itemFields(form) {
    const fitmentText = form.get('fitment')?.trim() ?? '';
    const title = form.get('title')?.trim() ?? '';
    return {
      title,
      priceCents: toCents(form.get('price')) ?? -1,
      compareAtCents: toCents(form.get('compare_at')),
      quantity: Number.isInteger(Number(form.get('quantity'))) && form.get('quantity') !== '' ? Number(form.get('quantity')) : -1,
      condition: ['used', 'new', 'refurbished'].includes(form.get('condition')) ? form.get('condition') : 'used',
      category: form.get('category')?.trim() ?? '',
      brand: form.get('brand')?.trim() ?? '',
      mpn: form.get('mpn')?.trim() ?? '',
      images: (form.get('images') ?? '').split(/\s+/).filter((src) => /^https:\/\//i.test(src) || /^\/media\/\d+\.(jpg|png|webp)$/.test(src)),
      description: form.get('description')?.trim() ?? '',
      fitment: fitmentText ? fromColumn(fitmentText) : fromTitle(title),
      lotId: Number(form.get('lot')) || null,
      madeToOrder: form.get('made_to_order') === 'on',
    };
  }

  function vehicleFilter(url) {
    const platformKey = PLATFORMS[url.searchParams.get('platform')] ? url.searchParams.get('platform') : '';
    const year = Number(url.searchParams.get('year')) || null;
    return { platform: platformKey, year: year ?? '', q: (url.searchParams.get('q') ?? '').slice(0, 100), vehicle: platformKey ? { platform: platformKey, year } : null };
  }

  // The buyer's cart is theirs by a signed cookie: a random id, nothing about them.
  const CART = config.production ? '__Host-ps_cart' : 'ps_cart';
  function cartOwner(req) {
    const found = String(req.headers.cookie ?? '').split(/;\s*/).find((part) => part.startsWith(`${CART}=`));
    const [id, mac] = (found?.slice(CART.length + 1) ?? '').split('.');
    return id && mac && /^[A-Za-z0-9_-]{22}$/.test(id) && same(mac, sign(`cart.${id}`).slice(0, 22)) ? `cart:${id}` : null;
  }
  function newCartOwner(res) {
    const id = randomBytes(16).toString('base64url');
    res.setHeader('set-cookie', `${CART}=${id}.${sign(`cart.${id}`).slice(0, 22)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${config.production ? '; Secure' : ''}`);
    return `cart:${id}`;
  }
  const refuseCrossSite = (res) => send(res, 403, 'Forms here are posted from this site only.', 'text/plain; charset=utf-8');

  async function storefront(req, res, url) {
    const path = url.pathname;
    const t = now();
    const owner = cartOwner(req);
    const cart = owner ? sales.cart(owner) : { lines: [], count: 0, cents: 0, ready: false };
    // What every storefront page shows in its header: how many are in the cart.
    const config = { ...baseConfig, cartCount: cart.count };

    // The cart.
    if ((path === '/cart/add' || path === '/cart/set') && req.method === 'POST') {
      if (crossSite(req)) return refuseCrossSite(res);
      const form = await formOf(req);
      const handle = String(form.get('item') ?? '');
      const qty = Number(form.get('qty') ?? (path === '/cart/add' ? 1 : 0));
      const who = owner ?? newCartOwner(res);
      const result = path === '/cart/add' ? await sales.add(who, handle, qty) : await sales.set(who, handle, qty);
      if (result.error) {
        const item = catalog.get(handle);
        const parent = item?.parentId ? catalog.get(item.parentId) : item;
        const words = store.SAY_BUYER[result.error] ?? 'That didn’t work. Try again.';
        return done(res, path === '/cart/add' && parent ? `/parts/${parent.handle}` : '/cart', result.error === 'sold-out' && result.left ? `Only ${result.left} left.` : words, 'problem');
      }
      return redirect(res, '/cart');
    }
    if (path === '/cart' && req.method === 'GET') return page(res, store.cartPage({ config, cart, problem: noticeOf(url).problem }));

    // Checking out: who's buying, then off to the payment platform's page.
    if (path === '/checkout') {
      if (req.method === 'GET') {
        if (!cart.lines.length) return redirect(res, '/cart');
        return page(res, store.checkoutPage({ config, cart, key: newCheckoutKey(), platform }));
      }
      if (req.method === 'POST') {
        if (crossSite(req)) return refuseCrossSite(res);
        const form = Object.fromEntries(await formOf(req));
        const key = isCheckoutKey(form.checkout) ? form.checkout : newCheckoutKey();
        const started = owner ? await sales.start(owner, form, { key }) : { error: 'empty' };
        if (started.error) {
          if (started.error === 'gone' || started.error === 'empty') return done(res, '/cart', store.SAY_BUYER[started.error], 'problem');
          return page(res, store.checkoutPage({ config, cart: sales.cart(owner), key, platform, problem: store.SAY_BUYER[started.error] ?? 'That didn’t work. Try again.', form }), 422);
        }
        return redirect(res, started.url ?? `/orders/${started.key}`);
      }
    }
    // The payment platform sends the buyer back here, with ?checkout=<key>.
    if ((path === '/checkout/back' || path === '/checkout/cancel') && req.method === 'GET') {
      const key = url.searchParams.get('checkout') ?? '';
      if (!isCheckoutKey(key) || !sales.get(key)) return page(res, store.notFoundPage({ config }), 404);
      if (path === '/checkout/cancel' && owner) await sales.cancel(owner, key);
      return redirect(res, `/orders/${key}`);
    }
    const order = /^\/orders\/([A-Za-z0-9_-]{24})$/.exec(path);
    if (order && req.method === 'GET') {
      const result = await sales.back(order[1]);
      if (result.error) return page(res, store.notFoundPage({ config }), 404);
      return page(res, store.orderPage({ config: { ...config, cartCount: sales.cart(owner ?? '').count }, order: result.checkout, waiting: result.waiting }), 200, { 'referrer-policy': 'no-referrer' });
    }
    // The single-part "Buy it" page from before carts.
    const buy = /^\/parts\/([a-z0-9-]{1,100})\/buy$/.exec(path);
    if (buy) return redirect(res, `/parts/${buy[1]}`);

    // The test payment page, used until the payment platform's settings are set.
    if (path === '/pay/test' && platform.name === 'test') {
      if (req.method === 'GET') {
        const ref = url.searchParams.get('ref') ?? '';
        const shown = test.pageFor(ref);
        if (!shown) return page(res, store.notFoundPage({ config }), 404);
        return page(res, store.testPayPage({ config, ref, shown, instead: PLATFORM_NAMES[platform.asked] && platform.asked !== 'test' ? PLATFORM_NAMES[platform.asked] : '' }));
      }
      if (req.method === 'POST') {
        if (crossSite(req)) return send(res, 403, 'Forms here are posted from this site only.', 'text/plain; charset=utf-8');
        const form = await formOf(req);
        const ref = form.get('ref') ?? '';
        const shown = test.pageFor(ref);
        if (!shown || form.get('answer') !== 'pay') return page(res, store.notFoundPage({ config }), 404);
        test.approve(ref);
        return redirect(res, shown.back);
      }
    }

    // The payment platform's webhook.
    if (path === '/pay/webhook' && req.method === 'POST') {
      const body = (await readBody(req, MAX_BODY)).toString('utf8');
      const heard = await sales.heard({ headers: req.headers, body, url: `${config.publicUrl}${path}` });
      return send(res, heard.error ? 401 : 200, heard.error ? 'refused' : 'ok', 'text/plain; charset=utf-8');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', 'text/plain');
    if (path === '/') return page(res, store.homePage({ config, items: catalog.list({ status: 'active', limit: 12 }), now: t }));
    if (path === '/parts') {
      const filter = vehicleFilter(url);
      const items = catalog.list({ status: ['active', 'held'], q: filter.q, vehicle: filter.vehicle, limit: 300 });
      return page(res, store.listPage({ config, items, now: t, filter }));
    }
    const part = /^\/parts\/([a-z0-9-]{1,100})$/.exec(path);
    if (part) {
      const item = catalog.get(part[1]);
      // A size's own address goes to the item it is a size of.
      if (item?.parentId) return redirect(res, `/parts/${catalog.get(item.parentId)?.handle ?? ''}`);
      if (!item || item.status === 'draft' || item.status === 'archived') return page(res, store.notFoundPage({ config }), 404);
      return page(res, store.partPage({ config, item, now: t, problem: noticeOf(url).problem }));
    }
    const media = /^\/media\/(\d{1,12})\.(jpg|png|webp)$/.exec(path);
    if (media) {
      const photo = photos.get(Number(media[1]));
      if (!photo) return send(res, 404, 'Not found', 'text/plain');
      return send(res, 200, photo.bytes, photo.type, { 'cache-control': 'public, max-age=31536000, immutable' });
    }
    if (path === '/feeds/google.tsv') return send(res, 200, catalog.exportAs('google', { site: config.publicUrl }), 'text/tab-separated-values; charset=utf-8', { 'cache-control': 'max-age=300' });
    if (path === '/feeds/meta.csv') return send(res, 200, catalog.exportAs('meta', { site: config.publicUrl, business: config.business }), 'text/csv; charset=utf-8', { 'cache-control': 'max-age=300' });
    if (path === '/healthz') return send(res, 200, JSON.stringify({ ok: true }), 'application/json');
    if (path === '/robots.txt') return send(res, 200, 'User-agent: *\nDisallow: /admin\nDisallow: /orders\nDisallow: /cart\nDisallow: /checkout\n', 'text/plain; charset=utf-8');
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

  // Pages for people who aren't signed in: sign-in, and setup, invite and new-password links.
  async function doors(req, res, url) {
    const path = url.pathname;
    if (req.method === 'POST' && crossSite(req)) return send(res, 403, 'Forms here are posted from this site only.', 'text/plain; charset=utf-8'), true;
    if (path === '/admin/sign-in' && req.method === 'POST') {
      const form = await formOf(req);
      const result = await accounts.signIn(form.get('email'), form.get('password'), { client: clientAddress(req, config.proxies) });
      if (result.error) return page(res, admin.signInPage({ config, email: form.get('email') ?? '', problem: result.error === 'locked' ? 'Too many tries. Wait 15 minutes, or ask the owner for a new-password link.' : 'That email and password don’t match.' }), 401), true;
      res.setHeader('set-cookie', result.cookie);
      return redirect(res, '/admin'), true;
    }
    if (path === '/admin/accept') {
      res.setHeader('referrer-policy', 'no-referrer');
      if (req.method === 'GET') {
        const raw = url.searchParams.get('link') ?? '';
        return page(res, admin.acceptPage({ config, raw, link: accounts.peek(raw) })), true;
      }
      if (req.method === 'POST') {
        const form = await formOf(req);
        const raw = form.get('link') ?? '';
        const result = await accounts.accept(raw, { email: form.get('email'), name: form.get('name'), password: form.get('password') });
        if (result.error) return page(res, admin.acceptPage({ config, raw, link: accounts.peek(raw), problem: result.error }), 422), true;
        res.setHeader('set-cookie', result.cookie);
        return done(res, '/admin', 'You’re signed in.'), true;
      }
    }
    return false;
  }

  async function dashboard(req, res, url) {
    const path = url.pathname;
    if (await doors(req, res, url)) return;
    const who = accounts.session(req);
    const { notice, problem: signedProblem } = noticeOf(url);
    if (!who) return page(res, admin.signInPage({ config }));
    const token = tokenFor(who);
    const owner = who.role === 'owner';
    const t = now();
    const view = { config, who, token, owner, notice, problem: signedProblem, now: t };
    const refuse = () => done(res, '/admin', 'Only an owner can do that.', 'problem');

    let form = null;
    let files = [];
    if (req.method === 'POST') {
      if (crossSite(req)) return send(res, 403, 'Forms here are posted from this site only.', 'text/plain; charset=utf-8');
      const boundary = boundaryOf(req.headers['content-type']);
      if (boundary) ({ fields: form, files } = parseMultipart(await readBody(req, PHOTO_BODY), boundary));
      else form = await formOf(req, path.startsWith('/admin/import') ? IMPORT_BODY : MAX_BODY);
      if (!same(form.get('token') ?? '', token)) return page(res, admin.adminLayout({ ...view, title: 'Expired', body: raw('<p class="problem">That form had expired. Go back, reload the page and try again.</p>') }), 403);
    } else if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');

    if (path === '/admin/sign-out' && form) {
      res.setHeader('set-cookie', accounts.signOut(req));
      return redirect(res, '/admin');
    }

    if (path === '/admin' && !form) {
      return page(res, admin.dashboardPage({ ...view, summary: catalog.summary(), drafts: catalog.list({ status: 'draft', limit: 10 }), recent: catalog.activity({ limit: 15 }), orders: owner ? sales.list({ limit: 5 }) : [] }));
    }

    if (path === '/admin/items' && !form) {
      const status = ['draft', 'active', 'held', 'sold', 'archived'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : '';
      const q = (url.searchParams.get('q') ?? '').slice(0, 100);
      const lotId = Number(url.searchParams.get('lot')) || null;
      let items = catalog.list({ status: status || null, q, lotId, limit: 500 });
      const need = url.searchParams.get('need');
      if (need === 'photo') items = items.filter((item) => item.images.length === 0);
      if (need === 'fitment') items = items.filter((item) => item.fitment.length === 0 && (item.status === 'active' || item.status === 'draft'));
      return page(res, admin.itemsPage({ ...view, items, filter: { status, q } }));
    }

    if (path === '/admin/items/new' && !form) {
      return page(res, admin.itemPage({ ...view, item: { quantity: 1, condition: 'used', fitment: [], images: [] }, lots: catalog.lots(), history: [], ai: drafts, mayEdit: true }));
    }

    if (path === '/admin/items' && form) {
      const fields = itemFields(form);
      const result = catalog.create(fields, { who: who.name });
      if (result.error) return page(res, admin.itemPage({ ...view, item: { ...fields, priceCents: fields.priceCents < 0 ? null : fields.priceCents }, lots: catalog.lots(), history: [], problem: admin.SAY[result.error], ai: drafts, mayEdit: true }), 422);
      // Photos chosen on the new-part form come along in the same post.
      if (files.length) {
        const added = photos.add(result.item.id, files, { who: who.name });
        if (added.error) return done(res, `/admin/items/${result.item.id}`, admin.SAY[added.error], 'problem');
      }
      return done(res, `/admin/items/${result.item.id}`, files.length && drafts.enabled ? 'Saved as a draft. Draft it with AI, or fill it in yourself.' : 'Saved as a draft. List it when it’s ready.');
    }

    const one = /^\/admin\/items\/(\d+)(?:\/([\w-]+))?$/.exec(path);
    if (one) {
      const id = Number(one[1]);
      const action = one[2];
      const item = catalog.get(id);
      if (!item) return page(res, admin.itemsPage({ ...view, items: [], filter: { status: '', q: '' }, problem: 'That part doesn’t exist.' }), 404);
      // Helpers work on drafts only: listing, selling and prices of listed parts are the owner's.
      const mayEdit = owner || item.status === 'draft';
      if (!action && !form) return page(res, admin.itemPage({ ...view, item, lots: catalog.lots(), history: catalog.activity({ itemId: id }), ai: drafts, mayEdit }));
      if (!action && form) {
        if (!mayEdit) return refuse();
        const fields = itemFields(form);
        const result = catalog.edit(id, fields, { who: who.name });
        if (result.error) return page(res, admin.itemPage({ ...view, item: { ...item, ...fields, priceCents: fields.priceCents < 0 ? null : fields.priceCents }, lots: catalog.lots(), history: catalog.activity({ itemId: id }), problem: admin.SAY[result.error], ai: drafts, mayEdit }), 422);
        return done(res, `/admin/items/${id}`, 'Saved.');
      }
      if (action === 'photos' && form) {
        if (!mayEdit) return refuse();
        if (!files.length) return done(res, `/admin/items/${id}`, 'Choose a photo first.', 'problem');
        const added = photos.add(id, files, { who: who.name });
        return added.error ? done(res, `/admin/items/${id}`, admin.SAY[added.error], 'problem') : done(res, `/admin/items/${id}`, `${added.added.length} ${added.added.length === 1 ? 'photo' : 'photos'} added.`);
      }
      if (action === 'remove-photo' && form) {
        if (!mayEdit) return refuse();
        const removed = photos.remove(id, form.get('src') ?? '', { who: who.name });
        return removed.error ? done(res, `/admin/items/${id}`, 'That photo isn’t on this part.', 'problem') : done(res, `/admin/items/${id}`, 'Photo removed.');
      }
      if (action === 'sizes' && form) {
        if (!owner) return refuse();
        const priceCents = toCents(form.get('price')) ?? -1;
        const quantity = form.get('quantity') === '' || form.get('quantity') == null ? 0 : Number(form.get('quantity'));
        const madeToOrder = form.get('made_to_order') === 'on';
        const sizeId = Number(form.get('size')) || null;
        const size = sizeId ? catalog.get(sizeId) : null;
        if (sizeId && size?.parentId !== id) return done(res, `/admin/items/${id}`, 'That size isn’t on this item.', 'problem');
        const result = size
          ? catalog.edit(size.id, { priceCents, quantity: Number.isInteger(quantity) ? quantity : -1, madeToOrder }, { who: who.name })
          : catalog.addSize(id, { option: form.get('option') ?? '', priceCents, quantity: Number.isInteger(quantity) ? quantity : -1, madeToOrder }, { who: who.name });
        return result.error ? done(res, `/admin/items/${id}`, admin.SAY[result.error] ?? 'That didn’t work.', 'problem') : done(res, `/admin/items/${id}`, size ? `${size.option} saved.` : 'Size added.');
      }
      if (action === 'draft' && form) {
        const drafted = await drafts.draft(id, { who: who.name });
        if (drafted.error) return done(res, `/admin/items/${id}`, admin.SAY[drafted.error] ?? 'The AI draft didn’t work. Try again.', 'problem');
        return done(res, `/admin/items/${id}`, drafted.notes ? `Drafted. Check before listing: ${drafted.notes}` : 'Drafted. Read it over, set the price, then list it.');
      }
      if (action && form) {
        if (!owner) return refuse();
        const args = action === 'hold' ? { until: t + Math.min(Number(form.get('hours')) || 24, 24 * 14) * 3_600_000 } : action === 'sell' ? { via: 'counter' } : {};
        const result = catalog.act(id, action, args, { who: who.name });
        const backTo = /^\/admin(\/[\w-]+)*(\?[\w=&-]*)?$/.test(form.get('back') ?? '') ? form.get('back') : `/admin/items/${id}`;
        const words = { publish: 'Listed. It’s in the store and the feeds.', unpublish: 'Unlisted.', hold: 'On hold.', release: 'Back on sale.', sell: 'Marked sold. It’s out of the store and the feeds.', archive: 'Removed from the store and the feeds.', restore: 'Brought back as a draft.' };
        return result.error ? done(res, backTo, admin.SAY[result.error] ?? 'That didn’t work.', 'problem') : done(res, backTo, words[action] ?? 'Done.');
      }
    }

    if (path === '/admin/lots' && !form) return page(res, admin.lotsPage({ ...view, lots: catalog.lots() }));
    if (path === '/admin/lots' && form) {
      const result = catalog.createLot({ name: form.get('name') ?? '', vin: (form.get('vin') ?? '').trim().toUpperCase() || null, costCents: owner ? toCents(form.get('cost')) ?? 0 : 0 }, { who: who.name });
      if (result.error) return page(res, admin.lotsPage({ ...view, lots: catalog.lots(), problem: admin.SAY[result.error] }), 422);
      return done(res, '/admin/lots', 'Car logged. Pick it as the donor when you list its parts.');
    }

    // Everything below is the owner's.
    if (!owner) return refuse();

    if (path === '/admin/people' && !form) return page(res, admin.peoplePage({ ...view, people: accounts.list() }));
    if (path === '/admin/people/invite' && form) {
      const result = accounts.invite(who, { email: form.get('email'), name: form.get('name') ?? '', role: form.get('role') === 'owner' ? 'owner' : 'helper' });
      if (result.error) return page(res, admin.peoplePage({ ...view, people: accounts.list(), problem: result.error }), 422);
      return page(res, admin.peoplePage({ ...view, people: accounts.list(), shown: { title: 'Invite link', to: String(form.get('email')).trim(), link: `${config.publicUrl}/admin/accept?link=${result.token}` } }));
    }
    const person = /^\/admin\/people\/(\d+)\/(reset|off|on)$/.exec(path);
    if (person && form) {
      const id = Number(person[1]);
      if (person[2] === 'reset') {
        const result = accounts.resetLink(who, id);
        if (result.error) return done(res, '/admin/people', result.error, 'problem');
        return page(res, admin.peoplePage({ ...view, people: accounts.list(), shown: { title: 'New-password link', to: result.account.name, link: `${config.publicUrl}/admin/accept?link=${result.token}` } }));
      }
      const result = accounts.setDisabled(who, id, person[2] === 'off');
      return result.error ? done(res, '/admin/people', result.error, 'problem') : done(res, '/admin/people', person[2] === 'off' ? 'Turned off and signed out.' : 'Turned back on.');
    }

    if (path === '/admin/orders' && !form) return page(res, admin.ordersPage({ ...view, orders: sales.list({ limit: 200 }) }));
    const step = /^\/admin\/orders\/([A-Za-z0-9_-]{24})\/(packed|sent)$/.exec(path);
    if (step && form) {
      if (!owner) return done(res, '/admin/orders', 'Only owners fill orders.', 'problem');
      const moved = await sales.advance(step[1], step[2]);
      return done(res, '/admin/orders', moved.ok ? `Marked ${step[2]}.` : 'That order isn’t at that step.', moved.ok ? 'done' : 'problem');
    }

    if (path === '/admin/import' && !form) return page(res, admin.importPage({ ...view, batches: catalog.batches() }));
    if ((path === '/admin/import/preview' || path === '/admin/import/commit') && form) {
      const text = form.get('csv') ?? '';
      const options = { condition: form.get('condition') === 'new' ? 'new' : 'used', ignoreBrand: form.get('ignore_brand')?.trim() || undefined, imageBase: form.get('image_base')?.trim() || undefined };
      if (path.endsWith('/preview')) {
        const plan = catalog.preview(text, options);
        if (!plan.source) return page(res, admin.importPage({ ...view, problem: admin.SAY['unknown-format'], batches: catalog.batches() }), 422);
        return page(res, admin.importPage({ ...view, plan, text, options, batches: catalog.batches() }));
      }
      const result = catalog.commit(text, options, { who: who.name });
      if (result.error) return page(res, admin.importPage({ ...view, problem: admin.SAY[result.error], batches: catalog.batches() }), 422);
      return done(res, '/admin/items', `Imported: ${result.plan.creates} new, ${result.plan.updates} updated.`);
    }
    const undo = /^\/admin\/import\/(\d+)\/undo$/.exec(path);
    if (undo && form) {
      const result = catalog.undo(Number(undo[1]), { who: who.name });
      return result.error ? done(res, '/admin/import', admin.SAY[result.error], 'problem') : done(res, '/admin/import', `Undone: ${result.count} parts put back.`);
    }

    if (path === '/admin/channels' && !form) return page(res, admin.channelsPage({ ...view, items: catalog.list({ limit: 100_000 }), payment: { name: platform.name, label: PLATFORM_NAMES[platform.name], asked: platform.asked, sandbox: platform.sandbox }, ai: drafts }));

    const exported = /^\/admin\/export\/(csv|shopify)$/.exec(path);
    if (exported && !form) {
      const name = exported[1] === 'csv' ? 'potomac-shop-products.csv' : 'shopify-products.csv';
      return send(res, 200, catalog.exportAs(exported[1], { business: config.business }), 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
    }

    return page(res, admin.itemsPage({ ...view, items: [], filter: { status: '', q: '' }, problem: 'That page doesn’t exist.' }), 404);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return await dashboard(req, res, url);
      return await storefront(req, res, url);
    } catch (error) {
      if (error.status === 413) return send(res, 413, 'That was too big to send. Photos can be up to 12 MB each.', 'text/plain; charset=utf-8');
      if (error.status === 400) return send(res, 400, 'That upload didn’t come through whole. Try again.', 'text/plain; charset=utf-8');
      console.error(error);
      if (!res.headersSent) send(res, 500, 'Something went wrong on our side.', 'text/plain; charset=utf-8');
    }
  });
  return { server };
}
