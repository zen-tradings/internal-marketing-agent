export function createNotifier(postMessage, { intervalMs = 0 } = {}) {
  const scheduledPost = intervalMs > 0 ? createSlackPostScheduler(postMessage, { intervalMs }) : postMessage;
  const send = (notify, text, priority = 2, kind = 'message') => {
    if (!notify?.channel) return Promise.resolve({ skipped: true, reason: 'missing-channel' });
    return scheduledPost({ channel: notify.channel, thread_ts: notify.ts, text }, { priority, kind });
  };
  return {
    ack(notify, input) {
      const route = notify?.routeLabel ? `\n识别:${notify.routeLabel}` : '';
      const revision = notify?.promptRevision ? `\nPrompt 修订:${notify.promptRevision}` : '';
      const entities = notify?.promptEntities?.length
        ? `\n实体/版本:${notify.promptEntities.join('、')}`
        : '';
      const links = Number.isInteger(notify?.userUrlCount)
        ? `\n用户链接:${notify.userUrlCount}`
        : '';
      const freshness = notify?.freshnessRequirement
        ? `\n时效:${notify.freshnessRequirement}`
        : '';
      const fullPrompt = String(input || '').trim();
      const displayed = fullPrompt.length > 2000
        ? `${fullPrompt.slice(0, 2000)}\n…完整 Prompt 已保存，共 ${fullPrompt.length} 字符`
        : fullPrompt;
      return send(
        notify,
        `收到,${notify?.queueState === 'running' ? '正在执行' : '已排队'} · 任务 ${shortRunId(notify?.runId)}:${route}${revision}${entities}${links}${freshness}\n\n完整要求:\n> ${displayed.replace(/\n/g, '\n> ')}`,
        2,
        'ack',
      );
    },
    success(notify, { title, mediaId, channelId, sourceCount, completeness }) {
      const destination = channelId === 'customerio-draft'
        ? 'Customer.io Newsletter 草稿'
        : channelId === 'customerio-opening-digest' ? 'Opening Digest 邮件' : '微信公众号草稿';
      const sources = Number.isFinite(sourceCount) ? `\n来源数量:${sourceCount}` : '';
      const coveredPages = Number(completeness?.pagesProcessed || completeness?.pagesFound?.length || 0);
      const complete = completeness
        ? `\n完整性:${completeness.errors?.length
          ? `未通过(${completeness.errors.join('; ')})`
          : coveredPages > 0
            ? `通过,覆盖页码 ${coveredPages} 页`
            : '通过'}`
        : '';
      return send(notify, `✅ ${destination}已创建\n标题:${title}${sources}${complete}\nMedia ID:${mediaId}`, 3, 'terminal');
    },
    progress(notify, { message }) { return send(notify, `⏳ ${String(message || '任务处理中')}`, 1, 'progress'); },
    failure(notify, { stage, error }) { return send(notify, `❌ 任务失败(阶段:${stage})\n${String(error).slice(0, 500)}`, 3, 'terminal'); },
    needsInput(notify, { question, details }) {
      const conflicts = Array.isArray(details?.conflicts) && details.conflicts.length
        ? `\n冲突:\n${details.conflicts.slice(0, 3).map((item) => `• ${item.description || item.topic}`).join('\n')}`
        : '';
      return send(
        notify,
        `❓ 任务需要确认，已暂停且未创建草稿${conflicts}\n\n请回复这一项:\n${String(question || '请补充核心信息。').slice(0, 1200)}`,
        3,
        'terminal',
      );
    },
    cancelled(notify, { runId, cleaned, cleanupError }) {
      const cleanup = cleanupError
        ? `未完成文件清理失败:${String(cleanupError).slice(0, 300)}`
        : cleaned ? '未完成文件已清理' : '没有需要清理的运行文件';
      return send(notify, `🛑 任务已停止\n任务:${runId}\n${cleanup}\n未创建新草稿。`, 3, 'terminal');
    },
    async respond(notify, { messages }) {
      if (!notify?.channel || !notify?.ts) throw new Error('QDII Slack response is missing channel/thread metadata');
      const posted = [];
      for (const message of Array.isArray(messages) ? messages : []) {
        posted.push(await scheduledPost({
          channel: notify.channel,
          thread_ts: notify.ts,
          text: String(message || '').slice(0, 39000),
        }, { priority: 3, kind: 'terminal' }));
      }
      if (!posted.length) throw new Error('QDII Slack response contains no messages');
      return { responseTs: posted[posted.length - 1]?.ts || posted[0]?.ts || '' };
    },
    warn(notify, msg) { return send(notify, `⚠️ ${msg}`, 2, 'warning'); },
  };
}

export function createSlackPostScheduler(postMessage, { intervalMs = 1000, now = () => Date.now() } = {}) {
  const channels = new Map();
  let sequence = 0;
  return function schedule(payload, { priority = 2, kind = 'message' } = {}) {
    const channel = String(payload?.channel || '');
    if (!channel || intervalMs <= 0) return postMessage(payload);
    let state = channels.get(channel);
    if (!state) {
      state = { queue: [], sending: false, lastSentAt: 0 };
      channels.set(channel, state);
    }
    const thread = String(payload.thread_ts || 'root');
    if (kind === 'terminal') {
      for (const entry of state.queue.filter((item) => item.kind === 'progress' && item.thread === thread)) {
        state.queue.splice(state.queue.indexOf(entry), 1);
        entry.resolve({ skipped: true, reason: 'superseded-by-terminal' });
      }
    }
    if (kind === 'progress') {
      const existing = state.queue.find((item) => item.kind === 'progress' && item.thread === thread);
      if (existing) {
        existing.payload = payload;
        return existing.promise;
      }
    }
    let resolveEntry, rejectEntry;
    const promise = new Promise((resolve, reject) => { resolveEntry = resolve; rejectEntry = reject; });
    state.queue.push({ payload, priority, kind, thread, sequence: sequence++, promise, resolve: resolveEntry, reject: rejectEntry });
    state.queue.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    void drainChannel(channel, state);
    return promise;
  };

  async function drainChannel(channel, state) {
    if (state.sending) return;
    state.sending = true;
    try {
      while (state.queue.length) {
        const delay = Math.max(0, state.lastSentAt + intervalMs - now());
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        const entry = state.queue.shift();
        try { entry.resolve(await postMessage(entry.payload)); }
        catch (error) { entry.reject(error); }
        state.lastSentAt = now();
      }
    } finally {
      state.sending = false;
      if (!state.queue.length) channels.delete(channel);
      else void drainChannel(channel, state);
    }
  }
}

function shortRunId(runId) {
  const value = String(runId || '').trim();
  return value ? value.slice(0, 12) : '待分配';
}
