// Configuration comes from the environment, once, here.
import { themeOf } from './themes.js';
export function readConfig(source = process.env) {
  const theme = themeOf(source.STORE_THEME);
  const given = (name, fallback) => source[name] ?? theme.defaults?.[fallback[0]] ?? fallback[1];
  const prod = source.NODE_ENV === 'production';
  const port = Number(source.PORT ?? 3000);
  return Object.freeze({
    production: prod,
    demo: source.DEMO === '1',
    port,
    database: source.DATABASE_PATH ?? 'data/potomac-shop.db',
    // The store's name, shown in the header, and used as the brand of unbranded parts in Meta's feed.
    business: given('BUSINESS_NAME', ['business', 'Rix Racing']),
    tagline: given('BUSINESS_TAGLINE', ['tagline', 'We don’t just sell parts. We build race cars.']),
    place: given('BUSINESS_PLACE', ['place', 'Morgantown, WV']),
    // How buyers reach the owner about a part ("Ask about this part").
    contactEmail: given('CONTACT_EMAIL', ['contactEmail', 'ricky@rixracing.com']),
    contactFacebook: given('CONTACT_FACEBOOK', ['contactFacebook', 'https://www.facebook.com/RixRacing']),
    // The public address; feeds and payment pages link back to it.
    publicUrl: (source.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    // Signs the dashboard's form tokens and messages.
    secret: source.SESSION_SECRET ?? (prod ? '' : 'development-only-secret-do-not-use-in-production'),
    // How many proxies in front add to X-Forwarded-For (1 on Railway).
    proxies: Number(source.TRUSTED_PROXIES ?? (prod ? 1 : 0)),
    // AI drafts from photos. Without a key the button isn't shown.
    ai: Object.freeze({
      apiKey: (source.ANTHROPIC_API_KEY ?? '').trim(),
      model: (source.AI_MODEL ?? 'claude-haiku-5-5').trim(),
      monthlyDollars: Number(source.AI_MONTHLY_DOLLARS ?? 10),
      // Dollars per million tokens, to count spending against the budget. Set them to the model's price.
      rates: Object.freeze({ input: Number(source.AI_INPUT_PER_MTOK ?? 1), output: Number(source.AI_OUTPUT_PER_MTOK ?? 5) }),
    }),
    // How the store looks and sounds (src/themes.js), and the business's own site it sits beside.
    theme,
    siteUrl: (source.SITE_URL ?? '').replace(/\/+$/, ''),
    // PAY_PROVIDER and its PAY_* settings are read by the kit (src/app/payments.js, choosePayments).
    env: source,
  });
}

export const config = readConfig();

/** Refuse to start half-configured in production. */
export function checkConfig(c = config) {
  if (!c.production) return;
  const missing = [];
  if (c.secret.length < 32) missing.push('SESSION_SECRET (32+ characters)');
  if (!/^https:\/\//.test(c.publicUrl)) missing.push('PUBLIC_URL (https://...)');
  if (missing.length) throw new Error(`Not starting: set ${missing.join(', ')}.`);
}
