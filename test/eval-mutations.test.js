import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCases } from '../src/eval/cases.js';
import { generateMutants, runMutationSuite, MUTATORS } from '../src/eval/mutations.js';

const CASES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'eval-cases.jsonl');

test('mutation suite: every injected defect is caught (100% synthetic recall)', async () => {
  const suite = await runMutationSuite(loadCases(CASES_FILE));
  assert.ok(suite.mutants >= 9, `expected at least 9 mutants, got ${suite.mutants}`);
  assert.deepEqual(suite.missed, [], JSON.stringify(suite.missed));
  assert.equal(suite.recall, 1);
});

test('mutants are generated only from clean labeled cases and all expect defect=true', () => {
  const cases = loadCases(CASES_FILE);
  const mutants = generateMutants(cases);
  const cleanIds = new Set(cases.filter((entry) => entry.expect?.defect === false).map((entry) => entry.id));
  for (const mutant of mutants) {
    assert.ok(cleanIds.has(mutant.sourceCaseId), `mutant ${mutant.id} built from a non-clean case`);
    assert.equal(mutant.expect.defect, true);
  }
});

test('every mutator targets a kind covered by the fixture set', () => {
  const cases = loadCases(CASES_FILE);
  const cleanKinds = new Set(cases.filter((entry) => entry.expect?.defect === false).map((entry) => entry.kind));
  for (const mutator of MUTATORS) {
    assert.ok(mutator.kinds.some((kind) => cleanKinds.has(kind)), `mutator ${mutator.id} has no clean fixture to mutate`);
  }
});

test('mutators return null instead of throwing when they do not apply', () => {
  const fabricated = MUTATORS.find((mutator) => mutator.id === 'fabricated-citation');
  assert.equal(fabricated.apply({ article: 'no links here', allowedUrls: [] }, '.'), null);
  const breakeven = MUTATORS.find((mutator) => mutator.id === 'shifted-breakeven');
  assert.equal(breakeven.apply({ strategy: { legs: [] }, stated: {} }), null);
});
