#!/usr/bin/env node
// Metric C value metrics over externally collected data. Read-only, offline. Usage:
//   node scripts/eval-value.mjs edit-distance <draft.md> <final-sent.md>
//   node scripts/eval-value.mjs feedback <events.jsonl>          lines: {"rating":"positive|negative","edition":"Vol. 3"}
//   node scripts/eval-value.mjs expectancy <trades.jsonl> [--baseline <baseline.jsonl>]
//                                                                lines: {"return": 0.042, ...}
// Data collection happens outside this repo (Customer.io click export, backtest fills, the final
// sent copy pasted by the editor); this script only answers the value questions given that data.

import fs from 'node:fs';

const [command, ...rest] = process.argv.slice(2);
const { expectancySummary, aggregateReaderFeedback, normalizedEditDistance } = await import('../src/eval/value.js');

if (command === 'edit-distance') {
  const [draftFile, finalFile] = rest.filter((arg) => !arg.startsWith('--'));
  if (!draftFile || !finalFile) usage();
  const distance = normalizedEditDistance(read(draftFile), read(finalFile));
  console.log(JSON.stringify({
    normalizedEditDistance: distance,
    interpretation: distance <= 0.05 ? 'sent nearly as drafted'
      : distance <= 0.25 ? 'light editing'
        : distance <= 0.5 ? 'heavy editing'
          : 'mostly rewritten: draft quality is far from usable',
  }, null, 2));
} else if (command === 'feedback') {
  const [file] = rest.filter((arg) => !arg.startsWith('--'));
  if (!file) usage();
  console.log(JSON.stringify(aggregateReaderFeedback(jsonl(file)), null, 2));
} else if (command === 'expectancy') {
  const [file] = rest.filter((arg) => !arg.startsWith('--'));
  if (!file) usage();
  const baselineIndex = rest.indexOf('--baseline');
  const baseline = baselineIndex !== -1 && rest[baselineIndex + 1] ? jsonl(rest[baselineIndex + 1]) : [];
  console.log(JSON.stringify(expectancySummary(
    jsonl(file).map((row) => row.return),
    baseline.map((row) => row.return),
  ), null, 2));
} else usage();

function read(file) {
  if (!fs.existsSync(file)) { console.error(`file not found: ${file}`); process.exit(1); }
  return fs.readFileSync(file, 'utf8');
}

function jsonl(file) {
  return read(file).split('\n').filter((line) => line.trim() && !line.startsWith('#')).map((line) => JSON.parse(line));
}

function usage() {
  console.error('Usage: node scripts/eval-value.mjs edit-distance <draft.md> <final.md> | feedback <events.jsonl> | expectancy <trades.jsonl> [--baseline <file.jsonl>]');
  process.exit(1);
}
