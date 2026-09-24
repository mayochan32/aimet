import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AccessMode, Parser, SessionMetrics, TokenUsage } from '../types.js';
import { copilotCostUsd, costUsd } from '../pricing.js';
import { jsonlRecords } from './util.js';
import { copilotModelIdentity } from './copilotmodel.js';
import {
  collectKnownWorkspaceReferences,
  knownWorkspaceProjects,
  projectInfoOf,
} from './copilot.js';
import { copilotWorkspaceRoots } from '../paths.js';

function finite(value: unknown): number | null {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

type ChildReferenceCache = { signature: string; names: Set<string> };
const childReferenceCaches = new Map<string, ChildReferenceCache>();

function fileSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '-';
  }
}

function addChildReference(line: string, names: Set<string>): void {
  if (!line.includes('"child_session_ref"')) return;
  try {
    const rec = JSON.parse(line) as Record<string, unknown>;
    if (rec.type !== 'child_session_ref') return;
    const attrs = rec.attrs as Record<string, unknown> | undefined;
    const childLogFile = attrs?.childLogFile;
    if (
      typeof childLogFile === 'string' &&
      childLogFile.toLowerCase().endsWith('.jsonl') &&
      basename(childLogFile) === childLogFile
    ) {
      names.add(childLogFile);
    }
  } catch {
    /* malformed lines are ignored like the normal JSONL parser */
  }
}

/** Child filenames explicitly linked by the sibling main.jsonl. */
function referencedChildLogs(logPath: string): Set<string> {
  const sessionDir = dirname(logPath);
  const mainPath = join(sessionDir, 'main.jsonl');
  const signature = fileSignature(mainPath);
  const cached = childReferenceCaches.get(sessionDir);
  if (cached?.signature === signature) return cached.names;

  const names = new Set<string>();
  let fd: number | undefined;
  try {
    // Stream the file because long-running sessions can make main.jsonl large.
    fd = openSync(mainPath, 'r');
    const decoder = new StringDecoder('utf8');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let pending = '';
    let read = 0;
    do {
      read = readSync(fd, buffer, 0, buffer.length, null);
      pending += read > 0 ? decoder.write(buffer.subarray(0, read)) : decoder.end();
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        addChildReference(pending.slice(0, newline).replace(/\r$/, ''), names);
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    } while (read > 0);
    if (pending) addChildReference(pending.replace(/\r$/, ''), names);
  } catch {
    // Older/incomplete captures may have no readable main.jsonl. Filename
    // fallbacks below retain compatibility in that case.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  childReferenceCaches.set(sessionDir, { signature, names });
  return names;
}

/**
 * GitHub Copilot Chat span sessions (multi-agent, VS Code):
 *   Legacy: <userData>/User/workspaceStorage/<hash>/GitHub.copilot-chat/
 *             debug-logs/<parent-session-uuid>/runSubagent-<Agent>-<callId>.jsonl
 *   Current: <userData>/User/globalStorage/github.copilot-chat/
 *             debug-logs/<parent-session-uuid>/{runSubagent,searchSubagent}-*.jsonl
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
 * main.jsonl child_session_ref records are the authority for child filenames.
 * runSubagent-* and searchSubagent-* remain fallbacks for older/incomplete
 * captures. UI-only title/categorization/summarize logs are never counted.
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
    if (name.toLowerCase() === 'main.jsonl') return true;
    if (!name.toLowerCase().endsWith('.jsonl')) return false;

    // Current Copilot writes the exact child filename into the parent's
    // child_session_ref. This supports future child types without accepting
    // unrelated title/categorization/summarization LLM logs.
    if (referencedChildLogs(path).has(name)) return true;

    // Documented filenames retained for old or partially copied captures whose
    // main.jsonl is missing or predates child_session_ref.
    return /^(?:runSubagent-|searchSubagent-).+\.jsonl$/i.test(name);
  },

  async parseFile(path: string): Promise<SessionMetrics | null> {
    // Span traces record in/cached/out; cache-write and reasoning are not recorded -> null.
    const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: null, reasoning: null };
    let sessionId = '';
    let parentSessionId: string | null = null;
    let label = '';
    let model = '';
    const models = new Set<string>();
    const accessModes = new Set<AccessMode>();
    const providers = new Set<string>();
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
          const nano = finite(attrs.copilotUsageNanoAiu);
          const aiu = finite(attrs.aiu);
          const credits = nano !== null ? nano : aiu;
          const identity = copilotModelIdentity({
            requestModel: typeof attrs.modelId === 'string' ? attrs.modelId : model,
            responseModel: attrs.model,
            credits,
          });
          model = identity.model;
          if (model !== 'unknown') models.add(model);
          if (identity.accessMode !== 'unknown') accessModes.add(identity.accessMode);
          if (identity.provider !== 'unknown') providers.add(identity.provider);
          if (identity.accessMode === 'mixed') {
            unknownCost = true;
            estimatedRequests++;
          } else if ((nano !== null || aiu !== null) && identity.accessMode === 'copilot') {
            actualCost += (nano !== null ? nano / 1e9 : aiu!) * 0.01;
            actualRequests++;
          } else {
            const price = identity.accessMode === 'byok' ? costUsd : copilotCostUsd;
            const estimated = model !== 'unknown'
              ? price(model, { input: uncached, output, cacheRead: cached, cacheWrite: null, reasoning: null })
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
    if (basename(path).toLowerCase() !== 'main.jsonl' && !parentSessionId) return null;

    const indexedProject = projectInfoOf(path, parentSessionId ?? sessionId);
    const referencedProject = referencedProjects.size === 1
      ? [...referencedProjects][0]
      : 'unknown';
    const accessMode: AccessMode = accessModes.size === 0
      ? 'unknown'
      : accessModes.size === 1 ? [...accessModes][0] : 'mixed';
    const provider = providers.size === 0
      ? 'unknown'
      : providers.size === 1 ? [...providers][0] : 'mixed';

    return {
      tool: 'copilot',
      sessionId,
      logPath: path,
      // Current session-store rows are keyed by the top-level session. Child
      // span ids are call ids, so resolve them through parentSessionId.
      project: indexedProject.project !== 'unknown' ? indexedProject.project : referencedProject,
      projectSource: indexedProject.project !== 'unknown'
        ? indexedProject.source
        : referencedProject !== 'unknown' ? 'structured-reference' : 'unknown',
      model: `${models.size > 1 ? 'mixed' : model || 'unknown'}${parentSessionId && label ? ` (${label})` : ''}`,
      accessMode,
      provider,
      startedAt: new Date(firstTs).toISOString(),
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
