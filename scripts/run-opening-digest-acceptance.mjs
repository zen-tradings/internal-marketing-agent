import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/index.js';
import { runWriter } from '../src/core/runner.js';
import { makeChannel } from '../src/channels/customerio-opening-digest.js';
import openingDigest from '../src/workflows/opening-digest.js';
import { easternDateKey } from '../src/lib/us-equity-calendar.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-opening-acceptance-'));
const config = loadConfig(process.env);
const commit = deployedCommit(root);
const timestamp = easternTimeKey(new Date());
const acceptanceId = `${commit.slice(0, 12)}-${timestamp}`;
const workflow = { ...openingDigest, workDir };

const generated = await runWriter({
  workflow,
  input: openingDigest.cronInput,
  config,
});
if (!generated.ok) throw new Error(generated.stderr || 'Opening Digest acceptance generation failed');

const channel = makeChannel();
const testResult = await channel.publish({
  articlePath: generated.articlePath,
  config,
  workflow,
  source: 'acceptance',
  contentMode: generated.contentMode || 'editorial',
  acceptanceId,
});
const formalResult = await channel.publish({
  articlePath: generated.articlePath,
  config,
  workflow,
  source: 'cron',
  contentMode: generated.contentMode || 'editorial',
});
const trace = JSON.parse(fs.readFileSync(generated.researchTracePath, 'utf8'));
console.log(JSON.stringify({
  ok: true,
  dateKey: easternDateKey(new Date()),
  commit,
  acceptanceId,
  contentMode: generated.contentMode || trace.contentMode || 'editorial',
  sourceCount: generated.sources?.length || 0,
  testMediaId: testResult.mediaId,
  formalMediaId: formalResult.mediaId,
  tracePath: generated.researchTracePath,
  diagnostics: trace.openingDigestDelivery?.diagnostics || [],
}));

function deployedCommit(repoRoot) {
  const marker = path.join(repoRoot, '.deploy-commit');
  const value = fs.existsSync(marker)
    ? fs.readFileSync(marker, 'utf8').trim()
    : process.env.OPENING_ACCEPTANCE_COMMIT || '';
  if (!/^[a-f0-9]{40}$/i.test(value)) throw new Error('Opening Digest acceptance requires .deploy-commit or OPENING_ACCEPTANCE_COMMIT');
  return value.toLowerCase();
}

function easternTimeKey(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(value);
  const get = (type) => parts.find((part) => part.type === type)?.value || '00';
  return `${get('hour')}${get('minute')}et`;
}
