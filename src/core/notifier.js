export function createNotifier(postMessage) {
  const send = (notify, text) => {
    if (!notify?.channel) return Promise.resolve({ skipped: true, reason: 'missing-channel' });
    return postMessage({ channel: notify.channel, thread_ts: notify.ts, text });
  };
  return {
    ack(notify, input) {
      const route = notify?.routeLabel ? `\n识别:${notify.routeLabel}` : '';
      return send(notify, `收到,已入队:${route}\n> ${String(input).slice(0, 120)}`);
    },
    success(notify, { title, mediaId, channelId, sourceCount, completeness }) {
      const destination = channelId === 'customerio-draft' ? 'Customer.io Newsletter 草稿' : '微信公众号草稿';
      const sources = Number.isFinite(sourceCount) ? `\n来源数量:${sourceCount}` : '';
      const complete = completeness ? `\n完整性:${completeness.errors?.length ? `未通过(${completeness.errors.join('; ')})` : `通过,覆盖页码 ${completeness.pagesFound?.length || 0} 页`}` : '';
      return send(notify, `✅ ${destination}已创建\n标题:${title}${sources}${complete}\nMedia ID:${mediaId}`);
    },
    progress(notify, { message }) { return send(notify, `⏳ ${String(message || '任务处理中')}`); },
    failure(notify, { stage, error }) { return send(notify, `❌ 任务失败(阶段:${stage})\n${String(error).slice(0, 500)}`); },
    cancelled(notify, { runId, cleaned, cleanupError }) {
      const cleanup = cleanupError
        ? `未完成文件清理失败:${String(cleanupError).slice(0, 300)}`
        : cleaned ? '未完成文件已清理' : '没有需要清理的运行文件';
      return send(notify, `🛑 任务已停止\n任务:${runId}\n${cleanup}\n未创建新草稿。`);
    },
    warn(notify, msg) { return send(notify, `⚠️ ${msg}`); },
  };
}
