// The people who run the store: an owner, and the people they invite. Two roles:
//   owner   everything
//   helper  photographs and drafts parts; can't list, sell, change listed parts, import or see orders
//
// Passwords are scrypt hashes. Sessions and links are random tokens; only their SHA-256 is stored.
// Sign-in failures are counted per email and device: five wrong tries lock that device out of that
// email for 15 minutes, so a stranger guessing can't lock the owner out of their own phone.

import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { transaction } from '../infra/db.js';

export const ROLES = ['owner', 'helper'];
const HOUR = 3_600_000;
const SESSION_MS = 12 * HOUR;
const LINK_MS = 7 * 24 * HOUR;
const TRIES = 5;
const LOCK_MS = 15 * 60_000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const COST = { N: 2 ** 15, r: 8, p: 1 };

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const cleanEmail = (email) => String(email ?? '').trim().toLowerCase();

function scrypt(password, salt, { N, r, p }) {
  return new Promise((resolve, reject) => scryptCallback(String(password).normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r }, (error, key) => (error ? reject(error) : resolve(key))));
}

export async function hashPassword(password, cost = COST) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, cost);
  return `scrypt$${cost.N}$${cost.r}$${cost.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function checkPassword(password, stored) {
  const [kind, N, r, p, salt, key] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scrypt(password, Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function passwordProblem(password, email = '') {
  if (typeof password !== 'string' || password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 200) return 'Use at most 200 characters.';
  if (cleanEmail(password) === cleanEmail(email)) return 'Don’t use your email as your password.';
  return '';
}

export function createAccounts({ db, secure = false, now = Date.now, cost = COST }) {
  const cookieName = secure ? '__Host-ps_session' : 'ps_session';
  const cookie = (value, maxAgeSeconds) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
  const failures = new Map(); // `${email} ${client}` → { count, until }
  // Unknown emails are checked against this, so they take as long as known ones.
  const decoy = hashPassword(token(), cost);

  const view = (row) => row && { id: row.id, email: row.email, name: row.name, role: row.role, disabled: Boolean(row.disabled) };
  const byEmail = (email) => db.prepare('SELECT * FROM accounts WHERE email = ?').get(cleanEmail(email));
  const count = () => db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;

  async function startSession(accountId) {
    const id = token();
    db.prepare('INSERT INTO sessions (hash, account_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sha256(id), accountId, now() + SESSION_MS, now());
    return cookie(id, SESSION_MS / 1000);
  }

  function readCookie(req) {
    const header = String(req?.headers?.cookie ?? '');
    const value = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
  }

  function issue(kind, fields) {
    const raw = token();
    db.prepare('INSERT INTO links (hash, kind, email, name, role, account_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sha256(raw), kind, fields.email ?? '', fields.name ?? '', fields.role ?? 'helper', fields.accountId ?? null, now() + LINK_MS, now());
    return raw;
  }

  function linkFor(raw) {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const row = db.prepare('SELECT * FROM links WHERE hash = ?').get(sha256(raw));
    if (!row || row.used_at || row.expires_at <= now()) return null;
    if (row.kind === 'setup' && count() > 0) return null;
    return row;
  }

  return {
    cookieName,

    /** True until the first owner has an account: only then is a setup link offered. */
    needsOwner: () => count() === 0,

    /** A one-time link for the first owner. Null once anyone has an account. */
    setupLink: () => (count() ? null : issue('setup', { role: 'owner' })),

    /** Who a request is from, or null. */
    session(req) {
      const id = readCookie(req);
      if (!id) return null;
      const row = db.prepare('SELECT sessions.hash, sessions.expires_at, accounts.* FROM sessions JOIN accounts ON accounts.id = sessions.account_id WHERE sessions.hash = ?').get(sha256(id));
      if (!row || row.expires_at <= now() || row.disabled) return null;
      return { ...view(row), session: row.hash };
    },

    /** Sign in. A wrong password and an unknown email get the same answer, in about the same time. */
    async signIn(email, password, { client = '' } = {}) {
      const key = `${cleanEmail(email)} ${String(client).slice(0, 64)}`;
      const failed = failures.get(key);
      if (failed && failed.until > now() && failed.count >= TRIES) return { error: 'locked' };
      const account = byEmail(email);
      const ok = account ? await checkPassword(String(password ?? ''), account.hash) : (await checkPassword(String(password ?? ''), await decoy), false);
      if (!ok || account.disabled) {
        if (failures.size > 10_000) for (const [k, entry] of failures) if (entry.until <= now()) failures.delete(k);
        failures.set(key, { count: (failed && failed.until > now() ? failed.count : 0) + 1, until: now() + LOCK_MS });
        return { error: 'wrong' };
      }
      failures.delete(key);
      return { ok: true, cookie: await startSession(account.id) };
    },

    signOut(req) {
      const id = readCookie(req);
      if (id) db.prepare('DELETE FROM sessions WHERE hash = ?').run(sha256(id));
      return cookie('', 0);
    },

    /** What a link is for (to draw its page), or null when it's expired or used. */
    peek(raw) {
      const link = linkFor(raw);
      return link && { kind: link.kind, email: link.email, name: link.name, role: link.role };
    },

    /** Use a setup, invite or reset link: make the account (or set the password) and sign in. */
    async accept(raw, form = {}) {
      const link = linkFor(raw);
      if (!link) return { error: 'That link has expired or been used. Ask the owner for a new one.' };
      const email = link.kind === 'setup' ? cleanEmail(form.email) : link.email;
      const name = String(form.name ?? link.name ?? '').trim().slice(0, 80);
      if (link.kind !== 'reset') {
        if (!EMAIL.test(email)) return { error: 'Give your email address.' };
        if (!name) return { error: 'Give your name.' };
        if (byEmail(email)) return { error: 'Someone already has an account with that email.' };
      }
      const problem = passwordProblem(form.password, email);
      if (problem) return { error: problem };
      const hash = await hashPassword(form.password, cost);
      const accountId = transaction(db, () => {
        // Checked again inside the transaction: two people can't use one link at once.
        const fresh = linkFor(raw);
        if (!fresh) return null;
        db.prepare('UPDATE links SET used_at = ? WHERE hash = ?').run(now(), sha256(raw));
        if (link.kind === 'reset') {
          db.prepare('UPDATE accounts SET hash = ? WHERE id = ?').run(hash, link.account_id);
          db.prepare('DELETE FROM sessions WHERE account_id = ?').run(link.account_id);
          return link.account_id;
        }
        return Number(db.prepare('INSERT INTO accounts (email, name, role, hash, created_at) VALUES (?, ?, ?, ?, ?)').run(email, name, link.kind === 'setup' ? 'owner' : link.role, hash, now()).lastInsertRowid);
      });
      if (!accountId) return { error: 'That link has expired or been used. Ask the owner for a new one.' };
      return { ok: true, accountId, cookie: await startSession(accountId) };
    },

    /** An owner invites someone: a link that works once, for a week. */
    invite(by, { email, name = '', role = 'helper' }) {
      if (by?.role !== 'owner') return { error: 'Only an owner can invite people.' };
      const clean = cleanEmail(email);
      if (!EMAIL.test(clean)) return { error: 'That email doesn’t look right.' };
      if (byEmail(clean)) return { error: 'Someone already has an account with that email.' };
      if (!ROLES.includes(role)) return { error: 'Pick owner or helper.' };
      return { ok: true, token: issue('invite', { email: clean, name: String(name).trim().slice(0, 80), role }) };
    },

    /** An owner makes a new-password link for someone who forgot theirs. */
    resetLink(by, accountId) {
      if (by?.role !== 'owner') return { error: 'Only an owner can do that.' };
      const account = view(db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId));
      if (!account || account.disabled) return { error: 'That person can’t sign in.' };
      return { ok: true, token: issue('reset', { email: account.email, accountId }), account };
    },

    /** An owner turns someone off (signed out everywhere) or back on. The last owner stays on. */
    setDisabled(by, accountId, disabled) {
      if (by?.role !== 'owner') return { error: 'Only an owner can do that.' };
      const account = view(db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId));
      if (!account) return { error: 'That person doesn’t have an account.' };
      if (disabled && account.role === 'owner' && db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE role = 'owner' AND disabled = 0").get().n <= 1) return { error: 'The store needs at least one owner.' };
      db.prepare('UPDATE accounts SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, accountId);
      if (disabled) db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
      return { ok: true };
    },

    list: () => db.prepare('SELECT * FROM accounts ORDER BY role DESC, name').all().map(view),
  };
}
