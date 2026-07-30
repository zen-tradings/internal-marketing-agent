import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EDITORIAL_SKILL_ID = 'latepost-ai-writer';
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

const DEFAULT_SKILL_ROOT = fileURLToPath(
  new URL('../../skills/latepost-ai-writer/', import.meta.url),
);
const DEFAULT_ARCHETYPE = '公司与产业深描';

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

export function hasEditorialSkill(workflow) {
  return workflow?.editorialSkill === EDITORIAL_SKILL_ID;
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

export function buildEditorialEvidenceGuidance(skill = EDITORIAL_SKILL) {
  return `【编辑方法路由】
${skill.routingMethod}

在完成来源评估和需求覆盖判断之后，再基于已经成立的证据选择稿型和角度。不要先定宏大结论再挑材料。只允许以下稿型:
${EDITORIAL_ARCHETYPES.map((name) => `- ${name}`).join('\n')}

editorial_brief 的 angle 必须描述证据可验证的变化及其影响对象；tension 描述表象与更深约束；ending_constraint 描述文章最后应回到的尚未解决问题。三者都不得加入来源没有支持的新事实。`;
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
    ? '用户已经指定结构：稿型方法只能改善段落推进和证据表达，不得增删、改名或重排用户要求的章节。'
    : '用户没有指定结构：可用稿型方法组织文章，但只采用证据能够支持的部分。';
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
