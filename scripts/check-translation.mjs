#!/usr/bin/env node
import dotenv from 'dotenv';
import { loadConfig } from '../src/config/index.js';
import { runWriter } from '../src/core/runner.js';
import translateWorkflow from '../src/workflows/translate.js';

dotenv.config({ override: true });

const instruction = process.argv.slice(2).join(' ').trim();
const sourceUrl = instruction.match(/https?:\/\/[^\s<>()]+/i)?.[0];
if (!sourceUrl) {
  console.error('用法: npm run check:translation -- "翻译前 11 页 https://example.com/paper.pdf"');
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

console.log('[translation] 按指定范围提取并翻译结构化内容，生成本地验收稿，不会调用微信草稿接口。');
const result = await runWriter({
  workflow: translateWorkflow,
  input: instruction,
  config,
  onProgress(progress) {
    console.log(`[translation] ${progress.stage}: ${progress.message}`);
  },
});

if (!result.ok) {
  console.error(`[translation] 失败: ${result.stderr}`);
  console.error(`[translation] trace: ${result.researchTracePath}`);
  process.exit(1);
}

console.log(`[translation] 验收稿: ${result.articlePath}`);
console.log(`[translation] trace: ${result.researchTracePath}`);
console.log(`[translation] completeness: ${JSON.stringify(result.completeness)}`);
