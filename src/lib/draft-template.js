export const FIXED_DRAFT_TEMPLATE_IDS = Object.freeze({
  'wechat-draft': 'zen-wechat/zen-trading@6',
  'wechat-opening-digest': 'zen-wechat/zen-trading@7',
  'customerio-draft': 'zen-customerio/zen-research@5',
  'customerio-opening-digest': 'zen-customerio/zen-research@7',
});

// Fixed community invite shown at the bottom of every Opening Digest draft.
// The email renders it as a hyperlink; WeChat forbids off-site hrefs, so the
// Chinese draft shows the same URL as plain text. Both renderers must use this
// single constant.
export const OPENING_DIGEST_DISCORD_INVITE_URL = 'https://discord.gg/EtNErjaN8';

export function assertFixedDraftTemplate(channelId, channel) {
  if (channelId === 'mock') return 'mock';
  const expected = FIXED_DRAFT_TEMPLATE_IDS[channelId];
  if (!expected) {
    throw templateError(`真实草稿渠道 ${channelId || '(empty)'} 未登记固定模板，拒绝发布`);
  }
  if (channel?.templateId !== expected || channel?.templateLocked !== true) {
    throw templateError(
      `草稿渠道 ${channelId} 未锁定模板 ${expected}，拒绝发布`,
    );
  }
  return expected;
}

export function assertRenderedTemplateMarker(html, templateId) {
  const marker = `data-zen-draft-template="${templateId}"`;
  if (!String(html || '').includes(marker)) {
    throw templateError(`渲染结果缺少固定模板标识 ${templateId}`);
  }
  return true;
}

function templateError(message) {
  const error = new Error(message);
  error.stage = 'render';
  return error;
}
