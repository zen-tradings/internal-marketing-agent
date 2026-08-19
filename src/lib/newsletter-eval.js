// Newsletter quality evaluation. Pure and offline by default: evaluateNewsletter() runs deterministic
// rubric checks against the email workflow output contract (frontmatter, sectioning, length, links,
// compliance). judgeNewsletterWithModel() is an optional LLM rubric pass and only runs when explicitly
// requested; it never affects channel state and is safe to run against any article.md draft.

import { parseNewsletterArticle } from './newsletter-email.js';

export const EVAL_VERSION = 1;
export const GRADE_THRESHOLDS = [
  { grade: 'A', min: 85 },
  { grade: 'B', min: 70 },
  { grade: 'C', min: 55 },
  { grade: 'D', min: 40 },
  { grade: 'F', min: 0 },
];

const DEFAULT_WEIGHTS = {
  metadata: 15,
  structure: 20,
  length: 15,
  compliance: 25,
  links: 10,
  language: 10,
  editionType: 5,
};

const SUBJECT_RECOMMENDED_MAX = 70;
const TITLE_MAX = 80;
const MIN_WORDS = 120;
const MAX_WORDS = 1200;
const LONG_PARAGRAPH_WORDS = 120;
const FRONTMATTER_KEYS = ['title', 'subject', 'preheader', 'edition'];

const COMPLIANCE_PATTERNS = [
  { re: /\|[-\s|]+\|/m, label: 'a Markdown table', note: 'the template owns layout; body must not contain tables' },
  { re: /<\/?(?:div|span|table|tr|td|img|style|script)\b/i, label: 'raw HTML tags', note: 'the template owns layout; body must not contain raw HTML' },
  { re: /!\[[^\]]*\]\([^)]+\)/, label: 'an inline image', note: 'fixed images are injected by the template; body must not contain images' },
  { re: /```/, label: 'a code block', note: 'newsletter body must not contain code blocks' },
  { re: /\bunsubscribe\b/i, label: 'an unsubscribe link', note: 'the Customer.io layout owns the legal unsubscribe link' },
  { re: /\b(?:all\s+rights\s+reserved|terms\s+of\s+service)\b/i, label: 'footer legal text', note: 'the template owns the footer' },
  { re: /physical\s+address|mailing\s+address|\d+\s+Leahy\s+St/i, label: 'a physical address', note: 'the template owns the physical address' },
  { re: /not\s+(?:financial|investment)\s+advice|investment\s+advice\s+disclaimer/i, label: 'an investment-advice disclaimer', note: 'the template owns disclaimers' },
  { re: /(?:^|\n)\s*(?:best\s+regards|sincerely|cheers|thanks\s+for\s+reading|the\s+zen\s+(?:trading\s+)?team)\b[^\n]*$/im, label: 'a signature/sign-off', note: 'the template owns branding; do not sign the body' },
];

const WATCHING_HEADING_RE = /^#{2,4}\s+.*\bwatching\b/im;

export function evaluateNewsletter(markdown, { edition, expectLanguage = 'en' } = {}) {
  const source = String(markdown || '');
  const article = parseNewsletterArticle(source, edition || 'Vol. 1');
  const body = article.body;
  const issues = [];
  const dimensions = {
    metadata: evalMetadata(source, article, edition),
    structure: evalStructure(body),
    length: evalLength(body),
    compliance: evalCompliance(body),
    links: evalLinks(body),
    language: evalLanguage(body, expectLanguage),
    editionType: evalEditionType(body),
  };
  let weighted = 0;
  let weightTotal = 0;
  for (const [id, dim] of Object.entries(dimensions)) {
    const weight = DEFAULT_WEIGHTS[id];
    weightTotal += weight;
    weighted += dim.score * weight;
    for (const issue of dim.issues) issues.push({ dimension: id, ...issue });
  }
  const score = weightTotal ? Math.round((weighted / weightTotal) * 100) : 0;
  return {
    version: EVAL_VERSION,
    score,
    grade: gradeFor(score),
    article: {
      title: article.title,
      edition: article.edition,
      subject: article.subject,
      preheader: article.preheader,
      wordCount: wordCount(body),
    },
    dimensions,
    issues,
  };
}

function evalMetadata(source, article, expectedEdition) {
  const dim = dimension('metadata');
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    dim.score = 0;
    dim.issues.push({ severity: 'error', message: 'Missing YAML frontmatter (title/subject/preheader/edition)' });
    return dim;
  }
  const keys = new Set();
  for (const line of match[1].split('\n')) {
    const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (pair) keys.add(pair[1].toLowerCase());
  }
  for (const key of FRONTMATTER_KEYS) {
    if (!keys.has(key)) fail(dim, `frontmatter is missing ${key}`);
  }
  if (keys.has('title')) {
    if (article.title === 'Untitled newsletter') fail(dim, 'title is empty');
    else if (article.title.length > TITLE_MAX) warn(dim, `title too long (${article.title.length} chars, recommended <=${TITLE_MAX})`);
  }
  if (keys.has('subject')) {
    if (article.subject.length > SUBJECT_RECOMMENDED_MAX) {
      warn(dim, `subject too long (${article.subject.length} chars, recommended <=${SUBJECT_RECOMMENDED_MAX}; may truncate on mobile)`);
    }
    if (!/zen research/i.test(article.subject)) warn(dim, 'subject does not carry the Zen Research brand');
  }
  if (keys.has('preheader')) {
    const preheader = match[1].match(/^preheader:\s*(.*)$/im)?.[1]?.trim() || '';
    if (!preheader) warn(dim, 'preheader is empty; it will fall back to the first body paragraph');
    else if (preheader.length > 140) fail(dim, `preheader exceeds 140 characters (${preheader.length})`);
  }
  if (expectedEdition && keys.has('edition') && article.edition !== expectedEdition) {
    warn(dim, `edition (${article.edition}) does not match the expected edition (${expectedEdition})`);
  }
  return dim;
}

function evalStructure(body) {
  const dim = dimension('structure');
  const headings = body.split('\n')
    .map((line) => line.match(/^(#{2,4})\s+(.+)$/))
    .filter(Boolean);
  if (!headings.length) fail(dim, 'body has no section headings (## ...); the contract asks for 2-4 judgment-led sections');
  else if (headings.length < 2) warn(dim, `only ${headings.length} section heading; 2-4 recommended`);
  else if (headings.length > 4) warn(dim, `too many section headings (${headings.length}); 2-4 recommended`);
  const paragraphs = body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block && !block.startsWith('#') && !/^(?:[-*]\s)/m.test(block));
  const longParagraphs = paragraphs.filter((block) => wordCount(block) > LONG_PARAGRAPH_WORDS);
  if (longParagraphs.length) warn(dim, `${longParagraphs.length} paragraph(s) exceed ${LONG_PARAGRAPH_WORDS} words; keep email paragraphs short`);
  const bullets = (body.match(/^(?:[-*])\s+/gm) || []).length;
  if (!headings.length && bullets < 3) warn(dim, 'body has neither headings nor lists; hard to scan in email');
  return dim;
}

function evalLength(body) {
  const dim = dimension('length');
  const words = wordCount(body);
  if (words === 0) fail(dim, 'body is empty');
  else if (words < MIN_WORDS) fail(dim, `body too short (${words} words, below the ${MIN_WORDS}-word minimum); not enough substance for an edition`);
  else if (words > MAX_WORDS) warn(dim, `body is long (${words} words, recommended <=${MAX_WORDS}); email completion rates drop`);
  return dim;
}

function evalCompliance(body) {
  const dim = dimension('compliance');
  for (const { re, label, note } of COMPLIANCE_PATTERNS) {
    if (re.test(body)) fail(dim, `body contains ${label}: ${note}`);
  }
  return dim;
}

function evalLinks(body) {
  const dim = dimension('links');
  const urls = [...body.matchAll(/\[[^\]]+\]\((https?:\/\/[^\s)]*)\)/g)].map((m) => m[1]);
  for (const url of urls) {
    if (!parseableUrl(url)) fail(dim, `link cannot be parsed: ${url}`);
  }
  if (urls.length > 5) warn(dim, `many inline links (${urls.length}); keep only the 1-5 most relevant`);
  const bare = body.match(/(?<![\w(])https?:\/\/[^\s)]+/g) || [];
  if (bare.length) warn(dim, `found ${bare.length} bare URL(s); use Markdown link text instead`);
  return dim;
}

function evalLanguage(body, expectLanguage) {
  const dim = dimension('language');
  if (expectLanguage !== 'en') return dim;
  const letters = (body.match(/[A-Za-z]/g) || []).length;
  const cjk = (body.match(/[一-鿿]/g) || []).length;
  if (cjk > letters && letters < 200) {
    fail(dim, 'the task expects English but the body is primarily Chinese');
  }
  return dim;
}

function evalEditionType(body) {
  const dim = dimension('editionType');
  const looksAnnouncement = /\b(?:introducing|we(?:'re| are) building|announcing|welcome)\b/i.test(body);
  if (looksAnnouncement) return dim; // Product/announcement editions are exempt from the market closing section.
  if (!WATCHING_HEADING_RE.test(body)) {
    warn(dim, 'market/research edition is missing a "What we\'re watching" closing section (announcement editions are exempt)');
  }
  return dim;
}

export function formatEvalReport(result) {
  const lines = [
    `Newsletter eval v${result.version}: ${result.score}/100 (${result.grade})`,
    `Title: ${result.article.title} | ${result.article.edition} | ${result.article.wordCount} words`,
  ];
  for (const [id, dim] of Object.entries(result.dimensions)) {
    lines.push(`- ${id}: ${Math.round(dim.score * 100)}/100${dim.issues.length ? '' : ' OK'}`);
    for (const issue of dim.issues) lines.push(`  [${issue.severity}] ${issue.message}`);
  }
  return lines.join('\n');
}

// Optional LLM rubric judge. fetchFn must be injectable so offline tests never touch the network;
// callers should treat this as advisory only. It must never block draft creation.
export async function judgeNewsletterWithModel(markdown, { config, fetchFn = globalThis.fetch, signal, language = 'en' } = {}) {
  const writer = config?.writer || {};
  if (!writer.openrouterApiKey) throw new Error('OpenRouter is not configured');
  const article = parseNewsletterArticle(markdown);
  const response = await fetchFn(`${String(writer.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      Authorization: `Bearer ${writer.openrouterApiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': writer.httpReferer || 'https://zentradings.com',
      'X-OpenRouter-Title': writer.appTitle || 'Zen Content Hub',
    },
    body: JSON.stringify({
      model: writer.reviewModel || writer.model,
      temperature: 0,
      max_tokens: 1200,
      reasoning: { effort: writer.reviewReasoningEffort || 'none', exclude: true },
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a strict newsletter quality reviewer. Score the edition on five dimensions with integer 0-100 scores: clarity (one clear takeaway, readable email prose), usefulness (specific, actionable, non-generic), structure (scannable sections, appropriate length), tone (professional, no hype), fidelity (claims look internally consistent, no invented specifics). Return only JSON: {"clarity":0,"usefulness":0,"structure":0,"tone":0,"fidelity":0,"summary":"one sentence","issues":["short concrete issue"]}.',
        },
        {
          role: 'user',
          content: `Expected language: ${language}\n\nTitle: ${article.title}\nSubject: ${article.subject}\nPreheader: ${article.preheader}\n\nBody:\n${article.body}`.slice(0, 80000),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter eval failed: ${response.status}`);
  const data = await response.json();
  const raw = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(raw) ? raw.map((part) => part?.text || '').join('') : String(raw || '');
  let parsed;
  try { parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || ''); }
  catch { throw new Error('OpenRouter eval returned non-JSON content'); }
  const scores = {};
  for (const key of ['clarity', 'usefulness', 'structure', 'tone', 'fidelity']) {
    const value = Number(parsed[key]);
    scores[key] = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
  }
  const values = Object.values(scores);
  return {
    scores,
    score: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    summary: String(parsed.summary || '').slice(0, 500),
    issues: (Array.isArray(parsed.issues) ? parsed.issues : []).map((issue) => String(issue).slice(0, 300)).slice(0, 10),
  };
}

function parseableUrl(url) {
  try {
    const parsed = new URL(url);
    return Boolean(parsed.hostname);
  } catch { return false; }
}

function dimension(id) {
  return { id, score: 1, issues: [] };
}

function fail(dim, message) {
  dim.score = Math.max(0, dim.score - 0.4);
  dim.issues.push({ severity: 'error', message });
}

function warn(dim, message) {
  dim.score = Math.max(0, dim.score - 0.15);
  dim.issues.push({ severity: 'warning', message });
}

function gradeFor(score) {
  for (const { grade, min } of GRADE_THRESHOLDS) {
    if (score >= min) return grade;
  }
  return 'F';
}

function wordCount(text) {
  const words = String(text || '').match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || [];
  const cjk = String(text || '').match(/[一-鿿]/g) || [];
  return words.length + cjk.length;
}
