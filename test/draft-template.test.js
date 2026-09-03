import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIXED_DRAFT_TEMPLATE_IDS,
  assertFixedDraftTemplate,
  assertRenderedTemplateMarker,
} from '../src/lib/draft-template.js';

test('固定模板注册表不可变且 mock 渠道豁免', () => {
  assert.equal(Object.isFrozen(FIXED_DRAFT_TEMPLATE_IDS), true);
  assert.equal(FIXED_DRAFT_TEMPLATE_IDS['wechat-draft'], 'zen-wechat/zen-trading@8');
  assert.equal(FIXED_DRAFT_TEMPLATE_IDS['wechat-opening-digest'], 'zen-wechat/zen-trading@9');
  assert.equal(FIXED_DRAFT_TEMPLATE_IDS['customerio-opening-digest'], 'zen-customerio/zen-research@8');
  assert.equal(assertFixedDraftTemplate('mock', {}), 'mock');
});

test('未登记渠道、错误模板或未锁定模板均拒绝发布', () => {
  assert.throws(
    () => assertFixedDraftTemplate('new-draft', { templateId: 'x', templateLocked: true }),
    /未登记固定模板/,
  );
  assert.throws(
    () => assertFixedDraftTemplate('wechat-draft', { templateId: 'x', templateLocked: true }),
    /未锁定模板/,
  );
  assert.throws(
    () => assertFixedDraftTemplate('wechat-draft', {
      templateId: FIXED_DRAFT_TEMPLATE_IDS['wechat-draft'],
      templateLocked: false,
    }),
    /未锁定模板/,
  );
});

test('邮件渲染结果必须携带登记的固定模板标识', () => {
  const id = FIXED_DRAFT_TEMPLATE_IDS['customerio-draft'];
  assert.equal(assertRenderedTemplateMarker(`<body data-zen-draft-template="${id}">`, id), true);
  assert.throws(() => assertRenderedTemplateMarker('<body>', id), /缺少固定模板标识/);
});
