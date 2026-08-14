import path from 'node:path';
import { envTimeoutMs } from './shared.js';
import { runtimeConfig } from '../config/runtime.js';

export default {
  id: 'qdii',
  mode: 'qdii-query',
  outputKind: 'slack-response',
  triggers: ['slack'],
  get workDir() { return path.join(runtimeConfig()?.workDir || process.env.WORK_DIR || '/srv/zen/wechat', 'qdii'); },
  get timeoutMs() { return envTimeoutMs(); },
  retries: 0,
};
