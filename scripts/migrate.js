// Create or update the database: `npm run migrate`.
import { config } from '../src/config.js';
import { migrate, openDatabase } from '../src/infra/db.js';

const db = openDatabase(config.database);
const applied = migrate(db);
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Nothing to apply.');
db.close();
