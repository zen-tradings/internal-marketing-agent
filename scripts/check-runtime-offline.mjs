import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { browserExecutable } from '../src/lib/translation/assets.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function command(executable, args, input) {
  const result = spawnSync(executable, args, { input, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${path.basename(executable)} 离线验收失败: ${result.error?.message || result.stderr}`);
  return result.stdout;
}
const python = process.env.QDII_PYTHON_PATH || path.join(root, '.venv/bin/python');
const bootstrap = `import runpy, socket, sys
# Import and process fixture files only; reject accidental network calls in workers.
def blocked(*args, **kwargs):
    raise RuntimeError("network disabled in offline acceptance")
socket.socket.connect = blocked
socket.create_connection = blocked
runpy.run_path(sys.argv[1], run_name="__main__")`;
function worker(name, request) {
  return JSON.parse(command(python, ['-c', bootstrap, path.join(root, 'python', name)], JSON.stringify(request)));
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-runtime-check-'));
let browser;
try {
  assert.equal(worker('qdii_worker.py', { action: 'self_test' }).ok, true);
  assert.equal(worker('opening_digest_worker.py', { action: 'self_test' }).ok, true);
  const executablePath = browserExecutable({ browserExecutablePath: process.env.TRANSLATION_BROWSER_EXECUTABLE });
  if (!executablePath) throw new Error('Chromium/Chrome 未安装；配置 TRANSLATION_BROWSER_EXECUTABLE');
  browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking'] });
  const context = await browser.newContext({ offline: true });
  await context.route('**/*', route => route.abort());
  const page = await context.newPage();
  await page.setContent(`<h1>Zen offline fixture 000001</h1><table border="1"><tr><th>Asset</th><th>Weight</th></tr><tr><td>Example</td><td>12.50%</td></tr></table><p>${'Offline PDF fixture preserves text and numeric values. '.repeat(20)}</p>`);
  const pdf = path.join(temporary, 'fixture.pdf'), png = path.join(temporary, 'fixture.png');
  await page.pdf({ path: pdf, format: 'A4' });
  await page.screenshot({ path: png });
  assert.match(command('pdfinfo', [pdf]), /Pages:\s+1/);
  assert.match(command('pdftotext', [pdf, '-']), /12\.50%/);
  command('pdftoppm', ['-f', '1', '-singlefile', '-scale-to', '300', '-png', pdf, path.join(temporary, 'poppler')]);
  const parsed = worker('qdii_worker.py', { action: 'extract_pdf', pdfPath: pdf, fundCode: '000001' });
  assert.equal(parsed.identity_verified, true); assert.equal(parsed.scan_detected, false);
  command(python, ['-c', 'from PIL import Image; import sys; [Image.open(p).verify() for p in sys.argv[1:]]', png, path.join(temporary, 'poppler.png')]);
  console.log(JSON.stringify({ platform: process.platform, pythonWorkers: 'ok', chromiumPdfAndPng: 'ok', popplerTextAndImage: 'ok', pythonPdfExtraction: 'ok', network: 'disabled for fixtures' }));
} finally {
  await browser?.close();
  fs.rmSync(temporary, { recursive: true, force: true });
}
