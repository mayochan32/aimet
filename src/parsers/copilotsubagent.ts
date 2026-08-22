import { basename } from 'node:path';
import type { Parser, SessionMetrics, TokenUsage } from '../types.js';
import { costUsd } from '../pricing.js';
import { jsonlRecords } from './util.js';
import {
  collectKnownWorkspaceReferences,
  knownWorkspaceProjects,
  projectOf,
} from './copilot.js';
import { copilotWorkspaceRoots } from '../paths.js';

function finite(value: unknown): number | null {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * GitHub Copilot Chat span sessions (multi-agent, VS Code):
 *   Legacy: <userData>/User/workspaceStorage/<hash>/GitHub.copilot-chat/
 *             debug-logs/<parent-session-uuid>/runSubagent-<Agent>-<callId>.jsonl
 *   Current: <userData>/User/globalStorage/github.copilot-chat/
 *             debug-logs/<parent-session-uuid>/runSubagent-<Agent>-<callId>.jsonl
 *
 * Span-trace format (one span per line):
 *   { v?, ts(ms), dur(ms), sid, type, name, spanId, parentSpanId?, status, attrs }
 *   - session_start: attrs.{copilotVersion, vscodeVersion, parentSessionId, label}
 *   - llm_request:   attrs.{model, inputTokens, outputTokens, cachedTokens, ttft}
 *   - turn_start / turn_end / tool_call / agent_response / subagent
 *
 * main.jsonl records every parent-side LLM request, while chatSessions often
 * stores only a task-level snapshot. Both share a session id, so Store gives
 * main.jsonl deterministic precedence rather than counting both.
 * title-*.jsonl is the tiny title-generation request; skipped as noise.
 *
 * Cost: prefer per-request copilotUsageNanoAiu/aiu. Fall back per request to
 * API-equivalent model pricing only when exact AIU is absent.
 *
 * NOTE: these logs exist only when Copilot Chat's debug file logging is
 * active. Without it, subagent usage is not recoverable from disk.
 */
export const copilotSubagentParser: Parser = {
  tool: 'copilot',

  defaultDirs() {
    return copilotWorkspaceRoots();
  },

  isLogFile(path: string) {
    const normalized = path.replace(/\\/g, '/');
    if (!/\/GitHub\.copilot-chat\/debug-logs\/[^/]+\//i.test(normalized)) return false;
    const name = normalized.split('/').pop() ?? '';
    return (name === 'main.jsonl' || name.startsWith('runSubagent-')) &&
      name.toLowerCase().endsWith('.jsonl');
  },

  async parseFile(path: string): Promise<SessionMetrics | null> {
    // Span traces record in/cached/out; cache-write and reasoning are not recorded -> null.
    const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: null, reasoning: null };
    let sessionId = '';
    let parentSessionId: string | null = null;
    let label = '';
    let model = '';
    let turns = 0;
    let requests = 0;
    let firstTs = Infinity;
    let lastTs = 0;
    let activeMs = 0;
    let actualCost = 0;
    let estimatedCost = 0;
    let actualRequests = 0;
    let estimatedRequests = 0;
    let unknownCost = false;
    const seenSpans = new Set<string>();
    const workspaceProjects = knownWorkspaceProjects(path);
    const referencedProjects = new Set<string>();

    for await (const rec of jsonlRecords(path)) {
      const ts = Number(rec.ts ?? 0);
      const dur = Number(rec.dur ?? 0);
      if (ts > 0) {
        firstTs = Math.min(firstTs, ts);
        lastTs = Math.max(lastTs, ts + (Number.isFinite(dur) ? dur : 0));
      }
      const attrs = (rec.attrs ?? {}) as Record<string, unknown>;
      if (workspaceProjects.length > 0) {
        collectKnownWorkspaceReferences(attrs, workspaceProjects, referencedProjects);
      }

      switch (rec.type) {
        case 'session_start':
          if (typeof rec.sid === 'string') sessionId = rec.sid;
          if (typeof attrs.parentSessionId === 'string') parentSessionId = attrs.parentSessionId;
          if (typeof attrs.label === 'string') label = attrs.label;
          break;
        case 'turn_start':
          turns++;
          break;
        case 'llm_request': {
          const spanId = typeof rec.spanId === 'string' ? rec.spanId : '';
          if (spanId && seenSpans.has(spanId)) break;
          if (spanId) seenSpans.add(spanId);
          requests++;
          const usage = attrs.usage && typeof attrs.usage === 'object'
            ? attrs.usage as Record<string, unknown>
            : {};
          const input = finite(attrs.inputTokens ?? usage.input_tokens) ?? 0;
          const output = finite(attrs.outputTokens ?? usage.output_tokens) ?? 0;
          const cached = finite(attrs.cachedTokens ?? usage.cached_input_tokens) ?? 0;
          // inputTokens includes cachedTokens (OpenAI-style); split them.
          const uncached = Math.max(0, input - cached);
          tokens.input = (tokens.input ?? 0) + uncached;
          tokens.cacheRead = (tokens.cacheRead ?? 0) + cached;
          tokens.output = (tokens.output ?? 0) + output;
          const requestModel = typeof attrs.model === 'string'
            ? attrs.model
            : typeof attrs.modelId === 'string' ? attrs.modelId : model;
          if (requestModel) model = requestModel;
          const nano = finite(attrs.copilotUsageNanoAiu);
          const aiu = finite(attrs.aiu);
          if (nano !== null || aiu !== null) {
            actualCost += (nano !== null ? nano / 1e9 : aiu!) * 0.01;
            actualRequests++;
          } else {
            const estimated = requestModel
              ? costUsd(requestModel, { input: uncached, output, cacheRead: cached, cacheWrite: 0, reasoning: 0 })
              : null;
            if (estimated === null) unknownCost = true;
            else estimatedCost += estimated;
            estimatedRequests++;
          }
          if (Number.isFinite(dur)) activeMs += dur;
          break;
        }
      }
    }

    if (!sessionId || requests === 0 || !Number.isFinite(firstTs)) return null;

    const indexedProject = projectOf(path, parentSessionId ?? sessionId);
    const referencedProject = referencedProjects.size === 1
      ? [...referencedProjects][0]
      : 'unknown';

    return {
      tool: 'copilot',
      sessionId,
      logPath: path,
      // Current session-store rows are keyed by the top-level session. Child
      // span ids are call ids, so resolve them through parentSessionId.
      project: indexedProject !== 'unknown' ? indexedProject : referencedProject,
      model: `${model || 'unknown'}${parentSessionId && label ? ` (${label})` : ''}`,
      startedAt: new Date(firstTs).toISOString(),
      endedAt: new Date(lastTs).toISOString(),
      durationSec: Math.round((lastTs - firstTs) / 1000),
      activeSec: Math.round(activeMs / 1000),
      tokens,
      costUsd: unknownCost ? null : actualCost + estimatedCost,
      estimated: estimatedRequests > 0,
      costSource: actualRequests > 0 && estimatedRequests > 0
        ? 'mixed'
        : actualRequests > 0 ? 'actual' : 'estimated',
      metricScope: 'own',
      turns: turns || requests,
      lastEventAt: new Date(lastTs).toISOString(),
      parentSessionId,
    };
  },
};
