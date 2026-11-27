// Import a product export from the command line.
//   npm run import -- products_export.csv            preview only
//   npm run import -- products_export.csv --commit   import it
// Options: --condition new|used   --brand "Store Name" (Vendor to ignore)   --image-base https://...
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { config } from '../src/config.js';
import { migrate, openDatabase } from '../src/infra/db.js';
import { createCatalog } from '../src/app/catalog.js';
import { SOURCES } from '../src/domain/sources.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { commit: { type: 'boolean' }, condition: { type: 'string' }, brand: { type: 'string' }, 'image-base': { type: 'string' } },
});
const [file] = positionals;
if (!file) {
  console.error('Give the CSV file: npm run import -- products_export.csv [--commit]');
  process.exit(1);
}
const db = openDatabase(config.database);
migrate(db);
const catalog = createCatalog({ db });
const text = readFileSync(file, 'utf8');
const options = { condition: values.condition === 'new' ? 'new' : 'used', ignoreBrand: values.brand ?? config.business, imageBase: values['image-base'] };
const plan = catalog.preview(text, options);
if (!plan.source) {
  console.error('Not an export we recognise (Shopify, WooCommerce, BigCommerce, Magento or ours).');
  process.exit(1);
}
console.log(`${SOURCES[plan.source]} export: ${plan.creates} new, ${plan.updates} to update, ${plan.skips} skipped.`);
for (const { draft, action, reason } of plan.rows) {
  if (action === 'skip') console.log(`  row ${draft.row}: skipped. ${[...draft.problems, reason].filter(Boolean).join(' ')}`);
}
if (values.commit) {
  const result = catalog.commit(text, options, { who: 'import script', filename: file });
  console.log(result.ok ? `Imported as batch ${result.batchId}. Undo it from the dashboard's Import page.` : `Not imported: ${result.error}`);
} else console.log('Preview only. Add --commit to import.');
db.close();
