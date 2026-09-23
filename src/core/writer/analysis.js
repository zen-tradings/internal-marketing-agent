import { renderQuarterlyCharts } from '../../lib/quarterly-chart.js';
import { editorialTraceFromBrief, macroEditorialTraceFromBrief } from '../../lib/editorial-skill.js';
import { throwIfTaskCancelled } from '../../lib/task-cancellation.js';
import { OPTIONS_STRATEGY_PROFILE, optionsStrategyWritingGuidance } from '../../lib/options-strategy-route.js';
import { AnalysisNeedsInputError, appendDeterministicReferences, applyAuditIssues, buildAuditPrompt, buildCoreRepairPrompt, buildEvidencePrompt, buildPlanningPrompt, buildWritingPrompt, fallbackTaskContract, inferNumericCriticalClaims, normalizeAuditCriticalClaims, normalizeAuditIssues, normalizeCoreRepairs, normalizeEvidenceMatrix, normalizePlanningResult, selectFinalReferenceIds } from '../analysis-v2.js';
import { completeReviewJson, completeArticle, summarizeInferenceTelemetry, positiveNumber } from './model-client.js';
import { ANALYSIS_V2_SYSTEM_PROMPT, normalizeAnalysisArticle, sourceForTrace, sourcePriorityTier, validateArticleSourceContract, citationValidationSummary, formatAsOf } from './shared.js';
import { TRACE_WRITE_THROTTLE_MS, writeResearchTrace } from './trace.js';
import { searchExaV2 } from './research.js';
import { describeFetchError } from '../../lib/fetch-retry.js';

export async function runAnalysisV2({
  workflow,
  input,
  config,
  writer,
  generationWriter,
  model,
  plannerModel,
  evidenceModel,
  reviewModel,
  generationTimeoutMs,
  modelProfile,
  fetchFn,
  trace,
  researchTracePath,
  taskContext,
  signal,
}) {
  trace.pipelineVersion = 'v2';
  trace.analysisInference = { requests: [], summary: summarizeInferenceTelemetry([]) };
  let lastAnalysisTraceWriteMs = 0;
  const onAnalysisInferenceTelemetry = (event) => {
    trace.analysisInference.requests.push(event);
    trace.analysisInference.summary = summarizeInferenceTelemetry(trace.analysisInference.requests);
    // Trace persistence is throttled: every inference event already recomputes the summary,
    // and rewriting the full trace file per event turns long runs into O(n²) synchronous IO.
    const nowMs = Date.now();
    if (nowMs - lastAnalysisTraceWriteMs >= TRACE_WRITE_THROTTLE_MS) {
      lastAnalysisTraceWriteMs = nowMs;
      writeResearchTrace(researchTracePath, trace);
    }
  };
  const analysis = config.analysis || {};
  const maxQueries = positiveNumber(analysis.searchMaxQueries, 8);
  const recentWindowDays = positiveNumber(analysis.recentWindowDays, 60);
  const profileGuidance = modelProfile === OPTIONS_STRATEGY_PROFILE
    ? optionsStrategyWritingGuidance(workflow.id)
    : '';
  const planningPrompt = `${buildPlanningPrompt(input, workflow, taskContext, {
    maxQueries,
    recentWindowDays,
  })}${profileGuidance ? `\n\n${profileGuidance}\n规划与搜索必须收集验证这些边界所需的来源；不得在规划阶段虚构期权链数据。` : ''}`;
  let rawPlanning;
  try {
    rawPlanning = await completeReviewJson({
      prompt: planningPrompt,
      model: plannerModel,
      reasoningEffort: modelProfile === OPTIONS_STRATEGY_PROFILE
        ? generationWriter.reasoningEffort
        : writer.plannerReasoningEffort,
      writer: { ...generationWriter, temperature: 0 },
      fetchFn,
      timeoutMs: generationTimeoutMs,
      systemPrompt: '你是分析任务规划器。Slack 原始 Prompt 是不可修改的任务合同。只返回有效 JSON。',
      onTelemetry: onAnalysisInferenceTelemetry,
      inferenceContext: { stage: 'planner' },
    });
  } catch (error) {
    if (modelProfile === OPTIONS_STRATEGY_PROFILE) {
      throw new Error(`期权策略规划失败:${describeFetchError(error).slice(0, 500)}`);
    }
    trace.planningFallback = describeFetchError(error).slice(0, 500);
    rawPlanning = {
      task_contract: fallbackTaskContract(input, workflow, taskContext),
      search_plan: [],
    };
  }
  const { taskContract, searchPlan } = normalizePlanningResult(
    rawPlanning,
    input,
    workflow,
    taskContext,
    { maxQueries },
  );
  trace.taskContract = taskContract;
  trace.searchPlan = searchPlan;
  trace.sourcePolicy = {
    kind: 'analysis-v2',
    promptFirst: true,
    userLinksFirst: true,
    officialFirst: true,
    bilingualSearchRequired: ['zh', 'en'],
    preferEnglishWithinTier: true,
    preferIndependentThirdPartyAnyLanguage: true,
    excludeGovernmentFundedMedia: true,
    minOfficialSources: 0,
    maxReferences: 5,
  };
  writeResearchTrace(researchTracePath, trace);
  if (taskContract.clarification_needed) {
    throw new AnalysisNeedsInputError(
      taskContract.clarification_question || '请确认任务中的核心实体、版本或写作要求。',
      { kind: 'task-contract', taskContract },
    );
  }

  const searchedSources = await searchExaV2({
    taskContract,
    searchPlan,
    workflow,
    writer,
    fetchFn,
    trace,
    taskContext,
    config,
    recentWindowDays,
    asOf: new Date(),
  });
  const sources = mergeInjectedSources(taskContext.qdiiSources, searchedSources);
  throwIfTaskCancelled(signal);
  if (!sources.length) {
    throw new Error(
      taskContract.user_urls.length
        ? '用户来源无法读取，且未检索到可核验的补充材料；任务已停止，未进入写作。'
        : '未检索到与任务直接相关的可靠材料；任务已停止，未进入写作。',
    );
  }
  if ((taskContract.user_urls.length || taskContract.user_attachments?.length)
    && !sources.some((source) => source.userSpecified)) {
    trace.userSourceWarning = {
      kind: 'user-source-unavailable',
      userUrls: taskContract.user_urls,
      userAttachments: taskContract.user_attachments,
      fetchError: trace.userSourceError,
      directErrors: trace.directUserSourceErrors,
      continuedWithIndependentSources: true,
    };
  }

  let rawEvidence;
  try {
    rawEvidence = await completeReviewJson({
      prompt: `${buildEvidencePrompt(taskContract, sources, workflow)}${profileGuidance ? `\n\n${profileGuidance}\n证据矩阵必须明确哪些具体期权参数具备完整报价依据，缺少依据的参数不得进入 safe_statements。` : ''}`,
      model: evidenceModel,
      reasoningEffort: modelProfile === OPTIONS_STRATEGY_PROFILE
        ? generationWriter.reasoningEffort
        : writer.plannerReasoningEffort,
      writer: { ...generationWriter, temperature: 0 },
      fetchFn,
      timeoutMs: generationTimeoutMs,
      systemPrompt: '你是研究证据编辑。只依据给定来源建立证据矩阵，只返回有效 JSON。',
      onTelemetry: onAnalysisInferenceTelemetry,
      inferenceContext: { stage: 'evidence' },
    });
  } catch (error) {
    if (modelProfile === OPTIONS_STRATEGY_PROFILE) {
      throw new Error(`期权策略证据整理失败:${describeFetchError(error).slice(0, 500)}`);
    }
    trace.evidenceFallback = describeFetchError(error).slice(0, 500);
    rawEvidence = {};
  }
  const evidenceMatrix = normalizeEvidenceMatrix(rawEvidence, sources, taskContract, workflow);
  const primaryIds = new Set(
    evidenceMatrix.source_assessments
      .filter((assessment) => assessment.source_type === 'primary')
      .map((assessment) => assessment.source_id),
  );
  for (const source of sources) {
    if (primaryIds.has(source.id)) {
      source.official = true;
      source.independentThirdParty = false;
    }
  }
  trace.evidenceMatrix = evidenceMatrix;
  if (evidenceMatrix.editorial_brief) {
    trace.editorialSkill = editorialTraceFromBrief(evidenceMatrix.editorial_brief);
  }
  if (evidenceMatrix.macro_brief) {
    const macroTrace = macroEditorialTraceFromBrief(evidenceMatrix.macro_brief);
    trace.editorialSkills = [trace.editorialSkill, macroTrace].filter(Boolean);
    trace.macroBrief = macroTrace;
  }
  trace.selectedSources = sources.map((source) => ({ id: source.id, ...sourceForTrace(source) }));
  trace.officialSourceCount = sources.filter((source) => source.official).length;
  trace.sourceTiers = {
    firstPriority: sources.filter((source) => sourcePriorityTier(source) === 1).length,
    specialist: sources.filter((source) => sourcePriorityTier(source) === 2).length,
    open: sources.filter((source) => sourcePriorityTier(source) === 3).length,
  };
  trace.researchLanes = [...new Set(trace.requests.map((request) => request.kind).filter(Boolean))];
  writeResearchTrace(researchTracePath, trace);
  if (evidenceMatrix.clarification_needed && taskContext?.resolvedClarification?.answered) {
    trace.suppressedClarification = {
      reason: '用户已在同一线程回答过一次核心确认，继续按完整线程上下文写作',
      previousQuestion: taskContext.resolvedClarification.question,
      proposedQuestion: evidenceMatrix.clarification_question,
    };
    evidenceMatrix.clarification_needed = false;
    evidenceMatrix.clarification_question = '';
  }
  if (evidenceMatrix.clarification_needed) {
    throw new AnalysisNeedsInputError(
      evidenceMatrix.clarification_question || '核心证据存在冲突，请确认后继续。',
      {
        kind: 'evidence-conflict',
        conflicts: evidenceMatrix.conflicts,
        entities: evidenceMatrix.entities,
        taskContract,
      },
    );
  }
  if (!evidenceMatrix.relevant_source_ids.length) {
    throw new Error('检索结果与原始 Prompt 的核心要求不匹配，已停止生成以避免无依据写作。');
  }
  if (!evidenceMatrix.selected_reference_ids.length) {
    throw new Error('没有可用于独立事实佐证和最终引用的合格来源，已停止生成；用户主动提供的受政府资助媒体仅可作为上下文。');
  }

  const prompt = buildWritingPrompt({
    contract: taskContract,
    evidenceMatrix,
    sources,
    workflow,
    asOf: formatAsOf(new Date()),
    optionsStrategyGuidance: profileGuidance,
  });
  const maxPromptChars = positiveNumber(writer.maxPromptChars, 160000);
  if (prompt.length > maxPromptChars) {
    throw new Error(`生成输入超过全局上限:${prompt.length}/${maxPromptChars} 字符;请减少链接或缩短素材`);
  }
  const writingTruncationSignal = {};
  const content = await completeArticle({
    prompt,
    model,
    writer: generationWriter,
    fetchFn,
    timeoutMs: generationTimeoutMs,
    systemPrompt: ANALYSIS_V2_SYSTEM_PROMPT,
    truncationSignal: writingTruncationSignal,
    onTelemetry: onAnalysisInferenceTelemetry,
    inferenceContext: { stage: 'writing' },
  });
  throwIfTaskCancelled(signal);
  if (writingTruncationSignal.truncated) {
    throw new Error('分析写作输出被 max_tokens 截断(finish_reason=length);请提高 OPENROUTER_MAX_TOKENS 后重试');
  }
  let article = renderQuarterlyCharts(normalizeAnalysisArticle(content, taskContract));
  const audit = await auditAnalysisV2({
    article,
    taskContract,
    evidenceMatrix,
    sources,
    workflow,
    writer,
    model: reviewModel,
    fetchFn,
    trace,
    researchTracePath,
    onTelemetry: onAnalysisInferenceTelemetry,
  });
  article = audit.article;
  const initialReferenceIds = [...evidenceMatrix.selected_reference_ids];
  const finalReferenceIds = workflow.id === 'macro'
    ? selectFinalReferenceIds({
        initialReferenceIds,
        criticalClaims: audit.review.criticalClaims,
        auditReview: audit.review,
        sources,
        maxReferences: 5,
      })
    : initialReferenceIds;
  if (workflow.id === 'macro') evidenceMatrix.initial_selected_reference_ids = initialReferenceIds;
  evidenceMatrix.selected_reference_ids = finalReferenceIds;
  if (workflow.id === 'macro') {
    trace.referenceSelection = {
      initialReferenceIds,
      criticalClaimEvidenceIds: [...new Set((audit.review.criticalClaims || [])
        .flatMap((claim) => claim.evidence_ids || []))],
      finalReferenceIds,
    };
  }
  article = appendDeterministicReferences(
    article,
    sources,
    finalReferenceIds,
    5,
  );
  const sourcePolicy = {
    requireCitations: true,
    referenceStyle: 'terminal-list',
    minReferences: 1,
    maxReferences: 5,
    requireUserSource: false,
  };
  validateArticleSourceContract(article, sources, sourcePolicy);
  trace.factReview = audit.review;
  trace.citationValidation = citationValidationSummary(article, sources, sourcePolicy);
  trace.finishedAt = new Date().toISOString();
  writeResearchTrace(researchTracePath, trace);
  return {
    article,
    sources,
    warnings: audit.warnings,
    contentPolicy: taskContract.content_policy,
  };
}

export function mergeInjectedSources(injected, searched) {
  const output = [];
  const seen = new Set();
  for (const source of [...(Array.isArray(injected) ? injected : []), ...(Array.isArray(searched) ? searched : [])]) {
    const key = String(source?.url || source?.id || `${source?.title}\u0000${source?.text}`).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(source);
  }
  return output;
}

export async function auditAnalysisV2({
  article,
  taskContract,
  evidenceMatrix,
  sources,
  workflow,
  writer,
  model,
  fetchFn,
  trace,
  researchTracePath,
  onTelemetry,
}) {
  const warnings = [];
  let firstRaw;
  try {
    firstRaw = await completeReviewJson({
      prompt: buildAuditPrompt({ article, contract: taskContract, evidenceMatrix, sources }),
      model: writer.reviewModel || model,
      writer: { ...writer, temperature: 0 },
      fetchFn,
      timeoutMs: workflow.timeoutMs,
      systemPrompt: '你是逐句事实审计员。只定位原文中的问题，不得重写全文，只返回有效 JSON。',
      onTelemetry,
      inferenceContext: { stage: 'audit' },
    });
  } catch (error) {
    const message = `事实审计服务不可用，已保留证据约束稿:${describeFetchError(error).slice(0, 240)}`;
    warnings.push(message);
    return {
      article,
      warnings,
      review: { approved: true, skipped: true, reason: message },
    };
  }
  const detectedIssues = normalizeAuditIssues(firstRaw, article, evidenceMatrix, taskContract);
  const firstCriticalClaims = evidenceMatrix.macro_brief
    ? uniqueCriticalClaims([
        ...normalizeAuditCriticalClaims(firstRaw, article, evidenceMatrix),
        ...inferNumericCriticalClaims(article, evidenceMatrix),
      ])
    : [];
  let firstIssues = detectedIssues;
  const coreDeleteIssues = firstIssues.filter((issue) => issue.impact === 'core' && issue.action === 'delete');
  let coreRepair;
  if (coreDeleteIssues.length) {
    let repairRaw;
    try {
      repairRaw = await completeReviewJson({
        prompt: buildCoreRepairPrompt({
          article,
          issues: coreDeleteIssues,
          evidenceMatrix,
          sources,
        }),
        model: writer.reviewModel || model,
        writer: { ...writer, temperature: 0 },
        fetchFn,
        timeoutMs: workflow.timeoutMs,
        systemPrompt: '你是核心论点局部修复员。只返回由给定证据直接支持的逐句替换 JSON，不得重写全文。',
        onTelemetry,
        inferenceContext: { stage: 'core-repair', pass: 1 },
      });
    } catch (error) {
      throw new Error(`核心论点删除后无法完成局部补写:${describeFetchError(error).slice(0, 240)}`);
    }
    coreRepair = normalizeCoreRepairs(repairRaw, coreDeleteIssues, evidenceMatrix);
    if (coreRepair.unresolved.length) {
      throw new Error(`核心论点缺乏证据且局部补写仍无法成立:${coreRepair.unresolved.map((quote) => quote.slice(0, 120)).join(' | ')}`);
    }
    const repairMap = new Map(coreRepair.repairs.map((item) => [item.article_quote, item]));
    firstIssues = firstIssues.map((issue) => {
      const repair = repairMap.get(issue.article_quote);
      return repair
        ? { ...issue, action: 'replace', replacement: repair.replacement, evidence_ids: repair.evidence_ids }
        : issue;
    });
  }
  const firstApplied = applyAuditIssues(article, firstIssues);
  trace.factReview = {
    approved: true,
    detected: detectedIssues,
    applied: firstApplied.applied,
    retained: firstApplied.retained,
    criticalClaims: firstCriticalClaims,
    repaired: firstApplied.applied.length > 0,
    ...(coreRepair ? { coreRepair } : {}),
  };
  writeResearchTrace(researchTracePath, trace);
  if (!detectedIssues.length) {
    return {
      article,
      warnings,
      review: {
        approved: true,
        detected: [],
        applied: [],
        retained: [],
        criticalClaims: firstCriticalClaims,
        repaired: false,
      },
    };
  }

  for (const issue of firstApplied.applied) {
    warnings.push(issue.action === 'delete'
      ? `事实审计已自动删除高风险无支持表述:${issue.article_quote.slice(0, 160)}`
      : `事实审计已自动局部修正:${issue.article_quote.slice(0, 160)}`);
  }
  for (const issue of firstApplied.retained) {
    warnings.push(`事实审计已保留待人工复核(${issue.confidence}/${issue.risk}/${issue.impact}):${issue.article_quote.slice(0, 160)}`);
  }
  // Second full-article audit is expensive; run it only when the first pass made high-risk or
  // core-impact edits (verify the repairs) or kept high-risk claims (check remaining text).
  // Low-risk local edits are already surfaced as warnings and do not justify another full pass.
  const needsSecondAudit = firstApplied.applied.some((issue) => issue.risk === 'high' || issue.impact === 'core')
    || firstApplied.retained.some((issue) => issue.risk === 'high');
  if (!needsSecondAudit) {
    trace.factReview.secondAuditSkipped = true;
    return {
      article: firstApplied.article,
      warnings,
      review: trace.factReview,
    };
  }
  let secondRaw;
  try {
    secondRaw = await completeReviewJson({
      prompt: buildAuditPrompt({
        article: firstApplied.article,
        contract: taskContract,
        evidenceMatrix,
        sources,
      }),
      model: writer.reviewModel || model,
      writer: { ...writer, temperature: 0 },
      fetchFn,
      timeoutMs: workflow.timeoutMs,
      systemPrompt: '你是局部修复复核员。只复核已经局部修改的句子及当前稿件剩余的高风险事实；不得重复报告已保留的低风险问题，不得重写全文，只返回有效 JSON。',
      onTelemetry,
      inferenceContext: { stage: 'audit-verify' },
    });
  } catch (error) {
    const message = `局部复核服务不可用，已保留第一次确定性修复:${describeFetchError(error).slice(0, 240)}`;
    warnings.push(message);
    return {
      article: firstApplied.article,
      warnings,
      review: {
        approved: true,
        detected: detectedIssues,
        applied: firstApplied.applied,
        retained: firstApplied.retained,
        criticalClaims: firstCriticalClaims
          .filter((claim) => firstApplied.article.includes(claim.article_quote)),
        repaired: firstApplied.applied.length > 0,
        verificationSkipped: message,
      },
    };
  }
  const retainedQuotes = new Set(firstApplied.retained.map((issue) => issue.article_quote));
  let secondIssues = normalizeAuditIssues(
    secondRaw,
    firstApplied.article,
    evidenceMatrix,
    taskContract,
  ).filter((issue) => !retainedQuotes.has(issue.article_quote));
  const secondCoreDeletes = secondIssues.filter((issue) => issue.impact === 'core' && issue.action === 'delete');
  let secondCoreRepair;
  if (secondCoreDeletes.length) {
    if (coreRepair) {
      throw new Error(`核心论点局部补写后复核仍无法成立:${secondCoreDeletes.map((issue) => issue.article_quote.slice(0, 120)).join(' | ')}`);
    }
    let repairRaw;
    try {
      repairRaw = await completeReviewJson({
        prompt: buildCoreRepairPrompt({
          article: firstApplied.article,
          issues: secondCoreDeletes,
          evidenceMatrix,
          sources,
        }),
        model: writer.reviewModel || model,
        writer: { ...writer, temperature: 0 },
        fetchFn,
        timeoutMs: workflow.timeoutMs,
        systemPrompt: '你是核心论点局部修复员。只返回由给定证据直接支持的逐句替换 JSON，不得重写全文。',
        onTelemetry,
        inferenceContext: { stage: 'core-repair', pass: 2 },
      });
    } catch (error) {
      throw new Error(`核心论点删除后无法完成局部补写:${describeFetchError(error).slice(0, 240)}`);
    }
    secondCoreRepair = normalizeCoreRepairs(repairRaw, secondCoreDeletes, evidenceMatrix);
    if (secondCoreRepair.unresolved.length) {
      throw new Error(`核心论点缺乏证据且局部补写仍无法成立:${secondCoreRepair.unresolved.map((quote) => quote.slice(0, 120)).join(' | ')}`);
    }
    const repairMap = new Map(secondCoreRepair.repairs.map((item) => [item.article_quote, item]));
    secondIssues = secondIssues.map((issue) => {
      const repair = repairMap.get(issue.article_quote);
      return repair
        ? { ...issue, action: 'replace', replacement: repair.replacement, evidence_ids: repair.evidence_ids }
        : issue;
    });
  }
  const secondApplied = applyAuditIssues(firstApplied.article, secondIssues);
  const secondCriticalClaims = evidenceMatrix.macro_brief
    ? uniqueCriticalClaims([
        ...normalizeAuditCriticalClaims(secondRaw, secondApplied.article, evidenceMatrix),
        ...inferNumericCriticalClaims(secondApplied.article, evidenceMatrix),
      ])
    : [];
  for (const issue of secondApplied.applied) {
    warnings.push(issue.action === 'delete'
      ? `事实复核后已自动删除高风险表述:${issue.article_quote.slice(0, 160)}`
      : `事实复核后已自动局部修正:${issue.article_quote.slice(0, 160)}`);
  }
  for (const issue of secondApplied.retained) {
    warnings.push(`事实复核已保留待人工复核(${issue.confidence}/${issue.risk}/${issue.impact}):${issue.article_quote.slice(0, 160)}`);
  }
  const review = {
    approved: true,
    detected: detectedIssues,
    applied: [...firstApplied.applied, ...secondApplied.applied],
    retained: [...firstApplied.retained, ...secondApplied.retained],
    criticalClaims: uniqueCriticalClaims([
      ...firstCriticalClaims.filter((claim) => secondApplied.article.includes(claim.article_quote)),
      ...secondCriticalClaims,
    ]),
    repaired: firstApplied.applied.length + secondApplied.applied.length > 0,
    verificationIssues: secondIssues,
    ...((coreRepair || secondCoreRepair) ? { coreRepair: coreRepair || secondCoreRepair } : {}),
  };
  trace.factReview = review;
  writeResearchTrace(researchTracePath, trace);
  return {
    article: secondApplied.article,
    warnings,
    review,
  };
}

export function uniqueCriticalClaims(claims) {
  const seen = new Set();
  const usedEvidence = new Set();
  const output = [];
  for (const claim of claims || []) {
    if (output.length >= 4 || seen.has(claim.article_quote)) continue;
    const evidenceIds = (claim.evidence_ids || []).filter((id) => {
      if (usedEvidence.has(id)) return true;
      if (usedEvidence.size >= 4) return false;
      usedEvidence.add(id);
      return true;
    });
    if (!evidenceIds.length) continue;
    seen.add(claim.article_quote);
    output.push({ ...claim, evidence_ids: evidenceIds });
  }
  return output;
}
