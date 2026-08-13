import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assessTranslationUnit } from '../workflows/translation-source-text.js';

export const OPENING_DIGEST_TRANSLATION_VERSION = 12;
const MODEL_TRANSLATION_BATCH_SIZE = 1;

const FIXED_TERMS = new Map([
  ['Market snapshot', '市场快照'],
  ['Earnings ahead', '财报预告'],
  ["Today's catalysts", '今日催化'],
  ['Market read', '市场解读'],
  ['Trending options volume', '期权成交量趋势'],
  ['Total option volume', '期权总成交量'],
  ['Call', '看涨期权成交量'],
  ['Put', '看跌期权成交量'],
  ['IVX change %', 'IVX 变化'],
  ['Source', '来源'],
  ['View source', '查看来源'],
  ['Data delayed 20 minutes', '数据延迟 20 分钟'],
  ['Opening capture', '开盘时点采集'],
  ['Latest available capture', '最新可用时点采集'],
  ['No major U.S.-listed earnings events were selected for the remainder of this week.', '本周余下时间暂无重点美股财报事件入选。'],
]);

export async function translateOpeningDigestPayload(payload, {
  writer, fetchFn = globalThis.fetch, cacheDir, timeoutMs = 5 * 60 * 1000, complete = completeTranslation,
} = {}) {
  const units = translationUnits(payload);
  const payloadHash = hashPayload(payload, writer?.model || '');
  const cachePath = cacheDir ? path.join(cacheDir, 'opening-digest-zh-CN.json') : '';
  if (cachePath) {
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      if (cached?.schemaVersion === OPENING_DIGEST_TRANSLATION_VERSION
        && cached?.payloadHash === payloadHash && validMapping(units, cached.translations)) return cached;
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw translationError(`中文译文缓存读取失败:${error.message}`);
    }
  }

  const translations = new Map();
  const modelUnits = [];
  for (const unit of units) {
    const fixed = FIXED_TERMS.get(unit.text);
    const company = unit.kind === 'company_name' ? translateCompanyName(unit.text) : '';
    const note = deterministicNoteTranslation(unit);
    const earnings = deterministicEarningsTranslation(unit);
    if (fixed) translations.set(unit.id, fixed);
    else if (company) translations.set(unit.id, company);
    else if (note) translations.set(unit.id, note);
    else if (earnings) translations.set(unit.id, earnings);
    else modelUnits.push(unit);
  }
  const repairs = [];
  if (modelUnits.length) {
    for (let offset = 0; offset < modelUnits.length; offset += MODEL_TRANSLATION_BATCH_SIZE) {
      let pending = modelUnits.slice(offset, offset + MODEL_TRANSLATION_BATCH_SIZE);
      for (let round = 0; round < 3 && pending.length; round++) {
        const protectedUnits = pending.map(protectTranslationUnit);
        const protectionById = new Map(protectedUnits.map((item) => [item.unit.id, item]));
        let result;
        try {
          result = await complete({ units: protectedUnits.map((item) => item.unit), writer, fetchFn, round, timeoutMs });
        } catch (error) {
          if (!error?.retryableTranslationResponse) throw error;
          const issues = [`模型响应 JSON 无效:${error.message}`];
          pending = pending.map((unit) => ({ ...unit, issues }));
          pending.forEach((unit) => repairs.push({ round: round + 1, id: unit.id, issues }));
          continue;
        }
        const returnedItems = Array.isArray(result?.translations) ? result.translations : [];
        const expectedIds = pending.map((unit) => unit.id);
        const returnedIds = returnedItems.map((item) => String(item.id));
        const responseMappingError = mappingResponseError(expectedIds, returnedIds);
        const returned = new Map(returnedItems.map((item) => [String(item.id), String(item.text || '').trim()]));
        const next = [];
        for (const unit of pending) {
          if (responseMappingError) {
            const issues = [responseMappingError];
            next.push({ ...unit, issues });
            repairs.push({ round: round + 1, id: unit.id, issues });
            continue;
          }
          if (!returned.has(unit.id)) {
            const issues = [`模型未返回文本块:${unit.id}`];
            next.push({ ...unit, issues });
            repairs.push({ round: round + 1, id: unit.id, issues });
            continue;
          }
          const text = restoreTranslationUnit(returned.get(unit.id) || '', protectionById.get(unit.id)?.tokens || []);
          const assessment = assessUnit(unit, text, round > 0);
          if (!assessment.hardErrors.length) translations.set(unit.id, text);
          else {
            next.push({ ...unit, issues: assessment.hardErrors });
            repairs.push({ round: round + 1, id: unit.id, issues: assessment.hardErrors });
          }
        }
        pending = next;
      }
      if (pending.length) {
        throw translationError(`Opening Digest 中文直译硬校验失败:${pending.map((unit) => `${unit.id}(${unit.issues.join('、')})`).join('; ')}`);
      }
    }
  }
  const ordered = units.map((unit) => ({ id: unit.id, kind: unit.kind, source: unit.text, text: translations.get(unit.id) }));
  if (!validMapping(units, ordered)) throw translationError('Opening Digest 中英块映射缺块、重复或乱序');
  const output = {
    schemaVersion: OPENING_DIGEST_TRANSLATION_VERSION,
    payloadHash,
    model: writer?.model || '',
    blockCount: ordered.length,
    repairs,
    translations: ordered,
    createdAt: new Date().toISOString(),
  };
  if (cachePath) {
    const temporary = `${cachePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, cachePath);
  }
  return output;
}

export function translationUnits(payload) {
  const units = [{ id: 'preheader', kind: 'preheader', text: String(payload.article.preheader || '') }];
  const lines = String(payload.article.body || '').split(/\r?\n/).filter((line) => line.trim());
  lines.forEach((line, index) => {
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    const list = /^\s*[-*+]\s+(.+)$/.exec(line);
    units.push({
      id: `body-${index + 1}`,
      kind: heading ? 'heading' : list ? 'list_item' : 'paragraph',
      text: String(heading?.[1] || list?.[1] || line).trim(),
      markdown: line,
    });
  });
  [...new Set((payload.metrics || []).map((metric) => metric.sourceNote).filter(Boolean))]
    .forEach((text, index) => units.push({ id: `metric-note-${index + 1}`, kind: 'note', text }));
  if (payload.options) {
    units.push({ id: 'oic-asof', kind: 'note', text: String(payload.options.data.asOf || '') });
    units.push({ id: 'oic-attribution', kind: 'note', text: String(payload.options.data.attribution || '') });
    payload.options.data.rows.forEach((row, index) => units.push({
      id: `oic-company-${index + 1}`, kind: 'company_name', text: String(row[2] || ''),
    }));
  }
  return units.filter((unit) => unit.text.trim());
}

export function translationMap(result) {
  return new Map((result?.translations || []).map((unit) => [unit.id, unit]));
}

function assessUnit(unit, text, afterRepair) {
  const brandError = compareBrandTokens(unit.text, text, unit.kind);
  if (unit.kind === 'company_name') {
    const invariant = assessTranslationUnit(unit, text, { afterRepair });
    return {
      ...invariant,
      hardErrors: [...new Set([...invariant.hardErrors.filter((item) => item !== '疑似未完成翻译'), ...(brandError ? [brandError] : [])])],
    };
  }
  const invariant = assessTranslationUnit(unit, text, { afterRepair });
  return { ...invariant, hardErrors: [...new Set([...invariant.hardErrors, ...(brandError ? [brandError] : [])])] };
}

function compareBrandTokens(source, translated, kind) {
  const sourceTokens = brandTokens(source, kind);
  const target = String(translated || '');
  const missing = sourceTokens.filter((token) => !target.includes(token));
  return missing.length ? `Ticker、公司或来源机构品牌未原样保留:${missing.join('、')}` : '';
}

function brandTokens(value, kind) {
  const text = String(value || '');
  const linkedSources = kind === 'company_name' ? [] : [...text.matchAll(/\[([^\]]+)]\(https?:\/\//gi)]
    .map((match) => match[1].trim())
    .filter(isInstitutionLabel);
  const tickerCompanies = kind === 'company_name' ? [] : [...text.matchAll(/\*\*([^*()]+?)\s*\(([A-Z]{1,6})\)\*\*/g)]
    .map((match) => stripLegalSuffix(match[1].replace(/^[^A-Za-z]+|[^A-Za-z.&'\-]+$/g, '').trim()));
  const tokens = [
    ...(text.match(/\b[A-Z]{2,10}\b/g) || []),
    ...(text.match(/\b[A-Za-z]*[a-z][A-Z][A-Za-z]*\b/g) || []),
    ...linkedSources,
    ...tickerCompanies,
  ];
  if (kind === 'company_name') {
    const brand = stripLegalSuffix(text);
    if (brand && brand !== text) tokens.push(brand);
  }
  return [...new Set(tokens)].filter((token) => token.length > 1 && !TIMEZONE_TOKENS.has(token));
}

function isInstitutionLabel(value) {
  const words = String(value || '').match(/[A-Za-z][A-Za-z’'.&-]*/g) || [];
  return words.length > 0 && words.length <= 5
    && words.every((word) => /^[A-Z]/.test(word) || /^[A-Z]{2,}$/.test(word));
}

const TIMEZONE_TOKENS = new Set(['ET', 'EST', 'EDT', 'PT', 'PST', 'PDT', 'UTC', 'GMT']);

function stripLegalSuffix(value) {
  return String(value || '').replace(/['’]s$/i, '')
    .replace(/(?:,?\s+)(?:Corporation|Corp\.?|Incorporated|Inc\.?|Limited|Ltd\.?|LLC|PLC|Company|Co\.?)$/i, '').trim();
}

function translateCompanyName(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const suffix = /(?:,?\s+)(Corporation|Corp\.?|Incorporated|Inc\.?|Limited|Ltd\.?|LLC|PLC|Company|Co\.?)$/i.exec(text);
  if (!suffix) return text;
  return `${text.slice(0, suffix.index).trim()} 公司`;
}

function deterministicNoteTranslation(unit) {
  const text = String(unit.text || '').trim();
  if (unit.id === 'oic-asof') return `截至 ${text.replace(/^As of\s+/i, '')}`;
  if (unit.id === 'oic-attribution') {
    const provided = /^Data provided by\s+(.+)$/i.exec(text);
    return provided ? `数据由 ${provided[1]} 提供` : `数据来源：${text}`;
  }
  return '';
}

function deterministicEarningsTranslation(unit) {
  const source = String(unit.text || '').trim();
  if (unit.kind !== 'paragraph' || !/\[[A-Z0-9.\-]+]\(https?:\/\//.test(source)
    || !/(?:before open|after close|timing not supplied)/.test(source)) return '';
  const links = [];
  let text = source.replace(/\[[^\]]+]\(https?:\/\/[^\s)]+\)/g, (link) => {
    links.push(link);
    return `ZEN_EARNINGS_LINK_${links.length - 1}`;
  });
  const weekdays = { Sun: '周日', Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六' };
  const months = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
  text = text.replace(/\*\*(Sun|Mon|Tue|Wed|Thu|Fri|Sat),\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}):\*\*/g,
    (_match, weekday, month, day) => `**${months[month]}月${Number(day)}日 ${weekdays[weekday]}：**`);
  text = text
    .replace(/before open \(expected\); call /g, '盘前（预计）；电话会 ')
    .replace(/after close \(expected\); call /g, '盘后（预计）；电话会 ')
    .replace(/timing not supplied \(expected\); call /g, '披露时段未提供（预计）；电话会 ')
    .replace(/before open; call /g, '盘前披露；电话会 ')
    .replace(/after close; call /g, '盘后披露；电话会 ')
    .replace(/timing not supplied; call /g, '披露时段未提供；电话会 ')
    .replace(/before open \(expected\)/g, '盘前（预计）')
    .replace(/after close \(expected\)/g, '盘后（预计）')
    .replace(/timing not supplied \(expected\)/g, '披露时段未提供（预计）')
    .replace(/;\s+/g, '；')
    .replace(/\.\s+(?=\*\*)/g, '。 ');
  links.forEach((link, index) => { text = text.replace(`ZEN_EARNINGS_LINK_${index}`, link); });
  return text.endsWith('.') ? `${text.slice(0, -1)}。` : text;
}

function mappingResponseError(expectedIds, returnedIds) {
  const expected = new Set(expectedIds);
  const unexpected = returnedIds.filter((id) => !expected.has(id));
  const duplicates = returnedIds.filter((id, index) => returnedIds.indexOf(id) !== index);
  const expectedSubsetOrder = expectedIds.filter((id) => returnedIds.includes(id));
  const returnedExpectedOrder = returnedIds.filter((id) => expected.has(id));
  if (!unexpected.length && !duplicates.length
    && JSON.stringify(returnedExpectedOrder) === JSON.stringify(expectedSubsetOrder)) return '';
  return `模型返回的块 ID 重复、乱序或含未知项:期望 ${expectedIds.join(',')}，实际 ${returnedIds.join(',')}`;
}

export function protectTranslationUnit(unit) {
  const source = String(unit.text || '');
  const candidates = [
    ...institutionMarkdownLinks(source),
    ...(source.match(/https?:\/\/[^\s)\]}>"']+/gi) || []),
    ...(source.match(/\b\d{1,2}:\d{2}(?:\s*(?:a\.m\.|p\.m\.|AM|PM))?(?:\s+(?:ET|EST|EDT|PT|PST|PDT|UTC|GMT))?/gi) || []),
    ...(source.match(/\b(?:ET|EST|EDT|PT|PST|PDT|UTC|GMT)\b/g) || []),
    ...(source.match(/\b(?:Q[1-4]|H[12]|FY\d{2,4}|[1-4]Q\d{2,4})\b/g) || []),
    ...(source.match(/(?:[$€£¥]\s*)?[-+]?\d+(?:[,.]\d+)*\s+(?:thousand|million|billion|trillion)(?:\s+(?:U\.S\.\s+)?dollars?)?/gi) || []),
    ...(source.match(/(?<![A-Za-z0-9])[-+]?\d+(?:[,.]\d+)*(?:%|‰)?/g) || []),
    ...brandTokens(source, unit.kind),
    ...(source.match(/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+\b/g) || []),
    ...(source.match(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z][A-Za-z0-9]{2,}\b/g) || []),
    // Qwen's strict JSON-schema output can stop a translated string at a source
    // quotation boundary while still reporting finish_reason=stop. Protecting the
    // quotation marks keeps the boundary opaque to the model; restore then puts
    // the exact original punctuation back before the invariant checks run.
    ...(source.match(/["“”]/g) || []),
  ];
  const values = [...new Set(candidates.filter(Boolean))].sort((a, b) => b.length - a.length);
  const ranges = [];
  for (const value of values) {
    for (let start = source.indexOf(value); start >= 0; start = source.indexOf(value, start + Math.max(value.length, 1))) {
      const end = start + value.length;
      if (!ranges.some((range) => start < range.end && end > range.start)) ranges.push({ start, end, value });
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const tokens = ranges.map((range, index) => ({ marker: `⟦ZEN_KEEP_${alphaMarker(index)}⟧`, value: range.value }));
  let cursor = 0; let text = '';
  ranges.forEach((range, index) => {
    text += source.slice(cursor, range.start) + tokens[index].marker;
    cursor = range.end;
  });
  text += source.slice(cursor);
  const { markdown: _unprotectedMarkdown, ...safeUnit } = unit;
  return { unit: { ...safeUnit, text }, tokens };
}

function institutionMarkdownLinks(source) {
  return [...String(source || '').matchAll(/\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/gi)]
    .filter((match) => isInstitutionLabel(match[1]))
    .map((match) => match[0]);
}

function alphaMarker(index) {
  let value = Number(index) + 1;
  let output = '';
  while (value > 0) {
    value -= 1;
    output = String.fromCharCode(65 + (value % 26)) + output;
    value = Math.floor(value / 26);
  }
  return output.padStart(3, 'A');
}

export function restoreTranslationUnit(value, tokens) {
  let text = String(value || '');
  for (const { marker, value: original } of tokens) text = text.replaceAll(marker, original);
  return text;
}

async function completeTranslation({ units, writer, fetchFn, round, timeoutMs }) {
  if (!writer?.openrouterApiKey) throw translationError('Opening Digest 中文直译缺少 OPENROUTER_API_KEY');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs) || 5 * 60 * 1000);
  const prompt = `将下列 Opening Digest 文本块完整直译为简体中文。不得摘要、解释、增删或改写事实。严格保留所有数字、百分比、Ticker、指数代码、型号、时间、URL、引文和机构品牌。每个形如 ⟦ZEN_KEEP_AAA⟧ 的占位符都代表一个不可变原文 token：必须逐字保留，而且每块中占位符的数量、拼写和顺序必须完全不变。公司品牌与无法可靠判断的专名保留原文；只翻译法律后缀和通用描述，例如 NVIDIA Corporation -> NVIDIA 公司。保留 Markdown 行内标记和链接 URL。返回与输入 ID 数量、顺序完全一致的 JSON。${round ? `这是第 ${round} 次局部修复，重点修复每块 issues。` : ''}\n\n${JSON.stringify(units)}`;
  try {
    const response = await fetchFn(`${String(writer.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: {
        Authorization: `Bearer ${writer.openrouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': writer.httpReferer || 'https://zentradings.com',
        'X-OpenRouter-Title': writer.appTitle || 'Zen Content Hub',
      },
      body: JSON.stringify({
        model: writer.model,
        messages: [{ role: 'system', content: 'You are a rigorous financial translator. Output JSON only.' }, { role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: Math.min(Number(writer.maxTokens) || 12000, 12000),
        reasoning: { effort: 'low', exclude: true },
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'opening_digest_translation', strict: true, schema: {
            type: 'object', additionalProperties: false, required: ['translations'], properties: {
              translations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' } } } },
            },
          } },
        },
      }),
    });
    const raw = await response.text();
    if (!response.ok) throw translationError(`OpenRouter 中文直译失败:${response.status} ${raw.slice(0, 300)}`);
    let data;
    try { data = JSON.parse(raw); }
    catch (error) { throw translationResponseError(`OpenRouter 响应外壳不是有效 JSON:${error.message}`); }
    return parseJson(data?.choices?.[0]?.message?.content);
  } catch (error) {
    if (error?.name === 'AbortError') throw translationError('Opening Digest 中文直译超时');
    if (error?.stage === 'translation') throw error;
    throw translationError(`Opening Digest 中文直译失败:${error.message}`);
  } finally { clearTimeout(timer); }
}

function parseJson(value) {
  const raw = Array.isArray(value) ? value.map((part) => part?.text || part).join('') : String(value || '');
  const clean = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  let directError;
  try { return JSON.parse(clean); } catch (error) { directError = error; }
  const start = clean.indexOf('{'); const end = clean.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(clean.slice(start, end + 1)); } catch (error) { directError = error; }
  }
  throw translationResponseError(`OpenRouter 中文直译未返回有效 JSON:${directError?.message || '响应为空'}`);
}

function validMapping(units, translations) {
  return Array.isArray(translations) && translations.length === units.length
    && translations.every((item, index) => item?.id === units[index].id && String(item.text || '').trim());
}

function hashPayload(payload, model) {
  return crypto.createHash('sha256').update(JSON.stringify({ version: OPENING_DIGEST_TRANSLATION_VERSION, model, payload })).digest('hex');
}

function translationError(message) { const error = new Error(message); error.stage = 'translation'; return error; }
function translationResponseError(message) {
  const error = translationError(message);
  error.retryableTranslationResponse = true;
  return error;
}
