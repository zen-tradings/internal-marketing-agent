// 发布前门禁:纯函数,确定性规则。errors 出口拦截(不予发布),warnings 放行但需 Slack 提醒人工关注。
// 门禁在注入头尾图之前跑,检查的是模型产出的原文,本地路径/密钥这类内容在模型输出里本就不该出现。

const SECRET_PATTERNS = [
  { re: /sk-or-[A-Za-z0-9_-]{10,}/, label: 'OpenRouter API key(sk-or-...)' },
  { re: /xox[bap]-[A-Za-z0-9-]{10,}/, label: 'Slack token(xoxb/xoxa/xoxp-...)' },
];

export function checkArticle(markdown) {
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

  if (/\/Users\//.test(markdownWithoutGeneratedCover)) {
    errors.push('出口拦截:正文包含本地路径 /Users/,模型产出不应出现本地文件路径');
  }

  if (md.includes('——')) {
    warnings.push('风格:出现中文破折号——,规范要求用逗号或冒号代替');
  }

  if (/\$\s?\d/.test(md)) {
    warnings.push('风格:出现美元符号后跟数字($+数字),规范要求用中文单位(如亿美元)');
  }

  return { errors, warnings };
}
