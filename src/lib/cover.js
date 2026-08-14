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
  'cover-generator'
);

// Always write the newly generated cover before publication to avoid reusing an older article cover.
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
  "title": "封面标题,不超过22个汉字",
  "key_takeaway": "一句核心结论或定位,不超过30个汉字"
}
标题应保留文章主体名称；核心结论必须来自正文，信息不足时写“Zen Research from Zen Trading”。`;

// Ask OpenRouter to extract cover data from article content. Parsing or validation failures return null so
// generateCover retains its existing example-data-plus-title fallback instead of failing cover generation.
export async function buildCoverData({ title, markdown, writer, fetchFn = globalThis.fetch }) {
  const controller = new AbortController();
  const timeoutMs = Number(writer?.coverTimeoutMs || 30000);
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
        max_tokens: 1200,
        reasoning: { effort: writer.reasoningEffort || 'none', exclude: true },
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: COVER_SYSTEM_PROMPT },
          { role: 'user', content: `文章标题:${title || ''}\n\n文章正文:\n${markdown || ''}` },
        ],
      }),
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error('封面数据请求超时');
        error.name = 'AbortError';
        reject(error);
      }, timeoutMs);
    });
    const res = await Promise.race([request, timeout]);
    if (!res.ok) return null;
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;
    return parseCoverContent(content);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
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

function normalizeCoverData(data) {
  if (!data || typeof data !== 'object') return null;

  const title = truncateField(data.title, 30, 22);
  const key_takeaway = truncateField(data.key_takeaway, 40, 30);
  if (title === null || key_takeaway === null) return null;
  return { title, key_takeaway };
}

// Missing or empty strings return null and fail the full extraction; values over hard limits are truncated.
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
      if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      result[key] = deepMerge(base ? base[key] : undefined, override[key]);
    }
    return result;
  }
  return override;
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

// Call the bundled cover-generator/render.mjs to generate the cover PNG.
// Its interface is node render.mjs <data.json> [out.png], without --title/--out flags; data is injected as
// window.DATA in template.html and captured by headless Chrome.
export async function generateCover({
  title,
  outDir,
  generatorDir = DEFAULT_GENERATOR_DIR,
  spawnFn = nodeSpawn,
  markdown,
  writer,
  buildDataFn = buildCoverData,
  processTimeoutMs = Number(writer?.coverProcessTimeoutMs || 90000),
  keepTemp = false,
}) {
  const examplePath = path.join(generatorDir, 'samples', 'example.json');
  let exampleData;
  try {
    const raw = await fs.readFile(examplePath, 'utf-8');
    exampleData = JSON.parse(raw);
  } catch (e) {
    throw Object.assign(new Error(`读取生成器示例数据失败:${e.message}`), { stage: 'cover' });
  }

  // Existing fallback: overwrite example-data title with the article title and retain other example defaults.
  let data = { ...exampleData, title, key_takeaway: 'Zen Research from Zen Trading' };

  if (markdown && writer) {
    let built = null;
    try {
      built = await buildDataFn({ title, markdown, writer });
    } catch {
      built = null; // Content extraction must not fail cover generation; use the example-plus-title fallback.
    }
    if (built) data = deepMerge(exampleData, built);
  }

  await fs.mkdir(outDir, { recursive: true });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zen-cover-'));
  const dataPath = path.join(workDir, 'data.json');
  const outPath = path.join(outDir, 'cover.png');
  await fs.writeFile(dataPath, JSON.stringify(data, null, 2));

  try {
    return await new Promise((resolve, reject) => {
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
        finish(reject, Object.assign(new Error(`封面生成超时:${processTimeoutMs}ms`), { stage: 'cover' }));
      }, processTimeoutMs);
      try {
        cp = spawnFn(process.execPath, [path.join(generatorDir, 'render.mjs'), dataPath, outPath], { cwd: generatorDir, stdio: 'inherit' });
      } catch (e) {
        finish(reject, Object.assign(e, { stage: 'cover' }));
        return;
      }
      cp.on('close', (code) => {
        if (code === 0) finish(resolve, path.resolve(outPath));
        else finish(reject, Object.assign(new Error(`封面生成失败 code=${code}`), { stage: 'cover' }));
      });
      cp.on('error', (e) => finish(reject, Object.assign(e, { stage: 'cover' })));
    });
  } finally {
    if (!keepTemp) await fs.rm(workDir, { recursive: true, force: true });
  }
}
