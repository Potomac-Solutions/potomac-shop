import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { migrate, openDatabase } from '../src/infra/db.js';
import { createAccounts, checkPassword, hashPassword } from '../src/app/accounts.js';
import { checkStore } from '@potomac-solutions/kit/store';
import { choosePayments, createPayments } from '../src/app/payments.js';
import { sqliteStore } from '../src/infra/kit-store.js';

const CHEAP = { N: 2 ** 10, r: 8, p: 1 };
const fresh = () => {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
};
const cookieOf = (setCookie) => ({ headers: { cookie: setCookie.split(';')[0] } });

test('passwords are scrypt hashes that check in constant time', async () => {
  const hash = await hashPassword('correct horse battery', CHEAP);
  assert.match(hash, /^scrypt\$1024\$8\$1\$/);
  assert.equal(await checkPassword('correct horse battery', hash), true);
  assert.equal(await checkPassword('wrong horse battery', hash), false);
});

test('setup link makes the first owner, once; sessions sign in and out', async () => {
  const db = fresh();
  let clock = 1_000;
  const accounts = createAccounts({ db, now: () => clock, cost: CHEAP });
  const link = accounts.setupLink();
  assert.equal(accounts.peek(link).kind, 'setup');
  const made = await accounts.accept(link, { email: 'Ricky@Rix.example', name: 'Ricky', password: 'owner-password-1' });
  assert.equal(made.ok, true);
  assert.equal(accounts.setupLink(), null);
  assert.equal(accounts.peek(link), null);
  const who = accounts.session(cookieOf(made.cookie));
  assert.deepEqual([who.email, who.role], ['ricky@rix.example', 'owner']);
  // Only a hash of the session is stored.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE hash = ?').get(made.cookie.split(';')[0].split('=')[1]).n, 0);
  accounts.signOut(cookieOf(made.cookie));
  assert.equal(accounts.session(cookieOf(made.cookie)), null);
  clock += 13 * 3_600_000;
  const signed = await accounts.signIn('ricky@rix.example', 'owner-password-1');
  assert.ok(accounts.session(cookieOf(signed.cookie)));
  clock += 13 * 3_600_000;
  assert.equal(accounts.session(cookieOf(signed.cookie)), null);
});

test('five wrong tries lock that device out of that email, not everyone', async () => {
  const db = fresh();
  const accounts = createAccounts({ db, cost: CHEAP });
  await accounts.accept(accounts.setupLink(), { email: 'o@x.example', name: 'O', password: 'owner-password-1' });
  for (let i = 0; i < 5; i += 1) assert.deepEqual(await accounts.signIn('o@x.example', 'nope', { client: '1.2.3.4' }), { error: 'wrong' });
  assert.deepEqual(await accounts.signIn('o@x.example', 'owner-password-1', { client: '1.2.3.4' }), { error: 'locked' });
  assert.equal((await accounts.signIn('o@x.example', 'owner-password-1', { client: '5.6.7.8' })).ok, true);
  assert.deepEqual(await accounts.signIn('nobody@x.example', 'whatever'), { error: 'wrong' });
});

test('helpers can’t invite; the last owner can’t be turned off; turning off signs out', async () => {
  const db = fresh();
  const accounts = createAccounts({ db, cost: CHEAP });
  await accounts.accept(accounts.setupLink(), { email: 'o@x.example', name: 'O', password: 'owner-password-1' });
  const owner = accounts.list()[0];
  const invite = accounts.invite(owner, { email: 'h@x.example', name: 'H', role: 'helper' });
  const helperMade = await accounts.accept(invite.token, { name: 'H', password: 'helper-password-1' });
  const helper = accounts.session(cookieOf(helperMade.cookie));
  assert.equal(helper.role, 'helper');
  assert.equal(accounts.invite(helper, { email: 'z@x.example' }).error, 'Only an owner can invite people.');
  assert.equal(accounts.setDisabled(owner, owner.id, true).error, 'The store needs at least one owner.');
  assert.equal(accounts.setDisabled(owner, helper.id, true).ok, true);
  assert.equal(accounts.session(cookieOf(helperMade.cookie)), null);
  assert.deepEqual(await accounts.signIn('h@x.example', 'helper-password-1'), { error: 'wrong' });
  const reset = accounts.resetLink(owner, owner.id);
  await accounts.accept(reset.token, { password: 'brand-new-password' });
  assert.equal((await accounts.signIn('o@x.example', 'brand-new-password')).ok, true);
});

function fakeSquare() {
  const orders = new Map();
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body });
    const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/v2/online-checkout/payment-links') {
      const id = `ord_${orders.size + 1}`;
      orders.set(id, { id, state: 'OPEN', total_money: body.quick_pay.price_money, tenders: [] });
      return reply(200, { payment_link: { id: 'pl_1', order_id: id, url: `https://sandbox.square.link/u/${id}` } });
    }
    if (path.startsWith('/v2/orders/')) {
      const order = orders.get(decodeURIComponent(path.split('/').pop()));
      return order ? reply(200, { order }) : reply(404, { errors: [{ code: 'NOT_FOUND' }] });
    }
    if (path === '/v2/refunds') return reply(200, { refund: { id: 'rf_1', status: 'PENDING' } });
    return reply(404, {});
  };
  const pay = (id) => {
    const order = orders.get(id);
    order.state = 'COMPLETED';
    order.tenders = [{ id: 't1', payment_id: 'pay_1', amount_money: { ...order.total_money } }];
  };
  return { fetch, calls, pay };
}

function fakeStripe() {
  const sessions = new Map();
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const form = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    calls.push({ path, method: init.method ?? 'GET', headers: init.headers, form });
    const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/v1/checkout/sessions' && init.method === 'POST') {
      const id = `cs_test_${sessions.size + 1}`;
      sessions.set(id, { id, status: 'open', payment_status: 'unpaid', amount_total: Number(form['line_items[0][price_data][unit_amount]']), currency: form['line_items[0][price_data][currency]'], payment_intent: null });
      return reply(200, { id, url: `https://checkout.stripe.com/c/pay/${id}`, expires_at: 0 });
    }
    if (path.startsWith('/v1/checkout/sessions/')) {
      const session = sessions.get(decodeURIComponent(path.split('/').pop()));
      return session ? reply(200, session) : reply(404, { error: { message: 'No such session' } });
    }
    if (path === '/v1/refunds') return reply(200, { id: 're_1' });
    return reply(404, {});
  };
  const pay = (id) => Object.assign(sessions.get(id), { status: 'complete', payment_status: 'paid', payment_intent: 'pi_1' });
  return { fetch, calls, pay };
}

const kitStore = () => sqliteStore(fresh());

test('the shop’s database keeps the kit’s store contract', async () => {
  await checkStore(sqliteStore(fresh()), assert);
});

test('Stripe through the kit: a Checkout page per checkout, paid once, believed only from Stripe', async () => {
  const stripe = fakeStripe();
  const platform = choosePayments({ PAY_PROVIDER: 'stripe', PAY_STRIPE_KEY: 'sk_test_abc', PAY_STRIPE_WEBHOOK_SECRET: 'whsec_x' }, { fetch: stripe.fetch });
  assert.deepEqual([platform.name, platform.label, platform.sandbox], ['stripe', 'Stripe', true]);
  const pay = createPayments({ store: kitStore(), provider: platform.provider });
  const id = 'checkout/k1';
  const started = await pay.start({ id, cents: 4500, description: 'Trail tee (M)', email: 'd@x.example', back: 'https://shop.example/checkout/back?checkout=k1', cancel: 'https://shop.example/checkout/cancel?checkout=k1' });
  assert.equal(started.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  const made = stripe.calls[0];
  assert.equal(made.headers.authorization, 'Bearer sk_test_abc');
  assert.equal(made.form.success_url, 'https://shop.example/checkout/back?checkout=k1');
  assert.equal(made.form.cancel_url, 'https://shop.example/checkout/cancel?checkout=k1');
  assert.equal(made.form['line_items[0][price_data][unit_amount]'], '4500');
  assert.equal((await pay.start({ id, cents: 4500, back: 'https://shop.example/checkout/back?checkout=k1' })).again, true, 'pressed again, the same page');
  assert.equal(stripe.calls.filter((c) => c.method === 'POST').length, 1);

  assert.equal((await pay.settle({ id })).error, 'not-paid');
  stripe.pay('cs_test_1');
  const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_1' } } });
  assert.deepEqual(await pay.heard({ headers: { 'stripe-signature': 't=1,v1=forged' }, body }), { error: 'bad-signature' });
  const stamp = Math.floor(Date.now() / 1000); // Stripe checks the signature's time against the real clock.
  const signature = createHmac('sha256', 'whsec_x').update(`${stamp}.${body}`).digest('hex');
  const heard = await pay.heard({ headers: { 'stripe-signature': `t=${stamp},v1=${signature}` }, body });
  assert.deepEqual([heard.ok, heard.id, heard.payment], [true, id, 'pi_1']);
  assert.equal((await pay.settle({ id })).again, true);

  assert.equal((await pay.refund({ id })).ok, true);
  const refund = stripe.calls.find((c) => c.path === '/v1/refunds');
  assert.deepEqual([refund.form.payment_intent, refund.form.amount], ['pi_1', '4500']);
  assert.equal((await pay.refund({ id })).error, 'bad-amount', 'nothing left to give back');
});

test('Square through the kit: a payment link, a signed webhook, a refund', async () => {
  const sq = fakeSquare();
  const platform = choosePayments({ PAY_PROVIDER: 'square', PAY_SQUARE_TOKEN: 'EAAA-test', PAY_SQUARE_LOCATION: 'LOC1', PAY_SQUARE_SANDBOX: '1', PAY_SQUARE_WEBHOOK_KEY: 'sigkey', PAY_SQUARE_WEBHOOK_URL: 'https://rix.example/pay/webhook' }, { fetch: sq.fetch });
  const pay = createPayments({ store: kitStore(), provider: platform.provider });
  const started = await pay.start({ id: 'checkout/k1', cents: 4500, description: '2g shifter (RR-1)', back: 'https://rix.example/checkout/back?checkout=k1' });
  assert.equal(started.url, 'https://sandbox.square.link/u/ord_1');
  assert.equal(sq.calls[0].url, 'https://connect.squareupsandbox.com/v2/online-checkout/payment-links');
  sq.pay('ord_1');
  const body = JSON.stringify({ type: 'payment.updated', data: { object: { payment: { id: 'pay_1', order_id: 'ord_1' } } } });
  assert.deepEqual(await pay.heard({ headers: { 'x-square-hmacsha256-signature': 'forged' }, body }), { error: 'bad-signature' });
  const signature = createHmac('sha256', 'sigkey').update(`https://rix.example/pay/webhook${body}`).digest('base64');
  assert.equal((await pay.heard({ headers: { 'x-square-hmacsha256-signature': signature }, body })).id, 'checkout/k1');
  assert.equal((await pay.refund({ id: 'checkout/k1' })).ok, true);
});

test('payments started before carts still settle and refund', async () => {
  const db = openDatabase(':memory:');
  const fs = await import('node:fs');
  const dir = fs.mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'mig-'));
  for (const name of fs.readdirSync(new URL('../migrations/', import.meta.url))) {
    if (name < '003') fs.copyFileSync(new URL(`../migrations/${name}`, import.meta.url), `${dir}/${name}`);
  }
  migrate(db, dir);
  db.prepare("INSERT INTO items (sku, handle, title, price_cents, created_at, updated_at) VALUES ('A', 'a', 'A', 100, 0, 0)").run();
  db.prepare("INSERT INTO orders (key, item_id, cents, name, email, delivery, created_at) VALUES ('old', 1, 4500, 'D', 'd@x.example', 'pickup', 0)").run();
  db.prepare("INSERT INTO payments (order_key, provider, ref, url, cents, created_at) VALUES ('old', 'square', 'ord_1', 'https://sandbox.square.link/u/ord_1', 4500, 5)").run();
  migrate(db);
  const sq = fakeSquare();
  const platform = choosePayments({ PAY_PROVIDER: 'square', PAY_SQUARE_TOKEN: 't', PAY_SQUARE_LOCATION: 'L', PAY_SQUARE_SANDBOX: '1' }, { fetch: sq.fetch });
  await platform.provider.start({ id: 'x', cents: 4500, currency: 'usd', description: 'A', back: '/' }); // Square's side of the old link.
  const pay = createPayments({ store: sqliteStore(db), provider: platform.provider });
  assert.equal(pay.paid('order/old').state, 'started');
  assert.equal((await pay.settle({ id: 'order/old' })).error, 'not-paid');
  sq.pay('ord_1');
  assert.equal((await pay.settle({ id: 'order/old' })).payment, 'pay_1');
  assert.equal((await pay.refund({ id: 'order/old' })).ok, true);
});

test('a platform is used only when its settings are all there; otherwise the test page', () => {
  assert.equal(choosePayments({}).name, 'test');
  assert.equal(choosePayments({ PAY_PROVIDER: 'square', PAY_SQUARE_TOKEN: 'x' }).name, 'test');
  assert.equal(choosePayments({ PAY_PROVIDER: 'stripe' }).asked, 'stripe');
  assert.deepEqual([choosePayments({ PAY_PROVIDER: 'stripe', PAY_STRIPE_KEY: 'sk_live_x' }).sandbox], [false]);
  const chosen = choosePayments({ PAY_PROVIDER: 'Square', PAY_SQUARE_TOKEN: 'x', PAY_SQUARE_LOCATION: 'L', PAY_SQUARE_SANDBOX: '1' });
  assert.deepEqual([chosen.name, chosen.sandbox], ['square', true]);
});
