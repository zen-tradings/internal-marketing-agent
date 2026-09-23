import fs from 'node:fs';
import { sourceForTrace } from './shared.js';
import { describeFetchError } from '../../lib/fetch-retry.js';

// Full trace files are rewritten on persisted updates; throttle high-frequency inference
// telemetry so a long run does not reserialize the whole trace on every request.
export const TRACE_WRITE_THROTTLE_MS = 5000;

export function startTrace(trace, fields) {
  const event = { ...fields, status: 'running', startedAt: new Date().toISOString() };
  trace?.requests?.push(event);
  if (trace) TRACE_OWNERS.set(event, trace);
  if (trace?.live) console.log(`[research] ${trace.workflowId}/${event.kind} start: ${truncateLog(event.query || (event.urls || []).join(', '))}`);
  persistResearchTrace(trace);
  return event;
}

export function finishTrace(event, { requestId, costDollars, results, contentStatuses }) {
  event.status = 'ok';
  event.finishedAt = new Date().toISOString();
  event.durationMs = Date.parse(event.finishedAt) - Date.parse(event.startedAt);
  event.requestId = requestId || null;
  event.costDollars = costDollars || null;
  event.results = results.map(sourceForTrace);
  if (Array.isArray(contentStatuses)) {
    event.contentStatuses = contentStatuses.map((status) => ({
      id: status?.id || '',
      status: status?.status || '',
      ...(status?.error ? {
        error: {
          tag: status.error.tag || '',
          httpStatusCode: Number(status.error.httpStatusCode || 0) || null,
        },
      } : {}),
    }));
  }
  const trace = findOwningTrace(event);
  if (trace?.live) console.log(`[research] ${trace.workflowId}/${event.kind} done: ${event.results.length} results, ${event.durationMs}ms`);
  persistResearchTrace(trace);
}

export function failTrace(event, error) {
  event.status = 'failed';
  event.finishedAt = new Date().toISOString();
  event.durationMs = Date.parse(event.finishedAt) - Date.parse(event.startedAt);
  event.error = describeFetchError(error).slice(0, 300);
  const trace = findOwningTrace(event);
  if (trace?.live) console.error(`[research] ${trace.workflowId}/${event.kind} failed: ${event.error}`);
  persistResearchTrace(trace);
}

// Keep the parent trace non-enumerable in JSON while persisting it immediately when an event completes.
export const TRACE_OWNERS = new WeakMap();

export function findOwningTrace(event) { return TRACE_OWNERS.get(event); }

export function persistResearchTrace(trace) {
  if (!trace?.tracePath) return;
  try { fs.writeFileSync(trace.tracePath, `${JSON.stringify(trace, null, 2)}\n`); } catch {}
}

export function writeResearchTrace(tracePath, trace) {
  trace.tracePath = tracePath;
  persistResearchTrace(trace);
}

export function truncateLog(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}
