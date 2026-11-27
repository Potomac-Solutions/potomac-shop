// The owner's side: list, edit, sell, remove, import and export. Phone first: one column, big targets.
import { ago, html, money, raw } from './html.js';
import { PLATFORMS, describe, toColumn } from '../domain/fitment.js';
import { SOURCES } from '../domain/sources.js';
import { buyable, webImages } from '../domain/exports.js';

const LABELS = { draft: 'Draft', active: 'Listed', held: 'On hold', sold: 'Sold', archived: 'Archived' };

/** What each refusal from the catalog means, for people. */
export const SAY = {
  'not-draft': 'Only a draft can be listed.',
  'no-stock': 'Set a quantity of at least one first.',
  'no-price': 'Set a price first.',
  'not-active': 'Only a listed part can do that.',
  'bad-time': 'Pick a time in the future.',
  'not-held': 'That part isn’t on hold.',
  'already-sold': 'That part has already sold.',
  'not-for-sale': 'Only a listed or held part can be sold.',
  'not-enough': 'There aren’t that many in stock.',
  'already-archived': 'That part is already archived.',
  'not-archived': 'Only an archived part can be brought back.',
  'no-title': 'A part needs a title.',
  'bad-price': 'The price has to be an amount, like 45.00.',
  'bad-quantity': 'The quantity has to be a whole number.',
  'sku-taken': 'Another part already has that SKU.',
  'unknown-format': 'That file isn’t an export we recognise. Shopify, WooCommerce, BigCommerce, Magento and our own CSV are.',
  'nothing-to-import': 'Nothing in that file could be imported. The preview says why for each row.',
  'changed-since': 'Some of those parts have changed since that import, so it can’t be undone as a whole.',
  'already-undone': 'That import was already undone.',
  'no-name': 'Give the lot a name.',
};

export function adminLayout({ config, title, body, notice = '', token = '' }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · ${config.business} dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700&family=Roboto:wght@400;500;700&display=swap">
<link rel="stylesheet" href="/static/shop.css">
<script src="/static/admin.js" defer></script>
</head>
<body class="admin">
<header class="top">
  <a class="brand" href="/admin"><span class="brand-mark">RIX</span> Dashboard</a>
  <nav aria-label="Dashboard">
    <a href="/admin/items/new">+ List a part</a>
    <a href="/admin/items">Parts</a>
    <a href="/admin/lots">Donor cars</a>
    <a href="/admin/import">Import</a>
    <a href="/admin/channels">Channels</a>
    <a href="/" target="_blank" rel="noopener">Store ↗</a>
    ${token ? html`<form method="post" action="/admin/sign-out" class="inline"><input type="hidden" name="token" value="${token}"><button class="link">Sign out</button></form>` : ''}
  </nav>
</header>
<main id="main" class="admin-main">
${notice ? html`<p class="notice" role="status">${notice}</p>` : ''}
${body}
</main>
</body>
</html>`;
}

export function signInPage({ config, problem = '' }) {
  return adminLayout({
    config,
    title: 'Sign in',
    body: html`<section class="panel narrow">
  <h1>Owner sign-in</h1>
  ${problem ? html`<p class="problem" role="alert">${problem}</p>` : ''}
  ${config.demo ? html`<p class="demo-login">This is a demo. The password is <strong>${config.ownerPassword}</strong>. Everything resets overnight.</p>` : ''}
  <form method="post" action="/admin/sign-in">
    <label>Password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
    <button type="submit">Sign in</button>
  </form>
</section>`,
  });
}

const statusBadge = (status) => html`<span class="badge badge-${status}">${LABELS[status]}</span>`;

export function dashboardPage({ config, token, summary, drafts, recent, notice, now }) {
  const { counts } = summary;
  return adminLayout({
    config,
    token,
    notice,
    title: 'Today',
    body: html`<h1>Today</h1>
<div class="stats">
  <a class="stat" href="/admin/items?status=draft"><span>${counts.draft}</span>waiting to be listed</a>
  <a class="stat" href="/admin/items?status=active"><span>${counts.active}</span>listed</a>
  <a class="stat" href="/admin/items?status=held"><span>${counts.held}</span>on hold</a>
  <a class="stat" href="/admin/items?status=sold"><span>${counts.sold}</span>sold</a>
</div>
${summary.noPhoto || summary.noFit ? html`<section class="panel warn">
  <h2>Needs a look</h2>
  <ul>
    ${summary.noPhoto ? html`<li><a href="/admin/items?status=active&amp;need=photo">${summary.noPhoto} listed ${summary.noPhoto === 1 ? 'part has' : 'parts have'} no photo</a>: Google and Meta won’t show ${summary.noPhoto === 1 ? 'it' : 'them'}.</li>` : ''}
    ${summary.noFit ? html`<li><a href="/admin/items?need=fitment">${summary.noFit} ${summary.noFit === 1 ? 'part says' : 'parts say'} nothing about which car ${summary.noFit === 1 ? 'it fits' : 'they fit'}</a>: shop-by-vehicle can’t find ${summary.noFit === 1 ? 'it' : 'them'}.</li>` : ''}
  </ul>
</section>` : ''}
<section class="panel">
  <h2>Waiting to be listed</h2>
  ${drafts.length ? itemTable(drafts, token, now) : html`<p class="quiet">Nothing waiting. <a href="/admin/items/new">List a part</a>.</p>`}
</section>
<section class="panel">
  <h2>What happened</h2>
  ${activityList(recent, now)}
</section>`,
  });
}

function activityList(entries, now) {
  if (!entries.length) return html`<p class="quiet">Nothing yet.</p>`;
  return html`<ul class="activity">${entries.map((a) => html`<li><span class="quiet">${ago(a.at, now)}</span> <strong>${a.who}</strong> ${a.action}${a.title ? html` <a href="/admin/items/${a.item_id}">${a.title}</a>` : ''}${a.detail ? html` <span class="quiet">${a.detail}</span>` : ''}</li>`)}</ul>`;
}

/** One-tap actions for a part, as small forms. */
function actions(item, token, now) {
  const button = (action, label, extra = '') => html`<form method="post" action="/admin/items/${item.id}/${action}" class="inline"><input type="hidden" name="token" value="${token}">${raw(extra)}<button class="small ${action === 'sell' ? 'primary' : ''}">${label}</button></form>`;
  const out = [];
  if (item.status === 'draft') out.push(button('publish', 'List it'));
  if (item.status === 'active' || item.status === 'held') out.push(button('sell', 'Sold'));
  if (item.status === 'active') out.push(button('hold', 'Hold 24 h', `<input type="hidden" name="hours" value="24">`));
  if (item.status === 'held') out.push(button('release', 'Release'));
  if (item.status === 'active') out.push(button('unpublish', 'Unlist'));
  if (item.status !== 'archived') out.push(button('archive', 'Remove'));
  if (item.status === 'archived') out.push(button('restore', 'Bring back'));
  return out;
}

function itemTable(items, token, now) {
  return html`<ul class="rows">${items.map((item) => {
    const [image] = webImages(item.images);
    return html`<li class="row">
  <a class="thumb" href="/admin/items/${item.id}">${image ? html`<img src="${image}" alt="" loading="lazy">` : html`<span>No photo</span>`}</a>
  <div class="row-main">
    <a href="/admin/items/${item.id}"><strong>${item.title}</strong></a>
    <p class="quiet">${money(item.priceCents)} · ${item.quantity} · ${statusBadge(item.status)} ${item.fitment.length ? html`· ${item.fitment.map((f) => PLATFORMS[f.platform]?.label ?? f.platform).join(', ')}` : html`· <span class="warn-text">no fitment</span>`}${item.lotName ? html` · ${item.lotName}` : ''}</p>
  </div>
  <div class="row-actions">${actions(item, token, now)}</div>
</li>`;
  })}</ul>`;
}

export function itemsPage({ config, token, items, filter, notice, now }) {
  const tab = (status, label) => html`<a href="/admin/items${status ? `?status=${status}` : ''}" ${filter.status === status ? raw('aria-current="page"') : ''}>${label}</a>`;
  return adminLayout({
    config,
    token,
    notice,
    title: 'Parts',
    body: html`<div class="head-row"><h1>Parts</h1><a class="button" href="/admin/items/new">+ List a part</a></div>
<nav class="tabs" aria-label="Status">${tab('', 'All')}${tab('draft', 'Drafts')}${tab('active', 'Listed')}${tab('held', 'On hold')}${tab('sold', 'Sold')}${tab('archived', 'Removed')}</nav>
<form method="get" action="/admin/items" class="search">
  ${filter.status ? html`<input type="hidden" name="status" value="${filter.status}">` : ''}
  <input type="search" name="q" value="${filter.q}" placeholder="Search title, SKU or category" aria-label="Search parts">
  <button>Search</button>
</form>
<p class="quiet">${items.length} shown</p>
${items.length ? itemTable(items, token, now) : html`<p class="quiet">Nothing here.</p>`}`,
  });
}

export function itemPage({ config, token, item, lots, history, notice, problem, now }) {
  const isNew = !item.id;
  const value = (field) => item[field] ?? '';
  return adminLayout({
    config,
    token,
    notice,
    title: isNew ? 'List a part' : item.title,
    body: html`<div class="head-row"><h1>${isNew ? 'List a part' : item.title}</h1>${isNew ? '' : statusBadge(item.status)}</div>
${problem ? html`<p class="problem" role="alert">${problem}</p>` : ''}
${isNew ? '' : html`<div class="row-actions big">${actions(item, token, now)}${item.status === 'active' || item.status === 'held' ? html`<a class="button small" href="/parts/${item.handle}" target="_blank" rel="noopener">See it in the store ↗</a>` : ''}</div>`}
<form method="post" action="${isNew ? '/admin/items' : `/admin/items/${item.id}`}" class="panel form">
  <input type="hidden" name="token" value="${token}">
  <label>Title<input name="title" value="${value('title')}" required placeholder="2g 95-99 manual shifter base & shifter OEM"></label>
  <p class="hint">Write it the way you always do: “2g 95-99 …”, “1G 1990 …”, “GVR4 …”. Fitment is read from it when the fitment box is empty.</p>
  <div class="cols">
    <label>Price<input name="price" inputmode="decimal" value="${item.priceCents != null ? (item.priceCents / 100).toFixed(2) : ''}" required placeholder="45.00"></label>
    <label>Was (optional)<input name="compare_at" inputmode="decimal" value="${item.compareAtCents != null ? (item.compareAtCents / 100).toFixed(2) : ''}"></label>
    <label>Quantity<input name="quantity" inputmode="numeric" value="${item.quantity ?? 1}"></label>
  </div>
  <div class="cols">
    <label>Condition<select name="condition">${['used', 'new', 'refurbished'].map((c) => html`<option ${c === (item.condition ?? 'used') ? raw('selected') : ''}>${c}</option>`)}</select></label>
    <label>Category<input name="category" value="${value('category')}" placeholder="Drivetrain"></label>
    <label>Donor car<select name="lot"><option value="">None</option>${lots.map((lot) => html`<option value="${lot.id}" ${lot.id === item.lotId ? raw('selected') : ''}>${lot.name}</option>`)}</select></label>
  </div>
  <label>Fits<input name="fitment" value="${item.fitment?.length ? toColumn(item.fitment) : ''}" placeholder="2G DSM 1995-1999 Eclipse Talon AWD; GVR4"></label>
  ${item.fitment?.length ? html`<ul class="fits small">${item.fitment.map((f) => html`<li>${PLATFORMS[f.platform]?.label ?? f.platform}: ${describe(f)}</li>`)}</ul>` : ''}
  <div class="cols">
    <label>Maker’s part number<input name="mpn" value="${value('mpn')}" placeholder="OEM or brand part number"></label>
    <label>Brand<input name="brand" value="${value('brand')}" placeholder="Mitsubishi, FatBoy FAB…"></label>
  </div>
  <label>Photos (one address per line)<textarea name="images" rows="3">${(item.images ?? []).join('\n')}</textarea></label>
  <label>Details<textarea name="description" rows="5">${value('description')}</textarea></label>
  <button type="submit" class="primary">${isNew ? 'Save as draft' : 'Save changes'}</button>
</form>
${isNew ? '' : html`<section class="panel">
  <h2>Post it by hand</h2>
  <p class="quiet">Facebook Marketplace and forums don’t take listings from stores’ software yet. Copy this, add the photos, post it, and mark it sold here when it goes.</p>
  <textarea class="copy" rows="6" readonly data-copy>${marketplaceText(item, config)}</textarea>
  <button type="button" class="small" data-copy-button>Copy listing text</button>
</section>
<section class="panel"><h2>History</h2>${activityList(history.map((h) => ({ ...h, title: '' })), now)}</section>`}`,
  });
}

/** A listing written for Marketplace, Craigslist or a forum post. */
export function marketplaceText(item, config) {
  const fits = item.fitment.map((f) => `${PLATFORMS[f.platform]?.label ?? f.platform} ${describe(f)}`).join('; ');
  return [
    `${item.title} – ${money(item.priceCents)}`,
    `Condition: ${item.condition}`,
    fits ? `Fits: ${fits}` : '',
    item.description,
    `More photos and details: ${config.publicUrl}/parts/${item.handle}`,
    `${config.business}, ${config.place}`,
  ].filter(Boolean).join('\n');
}

export function importPage({ config, token, notice, problem, plan, text, options, batches, now }) {
  return adminLayout({
    config,
    token,
    notice,
    title: 'Import',
    body: html`<h1>Bring your products over</h1>
${problem ? html`<p class="problem" role="alert">${problem}</p>` : ''}
${plan ? previewPanel({ plan, text, options, token }) : html`<section class="panel">
  <p>Export your products from your old store as a CSV, then choose the file here. Nothing changes until you’ve seen the preview.</p>
  <details><summary>How to get the file out of your store</summary>
    <ul>
      <li><strong>Shopify:</strong> Products → Export → All products → CSV. Big stores get the file by email. Keep the old store open until the import has copied your photos.</li>
      <li><strong>BigCommerce:</strong> Products → Export → pick a template (Bulk Edit is fine) → Export as CSV → download.</li>
      <li><strong>WooCommerce:</strong> Products → All Products → Export → Generate CSV.</li>
      <li><strong>Magento / Adobe Commerce:</strong> System → Data Transfer → Export → Entity Type: Products → CSV. Give us your store’s image address below so photos come along.</li>
    </ul>
  </details>
  <form method="post" action="/admin/import/preview" class="form">
    <input type="hidden" name="token" value="${token}">
    <label>Product CSV<input type="file" accept=".csv,text/csv" data-file-into="csv"></label>
    <label>…or paste it<textarea name="csv" id="csv" rows="6" placeholder="Handle,Title,Body (HTML),…"></textarea></label>
    <div class="cols">
      <label>Parts that don’t say are<select name="condition"><option>used</option><option>new</option></select></label>
      <label>Your store’s name, if it fills the Vendor column<input name="ignore_brand" value="${config.business}"></label>
    </div>
    <label>Magento image address (only for Magento)<input name="image_base" placeholder="https://yourstore.com/media/catalog/product"></label>
    <button class="primary">Preview</button>
  </form>
</section>`}
<section class="panel">
  <h2>Past imports</h2>
  ${batches.length ? html`<ul class="rows">${batches.map((b) => html`<li class="row"><div class="row-main"><strong>${SOURCES[b.source] ?? b.source}</strong> ${b.filename} <p class="quiet">${b.created_count} new, ${b.updated_count} updated · ${ago(b.created_at, now)}${b.undone_at ? ' · undone' : ''}</p></div>${b.undone_at ? '' : html`<form method="post" action="/admin/import/${b.id}/undo" class="inline"><input type="hidden" name="token" value="${token}"><button class="small">Undo</button></form>`}</li>`)}</ul>` : html`<p class="quiet">None yet.</p>`}
</section>`,
  });
}

function previewPanel({ plan, text, options, token }) {
  const label = { create: 'New', update: 'Update', skip: 'Skipped' };
  return html`<section class="panel">
  <h2>Preview: ${SOURCES[plan.source]} export</h2>
  <p><strong>${plan.creates}</strong> new, <strong>${plan.updates}</strong> to update, <strong>${plan.skips}</strong> skipped.</p>
  <form method="post" action="/admin/import/commit" class="inline-form">
    <input type="hidden" name="token" value="${token}">
    <textarea name="csv" hidden>${text}</textarea>
    <input type="hidden" name="condition" value="${options.condition}">
    <input type="hidden" name="ignore_brand" value="${options.ignoreBrand ?? ''}">
    <input type="hidden" name="image_base" value="${options.imageBase ?? ''}">
    <button class="primary" ${plan.creates + plan.updates ? '' : raw('disabled')}>Import ${plan.creates + plan.updates} ${plan.creates + plan.updates === 1 ? 'part' : 'parts'}</button>
    <a href="/admin/import">Start over</a>
  </form>
  <table class="preview">
    <thead><tr><th>Row</th><th>What happens</th><th>Part</th><th>Price</th><th>Fits</th></tr></thead>
    <tbody>${plan.rows.map(({ draft, action, reason }) => html`<tr class="${action}">
      <td>${draft.row}</td>
      <td>${label[action]}${draft.problems.length || reason ? html`<br><span class="warn-text">${[...draft.problems, reason].filter(Boolean).join(' ')}</span>` : ''}</td>
      <td>${draft.title || '—'}<br><span class="quiet">${draft.sku}</span></td>
      <td>${draft.priceCents != null ? money(draft.priceCents) : '—'}</td>
      <td>${draft.fitment.length ? draft.fitment.map((f) => PLATFORMS[f.platform]?.label ?? f.platform).join(', ') : html`<span class="quiet">—</span>`}</td>
    </tr>`)}</tbody>
  </table>
</section>`;
}

export function lotsPage({ config, token, lots, notice, problem }) {
  return adminLayout({
    config,
    token,
    notice,
    title: 'Donor cars',
    body: html`<h1>Donor cars</h1>
<p class="quiet">Every car you haul home, and what its parts have paid back.</p>
${problem ? html`<p class="problem" role="alert">${problem}</p>` : ''}
<form method="post" action="/admin/lots" class="panel form">
  <input type="hidden" name="token" value="${token}">
  <h2>Log a car</h2>
  <div class="cols">
    <label>What is it<input name="name" required placeholder="1995 Talon TSi AWD, Kona Blue"></label>
    <label>VIN<input name="vin" autocapitalize="characters" maxlength="17"></label>
    <label>Paid<input name="cost" inputmode="decimal" placeholder="800.00"></label>
  </div>
  <button class="primary">Save</button>
</form>
${lots.length ? html`<ul class="rows">${lots.map((lot) => html`<li class="row"><div class="row-main"><a href="/admin/items?lot=${lot.id}"><strong>${lot.name}</strong></a>
  <p class="quiet">Paid ${money(lot.costCents)} · sold ${money(lot.payoff.soldCents)} from ${lot.payoff.soldCount} of ${lot.payoff.count} parts · listed ${money(lot.payoff.listedCents)} · <span class="${lot.payoff.net >= 0 ? 'good' : 'warn-text'}">${lot.payoff.net >= 0 ? 'paid off by' : 'still owes'} ${money(Math.abs(lot.payoff.net))}</span></p></div></li>`)}</ul>` : ''}`,
  });
}

export function channelsPage({ config, token, items, now }) {
  const listed = items.filter((item) => item.status === 'active' || item.status === 'held');
  const inFeed = listed.filter((item) => webImages(item.images).length > 0);
  const live = listed.filter((item) => buyable(item, now));
  return adminLayout({
    config,
    token,
    title: 'Channels',
    body: html`<h1>Where your parts show up</h1>
<p class="quiet">Every channel reads the same list. Mark a part sold anywhere and it drops out of all of them.</p>
<section class="panel">
  <h2>Your store</h2>
  <p>${live.length} parts for sale at <a href="${config.publicUrl}">${config.publicUrl}</a>.</p>
</section>
<section class="panel">
  <h2>Google Shopping</h2>
  <p>${inFeed.length} of ${listed.length} listed parts are in the feed (a part needs a photo Google can show).</p>
  <p>In Google Merchant Center, add a product source → <em>Add products from a file</em> → <em>Enter a link to your file</em>, and give it this address. Set it to fetch daily.</p>
  <p><code>${config.publicUrl}/feeds/google.tsv</code></p>
</section>
<section class="panel">
  <h2>Facebook and Instagram</h2>
  <p>In Meta Commerce Manager, open your catalog → Data sources → Data feed → <em>Use a URL</em>, and give it this address. Set a daily schedule.</p>
  <p><code>${config.publicUrl}/feeds/meta.csv</code></p>
</section>
<section class="panel">
  <h2>Facebook Marketplace and forums</h2>
  <p>Not automatic yet: Meta only takes Marketplace listings from approved partners. Each part’s page has a <em>Copy listing text</em> box to post it by hand.</p>
</section>
<section class="panel">
  <h2>Files</h2>
  <ul>
    <li><a href="/admin/export/csv">Everything, in our CSV</a> (opens in any spreadsheet, imports back here)</li>
    <li><a href="/admin/export/shopify">Everything, as a Shopify product CSV</a></li>
  </ul>
</section>
<section class="panel quiet">
  <h2>Coming next</h2>
  <p>eBay Motors with fitment, and two-way stock with Square and Clover at the counter.</p>
</section>`,
  });
}
