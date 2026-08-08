import { workDirFor } from './shared.js';
import { isUsEquitySession } from '../lib/us-equity-calendar.js';

export default {
  id: 'opening-digest-eod',
  mode: 'opening-digest-eod',
  triggers: ['cron:20 16 * * 1-5'],
  cronTimezone: 'America/New_York',
  cronInput: '(Opening Digest EOD options cache)',
  shouldRun: (date) => /^(1|true|yes|on)$/i.test(String(process.env.OPENING_DIGEST_ENABLED || '')) && isUsEquitySession(date),
  get workDir() { return workDirFor('opening-digest-eod'); },
  channel: 'customerio-opening-digest-cache',
  get timeoutMs() { return 120000; },
  retries: 0,
};
