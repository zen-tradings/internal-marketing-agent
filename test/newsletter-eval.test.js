import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateNewsletter,
  formatEvalReport,
  judgeNewsletterWithModel,
  GRADE_THRESHOLDS,
} from '../src/lib/newsletter-eval.js';

const GOOD_MD = [
  '---',
  'title: HBM supply tightens into 2026',
  'subject: Zen Research from Zen Trading · Vol. 3 | HBM supply tightens',
  'preheader: Memory makers are sold out; the bottleneck is moving upstream.',
  'edition: Vol. 3',
  '---',
  '',
  'The memory cycle has turned. HBM capacity for 2026 is effectively allocated, and the constraint is shifting from wafer starts to advanced packaging.',
  '',
  '## Allocation, not demand, is the story',
  '',
  'SK Hynix and Micron report sold-out HBM supply through next year. The practical question for investors is who gets allocation, not whether demand exists.',
  '',
  '- HBM4 qualification windows close in the coming quarters',
  '- Packaging capacity additions lag wafer expansion by two to three quarters',
  '',
  '## What this means for pricing',
  '',
  'Contract pricing is likely to stay firm even if spot softness appears. Vendors with secured allocation hold the leverage; spot exposure is the weak position.',
  '',
  "## What we're watching",
  '',
  '- Qualification results from the second-largest customer',
  '- Packaging capex revisions in the next earnings cycle',
  '- Any shift in mix toward HBM4 ahead of schedule',
  '',
  'Relevant context: [SK Hynix IR](https://www.skhynix.com) and [TrendForce coverage](https://www.trendforce.com).',
  '',
].join('\n');

test('a compliant, well-formed newsletter scores high with zero errors', () => {
  const result = evaluateNewsletter(GOOD_MD);
  assert.ok(result.score >= 85, `score=${result.score}`);
  assert.equal(result.grade, 'A');
  assert.equal(result.issues.filter((issue) => issue.severity === 'error').length, 0);
  assert.equal(result.article.edition, 'Vol. 3');
  assert.ok(result.article.wordCount > 0);
});

test('missing frontmatter zeroes the metadata dimension', () => {
  const result = evaluateNewsletter('Just a body with no frontmatter. '.repeat(30));
  const metadata = result.dimensions.metadata;
  assert.equal(metadata.score, 0);
  assert.ok(metadata.issues.some((issue) => issue.severity === 'error'));
  assert.ok(result.score < 85);
});

test('preheader over 140 characters is an error', () => {
  const md = GOOD_MD.replace('Memory makers are sold out; the bottleneck is moving upstream.', 'x'.repeat(150));
  const result = evaluateNewsletter(md);
  assert.ok(result.dimensions.metadata.issues.some((issue) => issue.severity === 'error' && /preheader/.test(issue.message)));
});

test('compliance flags tables, raw HTML, unsubscribe links, and disclaimers', () => {
  const body = '## A\n\n| a | b |\n| --- | --- |\n\nClick to unsubscribe. This is not investment advice. <div>x</div>';
  const md = `---\ntitle: T\nsubject: Zen Research\npreheader: p\nedition: Vol. 1\n---\n${body}`;
  const result = evaluateNewsletter(md);
  const compliance = result.dimensions.compliance;
  assert.ok(compliance.score < 0.5, `score=${compliance.score}`);
  const labels = compliance.issues.map((issue) => issue.message).join('\n');
  assert.match(labels, /table/);
  assert.match(labels, /HTML/);
  assert.match(labels, /unsubscribe/);
  assert.match(labels, /disclaimer/);
});

test('too-short body is an error; too-long body is a warning', () => {
  const short = evaluateNewsletter('---\ntitle: T\nsubject: s\npreheader: p\nedition: Vol. 1\n---\nToo short.');
  assert.ok(short.dimensions.length.issues.some((issue) => issue.severity === 'error' && /too short/.test(issue.message)));

  const longBody = 'word '.repeat(1300);
  const long = evaluateNewsletter(`---\ntitle: T\nsubject: s\npreheader: p\nedition: Vol. 1\n---\n${longBody}`);
  assert.ok(long.dimensions.length.issues.some((issue) => issue.severity === 'warning' && /is long/.test(issue.message)));
});

test('market edition without a watching section warns; announcement editions are exempt', () => {
  const market = evaluateNewsletter('---\ntitle: T\nsubject: s\npreheader: p\nedition: Vol. 1\n---\n' + 'Market takeaway sentence. '.repeat(30));
  assert.ok(market.dimensions.editionType.issues.some((issue) => issue.severity === 'warning'));

  const announcement = evaluateNewsletter('---\ntitle: T\nsubject: s\npreheader: p\nedition: Vol. 1\n---\nIntroducing our new feature. ' + 'We are building something useful for you. '.repeat(20));
  assert.deepEqual(announcement.dimensions.editionType.issues, []);
});

test('a primarily Chinese body is an error when English is expected', () => {
  const md = '---\ntitle: T\nsubject: s\npreheader: p\nedition: Vol. 1\n---\n' + '这是一段中文正文内容用于验证语言维度检查。'.repeat(30);
  const result = evaluateNewsletter(md);
  assert.ok(result.dimensions.language.issues.some((issue) => issue.severity === 'error'));
});

test('bare URLs and excessive links warn; unparseable links are errors', () => {
  const many = Array.from({ length: 6 }, (_, i) => `[l${i}](https://example.com/${i})`).join(' ');
  const md = `---\ntitle: T\nsubject: s\npreheader: p\nedition: Vol. 1\n---\n${many} https://bare.example.com [bad](http://)`;
  const result = evaluateNewsletter(md);
  const links = result.dimensions.links;
  assert.ok(links.issues.some((issue) => issue.severity === 'warning' && /many inline links/.test(issue.message)));
  assert.ok(links.issues.some((issue) => issue.severity === 'warning' && /bare URL/.test(issue.message)));
  assert.ok(links.issues.some((issue) => issue.severity === 'error' && /cannot be parsed/.test(issue.message)));
});

test('formatEvalReport includes score, grade, and every dimension', () => {
  const report = formatEvalReport(evaluateNewsletter(GOOD_MD));
  assert.match(report, /Newsletter eval v1: \d+\/100 \([A-F]\)/);
  assert.match(report, /- metadata: \d+\/100/);
  assert.match(report, /- compliance: \d+\/100/);
});

test('grade thresholds are monotonic and start at A', () => {
  for (let i = 1; i < GRADE_THRESHOLDS.length; i += 1) {
    assert.ok(GRADE_THRESHOLDS[i - 1].min > GRADE_THRESHOLDS[i].min);
  }
  assert.equal(GRADE_THRESHOLDS[0].grade, 'A');
});

test('LLM judge rejects when no API key is configured', async () => {
  await assert.rejects(
    () => judgeNewsletterWithModel(GOOD_MD, { config: { writer: {} } }),
    /not configured/,
  );
});

test('LLM judge parses an injected OpenRouter response', async () => {
  const fetchFn = async (url, init) => {
    assert.match(String(url), /\/chat\/completions$/);
    const body = JSON.parse(init.body);
    assert.equal(body.temperature, 0);
    assert.equal(body.model, 'review-model');
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"clarity":90,"usefulness":80,"structure":85,"tone":88,"fidelity":95,"summary":"Solid edition.","issues":["Preheader could be tighter"]}' } }],
      }),
    };
  };
  const result = await judgeNewsletterWithModel(GOOD_MD, {
    config: { writer: { openrouterApiKey: 'sk-or-test', reviewModel: 'review-model', baseUrl: 'https://openrouter.example/v1' } },
    fetchFn,
  });
  assert.equal(result.score, 88);
  assert.equal(result.scores.fidelity, 95);
  assert.equal(result.summary, 'Solid edition.');
  assert.deepEqual(result.issues, ['Preheader could be tighter']);
});

test('LLM judge throws on non-JSON content instead of passing silently', async () => {
  const fetchFn = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'no json here' } }] }) });
  await assert.rejects(
    () => judgeNewsletterWithModel(GOOD_MD, { config: { writer: { openrouterApiKey: 'sk-or-test' } }, fetchFn }),
    /non-JSON/,
  );
});

test('LLM judge throws on HTTP failure', async () => {
  const fetchFn = async () => ({ ok: false, status: 503 });
  await assert.rejects(
    () => judgeNewsletterWithModel(GOOD_MD, { config: { writer: { openrouterApiKey: 'sk-or-test' } }, fetchFn }),
    /503/,
  );
});
