// Start the store.
import { checkConfig, config } from './config.js';
import { migrate, openDatabase } from './infra/db.js';
import { createCatalog } from './app/catalog.js';
import { createWeb } from './web/server.js';

checkConfig(config);
const db = openDatabase(config.database);
const applied = migrate(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);

const catalog = createCatalog({ db });
const { server } = createWeb({ catalog, config });

if (config.demo) {
  // The public demo resets every night at 4 am Eastern: the process exits and the host starts it
  // again (Railway's "always" restart), which re-seeds it from the fixture.
  const started = Date.now();
  const hour = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(Date.now()));
  setInterval(() => {
    if (Date.now() - started > 3_600_000 && hour() === 4) {
      console.log('Demo reset: exiting so the host starts it again with fresh data.');
      process.exit(0);
    }
  }, 5 * 60_000).unref();
}

server.listen(config.port, () => console.log(`${config.business} store on ${config.publicUrl}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
