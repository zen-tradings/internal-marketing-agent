import { findUnreadableTables } from './mobile-tables.js';
import { inspectCodeBlocks } from './code-blocks.js';

// Pre-publication gate: pure deterministic rules. Errors block egress; warnings pass with a Slack review notice.
// Run before fixed-image injection and inspect model output only; local paths and credentials must never be present.

const SECRET_PATTERNS = [
  { re: /sk-or-[A-Za-z0-9_-]{10,}/, label: 'OpenRouter API key(sk-or-...)' },
  { re: /xox[bap]-[A-Za-z0-9-]{10,}/, label: 'Slack token(xoxb/xoxa/xoxp-...)' },
  { re: /xapp-[A-Za-z0-9-]{10,}/, label: 'Slack app token(xapp-...)' },
  { re: /(?:authorization|api[_ -]?key|app[_ -]?secret)\s*[:=]\s*(?:bearer\s+)?[A-Za-z0-9._~+/-]{12,}/i, label: '通用 API 凭据' },
];

export function checkArticle(markdown, {
  secretValues = [],
  workflowMode = '',
  contentPolicy = {},
} = {}) {
  const md = String(markdown || '');
  const errors = checkOutboundLeaks(md, { secretValues }).errors;
  const warnings = [];

  const fmMatch = md.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : '';
  if (!fmMatch || !/^\s*title\s*:\s*\S/m.test(fm)) {
    errors.push('出口拦截:frontmatter 缺少 title 字段');
  }

  const code = inspectCodeBlocks(md);
  if ((code.fenced || code.htmlPre || code.indented) && contentPolicy.allow_code_blocks !== true) {
    warnings.push('排版提醒:正文包含用户未明确要求的代码块,已使用公众号浅色代码样式放行');
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

  // Faithful translation takes precedence over original-writing dash style rules.
  // Exempt only this style warning; credential, local-path, malformed-table, and other safety gates remain active.
  if (workflowMode !== 'translation' && md.includes('——')) {
    warnings.push('风格:出现中文破折号——,规范要求用逗号或冒号代替');
  }

  return { errors, warnings };
}

export function checkOutboundLeaks(markdown, { secretValues = [] } = {}) {
  const md = String(markdown || '');
  const frontmatter = md.match(/^---\n[\s\S]*?\n---/);
  const withoutGeneratedCover = frontmatter
    ? md.replace(/^---\n[\s\S]*?\n---/, (block) => block.replace(/^\s*cover\s*:\s*.*(?:\n|$)/gm, ''))
    : md;
  const errors = [];
  for (const { re, label } of SECRET_PATTERNS) {
    if (re.test(md)) errors.push(`出口拦截:疑似密钥泄漏(${label}),不允许发布`);
  }
  for (const secret of secretValues) {
    const value = String(secret || '').trim();
    if (value.length >= 8 && md.includes(value)) {
      errors.push('出口拦截:正文包含当前进程的真实凭据值,不允许发布');
      break;
    }
  }
  if (/(?:\/Users\/|\/home\/|\/srv\/|\/tmp\/|[A-Za-z]:\\Users\\)/.test(withoutGeneratedCover)) {
    errors.push('出口拦截:正文包含本地路径,模型产出不应泄漏运行环境路径');
  }
  return { errors };
}

export function configuredSecretValues(config = {}) {
  return [
    config.writer?.openrouterApiKey,
    config.writer?.exaApiKey,
    config.slack?.botToken,
    config.slack?.appToken,
    config.documents?.googleDocsAccessToken,
    config.documents?.googleDocsClientSecret,
    config.documents?.googleDocsRefreshToken,
    config.documents?.githubToken,
    config.wechat?.appSecret,
    config.customerio?.appApiKey,
    config.translation?.notionApiToken,
    config.translation?.datalabApiKey,
  ];
}
