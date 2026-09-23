import fs from 'node:fs';
import path from 'node:path';
import { createTranslationCheckpoint } from './checkpoint.js';
import { throwIfTaskCancelled } from '../task-cancellation.js';
import { TRANSLATION_BATCH_MAX_CHARS, TRANSLATION_BATCH_MAX_ITEMS, TRANSLATION_SHORT_UNIT_MAX_ITEMS, TRANSLATION_SHORT_UNIT_AVERAGE_CHARS, REPAIR_BATCH_MAX_CHARS, REPAIR_BATCH_MAX_ITEMS, CHECKPOINT_WRITE_THROTTLE_MS, translationUnits, applyTranslations, parseJsonPayload, safeError, report, writeJsonAtomic } from './shared.js';
import { hasExpectedTranslationSet, assessBatchTranslations, preferredTranslation, isReviewableEquivalenceError, normalizeBatchHighlights, protectInvariantText, restoreInvariantText } from './validation.js';

export async function translateDocument({
  source,
  workDir,
  model,
  writer,
  fetchFn,
  completeArticle,
  timeoutMs,
  onProgress,
  onInferenceTelemetry,
  batchConcurrency = 2,
  resumeFromCheckpoint = false,
  signal,
}) {
  throwIfTaskCancelled(signal);
  const units = translationUnits(source);
  if (!units.length) throw new Error('原文没有可翻译的结构化文本');
  const { completed, validationWarnings, validationExceptions, checkpointInvalidatedUnits, writeCheckpoint } =
    createTranslationCheckpoint({ workDir, source, model, units, resumeFromCheckpoint });
  let lastCheckpointWriteMs = 0;
  const writeCheckpointThrottled = () => {
    const nowMs = Date.now();
    if (nowMs - lastCheckpointWriteMs < CHECKPOINT_WRITE_THROTTLE_MS) return;
    lastCheckpointWriteMs = nowMs;
    writeCheckpoint();
  };
  if (checkpointInvalidatedUnits) writeCheckpoint();

  const pendingUnits = units.filter((unit) => !completed.has(unit.id));
  const initialBatchMaxItems = adaptiveTranslationBatchMaxItems(pendingUnits);
  const batches = batchUnits(
    pendingUnits,
    TRANSLATION_BATCH_MAX_CHARS,
    initialBatchMaxItems,
  );
  await report(onProgress, {
    stage: 'translation',
    message: completed.size
      ? `从结构化断点继续翻译 ${completed.size}/${units.length}${checkpointInvalidatedUnits
        ? `（按新规则重验，${checkpointInvalidatedUnits} 个旧单元需重做）`
        : ''}`
      : `开始翻译标题、正文及图表标题，共 ${units.length} 个文本单元`,
    completed: completed.size,
    total: units.length,
  });

  const effectiveBatchConcurrency = Math.max(1, Math.min(2, Number(batchConcurrency) || 1));
  await mapBounded(batches, effectiveBatchConcurrency, async (batch, batchIndex) => {
    throwIfTaskCancelled(signal);
    const initialContext = inferenceContextFor({
      phase: 'initial', batch, batchIndex, batchTotal: batches.length,
    });
    let translations = await requestTranslationBatch({
      batch, source, model, writer, fetchFn, completeArticle, timeoutMs,
      onInferenceTelemetry, inferenceContext: initialContext, signal,
    });
    const originalTranslations = translations;
    const repairedTranslations = [];
    const candidateHistory = new Map(batch.map((unit) => [unit.id, []]));
    for (const item of originalTranslations) {
      if (candidateHistory.has(item.id)) candidateHistory.get(item.id).push({ ...item, round: 0 });
    }
    let assessments = assessBatchTranslations(batch, translations);
    for (let repairRound = 1; repairRound <= 2; repairRound++) {
      const repairTargets = assessments
        .map((item) => {
          const issues = repairIssuesForAssessment(item);
          return issues.length ? {
            ...item.unit,
            currentTranslation: item.text || '',
            issues,
          } : null;
        })
        .filter(Boolean);
      if (!repairTargets.length) break;
      const repairBatches = batchUnits(
        repairTargets,
        REPAIR_BATCH_MAX_CHARS,
        REPAIR_BATCH_MAX_ITEMS,
      );
      const repairedGroups = await mapBounded(
        repairBatches,
        effectiveBatchConcurrency,
        async (repairBatch, repairBatchIndex) => requestTranslationBatch({
          batch: repairBatch,
          source,
          model,
          writer,
          fetchFn,
          completeArticle,
          timeoutMs,
          repair: true,
          onInferenceTelemetry,
          inferenceContext: inferenceContextFor({
            phase: 'repair',
            batch: repairBatch,
            batchIndex: repairBatchIndex,
            batchTotal: repairBatches.length,
            parentBatchIndex: batchIndex,
            repairRound,
          }),
          signal,
        }),
        signal,
      );
      const repaired = repairedGroups.flat();
      repairedTranslations.push(...repaired.map((item) => ({ ...item, round: repairRound })));
      for (const item of repaired) {
        if (candidateHistory.has(item.id)) {
          candidateHistory.get(item.id).push({ ...item, round: repairRound });
        }
      }
      translations = batch.map((unit) => {
        return preferredTranslation(unit, ...(candidateHistory.get(unit.id) || []));
      }).filter(Boolean);
      assessments = assessBatchTranslations(batch, translations, { afterRepair: true });
    }

    translations = normalizeBatchHighlights(batch, translations);
    assessments = assessBatchTranslations(batch, translations, { afterRepair: true });
    const acceptedIds = new Set();
    for (const assessment of assessments) {
      const reviewableErrors = assessment.hardErrors.filter(isReviewableEquivalenceError);
      const blockingErrors = assessment.hardErrors.filter((reason) => !isReviewableEquivalenceError(reason));
      if (blockingErrors.length) continue;
      const text = String(assessment.text || '').trim();
      if (!text) continue;
      completed.set(assessment.unit.id, text);
      acceptedIds.add(assessment.unit.id);
      if (reviewableErrors.length || assessment.warnings.length) {
        const messages = [
          ...reviewableErrors.map((reason) => `两轮聚焦修复后宽松放行:${reason}`),
          ...assessment.warnings,
        ].map((warning) => `${assessment.unit.id}: ${warning}`);
        validationWarnings.set(
          assessment.unit.id,
          messages,
        );
        validationExceptions.set(assessment.unit.id, {
          id: assessment.unit.id,
          source: assessment.unit.text,
          selected: text,
          reasons: reviewableErrors,
          warnings: assessment.warnings,
          candidates: candidateHistory.get(assessment.unit.id) || [],
        });
      } else {
        validationWarnings.delete(assessment.unit.id);
        validationExceptions.delete(assessment.unit.id);
      }
      // Persist progress as units pass structural hard gates, throttled to avoid rewriting the
      // whole checkpoint per unit; a failure in another unit of the same batch does not discard
      // completed progress on resume.
      writeCheckpointThrottled();
    }
    // Always flush at batch boundaries so at-most CHECKPOINT_WRITE_THROTTLE_MS of accepted
    // units can be lost to a crash between throttled saves.
    writeCheckpoint();
    lastCheckpointWriteMs = Date.now();

    const invalid = assessments.filter((item) => item.hardErrors
      .some((reason) => !isReviewableEquivalenceError(reason)));
    if (invalid.length) {
      const validation = invalid.map((item) => ({
        id: item.unit.id,
        reasons: item.hardErrors.filter((reason) => !isReviewableEquivalenceError(reason)),
        warnings: item.warnings,
      }));
      writeJsonAtomic(path.join(workDir, 'translation-invalid.json'), {
        failedAt: new Date().toISOString(),
        units: invalid.map((item) => ({ id: item.unit.id, source: item.unit.text })),
        validation,
        received: translations.map((item) => ({ id: item.id, text: item.text })),
        originalReceived: originalTranslations.map((item) => ({ id: item.id, text: item.text })),
        repairReceived: repairedTranslations,
        checkpointed: [...acceptedIds],
      });
      throw new Error(`结构化翻译校验失败:${validation
        .map((item) => `${item.id}(${item.reasons.join('+')})`)
        .join(',')}`);
    }
    if (validationExceptions.size) {
      writeJsonAtomic(path.join(workDir, 'translation-review.json'), {
        updatedAt: new Date().toISOString(),
        reviewRequired: [...validationExceptions.values()],
      });
    }
    writeCheckpoint();
    await report(onProgress, {
      stage: 'translation',
      message: `结构化翻译进度 ${completed.size}/${units.length}`,
      completed: completed.size,
      total: units.length,
    });
  }, signal);
  throwIfTaskCancelled(signal);
  if (completed.size !== units.length) {
    const error = new Error(`结构化翻译缺块:${completed.size}/${units.length}`);
    error.retryableTranslationResponse = true;
    throw error;
  }
  try { fs.rmSync(path.join(workDir, 'translation-invalid.json'), { force: true }); } catch {}
  const translated = applyTranslations(source, completed);
  translated.validationWarnings = [...validationWarnings.values()].flat();
  translated.validationExceptions = [...validationExceptions.values()];
  return translated;
}

export async function requestTranslationBatch({
  batch,
  source,
  model,
  writer,
  fetchFn,
  completeArticle,
  timeoutMs,
  repair = false,
  allowSplit = true,
  onInferenceTelemetry,
  inferenceContext = {},
  signal,
}) {
  const protections = new Map();
  const units = batch.map((unit) => {
    if (!repair) return unit;
    const protectedText = protectInvariantText(unit.text);
    protections.set(unit.id, protectedText.tokens);
    return {
      id: unit.id,
      kind: unit.kind,
      text: protectedText.text,
      currentTranslation: String(unit.currentTranslation || ''),
      issues: Array.isArray(unit.issues) ? unit.issues : [],
    };
  });
  const request = {
    prompt: `${repair
      ? '只修复下面 JSON 中 currentTranslation 明确列出的问题；以 text 原文为准，返回完整的修复后简体中文译文。'
      : '将下面 JSON 中每个 text 完整、忠实、逐句翻译为简体中文。'}

硬性规则:
- 只返回合法 JSON，格式严格为 {"translations":[{"id":"原 ID","text":"完整译文"}]}。
- translations 必须与输入数量相同，ID 必须逐字相同且不得重复、遗漏或新增。
- 按 kind 翻译标题、正文、标题层级、图注和表题，不总结、不改写、不删减。表格正文直接保留原文截图，不进入翻译输入。
- 不添加输入中不存在的图、表、公式、引用、分析或内容概括。
- 不改变任何数值含义、Ticker、型号、占位符和正文中原有的 URL。数字词可译成等价阿拉伯数字，K/M/B/T、千分位、百分比、万/亿等可使用等价中文写法，但严禁把数值改成不等价值。
- 金融语境中的 pre-fee 必须译为“费前”或“费用前”，不得译为“税前”；after-fee 或 net of fees 译为“费后”或“扣除费用后”。
- 所有 ⟦ZEN_INLINE_NNN⟧ 都是公式、链接或引用占位符，必须原样、原位置、各保留一次。
- 专有名词首次出现可保留英文，普通叙述必须翻译成中文。
- paragraph、quote、list_item 必须提高关键词和核心观点高亮密度：正文每约 200 个汉字至少 1 处，目标 2–3 处；优先高亮关键术语、核心机制、中心句或开头关键句。
- 每处使用 Markdown **加粗**，可包住 2–64 个字符的关键短语或短句，不能把整段全部加粗，也不能改动原意。
- title、heading、figure_caption、table_caption 禁止添加 **加粗**；除正文高亮外不得添加其它 Markdown 格式。
${repair ? `- 输入中的 ⟦ZEN_KEEP_N⟧ 是不可翻译占位符，必须原样、原位置、各保留一次。
- 每个单元都包含 currentTranslation 和 issues。只修复 issues 指出的块内问题，不重新发挥、总结或扩写。
- 即使 currentTranslation 为空，也必须根据 text 返回该 ID 的完整译文。` : ''}

文档标题:${source.title}
来源:${source.sourceUrl}

输入 JSON:
${JSON.stringify({ units })}`,
    model,
    writer: { ...writer, temperature: 0 },
    fetchFn,
    timeoutMs,
    onTelemetry: onInferenceTelemetry,
    inferenceContext,
    systemPrompt: '你是严谨的结构化文档翻译器。忠实翻译输入的标题、正文及图表标题；按要求在正文关键术语和核心观点上稳定添加 Markdown 高亮。数字可采用等价中文格式，但数值含义、占位符、链接、型号和结构绝不能改变。只输出合法 JSON。',
  };
  const responseFormat = {
    type: 'json_schema',
    json_schema: {
      name: 'translation_blocks',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['translations'],
        properties: {
          translations: {
            type: 'array',
            minItems: units.length,
            maxItems: units.length,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'text'],
              properties: {
                id: { type: 'string', enum: units.map((unit) => unit.id) },
                text: { type: 'string', minLength: 1 },
              },
            },
          },
        },
      },
    },
  };
  const complete = async (nextRequest) => {
    const truncationSignal = {};
    try {
      const raw = await completeArticle({ ...nextRequest, responseFormat, truncationSignal });
      lastTruncated = Boolean(truncationSignal.truncated);
      return raw;
    } catch (error) {
      lastTruncated = false;
      if (!/(?:response[_ -]?format|json[_ -]?schema|structured output|HTTP 400|OpenRouter 400)/i.test(safeError(error))) throw error;
      const raw = await completeArticle({
        ...nextRequest,
        inferenceContext: { ...nextRequest.inferenceContext, schemaFallback: true },
        truncationSignal,
      });
      lastTruncated = Boolean(truncationSignal.truncated);
      return raw;
    }
  };
  const parseTranslations = (raw) => {
    const parsed = parseJsonPayload(raw);
    if (!Array.isArray(parsed?.translations)) return [];
    return parsed.translations
      .filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string')
      .map((item) => ({
        id: item.id,
        text: repair ? restoreInvariantText(item.text, protections.get(item.id) || []) : item.text,
      }));
  };
  let bestTranslations = [];
  let lastResponseError;
  // Set by complete() when the provider returned partial content with finish_reason=length.
  // A truncated batch response is treated like any other incomplete response: retry once,
  // then deterministically split into smaller batches instead of failing the whole task.
  let lastTruncated = false;
  const truncationError = () => {
    const error = new Error(`翻译批次输出被 max_tokens 截断(finish_reason=length),收到 ${bestTranslations.length}/${batch.length} 块`);
    error.retryableTranslationResponse = true;
    return error;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfTaskCancelled(signal);
    const retryInstruction = attempt === 0
      ? ''
      : `${repair ? '上一次修复响应缺少输入块' : '上一次响应不是完整合法 JSON 或缺少输入块'}。请重新返回全部 ${batch.length} 个块；只允许使用这些 ID：${batch.map((unit) => unit.id).join('、')}。`;
    lastTruncated = false;
    try {
      const translations = parseTranslations(await complete({
        ...request,
        inferenceContext: { ...inferenceContext, translationResponseAttempt: attempt + 1 },
        prompt: retryInstruction
          ? request.prompt.replace(
            '\n\n输入 JSON:\n',
            `\n\n${retryInstruction}\n\n输入 JSON:\n`,
          )
          : request.prompt,
      }));
      if (translations.length > bestTranslations.length) bestTranslations = translations;
      if (hasExpectedTranslationSet(batch, translations)) return translations;
      if (lastTruncated) lastResponseError = truncationError();
    } catch (error) {
      if (lastTruncated) {
        lastResponseError = truncationError();
      } else if (error?.retryableTranslationResponse !== true) {
        throw error;
      } else {
        lastResponseError = error;
      }
    }
  }

  // Large structured output is more likely to truncate at the provider or gateway. After two incomplete attempts,
  // deterministically reduce to repair-batch size without losing previously persisted checkpoints.
  if (allowSplit && batch.length > 1) {
    const smallerBatches = batchUnits(batch, REPAIR_BATCH_MAX_CHARS, REPAIR_BATCH_MAX_ITEMS);
    if (smallerBatches.length > 1) {
      const recovered = [];
      for (const [splitIndex, smallerBatch] of smallerBatches.entries()) {
        throwIfTaskCancelled(signal);
        recovered.push(...await requestTranslationBatch({
          batch: smallerBatch,
          source,
          model,
          writer,
          fetchFn,
          completeArticle,
          timeoutMs,
          repair,
          allowSplit: false,
          onInferenceTelemetry,
          inferenceContext: {
            ...inferenceContext,
            itemCount: smallerBatch.length,
            inputCharacters: smallerBatch.reduce((total, unit) => total + String(unit.text || '').length, 0),
            splitBatchIndex: splitIndex + 1,
            splitBatchTotal: smallerBatches.length,
          },
          signal,
        }));
      }
      if (recovered.length > bestTranslations.length) bestTranslations = recovered;
      if (hasExpectedTranslationSet(batch, recovered)) return recovered;
    }
  }
  if (lastResponseError && bestTranslations.length === 0) throw lastResponseError;
  return bestTranslations;
}

export function adaptiveTranslationBatchMaxItems(units) {
  if (!units.length) return TRANSLATION_BATCH_MAX_ITEMS;
  const averageChars = units.reduce((total, unit) => total + String(unit.text || '').length, 0) / units.length;
  return averageChars <= TRANSLATION_SHORT_UNIT_AVERAGE_CHARS
    ? TRANSLATION_SHORT_UNIT_MAX_ITEMS
    : TRANSLATION_BATCH_MAX_ITEMS;
}

export function repairIssuesForAssessment(assessment) {
  const warningOnly = new Set(assessment.warnings || []);
  return [...new Set([
    ...(assessment.hardErrors || []),
    ...(assessment.repairableIssues || []).filter((reason) => !warningOnly.has(reason)),
  ])];
}

export function inferenceContextFor({
  phase,
  batch,
  batchIndex,
  batchTotal,
  parentBatchIndex,
  repairRound,
}) {
  return {
    phase,
    batchIndex: batchIndex + 1,
    batchTotal,
    itemCount: batch.length,
    inputCharacters: batch.reduce((total, unit) => total + String(unit.text || '').length, 0),
    ...(parentBatchIndex === undefined ? {} : { parentBatchIndex: parentBatchIndex + 1 }),
    ...(repairRound === undefined ? {} : { repairRound }),
  };
}

export async function mapBounded(values, concurrency, mapper, signal) {
  const results = new Array(values.length);
  let cursor = 0;
  let firstError;
  const worker = async () => {
    while (!firstError) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        throwIfTaskCancelled(signal);
        results[index] = await mapper(values[index], index);
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
  };
  const workerCount = Math.min(values.length, Math.max(1, Math.floor(Number(concurrency) || 1)));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) throw firstError;
  return results;
}

export function batchUnits(units, maxChars, maxItems) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const unit of units) {
    if (batch.length && (batch.length >= maxItems || chars + unit.text.length > maxChars)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(unit);
    chars += unit.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
