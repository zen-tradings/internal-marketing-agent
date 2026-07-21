import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { generateStructuredTranslation } from './source-document-v2.js';

const PAGE_MARKER_RE = /<!--\s*source-page:(\d+)\s*-->/g;
const TRANSLATION_CHECKPOINT_VERSION = 3;
const ANALYSIS_CHECKPOINT_VERSION = 2;

export async function generateStrictTranslation({
  input,
  workflow,
  writer,
  fetchFn,
  trace,
  completeArticle,
  fetchWithRetry,
  onProgress,
  resumeFromCheckpoint = false,
  translationConfig = {},
}) {
  const urls = extractUrls(input);
  if (!urls.length) throw new Error('直译任务缺少可读取的 http(s) 原文链接');
  const analysisRequest = extractSupplementaryAnalysisRequest(input);
  const textOnly = requestsTextOnlyTranslation(input);
  if (translationConfig.v2Enabled && !analysisRequest) {
    const result = await generateStructuredTranslation({
      input,
      workflow,
      writer,
      fetchFn,
      fetchWithRetry,
      completeArticle,
      onProgress,
      translationConfig,
      pdfExtractor: extractPdfSource,
      resumeFromCheckpoint,
      textOnly,
      highlightKeyPoints: /(?:关键词|核心观点).{0,12}高亮|高亮.{0,12}(?:关键词|核心观点)/i.test(input),
    });
    if (trace) {
      trace.translationV2 = {
        enabled: true,
        extractor: result.manifest.extractor,
        sourceType: result.manifest.sourceType,
        acquisition: result.manifest.acquisition,
        structure: {
          blocks: result.manifest.blocks,
          assets: result.manifest.assets,
          tables: result.manifest.tables,
          tableCells: result.manifest.tableCells,
          blockOrder: result.manifest.blockOrder,
          assetOrder: result.manifest.assetOrder,
        },
        completeness: result.completeness,
        textOnly: result.textOnly,
      };
    }
    return result;
  }
  const sourceUrl = urls[0];
  const source = await acquireSource({
    sourceUrl,
    workDir: workflow.workDir,
    fetchFn,
    fetchWithRetry,
    trace,
    allowCachedPdf: resumeFromCheckpoint,
  });
  const chunks = chunkBlocks(source.blocks, source.kind === 'pdf' ? 18000 : 22000);
  if (!chunks.length) throw new Error('未能从原文提取正文,拒绝生成空译文');
  const checkpoint = loadTranslationCheckpoint({
    workDir: workflow.workDir,
    source,
    model: workflow.model || writer.model,
    chunks,
  });
  const translated = [...checkpoint.translated];
  await reportProgress(onProgress, {
    stage: 'source',
    message: source.kind === 'pdf'
      ? `PDF 已完整提取 ${source.manifest.pages} 页，${translated.length ? `从断点 ${translated.length}/${chunks.length} 继续翻译` : '开始分块翻译'}`
      : '网页正文已完整提取，开始分块翻译',
    completed: translated.length,
    total: chunks.length,
  });

  let lastReportedQuarter = Math.floor((translated.length * 4) / chunks.length);
  for (let index = translated.length; index < chunks.length; index++) {
    const chunk = chunks[index];
    const prompt = translationPrompt({ source, chunk, index, total: chunks.length });
    let content = stripOuterFence(await completeArticle({
      prompt,
      model: workflow.model || writer.model,
      writer: { ...writer, temperature: 0 },
      fetchFn,
      timeoutMs: workflow.timeoutMs,
      systemPrompt: '你是严谨的专业译者。只做完整忠实的英译中，不总结、不改写、不省略。必须保留输入中的页面标记、编号、公式、表格、脚注和引用。只输出 Markdown 正文。',
    }));
    content = normalizeTranslationTableVocabulary(content);
    let untranslated = findUntranslatedEnglishLines(content);
    let visualMarkers = findPendingVisualSummaryMarkers(content);
    let missingAssetMarkers = findMissingAssetMarkers(chunk, content);
    let missingPageMarkers = findMissingPageMarkers(chunk, content);
    let missingVisualSummaries = findMissingVisualSummaries(chunk, content);
    if (untranslated.length || visualMarkers.length || missingAssetMarkers.length || missingPageMarkers.length || missingVisualSummaries.length) {
      content = stripOuterFence(await completeArticle({
        prompt: translationRepairPrompt({ sourceChunk: chunk, content, untranslated, visualMarkers, missingAssetMarkers, missingPageMarkers, missingVisualSummaries }),
        model: workflow.model || writer.model,
        writer: { ...writer, temperature: 0 },
        fetchFn,
        timeoutMs: workflow.timeoutMs,
        systemPrompt: '你是中文论文译文校对员。只修复漏译的英文正文，不删减、不总结、不改动数字、公式、图表、页面标记和引用。只输出完整修订后的 Markdown。',
      }));
      content = normalizeTranslationTableVocabulary(content);
      untranslated = findUntranslatedEnglishLines(content);
      visualMarkers = findPendingVisualSummaryMarkers(content);
      missingAssetMarkers = findMissingAssetMarkers(chunk, content);
      missingPageMarkers = findMissingPageMarkers(chunk, content);
      missingVisualSummaries = findMissingVisualSummaries(chunk, content);
    }
    if (untranslated.length) {
      writeFailedTranslationChunk(workflow.workDir, index, content, {
        untranslated,
        visualMarkers,
        missingAssetMarkers, missingPageMarkers, missingVisualSummaries,
      });
      throw new Error(`直译中文门禁失败:仍有 ${untranslated.length} 行疑似未翻译英文正文;示例:${untranslated.slice(0, 3).join(' | ').slice(0, 240)}`);
    }
    if (visualMarkers.length) {
      writeFailedTranslationChunk(workflow.workDir, index, content, { untranslated, visualMarkers, missingAssetMarkers, missingPageMarkers, missingVisualSummaries });
      throw new Error(`直译图表门禁失败:仍有 ${visualMarkers.length} 个图表概括占位符未处理`);
    }
    if (missingAssetMarkers.length) {
      writeFailedTranslationChunk(workflow.workDir, index, content, { untranslated, visualMarkers, missingAssetMarkers, missingPageMarkers, missingVisualSummaries });
      throw new Error(`直译图表门禁失败:丢失原图标记 ${missingAssetMarkers.join(',')}`);
    }
    if (missingPageMarkers.length) {
      writeFailedTranslationChunk(workflow.workDir, index, content, { untranslated, visualMarkers, missingAssetMarkers, missingPageMarkers, missingVisualSummaries });
      throw new Error(`直译页码门禁失败:丢失页面标记 ${missingPageMarkers.join(',')}`);
    }
    if (missingVisualSummaries.length) {
      writeFailedTranslationChunk(workflow.workDir, index, content, { untranslated, visualMarkers, missingAssetMarkers, missingPageMarkers, missingVisualSummaries });
      throw new Error(`直译图表门禁失败:缺少中文图表概括 ${missingVisualSummaries.join(',')}`);
    }
    translated.push(content);
    saveTranslationCheckpoint({ ...checkpoint, translated });
    const completed = index + 1;
    const quarter = Math.floor((completed * 4) / chunks.length);
    if (quarter > lastReportedQuarter || completed === chunks.length) {
      lastReportedQuarter = quarter;
      await reportProgress(onProgress, {
        stage: 'translation',
        message: `全文翻译进度 ${completed}/${chunks.length}`,
        completed,
        total: chunks.length,
      });
    }
  }

  const title = source.title || titleFromInput(input) || '原文直译';
  let body = translated.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  body = normalizeTranslationMarkdown(body);
  if (source.kind === 'pdf') body = removePdfRunningArtifacts(body, source.manifest.pages);
  body = textOnly
    ? stripTranslationVisualContent(body)
    : injectPageAssets(body, source.pageAssets || []);
  let supplementaryAnalysis;
  if (analysisRequest) {
    await reportProgress(onProgress, { stage: 'analysis', message: '全文直译已完成，开始生成原文依据分析' });
    supplementaryAnalysis = await generateSupplementaryAnalysis({
      request: analysisRequest,
      source,
      workDir: workflow.workDir,
      model: workflow.model || writer.model,
      writer,
      fetchFn,
      completeArticle,
      timeoutMs: workflow.timeoutMs,
    });
    body = `${body}\n\n## 原文依据分析\n\n${supplementaryAnalysis.markdown}`;
    await reportProgress(onProgress, { stage: 'analysis', message: '原文依据分析已完成，开始完整性检查' });
  }
  const article = `---\ntitle: ${yamlScalar(`${title}（译）`)}\n---\n\n来源：[《${escapeMarkdown(title)}》](${sourceUrl})，${source.publishedDate || '发布日期未知'}。\n\n${body}\n`;
  const completenessManifest = textOnly
    ? { ...source.manifest, figures: [], tables: [], assets: [], visualSummaries: [] }
    : source.manifest;
  const completeness = validateTranslationCompleteness(article, completenessManifest);
  if (completeness.errors.length) {
    throw new Error(`直译完整性门禁失败:${completeness.errors.join('; ')}`);
  }
  if (/(?:原文过长已截断|内容已截断|篇幅所限|以下省略|未完待续)/.test(article)) {
    throw new Error('直译完整性门禁失败:译文含截断/省略标记');
  }
  return {
    article,
    sourceUrl,
    manifest: source.manifest,
    completeness,
    assets: textOnly ? [] : (source.pageAssets || []),
    textOnly,
    supplementaryAnalysis: supplementaryAnalysis
      ? { request: analysisRequest, evidenceMode: supplementaryAnalysis.evidenceMode, literalHits: supplementaryAnalysis.literalHits }
      : undefined,
  };
}

export function requestsTextOnlyTranslation(input) {
  const text = String(input || '');
  return /(?:纯文字|只要文字|仅保留文字|不要(?:所有)?(?:图片|图像|图表)|无需处理(?:图片|图像|图表)|不(?:要|需要)(?:处理)?(?:所有)?(?:图片|图像|图表)(?:和|、)?(?:表格)?)/i.test(text);
}

export function stripTranslationVisualContent(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^<!--\s*(?:source-asset|visual-summary-required):[^>]+-->$/i.test(trimmed)) continue;
    if (/^!\[[^\]]*\]\([^)]*\)\s*$/.test(trimmed)) continue;
    if (/^>\s*(?:图|表)\s*\d+\s*内容概括[：:]/.test(trimmed)) continue;
    if (/^(?:图|表)\s*\d+\s*[.．:：]/.test(trimmed)) continue;
    if (/^\|.*\|\s*$/.test(trimmed)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function removePdfRunningArtifacts(value, pageCount) {
  const lines = String(value || '').split(/\r?\n/);
  const output = [];
  let afterPageMarker = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^<!--\s*source-page:\d+\s*-->$/.test(trimmed)) {
      output.push(line);
      afterPageMarker = true;
      continue;
    }
    if (afterPageMarker && !trimmed) {
      output.push(line);
      continue;
    }
    if (afterPageMarker && /^FT-Dojo[：:]/i.test(trimmed)) {
      afterPageMarker = false;
      continue;
    }
    afterPageMarker = false;
    if (/^\d{1,3}$/.test(trimmed) && Number(trimmed) >= 1 && Number(trimmed) <= Number(pageCount || 0)) continue;
    output.push(line);
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function normalizeTranslationMarkdown(value) {
  // PDF 文本可能仍携带原版面的视觉缩进。Markdown 会将连续四格解释成代码块；
  // 这里只移除行首布局空格，行内文字、数字、公式与单元格均不改动。另清掉
  // pdftotext 在个别公式处留下的控制字符，并把图表概括 blockquote 与后文隔开，
  // 避免 Markdown 把随后的整页正文一起吞进引用块。
  const normalized = String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^[ \t]{4,}(?=\S)/, ''));
  const output = [];
  for (let index = 0; index < normalized.length; index += 1) {
    const line = normalized[index];
    output.push(line);
    if (!/^\s*>/.test(line)) continue;
    const next = normalized[index + 1];
    if (next && !/^\s*>/.test(next)) output.push('');
  }
  return normalizeTranslationTableVocabulary(output.join('\n'));
}

const TABLE_CELL_TRANSLATIONS = new Map(Object.entries({
  Domain: '领域', Task: '任务', Description: '描述', 'Train Data Quality': '训练数据质量', Metrics: '指标',
  Train: '训练集', 'Valid/Test': '验证集/测试集', Method: '方法', Metric: '指标', Valid: '验证集', Test: '测试集',
  Setting: '设置', 'Avg.': '平均值',
  Total: '总计', Subtotal: '小计', 'Task Category': '任务类别', Subtask: '子任务', Average: '平均值',
  Mathematics: '数学', Math: '数学', 'Patent Examination': '专利审查', 'Patent Exam.': '专利审查',
  Chemistry: '化学', Chem: '化学', Finance: '金融', 'Table QA': '表格问答', Patent: '专利', 'Patent Examination': '专利审查',
  'Prior Art Retrieval': '现有技术检索', 'Prior Art Retrieval (PAR4PC)': '现有技术检索（PAR4PC）',
  'Novelty Classification': '新颖性分类', 'Novelty Classif. (NOC4PC)': '新颖性分类（NOC4PC）',
  'Paragraph Identification': '段落识别', 'Paragraph ID (PI4PC)': '段落识别（PI4PC）',
  'Molecular Understanding': '分子理解', 'Molecule Editing': '分子编辑', 'Molecule Optimization': '分子优化',
  'Reaction Prediction': '反应预测', 'Financial QA': '金融问答', 'Finance QA': '金融问答',
  'Table QA Data Analysis': '表格问答：数据分析', 'Data Analysis': '数据分析', 'Fact Checking': '事实核查',
  'Numerical Reasoning': '数值推理', 'Num. Reasoning': '数值推理', Visualization: '可视化',
  Accuracy: '准确率', Acc: '准确率', 'Exact Match': '精确匹配', 'Macro F1': '宏 F1',
  'Base Model': '基础模型', 'Manual SFT': '手动 SFT', 'Manual SFT (original)': '手动 SFT（原始）',
  'Manual SFT (w/ LLM synthesis)': '手动 SFT（使用 LLM 合成）', 'LLM synthesis': 'LLM 合成',
  'Table Vis.': '表格可视化', 'OpenHands Val': 'OpenHands 验证集', 'OpenHands Test': 'OpenHands 测试集',
  'FT-Agent Val': 'FT-Agent 验证集', 'FT-Agent Test': 'FT-Agent 测试集',
  'Mol Und': '分子理解', 'Mol Edit': '分子编辑', 'Mol Opt': '分子优化', Reaction: '反应',
  'Murcko scaffold': 'Murcko 骨架', equivalence: '等价性', 'fg count': '官能团计数', 'ring count': '环计数',
  'ring system scaffold': '环系骨架', 'add / delete': '添加/删除', substitute: '替换',
  'Forward / Retrosynthesis': '正向合成/逆合成', 'Reaction Condition': '反应条件',
  'Next Step Product': '下一步产物', 'Mechanism Selection': '机理选择',
  'Anomaly / Causal / Correlation': '异常/因果/相关性', 'Descriptive / Impact / Stat': '描述/影响/统计',
  TrendForecasting: '趋势预测', 'MatchBased / Multi-hop': '匹配式/多跳',
  'Aggregation / Arith / Comp': '聚合/算术/比较', 'Count / Domain / Multi-hop': '计数/领域/多跳',
  'Ranking / Time-based': '排序/时间型', ChartGeneration: '图表生成',
  'Valid Rate': '有效率', Scaffold: '骨架', 'Acc Equiv': '等价性准确率', 'Acc Scaffold': '骨架准确率',
}));

function normalizeTranslationTableVocabulary(value) {
  return String(value || '').split(/\r?\n/).map((line) => {
    if (!line.includes('|') || /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line)) return line;
    const leading = line.match(/^\s*/)?.[0] || '';
    const trimmedLine = line.trim();
    const hasLeadingPipe = trimmedLine.startsWith('|');
    const hasTrailingPipe = trimmedLine.endsWith('|');
    const content = trimmedLine.slice(hasLeadingPipe ? 1 : 0, hasTrailingPipe ? -1 : undefined);
    const replacements = [...TABLE_CELL_TRANSLATIONS.entries()].sort((a, b) => b[0].length - a[0].length);
    const cells = content.split('|').map((cell) => {
      const trimmed = cell.trim();
      let translated = TABLE_CELL_TRANSLATIONS.get(trimmed);
      if (!translated) {
        translated = trimmed.replace(/\(Chemistry\)/g, '（化学）').replace(/\(Table QA\)/g, '（表格问答）').replace(/\(Patent\)/g, '（专利）');
        for (const [english, chinese] of replacements) translated = translated.replaceAll(english, chinese);
        translated = translated.replace(/\bAcc(?=↑|↓|\s|$)/g, '准确率').replace(/\bQA\b/g, '问答').replace(/\bVis\.(?=\s|$)/g, '可视化');
      }
      return ` ${translated} `;
    });
    return `${leading}${hasLeadingPipe ? '|' : ''}${cells.join('|')}${hasTrailingPipe ? '|' : ''}`;
  }).join('\n');
}

function loadTranslationCheckpoint({ workDir, source, model, chunks }) {
  const checkpointPath = path.join(workDir, 'translation-checkpoint.json');
  const expected = {
    version: TRANSLATION_CHECKPOINT_VERSION,
    sourceUrl: source.sourceUrl,
    sourceSha256: source.manifest?.sha256 || '',
    model: String(model || ''),
    chunkHashes: chunks.map((chunk) => crypto.createHash('sha256').update(chunk).digest('hex')),
  };
  try {
    const saved = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    const matches = saved.version === expected.version
      && saved.sourceUrl === expected.sourceUrl
      && saved.sourceSha256 === expected.sourceSha256
      && saved.model === expected.model
      && JSON.stringify(saved.chunkHashes) === JSON.stringify(expected.chunkHashes)
      && Array.isArray(saved.translated)
      && saved.translated.length <= chunks.length
      && saved.translated.every((value) => typeof value === 'string' && value.trim());
    if (matches) return { ...expected, checkpointPath, translated: saved.translated };
  } catch {}
  return { ...expected, checkpointPath, translated: [] };
}

function saveTranslationCheckpoint(checkpoint) {
  const payload = {
    version: checkpoint.version,
    sourceUrl: checkpoint.sourceUrl,
    sourceSha256: checkpoint.sourceSha256,
    model: checkpoint.model,
    chunkHashes: checkpoint.chunkHashes,
    translated: checkpoint.translated,
    updatedAt: new Date().toISOString(),
  };
  const temporary = `${checkpoint.checkpointPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload));
    fs.renameSync(temporary, checkpoint.checkpointPath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    console.error(`[translate] checkpoint 写入失败(继续执行): ${error?.message || error}`);
  }
}

function writeFailedTranslationChunk(workDir, index, content, diagnostics) {
  try {
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, `translation-failed-chunk-${index + 1}.md`), String(content || ''));
    fs.writeFileSync(path.join(workDir, `translation-failed-chunk-${index + 1}.json`), JSON.stringify(diagnostics, null, 2));
  } catch {}
}

async function reportProgress(onProgress, progress) {
  if (typeof onProgress !== 'function') return;
  try { await onProgress(progress); }
  catch (error) { console.error(`[translate] 进度通知失败(已忽略): ${error?.message || error}`); }
}

export function extractSupplementaryAnalysisRequest(input) {
  const withoutUrls = String(input || '')
    .replace(/https?:\/\/[^\s<>()，。；：！？】【、】【【】）》〉]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = withoutUrls.match(/(?:并且|并|同时|另外|此外|然后|以及|翻译后|译完后|直译后)\s*(?:请)?(.+)$/i);
  if (!match) return '';
  const request = String(match[1] || '').trim().replace(/^[，,：:；;]+/, '').trim();
  if (!request || !/(?:讲讲|分析|解读|判断|说明|回答|讨论|比较|评价|提炼|总结|是否|哪些|什么|如何|为什么|有无|提到)/i.test(request)) return '';
  return request;
}

async function generateSupplementaryAnalysis({ request, source, workDir, model, writer, fetchFn, completeArticle, timeoutMs }) {
  const savedAnalysis = loadSupplementaryAnalysisCheckpoint({ request, source, workDir, model });
  if (savedAnalysis && !validateSupplementaryAnalysis(savedAnalysis.markdown, source.manifest).length) return savedAnalysis;
  const sourceChunks = chunkBlocks(source.blocks, 30000);
  const fullSource = source.blocks.join('\n\n');
  const literalHits = findLiteralTermHits(request, source.blocks);
  let evidence;
  let evidenceMode;
  if (fullSource.length <= 160000) {
    evidence = fullSource;
    evidenceMode = 'full-source';
  } else {
    const summaries = [];
    for (let index = 0; index < sourceChunks.length; index++) {
      const summary = await completeArticle({
        prompt: evidenceExtractionPrompt({ request, chunk: sourceChunks[index], index, total: sourceChunks.length }),
        model,
        writer: { ...writer, temperature: 0, maxTokens: Math.min(Number(writer.maxTokens) || 12000, 2500) },
        fetchFn,
        timeoutMs,
        systemPrompt: '你是原文证据提取员。只提取与用户问题有关的原文证据，不作最终结论，不补充外部知识。保留页面标记。',
      });
      summaries.push(stripOuterFence(summary));
    }
    evidence = summaries.join('\n\n');
    evidenceMode = 'chunked-evidence-map';
  }

  const prompt = supplementaryAnalysisPrompt({ request, source, evidence, evidenceMode, literalHits });
  let markdown = cleanSupplementaryAnalysis(await completeArticle({
    prompt,
    model,
    writer: { ...writer, temperature: 0, maxTokens: Math.min(Number(writer.maxTokens) || 12000, 4000) },
    fetchFn,
    timeoutMs,
    systemPrompt: '你是严谨的论文分析员。分析必须完全依据提供的原文证据，区分原文直接表述与概念对应，不使用外部信息。只输出中文 Markdown 分析正文。',
  }));

  let errors = validateSupplementaryAnalysis(markdown, source.manifest);
  if (errors.length) {
    markdown = cleanSupplementaryAnalysis(await completeArticle({
      prompt: `${prompt}\n\n上一次草稿存在这些格式或证据问题:${errors.join('; ')}\n请重新输出完整分析正文并修复。上一次草稿如下:\n${markdown}`,
      model,
      writer: { ...writer, temperature: 0, maxTokens: Math.min(Number(writer.maxTokens) || 12000, 4000) },
      fetchFn,
      timeoutMs,
      systemPrompt: '你是严谨的论文分析员。只依据提供的原文，修复全部问题。只输出中文 Markdown 分析正文。',
    }));
    errors = validateSupplementaryAnalysis(markdown, source.manifest);
  }
  if (errors.length) throw new Error(`原文依据分析门禁失败:${errors.join('; ')}`);
  const result = { markdown, evidenceMode, literalHits };
  saveSupplementaryAnalysisCheckpoint({ request, source, workDir, model, result });
  return result;
}

function loadSupplementaryAnalysisCheckpoint({ request, source, workDir, model }) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(workDir, 'translation-analysis-checkpoint.json'), 'utf8'));
    if (saved.version !== ANALYSIS_CHECKPOINT_VERSION
      || saved.request !== request
      || saved.sourceSha256 !== source.manifest?.sha256
      || saved.model !== String(model || '')
      || !saved.result?.markdown) return undefined;
    return saved.result;
  } catch { return undefined; }
}

function saveSupplementaryAnalysisCheckpoint({ request, source, workDir, model, result }) {
  const target = path.join(workDir, 'translation-analysis-checkpoint.json');
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({
      version: ANALYSIS_CHECKPOINT_VERSION,
      request,
      sourceSha256: source.manifest?.sha256 || '',
      model: String(model || ''),
      result,
      updatedAt: new Date().toISOString(),
    }));
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    console.error(`[translate] 分析 checkpoint 写入失败(继续执行): ${error?.message || error}`);
  }
}

function evidenceExtractionPrompt({ request, chunk, index, total }) {
  return `针对用户问题，从下面第 ${index + 1}/${total} 个原文分块中提取所有直接相关证据。\n用户问题:${request}\n\n要求:\n- 保留 <!-- source-page:N --> 标记，并在每条证据中写明原文页码。\n- 同时检查问题中的英文术语是否原样出现，以及是否存在仅在概念上相关的机制。\n- 没有相关证据时只写“本块未发现相关证据”。\n- 不回答最终问题，不使用外部知识。\n\n原文分块:\n${chunk}`;
}

function supplementaryAnalysisPrompt({ request, source, evidence, evidenceMode, literalHits }) {
  const pages = Number(source.manifest?.pages || 1);
  const citationRule = pages > 1
    ? '每个关键判断都要标注“（原文第 N 页）”，页码只能取自原文页面标记。'
    : '每个关键判断都要明确说明依据来自原文网页。';
  return `全文直译已经完成。现在只依据下面的原文证据，独立回答用户的附加问题。\n\n用户问题:${request}\n原文标题:${source.title || '未知'}\n证据覆盖方式:${evidenceMode}\n程序化字面检索结果:${JSON.stringify(literalHits)}\n\n硬性要求:\n- 开头直接给出结论。\n- 明确区分“原文直接使用了该术语”与“原文未使用该术语、但存在概念相近机制”，不得把后者说成前者。\n- ${citationRule}\n- 说明对应的具体机制、步骤或限制，不泛泛总结全文。\n- 不添加外部资料、常识推断或原文没有的信息。\n- 不生成 YAML frontmatter，不重复“原文依据分析”标题，不使用代码围栏。\n\n原文证据:\n${evidence}`;
}

function findLiteralTermHits(request, blocks) {
  const stopwords = new Set(['about', 'after', 'analysis', 'analyze', 'article', 'explain', 'paper', 'please', 'technique', 'techniques', 'the', 'this', 'whether']);
  const terms = [...new Set((String(request || '').match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) || [])
    .map((term) => term.toLowerCase())
    .filter((term) => !stopwords.has(term)))];
  return terms.map((term) => ({
    term,
    pages: [...new Set(blocks.flatMap((block) => {
      if (!new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(block)) return [];
      const page = Number(/<!--\s*source-page:(\d+)\s*-->/.exec(block)?.[1]);
      return Number.isFinite(page) ? [page] : ['web'];
    }))],
  }));
}

function cleanSupplementaryAnalysis(value) {
  return normalizeTranslationMarkdown(stripOuterFence(value)
    .replace(/^#{1,6}\s*原文依据分析\s*\n+/i, '')
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '')
    .trim());
}

function validateSupplementaryAnalysis(markdown, manifest = {}) {
  const errors = [];
  if (!String(markdown || '').trim()) errors.push('分析为空');
  if (/```/.test(markdown)) errors.push('分析含代码围栏');
  if (/^---\s*$/m.test(markdown)) errors.push('分析含额外 frontmatter');
  if (Number(manifest.pages || 1) > 1) {
    const cited = [...String(markdown).matchAll(/原文第\s*(\d+)\s*页/g)].map((match) => Number(match[1]));
    if (!cited.length) errors.push('分析未标注原文页码');
    const invalid = cited.filter((page) => page < 1 || page > manifest.pages);
    if (invalid.length) errors.push(`分析引用无效页码:${[...new Set(invalid)].join(',')}`);
  }
  return errors;
}

async function acquireSource({ sourceUrl, workDir, fetchFn, fetchWithRetry, trace, allowCachedPdf = false }) {
  const event = { kind: 'translation-source', endpoint: sourceUrl, status: 'running', startedAt: new Date().toISOString() };
  trace.requests.push(event);
  try {
    if (allowCachedPdf) {
      const cached = readCachedPdfSource({ sourceUrl, workDir });
      if (cached) {
        const source = extractPdfSource({ pdfBuffer: cached.pdfBuffer, sourceUrl, workDir });
        event.status = 'ok';
        event.finishedAt = new Date().toISOString();
        event.kind = 'translation-pdf-cache';
        event.pages = source.manifest.pages;
        event.blocks = source.blocks.length;
        event.assets = source.pageAssets?.length || 0;
        return source;
      }
    }
    const response = await fetchWithRetry(fetchFn, sourceUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 ZenContentHub/2.0' },
    }, { timeoutMs: 45000, retries: 2 });
    let initial;
    let pdfBuffer;
    let html;
    if (!response.ok) {
      // arXiv 的 /abs 页面偶尔会在网络层返回 404，但同编号的 /pdf 原件仍可用。
      // 直译的真实对象是 PDF，因此这里明确回退到官方 PDF，而不是把摘要页失败当作空原文。
      const fallbackPdfUrl = canonicalPdfUrl(sourceUrl);
      if (!fallbackPdfUrl) throw new Error(`原文获取失败:${response.status} ${response.statusText}`);
      const pdfResponse = await fetchWithRetry(fetchFn, fallbackPdfUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 ZenContentHub/2.0', Referer: sourceUrl },
      }, { timeoutMs: 60000, retries: 2 });
      if (!pdfResponse.ok) throw new Error(`原文获取失败:${response.status} ${response.statusText};PDF 回退失败:${pdfResponse.status} ${pdfResponse.statusText}`);
      const candidate = Buffer.from(await pdfResponse.arrayBuffer());
      if (candidate.subarray(0, 4).toString() !== '%PDF') throw new Error('arXiv PDF 回退返回的不是 PDF');
      pdfBuffer = candidate;
    } else {
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      initial = Buffer.from(await response.arrayBuffer());
      if (contentType.includes('application/pdf') || /\.pdf(?:$|[?#])/i.test(sourceUrl) || initial.subarray(0, 4).toString() === '%PDF') {
        pdfBuffer = initial;
      } else {
      html = initial.toString('utf8');
      const pdfUrl = discoverPdfUrl(html, sourceUrl) || canonicalPdfUrl(sourceUrl);
      if (pdfUrl) {
        const pdfResponse = await fetchWithRetry(fetchFn, pdfUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 ZenContentHub/2.0', Referer: sourceUrl },
        }, { timeoutMs: 60000, retries: 2 });
        if (pdfResponse.ok) {
          const candidate = Buffer.from(await pdfResponse.arrayBuffer());
          if (candidate.subarray(0, 4).toString() === '%PDF') pdfBuffer = candidate;
        }
      }
      }
    }

    const source = pdfBuffer
      ? extractPdfSource({ pdfBuffer, sourceUrl, workDir, fallbackHtml: html })
      : await extractHtmlSource({ html, sourceUrl, workDir, fetchFn, fetchWithRetry });
    event.status = 'ok';
    event.finishedAt = new Date().toISOString();
    event.kind = source.kind === 'pdf' ? 'translation-pdf' : 'translation-html';
    event.pages = source.manifest.pages;
    event.blocks = source.blocks.length;
    event.assets = source.pageAssets?.length || 0;
    return source;
  } catch (error) {
    event.status = 'failed';
    event.finishedAt = new Date().toISOString();
    event.error = error.message;
    throw error;
  }
}

export function canonicalPdfUrl(sourceUrl) {
  try {
    const url = new URL(sourceUrl);
    const arxiv = /(?:^|\.)arxiv\.org$/i.test(url.hostname);
    const match = url.pathname.match(/^\/abs\/([^/?#]+)$/i);
    if (arxiv && match) return `${url.origin}/pdf/${match[1]}.pdf`;
  } catch {}
  return undefined;
}

function readCachedPdfSource({ sourceUrl, workDir }) {
  try {
    let expectedSha;
    try {
      const checkpoint = JSON.parse(fs.readFileSync(path.join(workDir, 'translation-checkpoint.json'), 'utf8'));
      if (checkpoint.version === TRANSLATION_CHECKPOINT_VERSION && checkpoint.sourceUrl === sourceUrl) expectedSha = checkpoint.sourceSha256;
    } catch {}
    if (!expectedSha) {
      const cache = JSON.parse(fs.readFileSync(path.join(workDir, 'translation-source-cache.json'), 'utf8'));
      // 旧缓存没有记录原件类型。不能把普通网页中任意 PDF 链接当作
      // 文章原文续跑；只复用当前 PDF 获取逻辑明确写入的 v2 缓存。
      if (cache.version === 2 && cache.kind === 'pdf' && cache.sourceUrl === sourceUrl) expectedSha = cache.sha256;
    }
    if (!expectedSha) return undefined;
    const pdfBuffer = fs.readFileSync(path.join(workDir, 'translation-source.pdf'));
    const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
    if (sha256 !== expectedSha || pdfBuffer.subarray(0, 4).toString() !== '%PDF') return undefined;
    return { pdfBuffer };
  } catch { return undefined; }
}

export function extractPdfSource({ pdfBuffer, sourceUrl, workDir, fallbackHtml }) {
  requireCommand('pdftotext');
  requireCommand('pdfinfo');
  requireCommand('pdftoppm');
  requireCommand('pdfimages');
  fs.mkdirSync(workDir, { recursive: true });
  const pdfPath = path.join(workDir, 'translation-source.pdf');
  fs.writeFileSync(pdfPath, pdfBuffer);
  const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
  // 缓存只绑定到精确来源 URL 和 SHA-256。网络中断时，已验证过的同一份原始 PDF
  // 可以安全续跑；不同链接或内容绝不会复用它。
  fs.writeFileSync(path.join(workDir, 'translation-source-cache.json'), JSON.stringify({
    version: 2,
    kind: 'pdf',
    sourceUrl,
    sha256,
  }));
  const info = run('pdfinfo', [pdfPath]);
  const pages = Number(/^Pages:\s+(\d+)/mi.exec(info)?.[1] || 0);
  if (!pages) throw new Error('PDF 页数识别失败');
  const title = cleanPdfMeta(/^Title:\s+(.+)$/mi.exec(info)?.[1]) || htmlTitle(fallbackHtml) || path.basename(new URL(sourceUrl).pathname, '.pdf');
  const pageTexts = [];
  for (let page = 1; page <= pages; page++) {
    // 双栏论文用 -layout 会把左右栏横向拼接，破坏阅读顺序。-raw 会先读完
    // 左栏再进入右栏，更适合逐段直译。
    const text = run('pdftotext', ['-f', String(page), '-l', String(page), '-raw', '-nopgbrk', pdfPath, '-']);
    const normalized = normalizePdfPage(text);
    pageTexts.push(normalized);
  }
  const assetDir = path.join(workDir, 'assets');
  fs.mkdirSync(assetDir, { recursive: true });
  // 旧实现的整页截图会在手机端显示双栏英文原页。每次都清理所有上次
  // 提取的 PDF 图素材，避免共用工作目录时将旧论文的图片串进新稿。
  for (const filename of fs.readdirSync(assetDir)) {
    if (/^source-(?:page|figure)-\d+\.(?:png|jpe?g|webp)$/i.test(filename)) fs.rmSync(path.join(assetDir, filename), { force: true });
  }
  const joined = pageTexts.join('\n');
  const figures = numberedLabels(joined, /\b(?:Figure|Fig\.)\s*(\d+)/gi);
  const tables = numberedLabels(joined, /\bTable\s*(\d+)/gi);
  const pageAssets = extractEmbeddedPdfFigures({ pdfPath, assetDir, pageTexts });
  const blocks = pageTexts.map((pageText, index) => {
    const page = index + 1;
    const annotated = annotatePdfVisuals({
      text: pageText,
      page,
      figures: numberedLabels(pageText, /\b(?:Figure|Fig\.)\s*(\d+)/gi),
      tables: numberedLabels(pageText, /\bTable\s*(\d+)/gi),
      assets: pageAssets,
    });
    return `<!-- source-page:${page} -->\n${annotated}`;
  });
  return {
    kind: 'pdf',
    title,
    sourceUrl,
    blocks,
    pageAssets,
    manifest: {
      sha256,
      pages,
      figures,
      tables,
      equations: equationLabels(joined),
      assets: pageAssets.map((asset) => ({ kind: asset.kind, label: asset.label, relative: asset.relative })),
      visualSummaries: [
        ...figures.filter((label) => !pageAssets.some((asset) => asset.kind === 'figure' && asset.label === label)).map((label) => ({ kind: 'figure', label })),
        ...tables.map((label) => ({ kind: 'table', label })),
      ],
    },
  };
}

function extractEmbeddedPdfFigures({ pdfPath, assetDir, pageTexts }) {
  const list = run('pdfimages', ['-list', pdfPath]);
  const rows = list.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+image\s+(\d+)\s+(\d+)\s+/i);
    if (!match) return [];
    return [{ page: Number(match[1]), num: Number(match[2]), width: Number(match[3]), height: Number(match[4]) }];
  }).filter((row) => row.width >= 300 && row.height >= 180);
  if (!rows.length) return [];
  const temporaryDir = path.join(assetDir, `.pdfimages-${process.pid}`);
  fs.mkdirSync(temporaryDir, { recursive: true });
  const prefix = path.join(temporaryDir, 'image');
  try {
    run('pdfimages', ['-png', pdfPath, prefix]);
    const assets = [];
    for (const row of rows) {
      const pageFigures = numberedLabels(pageTexts[row.page - 1] || '', /\b(?:Figure|Fig\.)\s*(\d+)/gi);
      const imagesOnPage = rows.filter((candidate) => candidate.page === row.page);
      // 只有“一页一个嵌入图 + 一个图号”时才能无歧义对应；其余对象改用文字概括。
      if (pageFigures.length !== 1 || imagesOnPage.length !== 1) continue;
      const sourcePath = `${prefix}-${String(row.num).padStart(3, '0')}.png`;
      if (!fs.existsSync(sourcePath)) continue;
      const figure = pageFigures[0];
      const filename = `source-figure-${figure}.png`;
      const targetPath = path.join(assetDir, filename);
      fs.copyFileSync(sourcePath, targetPath);
      assets.push({ page: row.page, kind: 'figure', label: figure, path: targetPath, relative: `assets/${filename}` });
    }
    return assets;
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

function annotatePdfVisuals({ text, page, figures, tables, assets }) {
  let output = String(text || '');
  for (const figure of figures) {
    const extracted = assets.some((asset) => asset.page === page && asset.kind === 'figure' && asset.label === figure);
    if (!extracted) output = stripTopVectorFigureArtifacts(output, figure);
    const marker = extracted
      ? `<!-- source-asset:figure-${figure} -->`
      : `<!-- visual-summary-required:figure-${figure} -->`;
    output = insertMarkerBeforeCaption(output, new RegExp(`^(?:Figure|Fig\\.)\\s*${figure}\\.`, 'im'), marker);
  }
  for (const table of tables) {
    output = insertMarkerBeforeCaption(output, new RegExp(`^Table\\s*${table}\\.`, 'im'), `<!-- visual-summary-required:table-${table} -->`);
  }
  return output;
}

function stripTopVectorFigureArtifacts(text, figure) {
  const lines = String(text || '').split(/\r?\n/);
  const captionIndex = lines.findIndex((line) => new RegExp(`^(?:Figure|Fig\\.)\\s*${figure}\\.`, 'i').test(line.trim()));
  // 学术 PDF 的矢量图若位于页首，pdftotext 会先吐出坐标轴、图例和数值，再输出
  // Figure caption。只有该区段明显由大量短标签组成时才移除；普通正文不满足此条件。
  if (captionIndex < 6 || captionIndex > 100) return text;
  const candidate = lines.slice(1, captionIndex).filter((line) => line.trim());
  if (!candidate.length) return text;
  const artifactLines = candidate.filter((line) => {
    const value = line.trim();
    if (value.length <= 42) return true;
    if (!/[。！？.!?]$/.test(value) && value.length <= 72) return true;
    return /^(?:[\d.,%+\-()\s]+)$/.test(value);
  });
  if (artifactLines.length / candidate.length < 0.72) return text;
  return [lines[0], ...lines.slice(captionIndex)].join('\n');
}

function insertMarkerBeforeCaption(text, pattern, marker) {
  if (text.includes(marker)) return text;
  const match = pattern.exec(text);
  if (!match) return text;
  return `${text.slice(0, match.index)}${marker}\n${text.slice(match.index)}`;
}

async function extractHtmlSource({ html, sourceUrl, workDir, fetchFn, fetchWithRetry }) {
  if (!html) throw new Error('网页正文为空');
  const dom = new JSDOM(html, { url: sourceUrl });
  const document = dom.window.document;
  document.querySelectorAll('script,style,noscript,nav,header,footer,form,aside').forEach((node) => node.remove());
  for (const math of [...document.querySelectorAll('math')]) {
    const tex = math.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
    math.replaceWith(document.createTextNode(tex ? `$${tex}$` : cleanText(math.textContent)));
  }
  const root = document.querySelector('article,[role="main"],main') || document.body;
  const nodes = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,li,table,img')];
  const assetDir = path.join(workDir, 'assets');
  fs.mkdirSync(assetDir, { recursive: true });
  const blocks = [];
  let imageIndex = 0;
  for (const node of nodes) {
    if (node.closest('table') && node.tagName !== 'TABLE') continue;
    if (node.tagName === 'IMG') {
      const raw = node.getAttribute('src');
      if (!raw) continue;
      try {
        const url = new URL(raw, sourceUrl).toString();
        const response = await fetchWithRetry(fetchFn, url, {}, { timeoutMs: 20000, retries: 1 });
        if (!response.ok) continue;
        const type = response.headers.get('content-type') || 'image/jpeg';
        const ext = type.includes('png') ? '.png' : type.includes('gif') ? '.gif' : type.includes('webp') ? '.webp' : '.jpg';
        const filename = `source-image-${++imageIndex}${ext}`;
        fs.writeFileSync(path.join(assetDir, filename), Buffer.from(await response.arrayBuffer()));
        blocks.push(`![${node.getAttribute('alt') || `原文图片 ${imageIndex}`}](assets/${filename})`);
      } catch {}
      continue;
    }
    if (node.tagName === 'TABLE') {
      const rows = [...node.querySelectorAll('tr')].map((row) => [...row.querySelectorAll('th,td')].map((cell) => cleanText(cell.textContent)));
      if (rows.length) blocks.push(formatHtmlTable(rows));
      continue;
    }
    const text = cleanText(node.textContent);
    if (!text) continue;
    if (/^H[1-6]$/.test(node.tagName)) blocks.push(`${'#'.repeat(Number(node.tagName[1]))} ${text}`);
    else if (node.tagName === 'LI') blocks.push(`- ${text}`);
    else if (node.tagName === 'BLOCKQUOTE') blocks.push(`> ${text}`);
    else blocks.push(text);
  }
  if (!blocks.length) throw new Error('网页正文提取为空');
  const joined = blocks.join('\n\n');
  return {
    kind: 'html',
    title: htmlTitle(html) || document.title || new URL(sourceUrl).hostname,
    publishedDate: publishedDate(document),
    sourceUrl,
    blocks,
    pageAssets: [],
    manifest: {
      sha256: crypto.createHash('sha256').update(html).digest('hex'),
      pages: 1,
      figures: numberedLabels(joined, /\b(?:Figure|Fig\.)\s*(\d+)/gi),
      tables: numberedLabels(joined, /\bTable\s*(\d+)/gi),
      equations: [],
    },
  };
}

function translationPrompt({ source, chunk, index, total }) {
  return `把下面原文完整、严格、逐段翻译成简体中文。\n\n硬性要求:\n- 这是第 ${index + 1}/${total} 个连续分块，只翻译输入，不总结、不删减、不补充。\n- 保留所有 <!-- source-page:N --> 页面标记，不能改号或丢失。\n- 保留标题层级、段落顺序、列表、表格的全部单元格、图题、表题、公式、脚注和 References；表格可按手机可读的逐行记录重排，但不得删除单元格。\n- 数字、单位、专有名词、Ticker、统计符号与原文一致。\n- 不使用四空格缩进或代码围栏；公式用 LaTeX 行内文本或可读纯文本。\n- 所有英文叙述句必须翻译成中文。仅专有名词、模型/工具名、API、代码、缩写和 References 书目信息保留必要英文，禁止整句英文正文漏译。\n- <!-- source-asset:figure-N --> 标记必须原样保留，系统会在该位置插入真正的原图。\n- <!-- visual-summary-required:figure-N/table-N --> 不得保留标记；请根据邻近图题、表题和数据在原位置写一段忠实中文概括，格式为“> 图 N 内容概括：...”或“> 表 N 内容概括：...”，不得虚构图表信息。\n- 在不改变任何内容和论证顺序的前提下，每个主要章节用 Markdown 粗体标记 1-2 个核心观点或关键词；不得改写原句来制造高亮。\n- 只输出译文 Markdown，不要 frontmatter、译者说明或“续”。\n\n原文来源:${source.sourceUrl}\n\n${chunk}`;
}

export function validateTranslationCompleteness(article, manifest = {}) {
  const errors = [];
  const pages = [...String(article).matchAll(PAGE_MARKER_RE)].map((match) => Number(match[1]));
  if (manifest.pages > 1) {
    const missing = Array.from({ length: manifest.pages }, (_, i) => i + 1).filter((page) => !pages.includes(page));
    if (missing.length) errors.push(`缺少原文页码:${missing.join(',')}`);
  }
  for (const [kind, labels, patterns] of [
    ['图', manifest.figures, [/图\s*(\d+)/g, /Figure\s*(\d+)/gi]],
    ['表', manifest.tables, [/表\s*(\d+)/g, /Table\s*(\d+)/gi]],
    ['公式', manifest.equations, [/公式[（(]\s*(\d+)/g, /\((\d+)\)/g]],
  ]) {
    const present = new Set(patterns.flatMap((pattern) => [...String(article).matchAll(pattern)].map((match) => Number(match[1]))));
    const missing = (labels || []).filter((label) => !present.has(label));
    if (missing.length) errors.push(`缺少${kind}编号:${missing.join(',')}`);
  }
  if (/```/.test(article)) errors.push('含代码围栏');
  if (String(article).split(/\r?\n/).some((line) => /^ {4,}\S/.test(line))) errors.push('含四空格缩进块');
  if (/source-page-\d+\.png/i.test(article)) errors.push('含禁止发布的 PDF 整页截图');
  if (/<!--\s*(?:source-asset|visual-summary-required):/i.test(article)) errors.push('含未处理的图表占位标记');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(String(article))) errors.push('含 PDF 提取控制字符');
  if (hasLeakingBlockquote(String(article))) errors.push('图表概括引用块未与后续正文分隔');
  const untranslated = findUntranslatedEnglishLines(article);
  // 每个翻译分块已经执行“修复一次后仍有英文正文则拒绝”的严格门禁。全文拼接后
  // 可能只剩标题、作者、模型名或分析中的必要术语；少量疑似项不应阻断可读草稿。
  // 只有汇总阶段仍出现多处明显英文段落时才拒绝发布。
  if (untranslated.length > 3) errors.push(`疑似未翻译英文正文 ${untranslated.length} 行`);
  for (const asset of manifest.assets || []) {
    if (asset.relative && !String(article).includes(asset.relative)) errors.push(`缺少原图素材:${asset.kind} ${asset.label}`);
  }
  for (const visual of manifest.visualSummaries || []) {
    const prefix = visual.kind === 'figure' ? '图' : '表';
    if (!new RegExp(`(?:^|\\n)\\s*>\\s*${prefix}\\s*${visual.label}\\s*内容概括[：:]`, 'm').test(String(article || ''))) {
      errors.push(`缺少${prefix}${visual.label}中文内容概括`);
    }
  }
  return { errors, pagesFound: [...new Set(pages)].sort((a, b) => a - b) };
}

function chunkBlocks(blocks, maxChars) {
  const chunks = [];
  let current = '';
  for (const block of blocks) {
    const value = String(block || '').trim();
    if (!value) continue;
    if (current && current.length + value.length + 2 > maxChars) {
      chunks.push(current);
      current = '';
    }
    current += `${current ? '\n\n' : ''}${value}`;
  }
  if (current) chunks.push(current);
  return chunks;
}

function injectPageAssets(body, assets) {
  let out = body;
  for (const asset of assets) {
    const marker = `<!-- source-asset:${asset.kind}-${asset.label} -->`;
    out = out.replace(marker, `![原文图 ${asset.label}](${asset.relative})`);
  }
  return out;
}

function hasLeakingBlockquote(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!/^\s*>/.test(lines[index])) continue;
    const next = lines[index + 1];
    if (next && !/^\s*>/.test(next)) return true;
  }
  return false;
}

function translationRepairPrompt({ sourceChunk, content, untranslated, visualMarkers, missingAssetMarkers, missingPageMarkers, missingVisualSummaries }) {
  return `下面是一段完整论文译文，需要做一次无删减校对。请返回完整修订稿。\n\n硬性要求:\n- 不删减、不总结、不改变段落、页面标记、图表概括、图片标记、数字、公式、代码和 References。\n- 专有名词、模型/工具名、API、缩写可保留英文；普通英文叙述句必须译成中文。\n- 将每个 <!-- visual-summary-required:figure-N/table-N --> 替换成基于邻近图题、表题和数据的忠实中文概括，格式为“> 图 N 内容概括：...”或“> 表 N 内容概括：...”，不得虚构。\n- 下列丢失的原图标记必须在对应图题前原样恢复：${missingAssetMarkers.join('、') || '无'}。\n- 下列丢失的页面标记必须按原文分块中的位置原样恢复：${missingPageMarkers.join('、') || '无'}。\n- 下列缺失的图表概括必须依据原文分块中的图题、表题和数据补回对应位置：${missingVisualSummaries.join('、') || '无'}。\n- 不使用代码围栏或四空格缩进。\n\n疑似漏译行示例:\n${untranslated.slice(0, 12).join('\n') || '无'}\n\n待处理图表占位符:\n${visualMarkers.join('\n') || '无'}\n\n原文分块（只用于核对位置和缺失内容，不得复制英文正文）：\n${sourceChunk}\n\n待修订全文:\n${content}`;
}

function findPendingVisualSummaryMarkers(value) {
  return [...String(value || '').matchAll(/<!--\s*visual-summary-required:([^>]+)\s*-->/gi)].map((match) => match[0]);
}

function findMissingAssetMarkers(source, translated) {
  const expected = [...new Set([...String(source || '').matchAll(/<!--\s*source-asset:([^>]+)\s*-->/gi)].map((match) => match[0]))];
  return expected.filter((marker) => !String(translated || '').includes(marker));
}

function findMissingPageMarkers(source, translated) {
  const expected = [...new Set([...String(source || '').matchAll(PAGE_MARKER_RE)].map((match) => Number(match[1])))];
  const present = new Set([...String(translated || '').matchAll(PAGE_MARKER_RE)].map((match) => Number(match[1])));
  return expected.filter((page) => !present.has(page));
}

function findMissingVisualSummaries(source, translated) {
  const expected = [...new Set([...String(source || '').matchAll(/<!--\s*visual-summary-required:(figure|table)-(\d+)\s*-->/gi)]
    .map((match) => `${match[1].toLowerCase()}-${Number(match[2])}`))];
  return expected.filter((item) => {
    const [kind, label] = item.split('-');
    const prefix = kind === 'figure' ? '图' : '表';
    return !new RegExp(`(?:^|\\n)\\s*>\\s*${prefix}\\s*${label}\\s*内容概括[：:]`, 'm').test(String(translated || ''));
  });
}

export function findUntranslatedEnglishLines(value) {
  let inBibliography = false;
  const proseLines = String(value || '').split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (/^(?:#{1,6}\s*)?(?:参考文献|References)\s*$/i.test(trimmed)) {
      inBibliography = true;
      return false;
    }
    if (inBibliography && /^(?:#{1,6}\s*)?(?:附录|Appendix)(?:\s|$|[:：])/i.test(trimmed)) {
      inBibliography = false;
    }
    return !inBibliography;
  });
  return proseLines.map((line) => line.trim()).filter((line) => {
    if (!line || /<!--|https?:\/\//i.test(line) || /^!\[/.test(line)) return false;
    // Markdown 脚注定义常承载作者、论文题名和出版信息；与 References 的
    // 书目信息相同，不属于待翻译的叙述正文。只豁免定义行，正文中的脚注引用
    // 及任何英文段落仍会照常接受漏译检查。
    if (/^\[\^[^\]]+\]:\s*/.test(line) || /^\\\*[^:\n]{1,160}:/.test(line) || /^†[^:\n]{1,160}:/.test(line)) return false;
    if (/^\|/.test(line) || /^\s*>\s*(?:图|表)\s*\d+\s*内容概括/.test(line)) return false;
    // 作者名 + 引号内题名是行内文献引注，不是英语叙述句；移除后再做漏译判断。
    // 这样不会放过普通英文正文，同时允许原文的完整参考信息保留。
    const checkLine = line.replace(/[A-Z][A-Za-z.-]+(?:\s+[A-Z][A-Za-z.-]+){1,5},\s*[“"][^”"]{5,240}[”"]\.?/g, '');
    const words = checkLine.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    const letters = (checkLine.match(/[A-Za-z]/g) || []).length;
    const compact = checkLine.replace(/\s/g, '');
    const hasHan = /\p{Script=Han}/u.test(checkLine);
    if (!hasHan) return words.length >= 10 && letters / Math.max(1, compact.length) > 0.65;

    // 译文里允许模型名、API、缩写和作者名，但不允许将英文的章节标签或
    // 一个完整英文从句夹在中文句子中，例如“Table 2 展示…”。
    if (/^(?:#{1,6}\s*)?(?:Table\b|Figure\b|Fig\.?\b|Appendix\b|Section\b|Chapter\b|Equation\b)\s*[A-Z]?\.?\d*/i.test(checkLine)) return true;
    const englishRuns = checkLine.match(/(?:[A-Za-z][A-Za-z'-]*\s+){3,}[A-Za-z][A-Za-z'-]*/g) || [];
    return englishRuns.some((run) => {
      const runWords = run.match(/[A-Za-z][A-Za-z'-]*/g) || [];
      return runWords.length >= 4 && /\b(?:the|this|that|these|those|is|are|was|were|with|from|for|and|or|but|we|our|they|their|can|will|does|do)\b/i.test(run);
    });
  });
}

function formatHtmlTable(rows) {
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: width }, (_, i) => String(row[i] || '').replace(/\|/g, '\\|')));
  if (width <= 4) {
    const header = normalized[0];
    return [
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      ...normalized.slice(1).map((row) => `| ${row.join(' | ')} |`),
    ].join('\n');
  }
  const headers = normalized[0].map((value, index) => value || `第 ${index + 1} 列`);
  return [
    `**原文表格（${width} 列，按行展开）**`,
    ...normalized.slice(1).map((row, rowIndex) => `- 第 ${rowIndex + 1} 行：${row.map((value, index) => `${headers[index]}=${value}`).join('；')}`),
  ].join('\n');
}

export function discoverPdfUrl(html, baseUrl) {
  if (!html) return undefined;
  // citation_pdf_url 是学术页面明确声明的原文 PDF，优先且唯一地自动接受。
  // 不扫描页面中任意 .pdf 链接：新闻页和产品页经常嵌入示例/下载材料，
  // 它们并不是用户要求翻译的正文。
  const citationPatterns = [
    /<meta[^>]+name=["']citation_pdf_url["'][^>]+content=["']([^"']+)/i,
    /<meta[^>]+content=["']([^"']+\.pdf[^"']*)["'][^>]+name=["']citation_pdf_url["']/i,
  ];
  for (const pattern of citationPatterns) {
    const value = pattern.exec(html)?.[1];
    if (value) return new URL(value.replace(/&amp;/g, '&'), baseUrl).toString();
  }
  // SSRN 少数页面没有 citation_pdf_url，但官方 Delivery.cfm 仍能唯一表明
  // 论文原件；仅为该来源保留兼容分支。
  try {
    const page = new URL(baseUrl);
    if (!/(?:^|\.)ssrn\.com$/i.test(page.hostname)) return undefined;
    const value = /href=["']([^"']+Delivery\.cfm(?:\?[^"']*)?)["']/i.exec(html)?.[1];
    return value ? new URL(value.replace(/&amp;/g, '&'), baseUrl).toString() : undefined;
  } catch {}
  return undefined;
}

function extractUrls(text) {
  // Slack/中文自然语言里 URL 后常直接接全角逗号、句号或右括号；这些字符不能
  // 进入 URL，更不能被写到 HTTP Referer 头中。
  return (String(text || '').match(/https?:\/\/[^\s<>()，。；：！？、】【】）》〉]+/g) || [])
    .map((url) => url.replace(/[.,;:!?)\]}>，。；：！？、】【】）》〉]+$/, ''));
}
function titleFromInput(input) { return String(input || '').replace(/https?:\/\/\S+/g, '').trim().slice(0, 80); }
function htmlTitle(html) { return cleanText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '')?.[1]); }
function publishedDate(document) { return document.querySelector('meta[property="article:published_time"],meta[name="date"],time[datetime]')?.getAttribute('content') || document.querySelector('time[datetime]')?.getAttribute('datetime') || undefined; }
function cleanText(value) { return String(value || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }
function cleanPdfMeta(value) { const text = cleanText(value); return /^(?:untitled|none)$/i.test(text) ? '' : text; }
function normalizePdfPage(value) { return String(value || '').replace(/\r/g, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim(); }
function numberedLabels(text, pattern) { return [...new Set([...String(text).matchAll(pattern)].map((match) => Number(match[1])).filter(Number.isFinite))].sort((a, b) => a - b); }
function equationLabels(text) {
  const standalone = numberedLabels(text, /(?:^|\n)\s*\((\d{1,3})\)\s*(?:\n|$)/g);
  const inlineFormula = numberedLabels(text, /(?:^|\n)[^\n]*[=≤≥⊆∈][^\n]*\((\d{1,3})\)\s*(?:\n|$)/g);
  return [...new Set([...standalone, ...inlineFormula])].sort((a, b) => a - b);
}
function escapeRegExp(value) { return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function stripOuterFence(value) { const text = String(value || '').trim(); const match = text.match(/^```(?:markdown|md)?\s*([\s\S]*?)\s*```$/i); return match ? match[1].trim() : text; }
function yamlScalar(value) { return JSON.stringify(String(value || '').replace(/\n/g, ' ')); }
function escapeMarkdown(value) { return String(value || '').replace(/[\[\]]/g, '\\$&'); }

export function requireCommand(command, { spawn = spawnSync, exists = fs.existsSync } = {}) {
  const result = spawn(command, ['-v'], { encoding: 'utf8' });
  if (result.error?.code !== 'ENOENT') return;
  const installedOutsidePath = [
    `/opt/homebrew/bin/${command}`,
    `/usr/local/bin/${command}`,
  ].some((candidate) => exists(candidate));
  if (installedOutsidePath) {
    throw new Error(`Poppler 已安装,但 Bot 服务环境找不到 ${command};请重新运行 scripts/install-launchd.sh 刷新 launchd PATH`);
  }
  throw new Error(`直译 PDF 缺少 Poppler 命令 ${command};请先运行 brew install poppler`);
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败:${String(result.stderr || '').slice(0, 300)}`);
  return result.stdout || '';
}
