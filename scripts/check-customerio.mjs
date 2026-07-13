import 'dotenv/config';

const apiKey = process.env.CUSTOMERIO_APP_API_KEY;
const baseUrl = String(process.env.CUSTOMERIO_API_BASE_URL || 'https://api.customer.io').replace(/\/+$/, '');
const stage = String(process.env.NEWSLETTER_AUDIENCE_STAGE || 'internal').trim().toLowerCase();
const edition = String(process.env.NEWSLETTER_EDITION || 'Vol. 1').trim();
const allowFull = /^(1|true|yes|on)$/i.test(process.env.CUSTOMERIO_ALLOW_FULL_AUDIENCE || '');
const stages = {
  internal: {
    segmentId: positiveInteger(process.env.CUSTOMERIO_INTERNAL_SEGMENT_ID || process.env.CUSTOMERIO_NEWSLETTER_SEGMENT_ID),
    maxRecipients: positiveInteger(process.env.CUSTOMERIO_INTERNAL_MAX_RECIPIENTS) || 10,
  },
  pilot: {
    segmentId: positiveInteger(process.env.CUSTOMERIO_PILOT_SEGMENT_ID),
    maxRecipients: positiveInteger(process.env.CUSTOMERIO_PILOT_MAX_RECIPIENTS) || 50,
  },
  full: {
    segmentId: positiveInteger(process.env.CUSTOMERIO_FULL_SEGMENT_ID),
    maxRecipients: positiveInteger(process.env.CUSTOMERIO_FULL_MAX_RECIPIENTS),
  },
};

if (!apiKey) fail('缺少 CUSTOMERIO_APP_API_KEY');
if (!Object.hasOwn(stages, stage)) fail('NEWSLETTER_AUDIENCE_STAGE 必须是 internal、pilot 或 full');

const results = await Promise.all(Object.entries(stages).map(async ([name, settings]) => {
  if (!settings.segmentId) return { stage: name, segmentId: '-', count: '-', max: settings.maxRecipients || '-' };
  const data = await request(`/v1/segments/${settings.segmentId}/customer_count`);
  return {
    stage: name,
    segmentId: settings.segmentId,
    count: data.count,
    max: settings.maxRecipients || '-',
  };
}));

console.table(results);

const selected = results.find((item) => item.stage === stage);
const errors = [];
if (!stages[stage].segmentId) errors.push(`${stage} 阶段没有配置 segment ID`);
if (selected?.count === 0) errors.push(`${stage} 阶段受众为空`);
if (Number.isInteger(stages[stage].maxRecipients) && selected?.count > stages[stage].maxRecipients) {
  errors.push(`${stage} 阶段受众 ${selected.count} 人，超过上限 ${stages[stage].maxRecipients} 人`);
}
if (stage === 'full' && !allowFull) errors.push('full 阶段未设置 CUSTOMERIO_ALLOW_FULL_AUDIENCE=true');
if (!process.env.CUSTOMERIO_NEWSLETTER_FROM) errors.push('缺少 CUSTOMERIO_NEWSLETTER_FROM');
if (!process.env.CUSTOMERIO_COMPANY_ADDRESS) errors.push('缺少 CUSTOMERIO_COMPANY_ADDRESS');

const list = await request('/v1/newsletters');
const expectedName = `Zen Trading Newsletter · ${edition}`;
const editions = await Promise.all((list.newsletters || [])
  .filter((item) => item.name === expectedName)
  .map(async (item) => {
    const row = {
      id: item.id,
      state: item.sent_at == null ? 'draft' : 'sent',
      segmentIds: item.recipient_segment_ids?.join(',') || '-',
      messages: '-',
      delivered: '-',
      failed: '-',
      suppressed: '-',
    };
    if (item.sent_at == null) return row;
    const data = await request(`/v1/newsletters/${item.id}/messages`);
    const messages = data.messages || [];
    return {
      ...row,
      messages: messages.length,
      delivered: messages.filter((message) => message.metrics?.delivered).length,
      failed: messages.filter((message) => message.metrics?.failed).length,
      suppressed: messages.filter((message) => message.metrics?.suppressed).length,
    };
  }));

console.log(`当前阶段: ${stage}; 目标版号: ${expectedName}`);
console.table(editions);

if (errors.length) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('Customer.io newsletter 工作流配置检查通过。');
}

async function request(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    fail(`Customer.io ${path} 检查失败: ${response.status} ${detail}`);
  }
  return response.json();
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
