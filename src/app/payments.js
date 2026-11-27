// Taking payment for an order on the payment platform's own page, so no card number ever reaches
// this store. A provider does four things:
//
//   start({ key, cents, name, email, back })  → { ok, ref, url } | { error }
//   check({ ref })                            → { paid: true, cents, paymentId } | { paid: false } | { error }
//   refund({ paymentId, cents, key })         → { ok } | { error }
//   hear({ headers, body, url })              → { ref } | { ignore: true } | { error: 'bad-signature' }
//
// This file owns what every provider needs around that: an order is paid at most once, at the
// amount asked, however many times the buyer comes back or the webhook arrives. `check` is the
// only thing believed; a return address or webhook only says which payment to check.
//
// Providers here: `square` (payment links, Square's Checkout API) and `testProvider` (a page of our
// own that takes no money, for the demo and until Square's keys are set). Square's has been
// written from Square's API reference and tested against a faked Square; run it in Square's
// sandbox before taking real money.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** A provider that takes no money: its "platform page" is /pay/test on this store. */
export function testProvider({ page = '/pay/test' } = {}) {
  const started = new Map();
  return {
    name: 'test',
    async start({ cents, name, back }) {
      const ref = `test_${randomBytes(9).toString('base64url')}`;
      started.set(ref, { cents, name, back, paid: false });
      return { ok: true, ref, url: `${page}?ref=${ref}` };
    },
    async check({ ref }) {
      const one = started.get(ref);
      if (!one) return { error: 'unknown-payment' };
      return one.paid ? { paid: true, cents: one.cents, paymentId: `pay_${ref}` } : { paid: false };
    },
    async refund({ paymentId }) {
      return { ok: true, ref: `refund_${paymentId}` };
    },
    async hear() {
      return { ignore: true };
    },
    /** What the test page shows, or null. */
    pageFor: (ref) => (started.has(ref) ? { ...started.get(ref) } : null),
    /** The buyer pressed Pay on the test page. */
    approve(ref) {
      const one = started.get(ref);
      if (one) one.paid = true;
      return Boolean(one);
    },
  };
}

/**
 * Square: a quick-pay payment link per order. `token` is an access token, `location` the
 * location id. `webhookKey` and `webhookUrl` are the webhook subscription's signature key and the
 * exact address Square posts to (Square signs that address with the body).
 */
export function square({ token, location, webhookKey = '', webhookUrl = '', sandbox = false, version = '2025-01-23', fetch: fetcher = fetch }) {
  if (!token || !location) throw new TypeError('Square needs an access token and a location');
  const base = sandbox ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
  async function call(path, { method = 'GET', body } = {}) {
    const response = await fetcher(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'square-version': version, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  }
  const failed = (status) => ({ error: status === 401 || status === 403 ? 'provider-refused-key' : status === 429 ? 'provider-busy' : 'provider-failed' });
  return {
    name: 'square',
    async start({ key, cents, name, email, back }) {
      const { status, data } = await call('/v2/online-checkout/payment-links', {
        method: 'POST',
        body: {
          idempotency_key: `ps-${key}`.slice(0, 45),
          quick_pay: { name: String(name).slice(0, 255), price_money: { amount: cents, currency: 'USD' }, location_id: location },
          checkout_options: { redirect_url: back },
          ...(email ? { pre_populated_data: { buyer_email: email } } : {}),
        },
      });
      const link = data?.payment_link;
      if (status >= 300 || !link?.url || !link?.order_id) return failed(status);
      // The payment link's order is what gets paid; it is the reference we check.
      return { ok: true, ref: link.order_id, url: link.url };
    },
    async check({ ref }) {
      const { status, data } = await call(`/v2/orders/${encodeURIComponent(ref)}`);
      if (status >= 300 || !data?.order) return failed(status);
      const order = data.order;
      const tender = (order.tenders ?? [])[0];
      const due = order.net_amount_due_money?.amount ?? order.total_money?.amount;
      if (!tender || due !== 0 || order.state === 'CANCELED') return { paid: false };
      return { paid: true, cents: order.total_money?.amount ?? 0, paymentId: tender.payment_id ?? tender.id };
    },
    async refund({ paymentId, cents, key }) {
      const { status, data } = await call('/v2/refunds', {
        method: 'POST',
        body: { idempotency_key: `ps-refund-${key}`.slice(0, 45), payment_id: paymentId, amount_money: { amount: cents, currency: 'USD' }, reason: 'Sold before the payment finished' },
      });
      return status < 300 && data?.refund ? { ok: true, ref: data.refund.id } : failed(status);
    },
    async hear({ headers, body }) {
      if (!webhookKey || !webhookUrl) return { ignore: true };
      const expected = createHmac('sha256', webhookKey).update(webhookUrl + body).digest('base64');
      const given = headers['x-square-hmacsha256-signature'] ?? '';
      if (!same(given, expected)) return { error: 'bad-signature' };
      let event;
      try {
        event = JSON.parse(body);
      } catch {
        return { ignore: true };
      }
      const orderId = event?.data?.object?.payment?.order_id;
      return String(event?.type ?? '').startsWith('payment.') && orderId ? { ref: orderId } : { ignore: true };
    },
  };
}

/**
 * The provider PAY_PROVIDER names, if its settings are all there; otherwise the test page.
 * Answers { provider, name, sandbox, asked }.
 */
export function choosePayments(env = {}, { fetch: fetcher } = {}) {
  const test = testProvider();
  const asked = String(env.PAY_PROVIDER ?? '').trim().toLowerCase();
  if (asked === 'square' && env.PAY_SQUARE_TOKEN && env.PAY_SQUARE_LOCATION) {
    const sandbox = /^(1|true|yes)$/i.test(String(env.PAY_SQUARE_SANDBOX ?? ''));
    const provider = square({
      token: env.PAY_SQUARE_TOKEN.trim(),
      location: env.PAY_SQUARE_LOCATION.trim(),
      webhookKey: (env.PAY_SQUARE_WEBHOOK_KEY ?? '').trim(),
      webhookUrl: (env.PAY_SQUARE_WEBHOOK_URL ?? '').trim(),
      sandbox,
      ...(env.PAY_SQUARE_VERSION ? { version: env.PAY_SQUARE_VERSION.trim() } : {}),
      ...(fetcher ? { fetch: fetcher } : {}),
    });
    return { provider, test, name: 'square', sandbox, asked };
  }
  return { provider: test, test, name: 'test', sandbox: true, asked };
}

/** Payments for orders, kept in the `payments` table. */
export function createPayments({ db, provider, now = Date.now }) {
  const byKey = db.prepare('SELECT * FROM payments WHERE order_key = ?');
  const byRef = db.prepare('SELECT * FROM payments WHERE provider = ? AND ref = ?');
  const safely = async (run) => {
    try {
      return (await run()) ?? { error: 'provider-failed' };
    } catch {
      return { error: 'provider-failed' };
    }
  };

  return {
    get: (key) => byKey.get(key) ?? null,

    /** Open the payment page for an order (once; asked again, the same page). */
    async start({ key, cents, name, email, back }) {
      const before = byKey.get(key);
      if (before?.state === 'paid') return { error: 'paid' };
      if (before) return { ok: true, url: before.url, ref: before.ref, again: true };
      const made = await safely(() => provider.start({ key, cents, name, email, back }));
      if (!made.ok || !made.ref || !made.url) return { error: made.error ?? 'provider-failed' };
      db.prepare('INSERT INTO payments (order_key, provider, ref, url, cents, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(key, provider.name, made.ref, made.url, cents, now());
      return { ok: true, url: made.url, ref: made.ref };
    },

    /** Ask the platform whether an order was paid, and record it once. */
    async settle(key) {
      const payment = byKey.get(key);
      if (!payment) return { error: 'no-payment' };
      if (payment.state !== 'started') return { ok: true, again: true, paymentId: payment.payment_id };
      const answer = await safely(() => provider.check({ ref: payment.ref }));
      if (answer.error) return { error: answer.error };
      if (!answer.paid) return { error: 'not-paid' };
      if (answer.cents !== payment.cents) return { error: 'wrong-amount', paymentId: String(answer.paymentId ?? '') };
      const changed = db.prepare("UPDATE payments SET state = 'paid', payment_id = ?, paid_at = ? WHERE order_key = ? AND state = 'started'").run(String(answer.paymentId ?? ''), now(), key).changes;
      return { ok: true, again: changed === 0, paymentId: String(answer.paymentId ?? '') };
    },

    /** A webhook: which order it is about, settled. `bad-signature` is a request to refuse. */
    async heard(request) {
      const news = await safely(() => provider.hear(request));
      if (news.error) return { error: news.error };
      if (news.ignore || !news.ref) return { ignore: true };
      const payment = byRef.get(provider.name, String(news.ref));
      if (!payment) return { ignore: true };
      const settled = await this.settle(payment.order_key);
      return { ...settled, key: payment.order_key };
    },

    /** Give a paid order's money back, all of it. */
    async refund(key) {
      const payment = byKey.get(key);
      if (payment?.state !== 'paid') return { error: 'not-paid' };
      const made = await safely(() => provider.refund({ paymentId: payment.payment_id, cents: payment.cents, key }));
      if (!made.ok) return { error: made.error ?? 'provider-failed' };
      db.prepare("UPDATE payments SET state = 'refunded' WHERE order_key = ?").run(key);
      return { ok: true };
    },
  };
}
