import { sharedResearch, officialFirstPolicy, envChannel, envModel, envTimeoutMs, buildPromptTemplate } from './shared.js';

export default {
  id: 'wechat',
  mode: 'analysis',
  editorialSkill: 'latepost-ai-writer',
  sourcePolicy: officialFirstPolicy(),
  factReview: true,
  triggers: ['slack'],
  get workDir() { return process.env.WORK_DIR || '/srv/zen/wechat'; }, // 保持现状,不带子目录
  get model() { return envModel(); },
  get channel() { return envChannel(); },   // 默认真实渠道;本地演练用 HUB_DRY_RUN=1 或设 WECHAT_CHANNEL=mock
  get timeoutMs() { return envTimeoutMs(); },
  get research() { return sharedResearch(); },
  retries: 0,
  promptTemplate: (task) => buildPromptTemplate({ persona: 'Zen Trading 公众号分析师', task }),
};
