import { findUnreadableTables } from './mobile-tables.js';

// 发布前门禁:纯函数,确定性规则。errors 出口拦截(不予发布),warnings 放行但需 Slack 提醒人工关注。
// 门禁在注入头尾图之前跑,检查的是模型产出的原文,本地路径/密钥这类内容在模型输出里本就不该出现。

const SECRET_PATTERNS = [
  { re: /sk-or-[A-Za-z0-9_-]{10,}/, label: 'OpenRouter API key(sk-or-...)' },
  { re: /xox[bap]-[A-Za-z0-9-]{10,}/, label: 'Slack token(xoxb/xoxa/xoxp-...)' },
  { re: /xapp-[A-Za-z0-9-]{10,}/, label: 'Slack app token(xapp-...)' },
  { re: /(?:authorization|api[_ -]?key|app[_ -]?secret)\s*[:=]\s*(?:bearer\s+)?[A-Za-z0-9._~+/-]{12,}/i, label: '通用 API 凭据' },
];

export function checkArticle(markdown, { secretValues = [], workflowMode = '' } = {}) {
  const md = String(markdown || '');
  const errors = [];
  const warnings = [];

  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : '';
  // `cover` 由发布链路写回为本地文件路径，重试时不能把这个系统字段误判为
  // 模型泄漏的本地路径。正文及其他 frontmatter 字段仍保持严格检查。
  const markdownWithoutGeneratedCover = fmMatch
    ? md.replace(/^---\n[\s\S]*?\n---/, (block) => block.replace(/^\s*cover\s*:\s*.*(?:\n|$)/gm, ''))
    : md;

  if (!fmMatch || !/^\s*title\s*:\s*\S/m.test(fm)) {
    errors.push('出口拦截:frontmatter 缺少 title 字段');
  }

  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(md)) {
      errors.push(`出口拦截:疑似密钥泄漏(${label}),不允许发布`);
    }
  }

  for (const secret of secretValues) {
    const value = String(secret || '').trim();
    if (value.length >= 8 && md.includes(value)) {
      errors.push('出口拦截:正文包含当前进程的真实凭据值,不允许发布');
      break;
    }
  }

  if (/(?:\/Users\/|\/home\/|\/srv\/|\/tmp\/|[A-Za-z]:\\Users\\)/.test(markdownWithoutGeneratedCover)) {
    errors.push('出口拦截:正文包含本地路径,模型产出不应泄漏运行环境路径');
  }

  if (/```/.test(md)) {
    errors.push('出口拦截:正文包含代码围栏,公众号固定版式不允许代码卡片');
  }

  // 非直译工作流仍可能显式生成 HTML <pre><code>，只在这些块之外检查
  // 会被 Markdown 误识别为代码卡片的四空格缩进。
  const markdownOutsideExplicitPre = md.replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, '');
  if (markdownOutsideExplicitPre.split(/\r?\n/).some((line) => /^ {4,}\S/.test(line))) {
    errors.push('出口拦截:正文包含四空格缩进块,会被渲染为黄色代码框');
  }

  if (/source-page-\d+\.png/i.test(md)) {
    errors.push('出口拦截:正文包含 PDF 整页截图,会破坏公众号阅读体验');
  }

  if (/!\[[^\]]*\]\([^)]*(?:source[-_]?page|page[-_]?\d+)[^)]*\.(?:png|jpe?g|webp)(?:\?[^)]*)?\)/i.test(md)) {
    errors.push('出口拦截:正文包含疑似 PDF 整页图片,请仅保留原文图表或中文概括');
  }

  const unreadableTables = findUnreadableTables(md);
  if (unreadableTables.length) {
    warnings.push(`排版提醒:正文仍有 ${unreadableTables.length} 个无法自动拆分的宽表或列数异常表格,已按可读性优先放行`);
  }

  // 直译以忠实还原原文为最高优先级，不用原创写作的破折号风格规范干预译文。
  // 这里只豁免这一条风格提醒；密钥、本地路径、代码块、坏表格等门禁保持不变。
  if (workflowMode !== 'translation' && md.includes('——')) {
    warnings.push('风格:出现中文破折号——,规范要求用逗号或冒号代替');
  }

  if (/\$\s?\d/.test(md)) {
    warnings.push('风格:出现美元符号后跟数字($+数字),规范要求用中文单位(如亿美元)');
  }

  return { errors, warnings };
}
