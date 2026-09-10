import { config } from 'dotenv'; config({ path: new URL('file:///Users/clarachen/Documents/project/zen%20trading/zen-slack-bot/.env').pathname });
import fs from 'node:fs';

const jsonPath = process.argv[2];
const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
const records = data.results || data;
const outPath = jsonPath.replace(/\.json$/, '.evidence_zh.json');

let existing = {};
try { existing = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch {}

const writer = {
  key: process.env.OPENROUTER_API_KEY,
  model: process.env.OPENROUTER_MODEL || 'qwen/qwen3.8-max',
  base: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
};

const system = '你是严谨的金融译者和隐私合规编辑。输出 JSON。';
const results = {};
for (const r of records) {
  const id = String(r.rank);
  if (existing[id]?.zh) { results[id] = existing[id]; continue; }
  const label = `从业者 ${String(r.rank).padStart(2, '0')}`;
  const prompt = `把下面一段公开职业资料证据 1:1 忠实翻译为简体中文，用于一份已匿名的研究报告。要求：
1. 人物姓名一律替换为「${label}」。
2. 所有公司/机构名称一律替换为行业类别代称：大型投行/银行→「某大型银行」，做市商→「某做市商」，量化基金→「某量化机构」，资产管理/投顾→「某资产管理机构」，交易所→「某交易所」，科技公司→「某科技公司」，教育培训→「某教育培训机构」，其它→「某机构」。同一机构在同一文本内保持同一代称，机构后括号不要出现原名。
3. 删除所有 LinkedIn 链接和 Markdown 链接，但保留链接文字本身（如职位名）。
4. 数字、百分比、年限、日期、策略名、交易所品种代码（SPX/VIX/RUT 等）必须原样保留，不得增删事实，不得添加解释。
5. LinkedIn 档案里的第一人称保留为第一人称。
只返回 JSON：{"zh":"中文译文"}

记录：
${r.strategy_evidence}`;
  const res = await postWithRetry(`${writer.base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${writer.key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://zentradings.com' },
    body: JSON.stringify({
      model: writer.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      temperature: 0, max_tokens: 12000,
      response_format: { type: 'json_object' },
    }),
  }, id);
  const raw = await res.text();
  if (!res.ok) throw new Error(`rank ${id}: HTTP ${res.status} ${raw.slice(0, 300)}`);
  let data2;
  try { data2 = JSON.parse(raw); }
  catch { throw new Error(`rank ${id}: invalid envelope JSON ${raw.slice(0, 300)}`); }
  const content = data2?.choices?.[0]?.message?.content || '';
  let parsed;
  try { parsed = JSON.parse(content); }
  catch {
    const s = content.indexOf('{'); const e = content.lastIndexOf('}');
    if (s >= 0 && e > s) { parsed = JSON.parse(content.slice(s, e + 1)); }
    else { parsed = { zh: content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim() }; }
  }
  if (!parsed?.zh?.trim()) {
    const finish = data2?.choices?.[0]?.finish_reason;
    if (finish === 'content_filter') throw new Error(`rank ${id}: content filtered`);
    if (finish === 'length') throw new Error(`rank ${id}: output truncated (length)`);
    throw new Error(`rank ${id}: empty translation finish=${finish} content=${content.slice(0, 300)}`);
  }
  results[id] = { zh: parsed.zh.trim() };
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`translated ${id}/20`);
}
async function postWithRetry(url, init, label, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      lastErr = error;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    } finally { clearTimeout(timer); }
  }
  throw new Error(`rank ${label}: ${lastErr?.message || lastErr}`);
}

console.log(JSON.stringify({ outPath, count: Object.keys(results).length }));
