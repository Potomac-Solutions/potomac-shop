import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { migrate, openDatabase } from '../src/infra/db.js';
import { createAccounts, checkPassword, hashPassword } from '../src/app/accounts.js';
import { choosePayments, createPayments, square } from '../src/app/payments.js';

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
  const calls = [];
  const orders = new Map();
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body });
    const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/v2/online-checkout/payment-links') {
      const id = `ord_${orders.size + 1}`;
      orders.set(id, { id, state: 'OPEN', total_money: body.quick_pay.price_money, net_amount_due_money: { ...body.quick_pay.price_money }, tenders: [] });
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
    order.tenders = [{ id: 't1', payment_id: 'pay_1' }];
    order.net_amount_due_money.amount = 0;
  };
  return { fetch, calls, pay };
}

test('Square: a payment link per order, believed only when Square says the order is paid', async () => {
  const db = fresh();
  db.prepare("INSERT INTO items (sku, handle, title, price_cents, created_at, updated_at) VALUES ('A', 'a', 'A', 100, 0, 0)").run();
  db.prepare("INSERT INTO orders (key, item_id, cents, name, email, delivery, created_at) VALUES ('k1', 1, 4500, 'D', 'd@x.example', 'pickup', 0)").run();
  const sq = fakeSquare();
  const provider = square({ token: 'EAAA-test', location: 'LOC1', sandbox: true, fetch: sq.fetch, webhookKey: 'sigkey', webhookUrl: 'https://rix.example/pay/webhook' });
  const payments = createPayments({ db, provider });
  const started = await payments.start({ key: 'k1', cents: 4500, name: '2g shifter (RR-1)', email: 'd@x.example', back: 'https://rix.example/orders/k1' });
  assert.equal(started.url, 'https://sandbox.square.link/u/ord_1');
  const call = sq.calls[0];
  assert.equal(call.url, 'https://connect.squareupsandbox.com/v2/online-checkout/payment-links');
  assert.equal(call.headers.authorization, 'Bearer EAAA-test');
  assert.deepEqual(call.body.quick_pay, { name: '2g shifter (RR-1)', price_money: { amount: 4500, currency: 'USD' }, location_id: 'LOC1' });
  assert.equal(call.body.checkout_options.redirect_url, 'https://rix.example/orders/k1');
  assert.equal((await payments.start({ key: 'k1', cents: 4500, name: 'x', back: 'y' })).again, true);
  assert.equal(sq.calls.filter((c) => c.method === 'POST').length, 1);

  assert.deepEqual(await payments.settle('k1'), { error: 'not-paid' });
  sq.pay('ord_1');
  // A webhook with a bad signature is refused; a good one settles the order.
  const body = JSON.stringify({ type: 'payment.updated', data: { object: { payment: { id: 'pay_1', order_id: 'ord_1', status: 'COMPLETED' } } } });
  assert.deepEqual(await payments.heard({ headers: { 'x-square-hmacsha256-signature': 'forged' }, body }), { error: 'bad-signature' });
  const signature = createHmac('sha256', 'sigkey').update(`https://rix.example/pay/webhook${body}`).digest('base64');
  const heard = await payments.heard({ headers: { 'x-square-hmacsha256-signature': signature }, body });
  assert.deepEqual([heard.ok, heard.key, heard.paymentId], [true, 'k1', 'pay_1']);
  assert.equal((await payments.settle('k1')).again, true);
  assert.equal(payments.get('k1').state, 'paid');

  assert.equal((await payments.refund('k1')).ok, true);
  const refund = sq.calls.find((c) => c.url.endsWith('/v2/refunds'));
  assert.deepEqual(refund.body.amount_money, { amount: 4500, currency: 'USD' });
  assert.equal(refund.body.payment_id, 'pay_1');
});

test('Square is used only when its settings are all there; otherwise the test page', () => {
  assert.equal(choosePayments({}).name, 'test');
  assert.equal(choosePayments({ PAY_PROVIDER: 'square', PAY_SQUARE_TOKEN: 'x' }).name, 'test');
  const chosen = choosePayments({ PAY_PROVIDER: 'Square', PAY_SQUARE_TOKEN: 'x', PAY_SQUARE_LOCATION: 'L', PAY_SQUARE_SANDBOX: '1' });
  assert.deepEqual([chosen.name, chosen.sandbox], ['square', true]);
});
