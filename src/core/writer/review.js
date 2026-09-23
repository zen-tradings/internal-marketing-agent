import { cleanReferenceTitle } from '../analysis-v2.js';
import { completeReviewJson } from './model-client.js';
import { extractArticleUrls, matchResearchSources, normalizeArticle, hasTitleFrontmatter } from './shared.js';

export async function reviewAndRepairArticle({ article, input, research, workflow, writer, fetchFn, sourcePolicy }) {
  const allowed = research.filter((source) => source?.url).map((source) => ({
    title: source.title || '',
    url: source.url,
    official: Boolean(source.official),
    excerpt: [source.summary, source.text, ...(source.highlights || [])].filter(Boolean).join('\n').slice(0, 3200),
  }));
  const referenceInstruction = sourcePolicy.referenceStyle === 'terminal-list'
    ? `正文不得放引用脚标、脚注或来源链接。全文最后必须只有一个“## 引用链接”章节，精选 1-5 个最相关、最具支持力的允许来源；以相关性为准，不凑数，不要生成“引用来源”或罗列全部检索结果，该章节后不得再有文字。${sourcePolicy.requireUserSource ? '法律文件分析必须包含用户指定的案卷或文件链接。' : ''}`
    : '引用链接必须紧邻其支持的事实；文末不得重复放“资料来源/参考来源/Sources/References”列表。';
  const legalInstruction = sourcePolicy.kind === 'legal-document-analysis'
    ? '必须区分诉状指控、当事人陈述、法院认定和分析推断；不得扩散与案件分析无关的住址、电话、账户号等敏感信息。'
    : '';
  // Without external factual material, announcement/welcome emails still check obvious fabrication but need no citations.
  const prompt = `审查下面的待发布稿件，只依据任务和允许来源判断。检查所有数字、日期、因果关系和关键事实；引用 URL 只能来自允许来源。${referenceInstruction}${legalInstruction}不要改变文章语言、结构或观点，除非为删除无支持内容、修正来源矛盾或修复引用所必需。\n\n返回严格 JSON，不要代码围栏:\n{"approved":true|false,"issues":["..."],"revised_markdown":"完整修订稿；无需修订时留空"}\n\n工作流:${workflow.id}\n任务:${input}\n\n允许来源:${JSON.stringify(allowed)}\n\n待审稿件:\n${article}`;
  const review = await completeReviewJson({
    prompt,
    model: writer.reviewModel || writer.model,
    writer: { ...writer, temperature: 0 },
    fetchFn,
    timeoutMs: workflow.timeoutMs,
    systemPrompt: '你是金融研究事实审查员。严格依据给定来源，不得自行补充事实。只返回有效 JSON。',
  });
  const revised = String(review.revised_markdown || '').trim();
  if (review.approved === true && !revised) return { article, review: { approved: true, issues: review.issues || [] } };
  if (!revised) throw new Error(`事实审查未通过:${(review.issues || ['存在未说明问题']).join('; ')}`);
  let normalized = normalizeArticle(revised);
  if (!hasTitleFrontmatter(normalized)) throw new Error('事实审查修订稿缺少 title frontmatter');
  const verificationHistory = [];
  for (let round = 0; round < 2; round++) {
    const verification = await completeReviewJson({
      prompt: `复核下面修订稿是否已解决列出的问题，且所有数字/事实都由允许来源支持、引用 URL 均在允许来源中，并符合这条引用格式要求:${referenceInstruction} 只返回 JSON:{"approved":true|false,"issues":["..."]}\n\n允许来源:${JSON.stringify(allowed)}\n\n原问题:${JSON.stringify(review.issues || [])}\n\n修订稿:\n${normalized}`,
      model: writer.reviewModel || writer.model,
      writer: { ...writer, temperature: 0 },
      fetchFn,
      timeoutMs: workflow.timeoutMs,
      systemPrompt: '你是金融研究事实审查员。只返回有效 JSON。',
    });
    verificationHistory.push(verification.issues || []);
    if (verification.approved === true) {
      return {
        article: normalized,
        review: { approved: true, issues: review.issues || [], repaired: true, verificationHistory },
      };
    }
    if (round === 1) {
      throw new Error(`事实复核未通过:${(verification.issues || ['修订后仍存在问题']).join('; ')}`);
    }
    const followup = await completeReviewJson({
      prompt: `只修复复核指出的剩余问题，不增加新事实，不改变无关段落。必须返回完整 Markdown。${referenceInstruction}${legalInstruction}\n\n返回 JSON:{"approved":true,"issues":[],"revised_markdown":"完整修订稿"}\n\n允许来源:${JSON.stringify(allowed)}\n\n剩余问题:${JSON.stringify(verification.issues || [])}\n\n当前修订稿:\n${normalized}`,
      model: writer.reviewModel || writer.model,
      writer: { ...writer, temperature: 0 },
      fetchFn,
      timeoutMs: workflow.timeoutMs,
      systemPrompt: '你是金融研究事实修订员。严格按问题逐项修复，只返回有效 JSON。',
    });
    const followupMarkdown = String(followup.revised_markdown || '').trim();
    if (!followupMarkdown) throw new Error(`事实复核未通过:${(verification.issues || ['修订后仍存在问题']).join('; ')}`);
    normalized = normalizeArticle(followupMarkdown);
    if (!hasTitleFrontmatter(normalized)) throw new Error('事实复核二次修订稿缺少 title frontmatter');
  }
  throw new Error('事实复核未通过:未知错误');
}

export function canonicalizeTerminalReferences(article, research, policy = {}) {
  const original = String(article || '').trim();
  const usedLinks = extractArticleUrls(original);
  const matched = matchResearchSources(usedLinks, research)
    .slice(0, Number(policy.maxReferences || Number.POSITIVE_INFINITY));
  let body = removeTerminalReferenceSections(original);

  const images = [];
  body = body.replace(/!\[[^\]]*\]\([^\s)]+(?:\s+"[^"]*")?\)/g, (image) => {
    images.push(image);
    return `@@ZEN_IMAGE_${images.length - 1}@@`;
  });
  body = body
    .replace(/\[\^([^\]]+)\]/g, '')
    .replace(/^\[\^[^\]]+\]:.*(?:\n(?: {2,}|\t).*)*\n?/gm, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, '')
    .replace(/https?:\/\/[^\s)>\]]+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  body = body.replace(/@@ZEN_IMAGE_(\d+)@@/g, (_, index) => images[Number(index)] || '');

  if (!matched.length) return body;
  const list = matched.map((source, index) => `${index + 1}. [${cleanReferenceTitle(source.title, source.url)}](${source.url})`).join('\n');
  return `${body}\n\n## 引用链接\n\n${list}\n`;
}

export function removeTerminalReferenceSections(article) {
  const text = String(article || '');
  const heading = /^#{1,4}\s*(?:引用链接|引用来源|资料来源|参考来源|来源列表|Sources|References)\s*$/gmi;
  const matches = [...text.matchAll(heading)];
  if (!matches.length) return text;
  // The publication contract permits a sources section only at the end; rebuild from the first of any synonymous sections.
  return text.slice(0, matches[0].index).trimEnd();
}
