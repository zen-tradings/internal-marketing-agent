import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_GENERATOR_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tools',
  'infographic-generator'
);

// 生成图统一命名,便于重试时确定性剥离(见 stripGeneratedInfographics)。
export const GENERATED_IMAGE_RE = /^!\[[^\]]*\]\((?:[^()\s]*\/)?infographic-\d+\.png\)\s*$/;

const MAX_SYNTAX_CHARS = 4000;
const MAX_ANCHOR_CHARS = 60;

// 规划 prompt 中给出的模板白名单。渲染端仍会用 getTemplates() 硬校验,
// 这里收敛到在公众号竖屏上可读性好、数据形态简单的一批。
const TEMPLATE_GUIDE = `
可用模板(只能从这里选):
- 流程/步骤/时间线: sequence-steps-simple, sequence-timeline-simple, sequence-ascending-steps, sequence-funnel-simple, sequence-pyramid-simple, sequence-roadmap-vertical-simple
- 要点列表: list-row-simple-horizontal-arrow, list-column-simple-vertical-arrow, list-grid-simple, list-sector-simple, list-pyramid-rounded-rect-node
- 对比: compare-hierarchy-left-right-circle-node-pill-badge, compare-swot
- 层级/结构: hierarchy-structure, hierarchy-tree-curved-line-rounded-rect-node, hierarchy-mindmap-level-gradient-rounded-rect
- 关系/流向: relation-network-simple-circle-node, relation-circle-circular-progress
- 数据图表: chart-column-simple, chart-bar-plain-text, chart-line-plain-text, chart-pie-plain-text, chart-pie-donut-plain-text

语法规则(缩进两个空格,不是 YAML,不要输出代码围栏):
infographic <模板名>
data
  title 图标题(可选;chart- 图表类模板不超过8个汉字,宁可省略也不要写长,长标题会换行遮挡图形)
  items
    - label 条目名(必填,不超过10个汉字)
      desc 一句话说明(可选,不超过24个汉字)
      value 纯数字(仅 chart- 图表类模板使用)
  # 层级/对比类模板用 children 嵌套:
    - label 父项
      children
        - label 子项
  # 关系类模板改用 nodes/edges:
  nodes
    - id a
      label 节点甲
  edges
    - from a
      to b

禁止: icon、illus 字段;英文标签;目标价、点位、买入/卖出等投资建议措辞;编造正文没有的数字。`;

const INFOGRAPHIC_SYSTEM_PROMPT = `你负责为 Zen Trading 公众号分析文章设计配图。从文章中挑选真正适合可视化的内容(流程、对比、结构、产业链、数据序列),输出 AntV Infographic 语法,只输出 JSON,不要输出解释或代码围栏。

合规红线:图中所有文字与数字必须来自文章正文,不得新增事实;绝不能出现目标价、点位、买入/卖出等投资建议措辞。

输出 JSON(严格遵守):
{
  "infographics": [
    {
      "anchor": "插入位置锚点:复制文章中的某个二级/三级标题文字(不带#),或某段正文的开头(不超过30个汉字),图片插在该标题或段落之后",
      "alt": "图片替代文本,不超过20个汉字",
      "syntax": "infographic <模板名>\\ndata\\n  ...(多行字符串)"
    }
  ]
}
要求:
- 最多 __MAX_IMAGES__ 张;没有适合可视化的内容就返回 {"infographics": []},宁缺毋滥
- 每张图 3-8 个数据项;label 不超过10个汉字,desc 不超过24个汉字;数值单位写进 desc 或正文,不要塞进 title
- anchor 必须是文章里逐字存在的文本,否则无法定位
- 不同图片使用不同类型的模板,避免与文章已有表格重复展示同一批数字
${TEMPLATE_GUIDE}`;

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

// 调 OpenRouter 规划文章配图。解析/校验失败一律返回 null,不抛错,
// 由调用方按“无配图”继续发布流程。
export async function buildInfographicPlan({
  title,
  markdown,
  writer,
  maxImages = 2,
  timeoutMs: timeoutOption,
  fetchFn = globalThis.fetch,
}) {
  const controller = new AbortController();
  const timeoutMs = Number(timeoutOption) > 0 ? Number(timeoutOption) : 45000;
  let timer;
  try {
    if (!writer || !writer.openrouterApiKey || !writer.model) return null;
    const url = `${trimTrailingSlash(writer.baseUrl || 'https://openrouter.ai/api/v1')}/chat/completions`;
    const request = fetchFn(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${writer.openrouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': writer.httpReferer || 'https://zentradings.com',
        'X-OpenRouter-Title': writer.appTitle || 'Zen Content Hub',
      },
      body: JSON.stringify({
        model: writer.model,
        max_tokens: 4000,
        reasoning: { effort: writer.reasoningEffort || 'none', exclude: true },
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: INFOGRAPHIC_SYSTEM_PROMPT.replaceAll('__MAX_IMAGES__', String(maxImages)),
          },
          { role: 'user', content: `文章标题:${title || ''}\n\n文章正文:\n${markdown || ''}` },
        ],
      }),
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error('信息图规划请求超时');
        error.name = 'AbortError';
        reject(error);
      }, timeoutMs);
    });
    const res = await Promise.race([request, timeout]);
    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    return parseInfographicPlan(content, maxImages);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function parseInfographicPlan(content, maxImages = 2) {
  try {
    const trimmed = String(content || '').trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const data = JSON.parse(fenced ? fenced[1].trim() : trimmed);
    const list = Array.isArray(data?.infographics) ? data.infographics : [];
    const normalized = list.map(normalizeInfographicItem).filter(Boolean);
    return normalized.slice(0, maxImages);
  } catch {
    return null;
  }
}

function normalizeInfographicItem(item) {
  if (!item || typeof item !== 'object') return null;
  const anchor = String(item.anchor || '').replace(/\s+/g, ' ').trim();
  const alt = String(item.alt || '').replace(/\s+/g, ' ').trim() || '文章配图';
  let syntax = String(item.syntax || '').trim();
  const fenced = syntax.match(/^```[a-z]*\s*([\s\S]*?)\s*```$/i);
  if (fenced) syntax = fenced[1].trim();
  if (!anchor || anchor.length > MAX_ANCHOR_CHARS) return null;
  if (!syntax || syntax.length > MAX_SYNTAX_CHARS) return null;
  if (!/^infographic\s+\S+\s*$/m.test(syntax.split('\n')[0] || '')) return null;
  // 离线渲染不加载远程图标/插画资源,直接剔除这些行,避免渲染端外联。
  syntax = syntax
    .split('\n')
    .filter((line) => !/^\s*(icon|illus)\s+\S/.test(line))
    .join('\n');
  return { anchor, alt: alt.slice(0, 30), syntax };
}

// 重试发布时,article.md 可能已含上一次注入的生成图。按确定性的文件命名剥离,
// 保证门禁看到的始终是模型产出的原文,且重复发布不会累积图片。
export function stripGeneratedInfographics(markdown) {
  return String(markdown || '')
    .split('\n')
    .filter((line) => !GENERATED_IMAGE_RE.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function normalizeAnchorText(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

// 把生成图插入锚点所在块之后:标题锚点插在标题行后,段落锚点插在段落结束后。
// 找不到锚点返回 null,由调用方告警并跳过该图。
export function insertInfographicImage(markdown, { anchor, imagePath, alt }) {
  const lines = String(markdown || '').split('\n');
  const needle = normalizeAnchorText(anchor);
  if (!needle) return null;

  let index = lines.findIndex((line) => {
    const text = normalizeAnchorText(line.replace(/^#{1,6}\s+/, ''));
    return text && (text === needle || text.startsWith(needle) || text.includes(needle));
  });
  if (index === -1 && needle.length > 12) {
    const short = needle.slice(0, 12);
    index = lines.findIndex((line) => normalizeAnchorText(line).includes(short));
  }
  if (index === -1) return null;

  const isHeading = /^#{1,6}\s/.test(lines[index]);
  let insertAt = index + 1;
  if (!isHeading) {
    while (insertAt < lines.length && lines[insertAt].trim() !== '') insertAt += 1;
  }
  const imageLine = `![${alt || '文章配图'}](${imagePath})`;
  const next = [...lines];
  next.splice(insertAt, 0, '', imageLine);
  return next.join('\n').replace(/\n{3,}/g, '\n\n');
}

// 规划 -> 逐张渲染 -> 插入 Markdown。任何一步失败都降级为跳过该图并记录
// warning,绝不阻断发布(与封面提取失败的回退策略一致)。
export async function generateArticleInfographics({
  title,
  markdown,
  outDir,
  writer,
  infographic = {},
  generatorDir = DEFAULT_GENERATOR_DIR,
  spawnFn = nodeSpawn,
  fetchFn = globalThis.fetch,
  buildPlanFn = buildInfographicPlan,
  processTimeoutMs = Number(infographic?.processTimeoutMs || 90000),
  keepTemp = false,
}) {
  const warnings = [];
  const images = [];
  let current = String(markdown || '');

  const maxImages = Number(infographic?.maxImages) > 0 ? Number(infographic.maxImages) : 2;
  let plan = null;
  try {
    plan = await buildPlanFn({
      title,
      markdown: current,
      writer,
      maxImages,
      timeoutMs: Number(infographic?.timeoutMs) || undefined,
      fetchFn,
    });
  } catch {
    plan = null;
  }
  if (!plan) {
    warnings.push('信息图规划失败,已按无配图继续');
    return { markdown: current, images, warnings };
  }
  if (!plan.length) return { markdown: current, images, warnings };

  await fs.mkdir(outDir, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-infographic-'));
  try {
    for (const [index, item] of plan.entries()) {
      const outPath = path.join(outDir, `infographic-${index + 1}.png`);
      const dataPath = path.join(workDir, `data-${index + 1}.json`);
      await fs.writeFile(dataPath, JSON.stringify({ syntax: item.syntax }, null, 2));
      try {
        await runRenderer({ generatorDir, dataPath, outPath, spawnFn, processTimeoutMs });
        await fs.access(outPath);
      } catch (e) {
        warnings.push(`第 ${index + 1} 张信息图渲染失败,已跳过:${String(e.message || e).slice(0, 160)}`);
        continue;
      }
      const inserted = insertInfographicImage(current, {
        anchor: item.anchor,
        imagePath: outPath,
        alt: item.alt,
      });
      if (!inserted) {
        warnings.push(`第 ${index + 1} 张信息图锚点定位失败,已跳过:${item.anchor.slice(0, 40)}`);
        continue;
      }
      current = inserted;
      images.push(outPath);
    }
  } finally {
    if (!keepTemp) await fs.rm(workDir, { recursive: true, force: true });
  }
  return { markdown: current, images, warnings };
}

function runRenderer({ generatorDir, dataPath, outPath, spawnFn, processTimeoutMs }) {
  return new Promise((resolve, reject) => {
    let cp;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { cp?.kill?.('SIGKILL'); } catch {}
      finish(reject, new Error(`信息图渲染超时:${processTimeoutMs}ms`));
    }, processTimeoutMs);
    try {
      cp = spawnFn(process.execPath, [path.join(generatorDir, 'render.mjs'), dataPath, outPath], {
        cwd: generatorDir,
        stdio: 'inherit',
      });
    } catch (e) {
      finish(reject, e);
      return;
    }
    cp.on('close', (code) => {
      if (code === 0) finish(resolve);
      else finish(reject, new Error(`信息图渲染失败 code=${code}`));
    });
    cp.on('error', (e) => finish(reject, e));
  });
}
