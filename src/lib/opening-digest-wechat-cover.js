import { FIXED_DRAFT_TEMPLATE_IDS } from './draft-template.js';
import {
  assertDateKey, renderCanvasCover,
} from './opening-digest-canvas-cover.js';
import { OPENING_DIGEST_SAFE_HEADLINE, OPENING_DIGEST_ZH_HEADLINE_MAX_CHARS } from './opening-digest-translation.js';
import { chromium } from 'playwright-core';

export const WECHAT_OPENING_COVER_WIDTH = 900;
export const WECHAT_OPENING_COVER_HEIGHT = 383;
export const WECHAT_OPENING_COVER_SECTION = '开市日报 · DAILY BRIEF';
export const WECHAT_OPENING_COVER_TAGS = 'TREASURY YIELDS · SOFTWARE · MARKET SIGNALS';
const CACHE_NAMES = { png: 'opening-digest-wechat-cover.png', json: 'opening-digest-wechat-cover.json' };
const dimensions = { width: WECHAT_OPENING_COVER_WIDTH, height: WECHAT_OPENING_COVER_HEIGHT, label: '微信日报封面' };

export function normalizeOpeningDigestWechatHeadline(headline) {
  const candidate = String(headline || '').trim();
  return candidate && [...candidate].length <= OPENING_DIGEST_ZH_HEADLINE_MAX_CHARS && !/[\r\n\u0000-\u001f]/.test(candidate)
    ? candidate : OPENING_DIGEST_SAFE_HEADLINE;
}

export function openingDigestWechatCoverData({ dateKey, headline }) {
  assertDateKey(dateKey, '微信日报封面日期无效');
  return {
    publish_date: dateKey,
    section: WECHAT_OPENING_COVER_SECTION,
    cover_keywords: [normalizeOpeningDigestWechatHeadline(headline)],
    english_tags: WECHAT_OPENING_COVER_TAGS.split(' · '),
  };
}

export async function renderOpeningDigestWechatCover({
  dateKey, headline, executablePath, timeoutMs = 30000, cacheDir,
}, { browserType = chromium, loadAssets } = {}) {
  const data = openingDigestWechatCoverData({ dateKey, headline });
  return renderCanvasCover({
    data,
    marker: FIXED_DRAFT_TEMPLATE_IDS['wechat-opening-digest'],
    cacheNames: CACHE_NAMES,
    dims: dimensions,
    errorLabel: '微信日报封面',
    executablePath,
    timeoutMs,
    cacheDir,
  }, { browserType, loadAssets });
}
