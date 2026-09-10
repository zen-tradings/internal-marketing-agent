import fs from 'node:fs';
import path from 'node:path';

const JSON_PATH = process.argv[2];
if (!JSON_PATH) {
  console.error('usage: node scripts/build-anon-options-article.mjs <options.json> [out.md]');
  process.exit(2);
}

const CATEGORY_COUNTS = new Map();
const COMPANY_PLACEHOLDERS = new Map();

function categorizeCompany(company) {
  const c = String(company || '').toLowerCase();
  const rules = [
    [/\b(self[- ]employed|independent|freelance|confidential|stealth)\b/, '独立从业'],
    [/bank of america|jpmorgan|goldman|morgan stanley|citigroup|barclays|deutsche|\bubs\b|wells fargo|hsbc|credit suisse|\bbank\b/, '某大型银行'],
    [/citadel|jump trading|\bdrw\b|\bimc\b|susquehanna|\bsig\b|optiver|wolverine|\bxr trading\b|chicago trading|\bctc\b|volant|peak6|group one|akuna|belvedere|simplex|t3 trading|tradebot|spot trading|market maker/, '某做市商'],
    [/two sigma|d\.e\. shaw|renaissance|worldquant|tower research|hudson river|\bqvr\b|quant|numerai|point72|\baqr\b|millennium|bridgewater|man group|winton|squarepoint|exoduspoint|verition|balyasny|capula|garden research/, '某量化机构'],
    [/blackrock|vanguard|fidelity|schwab|state street|\bbny\b|invesco|pimco|asset management|capital group|goldenstone|wealth|advisors?|investments?|\bfund\b|partners\b|\bcapital\b|management\b|\bmgmt\b/, '某资产管理机构'],
    [/\bcme\b|\bcboe\b|\bice\b|nasdaq|\bnyse\b|\bocc\b|exchange|clearing/, '某交易所或清算机构'],
    [/university|college|institute|academy|education|learning|training|school/, '某教育培训机构'],
    [/consulting|consultant|deloitte|\bpwc\b|kpmg|ernst|mckinsey|\bbain\b|\bbcg\b/, '某咨询机构'],
    [/software|technolog|tech\b|systems|solutions|digital|analytics|platform|fintech/, '某科技公司'],
    [/insurance|\baig\b|metlife|prudential|chubb/, '某保险机构'],
    [/semiconductor|manufactur|hardware|electronics|mitsubishi|industrial|corporation|\bcorp\b|\binc\b|\bllc\b|\bltd\b|\bco\.?\b|company/, '某企业'],
  ];
  for (const [re, label] of rules) if (re.test(c)) return label;
  return '某机构';
}

function placeholderCompany(company) {
  const key = String(company || '').trim();
  if (!key) return '某机构';
  if (COMPANY_PLACEHOLDERS.has(key)) return COMPANY_PLACEHOLDERS.get(key);
  const label = categorizeCompany(key);
  const count = CATEGORY_COUNTS.get(label) || 0;
  CATEGORY_COUNTS.set(label, count + 1);
  const out = count === 0 ? label : `${label} ${count + 1}`;
  COMPANY_PLACEHOLDERS.set(key, out);
  return out;
}

function yearRange(from, to, isCurrent) {
  const y = (v) => (v ? String(v).slice(0, 4) : '');
  if (isCurrent || !to) return `${y(from)} 年至今`;
  if (y(from) === y(to)) return `${y(from)} 年`;
  return `${y(from)} 年–${y(to)} 年`;
}

const LOCATION_MAP = {
  'New York': '纽约州', 'California': '加利福尼亚州', 'Illinois': '伊利诺伊州', 'Texas': '得克萨斯州',
  'Massachusetts': '马萨诸塞州', 'Connecticut': '康涅狄格州', 'New Jersey': '新泽西州', 'Pennsylvania': '宾夕法尼亚州',
  'Florida': '佛罗里达州', 'Georgia': '佐治亚州', 'Washington': '华盛顿州', 'Colorado': '科罗拉多州',
  'United States': '美国', 'Chicago': '芝加哥', 'New York City': '纽约', 'San Francisco': '旧金山', 'Boston': '波士顿',
  'Los Angeles': '洛杉矶', 'Philadelphia': '费城', 'Naperville': '内珀维尔', 'North Andover': '北安多弗',
  'Southington': '绍辛顿', 'Jersey City': '泽西市', 'Hoboken': '霍博肯', 'Princeton': '普林斯顿',
};
function fmtLocation(loc) {
  if (!loc) return '';
  let out = String(loc);
  for (const [en, zh] of Object.entries(LOCATION_MAP)) out = out.split(en).join(zh);
  return out;
}

const STRATEGY_MAP = {
  'Long Call': '买入看涨', 'Long Put': '买入看跌', 'Covered Call': '备兑看涨', 'Protective Put': '保护性看跌',
  'Iron Condor': '铁鹰式组合', 'Credit Spread': '信用价差', 'Debit Spread': '借方价差', 'Butterfly': '蝶式价差',
  '0DTE': '当日到期', 'Calendar Spread': '日历价差', 'Diagonal Spread': '对角价差', 'Straddle': '跨式组合',
  'Strangle': '宽跨式组合', 'Vertical Spread': '垂直价差',
  'Adjacent Options / Derivatives / Volatility': '期权/衍生品/波动率相关',
};
function strategyZh(list) {
  return (Array.isArray(list) ? list : [list]).filter(Boolean).map((s) => STRATEGY_MAP[s] || s).join('、');
}

function evidenceStrengthZh(v) {
  return String(v || '')
    .replace(/^Strong/i, '强')
    .replace(/^Moderate/i, '中')
    .replace(/named traditional strategy/i, '明确指向传统策略')
    .replace(/adjacent options\/derivatives\/volatility evidence/i, '期权/衍生品/波动率相关证据');
}

const CLASSIFICATION_NOTE_ZH = '在本次检索返回的公开 LinkedIn 资料中，未发现公开的 LLM 辅助使用证据；但这并不证明其未使用 LLM。';

const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const evidenceZh = (() => {
  try {
    return JSON.parse(fs.readFileSync(JSON_PATH.replace(/\.json$/i, '.evidence_zh.json'), 'utf8'));
  } catch { return {}; }
})();
const records = data.results || data;
const meta = data.metadata || {};
const dateStr = String(meta.generated_at || '').slice(0, 10);
const isLlmCohort = records.some((r) => Array.isArray(r.llm_assistance_type) && r.llm_assistance_type.length);
const titleText = isLlmCohort ? '期权与 LLM 辅助实践从业者调研（匿名）' : '传统期权从业者调研（匿名）';
const introText = isLlmCohort
  ? '以下人选均为美国地区的期权/衍生品/波动率从业者，且其公开职业资料中可见使用 LLM/生成式 AI 辅助投研、策略、监控或工作流的公开证据。'
  : '以下人选均为美国地区的期权/衍生品/波动率从业者，其公开职业资料中有期权、衍生品或波动率相关证据；且在本次检索返回的公开资料中未发现使用 LLM 辅助的公开证据。这一结论仅表示"公开资料中未见"，不构成对其是否使用 LLM 的证明。';
const llmUsageMap = {
  'Risk and Scenario Analysis': '风险与情景分析',
  'Strategy Ideation or Selection': '策略构思或选择',
  'Monitoring or Workflow Automation': '监控或工作流自动化',
  'Model Training and Evaluation': '模型训练与评估',
  'Research Synthesis': '研究信息整合',
  'Market, News, or Sentiment Interpretation': '市场/新闻/情绪解读',
  'Investment Research and Decision Support': '投资研究与决策支持',
};

const lines = [];
lines.push('---');
lines.push(`title: "${titleText}"`);
lines.push('---');
lines.push('');
lines.push(`本文是一份候选人调研材料的中文阅读版，共 ${records.length} 位从业者，数据生成于 ${dateStr}。`);
lines.push('');
lines.push(`**口径说明**：${introText}`);
lines.push('');
lines.push('**匿名处理**：按交付要求，姓名统一编号为"从业者 01–20"（编号与原名单排名一致）；任职机构按行业类别匿名，同一机构在全篇保持同一代称；个人主页链接已隐去。');
lines.push('');
lines.push('## 从业者经历');
lines.push('');

for (const r of records) {
  lines.push(`### 从业者 ${String(r.rank).padStart(2, '0')}`);
  lines.push('');
  const loc = fmtLocation(r.location);
  if (loc) lines.push(`- **所在地**：${loc}`);
  if (r.strategy_classification?.length) lines.push(`- **策略分类**：${strategyZh(r.strategy_classification)}`);
  if (r.evidence_strength) lines.push(`- **证据强度**：${evidenceStrengthZh(r.evidence_strength)}`);
  if (r.current_roles?.length) {
    const role = r.current_roles[0];
    lines.push(`- **现任**：${role.title || ''}，${placeholderCompany(role.company)}（${yearRange(role.from, role.to, role.is_current)}）`);
  }
  const evidence = evidenceZh[String(r.rank)]?.zh
    || String(r.strategy_evidence || '').replace(/\s+/g, ' ').trim();
  if (evidence) {
    lines.push(`- **策略证据**：${evidence}`);
  }
  if (isLlmCohort && r.llm_assistance_type?.length) {
    lines.push(`- **LLM 辅助类型**：${r.llm_assistance_type.map((t) => llmUsageMap[t] || t).join('、')}`);
  }
  if (r.classification_notes) {
    const note = /No public LLM-assistance evidence/i.test(r.classification_notes)
      ? CLASSIFICATION_NOTE_ZH
      : r.classification_notes;
    lines.push(`- **备注**：${note}`);
  }
  if (r.work_history?.length) {
    lines.push('- **工作经历**：');
    for (const w of r.work_history) {
      lines.push(`  - ${w.title || '职位'} · ${placeholderCompany(w.company)} · ${yearRange(w.from, w.to, w.is_current)}`);
    }
  }
  if (r.education_history?.length) {
    lines.push('- **教育背景**：');
    for (const e of r.education_history) {
      const period = yearRange(e.from, e.to, false);
      lines.push(`  - ${e.degree || '学历'} · ${placeholderCompany(e.institution)}${period ? `（${period}）` : ''}`);
    }
  }
  lines.push('');
}

lines.push('---');
lines.push('');
lines.push('来源：候选人调研报告（本批次 20 人）；完整原始数据见同批 JSON / CSV 文件。本文为内部研究材料。');

const md = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
const out = process.argv[3]
  || path.join(path.dirname(JSON_PATH), `${path.basename(JSON_PATH, '.json')}_anon_zh.md`);
fs.writeFileSync(out, md);
console.log(JSON.stringify({ out, records: records.length, chars: md.length, companiesAnonymized: COMPANY_PLACEHOLDERS.size }));
