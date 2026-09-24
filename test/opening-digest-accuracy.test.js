import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditOpeningDigestNumberProvenance,
  auditOpeningDigestPeriodConsistency,
  OPENING_DIGEST_PROVENANCE_MAX_EXCERPT_CHARS,
} from '../src/lib/opening-digest-number-provenance.js';
import {
  matchOpeningVerificationResults,
  normalizeOpeningVerificationResults,
  openingDigestSnapshotEvidence,
} from '../src/core/writer/opening-editor.js';

const FRONTMATTER = '---\ntitle: Zen Opening Digest\nheadline: Fed decision looms over narrow equity participation\nstance: neutral\nconfidence: medium\nedition: 2026-09-23\n---\n';

const ARTICLE = `${FRONTMATTER}
The market opened neutral as supply concerns support energy.

## What matters today

**Oil holds the tape.** WTI traded at 91.99 dollars while yields sat at 5.00 percent [CNBC](https://example.com/a).

**Growth holds.** The composite PMI registered 58.4, up from 56.0 [Reuters](https://example.com/b).

## Evidence and cross-currents

The strongest support is the jump in survey pricing [Reuters](https://example.com/b).

The strongest cross-current is thinner participation [CNBC](https://example.com/a).

## What to watch

- Whether participation broadens through the session [Bloomberg](https://example.com/c)
`;

function researchFixture() {
  return [
    { url: 'https://example.com/a', text: 'WTI was 89.41 dollars, down 1.2 percent, and the 10-year yield stood at 4.947 percent.' },
    { url: 'https://example.com/b', text: 'The composite PMI registered 58.4 in September, up from 56.0.' },
    { url: 'https://example.com/c', text: 'Participation narrowed in early dealings.' },
  ];
}

test('数字无源审计：句内精确数字未出现在链接来源摘录时报错', () => {
  const audit = auditOpeningDigestNumberProvenance({ article: ARTICLE, research: researchFixture() });
  assert.ok(audit.warnings.length >= 1);
  assert.ok(audit.warnings.some((warning) => warning.includes('91.99')));
  assert.ok(audit.warnings.some((warning) => warning.includes('5.00')));
  assert.equal(audit.stats.unverifiedNumbers >= 2, true);
});

test('数字无源审计：来源摘录含同值或舍入等值时不报错', () => {
  const research = [
    { url: 'https://example.com/a', text: 'WTI traded at 91.99 dollars.' },
  ];
  const article = `${FRONTMATTER}
## What matters today

**Oil holds the tape.** WTI traded at 91.99 dollars [CNBC](https://example.com/a).
`;
  const audit = auditOpeningDigestNumberProvenance({ article, research });
  assert.deepEqual(audit.warnings, []);
});

test('数字无源审计：快照数值与变动幅度被豁免', () => {
  const snapshot = { metrics: [{ label: 'WTI', value: 91.99, changePct: -2.75 }] };
  const article = `${FRONTMATTER}
## What matters today

**Oil holds the tape.** WTI traded at 91.99 dollars, down 2.75% [CNBC](https://example.com/a).
`;
  const audit = auditOpeningDigestNumberProvenance({ article, research: researchFixture(), snapshot });
  assert.deepEqual(audit.warnings, []);
});

test('数字无源审计：摘录超过上限视为不可验证并跳过', () => {
  const research = [{ url: 'https://example.com/a', text: 'x'.repeat(OPENING_DIGEST_PROVENANCE_MAX_EXCERPT_CHARS + 100) }];
  const audit = auditOpeningDigestNumberProvenance({ article: ARTICLE, research });
  assert.deepEqual(audit.warnings, []);
  assert.equal(audit.stats.unverifiableSentences >= 1, true);
});

test('数字无源审计：舍入到摘录数值的容差内不报错', () => {
  const research = [{ url: 'https://example.com/a', text: 'The 10-year yield stood at 4.947 percent.' }];
  const article = `${FRONTMATTER}
## Evidence and cross-currents

The 10-year yield trades near 4.95 percent [Reuters](https://example.com/a).
`;
  const audit = auditOpeningDigestNumberProvenance({ article, research });
  assert.deepEqual(audit.warnings, []);
});

test('年份一致性审计：非对比语境的往年同期被标记，since/对比语境豁免', () => {
  const stale = `${FRONTMATTER}
## What matters today

**PMI point.** The September 2025 composite PMI was 58.4.
`;
  const audit = auditOpeningDigestPeriodConsistency({ article: stale, asOf: new Date('2026-09-23T14:00:00Z') });
  assert.equal(audit.warnings.length, 1);
  assert.ok(audit.warnings[0].includes('September 2025'));

  const comparative = `${FRONTMATTER}
## What matters today

**Growth point.** Activity is the highest since July 2021, with new orders at 58.2.
`;
  assert.deepEqual(auditOpeningDigestPeriodConsistency({ article: comparative, asOf: new Date('2026-09-23T14:00:00Z') }).warnings, []);

  const current = `${FRONTMATTER}
## What matters today

**Growth point.** The September 2026 flash PMI rose to 58.4.
`;
  assert.deepEqual(auditOpeningDigestPeriodConsistency({ article: current, asOf: new Date('2026-09-23T14:00:00Z') }).warnings, []);
});

test('复核裁决归一化与覆盖率：空裁决视为未验证', () => {
  const severe = [
    { claim: 'Revenue was 900 billion.', category: 'fabricated_number_or_date', sourceUrl: 'https://example.com/a' },
  ];
  assert.equal(matchOpeningVerificationResults(severe, []).coverage, 0);
  const partial = normalizeOpeningVerificationResults([
    { claim: 'Revenue was 900 billion.', status: 'fixed', evidence: 'repaired' },
  ]);
  assert.equal(matchOpeningVerificationResults(severe, partial).coverage, 1);
  const fuzzy = normalizeOpeningVerificationResults([
    { claim: 'revenue was 900 billion', status: 'unresolved', evidence: 'still present' },
  ]);
  assert.equal(matchOpeningVerificationResults(severe, fuzzy).coverage, 1);
  const unrelated = normalizeOpeningVerificationResults([
    { claim: 'another claim entirely', status: 'fixed', evidence: 'x' },
  ]);
  assert.equal(matchOpeningVerificationResults(severe, unrelated).coverage, 0);
});

test('归因快照证据源包含可核对的数值与捕获时间', () => {
  const evidence = openingDigestSnapshotEvidence({
    capturedAt: '2026-09-23T14:00:00.088Z',
    metrics: [
      { label: 'WTI', value: 89.41, changePct: -1.2, asOf: '2026-09-23T13:59:00Z' },
      { label: 'VIX', value: 17.2, unavailable: true },
    ],
  });
  assert.ok(evidence.url.startsWith('zen-attribution-snapshot://'));
  assert.ok(evidence.text.includes('WTI: 89.41'));
  assert.ok(evidence.text.includes('-1.20% versus prior close'));
  assert.ok(!evidence.text.includes('VIX'));
});