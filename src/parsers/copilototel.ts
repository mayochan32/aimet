import { basename, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AccessMode, Parser, SessionMetrics } from '../types.js';
import { costUsd, copilotCostUsd } from '../pricing.js';
import { copilotWorkspaceRoots } from '../paths.js';
import { jsonlRecords } from './util.js';
import { projectInfoOf } from './copilot.js';

/**
 * VS Code Copilot Chat OpenTelemetry sources.
 *
 * Preferred: User/globalStorage/github.copilot-chat/agent-traces.db
 * Fallback:  the documented OTel file exporter (JSON Lines).
 *
 * Only `chat` spans are billed here. `invoke_agent` spans contain session
 * rollups and would double-count the same calls if they were added as well.
 */

const ATTR = {
  operation: 'gen_ai.operation.name',
  provider: 'gen_ai.provider.name',
  conversation: 'gen_ai.conversation.id',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  input: 'gen_ai.usage.input_tokens',
  output: 'gen_ai.usage.output_tokens',
  cacheRead: 'gen_ai.usage.cache_read.input_tokens',
  cacheWrite: 'gen_ai.usage.cache_creation.input_tokens',
  reasoning: 'gen_ai.usage.reasoning.output_tokens',
  reasoningLegacy: 'gen_ai.usage.reasoning_tokens',
  responseId: 'gen_ai.response.id',
  chatSession: 'copilot_chat.chat_session_id',
  session: 'copilot_chat.session_id',
  creditsNano: 'copilot_chat.copilot_usage_nano_aiu',
  creditsNanoCanonical: 'github.copilot.nano_aiu',
  server: 'server.address',
} as const;

type Observation = {
  key: string;
  traceId: string;
  sessionId: string;
  accessMode: AccessMode;
  provider: string;
  model: string;
  serverAddress: string | null;
  startMs: number;
  endMs: number;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  creditsNano: number | null;
};

type DbSpanRow = {
  span_id: string;
  trace_id: string;
  start_time_ms: number;
  end_time_ms: number;
  provider_name: string | null;
  conversation_id: string | null;
  chat_session_id: string | null;
  request_model: string | null;
  response_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  root_session_id: string | null;
  cache_write: string | null;
  reasoning_output: string | null;
  credits_nano: string | null;
  server_address: string | null;
};

function finite(value: unknown): number | null {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function serverHost(serverAddress: string | null): string {
  return (serverAddress ?? '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0];
}

function isCopilotHost(host: string): boolean {
  return host === 'github.com' || host.endsWith('.github.com') ||
    host === 'githubcopilot.com' || host.endsWith('.githubcopilot.com');
}

/**
 * Route evidence is intentionally independent from provider normalization.
 * Credits prove Copilot billing; a non-GitHub endpoint proves a direct/BYOK
 * request even when VS Code incorrectly reports provider=github.
 */
function accessModeOf(
  reportedProvider: unknown,
  serverAddress: string | null,
  creditsNano: number | null
): AccessMode {
  const host = serverHost(serverAddress);
  if (host && !isCopilotHost(host)) return 'byok';
  if (creditsNano !== null) return 'copilot';
  const reported = stringValue(reportedProvider).toLowerCase();
  if (reported && reported !== 'unknown' && reported !== 'github') return 'byok';
  if (reported === 'github' || isCopilotHost(host)) return 'copilot';
  return 'unknown';
}

/**
 * VS Code 1.136 can label a direct BYOK call as provider=github even though
 * server.address points at the user's provider. Prefer a recognized direct
 * provider endpoint in that case; keep explicit non-GitHub providers intact.
 */
function providerOf(value: unknown, serverAddress: string | null): string {
  const reported = stringValue(value) || 'unknown';
  if (reported !== 'github' && reported !== 'unknown') return reported;
  const host = serverHost(serverAddress);
  if (host === 'api.openai.com' || host.endsWith('.openai.com')) return 'openai';
  if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) return 'anthropic';
  if (host === 'generativelanguage.googleapis.com') return 'gemini';
  if (host === 'openrouter.ai' || host.endsWith('.openrouter.ai')) return 'openrouter';
  if (host === 'api.x.ai' || host.endsWith('.x.ai')) return 'xai';
  if (host.endsWith('.openai.azure.com')) return 'azure.ai.openai';
  if (host && !isCopilotHost(host)) return 'custom';
  return reported;
}

function explicitOtelPaths(): string[] {
  return [process.env.AIMET_COPILOT_OTEL_FILE]
    .filter((v): v is string => typeof v === 'string' && Boolean(v.trim()))
    .map((v) => resolve(v.trim()));
}

function explicitCliOtelPaths(): string[] {
  return [process.env.AIMET_COPILOT_CLI_OTEL_FILE, process.env.COPILOT_OTEL_FILE_EXPORTER_PATH]
    .filter((v): v is string => typeof v === 'string' && Boolean(v.trim()))
    .map((v) => resolve(v.trim()));
}

function sqliteObservations(path: string): Observation[] | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((row) => row.name)
    );
    if (!tables.has('spans') || !tables.has('span_attributes')) return null;

    const rows = db.prepare(`
      SELECT s.span_id, s.trace_id, s.start_time_ms, s.end_time_ms,
             s.provider_name, s.conversation_id, s.chat_session_id,
             s.request_model, s.response_model, s.input_tokens,
             s.output_tokens, s.cached_tokens, s.reasoning_tokens,
             (
               SELECT COALESCE(root.conversation_id, root.chat_session_id)
               FROM spans AS root
               WHERE root.trace_id = s.trace_id
                 AND root.operation_name = 'invoke_agent'
                 AND COALESCE(root.conversation_id, root.chat_session_id) IS NOT NULL
               ORDER BY root.start_time_ms LIMIT 1
             ) AS root_session_id,
             (SELECT value FROM span_attributes WHERE span_id = s.span_id AND key = ?) AS cache_write,
             (SELECT value FROM span_attributes WHERE span_id = s.span_id AND key = ?) AS reasoning_output,
             COALESCE(
               (SELECT value FROM span_attributes WHERE span_id = s.span_id AND key = ?),
               (SELECT value FROM span_attributes WHERE span_id = s.span_id AND key = ?)
             ) AS credits_nano,
             (SELECT value FROM span_attributes WHERE span_id = s.span_id AND key = ?) AS server_address
      FROM spans AS s
      WHERE s.operation_name = 'chat'
        AND s.input_tokens IS NOT NULL
        AND s.output_tokens IS NOT NULL
      ORDER BY s.start_time_ms
    `).all(ATTR.cacheWrite, ATTR.reasoning, ATTR.creditsNanoCanonical, ATTR.creditsNano, ATTR.server) as DbSpanRow[];

    const observations: Observation[] = [];
    for (const row of rows) {
      // Utility calls such as title/progress generation are chat spans too,
      // but have no conversation/session identity and are not user sessions.
      // A subagent chat may carry its own conversation id. The connected
      // invoke_agent root owns the trace-wide accounting row in aimet.
      const sessionId = row.root_session_id ?? row.conversation_id ?? row.chat_session_id;
      if (!sessionId) continue;
      const creditsNano = finite(row.credits_nano);
      observations.push({
        key: row.span_id,
        traceId: row.trace_id,
        sessionId,
        accessMode: accessModeOf(row.provider_name, row.server_address, creditsNano),
        provider: providerOf(row.provider_name, row.server_address),
        model: row.response_model ?? row.request_model ?? 'unknown',
        serverAddress: row.server_address,
        startMs: Number(row.start_time_ms),
        endMs: Number(row.end_time_ms),
        input: finite(row.input_tokens) ?? 0,
        output: finite(row.output_tokens) ?? 0,
        cacheRead: finite(row.cached_tokens),
        cacheWrite: finite(row.cache_write),
        reasoning: finite(row.reasoning_output) ?? finite(row.reasoning_tokens),
        creditsNano,
      });
    }
    return observations;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function otlpValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  for (const key of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) {
    if (key in record) return record[key];
  }
  return value;
}

function attributesOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  if (!Array.isArray(value)) return value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.key === 'string') result[row.key] = otlpValue(row.value);
  }
  return result;
}

function highResolutionMs(value: unknown): number | null {
  if (Array.isArray(value) && value.length >= 2) {
    const sec = finite(value[0]);
    const nano = finite(value[1]);
    return sec === null || nano === null ? null : sec * 1000 + nano / 1e6;
  }
  if (typeof value === 'string') {
    const numeric = finite(value);
    if (numeric !== null) return numeric > 1e15 ? numeric / 1e6 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const numeric = finite(value);
  if (numeric === null) return null;
  return numeric > 1e15 ? numeric / 1e6 : numeric;
}

function contextIds(rec: Record<string, unknown>): { traceId: string; spanId: string } {
  const context = [rec.spanContext, rec._spanContext, rec.context]
    .find((v) => v && typeof v === 'object') as Record<string, unknown> | undefined;
  return {
    traceId: stringValue(rec.traceId ?? context?.traceId),
    spanId: stringValue(rec.spanId ?? context?.spanId),
  };
}

function observationFromJson(
  rec: Record<string, unknown>, index: number, inheritedSessionId = ''
): Observation | null {
  const attrs = attributesOf(rec.attributes);
  if (attrs[ATTR.operation] !== 'chat') return null;
  const input = finite(attrs[ATTR.input]);
  const output = finite(attrs[ATTR.output]);
  if (input === null || output === null) return null;

  const { traceId, spanId } = contextIds(rec);
  const startMs = highResolutionMs(rec.startTime ?? rec.startTimeUnixNano ?? rec.timestamp ?? rec.hrTime) ?? 0;
  const explicitEnd = highResolutionMs(rec.endTime ?? rec.endTimeUnixNano);
  const durationMs = highResolutionMs(rec.duration) ?? 0;
  const endMs = explicitEnd ?? startMs + durationMs;
  const responseId = stringValue(attrs[ATTR.responseId]);
  const sessionId = inheritedSessionId || stringValue(
    attrs[ATTR.conversation] ?? attrs[ATTR.chatSession] ?? attrs[ATTR.session]
  );
  if (!sessionId) return null;
  const serverAddress = stringValue(attrs[ATTR.server]) || null;
  const creditsNano = finite(attrs[ATTR.creditsNanoCanonical] ?? attrs[ATTR.creditsNano]);

  return {
    key: spanId || responseId || `${sessionId}:${startMs}:${index}`,
    traceId,
    sessionId,
    accessMode: accessModeOf(attrs[ATTR.provider], serverAddress, creditsNano),
    provider: providerOf(attrs[ATTR.provider], serverAddress),
    model: stringValue(attrs[ATTR.responseModel] ?? attrs[ATTR.requestModel]) || 'unknown',
    serverAddress,
    startMs,
    endMs,
    input,
    output,
    cacheRead: finite(attrs[ATTR.cacheRead]),
    cacheWrite: finite(attrs[ATTR.cacheWrite]),
    reasoning: finite(attrs[ATTR.reasoning]) ?? finite(attrs[ATTR.reasoningLegacy]),
    creditsNano,
  };
}

function observationScore(o: Observation): number {
  return [o.accessMode !== 'unknown', o.provider !== 'unknown', o.cacheRead !== null, o.cacheWrite !== null,
    o.reasoning !== null, o.creditsNano !== null, o.endMs > o.startMs]
    .filter(Boolean).length;
}

function spanRecords(rec: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(rec.resourceSpans)) return [rec];
  const spans: Record<string, unknown>[] = [];
  for (const resource of rec.resourceSpans) {
    if (!resource || typeof resource !== 'object') continue;
    const scopes = (resource as Record<string, unknown>).scopeSpans;
    if (!Array.isArray(scopes)) continue;
    for (const scope of scopes) {
      if (!scope || typeof scope !== 'object') continue;
      const rows = (scope as Record<string, unknown>).spans;
      if (Array.isArray(rows)) {
        for (const row of rows) {
          if (row && typeof row === 'object') spans.push(row as Record<string, unknown>);
        }
      }
    }
  }
  return spans;
}

type JsonlObservations = {
  observations: Observation[];
  rootCredits: Map<string, number>;
};

async function jsonlObservations(path: string): Promise<JsonlObservations | null> {
  const observations = new Map<string, Observation>();
  const rootCredits = new Map<string, number>();
  const records: Record<string, unknown>[] = [];
  let index = 0;
  try {
    for await (const rec of jsonlRecords(path)) {
      records.push(...spanRecords(rec));
    }
    const bySpan = new Map<string, Record<string, unknown>>();
    for (const rec of records) {
      const { spanId } = contextIds(rec);
      if (spanId) bySpan.set(spanId, rec);
    }
    const ancestorSession = (rec: Record<string, unknown>): string => {
      const visited = new Set<string>();
      let parentId = stringValue(rec.parentSpanId ?? rec.parent_span_id);
      let rootId = '';
      while (parentId && !visited.has(parentId)) {
        visited.add(parentId);
        const parent = bySpan.get(parentId);
        if (!parent) break;
        const attrs = attributesOf(parent.attributes);
        if (attrs[ATTR.operation] === 'invoke_agent') {
          const id = stringValue(attrs[ATTR.conversation] ?? attrs[ATTR.chatSession] ?? attrs[ATTR.session]);
          if (id) rootId = id;
        }
        parentId = stringValue(parent.parentSpanId ?? parent.parent_span_id);
      }
      return rootId;
    };
    const seenRoots = new Set<string>();
    for (const rec of records) {
      const attrs = attributesOf(rec.attributes);
      if (attrs[ATTR.operation] === 'invoke_agent' &&
          !stringValue(rec.parentSpanId ?? rec.parent_span_id)) {
        const id = stringValue(attrs[ATTR.conversation] ?? attrs[ATTR.chatSession] ?? attrs[ATTR.session]);
        const credits = finite(attrs[ATTR.creditsNanoCanonical] ?? attrs[ATTR.creditsNano]);
        const { spanId } = contextIds(rec);
        if (id && credits !== null && (!spanId || !seenRoots.has(spanId))) {
          rootCredits.set(id, (rootCredits.get(id) ?? 0) + credits);
          if (spanId) seenRoots.add(spanId);
        }
      }
      const observation = observationFromJson(rec, index++, ancestorSession(rec));
      if (!observation) continue;
      const old = observations.get(observation.key);
      if (!old || observationScore(observation) > observationScore(old)) {
        observations.set(observation.key, observation);
      }
    }
  } catch {
    return null;
  }
  return observations.size ? { observations: [...observations.values()], rootCredits } : null;
}

function aggregate(
  path: string, observations: Observation[], tool: 'copilot' | 'copilot-cli',
  rootCredits: Map<string, number> = new Map()
): SessionMetrics[] {
  const groups = new Map<string, Observation[]>();
  for (const observation of observations) {
    const rows = groups.get(observation.sessionId) ?? [];
    rows.push(observation);
    groups.set(observation.sessionId, rows);
  }

  const result: SessionMetrics[] = [];
  for (const [sessionId, rows] of groups) {
    rows.sort((a, b) => a.startMs - b.startMs);
    const providers = new Set(rows.map((row) => row.provider).filter((v) => v !== 'unknown'));
    const accessModes = new Set(rows.map((row) => row.accessMode).filter((v) => v !== 'unknown'));
    const models = new Set(rows.map((row) => row.model).filter((v) => v !== 'unknown'));
    const servers = new Set(rows.map((row) => row.serverAddress).filter((v): v is string => Boolean(v)));
    const provider = providers.size === 0 ? 'unknown' : providers.size === 1 ? [...providers][0] : 'mixed';
    const accessMode: AccessMode = accessModes.size === 0
      ? 'unknown'
      : accessModes.size === 1 ? [...accessModes][0] : 'mixed';
    const model = models.size === 0 ? 'unknown' : models.size === 1 ? [...models][0] : 'mixed';

    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let reasoning = 0;
    let allCacheReadKnown = true;
    let allCacheWriteKnown = true;
    let allReasoningKnown = true;
    let actualCost = 0;
    let estimatedCost = 0;
    let actualRequests = 0;
    let estimatedRequests = 0;
    let unknownCost = false;
    let activeMs = 0;

    for (const row of rows) {
      const read = row.cacheRead ?? 0;
      const write = row.cacheWrite ?? 0;
      const uncached = Math.max(0, row.input - read - write);
      input += uncached;
      output += row.output;
      cacheRead += read;
      cacheWrite += write;
      reasoning += row.reasoning ?? 0;
      allCacheReadKnown &&= row.cacheRead !== null;
      allCacheWriteKnown &&= row.cacheWrite !== null;
      allReasoningKnown &&= row.reasoning !== null;
      activeMs += Math.max(0, row.endMs - row.startMs);

      if (tool === 'copilot' && row.creditsNano !== null && row.accessMode === 'copilot') {
        actualCost += row.creditsNano / 1e9 * 0.01;
        actualRequests++;
      } else {
        const estimated = (row.accessMode === 'copilot' ? copilotCostUsd : costUsd)(row.model, {
          input: uncached,
          output: row.output,
          cacheRead: row.cacheRead,
          cacheWrite: row.cacheWrite,
          reasoning: row.reasoning,
        });
        if (estimated === null) unknownCost = true;
        else estimatedCost += estimated;
        estimatedRequests++;
      }
    }

    // The CLI stamps its credit total on both the root and child spans.
    // Use only root invoke_agent totals; never add child chat credits to it.
    if (tool === 'copilot-cli' && accessMode === 'copilot' && rootCredits.has(sessionId)) {
      actualCost = (rootCredits.get(sessionId) ?? 0) / 1e9 * 0.01;
      actualRequests = 1;
      estimatedRequests = 0;
      estimatedCost = 0;
      unknownCost = false;
    }

    const first = Math.min(...rows.map((row) => row.startMs).filter((v) => v > 0));
    const last = Math.max(...rows.map((row) => row.endMs));
    if (!Number.isFinite(first) || !Number.isFinite(last)) continue;
    const project = tool === 'copilot'
      ? projectInfoOf(path, sessionId)
      : { project: 'unknown', source: 'unknown' as const };
    result.push({
      tool,
      sessionId,
      logPath: path,
      project: project.project,
      projectSource: project.source,
      model,
      accessMode,
      provider,
      serverAddress: servers.size === 0 ? null : servers.size === 1 ? [...servers][0] : 'mixed',
      startedAt: new Date(first).toISOString(),
      lastEventAt: new Date(last).toISOString(),
      durationSec: Math.round(Math.max(0, last - first) / 1000),
      activeSec: Math.round(activeMs / 1000),
      tokens: {
        input,
        output,
        cacheRead: allCacheReadKnown ? cacheRead : null,
        cacheWrite: allCacheWriteKnown ? cacheWrite : null,
        reasoning: allReasoningKnown ? reasoning : null,
      },
      costUsd: unknownCost ? null : actualCost + estimatedCost,
      estimated: estimatedRequests > 0,
      costSource: actualRequests > 0 && estimatedRequests > 0
        ? 'mixed'
        : actualRequests > 0 ? 'actual' : 'estimated',
      // The OTel trace tree includes foreground and descendant chat spans.
      metricScope: 'tree',
      turns: rows.length,
      parentSessionId: null,
    });
  }
  return result;
}

export const copilotOtelParser: Parser = {
  tool: 'copilot',

  defaultDirs() {
    return [...copilotWorkspaceRoots(), ...explicitOtelPaths()];
  },

  isLogFile(path: string) {
    const name = basename(path).toLowerCase();
    const normalized = path.replace(/\\/g, '/').toLowerCase();
    if (explicitCliOtelPaths().includes(resolve(path))) return false;
    if (explicitOtelPaths().includes(resolve(path))) return true;
    if (normalized.includes('/chatsessions/') || normalized.includes('/debug-logs/')) return false;
    if (name === 'agent-traces.db' || /(?:otel|trace).*\.db$/.test(name)) return true;
    if (!name.endsWith('.jsonl')) return false;
    return /(?:copilot|otel|trace)/.test(name);
  },

  async parseFile(path: string): Promise<SessionMetrics[] | null> {
    const name = basename(path).toLowerCase();
    const parsed = name.endsWith('.db')
      ? { observations: sqliteObservations(path), rootCredits: new Map<string, number>() }
      : await jsonlObservations(path);
    if (!parsed?.observations?.length) return null;
    const sessions = aggregate(path, parsed.observations, 'copilot');
    return sessions.length ? sessions : null;
  },
};

/** Standalone terminal Copilot CLI OTel file exporter. */
export const copilotCliOtelParser: Parser = {
  tool: 'copilot-cli',

  defaultDirs() {
    return explicitCliOtelPaths();
  },

  isLogFile(path: string) {
    const name = basename(path).toLowerCase();
    if (explicitOtelPaths().includes(resolve(path))) return false;
    if (explicitCliOtelPaths().includes(resolve(path))) return true;
    return path.toLowerCase().endsWith('.jsonl') &&
      /(?:copilot|otel|trace)/.test(name) &&
      name !== 'events.jsonl';
  },

  async parseFile(path: string): Promise<SessionMetrics[] | null> {
    const parsed = await jsonlObservations(path);
    if (!parsed?.observations.length) return null;
    const sessions = aggregate(path, parsed.observations, 'copilot-cli', parsed.rootCredits);
    return sessions.length ? sessions : null;
  },
};
