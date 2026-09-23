import { RemoteOperationState } from './publication-contracts.js';
import crypto from 'node:crypto';

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function needsReview(message, cause) {
  return Object.assign(new Error(message, { cause }), { stage: 'needs_review', retryable: false });
}

export function remoteOperationsFor(store, runId) {
  return {
    get: operation => store.getRemoteOperation(runId, operation),
    prepare: entry => store.prepareRemoteOperation({ runId, ...entry }),
    increment: operation => store.incrementRemoteOperationAttempt(runId, operation),
    update: (operation, patch) => store.updateRemoteOperation(runId, operation, patch),
  };
}

// The write-ahead record is committed before the request. A lost response never
// authorizes a second write; recovery may only confirm a remote result.
export async function performRemoteOperation({ operations, runId, operation, payload, snapshot = async () => [], create, recover = async () => undefined, definitelyRejected = () => false }) {
  if (!operations || !runId) return create();
  let record = operations.get(operation);
  const payloadSha256 = crypto.createHash('sha256').update(stableJson(payload)).digest('hex');
  if (!record) record = operations.prepare({ operation, operationKey: `${operation}:v1:${runId}`, payloadSha256, payload, beforeIds: await snapshot() });
  RemoteOperationState.parse(record.state);
  if (record.remote_id) return String(record.remote_id);
  if (record.payload_sha256 !== payloadSha256) throw needsReview(`${operation}: 冻结请求与当前内容不一致，已停止继续创建`);
  const confirm = remoteId => {
    if (!remoteId) throw new Error('远端成功响应缺少 ID');
    operations.update(operation, { state: 'confirmed', remoteId: String(remoteId), lastError: '' });
    return String(remoteId);
  };
  const reconcile = async cause => {
    let recovered;
    try { recovered = await recover(record); } catch (error) { cause ||= error; }
    if (recovered) return confirm(recovered);
    operations.update(operation, { state: 'needs_review', lastError: cause?.message || '远端结果无法确认' });
    throw needsReview(`${operation}: 发布结果不明，已停止继续创建，请人工核对`, cause);
  };
  if (Number(record.attempt_count) > 0 && record.state !== 'rejected') return reconcile();
  record = operations.increment(operation);
  if (!record || record.state !== 'attempting') throw needsReview(`${operation}: 无法取得创建权限`);
  try { return confirm(await create()); }
  catch (error) {
    if (definitelyRejected(error)) {
      operations.update(operation, { state: 'rejected', lastError: error.message });
      throw error;
    }
    operations.update(operation, { state: 'ambiguous', lastError: error.message });
    return reconcile(error);
  }
}
