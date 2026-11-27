// Configuration comes from the environment, once, here.
export function readConfig(source = process.env) {
  const prod = source.NODE_ENV === 'production';
  return Object.freeze({
    production: prod,
    demo: source.DEMO === '1',
    port: Number(source.PORT ?? 3000),
    database: source.DATABASE_PATH ?? 'data/potomac-shop.db',
    // The store's name, shown in the header, and used as the brand of unbranded parts in Meta's feed.
    business: source.BUSINESS_NAME ?? 'Rix Racing',
    tagline: source.BUSINESS_TAGLINE ?? 'We don’t just sell parts. We build race cars.',
    place: source.BUSINESS_PLACE ?? 'Morgantown, WV',
    // How buyers reach the owner about a part ("Ask about this part").
    contactEmail: source.CONTACT_EMAIL ?? 'ricky@rixracing.com',
    contactFacebook: source.CONTACT_FACEBOOK ?? 'https://www.facebook.com/RixRacing',
    // The public address; feeds link to it.
    publicUrl: (source.PUBLIC_URL ?? `http://localhost:${source.PORT ?? 3000}`).replace(/\/+$/, ''),
    // The owner's sign-in until staff accounts arrive from the kit.
    ownerPassword: source.OWNER_PASSWORD ?? (prod ? '' : 'owner-dev-password'),
    secret: source.SESSION_SECRET ?? (prod ? '' : 'development-only-secret-do-not-use-in-production'),
  });
}

export const config = readConfig();

/** Refuse to start half-configured in production. */
export function checkConfig(c = config) {
  if (!c.production) return;
  const missing = [];
  if (c.secret.length < 32) missing.push('SESSION_SECRET (32+ characters)');
  if (!c.ownerPassword || c.ownerPassword.length < 12) missing.push('OWNER_PASSWORD (12+ characters)');
  if (!/^https:\/\//.test(c.publicUrl)) missing.push('PUBLIC_URL (https://...)');
  if (missing.length) throw new Error(`Not starting: set ${missing.join(', ')}.`);
}
