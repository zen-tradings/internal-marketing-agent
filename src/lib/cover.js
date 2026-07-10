import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_GENERATOR_DIR = path.join(os.homedir(), 'zen-push-image');

// 发布前总是写入本次生成的封面,避免沿用旧文章 cover。
export function ensureFrontmatterCover(markdown, coverPath) {
  const m = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return `---\ncover: ${coverPath}\n---\n${markdown}`;
  const fm = /^\s*cover:/m.test(m[1])
    ? m[1].replace(/^\s*cover:.*$/m, `cover: ${coverPath}`)
    : m[1] + `\ncover: ${coverPath}`;
  return markdown.replace(m[0], `---\n${fm}\n---`);
}

const COVER_SYSTEM_PROMPT = `你负责从 Zen Trading 公众号文章中提取封面数据。只输出 JSON,不要输出解释、代码围栏之外的文字或发布指令。

合规红线:绝不能出现目标价、点位、买入/卖出等投资建议措辞,提取内容只能是文章中已有的事实性摘要。

输出 JSON 字段(严格遵守):
{
  "tag": "事件驱动|周报|月报|季报|年报 之一",
  "title": "封面标题,不超过22个汉字",
  "key_takeaway": "核心结论,不超过25个汉字",
  "chain": {
    "direction": "up|down|neutral",
    "stages": [ { "kicker": "...", "nm": "英文公司名或Ticker", "sub": "..." } ]
  },
  "bullets": [ { "ic": "1", "tx": "不超过15字,数字用<b>包裹" } ],
  "source": "来源：公开资料 · 截至 YYYY-MM"
}
chain.stages 需 2 到 3 个,bullets 需 3 到 5 个。`;

// 调 OpenRouter 从文章内容里提取封面数据。解析/校验失败一律返回 null,不抛错,
// 让调用方(generateCover)回退到示例数据 + 标题的既有行为,不能让封面因提取失败而挂掉。
export async function buildCoverData({ title, markdown, writer, fetchFn = globalThis.fetch }) {
  try {
    if (!writer || !writer.openrouterApiKey || !writer.model) return null;
    const url = `${trimTrailingSlash(writer.baseUrl || 'https://openrouter.ai/api/v1')}/chat/completions`;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${writer.openrouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': writer.httpReferer || 'https://zentradings.com',
        'X-OpenRouter-Title': writer.appTitle || 'Zen Content Hub',
      },
      body: JSON.stringify({
        model: writer.model,
        temperature: 0,
        messages: [
          { role: 'system', content: COVER_SYSTEM_PROMPT },
          { role: 'user', content: `文章标题:${title || ''}\n\n文章正文:\n${markdown || ''}` },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    return parseCoverContent(content);
  } catch {
    return null;
  }
}

function parseCoverContent(content) {
  try {
    const trimmed = String(content || '').trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const jsonText = fenced ? fenced[1].trim() : trimmed;
    const data = JSON.parse(jsonText);
    return normalizeCoverData(data);
  } catch {
    return null;
  }
}

const VALID_TAGS = ['事件驱动', '周报', '月报', '季报', '年报'];
const VALID_DIRECTIONS = ['up', 'down', 'neutral'];

function normalizeCoverData(data) {
  if (!data || typeof data !== 'object') return null;
  if (!VALID_TAGS.includes(data.tag)) return null;

  const title = truncateField(data.title, 30, 22);
  const key_takeaway = truncateField(data.key_takeaway, 35, 25);
  if (title === null || key_takeaway === null) return null;

  if (!data.chain || typeof data.chain !== 'object') return null;
  if (!VALID_DIRECTIONS.includes(data.chain.direction)) return null;
  if (!Array.isArray(data.chain.stages) || data.chain.stages.length < 2 || data.chain.stages.length > 3) return null;
  for (const s of data.chain.stages) {
    if (!s || typeof s !== 'object' || !s.kicker || !s.nm || !s.sub) return null;
  }

  if (!Array.isArray(data.bullets) || data.bullets.length < 3 || data.bullets.length > 5) return null;
  for (const b of data.bullets) {
    if (!b || typeof b !== 'object' || !b.ic || !b.tx) return null;
  }

  return {
    tag: data.tag,
    title,
    key_takeaway,
    chain: data.chain,
    bullets: data.bullets,
    source: typeof data.source === 'string' && data.source.trim() ? data.source : '来源:公开资料',
  };
}

// 缺失/空字符串返回 null(触发整体提取失败);超过硬上限的字符串截断而非失败。
function truncateField(value, hardLimit, targetLen) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const s = value.trim();
  return s.length > hardLimit ? s.slice(0, targetLen) : s;
}

function deepMerge(base, override) {
  if (Array.isArray(override)) return override;
  if (override && typeof override === 'object') {
    const result = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
    for (const key of Object.keys(override)) {
      result[key] = deepMerge(base ? base[key] : undefined, override[key]);
    }
    return result;
  }
  return override;
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

// 调用 ~/zen-push-image/render.mjs 生成封面 PNG。
// 真实接口: node render.mjs <data.json> [out.png] —— 无 --title/--out flag,
// 数据以 window.DATA 形式注入 template.html 后由无头 Chrome 截图。
// 不需要 Gemini API key:无 key 时背景退化为 CSS 渐变占位图。
export async function generateCover({
  title,
  outDir,
  generatorDir = DEFAULT_GENERATOR_DIR,
  spawnFn = nodeSpawn,
  markdown,
  writer,
  buildDataFn = buildCoverData,
}) {
  const examplePath = path.join(generatorDir, 'samples', 'example.json');
  let exampleData;
  try {
    const raw = await fs.readFile(examplePath, 'utf-8');
    exampleData = JSON.parse(raw);
  } catch (e) {
    throw Object.assign(new Error(`读取生成器示例数据失败:${e.message}`), { stage: 'cover' });
  }

  // 既有回退行为:示例数据 + 文章标题覆盖 title 字段,其余字段沿用示例默认值。
  let data = { ...exampleData, title };

  if (markdown && writer) {
    let built = null;
    try {
      built = await buildDataFn({ title, markdown, writer });
    } catch {
      built = null; // 内容提取失败不能让封面生成挂掉,回退到示例+标题
    }
    if (built) data = deepMerge(exampleData, built);
  }

  await fs.mkdir(outDir, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cover-'));
  const dataPath = path.join(workDir, 'data.json');
  const outPath = path.join(outDir, 'cover.png');
  await fs.writeFile(dataPath, JSON.stringify(data, null, 2));

  return new Promise((resolve, reject) => {
    let cp;
    try {
      cp = spawnFn(process.execPath, [path.join(generatorDir, 'render.mjs'), dataPath, outPath], { cwd: generatorDir, stdio: 'inherit' });
    } catch (e) {
      reject(Object.assign(e, { stage: 'cover' }));
      return;
    }
    cp.on('close', (code) => {
      if (code === 0) resolve(path.resolve(outPath));
      else reject(Object.assign(new Error(`封面生成失败 code=${code}`), { stage: 'cover' }));
    });
    cp.on('error', (e) => reject(Object.assign(e, { stage: 'cover' })));
  });
}
