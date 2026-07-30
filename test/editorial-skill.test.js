import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EDITORIAL_ARCHETYPES,
  EDITORIAL_SKILL,
  buildEditorialEvidenceGuidance,
  buildEditorialWritingGuidance,
  extractMarkdownSection,
  loadEditorialSkill,
  normalizeEditorialBrief,
  routeEditorialArchetype,
} from '../src/lib/editorial-skill.js';

test('完整写作 skill 从仓库加载并生成稳定内容摘要', () => {
  const loadedAgain = loadEditorialSkill();
  assert.equal(EDITORIAL_SKILL.id, 'latepost-ai-writer');
  assert.match(EDITORIAL_SKILL.digest, /^[a-f0-9]{64}$/);
  assert.equal(loadedAgain.digest, EDITORIAL_SKILL.digest);
  assert.deepEqual(Object.keys(EDITORIAL_SKILL.archetypes), [...EDITORIAL_ARCHETYPES]);
  assert.match(EDITORIAL_SKILL.coreMethod, /^## 完整工作流/);
  assert.match(EDITORIAL_SKILL.qualityChecklist, /^## 发布阻断项/);
});

test('skill 缺失或章节损坏时快速失败，不静默降级', () => {
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-editorial-skill-'));
  assert.throws(
    () => loadEditorialSkill(missingRoot),
    /无法读取写作 skill/,
  );
  assert.throws(
    () => extractMarkdownSection('# 文档\n\n## 其它\n内容', '完整工作流'),
    /缺少章节/,
  );
});

test('稿型路由限制在八种白名单，无效模型结果使用确定性回退', () => {
  assert.equal(routeEditorialArchetype('实测一款新的 AI Agent 产品'), '产品实测');
  assert.equal(routeEditorialArchetype('对话一家 AI 创业公司的创始人'), 'AI 创业访谈');
  assert.equal(routeEditorialArchetype('解释 Transformer 推理架构如何工作'), '技术解释');
  const fallback = normalizeEditorialBrief({
    archetype: '自创稿型',
    angle: '证据支持的局部变化',
  }, {
    input: '分析一家公司的变化',
    workflowId: 'company',
  });
  assert.equal(fallback.archetype, '公司与产业深描');
  assert.equal(fallback.routing_source, 'deterministic-fallback');
  assert.equal(fallback.angle, '证据支持的局部变化');
});

test('运行时只注入方法、选定稿型和内部检查，不注入 skill 默认交付格式', () => {
  const brief = normalizeEditorialBrief({
    archetype: '产品实测',
    angle: '一次成功演示仍未证明稳定能力',
    tension: '演示速度与真实失败恢复之间存在落差',
    ending_constraint: '部署成本和人工介入仍待验证',
  });
  const guidance = buildEditorialWritingGuidance(brief, { userSpecifiedStructure: true });
  assert.match(guidance, /一次成功演示仍未证明稳定能力/);
  assert.match(guidance, /用户已经指定结构/);
  assert.match(guidance, /## 产品实测/);
  assert.match(guidance, /## 发布阻断项/);
  assert.doesNotMatch(guidance, /标题备选 3 条/);
  assert.doesNotMatch(guidance, /## 默认编辑说明/);
  assert.match(guidance, /不得声称本文代表《晚点》/);
});

test('证据编辑说明要求先完成证据判断，再选择受控稿型和角度', () => {
  const guidance = buildEditorialEvidenceGuidance();
  assert.match(guidance, /在完成来源评估和需求覆盖判断之后/);
  for (const archetype of EDITORIAL_ARCHETYPES) {
    assert.match(guidance, new RegExp(archetype.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
