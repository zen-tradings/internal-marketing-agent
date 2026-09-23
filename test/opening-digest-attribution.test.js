import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditOpeningDigestAttribution } from '../src/lib/opening-digest-attribution.js';
import { attributionInvariantIssues } from '../src/core/writer/opening-editor.js';
import { buildOpeningDigestEvidenceLedger, openingDigestEvidenceSources, evidenceGradeFor } from '../src/lib/opening-digest-evidence.js';

const SNAPSHOT = {
  capturedAt: '2026-09-22T14:00:00.000Z',
  metrics: [
    { label: 'WTI', value: 90.57, changePct: -5.44, asOf: '2026-09-22T13:58:00.000Z' },
    { label: '10Y UST', value: 4.05, changePct: -1.2, asOf: '2026-09-22T13:58:00.000Z' },
    { label: 'SPY', value: 678.9, changePct: 0.3, asOf: '2026-09-22T13:58:00.000Z' },
  ],
};

const AS_OF = new Date('2026-09-22T14:00:00.000Z');

function article(body) {
  return `---\ntitle: Zen Opening Digest\nheadline: Markets open with data\nstance: neutral\nconfidence: medium\npreheader: Opening hour read.\nedition: 2026-09-22\n---\nOpening call sentence stays factual.\n\n## What matters today\n\n${body}\n\n## Evidence and cross-currents\n\nCross-currents remain supplied by sources.\n\n## What to watch\n\n- Current index levels and volatility\n- Treasury yields\n- Scheduled earnings\n`;
}

test('snapshot conflicts are flagged when narrative direction contradicts the snapshot without an earlier-time label', () => {
  const audit = auditOpeningDigestAttribution({
    article: article('Oil rebounded after four days of declines, supporting energy exposure through the session.'),
    snapshot: SNAPSHOT,
    asOf: AS_OF,
  });
  assert.equal(audit.stats.snapshotConflicts, 1);
  assert.match(audit.warnings[0], /归因冲突:正文对 WTI/);

  const labelled = auditOpeningDigestAttribution({
    article: article('Premarket, Brent briefly fell below $100 before rebounding, a move that has since reversed.'),
    snapshot: SNAPSHOT,
    asOf: AS_OF,
  });
  assert.equal(labelled.stats.snapshotConflicts, 0);
});

test('yield direction matching the snapshot does not warn', () => {
  const audit = auditOpeningDigestAttribution({
    article: article('Treasury yields declined as the opening hour progressed, easing pressure on valuations.'),
    snapshot: SNAPSHOT,
    asOf: AS_OF,
  });
  assert.equal(audit.stats.snapshotConflicts, 0);
});

test('upcoming-framed same-day event times require a source link and must not already be past', () => {
  const unsourced = auditOpeningDigestAttribution({
    article: article('The 1:15 p.m. ET weekly employment report will offer a fresh labor-market read.'),
    snapshot: SNAPSHOT,
    asOf: AS_OF,
  });
  assert.equal(unsourced.stats.temporalIssues, 1);
  assert.match(unsourced.warnings[0], /时间无源/);

  const past = auditOpeningDigestAttribution({
    article: article('The [weekly employment report](https://example.com/adp) scheduled for 8:15 a.m. ET will offer a fresh labor-market read.'),
    snapshot: SNAPSHOT,
    asOf: AS_OF,
  });
  assert.equal(past.stats.temporalIssues, 1);
  assert.match(past.warnings[0], /时态违规/);

  const future = auditOpeningDigestAttribution({
    article: article('The [weekly employment report](https://example.com/adp) scheduled for 1:15 p.m. ET will offer a fresh labor-market read.'),
    snapshot: SNAPSHOT,
    asOf: AS_OF,
  });
  assert.equal(future.stats.temporalIssues, 0);
});

test('strong causal verbs and buyer-flow assertions require a source link in the sentence', () => {
  const audit = auditOpeningDigestAttribution({
    article: article('Lower yields directly support equity valuations. Buying remains intact, but there is a lack of incremental buyers at these levels.'),
    snapshot: SNAPSHOT,
    asOf: AS_OF,
  });
  assert.equal(audit.stats.causalStrengthIssues, 2);

  const sourced = auditOpeningDigestAttribution({
    article: article('Lower yields [directly support equity valuations](https://example.com/rates) according to strategists.'),
    snapshot: SNAPSHOT,
    asOf: AS_OF,
  });
  assert.equal(sourced.stats.causalStrengthIssues, 0);
});

test('surpassing comparisons require a stated comparable basis', () => {
  const audit = auditOpeningDigestAttribution({
    article: article('The new assistant has surpassed ChatGPT in early downloads.'),
    snapshot: SNAPSHOT,
    asOf: AS_OF,
  });
  assert.equal(audit.stats.comparisonBasisIssues, 1);

  const qualified = auditOpeningDigestAttribution({
    article: article('The new assistant has surpassed ChatGPT over the same first 12 days after launch.'),
    snapshot: SNAPSHOT,
    asOf: AS_OF,
  });
  assert.equal(qualified.stats.comparisonBasisIssues, 0);
});

test('attribution repair invariant allows deletion but forbids new tokens', () => {
  const original = article('Oil rebounded for 4 days. [A sourced line](https://example.com/a) stays.');
  const deletion = article('[A sourced line](https://example.com/a) stays.');
  assert.deepEqual(attributionInvariantIssues(original, deletion), []);

  const original2 = article('Oil rebounded after four days of declines. [A sourced line](https://example.com/a) stays.');

  const changed = article('Oil fell for 5 days straight. [A sourced line](https://example.com/a) stays.');
  assert.ok(attributionInvariantIssues(original2, changed).some((issue) => issue.includes('added numbers:5')));

  const added = article('Oil rebounded for 4 days and then for 5 more. [A sourced line](https://example.com/a) stays.');
  assert.ok(attributionInvariantIssues(original, added).some((issue) => issue.includes('added numbers:5')));
});

test('evidence ledger maps linked sentences to sources, grades and snapshot references', () => {
  const research = [
    { title: 'Reuters market report', url: 'https://www.reuters.com/markets/oil', priority: true, openingDigestSourceId: 'OD1' },
    { title: 'META market quote', url: 'https://finance.yahoo.com/quote/META', openingDigestKind: 'universe-price', openingDigestSourceId: 'OD2' },
  ];
  const ledger = buildOpeningDigestEvidenceLedger({
    article: article('Crude inventories rose sharply, according to [wire reporting](https://www.reuters.com/markets/oil). META was +6.00% at 10:15 AM, versus the prior regular close, per the [Yahoo quote](https://finance.yahoo.com/quote/META).'),
    research,
    snapshot: SNAPSHOT,
    plan: { dominant_theme: 'opening-hour dispersion', stance: 'neutral', transmission_chain: [{ from: 'oil', to: 'yields', mechanism: 'inflation expectations', source_ids: ['OD1'] }] },
  });
  const linked = ledger.claims.filter((claim) => claim.source_urls.length);
  assert.equal(ledger.summary.claimCount, 7);
  assert.equal(ledger.summary.linkedClaimCount, 2);
  assert.deepEqual(ledger.claims[1].evidence_grade, 'wire-report');
  assert.deepEqual(ledger.claims[2].evidence_grade, 'price-observation-only');
  assert.deepEqual(ledger.plan.transmission_chain[0].from, 'oil');
});

test('evidence sources capture the exact excerpt the writer received with per-source caps', () => {
  const research = [
    { title: 'Wire report', url: 'https://example.com/wire', text: 'x'.repeat(3000), openingDigestSourceId: 'OD1' },
    { title: 'User file', url: 'https://example.com/user', text: 'y'.repeat(3000), userSpecified: true, openingDigestSourceId: 'OD2' },
  ];
  const sources = openingDigestEvidenceSources(research, { excerptChars: 1200, writer: { exaUserContentMaxChars: 24000 } });
  assert.equal(sources[0].excerpt.length, 1200 + '\n(原文过长已截断)'.length);
  assert.equal(sources[1].excerpt.length, 3000);
  assert.equal(evidenceGradeFor([{ official: true }]), 'official-data');
  assert.equal(evidenceGradeFor([]), 'unlinked');
});
