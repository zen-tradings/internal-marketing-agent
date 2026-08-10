import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.QDII_PYTHON_PATH || path.join(ROOT, '.venv', 'bin', 'python');
const worker = process.env.QDII_WORKER_PATH || path.join(ROOT, 'python', 'qdii_worker.py');
if (!fs.existsSync(python) && !python.includes('/')) {
  // A bare executable name is resolved by spawnSync below.
} else if (!fs.existsSync(python)) {
  throw new Error(`QDII Python runtime not found: ${python}; run npm run setup:qdii`);
}
const result = spawnSync(python, [worker], {
  cwd: ROOT,
  encoding: 'utf8',
  input: JSON.stringify({ action: 'self_test' }),
  env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
});
if (result.status !== 0) throw new Error(`QDII Python self-test failed: ${String(result.stderr || result.stdout).trim()}`);
const data = JSON.parse(result.stdout);
if (data.ok !== true) throw new Error('QDII Python self-test did not return ok=true');
console.log(JSON.stringify(data));
