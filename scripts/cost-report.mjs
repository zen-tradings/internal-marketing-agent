import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config/index.js';
import { costConfigurationId } from '../src/lib/cost-telemetry.js';
import { costPeriods } from '../src/lib/cost-report.js';

// Read-only: never openStore(), run migrations, refresh providers, or generate.
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) {
  if (!['--ledger', '--month', '--timezone', '--billing', '--configuration'].includes(args[i]) || !args[i + 1]) throw new Error('Use --ledger PATH --month YYYY-MM --timezone TZ --billing JSON --configuration HASH');
  options[args[i].slice(2)] = args[++i];
}
const envPath = process.env.DOTENV_CONFIG_PATH || '.env';
const env = { ...(fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {}), ...process.env };
const filename = options.ledger || `${env.DB_PATH || path.resolve(env.HOME || '.', 'zen-content-hub', 'runs.db')}${/^(1|true|yes|on)$/i.test(env.HUB_DRY_RUN || '') ? '.dry-run.db' : ''}.costs.sqlite3`;
let configurationId = options.configuration;
try {
  const config = loadConfig(env);
  configurationId ||= costConfigurationId(config);
} catch {} // Reporting still works without service secrets/configuration.
let events = [];
let instrumentedSince = null;
if (fs.existsSync(filename)) {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    events = db.prepare('SELECT event_json FROM cost_events ORDER BY occurred_at').all().map(row => JSON.parse(row.event_json));
    instrumentedSince = db.prepare('SELECT applied_at FROM schema_migrations WHERE version=1').get()?.applied_at ?? null;
  }
  finally { db.close(); }
}
const billing = options.billing ? JSON.parse(fs.readFileSync(options.billing, 'utf8')) : {};
console.log(JSON.stringify({
  ...costPeriods(events, { month: options.month, timezone: options.timezone, configurationId }),
  billing: { currency: 'USD', fixedSubscriptions: billing.fixedSubscriptions || [],
    topUps: billing.topUps || [], credits: billing.credits || [], sharedFees: billing.sharedFees || [],
    // Separate accounting views; never add top-ups to metered inference.
    unallocatedVendors: billing.unallocatedVendors || ['DigitalOcean allocation', 'Datalab', 'Customer.io', 'offsite backup'],
  },
  coverage: { ledgerExists: fs.existsSync(filename), instrumentedSince, firstRecordedAt: events[0]?.occurredAt || null,
    lastRecordedAt: events.at(-1)?.occurredAt || null,
    note: 'A completed calendar month does not imply complete cost coverage. Live instrumentation starts at instrumentedSince; older legacy receipts are partial, regardless of unknownCostRequests. Provider-wide bills and credits are not project attribution. Historical traces overwritten before instrumentation cannot be reconstructed.' },
}, null, 2));
