import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EDITORIAL_SKILL_ID = 'latepost-ai-writer';
export const MACRO_EDITORIAL_SKILL_ID = 'global-macro-strategy-writer';
export const EDITORIAL_ARCHETYPES = Object.freeze([
  '独家快讯',
  '公司与产业深描',
  '人物对话',
  '技术解释',
  '产品实测',
  'AI 月报与趋势综合',
  'AI 创业访谈',
  'AI 议题观察',
]);
export const MACRO_EDITORIAL_ARCHETYPES = Object.freeze([
  '事件快评',
  '机制型深度',
  '宏观周报',
]);

const DEFAULT_SKILL_ROOT = fileURLToPath(
  new URL('../../skills/latepost-ai-writer/', import.meta.url),
);
const DEFAULT_MACRO_SKILL_ROOT = fileURLToPath(
  new URL('../../skills/global-macro-strategy-writer/', import.meta.url),
);
const DEFAULT_ARCHETYPE = '公司与产业深描';
const DEFAULT_MACRO_ARCHETYPE = '机制型深度';

export function loadEditorialSkill(rootDir = DEFAULT_SKILL_ROOT) {
  const skillPath = path.join(rootDir, 'SKILL.md');
  const archetypesPath = path.join(rootDir, 'references', 'article-archetypes.md');
  const checklistPath = path.join(rootDir, 'references', 'quality-checklist.md');
  const skillMarkdown = readRequiredFile(skillPath);
  const archetypesMarkdown = readRequiredFile(archetypesPath);
  const checklistMarkdown = readRequiredFile(checklistPath);
  const coreMethod = extractMarkdownSection(skillMarkdown, '完整工作流');
  const routingMethod = extractMarkdownSection(archetypesMarkdown, '选择顺序');
  const qualityChecklist = extractMarkdownRange(
    checklistMarkdown,
    '发布阻断项',
    '五项评分',
  );
  const archetypes = Object.fromEntries(
    EDITORIAL_ARCHETYPES.map((name) => [
      name,
      extractMarkdownSection(archetypesMarkdown, name),
    ]),
  );
  const digest = crypto.createHash('sha256')
    .update([
      skillMarkdown,
      archetypesMarkdown,
      checklistMarkdown,
    ].join('\n'))
    .digest('hex');
  return Object.freeze({
    id: EDITORIAL_SKILL_ID,
    rootDir,
    digest,
    coreMethod,
    routingMethod,
    qualityChecklist,
    archetypes: Object.freeze(archetypes),
  });
}

export const EDITORIAL_SKILL = loadEditorialSkill();

export function loadMacroEditorialSkill(rootDir = DEFAULT_MACRO_SKILL_ROOT) {
  const skillPath = path.join(rootDir, 'SKILL.md');
  const archetypesPath = path.join(rootDir, 'references', 'article-archetypes.md');
  const checklistPath = path.join(rootDir, 'references', 'quality-checklist.md');
  const methodPath = path.join(rootDir, 'references', 'editorial-method.md');
  const evidencePath = path.join(rootDir, 'references', 'corpus-evidence.md');
  const skillMarkdown = readRequiredFile(skillPath);
  const archetypesMarkdown = readRequiredFile(archetypesPath);
  const checklistMarkdown = readRequiredFile(checklistPath);
  const methodMarkdown = readRequiredFile(methodPath);
  const evidenceMarkdown = readRequiredFile(evidencePath);
  const archetypes = Object.fromEntries(
    MACRO_EDITORIAL_ARCHETYPES.map((name) => [
      name,
      extractMarkdownSection(archetypesMarkdown, name),
    ]),
  );
  const digest = crypto.createHash('sha256')
    .update([
      skillMarkdown,
      archetypesMarkdown,
      checklistMarkdown,
      methodMarkdown,
      evidenceMarkdown,
    ].join('\n'))
    .digest('hex');
  return Object.freeze({
    id: MACRO_EDITORIAL_SKILL_ID,
    rootDir,
    digest,
    coreMethod: extractMarkdownSection(skillMarkdown, '完整工作流'),
    routingMethod: extractMarkdownSection(archetypesMarkdown, '选择顺序'),
    qualityChecklist: extractMarkdownRange(checklistMarkdown, '发布阻断项', '五项评分'),
    editorialMethod: methodMarkdown,
    corpusEvidence: evidenceMarkdown,
    archetypes: Object.freeze(archetypes),
  });
}

export const MACRO_EDITORIAL_SKILL = loadMacroEditorialSkill();

export function hasEditorialSkill(workflow) {
  return workflow?.editorialSkill === EDITORIAL_SKILL_ID
    || workflow?.editorialSkills?.includes?.(EDITORIAL_SKILL_ID);
}

export function hasMacroEditorialSkill(workflow) {
  return workflow?.editorialSkill === MACRO_EDITORIAL_SKILL_ID
    || workflow?.editorialSkills?.includes?.(MACRO_EDITORIAL_SKILL_ID);
}

export function extractMarkdownSection(markdown, heading) {
  return extractMarkdownRange(markdown, heading);
}

export function extractMarkdownRange(markdown, startHeading, endHeading) {
  const lines = String(markdown || '').split(/\r?\n/);
  const startIndex = lines.findIndex((line) => line.trim() === `## ${startHeading}`);
  if (startIndex < 0) {
    throw new Error(`写作 skill 缺少章节:## ${startHeading}`);
  }
  const endIndex = endHeading
    ? lines.findIndex((line, index) =>
        index > startIndex && line.trim() === `## ${endHeading}`)
    : lines.findIndex((line, index) =>
        index > startIndex && /^##\s+/.test(line));
  const sliceEnd = endIndex >= 0 ? endIndex : lines.length;
  const section = lines.slice(startIndex, sliceEnd).join('\n').trim();
  if (!section) throw new Error(`写作 skill 章节为空:## ${startHeading}`);
  return section;
}

export function routeEditorialArchetype(input, workflowId = '') {
  const text = String(input || '');
  if (/(?:独家|快讯|简讯|breaking|news\s*brief|flash)/i.test(text)) return '独家快讯';
  if (/(?:创始人|创业者|创业公司|founder|startup)/i.test(text)
    && /(?:访谈|采访|对话|interview|q\s*&\s*a)/i.test(text)) {
    return 'AI 创业访谈';
  }
  if (/(?:访谈|采访|对话|问答|interview|q\s*&\s*a)/i.test(text)) return '人物对话';
  if (/(?:实测|测评|评测|体验|product\s*(?:test|review)|hands-on)/i.test(text)) return '产品实测';
  if (/(?:月报|月度|趋势综合|趋势盘点|monthly|trend\s*(?:digest|roundup))/i.test(text)) {
    return 'AI 月报与趋势综合';
  }
  if (/(?:原理|机制|技术解释|架构|如何工作|technical\s*(?:explainer|deep\s*dive)|how\s+.+\s+works)/i.test(text)) {
    return '技术解释';
  }
  if (/(?:议题|伦理|对齐|欺骗|社会影响|安全责任|治理|ethics|alignment|governance)/i.test(text)) {
    return 'AI 议题观察';
  }
  if (String(workflowId) === 'earnings') return DEFAULT_ARCHETYPE;
  return DEFAULT_ARCHETYPE;
}

export function normalizeEditorialBrief(raw, {
  input = '',
  workflowId = '',
  skill = EDITORIAL_SKILL,
} = {}) {
  const candidate = raw && typeof raw === 'object' ? raw : {};
  const returnedArchetype = cleanText(candidate.archetype, 80);
  const validReturnedArchetype = EDITORIAL_ARCHETYPES.includes(returnedArchetype);
  const archetype = validReturnedArchetype
    ? returnedArchetype
    : routeEditorialArchetype(input, workflowId);
  const angle = cleanText(candidate.angle, 500)
    || '依据证据矩阵选择一个可验证的新变化，说明它改变谁的处境，并把结论收窄到材料能够支持的范围。';
  const tension = cleanText(candidate.tension, 400)
    || '区分已发生的事实、各方判断与尚未验证的结果。';
  const endingConstraint = cleanText(
    candidate.ending_constraint ?? candidate.endingConstraint,
    400,
  ) || '回到尚未解决且可继续验证的核心约束。';
  return Object.freeze({
    skill_id: skill.id,
    skill_digest: skill.digest,
    archetype,
    angle,
    tension,
    ending_constraint: endingConstraint,
    routing_source: validReturnedArchetype ? 'evidence-model' : 'deterministic-fallback',
  });
}

export function editorialTraceFromBrief(brief) {
  if (!brief) return undefined;
  return {
    id: brief.skill_id,
    digest: brief.skill_digest,
    archetype: brief.archetype,
    angle: brief.angle,
    tension: brief.tension,
    endingConstraint: brief.ending_constraint,
    routingSource: brief.routing_source,
  };
}

export function routeMacroEditorialArchetype(input) {
  const text = String(input || '');
  if (/(?:周报|周度|本周|一周|下周|weekly\s+(?:macro|market|review|outlook|report)|week\s+(?:in\s+review|ahead))/i.test(text)) {
    return '宏观周报';
  }
  if (/(?:快评|点评|盘中|盘后|刚刚|公布后|会议结果|单一事件|event[- ]driven|market\s+reaction|quick\s+(?:take|comment)|post[- ](?:meeting|data))/i.test(text)) {
    return '事件快评';
  }
  if (/(?:机制|周期|政策组合|传导|框架|跨资产|深度|长期路径|mechanism|cycle|policy\s+mix|transmission|framework|cross[- ]asset|deep\s+dive)/i.test(text)) {
    return '机制型深度';
  }
  return DEFAULT_MACRO_ARCHETYPE;
}

export function normalizeMacroEditorialBrief(raw, {
  input = '',
  skill = MACRO_EDITORIAL_SKILL,
  hasPrimaryEvidence = false,
} = {}) {
  const candidate = raw && typeof raw === 'object' ? raw : {};
  const returnedArchetype = cleanText(candidate.archetype, 80);
  const validReturnedArchetype = MACRO_EDITORIAL_ARCHETYPES.includes(returnedArchetype);
  const routedArchetype = routeMacroEditorialArchetype(input);
  const taskSelectedArchetype = hasExplicitMacroArchetypeSignal(input);
  const archetype = taskSelectedArchetype
    ? routedArchetype
    : validReturnedArchetype ? returnedArchetype : routedArchetype;
  const evidenceBoundary = cleanText(candidate.evidence_boundary ?? candidate.evidenceBoundary, 500)
    || (hasPrimaryEvidence
      ? '核心事实已有直接一手或原始来源支持；因果与预测仍须标为我们的判断。'
      : '没有可确认的一手依据；只写已证实事实、待验证点与观察条件，不建立完整确定性因果叙事。');
  return Object.freeze({
    skill_id: skill.id,
    skill_digest: skill.digest,
    archetype,
    thesis: cleanText(candidate.thesis, 500)
      || '先区分事实、市场已定价预期与增量信息，再给出条件化的跨资产判断。',
    priced_expectation: cleanText(candidate.priced_expectation ?? candidate.pricedExpectation, 500)
      || '仅在证据可以观察时描述市场已定价预期，否则明确为待验证。',
    incremental_information: cleanText(candidate.incremental_information ?? candidate.incrementalInformation, 500)
      || '识别本次信息相较此前认知真正改变的概率、路径或时间。',
    transmission: cleanText(candidate.transmission, 700)
      || '从政策或数据出发，经利率、汇率、盈利、流动性、风险溢价或供需连接到资产。',
    baseline_scenario: cleanText(candidate.baseline_scenario ?? candidate.baselineScenario, 600)
      || '给出证据支持的基准情景、触发条件和观察信号。',
    counter_scenario: cleanText(candidate.counter_scenario ?? candidate.counterScenario, 600)
      || '给出能够真正推翻基准判断的反向情景。',
    invalidation: cleanText(candidate.invalidation, 500)
      || '写明判断失效所需出现的数据、政策动作或价格行为。',
    evidence_boundary: evidenceBoundary,
    routing_source: taskSelectedArchetype
      ? 'task-semantics'
      : validReturnedArchetype ? 'evidence-model' : 'deterministic-fallback',
  });
}

export function macroEditorialTraceFromBrief(brief) {
  if (!brief) return undefined;
  return {
    id: brief.skill_id,
    digest: brief.skill_digest,
    archetype: brief.archetype,
    thesis: brief.thesis,
    pricedExpectation: brief.priced_expectation,
    incrementalInformation: brief.incremental_information,
    transmission: brief.transmission,
    baselineScenario: brief.baseline_scenario,
    counterScenario: brief.counter_scenario,
    invalidation: brief.invalidation,
    evidenceBoundary: brief.evidence_boundary,
    routingSource: brief.routing_source,
  };
}

export function buildEditorialEvidenceGuidance(skill = EDITORIAL_SKILL) {
  return `【编辑方法路由】
${skill.routingMethod}

在完成来源评估和需求覆盖判断之后，再基于已经成立的证据选择稿型和角度。不要先定宏大结论再挑材料。只允许以下稿型:
${EDITORIAL_ARCHETYPES.map((name) => `- ${name}`).join('\n')}

editorial_brief 的 angle 必须描述证据可验证的变化及其影响对象；tension 描述表象与更深约束；ending_constraint 描述文章最后应回到的尚未解决问题。三者都不得加入来源没有支持的新事实。`;
}

export function buildMacroEditorialEvidenceGuidance(skill = MACRO_EDITORIAL_SKILL) {
  return `【宏观策略方法路由】
${skill.routingMethod}

在完成来源评估后，先把事实、已定价预期、增量信息和作者推断分开，再选择一个稿型。只允许以下稿型:
${MACRO_EDITORIAL_ARCHETYPES.map((name) => `- ${name}`).join('\n')}

macro_brief 必须包含核心命题、已定价预期、增量信息、传导链、基准情景、反向情景、失效条件和证据边界。一个直接一手或原始来源可以支撑核心事实；没有一手来源时，evidence_boundary 必须要求缩窄为已确认事实、待验证点和观察条件。不能直接证实的因果只能作为“我们的判断”，并同时提供依据、反例和失效条件。`;
}

export function buildEditorialWritingGuidance(brief, {
  userSpecifiedStructure = false,
  skill = EDITORIAL_SKILL,
} = {}) {
  const normalized = normalizeEditorialBrief(brief, { skill });
  const archetypeMethod = skill.archetypes[normalized.archetype];
  if (!archetypeMethod) {
    throw new Error(`写作 skill 未加载稿型:${normalized.archetype}`);
  }
  const structureRule = userSpecifiedStructure
    ? '用户已经指定结构：稿型方法只能改善段落推进和证据表达，不得增删、改名或重排用户要求的章节；用户点名的章节名必须原样保留，不要改写成双语标题。'
    : '用户没有指定结构：可用稿型方法组织文章，但只采用证据能够支持的部分；正文分区标题写成 `## English｜中文`，不要手写序号。';
  return `【LatePost AI Writer 编辑方法】
Skill:${skill.id}
Digest:${skill.digest}
稿型:${normalized.archetype}
证据后角度:${normalized.angle}
核心矛盾:${normalized.tension}
结尾约束:${normalized.ending_constraint}

【优先级与生产适配】
- Slack 原始 Prompt、EvidenceMatrix、来源安全门禁和固定输出契约高于本编辑方法。
- 工作流专属方法高于本编辑方法；本编辑方法只改善选角、因果结构、证据密度和克制表达。
- ${structureRule}
- 只返回一个 YAML title 和正文。不要输出标题备选、待核实清单、编辑说明、评分、稿型说明或风险提示板块。
- 不得虚构采访、匿名信源、内部材料、数据或引语；没有真实依据时不得写“独家”“据我们了解”或“知情人士称”。
- 不得声称本文代表《晚点》或使用其官方方法，不得复刻参考语料中的原句、标题或独特表达。
- 在内部完成事实、结构和语言自检，不要把编辑过程输出给读者。

${skill.coreMethod}

【当前稿型方法】
${archetypeMethod}

【内部交稿检查】
${skill.qualityChecklist}`;
}

export function buildMacroEditorialWritingGuidance(brief, {
  userSpecifiedStructure = false,
  skill = MACRO_EDITORIAL_SKILL,
} = {}) {
  const normalized = normalizeMacroEditorialBrief(brief, { skill });
  const archetypeMethod = skill.archetypes[normalized.archetype];
  if (!archetypeMethod) throw new Error(`宏观写作 skill 未加载稿型:${normalized.archetype}`);
  const structureRule = userSpecifiedStructure
    ? '用户已经指定结构：不得增删、改名或重排用户要求的章节；宏观方法只改善每章内部的判断和证据表达；用户点名的章节名必须原样保留，不要改写成双语标题。'
    : '用户没有指定结构：按所选稿型自然组织，不把分析步骤机械写成栏目；正文分区标题写成 `## English｜中文`，不要手写序号。';
  return `【Global Macro Strategy Writer 主导方法】
Skill:${skill.id}
Digest:${skill.digest}
稿型:${normalized.archetype}
核心命题:${normalized.thesis}
已定价预期:${normalized.priced_expectation}
增量信息:${normalized.incremental_information}
传导链:${normalized.transmission}
基准情景:${normalized.baseline_scenario}
反向情景:${normalized.counter_scenario}
失效条件:${normalized.invalidation}
证据边界:${normalized.evidence_boundary}

【组合优先级与公开稿边界】
- Slack 原始 Prompt、EvidenceMatrix、来源安全门禁和固定输出契约高于所有 skill。
- 在两个写作 skill 之间，本宏观方法主导问题、预期差、传导、情景和观察信号；LatePost 方法只负责证据账本、归因、因果推进、事实审计与避免虚构。
- ${structureRule}
- 以 Zen Trading 的“我们”表达自有判断。不能直接证实的因果明确写成“我们的判断”，并给出依据、最强反例与失效条件。
- 不写买卖、目标价、入场、退出、止损、仓位或面向个人的交易指令。
- 关键价格、收益率或估值水平必须可由来源复核，并写清资产、市场、时点与口径；无来源则删除具体点位。
- 只有可靠数据才使用 Markdown 表格，并在表题或邻近文字注明口径、时点和来源。
- 只返回一个 YAML title 和正文，不输出稿型说明、编辑说明、证据账本或评分。

${skill.coreMethod}

【当前宏观稿型】
${archetypeMethod}

【内部交稿检查】
${skill.qualityChecklist}`;
}

function readRequiredFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`无法读取写作 skill:${filePath}:${error.message}`);
  }
  if (!content.trim()) throw new Error(`写作 skill 文件为空:${filePath}`);
  return content;
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function hasExplicitMacroArchetypeSignal(input) {
  return /(?:周报|周度|本周|一周|下周|weekly\s+(?:macro|market|review|outlook|report)|week\s+(?:in\s+review|ahead)|快评|点评|盘中|盘后|刚刚|公布后|会议结果|单一事件|event[- ]driven|market\s+reaction|quick\s+(?:take|comment)|post[- ](?:meeting|data)|机制|周期|政策组合|传导|框架|跨资产|深度|长期路径|mechanism|cycle|policy\s+mix|transmission|framework|cross[- ]asset|deep\s+dive)/i.test(String(input || ''));
}
