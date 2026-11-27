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
    ${available ? html`<p><a class="button" href="${ask}">Ask about this part</a></p><p class="quiet">Online checkout comes with Square in the next release.</p>` : ''}
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
