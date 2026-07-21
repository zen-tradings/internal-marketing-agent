#!/usr/bin/env node
import dotenv from 'dotenv';
import { loadConfig } from '../src/config/index.js';
import { runWriter } from '../src/core/runner.js';
import translateWorkflow from '../src/workflows/translate.js';

dotenv.config({ override: true });

const sourceUrl = process.argv.slice(2).find((value) => /^https?:\/\//i.test(value));
if (!sourceUrl) {
  console.error('用法: npm run check:translation-v2 -- https://example.com/article');
  process.exit(2);
}

let parsed;
try { parsed = new URL(sourceUrl); }
catch {
  console.error('链接格式无效');
  process.exit(2);
}
if (!['http:', 'https:'].includes(parsed.protocol)) {
  console.error('只允许 http(s) 链接');
  process.exit(2);
}

const config = loadConfig();
config.translation.v2Enabled = true;

console.log('[translation-v2] 只生成本地验收稿，不会调用微信草稿接口。');
const result = await runWriter({
  workflow: translateWorkflow,
  input: `直译 ${sourceUrl}`,
  config,
  onProgress(progress) {
    console.log(`[translation-v2] ${progress.stage}: ${progress.message}`);
  },
});

if (!result.ok) {
  console.error(`[translation-v2] 失败: ${result.stderr}`);
  console.error(`[translation-v2] trace: ${result.researchTracePath}`);
  process.exit(1);
}

console.log(`[translation-v2] 验收稿: ${result.articlePath}`);
console.log(`[translation-v2] trace: ${result.researchTracePath}`);
console.log(`[translation-v2] completeness: ${JSON.stringify(result.completeness)}`);
