// Small guards for the web layer.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Whether a form post came from another site: by Sec-Fetch-Site, or else an Origin naming another
 * host. Browsers send one or the other on every form post; a post with neither isn't refused here
 * (the dashboard's forms also carry a token).
 */
export function crossSite(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return Boolean(origin);
  try {
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true;
  }
}

/**
 * One-line messages after a form post ride in the address (?done=… or ?problem=…), signed, so
 * nobody can put words in a real page's message box with a link of their own.
 */
export function createNotices(secret) {
  const sign = (text) => createHmac('sha256', secret).update(`notice.${text}`).digest('base64url').slice(0, 22);
  return {
    /** A path with a message, signed. */
    to(path, words, kind = 'done') {
      const text = String(words).slice(0, 300);
      return `${path}${path.includes('?') ? '&' : '?'}${kind}=${encodeURIComponent(text)}&sig=${sign(`${kind}:${text}`)}`;
    },
    /** The message on a request's address, or '' when it wasn't signed here. */
    read(url) {
      for (const kind of ['done', 'problem']) {
        const text = url.searchParams.get(kind);
        if (text && same(url.searchParams.get('sig') ?? '', sign(`${kind}:${text}`))) return { [kind]: text };
      }
      return {};
    },
  };
}

/** The address a request came from; behind `proxies` trusted proxies, the entry they added. */
export function clientAddress(req, proxies = 0) {
  if (proxies > 0) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((part) => part.trim()).filter(Boolean);
    const entry = forwarded[forwarded.length - proxies];
    if (entry) return entry;
  }
  return req.socket?.remoteAddress ?? '';
}
