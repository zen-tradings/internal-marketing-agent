import { FIXED_DRAFT_TEMPLATE_IDS } from './draft-template.js';

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
export const NEWSLETTER_TEMPLATE_ID = FIXED_DRAFT_TEMPLATE_IDS['customerio-draft'];
export const NEWSLETTER_COMPANY_ADDRESS = '700 Leahy St, Redwood City, CA 94061';

export function normalizeEdition(value = 'Vol. 1') {
  const raw = String(value || 'Vol. 1').trim();
  const match = raw.match(/^vol\.?\s*(\d+)$/i);
  return match ? `Vol. ${match[1]}` : raw;
}

export function parseNewsletterArticle(markdown, defaultEdition = 'Vol. 1') {
  const source = String(markdown || '');
  const match = source.match(FRONTMATTER_RE);
  const meta = {};
  if (match) {
    for (const line of match[1].split('\n')) {
      const pair = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (!pair) continue;
      meta[pair[1].toLowerCase()] = stripQuotes(pair[2].trim());
    }
  }
  const body = source.replace(FRONTMATTER_RE, '').trim();
  const title = meta.title || 'Untitled newsletter';
  const edition = normalizeEdition(meta.edition || defaultEdition);
  const subject = meta.subject || `Zen Research from Zen Trading · ${edition} | ${title}`;
  const preheader = (meta.preheader || plainText(body)).slice(0, 140);
  return { title, edition, subject, preheader, body };
}

export function renderNewsletterEmail(article, options = {}) {
  const siteUrl = safeUrl(options.siteUrl) || 'https://zentradings.com';
  const siteLabel = siteUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const feedbackUrl = safeUrl(options.feedbackUrl);
  const headerImageUrl = safeUrl(options.headerImageUrl);
  const contactEmail = safeEmail(options.contactEmail);
  const address = escapeHtml(NEWSLETTER_COMPANY_ADDRESS);
  const content = options.contentHtml || renderMarkdown(article.body);
  const unsubscribe = options.includeUnsubscribe === false
    ? ''
    : '<p style="margin:0 0 8px"><a href="{% unsubscribe_url %}" class="untracked" style="color:#173f43">Unsubscribe</a></p>';
  const feedback = renderFeedback({ feedbackUrl, contactEmail, edition: article.edition });
  // 开头品牌图:仅在配置了公开图片 URL 时渲染,顶部与卡片圆角对齐,自适应宽度。
  const headerImage = headerImageUrl
    ? `<tr><td style="padding:0"><img src="${escapeAttr(headerImageUrl)}" alt="Zen Research from Zen Trading" width="620" style="display:block;width:100%;max-width:620px;height:auto;border:0;border-top-left-radius:12px;border-top-right-radius:12px"></td></tr>`
    : '';
  // 页脚只保留公司信息(网址 + 邮件)与法律强制项(退订 + 实体地址)。
  const contact = contactEmail
    ? `<p style="margin:0 0 8px"><a href="${escapeAttr(siteUrl)}" style="color:#173f43">${escapeHtml(siteLabel)}</a> · <a href="mailto:${escapeAttr(contactEmail)}" style="color:#173f43">${escapeHtml(contactEmail)}</a></p>`
    : `<p style="margin:0 0 8px"><a href="${escapeAttr(siteUrl)}" style="color:#173f43">${escapeHtml(siteLabel)}</a></p>`;

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(article.subject)}</title>
  <style>
    @media screen and (max-width:640px) {
      .zen-email-shell { padding:8px 4px !important; }
      .zen-email-content { padding:20px 8px !important; }
      .zen-email-footer { padding:18px 8px !important; }
    }
  </style>
</head>
<body data-zen-draft-template="${NEWSLETTER_TEMPLATE_ID}" style="margin:0;background:#f0edeb;color:#08272b;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-weight:300">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(article.preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f0edeb"><tr><td class="zen-email-shell" align="center" style="padding:16px 6px">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#fffdf8;border:1px solid #dcd8d5;border-radius:12px">
      ${headerImage}
      <tr><td class="zen-email-content" style="padding:24px 16px">
        <p style="margin:0 0 14px;font-size:11px;letter-spacing:.12em;font-weight:600;color:#66787a">ZEN RESEARCH FROM ZEN TRADING · ${escapeHtml(article.edition.toUpperCase())}</p>
        <h1 style="margin:0 0 20px;font-size:24px;line-height:1.25;font-weight:500;color:#08272b">${escapeHtml(article.title)}</h1>
        <div style="font-size:14px;line-height:1.6;font-weight:300;color:#173f43">${content}</div>
        ${feedback}
      </td></tr>
      <tr><td class="zen-email-footer" style="padding:18px 16px;border-top:1px solid #dcd8d5;font-size:11px;line-height:1.6;font-weight:300;color:#66787a">
        ${contact}
        ${unsubscribe}
        <p style="margin:0">Zen Trading · ${address}</p>
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;
}

function renderFeedback({ feedbackUrl, contactEmail, edition }) {
  if (!feedbackUrl && !contactEmail) return '';
  const positive = feedbackUrl
    ? feedbackWebUrl(feedbackUrl, 'positive', edition)
    : feedbackMailto(contactEmail, 'satisfied', edition);
  const negative = feedbackUrl
    ? feedbackWebUrl(feedbackUrl, 'negative', edition)
    : feedbackMailto(contactEmail, 'not satisfied', edition);
  return `<div style="margin:26px 0 0;padding:18px 12px;border-top:1px solid #dcd8d5;text-align:center">
          <p style="margin:0 0 12px;font-size:13px;color:#66787a">Was this edition useful?</p>
          <a href="${escapeAttr(positive)}" style="display:inline-block;margin:0 5px;background:#08272b;color:#f7f4ec;text-decoration:none;padding:9px 15px;border-radius:999px;font-size:13px;font-weight:500">👍 Satisfied</a>
          <a href="${escapeAttr(negative)}" style="display:inline-block;margin:0 5px;background:#e7e3df;color:#173f43;text-decoration:none;padding:9px 15px;border-radius:999px;font-size:13px;font-weight:500">👎 Not satisfied</a>
        </div>`;
}

function feedbackWebUrl(base, rating, edition) {
  const url = new URL(base);
  url.searchParams.set('rating', rating);
  url.searchParams.set('edition', edition);
  return url.toString();
}

function feedbackMailto(email, rating, edition) {
  const subject = `Zen Research feedback: ${rating} (${edition})`;
  const body = `My rating: ${rating}\n\nWhat would make the next edition more useful?\n`;
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function renderMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let list = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p style="margin:0 0 18px">${inline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    out.push(`<ul style="margin:0 0 20px;padding-left:22px">${list.map((item) => `<li style="margin:0 0 8px">${inline(item)}</li>`).join('')}</ul>`);
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^(#{2,4})\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList();
      out.push(`<h2 style="margin:24px 0 10px;font-size:17px;line-height:1.35;font-weight:500;color:#08272b">${inline(heading[2])}</h2>`);
      continue;
    }
    const item = line.match(/^[-*]\s+(.+)$/);
    if (item) { flushParagraph(); list.push(item[1]); continue; }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return out.join('\n');
}

function inline(text) {
  const links = [];
  const source = String(text).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
    const token = `\uE000ZEN_LINK_${links.length}\uE001`;
    links.push(`<a href="${escapeAttr(url)}" style="color:#0b6d75">${escapeHtml(label)}</a>`);
    return token;
  });
  let value = escapeHtml(source);
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/`([^`]+)`/g, '<code style="background:#f0edeb;padding:1px 4px;border-radius:3px">$1</code>');
  value = value.replace(/\uE000ZEN_LINK_(\d+)\uE001/g, (_, index) => links[Number(index)] || '');
  return value;
}

function plainText(markdown) {
  return String(markdown || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*_`>-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch { return ''; }
}

function safeEmail(value) {
  const email = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function stripQuotes(value) {
  return value.replace(/^(['"])([\s\S]*)\1$/, '$2');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function escapeAttr(value) { return escapeHtml(value); }
