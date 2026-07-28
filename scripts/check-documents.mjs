import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig } from '../src/config/index.js';
import { loadDirectUserSources } from '../src/core/user-sources.js';

dotenv.config();
const urls = process.argv.slice(2).map((value) => String(value || '').trim()).filter(Boolean);
if (!urls.length) {
  console.error('用法：npm run check:documents -- "<Notion 或 Google Docs 私有链接>" [...]');
  process.exit(1);
}

const config = loadConfig(process.env);
const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-private-doc-check-'));
try {
  const result = await loadDirectUserSources({
    userUrls: urls,
    workDir,
    config,
  });
  for (const source of result.sources) {
    console.log(`OK ${source.extractor} ${source.title || source.url} (${source.text.length} chars)`);
  }
  for (const error of result.errors) {
    console.error(`FAIL ${error.kind || 'document'} ${error.url}: ${error.error}`);
  }
  if (result.sources.length !== urls.length || result.errors.length) process.exitCode = 1;
} finally {
  await fs.rm(workDir, { recursive: true, force: true });
}
