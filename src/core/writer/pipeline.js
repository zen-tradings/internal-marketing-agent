import fs from 'node:fs';
import path from 'node:path';
import { renderQuarterlyCharts } from '../../lib/quarterly-chart.js';
import { editorialTraceFromBrief, hasEditorialSkill, hasMacroEditorialSkill, macroEditorialTraceFromBrief, normalizeEditorialBrief, normalizeMacroEditorialBrief } from '../../lib/editorial-skill.js';
import { cancellationErrorFromSignal, isTaskCancelled, throwIfTaskCancelled, withTaskCancellation } from '../../lib/task-cancellation.js';
import { OPTIONS_STRATEGY_PROFILE, classifyOptionsStrategyIntent, isOptionsStrategyWorkflow } from '../../lib/options-strategy-route.js';
import { generateStrictTranslation } from '../../workflows/translate-engine.js';
import { sourceRequestHeadersForAttachment, translationAttachment } from '../user-sources.js';
import { AnalysisNeedsInputError, contentPolicyForPrompt, isAnalysisV2Enabled } from '../analysis-v2.js';
import { easternDateKey } from '../../lib/us-equity-calendar.js';
import { auditOpeningDigestInsight, normalizeOpeningDigestPlan, openingDigestEditorialState, openingDigestPlanPromptText, openingDigestSelectedResearch, openingDigestSourceIds } from '../../lib/opening-digest-editorial.js';
import { completeArticle, summarizeInferenceTelemetry, positiveNumber } from './model-client.js';
import { LEGAL_TASK_RE, extractUrls, sourceForTrace, sourcePriorityTier, openingDigestSelectionSummary, buildUserPrompt, sourcePolicyFor, validateArticleSourceContract, citationValidationSummary, sourceExcerptLimitFor, normalizeArticle, hasTitleFrontmatter } from './shared.js';
import { TRACE_WRITE_THROTTLE_MS, writeResearchTrace } from './trace.js';
import { runAnalysisV2, mergeInjectedSources } from './analysis.js';
import { searchExa } from './research.js';
import { refineOpeningDigestDraft, normalizeOpeningDigestCitations, planOpeningDigestEditorial, compactOpeningDigestEditorial, reviewAndRepairOpeningDigest } from './opening-editor.js';
import { reviewAndRepairArticle, canonicalizeTerminalReferences } from './review.js';
import { describeFetchError, fetchWithRetry } from '../../lib/fetch-retry.js';

export async function runWriter({
  workflow,
  input,
  config,
  fetchFn = globalThis.fetch,
  onProgress,
  resumeFromCheckpoint = false,
  taskContext = {},
  signal,
}) {
  fetchFn = withTaskCancellation(fetchFn, signal);
  const articlePath = path.join(workflow.workDir, 'article.md');
  const researchTracePath = path.join(workflow.workDir, 'research-trace.json');
  const trace = {
    workflowId: workflow.id || 'unknown',
    mode: workflow.mode || 'analysis',
    input,
    startedAt: new Date().toISOString(),
    tracePath: researchTracePath,
    live: fetchFn === globalThis.fetch,
    requests: [],
    ...(taskContext?.routeReason ? {
      routing: {
        workflowId: workflow.id || 'unknown',
        reason: taskContext.routeReason,
      },
    } : {}),
  };
  let editorialContext = null;
  let openingDigestResearch = [];
  let openingDigestPlan = null;
  try { fs.rmSync(articlePath, { force: true }); } catch {}

  try {
    throwIfTaskCancelled(signal);
    fs.mkdirSync(workflow.workDir, { recursive: true });
    if (Array.isArray(taskContext?.qdiiSources) && taskContext.qdiiSources.length) {
      trace.qdii = {
        artifactPath: taskContext.qdiiPayload?.artifactPath || null,
        fundCodes: taskContext.qdiiPayload?.query?.fundCodes || [],
        failures: taskContext.qdiiPayload?.failures || [],
        sourceCount: taskContext.qdiiSources.length,
      };
    }
    const writer = config.writer || {};
    const baseModel = workflow.mode === 'translation'
      ? config.translation?.model || workflow.model || writer.model
      : workflow.model || writer.model;
    const detectedModelProfile = classifyOptionsStrategyIntent(input);
    const modelProfile = isOptionsStrategyWorkflow(workflow.id)
      && (taskContext?.modelProfile === OPTIONS_STRATEGY_PROFILE
        || detectedModelProfile.decision === OPTIONS_STRATEGY_PROFILE)
      ? OPTIONS_STRATEGY_PROFILE
      : '';
    const usesOptionsStrategyModel = modelProfile === OPTIONS_STRATEGY_PROFILE;
    const analysisV2Enabled = isAnalysisV2Enabled(config, workflow);
    const model = usesOptionsStrategyModel ? writer.optionsStrategyModel : baseModel;
    const plannerModel = usesOptionsStrategyModel && analysisV2Enabled
      ? writer.optionsStrategyModel
      : (writer.plannerModel || baseModel);
    const evidenceModel = plannerModel;
    const reviewModel = writer.reviewModel || baseModel;
    const generationWriter = usesOptionsStrategyModel
      ? {
          ...writer,
          maxTokens: writer.optionsStrategyMaxTokens,
          reasoningEffort: writer.optionsStrategyReasoningEffort,
          preserveReasoningOnEmpty: true,
        }
      : writer;
    const generationTimeoutMs = usesOptionsStrategyModel
      ? writer.optionsStrategyTimeoutMs
      : workflow.timeoutMs;
    if (usesOptionsStrategyModel) {
      trace.modelProfile = {
        id: modelProfile,
        reason: taskContext?.modelRouteReason || detectedModelProfile.reason,
        fallbackAllowed: false,
        appliedRoles: analysisV2Enabled ? ['planner', 'evidence', 'writer'] : ['writer'],
      };
      trace.routing = {
        ...(trace.routing || {}),
        modelProfile,
        modelRouteReason: taskContext?.modelRouteReason || detectedModelProfile.reason,
      };
    }
    trace.models = {
      writer: model || null,
      planner: plannerModel || null,
      review: reviewModel || null,
      ...(usesOptionsStrategyModel && analysisV2Enabled ? { evidence: evidenceModel || null } : {}),
    };
    if (!writer.openrouterApiKey) throw new Error('缺少 OpenRouter API key');
    if (!model) throw new Error('缺少 OpenRouter model');

    if (workflow.mode === 'translation') {
      const inputSourceUrl = extractUrls(input).urls[0];
      const attachedSource = inputSourceUrl ? undefined : translationAttachment(taskContext.attachments);
      const sourceUrl = inputSourceUrl || attachedSource?.url;
      const translationWriter = {
        ...writer,
        reasoningEffort: config.translation?.reasoningEffort || 'high',
        ...(Number(config.translation?.maxTokens) > 0
          ? { maxTokens: Number(config.translation?.maxTokens) }
          : {}),
      };
      const translationWorkflow = { ...workflow, model };
      trace.translationInference = { requests: [], summary: summarizeInferenceTelemetry([]) };
      let lastTranslationTraceWriteMs = 0;
      const onInferenceTelemetry = (event) => {
        trace.translationInference.requests.push(event);
        trace.translationInference.summary = summarizeInferenceTelemetry(trace.translationInference.requests);
        const nowMs = Date.now();
        if (nowMs - lastTranslationTraceWriteMs >= TRACE_WRITE_THROTTLE_MS) {
          lastTranslationTraceWriteMs = nowMs;
          writeResearchTrace(researchTracePath, trace);
        }
      };
      const result = await generateStrictTranslation({
        input,
        sourceUrl,
        sourceRequestHeaders: sourceRequestHeadersForAttachment(attachedSource, config.slack?.botToken),
        workflow: translationWorkflow, writer: translationWriter, fetchFn, trace,
        completeArticle,
        fetchWithRetry,
        translationConfig: config.translation || {},
        documentConfig: config.documents || {},
        onInferenceTelemetry,
        onProgress: async (progress) => {
          throwIfTaskCancelled(signal);
          trace.translationProgress = { ...progress, updatedAt: new Date().toISOString() };
          writeResearchTrace(researchTracePath, trace);
          if (onProgress) await onProgress(progress);
        },
        resumeFromCheckpoint,
        signal,
      });
      throwIfTaskCancelled(signal);
      trace.finishedAt = new Date().toISOString();
      trace.selectedSources = [{ title: result.manifest?.title || '', url: result.sourceUrl, kind: 'translation-source' }];
      trace.translation = {
        manifest: result.manifest,
        completeness: result.completeness,
        warnings: result.warnings,
      };
      writeResearchTrace(researchTracePath, trace);
      if (!hasTitleFrontmatter(result.article)) throw new Error('直译输出缺少 title frontmatter');
      throwIfTaskCancelled(signal);
      fs.writeFileSync(articlePath, result.article);
      return {
        ok: true,
        articlePath,
        model,
        researchTracePath,
        sources: [result.sourceUrl],
        completeness: result.completeness,
        warnings: result.warnings,
        contentPolicy: result.contentPolicy,
      };
    }

    const preserveSpecializedLegalV1 = LEGAL_TASK_RE.test(String(input || ''))
      && extractUrls(input).urls.length > 0;
    if (isAnalysisV2Enabled(config, workflow) && !preserveSpecializedLegalV1) {
      const result = await runAnalysisV2({
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
      });
      throwIfTaskCancelled(signal);
      fs.writeFileSync(articlePath, result.article);
      return {
        ok: true,
        articlePath,
        model,
        researchTracePath,
        sources: result.sources.map((source) => source.url).filter(Boolean),
        warnings: result.warnings,
        contentPolicy: result.contentPolicy,
      };
    }

    if (hasEditorialSkill(workflow)) {
      trace.editorialSkill = editorialTraceFromBrief(normalizeEditorialBrief(undefined, {
        input,
        workflowId: workflow.id,
      }));
    }
    if (hasMacroEditorialSkill(workflow)) {
      const macroTrace = macroEditorialTraceFromBrief(normalizeMacroEditorialBrief(undefined, { input }));
      trace.editorialSkills = [trace.editorialSkill, macroTrace].filter(Boolean);
      trace.macroBrief = macroTrace;
    }
    const sourcePolicy = sourcePolicyFor({ input, workflow });
    if (!writer.exaApiKey && !sourcePolicy.skipResearch) throw new Error('原创研究工作流缺少 Exa API key');
    trace.sourcePolicy = sourcePolicy;
    const researchAsOf = new Date();
    const contextPromise = typeof workflow.collectContext === 'function'
      ? Promise.resolve().then(() => workflow.collectContext({
          config, fetchFn, asOf: researchAsOf, taskContext, signal,
        })).catch((error) => {
          if (signal?.aborted) throw cancellationErrorFromSignal(signal);
          return {
            diagnostics: [`Opening Digest universe context 已降级:${describeFetchError(error).slice(0, 300)}`],
            sources: [],
            promptText: '',
            trace: { diagnostics: [describeFetchError(error).slice(0, 300)] },
          };
        })
      : Promise.resolve(null);
    let externalResearch;
    if (workflow.id === 'opening-digest') {
      editorialContext = await contextPromise;
      externalResearch = await searchExa({
        input, writer, workflow, fetchFn, trace, sourcePolicy, editorialContext, asOf: researchAsOf,
      });
    } else {
      [externalResearch, editorialContext] = await Promise.all([
        searchExa({ input, writer, workflow, fetchFn, trace, sourcePolicy, asOf: researchAsOf }),
        contextPromise,
      ]);
    }
    if (workflow.id === 'opening-digest' && editorialContext) {
      trace.openingDigestUniverse = editorialContext.trace || { diagnostics: editorialContext.diagnostics || [] };
      if (editorialContext.artifact) {
        const artifactPath = path.join(workflow.workDir, 'opening-digest-universe.json');
        try {
          fs.writeFileSync(artifactPath, `${JSON.stringify(editorialContext.artifact, null, 2)}\n`, { mode: 0o600 });
          trace.openingDigestUniverse.artifactPath = artifactPath;
        } catch (error) {
          const diagnostic = `Opening Digest universe artifact 写入失败:${error.message}`;
          trace.openingDigestUniverse.diagnostics = [...(trace.openingDigestUniverse.diagnostics || []), diagnostic];
        }
      }
    }
    const injectedSources = [
      ...(Array.isArray(taskContext.qdiiSources) ? taskContext.qdiiSources : []),
      ...(Array.isArray(editorialContext?.sources) ? editorialContext.sources : []),
    ];
    let research = mergeInjectedSources(injectedSources, externalResearch);
    if (workflow.id === 'opening-digest') {
      research = openingDigestSourceIds(research);
      openingDigestResearch = research;
      if (research.length === 0) throw new Error('Opening Digest 未检索到可用研究来源');
      const editorialHistory = await Promise.resolve(taskContext?.openingDigestHistory?.listEditorialHistory?.({ limitSessions: 20 }))
        .catch((error) => {
          trace.openingDigestEditorialHistory = { diagnostics: [describeFetchError(error).slice(0, 300)], editions: [] };
          return [];
        });
      const history = Array.isArray(editorialHistory) ? editorialHistory : editorialHistory?.rows || [];
      trace.openingDigestEditorialHistory ||= { editions: history };
      if (workflow.editorialPlanning === true) {
        try {
          openingDigestPlan = await planOpeningDigestEditorial({
            research, editorialContext, history, asOf: researchAsOf,
            model: plannerModel, writer, workflow, fetchFn,
          });
          trace.openingDigestEditorialPlan = { status: 'model', ...openingDigestPlan };
        } catch (error) {
          openingDigestPlan = normalizeOpeningDigestPlan({}, research, history);
          trace.openingDigestEditorialPlan = {
            status: 'fallback', diagnostic: describeFetchError(error).slice(0, 500), ...openingDigestPlan,
          };
        }
      } else {
        openingDigestPlan = normalizeOpeningDigestPlan({}, research, history);
        trace.openingDigestEditorialPlan = { status: 'deterministic', ...openingDigestPlan };
      }
    }
    throwIfTaskCancelled(signal);
    trace.selectedSources = research.map(sourceForTrace);
    trace.officialSourceCount = research.filter((source) => source.official).length;
    trace.sourceTiers = {
      firstPriority: research.filter((source) => sourcePriorityTier(source) === 1).length,
      specialist: research.filter((source) => sourcePriorityTier(source) === 2).length,
      open: research.filter((source) => sourcePriorityTier(source) === 3).length,
    };
    trace.researchLanes = [...new Set(trace.requests.map((request) => request.kind).filter(Boolean))];
    writeResearchTrace(researchTracePath, trace);
    const generationResearch = workflow.id === 'opening-digest' && workflow.editorialPlanning === true
      ? openingDigestSelectedResearch(research, openingDigestPlan)
      : research;
    const generationEditorialContext = workflow.id === 'opening-digest' && workflow.editorialPlanning === true
      ? [editorialContext?.promptText || '', openingDigestPlanPromptText(openingDigestPlan)].filter(Boolean).join('\n\n')
      : editorialContext?.promptText || '';
    const maxPromptChars = positiveNumber(writer.maxPromptChars, 160000);
    const configuredExcerptChars = sourceExcerptLimitFor(workflow);
    let appliedExcerptChars = configuredExcerptChars;
    let prompt = buildUserPrompt({
      workflow, input, research: generationResearch, writer, sourcePolicy, asOf: researchAsOf,
      editorialContext: generationEditorialContext,
      sourceExcerptMaxChars: appliedExcerptChars,
      modelProfile,
    });
    if (workflow.id === 'opening-digest' && prompt.length > maxPromptChars) {
      for (const fallbackLimit of [900, 600, 300, 0]) {
        if (fallbackLimit >= appliedExcerptChars) continue;
        appliedExcerptChars = fallbackLimit;
        prompt = buildUserPrompt({
          workflow, input, research: generationResearch, writer, sourcePolicy, asOf: researchAsOf,
          editorialContext: generationEditorialContext,
          sourceExcerptMaxChars: appliedExcerptChars,
          modelProfile,
        });
        if (prompt.length <= maxPromptChars) break;
      }
    }
    if (workflow.id === 'opening-digest') {
      trace.openingDigestResearchBudget = {
        sourceCount: research.length,
        selectedSourceCount: generationResearch.length,
        configuredExcerptChars,
        appliedExcerptChars,
        promptChars: prompt.length,
        maxPromptChars,
        withinLimit: prompt.length <= maxPromptChars,
      };
      writeResearchTrace(researchTracePath, trace);
    }
    if (prompt.length > maxPromptChars) {
      throw new Error(`生成输入超过全局上限:${prompt.length}/${maxPromptChars} 字符;请减少链接或缩短素材`);
    }
    const truncationSignal = {};
    const content = await completeArticle({
      prompt,
      model,
      writer: generationWriter,
      fetchFn,
      timeoutMs: generationTimeoutMs,
      systemPrompt: workflow.systemPrompt,
      truncationSignal,
    });
    throwIfTaskCancelled(signal);
    if (truncationSignal.truncated) {
      throw new Error('写作输出被 max_tokens 截断(finish_reason=length);请提高 OPENROUTER_MAX_TOKENS 后重试');
    }
    let article = renderQuarterlyCharts(normalizeArticle(content));
    if (workflow.id === 'opening-digest') article = normalizeOpeningDigestCitations(article, research);
    if (!hasTitleFrontmatter(article)) {
      throw new Error('OpenRouter 输出缺少 title frontmatter');
    }
    if (workflow.id === 'opening-digest' && workflow.editorialPlanning === true) {
      const refined = await refineOpeningDigestDraft({ article, research: generationResearch, workflow, writer, fetchFn });
      article = refined.article;
      trace.openingDigestRefinement = refined.trace;
    }
    if (workflow.factReview && !sourcePolicy.skipResearch) {
      const reviewed = workflow.factReviewPolicy === 'severe-only'
        ? await reviewAndRepairOpeningDigest({ article, input, research, workflow, writer, fetchFn })
        : await reviewAndRepairArticle({ article, input, research, workflow, writer, fetchFn, sourcePolicy });
      article = reviewed.article;
      trace.factReview = reviewed.review;
    } else if (sourcePolicy.skipResearch) {
      trace.factReview = { skipped: true, reason: 'non-research-newsletter' };
    }

    if (workflow.id === 'opening-digest') {
      try {
        const compacted = await compactOpeningDigestEditorial({
          article, research, workflow, writer, fetchFn,
        });
        article = compacted.article;
        trace.openingDigestCompaction = compacted.trace;
      } catch (error) {
        trace.openingDigestCompaction = {
          attempted: true,
          appliedCount: 0,
          revertedCount: 0,
          diagnostic: describeFetchError(error).slice(0, 500),
          blocks: [],
        };
      }
    }

    if (sourcePolicy.referenceStyle === 'terminal-list') {
      article = canonicalizeTerminalReferences(article, research, sourcePolicy);
    }
    if (typeof workflow.decorateArticle === 'function') {
      article = workflow.decorateArticle({
        article, research, asOf: researchAsOf, editorialContext,
      });
    }
    validateArticleSourceContract(article, research, sourcePolicy);
    if (typeof workflow.validateArticle === 'function') {
      const validation = workflow.validateArticle({ article, research, asOf: researchAsOf });
      if (workflow.id === 'opening-digest') {
        trace.openingDigestAudit = validation;
        trace.openingDigestSelection = openingDigestSelectionSummary(validation, research);
      }
    }
    if (workflow.id === 'opening-digest' && editorialContext?.artifact) {
      const artifactPath = path.join(workflow.workDir, 'opening-digest-universe.json');
      try { fs.writeFileSync(artifactPath, `${JSON.stringify(editorialContext.artifact, null, 2)}\n`, { mode: 0o600 }); }
      catch (error) {
        trace.openingDigestUniverse ||= { diagnostics: [] };
        trace.openingDigestUniverse.diagnostics = [
          ...(trace.openingDigestUniverse.diagnostics || []),
          `Opening Digest universe artifact 更新失败:${error.message}`,
        ];
      }
    }

    throwIfTaskCancelled(signal);
    let openingDigestState;
    if (workflow.id === 'opening-digest') {
      trace.contentMode = 'editorial';
      trace.openingDigestInsightAudit = auditOpeningDigestInsight(article);
      openingDigestState = openingDigestEditorialState(article, openingDigestPlan);
    }
    trace.finishedAt = new Date().toISOString();
    trace.citationValidation = citationValidationSummary(article, research, sourcePolicy);
    writeResearchTrace(researchTracePath, trace);
    fs.writeFileSync(articlePath, article);
    return {
      ok: true,
      articlePath,
      model,
      researchTracePath,
      sources: research.map((r) => r.url).filter(Boolean),
      ...(workflow.id === 'opening-digest' ? { contentMode: 'editorial', openingDigestEditorialState: openingDigestState } : {}),
      contentPolicy: contentPolicyForPrompt(input),
    };
  } catch (e) {
    if (isTaskCancelled(e, signal)) throw cancellationErrorFromSignal(signal);
    if (workflow.id === 'opening-digest' && e?.openingDigestFactReview) {
      trace.factReview = e.openingDigestFactReview;
    }
    if (workflow.id === 'opening-digest' && isOpeningDigestEditorialModelFailure(e)) {
      e.openingDigestHardFailure = true;
      e.stage ||= 'generate';
    }
    if (workflow.id === 'opening-digest' && !e?.openingDigestHardFailure) {
      const fallbackAsOf = new Date();
      let fallback = openingDigestFallbackArticle(fallbackAsOf);
      if (typeof workflow.decorateArticle === 'function') {
        fallback = workflow.decorateArticle({
          article: fallback,
          research: openingDigestResearch,
          asOf: fallbackAsOf,
          editorialContext,
        });
      }
      trace.finishedAt = new Date().toISOString();
      trace.contentMode = 'data-only';
      trace.fallbackReason = describeFetchError(e).slice(0, 600);
      trace.diagnostics = [...(trace.diagnostics || []), trace.fallbackReason];
      try {
        if (editorialContext?.artifact) {
          const artifactPath = path.join(workflow.workDir, 'opening-digest-universe.json');
          fs.writeFileSync(artifactPath, `${JSON.stringify(editorialContext.artifact, null, 2)}\n`, { mode: 0o600 });
        }
        fs.writeFileSync(articlePath, fallback);
        writeResearchTrace(researchTracePath, trace);
        return {
          ok: true,
          articlePath,
          model: 'fallback',
          researchTracePath,
          sources: (trace.selectedSources || []).map((source) => source.url).filter(Boolean),
          contentMode: 'data-only',
        };
      } catch (fallbackError) {
        trace.error = describeFetchError(fallbackError).slice(0, 600);
      }
    }
    trace.finishedAt = new Date().toISOString();
    if (e instanceof AnalysisNeedsInputError) {
      trace.needsInput = e.details;
      trace.error = e.message;
      writeResearchTrace(researchTracePath, trace);
      try { fs.rmSync(articlePath, { force: true }); } catch {}
      return {
        ok: false,
        needsInput: true,
        clarification: e.details,
        articlePath,
        researchTracePath,
        stderr: e.message,
      };
    }
    trace.error = describeFetchError(e).slice(0, 600);
    writeResearchTrace(researchTracePath, trace);
    try { fs.rmSync(articlePath, { force: true }); } catch {}
    return { ok: false, articlePath, researchTracePath, exitCode: 1, stderr: describeFetchError(e).slice(0, 600) };
  }
}

export function openingDigestFallbackArticle(asOf) {
  const date = easternDateKey(asOf);
  return `---\ntitle: Zen Opening Digest\nheadline: Opening data, read unavailable\nstance: neutral\nconfidence: low\npreheader: Opening data are available; the evidence-bound editorial read could not be completed.\nedition: ${date}\n---\nEditorial update unavailable for this edition. Opening data are available, but the evidence-bound synthesis could not be completed, so no directional conclusion is presented.\n\n## What matters today\n\nNo evidence-ranked narrative is available.\n\nNo additional market implication is asserted.\n\n## Evidence and cross-currents\n\nThe available data are shown without a causal interpretation.\n\n## What to watch\n\n- Current index levels and volatility\n- Available Treasury yield observations\n- Scheduled earnings shown below\n`;
}

export function isOpeningDigestEditorialModelFailure(error) {
  return /(?:OpenRouter completion failed|OpenRouter returned empty content|OpenRouter returned malformed JSON response|OpenRouter completion timed out)/i
    .test(String(error?.message || error || ''));
}
