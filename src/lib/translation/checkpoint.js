import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CHECKPOINT_VERSION, writeJsonAtomic } from './shared.js';
import { assessTranslationUnit, isReviewableEquivalenceError } from './validation.js';
import { TranslationCheckpoint } from '../publication-contracts.js';

export function createTranslationCheckpoint({ workDir, source, model, units, resumeFromCheckpoint }) {
  const checkpointPath = path.join(workDir, 'translation-checkpoint.json');
  const checkpointKey = crypto.createHash('sha256')
    .update(JSON.stringify({ version: CHECKPOINT_VERSION, source: source.sha256, model, units }))
    .digest('hex');
  const completed = new Map();
  const validationWarnings = new Map();
  const validationExceptions = new Map();
  let checkpointInvalidatedUnits = 0;
  if (resumeFromCheckpoint) {
    try {
      const saved = TranslationCheckpoint.parse(JSON.parse(fs.readFileSync(checkpointPath, 'utf8')));
      if (saved.key === checkpointKey) {
        for (const item of saved.translations || []) completed.set(item.id, item.text);
        for (const item of saved.warnings || []) {
          if (item?.id && Array.isArray(item.messages)) validationWarnings.set(item.id, item.messages);
        }
        for (const item of saved.validationExceptions || []) {
          if (item?.id) validationExceptions.set(item.id, item);
        }
      }
    } catch {}
  }
  if (completed.size) {
    const unitMap = new Map(units.map((unit) => [unit.id, unit]));
    for (const [id, text] of [...completed]) {
      const unit = unitMap.get(id);
      const assessment = unit
        ? assessTranslationUnit(unit, text, { afterRepair: true })
        : { hardErrors: ['断点含未知文本块'], warnings: [] };
      const blockingErrors = assessment.hardErrors.filter((reason) => !isReviewableEquivalenceError(reason));
      const exception = validationExceptions.get(id);
      const exceptionMatches = Boolean(
        exception
        && exception.source === unit?.text
        && exception.selected === text
        && Array.isArray(exception.candidates)
        && blockingErrors.length === 0
        && assessment.hardErrors.every(isReviewableEquivalenceError),
      );
      if (blockingErrors.length
        || ((assessment.hardErrors.length || assessment.warnings.length) && !exceptionMatches)) {
        completed.delete(id);
        validationWarnings.delete(id);
        validationExceptions.delete(id);
        checkpointInvalidatedUnits += 1;
        continue;
      }
      if (!assessment.hardErrors.length && !assessment.warnings.length) {
        validationWarnings.delete(id);
        validationExceptions.delete(id);
      } else if (!validationWarnings.has(id)) {
        validationWarnings.set(id, [
          ...assessment.hardErrors.map((reason) => `${id}: 两轮聚焦修复后宽松放行:${reason}`),
          ...assessment.warnings.map((reason) => `${id}: ${reason}`),
        ]);
      }
    }
  }
  const writeCheckpoint = () => writeJsonAtomic(checkpointPath, {
    version: CHECKPOINT_VERSION,
    key: checkpointKey,
    translations: [...completed].map(([id, text]) => ({ id, text })),
    warnings: [...validationWarnings].map(([id, messages]) => ({ id, messages })),
    validationExceptions: [...validationExceptions.values()],
    updatedAt: new Date().toISOString(),
  });
  return { completed, validationWarnings, validationExceptions, checkpointInvalidatedUnits, writeCheckpoint };
}
