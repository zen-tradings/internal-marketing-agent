export function createNotifier(postMessage) {
  const send = (notify, text) => postMessage({ channel: notify.channel, thread_ts: notify.ts, text });
  return {
    ack(notify, input) { return send(notify, `收到,已入队:\n> ${String(input).slice(0, 80)}`); },
    success(notify, { title, mediaId }) { return send(notify, `✅ 草稿已发布\n标题:${title}\nMedia ID:${mediaId}`); },
    failure(notify, { stage, error }) { return send(notify, `❌ 任务失败(阶段:${stage})\n${String(error).slice(0, 500)}`); },
    warn(notify, msg) { return send(notify, `⚠️ ${msg}`); },
  };
}
