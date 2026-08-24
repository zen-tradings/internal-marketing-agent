import { JSDOM } from 'jsdom';

const RESERVED_HEADINGS = new Set([
  '引用链接',
  '引用来源',
  '资料来源',
  '参考来源',
  '来源列表',
  'Sources',
  'References',
]);

const ORDINAL_RE = /^(?:(?:0?\d{1,2}|[一二三四五六七八九十百]+)[、.．]|[（(](?:0?\d{1,2}|[一二三四五六七八九十百]+)[)）])\s*/;

export function isReservedHeading(text) {
  return RESERVED_HEADINGS.has(String(text || '').trim());
}

export function stripHeadingOrdinal(text) {
  return String(text || '').trim().replace(ORDINAL_RE, '').trim();
}

export function parseSectionHeading(text) {
  const raw = String(text || '').trim();
  if (!raw) return { en: '', zh: '' };
  const parts = splitHeadingParts(raw);
  if (parts.length < 2) {
    return looksEnglish(raw) && !looksChinese(raw)
      ? { en: raw, zh: '' }
      : { en: '', zh: raw };
  }
  const [left, right] = parts;
  if (looksEnglish(left) && looksChinese(right)) return { en: left, zh: right };
  if (looksChinese(left) && looksEnglish(right)) return { en: right, zh: left };
  return { en: left, zh: right };
}

export function renderSectionHeadingCard({ index, en = '', zh = '' }) {
  const number = String(Math.max(1, Number(index) || 1)).padStart(2, '0');
  const english = String(en || '').trim();
  const chinese = String(zh || '').trim() || english;
  const showEnglish = Boolean(english && chinese && english !== chinese);
  const englishRow = showEnglish
    ? `<section data-zen-heading-en="true" style="font-family:'PingFang SC','PingFang TC',-apple-system,BlinkMacSystemFont,'Hiragino Sans GB','Microsoft YaHei',sans-serif;font-size:.78em;line-height:1.35;font-weight:400;color:#A3A3A3;letter-spacing:.01em;">${escapeHtml(english)}</section>`
    : '';
  const titleStyle = "font-family:'PingFang SC','PingFang TC',-apple-system,BlinkMacSystemFont,'Hiragino Sans GB','Microsoft YaHei',sans-serif;font-size:1.12em;line-height:1.45;font-weight:500;color:#222222;letter-spacing:.04em;";
  const titleMargin = showEnglish ? 'margin-top:.18em;' : '';
  return [
    '<section data-zen-section-heading="true" style="margin:1.8em 0 .85em;background:#FFFFFF;border:1px solid #E7E3DB;border-radius:1.05em;box-shadow:0 10px 22px rgba(28,28,28,.08);overflow:hidden;">',
    '<section data-zen-heading-bar="true" style="height:.38em;width:2.15em;margin:.58em 0 0 1.15em;background:#D4D0C8;border-radius:.1em;"></section>',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border:0;">',
    '<tr>',
    `<td width="18%" valign="top" style="width:18%;padding:.1em .15em .95em 1em;vertical-align:top;"><section data-zen-heading-index="true" style="font-family:Georgia,'Times New Roman',serif;font-size:1.85em;line-height:1;font-weight:400;color:#C4C0B8;letter-spacing:.02em;">${number}</section></td>`,
    `<td valign="top" style="padding:.12em 1.15em .95em .15em;vertical-align:top;">${englishRow}<section data-zen-heading-zh="true" style="${titleStyle}${titleMargin}">${escapeHtml(chinese)}</section></td>`,
    '</tr>',
    '</table>',
    '</section>',
  ].join('');
}

export function restyleSectionHeadings(html, { stripOrdinals = false } = {}) {
  const document = new JSDOM(`<body>${String(html || '')}</body>`).window.document;
  let index = 0;
  for (const heading of [...document.querySelectorAll('h2')]) {
    const raw = normalizeHeadingText(heading.textContent);
    if (!raw || isReservedHeading(raw)) continue;
    index += 1;
    const parsed = parseSectionHeading(raw);
    const en = stripOrdinals ? stripHeadingOrdinal(parsed.en) : parsed.en;
    const zh = stripOrdinals ? stripHeadingOrdinal(parsed.zh) : parsed.zh;
    heading.outerHTML = renderSectionHeadingCard({ index, en, zh });
  }
  return document.body.innerHTML;
}

function splitHeadingParts(text) {
  const separator = text.includes('｜') ? '｜' : (text.includes('|') ? '|' : '');
  if (!separator) return [text];
  const [left, ...rest] = text.split(separator);
  const right = rest.join(separator).trim();
  const start = left.trim();
  return right ? [start, right] : [start];
}

function looksEnglish(text) {
  const letters = String(text || '').replace(/[^A-Za-z\u00C0-\u024F]/g, '');
  const cjk = String(text || '').replace(/[^\u3400-\u9FFF]/g, '');
  return letters.length >= 2 && letters.length > cjk.length;
}

function looksChinese(text) {
  return /[\u3400-\u9FFF]/.test(String(text || ''));
}

function normalizeHeadingText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '\u0026amp;',
    '<': '\u0026lt;',
    '>': '\u0026gt;',
    '"': '\u0026quot;',
    "'": '\u0026#39;',
  }[char]));
}
