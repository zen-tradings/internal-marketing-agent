export const FIXED_DRAFT_TEMPLATE_IDS = Object.freeze({
  'wechat-draft': 'zen-wechat/zen-trading@4',
  'customerio-draft': 'zen-customerio/zen-research@1',
});

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
