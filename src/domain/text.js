// Small text rules shared by the importer, the feeds and the pages. No I/O.

/** "$1,234.50", "1234.5", "  12 " to whole cents; null when it isn't an amount. */
export function toCents(value) {
  const text = String(value ?? '').replace(/[$,\s]/g, '');
  if (text === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, part = ''] = text.split('.');
  return Number(whole) * 100 + Number(part.padEnd(2, '0'));
}

/** 12345 to "123.45": the plain form feeds and CSV want. */
export const centsToAmount = (cents) => (cents / 100).toFixed(2);

/** "2G 95-99 Seat Belts & Latches!" to "2g-95-99-seat-belts-latches". */
export function slugify(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };

// "&#8217;" and "&#x2019;" to the character; anything out of range stays as written.
function charRef(name) {
  const match = /^#(x[0-9a-f]+|\d+)$/i.exec(name);
  if (!match) return null;
  const code = match[1][0].toLowerCase() === 'x' ? parseInt(match[1].slice(1), 16) : Number(match[1]);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null;
}

/**
 * HTML from another platform (Shopify's "Body (HTML)") to plain text with paragraph breaks.
 * We never store or show someone else's HTML: what a store wrote comes back as text.
 */
export function htmlToText(html) {
  return String(html ?? '')
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#?\w+);/g, (match, name) => ENTITIES[name.toLowerCase()] ?? charRef(name) ?? match)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** A cell our own export protected against spreadsheet formulas ("'=x") back to what was written. */
export const unprotect = (text) => String(text ?? '').replace(/^'(?=[=+\-@\t\r])/, '');
