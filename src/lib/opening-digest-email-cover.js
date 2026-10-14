import { FIXED_DRAFT_TEMPLATE_IDS } from './draft-template.js';
import { assertDateKey, renderCanvasCover } from './opening-digest-canvas-cover.js';
import { OPENING_DIGEST_HEADLINE_HARD_MAX_CHARS } from './opening-digest-editorial.js';
import { chromium } from 'playwright-core';

export const EMAIL_OPENING_COVER_SCALE = 2;
export const EMAIL_OPENING_COVER_WIDTH = 900 * EMAIL_OPENING_COVER_SCALE;
export const EMAIL_OPENING_COVER_HEIGHT = 383 * EMAIL_OPENING_COVER_SCALE;
export const EMAIL_OPENING_COVER_SECTION = 'DAILY BRIEF';
export const EMAIL_OPENING_COVER_TAGS = 'TREASURY YIELDS · SOFTWARE · MARKET SIGNALS';
export const OPENING_DIGEST_EN_SAFE_HEADLINE = 'Opening signals stay mixed';
const CACHE_NAMES = { png: 'opening-digest-email-cover.png', json: 'opening-digest-email-cover.json' };
const dimensions = { width: EMAIL_OPENING_COVER_WIDTH, height: EMAIL_OPENING_COVER_HEIGHT, label: '邮件封面' };

export function normalizeOpeningDigestEmailHeadline(headline) {
  const candidate = String(headline || '').trim();
  return candidate && candidate.length <= OPENING_DIGEST_HEADLINE_HARD_MAX_CHARS && !/[\r\n\u0000-\u001f]/.test(candidate)
    ? candidate : OPENING_DIGEST_EN_SAFE_HEADLINE;
}

export function openingDigestEmailCoverData({ dateKey, headline }) {
  assertDateKey(dateKey, '邮件封面日期无效');
  return {
    publish_date: dateKey,
    section: EMAIL_OPENING_COVER_SECTION,
    cover_keywords: [normalizeOpeningDigestEmailHeadline(headline)],
    english_tags: EMAIL_OPENING_COVER_TAGS.split(' · '),
    scale: EMAIL_OPENING_COVER_SCALE,
  };
}

// Renders the English email cover with the same Canvas artwork as the WeChat
// draft cover. If the live English headline cannot fit the safe headline width
// even at the minimum font size, the renderer retries once with the fixed
// English fallback headline; a failing fallback render propagates so the
// channel degrades to the no-cover edition.
export async function renderOpeningDigestEmailCover({
  dateKey, headline, executablePath, timeoutMs = 30000, cacheDir,
}, { browserType = chromium, loadAssets } = {}) {
  const data = openingDigestEmailCoverData({ dateKey, headline });
  try {
    return await renderEmailCoverData(data, { executablePath, timeoutMs, cacheDir }, { browserType, loadAssets });
  } catch (error) {
    if (!/封面标题超出安全宽度/.test(String(error?.message)) || data.cover_keywords[0] === OPENING_DIGEST_EN_SAFE_HEADLINE) throw error;
    const fallback = { ...data, cover_keywords: [OPENING_DIGEST_EN_SAFE_HEADLINE] };
    return renderEmailCoverData(fallback, { executablePath, timeoutMs, cacheDir }, { browserType, loadAssets });
  }
}

async function renderEmailCoverData(data, options, dependencies) {
  return renderCanvasCover({
    data,
    marker: FIXED_DRAFT_TEMPLATE_IDS['customerio-opening-digest'],
    cacheNames: CACHE_NAMES,
    dims: dimensions,
    errorLabel: 'Opening Digest 邮件封面',
    ...options,
  }, dependencies);
}
