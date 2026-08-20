import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { createWechatClient } from '@wenyan-md/core/wechat';
import { defaultHttpAdapter } from '@wenyan-md/core/http';
import { FIXED_DRAFT_TEMPLATE_IDS, OPENING_DIGEST_DISCORD_INVITE_URL } from '../lib/draft-template.js';
import { fetchWithTimeout } from '../lib/http-timeout.js';
import { renderOpeningDigestCover } from '../lib/opening-digest-cover.js';
import { translationMap } from '../lib/opening-digest-translation.js';
import { withRuntimeResource } from '../config/runtime.js';

export const WECHAT_OPENING_DIGEST_TEMPLATE_ID = FIXED_DRAFT_TEMPLATE_IDS['wechat-opening-digest'];
export const WECHAT_DRAFT_MAX_CHARS = 20000;
export const WECHAT_DRAFT_MAX_BYTES = 1024 * 1024;

export function makeWechatOpeningDigestChannel({
  renderCover = renderOpeningDigestCover,
  api,
} = {}) {
  const coverCache = new Map();
  const bodyImageCache = new Map();
  return {
    id: 'wechat-opening-digest',
    templateId: WECHAT_OPENING_DIGEST_TEMPLATE_ID,
    templateLocked: true,
    async publish({ payload, translation, config, acceptance = false }) {
      const activeApi = api || createWechatApi({ timeoutMs: config.wechat.timeoutMs });
      const title = acceptance ? `[测试] Zen 开市日报 · ${payload.dateKey.slice(5)}` : `Zen Research日报 · ${payload.dateKey}`;
      const cover = await renderCover({
        dateLabel: chineseDate(payload.dateKey), label: '开市日报',
        executablePath: config.openingDigest.browserExecutablePath,
        timeoutMs: config.openingDigest.captureTimeoutMs,
      });
      return withRuntimeResource('wechat-write', async () => {
      const coverHash = crypto.createHash('sha256').update(cover).digest('hex');
      const token = await activeApi.getAccessToken(config.wechat.appId, config.wechat.appSecret);
      let coverAsset = coverCache.get(coverHash);
      if (!coverAsset) {
        coverAsset = await activeApi.uploadMaterial(token, cover, `zen-opening-digest-${payload.dateKey}.png`);
        coverCache.set(coverHash, coverAsset);
      }
      const images = await uploadBodyImages(activeApi, token, config.assets, bodyImageCache);
      const html = renderWechatOpeningDigestHtml({ payload, translation, images });
      const digest = translationMap(translation).get('preheader')?.text || '';
      assertWechatLimits(html, { title, digest });
      const attempts = [];
      let final;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const created = await activeApi.addDraft(token, { title, digest, content: html, thumbMediaId: coverAsset.media_id });
        const mediaId = String(created?.media_id || '');
        if (!mediaId) throw wechatError(`微信 draft/add 未返回 media_id:${JSON.stringify(created)}`);
        let saved;
        try {
          saved = await activeApi.getDraft(token, mediaId);
        } catch (error) {
          attempts.push({ attempt, mediaId, status: 'unverified', errors: [error.message] });
          final = { mediaId, title, status: 'unverified', errors: [`微信 draft/get 暂不可用:${error.message}`] };
          break;
        }
        const validation = validateWechatOpeningDigestDraft(saved, { title, payload, translation });
        attempts.push({ attempt, mediaId, status: validation.ok ? 'verified' : 'invalid', errors: validation.errors });
        final = { mediaId, title, status: validation.ok ? 'verified' : 'invalid', errors: validation.errors };
        if (validation.ok) break;
        if (attempt < 3) {
          try {
            await activeApi.deleteDraft(token, mediaId);
            attempts.at(-1).deleted = true;
          } catch (error) {
            attempts.at(-1).status = 'unverified';
            attempts.at(-1).errors.push(`微信 draft/delete 失败:${error.message}`);
            final = { mediaId, title, status: 'unverified', errors: attempts.at(-1).errors };
            break;
          }
        }
      }
      return { ...final, htmlChars: html.length, htmlBytes: Buffer.byteLength(html), attempts };
      });
    },
  };
}

export function renderWechatOpeningDigestHtml({ payload, translation, images = {} }) {
  const translated = translationMap(translation);
  const bodyBlocks = renderNarrative(payload.article.body, translated);
  const metrics = renderMetrics(payload.metrics || [], translated);
  const options = payload.options ? renderOptions(payload.options, translated) : '';
  // WeChat forbids off-site hrefs, so the fixed Discord invite is plain text.
  // It sits below the body (after the OIC block when present) and above the
  // survey/QR tail images so the fixed tail images still close the article.
  const discord = `<p data-zen-section="discord" style="margin:20px 0 0;padding-top:16px;border-top:1px solid #e4e0dc;font-size:13px;color:#66787a">加入 Zen Discord 社区：${escapeHtml(OPENING_DIGEST_DISCORD_INVITE_URL)}</p>`;
  const image = (src, role) => src ? `<p data-zen-role="${role}" style="margin:0"><img src="${escapeAttr(src)}" style="display:block;width:100%;height:auto" alt=""></p>` : '';
  return `<section data-zen-draft-template="${WECHAT_OPENING_DIGEST_TEMPLATE_ID}" style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#173f43;font-size:15px;line-height:1.75;word-break:break-word">${image(images.header, 'header')}<h2 data-zen-section="market" style="margin:22px 0 9px;font-size:18px;color:#08272b">市场快照</h2>${metrics}${bodyBlocks}${options}${discord}${image(images.survey, 'survey')}${image(images.footer, 'footer')}</section>`;
}

export function validateWechatOpeningDigestDraft(saved, { title, payload, translation }) {
  const article = saved?.content?.news_item?.[0] || saved?.news_item?.[0] || saved?.articles?.[0];
  const errors = [];
  if (!article) return { ok: false, errors: ['回读缺少首篇文章'] };
  const translated = translationMap(translation);
  if (String(article.title || '') !== title) errors.push(`标题:期望“${title}”，实际“${article.title || ''}”`);
  const expectedDigest = translationMap(translation).get('preheader')?.text || '';
  if (expectedDigest && String(article.digest || '') !== expectedDigest) errors.push(`摘要:期望“${expectedDigest}”，实际“${article.digest || ''}”`);
  const document = new JSDOM(`<body>${article.content || ''}</body>`).window.document;
  const expectedSections = ['市场快照', ...translation.translations.filter((item) => item.kind === 'heading').map((item) => stripInlineMarkdown(item.text)), ...(payload.options ? ['期权成交量趋势'] : [])];
  const sectionOrder = [...document.querySelectorAll('h2')].map((node) => normalizeText(node.textContent));
  if (sectionOrder.join('|') !== expectedSections.join('|')) errors.push(`区块顺序:期望 ${expectedSections.join('→')}，实际 ${sectionOrder.join('→')}`);
  const marketTable = document.querySelector('[data-zen-market-grid]')
    || [...document.querySelectorAll('table')].find((table) => table.querySelectorAll('td').length === 9);
  const metricCells = marketTable ? [...marketTable.querySelectorAll('td')] : [];
  if (metricCells.length !== 9) errors.push(`行情格:期望 9，实际 ${metricCells.length}`);
  (payload.metrics || []).forEach((metric, index) => {
    const node = document.querySelector(`[data-metric="${cssEscape(metric.label)}"]`) || metricCells[index];
    const expected = metricStrings(metric);
    if (!node) errors.push(`行情 ${metric.label}:缺失`);
    else expected.forEach((value) => { if (value && !node.textContent.includes(value)) errors.push(`行情 ${metric.label}:缺少 ${value}`); });
  });
  const oicTable = document.querySelector('[data-zen-oic]')
    || [...document.querySelectorAll('table')].find((table) => table.querySelectorAll('tbody').length === 20 || table.querySelectorAll('tr').length === 40);
  const rows = oicTable ? [...oicTable.querySelectorAll('[data-oic-rank],tbody')].filter((node, index, all) => all.indexOf(node) === index) : [];
  if (payload.options && rows.length !== 20) errors.push(`OIC 记录:期望 20，实际 ${rows.length}`);
  payload.options?.data.rows.forEach((source, rowIndex) => {
    const rank = String(source[0]); const group = document.querySelector(`[data-oic-rank="${cssEscape(rank)}"]`) || rows[rowIndex];
    if (!group) { errors.push(`OIC Rank ${rank}:缺失`); return; }
    const values = [rank, source[1], translationMap(translation).get(`oic-company-${rank}`)?.text, ...source.slice(3)].map(String);
    values.forEach((value, index) => { if (!group.textContent.includes(value)) errors.push(`OIC ${source[1]} 字段 ${index + 1}:缺少 ${value}`); });
  });
  if (payload.options) {
    const optionText = document.querySelector('[data-zen-section="options"]')?.parentElement?.textContent || document.body.textContent;
    for (const [label, value] of [
      ['OIC 时点', translated.get('oic-asof')?.text],
      ['OIC 来源', translated.get('oic-attribution')?.text],
      ['OIC 采集时间', formatCapturedAt(payload.options.capturedAt)],
      ['OIC 机构', 'OCC/OIC'],
    ]) if (value && !optionText.includes(value)) errors.push(`${label}:缺少 ${value}`);
  }
  let contentCursor = 0;
  const fullText = normalizeText(document.body.textContent);
  for (const unit of translation.translations.filter((item) => item.id.startsWith('body-'))) {
    const node = document.querySelector(`[data-block-id="${cssEscape(unit.id)}"]`);
    const visible = normalizedBodyText(unit);
    if (node && !normalizedBodyText(unit, node.textContent).includes(visible)) errors.push(`正文块 ${unit.id}:内容被改写`);
    else if (!node) {
      const index = fullText.indexOf(visible, contentCursor);
      if (index < 0) errors.push(`正文块 ${unit.id}:缺失或乱序`);
      else contentCursor = index + visible.length;
    }
  }
  for (const unit of translation.translations.filter((item) => item.id.startsWith('metric-note-'))) {
    const node = document.querySelector(`[data-block-id="${cssEscape(unit.id)}"]`);
    const visible = normalizeText(stripInlineMarkdown(unit.text));
    if (node ? !normalizeText(node.textContent).includes(visible) : !fullText.includes(visible)) {
      errors.push(`行情说明块 ${unit.id}:缺失或被改写`);
    }
  }
  const discordNode = document.querySelector('[data-zen-section="discord"]');
  if (!discordNode || !discordNode.textContent.includes(OPENING_DIGEST_DISCORD_INVITE_URL)) {
    errors.push('Discord 社群链接缺失或被改写');
  } else {
    const surveyImage = document.querySelector('[data-zen-role="survey"]');
    if (surveyImage && !(discordNode.compareDocumentPosition(surveyImage) & 4)) errors.push('Discord 链接必须位于问卷图之前');
    if (discordNode.querySelector('a')) errors.push('Discord 链接必须为纯文本，不得带 href');
  }
  const images = [...document.querySelectorAll('img')];
  if (images.length < 3) errors.push(`固定图片:期望至少 3，实际 ${images.length}`);
  if (!translated.size) errors.push('译文映射为空');
  return { ok: errors.length === 0, errors };
}

function renderMetrics(metrics, translated) {
  const cells = metrics.map((metric) => {
    const values = metricStrings(metric);
    return `<td data-metric="${escapeAttr(metric.label)}" width="33.33%" style="width:33.33%;padding:7px 5px;border:1px solid #e4e0dc;vertical-align:top"><span style="display:block;font-size:10px;color:#66787a">${escapeHtml(metric.label)}</span><b style="display:block;font-size:15px;color:#08272b">${escapeHtml(values[0])}</b>${values[1] ? `<span style="font-size:11px;color:${metric.changePct >= 0 ? '#167a45' : '#b42318'}">${escapeHtml(values[1])}</span>` : ''}</td>`;
  });
  const rows = []; for (let index = 0; index < cells.length; index += 3) rows.push(`<tr>${cells.slice(index, index + 3).join('')}</tr>`);
  const notes = [...new Set(metrics.map((metric) => metric.sourceNote).filter(Boolean))];
  const noteHtml = notes.map((note, index) => `<p data-block-id="metric-note-${index + 1}" style="margin:6px 0;font-size:11px;color:#66787a">${inlineMarkup(translated.get(`metric-note-${index + 1}`)?.text || note)}</p>`).join('');
  return `<table data-zen-market-grid role="presentation" width="100%" style="width:100%;border-collapse:collapse;table-layout:fixed">${rows.join('')}</table>${noteHtml}`;
}

function renderNarrative(markdown, translated) {
  const lines = String(markdown || '').split(/\r?\n/).filter((line) => line.trim());
  let section = '';
  const parts = [];
  lines.forEach((line, index) => {
    const id = `body-${index + 1}`; const unit = translated.get(id); if (!unit) return;
    const heading = /^#{1,6}\s+/.test(line); const list = /^\s*[-*+]\s+/.test(line);
    if (heading) {
      section = unit.source === 'Earnings ahead' ? 'earnings'
        : unit.source === "Today's catalysts" ? 'catalysts'
          : unit.source === 'Market read' ? 'read' : `body-${index + 1}`;
      parts.push(`<h2 data-zen-section="${section}" data-block-id="${id}" style="margin:22px 0 9px;font-size:18px;color:#08272b">${inlineMarkup(unit.text)}</h2>`);
    } else if (list) parts.push(`<p data-block-id="${id}" style="margin:6px 0 6px 1em;text-indent:-1em">• ${inlineMarkup(unit.text)}</p>`);
    else if (section === 'earnings') parts.push(renderEarningsPreviewLines(id, unit.text));
    else parts.push(`<p data-block-id="${id}" style="margin:8px 0">${inlineMarkup(unit.text)}</p>`);
  });
  return parts.join('');
}

function renderEarningsPreviewLines(id, text) {
  // The schedule remains one deterministic translation unit, but each linked
  // ticker starts its own visual row in the WeChat draft. Keep the separator
  // with the preceding row so readback validation still sees the exact text.
  const rows = String(text || '').split(/(?<=[;；])(?=\s*\[[A-Z0-9.-]+\]\(https?:\/\/)/);
  if (rows.length === 1) return `<p data-block-id="${id}" style="margin:8px 0">${inlineMarkup(text)}</p>`;
  return `<div data-block-id="${id}" data-zen-earnings-rows="${rows.length}">${rows.map((row) => `<p style="margin:6px 0">${inlineMarkup(row)}</p>`).join(' ')}</div>`;
}

function renderOptions(options, translated) {
  const rows = options.data.rows.map((row, index) => {
    const [rank, ticker, , call, put, total, ivx, change] = row;
    const company = translated.get(`oic-company-${index + 1}`)?.text || row[2];
    const bg = index % 2 ? '#fffdf8' : '#f7f4ec';
    return `<tbody data-oic-rank="${escapeAttr(rank)}"><tr bgcolor="${bg}"><th rowspan="2" width="9%">${escapeHtml(rank)}</th><th colspan="2" width="51%" align="left">${escapeHtml(ticker)}<small style="display:block;font-weight:400;line-height:1.3">${escapeHtml(company)}</small></th><td colspan="2" width="40%" align="right"><small style="display:block;color:#66787a">期权总成交量</small>${escapeHtml(total)}</td></tr><tr bgcolor="${bg}"><td><small>看涨</small><br>${escapeHtml(call)}</td><td><small>看跌</small><br>${escapeHtml(put)}</td><td><small>IVX 30</small><br>${escapeHtml(ivx)}</td><td><small>IVX 变化</small><br>${escapeHtml(change)}</td></tr></tbody>`;
  }).join('');
  const asOf = translated.get('oic-asof')?.text || options.data.asOf;
  const attribution = translated.get('oic-attribution')?.text || options.data.attribution;
  return `<h2 data-zen-section="options" style="margin:22px 0 9px;font-size:18px;color:#08272b">期权成交量趋势</h2><p data-block-id="oic-asof" style="margin:0 0 7px;font-size:11px;color:#66787a">${inlineMarkup(asOf)}</p><table data-zen-oic width="100%" cellpadding="4" style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:10px;line-height:1.35;border:1px solid #ddd">${rows}</table><p style="margin:7px 0 18px;font-size:11px;color:#66787a">来源：OCC/OIC · ${inlineMarkup(attribution)} · 数据延迟 20 分钟 · ${escapeHtml(formatCapturedAt(options.capturedAt))}</p>`;
}

export function createWechatApi({ fetchFn = globalThis.fetch, timeoutMs = 30000 } = {}) {
  const boundedFetch = (resource, options) => fetchWithTimeout(fetchFn, resource, options, {
    timeoutMs,
    label: '微信 API',
  });
  const client = createWechatClient({ ...defaultHttpAdapter, fetch: boundedFetch });
  return {
    async getAccessToken(appId, appSecret) { return (await client.fetchAccessToken(appId, appSecret)).access_token; },
    async uploadMaterial(token, buffer, filename) { return client.uploadMaterial('image', new Blob([buffer]), filename, token); },
    async uploadContentImage(token, buffer, filename) {
      const form = new FormData(); form.append('media', new Blob([buffer]), filename);
      const response = await boundedFetch(`https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token=${token}`, { method: 'POST', body: form });
      const data = await response.json(); if (!response.ok || data.errcode || !data.url) throw wechatError(`微信正文图片上传失败:${JSON.stringify(data)}`); return data.url;
    },
    async addDraft(token, input) { return client.publishArticle(token, { title: input.title, digest: input.digest, content: input.content, thumb_media_id: input.thumbMediaId, show_cover_pic: 0, need_open_comment: 0, only_fans_can_comment: 0 }); },
    async getDraft(token, mediaId) { return client.getDraft(token, mediaId); },
    async deleteDraft(token, mediaId) {
      const response = await boundedFetch(`https://api.weixin.qq.com/cgi-bin/draft/delete?access_token=${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ media_id: mediaId }) });
      const data = await response.json(); if (!response.ok || data.errcode) throw wechatError(`微信 draft/delete 失败:${JSON.stringify(data)}`); return data;
    },
  };
}

async function uploadBodyImages(api, token, assets, cache = new Map()) {
  const result = {};
  for (const [key, filename] of [['header', assets.headerImage], ['survey', assets.surveyImage], ['footer', assets.footerImage]]) {
    const buffer = await fs.readFile(filename);
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    if (!cache.has(hash)) {
      const uploaded = path.extname(filename).toLowerCase() === '.gif'
        ? await api.uploadMaterial(token, buffer, path.basename(filename))
        : { url: await api.uploadContentImage(token, buffer, path.basename(filename)) };
      cache.set(hash, uploaded.url);
    }
    result[key] = cache.get(hash);
  }
  return result;
}

function assertWechatLimits(html, { title = '', digest = '' } = {}) {
  if ([...title].length > 32) throw wechatError(`微信标题超过 32 字:${[...title].length}`);
  if ([...digest].length > 120) throw wechatError(`微信摘要超过 120 字:${[...digest].length}`);
  if (html.length >= WECHAT_DRAFT_MAX_CHARS) throw wechatError(`微信正文超过 20,000 字符:${html.length}`);
  if (Buffer.byteLength(html) >= WECHAT_DRAFT_MAX_BYTES) throw wechatError(`微信正文超过 1MB:${Buffer.byteLength(html)}`);
}
function metricStrings(metric) {
  if (metric.unavailable || !Number.isFinite(metric.value)) return ['—', ''];
  const digits = /UST|VIX/.test(metric.label) ? 2 : metric.value >= 1000 ? 0 : 2;
  const value = Number(metric.value).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits });
  const change = Number.isFinite(metric.changePct) ? `${metric.changePct >= 0 ? '+' : ''}${metric.changePct.toFixed(2)}%` : '';
  return [value, change];
}
function inlineMarkup(value) { return escapeHtml(stripOpeningDigestSourceLinks(value)).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>'); }
function stripOpeningDigestSourceLinks(value) {
  return String(value || '')
    // Parenthetical links are source citations rather than sentence content in
    // the Opening Digest contract. Remove both the publisher label and URL.
    .replace(/[\uff08(]\s*\[([^\]]+)]\(((?:https?:\/\/|mailto:)(?:[^()\s]|\([^()\s]*\))+)\)\s*[)\uff09]/gi, '')
    // A linked headline, company, or ticker can carry sentence meaning. Keep its
    // visible label as plain text while removing the off-site destination.
    .replace(/\[([^\]]+)]\(((?:https?:\/\/|mailto:)(?:[^()\s]|\([^()\s]*\))+)\)/gi, '$1')
    .replace(/<(?:https?:\/\/|mailto:)[^>\s]+>/gi, '')
    .replace(/(?:https?:\/\/|mailto:)[^\s<>"'\uff0c\u3002\uff1b\uff01\uff1f)\uff09]+/gi, '')
    .replace(/[ \t]+([,.;:!?\uff0c\u3002\uff1b\uff1a\uff01\uff1f])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
function stripInlineMarkdown(value) { return stripOpeningDigestSourceLinks(value).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1'); }
function normalizeText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function normalizedBodyText(unit, value = unit.text) {
  const text = normalizeText(stripInlineMarkdown(value));
  // WeChat can remove source whitespace between adjacent block paragraphs. For
  // an earnings row, that is only the separator before the next ticker; keep
  // the readback comparison strict for every other character.
  return /(?:before open|after close|timing not supplied)/i.test(String(unit.source || ''))
    ? text.replace(/([；;])\s+(?=[A-Z][A-Z0-9.-]{0,9}\b)/g, '$1')
    : text;
}
function formatCapturedAt(value) { try { return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); } catch { return String(value || ''); } }
function chineseDate(dateKey) { const [year, month, day] = dateKey.split('-'); return `${year}年${Number(month)}月${Number(day)}日`; }
function cssEscape(value) { return String(value).replace(/["\\]/g, '\\$&'); }
function escapeAttr(value) { return escapeHtml(value); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
function wechatError(message) { const error = new Error(message); error.stage = 'publish'; return error; }
