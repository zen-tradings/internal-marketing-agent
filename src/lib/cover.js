import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_GENERATOR_DIR = path.join(os.homedir(), 'zen-push-image');

// 若 frontmatter 缺 cover: 插入;已存在则原样返回(不重复插入)
export function ensureFrontmatterCover(markdown, coverPath) {
  const m = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return `---\ncover: ${coverPath}\n---\n${markdown}`;
  if (/^\s*cover:/m.test(m[1])) return markdown;
  const fm = m[1] + `\ncover: ${coverPath}`;
  return markdown.replace(m[0], `---\n${fm}\n---`);
}

// 调用 ~/zen-push-image/render.mjs 生成封面 PNG。
// 真实接口: node render.mjs <data.json> [out.png] —— 无 --title/--out flag,
// 数据以 window.DATA 形式注入 template.html 后由无头 Chrome 截图。
// 不需要 Gemini API key:无 key 时背景退化为 CSS 渐变占位图。
export async function generateCover({ title, outDir, generatorDir = DEFAULT_GENERATOR_DIR, spawnFn = nodeSpawn }) {
  const examplePath = path.join(generatorDir, 'samples', 'example.json');
  let data;
  try {
    const raw = await fs.readFile(examplePath, 'utf-8');
    data = JSON.parse(raw);
  } catch (e) {
    throw Object.assign(new Error(`读取生成器示例数据失败:${e.message}`), { stage: 'cover' });
  }
  data.title = title; // 用文章标题覆盖示例数据的 title/headline 字段,其余字段沿用示例默认值

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
