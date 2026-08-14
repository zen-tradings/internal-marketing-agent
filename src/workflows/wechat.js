import { sharedResearch, officialFirstPolicy, envChannel, envModel, envTimeoutMs, buildPromptTemplate } from './shared.js';
import { runtimeConfig } from '../config/runtime.js';

export default {
  id: 'wechat',
  mode: 'analysis',
  editorialSkill: 'latepost-ai-writer',
  sourcePolicy: officialFirstPolicy(),
  factReview: true,
  triggers: ['slack'],
  get workDir() { return runtimeConfig()?.workDir || process.env.WORK_DIR || '/srv/zen/wechat'; }, // Preserve existing root-level layout.
  get model() { return envModel(); },
  get channel() { return envChannel(); },   // Live channel by default; use HUB_DRY_RUN=1 or WECHAT_CHANNEL=mock locally.
  get timeoutMs() { return envTimeoutMs(); },
  get research() { return sharedResearch(); },
  retries: 0,
  promptTemplate: (task) => buildPromptTemplate({ persona: 'Zen Trading 公众号分析师', task }),
};
