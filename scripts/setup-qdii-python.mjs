import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const venv = path.join(ROOT, '.venv');
const bootstrap = selectBootstrapPython();

run(bootstrap, ['-c', 'import sys; assert sys.version_info >= (3, 11), sys.version']);
if (!fs.existsSync(path.join(venv, 'bin', 'python'))) run(bootstrap, ['-m', 'venv', venv]);
run(path.join(venv, 'bin', 'python'), [
  '-m', 'pip', 'install', '--disable-pip-version-check',
  '-r', path.join(ROOT, 'python', 'requirements-qdii.lock'),
]);
run(path.join(venv, 'bin', 'python'), [path.join(ROOT, 'python', 'qdii_worker.py')], {
  input: JSON.stringify({ action: 'self_test' }),
});
console.log(`QDII Python environment is ready: ${venv}`);

function selectBootstrapPython() {
  const candidates = process.env.QDII_BOOTSTRAP_PYTHON
    ? [process.env.QDII_BOOTSTRAP_PYTHON]
    : ['python3.13', 'python3.12', 'python3.11', 'python3'];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    if (result.status === 0) return candidate;
  }
  throw new Error('Python 3.11 or newer was not found; install it or set QDII_BOOTSTRAP_PYTHON');
}

function run(command, args, { input } = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', input, stdio: input ? ['pipe', 'inherit', 'inherit'] : 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed with exit ${result.status ?? 'spawn-error'}${result.error ? `: ${result.error.message}` : ''}`);
}
