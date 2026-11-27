// The public demo's sign-ins can't be changed by visitors: nobody can make a new-password link
// for them or turn them off. Anything else a visitor does lasts until the nightly reset.
import { DEMO_LOGINS } from './web/admin.js';

const REFUSED = { error: 'The demo accounts can’t be changed. Everything resets overnight.' };
const EMAILS = new Set(Object.values(DEMO_LOGINS).map((login) => login.email));

export function lockedAccounts(accounts) {
  const isDemo = (id) => accounts.list().some((one) => one.id === id && EMAILS.has(one.email));
  return Object.assign(Object.create(accounts), {
    resetLink: (by, id) => (isDemo(id) ? REFUSED : accounts.resetLink(by, id)),
    setDisabled: (by, id, disabled) => (isDemo(id) ? REFUSED : accounts.setDisabled(by, id, disabled)),
  });
}
