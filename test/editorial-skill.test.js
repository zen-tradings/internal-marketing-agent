import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EDITORIAL_ARCHETYPES,
  EDITORIAL_SKILL,
  MACRO_EDITORIAL_ARCHETYPES,
  MACRO_EDITORIAL_SKILL,
  buildEditorialEvidenceGuidance,
  buildEditorialWritingGuidance,
  buildMacroEditorialEvidenceGuidance,
  buildMacroEditorialWritingGuidance,
  extractMarkdownSection,
  loadEditorialSkill,
  loadMacroEditorialSkill,
  normalizeMacroEditorialBrief,
  normalizeEditorialBrief,
  routeMacroEditorialArchetype,
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

test('宏观写作 skill 加载三类稿型、方法、审计清单和可追溯样本索引', () => {
  const loadedAgain = loadMacroEditorialSkill();
  assert.equal(MACRO_EDITORIAL_SKILL.id, 'global-macro-strategy-writer');
  assert.match(MACRO_EDITORIAL_SKILL.digest, /^[a-f0-9]{64}$/);
  assert.equal(loadedAgain.digest, MACRO_EDITORIAL_SKILL.digest);
  assert.deepEqual(Object.keys(MACRO_EDITORIAL_SKILL.archetypes), [...MACRO_EDITORIAL_ARCHETYPES]);
  assert.match(MACRO_EDITORIAL_SKILL.coreMethod, /^## 完整工作流/);
  assert.match(MACRO_EDITORIAL_SKILL.qualityChecklist, /^## 发布阻断项/);
  assert.match(MACRO_EDITORIAL_SKILL.corpusEvidence, /368/);
  assert.match(MACRO_EDITORIAL_SKILL.corpusEvidence, /原创方法代表样本/);
  assert.match(MACRO_EDITORIAL_SKILL.corpusEvidence, /译编编辑代表样本/);
  assert.match(MACRO_EDITORIAL_SKILL.corpusEvidence, /不包含原文/);
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

test('宏观稿型按任务语义选择，并在双 skill 中保持宏观判断优先', () => {
  assert.equal(routeMacroEditorialArchetype('CPI 公布后写一篇市场快评'), '事件快评');
  assert.equal(routeMacroEditorialArchetype('解释美元流动性如何跨资产传导'), '机制型深度');
  assert.equal(routeMacroEditorialArchetype('复盘本周市场并展望下周'), '宏观周报');
  const brief = normalizeMacroEditorialBrief({
    archetype: '宏观周报',
    thesis: '美元实际利率仍是本周跨资产定价主轴',
    evidence_boundary: '一个直接一手数据发布支撑核心事实，传导属于我们的判断。',
  }, { hasPrimaryEvidence: true });
  const guidance = buildMacroEditorialWritingGuidance(brief, { userSpecifiedStructure: true });
  assert.match(guidance, /Global Macro Strategy Writer 主导方法/);
  assert.match(guidance, /本宏观方法主导问题、预期差、传导、情景和观察信号/);
  assert.match(guidance, /LatePost 方法只负责证据账本、归因、因果推进、事实审计与避免虚构/);
  assert.match(guidance, /用户已经指定结构/);
  assert.match(guidance, /不写买卖、目标价、入场、退出、止损、仓位/);
  assert.match(buildMacroEditorialEvidenceGuidance(), /没有一手来源时/);
});

test('宏观证据不足时确定性收窄边界，不把因果叙事伪装成事实', () => {
  const brief = normalizeMacroEditorialBrief(undefined, {
    input: '分析黄金和美元的关系',
    hasPrimaryEvidence: false,
  });
  assert.equal(brief.archetype, '机制型深度');
  assert.match(brief.evidence_boundary, /没有可确认的一手依据/);
  assert.match(brief.evidence_boundary, /不建立完整确定性因果叙事/);
});
