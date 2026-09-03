// Mutation testing for the eval checkers (Metric B, synthetic).
// Takes clean labeled cases (expect.defect === false), injects known defect types, and measures
// whether the checkers catch them. A missed mutant is a synthetic false negative: a defect class
// the auditor would ship silently. This makes recall measurable before any real incident exists.

import { resolveText, resolveJson } from './cases.js';
import { runCase } from './harness.js';

const FABRICATED_URL = 'https://fabricated-source.invalid/report';

// Each mutator returns null when it does not apply, otherwise a mutated case input.
export const MUTATORS = [
  {
    id: 'fabricated-citation',
    kinds: ['citation-grounding'],
    apply: (input, baseDir) => {
      const article = resolveText(input, baseDir, 'article', 'articlePath');
      const mutated = article.replace(/\((https?:\/\/[^\s)]+)\)/, `(${FABRICATED_URL})`);
      if (mutated === article) return null;
      return { ...input, article: mutated, articlePath: undefined };
    },
  },
  {
    id: 'secret-key-leak',
    kinds: ['gates'],
    apply: (input, baseDir) => {
      const markdown = resolveText(input, baseDir, 'markdown', 'markdownPath');
      return { ...input, markdown: `${markdown}\n\nDebug: sk-or-v1mutant0123456789abcdef`, markdownPath: undefined };
    },
  },
  {
    id: 'local-path-leak',
    kinds: ['gates'],
    apply: (input, baseDir) => {
      const markdown = resolveText(input, baseDir, 'markdown', 'markdownPath');
      return { ...input, markdown: `${markdown}\n\nSaved to /home/zen/workdir/article.md`, markdownPath: undefined };
    },
  },
  {
    id: 'market-read-overrun',
    kinds: ['opening-digest-limits'],
    apply: (input, baseDir) => {
      const article = resolveText(input, baseDir, 'article', 'articlePath');
      if (/^headline:/m.test(article)) {
        return {
          ...input,
          article: article.replace(/^headline:.*$/m, 'headline: This headline is deliberately far too long for the mobile Opening Digest subject'),
          articlePath: undefined,
        };
      }
      const padding = ' Extra sentence padding the market read beyond its enforced budget.'.repeat(4);
      return { ...input, article: `${article.trimEnd()}${padding}\n`, articlePath: undefined };
    },
  },
  {
    id: 'inflated-max-loss',
    kinds: ['options-strategy'],
    apply: (input) => {
      const maxLoss = input.stated?.maxLoss;
      if (!Number.isFinite(Number(maxLoss))) return null;
      return { ...input, stated: { ...input.stated, maxLoss: Number(maxLoss) * 1.5 + 1 } };
    },
  },
  {
    id: 'shifted-breakeven',
    kinds: ['options-strategy'],
    apply: (input) => {
      const breakevens = input.stated?.breakevens;
      if (!Array.isArray(breakevens) || !breakevens.length) return null;
      return { ...input, stated: { ...input.stated, breakevens: breakevens.map((be) => Number(be) + 5) } };
    },
  },
  {
    id: 'undisclosed-max-loss',
    kinds: ['options-strategy'],
    apply: (input) => {
      if (input.stated?.maxLoss === undefined) return null;
      const stated = { ...input.stated };
      delete stated.maxLoss;
      return { ...input, stated };
    },
  },
  {
    id: 'perturbed-holding-weight',
    kinds: ['qdii-reconcile'],
    apply: (input, baseDir) => {
      const reply = String(input.reply || '');
      const mutated = reply.replace(/(\d+(?:\.\d+)?)\s*%/, (_match, value) => `${(Number(value) + 2.75).toFixed(2)}%`);
      if (mutated === reply) return null;
      return { ...input, reply: mutated, payload: resolveJson(input, baseDir, 'payload', 'payloadPath'), payloadPath: undefined };
    },
  },
  {
    id: 'wrong-report-period',
    kinds: ['qdii-reconcile'],
    apply: (input, baseDir) => {
      const reply = String(input.reply || '');
      const mutated = reply.replace(/(\d{4})Q([1-4])/, (_match, year, quarter) => (
        quarter === '1' ? `${Number(year) - 1}Q4` : `${year}Q${Number(quarter) - 1}`
      ));
      if (mutated === reply) return null;
      return { ...input, reply: mutated, payload: resolveJson(input, baseDir, 'payload', 'payloadPath'), payloadPath: undefined };
    },
  },
  {
    id: 'swapped-holding-weights',
    kinds: ['qdii-reconcile'],
    apply: (input, baseDir) => {
      const reply = String(input.reply || '');
      const weights = [...reply.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((match) => match[1]);
      if (new Set(weights).size < 2) return null;
      const [first, second] = weights;
      let index = 0;
      const mutated = reply.replace(/(\d+(?:\.\d+)?)(\s*%)/g, (match, value, suffix) => {
        index += 1;
        if (index === 1) return `${second}${suffix}`;
        if (index === 2) return `${first}${suffix}`;
        return match;
      });
      return { ...input, reply: mutated, payload: resolveJson(input, baseDir, 'payload', 'payloadPath'), payloadPath: undefined };
    },
  },
  {
    id: 'full-portfolio-claim',
    kinds: ['qdii-reconcile'],
    apply: (input, baseDir) => {
      const reply = String(input.reply || '');
      if (!reply) return null;
      return {
        ...input,
        reply: `${reply}\nThis is the complete portfolio of the fund.`,
        payload: resolveJson(input, baseDir, 'payload', 'payloadPath'),
        payloadPath: undefined,
      };
    },
  },
];

export function generateMutants(cases) {
  const mutants = [];
  for (const entry of cases) {
    if (entry.expect?.defect !== false) continue; // mutate only known-clean cases
    for (const mutator of MUTATORS) {
      if (!mutator.kinds.includes(entry.kind)) continue;
      let input;
      try { input = mutator.apply(entry.input, entry.baseDir); }
      catch { input = null; }
      if (!input) continue;
      mutants.push({
        id: `${entry.id}::${mutator.id}`,
        kind: entry.kind,
        mutation: mutator.id,
        sourceCaseId: entry.id,
        input,
        expect: { defect: true },
        baseDir: entry.baseDir,
      });
    }
  }
  return mutants;
}

// Runs every generated mutant. recall = caught / mutants; every missed mutant is a synthetic
// false negative worth fixing in the corresponding checker.
export async function runMutationSuite(cases) {
  const mutants = generateMutants(cases);
  const results = [];
  for (const mutant of mutants) {
    const result = await runCase(mutant);
    results.push({ ...result, mutation: mutant.mutation, sourceCaseId: mutant.sourceCaseId });
  }
  const missed = results.filter((result) => !result.flagged);
  const byMutation = {};
  for (const result of results) {
    const bucket = byMutation[result.mutation] ||= { mutants: 0, caught: 0 };
    bucket.mutants += 1;
    if (result.flagged) bucket.caught += 1;
  }
  return {
    mutants: results.length,
    caught: results.length - missed.length,
    recall: results.length ? Math.round(((results.length - missed.length) / results.length) * 10000) / 10000 : null,
    missed: missed.map((result) => ({ id: result.id, mutation: result.mutation })),
    byMutation,
    results,
  };
}
