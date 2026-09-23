import Database from 'better-sqlite3';
import { inspectRollbackSafety } from '../src/core/rollback-safety.js';

if (process.argv.length !== 4 || process.argv[2] !== '--db') throw new Error('Usage: node scripts/check-rollback.mjs --db /absolute/path/runs.db');
const db = new Database(process.argv[3], { readonly: true, fileMustExist: true });
try {
  const result = inspectRollbackSafety(db);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} finally { db.close(); }
