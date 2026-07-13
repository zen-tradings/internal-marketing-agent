const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

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
  const subject = meta.subject || `Zen Trading Newsletter · ${edition} | ${title}`;
  const preheader = (meta.preheader || plainText(body)).slice(0, 140);
  return { title, edition, subject, preheader, body };
}

export function renderNewsletterEmail(article, options = {}) {
  const siteUrl = safeUrl(options.siteUrl) || 'https://zentradings.com';
  const feedbackUrl = safeUrl(options.feedbackUrl);
  const address = escapeHtml(options.companyAddress || 'Company address required before sending');
  const content = renderMarkdown(article.body);
  const feedback = feedbackUrl
    ? `<p style="margin:28px 0 0;text-align:center"><a href="${escapeAttr(feedbackUrl)}" style="display:inline-block;background:#08272b;color:#f7f4ec;text-decoration:none;padding:12px 20px;border-radius:999px;font-weight:600">Share feedback</a></p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(article.subject)}</title></head>
<body style="margin:0;background:#f0edeb;color:#08272b;font-family:Arial,Helvetica,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(article.preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f0edeb"><tr><td align="center" style="padding:24px 12px">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#fffdf8;border:1px solid #dcd8d5;border-radius:12px">
      <tr><td style="padding:32px">
        <p style="margin:0 0 18px;font-size:13px;letter-spacing:.14em;font-weight:700;color:#66787a">ZEN TRADING NEWSLETTER · ${escapeHtml(article.edition.toUpperCase())}</p>
        <h1 style="margin:0 0 28px;font-size:32px;line-height:1.16;color:#08272b">${escapeHtml(article.title)}</h1>
        <div style="font-size:16px;line-height:1.65;color:#173f43">${content}</div>
        ${feedback}
      </td></tr>
      <tr><td style="padding:24px 32px;border-top:1px solid #dcd8d5;font-size:12px;line-height:1.6;color:#66787a">
        <p style="margin:0 0 8px">You're receiving this because you subscribed at <a href="${escapeAttr(siteUrl)}" style="color:#173f43">zentradings.com</a>. Research commentary only, not investment advice.</p>
        <p style="margin:0 0 8px"><a href="{% unsubscribe_url %}" class="untracked" style="color:#173f43">Unsubscribe</a></p>
        <p style="margin:0">Zen Trading · ${address}</p>
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;
}

function renderMarkdown(markdown) {
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
      out.push(`<h2 style="margin:30px 0 12px;font-size:22px;line-height:1.3;color:#08272b">${inline(heading[2])}</h2>`);
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
  let value = escapeHtml(text);
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${escapeAttr(url)}" style="color:#0b6d75">${label}</a>`);
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/`([^`]+)`/g, '<code style="background:#f0edeb;padding:1px 4px;border-radius:3px">$1</code>');
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

function stripQuotes(value) {
  return value.replace(/^(['"])([\s\S]*)\1$/, '$2');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function escapeAttr(value) { return escapeHtml(value); }
