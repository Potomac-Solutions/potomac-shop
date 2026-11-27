// The storefront: what buyers see. Shop by vehicle first, because that is how a DSM owner shops.
import { html, money, paragraphs, raw } from './html.js';
import { PLATFORMS, describe } from '../domain/fitment.js';
import { buyable, webImages } from '../domain/exports.js';

/** The page around every storefront page. */
export function storeLayout({ config, title, body, description = '' }) {
  return html`<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} · ${config.business}` : config.business}</title>
${description ? html`<meta name="description" content="${description}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Roboto:wght@400;500;700&display=swap">
<link rel="stylesheet" href="/static/shop.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <a class="brand" href="/"><span class="brand-mark">RIX</span> ${config.business.replace(/^Rix\s*/i, '') || config.business}</a>
  <nav aria-label="Shop">
    <a href="/parts">All parts</a>
    <a href="/parts?platform=1G">1G DSM</a>
    <a href="/parts?platform=2G">2G DSM</a>
    <a href="/parts?platform=EVO89">EVO</a>
  </nav>
</header>
${config.demo ? html`<p class="demo-bar">Demo store. Real parts and prices from ${config.business}; nothing is really sold. <a href="/admin">See the owner’s side</a></p>` : ''}
<main id="main">${body}</main>
<footer class="foot">
  <p><strong>${config.business}</strong> · ${config.place}</p>
  <p>Questions about a part? <a href="mailto:${config.contactEmail}">${config.contactEmail}</a> · <a href="${config.contactFacebook}" rel="noopener">Facebook</a></p>
  <p class="quiet">Store by Potomac Solutions</p>
</footer>
</body>
</html>`;
}

/** The vehicle picker: platform, then year. Works as a plain form, no script. */
export function vehiclePicker({ platform = '', year = '', q = '' } = {}) {
  const years = platform && PLATFORMS[platform] ? range(PLATFORMS[platform].from, PLATFORMS[platform].to) : [];
  return html`<form class="picker" action="/parts" method="get" role="search">
  <label>Your car
    <select name="platform">
      <option value="">Any DSM or EVO</option>
      ${Object.entries(PLATFORMS).map(([key, p]) => html`<option value="${key}" ${key === platform ? raw('selected') : ''}>${p.label} (${p.from}–${p.to})</option>`)}
    </select>
  </label>
  ${years.length ? html`<label>Year
    <select name="year"><option value="">Any year</option>${years.map((y) => html`<option ${String(y) === String(year) ? raw('selected') : ''}>${y}</option>`)}</select>
  </label>` : ''}
  <label>Part<input type="search" name="q" value="${q}" placeholder="turbo, shifter, cluster…"></label>
  <button type="submit">Find parts</button>
</form>`;
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function card(item, now) {
  const [image] = webImages(item.images);
  const available = buyable(item, now);
  return html`<li class="card">
  <a href="/parts/${item.handle}">
    <div class="card-image">${image ? html`<img src="${image}" alt="" loading="lazy" width="400" height="400">` : html`<span class="no-photo">Photo on request</span>`}</div>
    <h3>${item.title}</h3>
    <p class="price">${item.compareAtCents ? html`<s>${money(item.compareAtCents)}</s> ` : ''}${money(item.priceCents)}</p>
    <p class="tags">${item.fitment.slice(0, 2).map((f) => html`<span class="tag">${PLATFORMS[f.platform]?.label ?? f.platform}</span>`)}${item.fitment.some((f) => f.drive) ? html`<span class="tag">${item.fitment.find((f) => f.drive).drive}</span>` : ''}<span class="tag tag-quiet">${item.condition}</span>${available ? '' : html`<span class="tag tag-sold">${item.status === 'held' ? 'On hold' : 'Sold'}</span>`}</p>
  </a>
</li>`;
}

export function grid(items, now) {
  if (!items.length) return html`<p class="empty">Nothing listed for that yet. Much of the stock isn’t online, so ask: it may be on the shelf.</p>`;
  return html`<ul class="grid">${items.map((item) => card(item, now))}</ul>`;
}

export function homePage({ config, items, now }) {
  return storeLayout({
    config,
    title: '',
    description: `Used and performance parts for DSM and EVO, from ${config.business} in ${config.place}.`,
    body: html`<section class="hero">
  <p class="eyebrow">DSM · EVO · ${config.place}</p>
  <h1>Parts pulled from real cars, by people who race them.</h1>
  <p class="lede">${config.tagline}</p>
  ${vehiclePicker()}
</section>
<section class="section">
  <div class="section-head"><h2>Fresh off the shelf</h2><a href="/parts">All parts</a></div>
  ${grid(items, now)}
</section>
<section class="section split">
  <div><h2>Don’t see it?</h2><p>Much of the stock never makes it online. Text, message or email with your car and the part, and we’ll check the shelves.</p></div>
  <p><a class="button" href="mailto:${config.contactEmail}?subject=Part%20request">Ask for a part</a></p>
</section>`,
  });
}

export function listPage({ config, items, now, filter }) {
  const p = PLATFORMS[filter.platform];
  const heading = p ? `${filter.year ? `${filter.year} ` : ''}${p.label} parts` : 'All parts';
  return storeLayout({
    config,
    title: heading,
    body: html`<section class="section">
  <h1>${heading}</h1>
  ${vehiclePicker(filter)}
  <p class="quiet">${items.length} ${items.length === 1 ? 'part' : 'parts'}${filter.q ? html` matching “${filter.q}”` : ''}</p>
  ${grid(items, now)}
</section>`,
  });
}

export function partPage({ config, item, now }) {
  const images = webImages(item.images);
  const available = buyable(item, now);
  const ask = `mailto:${config.contactEmail}?subject=${encodeURIComponent(`${item.title} (${item.sku})`)}`;
  // Product structured data, so Google reads the same price and stock as the feed.
  const data = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: item.title,
    sku: item.sku,
    image: images,
    description: item.description || item.title,
    ...(item.mpn ? { mpn: item.mpn } : {}),
    offers: {
      '@type': 'Offer',
      url: `${config.publicUrl}/parts/${item.handle}`,
      priceCurrency: 'USD',
      price: (item.priceCents / 100).toFixed(2),
      availability: available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: { new: 'https://schema.org/NewCondition', used: 'https://schema.org/UsedCondition', refurbished: 'https://schema.org/RefurbishedCondition' }[item.condition],
    },
  };
  return storeLayout({
    config,
    title: item.title,
    description: (item.description || item.title).slice(0, 160),
    body: html`<article class="part">
  <div class="gallery">
    ${images.length ? images.map((src, i) => html`<img src="${src}" alt="${i === 0 ? item.title : ''}" ${i ? raw('loading="lazy"') : ''}>`) : html`<div class="no-photo big">Photos on request</div>`}
  </div>
  <div class="part-info">
    <p class="eyebrow">${item.category || 'Part'} · ${item.condition}</p>
    <h1>${item.title}</h1>
    <p class="price big">${item.compareAtCents ? html`<s>${money(item.compareAtCents)}</s> ` : ''}${money(item.priceCents)}</p>
    ${available
      ? html`<p class="stock">${item.quantity > 1 ? `${item.quantity} in stock` : 'One in stock'}</p>`
      : html`<p class="stock gone">${item.status === 'held' ? 'On hold for a buyer' : 'Sold'}</p>`}
    ${available ? html`<p class="buy-row"><a class="button" href="/parts/${item.handle}/buy">Buy it</a> <a class="button ghost" href="${ask}">Ask about it</a></p>` : ''}
    ${item.fitment.length ? html`<h2>Fits</h2><ul class="fits">${item.fitment.map((f) => html`<li><strong>${PLATFORMS[f.platform]?.label ?? f.platform}</strong> ${describe(f)}</li>`)}</ul>` : ''}
    ${item.description ? html`<h2>Details</h2>${paragraphs(item.description)}` : ''}
    <p class="quiet">SKU ${item.sku}</p>
  </div>
</article>
<script type="application/ld+json">${raw(JSON.stringify(data).replace(/</g, '\\u003c'))}</script>`,
  });
}

export function notFoundPage({ config }) {
  return storeLayout({ config, title: 'Not found', body: html`<section class="section"><h1>That part isn’t here</h1><p>It may have sold. <a href="/parts">See what’s listed</a> or ask us: much of the stock isn’t online.</p></section>` });
}

/** What a buyer sees when buying didn't start. */
export const SAY_BUYER = {
  'no-name': 'Add your name.',
  'bad-email': 'That email doesn’t look right.',
  'no-address': 'Add the address to ship it to.',
  gone: 'Someone else is buying this part right now, or it just sold. Ask us: there may be another on the shelf.',
  'pay-unavailable': 'The payment page wouldn’t open. Nothing was charged. Try again in a minute.',
};

/** Who's buying, and pickup or shipping. Then on to the payment platform's own page. */
export function buyPage({ config, item, now, platform, problem = '', form = {} }) {
  const available = buyable(item, now);
  const [image] = webImages(item.images);
  const value = (name) => form[name] ?? '';
  return storeLayout({
    config,
    title: `Buy ${item.title}`,
    body: html`<section class="section checkout">
  <p class="eyebrow">Checkout</p>
  <h1>${item.title}</h1>
  <div class="checkout-item">${image ? html`<img src="${image}" alt="" width="120" height="120">` : ''}<p class="price big">${money(item.priceCents)}</p></div>
  ${problem ? html`<p class="problem" role="alert">${problem}</p>` : ''}
  ${available ? html`<form method="post" action="/parts/${item.handle}/buy" class="form panel">
    <label>Your name<input name="name" value="${value('name')}" autocomplete="name" required maxlength="100"></label>
    <label>Email<input type="email" name="email" value="${value('email')}" autocomplete="email" required></label>
    <label>Phone (for pickup or a shipping question)<input type="tel" name="phone" value="${value('phone')}" autocomplete="tel"></label>
    <fieldset class="choice">
      <legend>How you’ll get it</legend>
      <label class="radio"><input type="radio" name="delivery" value="pickup" ${value('delivery') !== 'ship' ? raw('checked') : ''}> Pick it up in ${config.place}</label>
      <label class="radio"><input type="radio" name="delivery" value="ship" ${value('delivery') === 'ship' ? raw('checked') : ''}> Ship it to me</label>
    </fieldset>
    <label>Shipping address (only if shipping)<textarea name="address" rows="3" autocomplete="street-address">${value('address')}</textarea></label>
    <p class="hint">Shipping is quoted for each part before it goes out: we’ll text or email you the cost. You pay for the part now; it’s held for you.</p>
    <button type="submit" class="primary">Pay ${money(item.priceCents)}</button>
    <p class="quiet">${platform.name === 'test' ? 'Demo: you’ll go to a test payment page. No card is asked for and no money moves.' : 'You’ll pay on a secure payment page; your card never touches this site.'} The part is held for 30 minutes while you pay.</p>
  </form>` : html`<p class="stock gone">This part isn’t available right now.</p><p><a href="/parts">See what’s listed</a></p>`}
</section>`,
  });
}

/** After paying (or not): what happened to the order, in plain words. */
export function orderPage({ config, order, item, waiting = false, problem = '' }) {
  const title = item?.title ?? 'Your part';
  const states = {
    paid: html`<h1>It’s yours</h1><p>You bought <strong>${title}</strong> for ${money(order.cents)}. A receipt comes from the payment platform.</p>
      <p>${order.delivery === 'pickup' ? html`We’ll get in touch at ${order.email} to set a pickup time in ${config.place}.` : html`We’ll email ${order.email} the shipping cost before it goes out.`}</p>`,
    started: waiting
      ? html`<h1>Waiting on the payment</h1><p>We haven’t heard from the payment page yet. If you paid, this usually takes a few seconds: <a href="/orders/${order.key}">check again</a>.</p><p>The part stays held for you for 30 minutes. <a href="/orders/${order.key}/cancel">Cancel and let it go</a>.</p>`
      : html`<h1>Not paid yet</h1><p><a href="/parts/${item?.handle ?? ''}/buy">Try paying again</a>, or <a href="/orders/${order.key}/cancel">let it go</a>.</p>`,
    cancelled: html`<h1>Cancelled</h1><p>Nothing was charged, and the part is back on sale. <a href="/parts/${item?.handle ?? ''}">See the part</a>.</p>`,
    refunded: html`<h1>Refunded</h1><p>Sorry: ${title} sold at the counter while you were paying. Your payment of ${money(order.cents)} has been refunded in full. Ask us: there may be another on the shelf.</p>`,
    'refund-failed': html`<h1>We owe you a refund</h1><p>${title} sold while you were paying, and the automatic refund didn’t go through. We’ve been told and will refund ${money(order.cents)} by hand. Questions: <a href="mailto:${config.contactEmail}">${config.contactEmail}</a>.</p>`,
  };
  return storeLayout({
    config,
    title: 'Your order',
    body: html`<section class="section">
  <p class="eyebrow">Order</p>
  ${problem ? html`<p class="problem" role="alert">${problem}</p>` : ''}
  ${states[order.state]}
  <p class="quiet">Questions: <a href="mailto:${config.contactEmail}">${config.contactEmail}</a></p>
</section>`,
  });
}

/** The test payment page: where a buyer would be on Square's page. Plainly a test; it imitates no platform. */
export function testPayPage({ config, ref, shown }) {
  return storeLayout({
    config,
    title: 'Test payment page',
    body: html`<section class="section checkout">
  <div class="panel test-pay">
    <p><strong>Test payment page.</strong> No money moves and no card is asked for. Once Square is set up, buyers pay on Square’s own page here.</p>
    <h1>${shown.name}</h1>
    <p class="price big">${money(shown.cents)}</p>
    <form method="post" action="/pay/test"><input type="hidden" name="ref" value="${ref}"><input type="hidden" name="answer" value="pay"><button type="submit" class="primary">Pay ${money(shown.cents)}</button></form>
    <p><a href="${shown.back}/cancel">Go back without paying</a></p>
  </div>
</section>`,
  });
}
