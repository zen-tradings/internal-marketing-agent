// Preserve the original prompt and its attachments independently of follow-ups.
export function retainSlackMessages(messages, rootTs = messages?.[0]?.ts) {
  const sorted = [...(messages || [])].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  const root = sorted.find(item => String(item.ts) === String(rootTs));
  if (!root) return sorted.slice(-11);
  return [root, ...sorted.filter(item => item !== root).slice(-11)];
}
