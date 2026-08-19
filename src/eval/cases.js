// JSONL labeled-case loader for the eval harness. Each line is one case:
//   {"id":"...","kind":"routing|source-policy|citation-grounding|gates|opening-digest-limits|options-strategy|qdii-reconcile",
//    "input":{...},"expect":{...}}
// expect.defect (boolean) is the ground-truth label used by the meta-eval (Metric B).

import fs from 'node:fs';
import path from 'node:path';

export const CASE_KINDS = [
  'routing',
  'source-policy',
  'citation-grounding',
  'gates',
  'opening-digest-limits',
  'options-strategy',
  'qdii-reconcile',
];

export function loadCases(file) {
  const absolute = path.resolve(file);
  const lines = fs.readFileSync(absolute, 'utf8').split('\n');
  const cases = [];
  const seen = new Set();
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let entry;
    try { entry = JSON.parse(line); }
    catch (error) { throw new Error(`${file}:${index + 1} invalid JSON: ${error.message}`); }
    validateCase(entry, `${file}:${index + 1}`);
    if (seen.has(entry.id)) throw new Error(`${file}:${index + 1} duplicate case id: ${entry.id}`);
    seen.add(entry.id);
    cases.push({ ...entry, baseDir: path.dirname(absolute) });
  }
  return cases;
}

export function validateCase(entry, where = 'case') {
  if (!entry || typeof entry !== 'object') throw new Error(`${where}: case must be an object`);
  if (!entry.id || typeof entry.id !== 'string') throw new Error(`${where}: case needs a string id`);
  if (!CASE_KINDS.includes(entry.kind)) throw new Error(`${where}: unknown kind "${entry.kind}" (allowed: ${CASE_KINDS.join(', ')})`);
  if (!entry.input || typeof entry.input !== 'object') throw new Error(`${where}: case needs an input object`);
  if (!entry.expect || typeof entry.expect !== 'object') throw new Error(`${where}: case needs an expect object`);
  return true;
}

// Resolve inline text or a file reference relative to the cases file.
export function resolveText(input, baseDir, inlineKey, pathKey) {
  if (typeof input[inlineKey] === 'string') return input[inlineKey];
  if (typeof input[pathKey] === 'string') {
    return fs.readFileSync(path.resolve(baseDir || '.', input[pathKey]), 'utf8');
  }
  throw new Error(`case input needs "${inlineKey}" or "${pathKey}"`);
}

export function resolveJson(input, baseDir, inlineKey, pathKey) {
  if (input[inlineKey] !== undefined) return input[inlineKey];
  if (typeof input[pathKey] === 'string') {
    return JSON.parse(fs.readFileSync(path.resolve(baseDir || '.', input[pathKey]), 'utf8'));
  }
  return undefined;
}
