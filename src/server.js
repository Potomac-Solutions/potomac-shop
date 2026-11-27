// Start the store.
import { checkConfig, config } from './config.js';
import { migrate, openDatabase } from './infra/db.js';
import { createShop } from './app/index.js';
import { createWeb } from './web/server.js';
import { lockedAccounts } from './demo-lock.js';

checkConfig(config);
const db = openDatabase(config.database);
const applied = migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

const shop = createShop({ db, config });
// The public demo refuses changes to its own sign-ins, so the next visitor can still sign in.
if (config.demo) shop.accounts = lockedAccounts(shop.accounts);
const { server } = createWeb({ shop, config });

if (config.demo) {
  // The demo resets every night at 4 am Eastern: the process exits and the host starts it again
  // (Railway's "always" restart), which re-seeds it.
  const started = Date.now();
  const hour = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(Date.now()));
  setInterval(() => {
    if (Date.now() - started > 3_600_000 && hour() === 4) {
      console.log('Demo reset: exiting so the host starts it again with fresh data.');
      process.exit(0);
    }
  }, 5 * 60_000).unref();
}

server.listen(config.port, () => {
  console.log(`${config.business} store on ${config.publicUrl} (payments: ${shop.platform.name}${shop.platform.sandbox ? ', no real money' : ''}; AI drafts: ${shop.drafts.enabled ? 'on' : 'off'})`);
  if (shop.accounts.needsOwner()) console.log(`Nobody has an account yet. Set up the first owner: ${config.publicUrl}/admin/accept?link=${shop.accounts.setupLink()}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
