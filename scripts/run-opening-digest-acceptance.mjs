import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config/index.js';
import { runWriter } from '../src/core/runner.js';
import { makeChannel, publishHistoricalOpeningDigestWechat } from '../src/channels/customerio-opening-digest.js';
import openingDigest from '../src/workflows/opening-digest.js';
import { easternDateKey } from '../src/lib/us-equity-calendar.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zen-opening-acceptance-'));
const config = loadConfig(process.env);
const commit = deployedCommit(root);
const timestamp = easternTimeKey(new Date());
const acceptanceId = `${commit.slice(0, 12)}-${timestamp}`;
const workflow = { ...openingDigest, workDir };
const migration = parseHistoricalMigrationArgs(process.argv.slice(2));

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
assertVerifiedWechat(testResult, 'TEST');
const formalResult = migration
  ? await publishHistoricalOpeningDigestWechat({ ...migration, config })
  : await channel.publish({
    articlePath: generated.articlePath,
    config,
    workflow,
    source: 'cron',
    contentMode: generated.contentMode || 'editorial',
  });
assertVerifiedWechat(formalResult, 'formal');
const trace = JSON.parse(fs.readFileSync(generated.researchTracePath, 'utf8'));
const universe = trace.openingDigestUniverse || {};
console.log(JSON.stringify({
  ok: true,
  dateKey: easternDateKey(new Date()),
  commit,
  acceptanceId,
  contentMode: generated.contentMode || trace.contentMode || 'editorial',
  sourceCount: generated.sources?.length || 0,
  testMediaId: testResult.mediaId,
  formalMediaId: formalResult.mediaId,
  testWechat: testResult.deliveries?.find((item) => item.destination === 'wechat') || null,
  formalWechat: formalResult.deliveries?.find((item) => item.destination === 'wechat') || null,
  universeSize: universe.universeSize || 0,
  quoteCoverage: universe.quoteCoverage || null,
  priceMoverCount: universe.priceMovers?.length || 0,
  oicUniverseMatchCount: universe.oicUniverseMatches?.length || 0,
  ivTriggerCount: universe.ivTriggers?.length || 0,
  universeResearchLanes: (trace.researchLanes || []).filter((lane) => /opening-digest-universe/.test(lane)),
  tracePath: generated.researchTracePath,
  diagnostics: trace.openingDigestDelivery?.diagnostics || [],
  historicalMigration: migration ? {
    sourceDir: migration.sourceDir,
    newsletterId: migration.newsletterId,
    historicalSegmentId: migration.historicalSegmentId,
    historicalSegmentName: migration.historicalSegmentName,
  } : null,
}));

export function parseHistoricalMigrationArgs(argv) {
  if (!argv.length) return null;
  const parsed = {};
  const allowed = new Set(['--historical-source-dir', '--historical-newsletter-id', '--historical-segment-id', '--historical-segment-name']);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!allowed.has(key) || !value) throw new Error(`Invalid historical migration argument:${key || '(empty)'}`);
    parsed[key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  }
  const required = ['historicalSourceDir', 'historicalNewsletterId', 'historicalSegmentId', 'historicalSegmentName'];
  if (required.some((key) => !parsed[key])) throw new Error('Historical migration acceptance requires all four arguments');
  if (!/^\d+$/.test(parsed.historicalNewsletterId) || !/^\d+$/.test(parsed.historicalSegmentId)) {
    throw new Error('Historical migration newsletter and segment IDs must be positive integers');
  }
  return {
    sourceDir: parsed.historicalSourceDir,
    newsletterId: Number(parsed.historicalNewsletterId),
    historicalSegmentId: Number(parsed.historicalSegmentId),
    historicalSegmentName: parsed.historicalSegmentName,
  };
}

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

function assertVerifiedWechat(result, label) {
  if (!config.openingDigest.wechatEnabled) {
    throw new Error(`Opening Digest ${label} acceptance requires OPENING_DIGEST_WECHAT_ENABLED=true`);
  }
  const delivery = result.deliveries?.find((item) => item.destination === 'wechat');
  if (!delivery?.mediaId || delivery.status !== 'verified') {
    throw new Error(`Opening Digest ${label} WeChat acceptance failed:${JSON.stringify(delivery || null)}`);
  }
}
