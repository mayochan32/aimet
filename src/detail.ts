import { jsonlRecords } from './parsers/util.js';

/**
 * Full-detail dump of a single session log.
 * Emits everything the JSONL records, organized but unfiltered:
 * raw usage objects, rate limits, CLI versions, event type counts, etc.
 */

export async function detailClaude(path: string, raw = false): Promise<Record<string, unknown>> {
  const meta: Record<string, unknown> = {};
  const turns: Record<string, unknown>[] = [];
  const eventCounts: Record<string, number> = {};
  const models = new Set<string>();

  for await (const rec of jsonlRecords(path)) {
    const t = String(rec.type ?? 'unknown');
    eventCounts[t] = (eventCounts[t] ?? 0) + 1;

    // Session-level metadata (first occurrence wins).
    for (const k of ['sessionId', 'cwd', 'version', 'gitBranch', 'userType']) {
      if (meta[k] === undefined && rec[k] !== undefined) meta[k] = rec[k];
    }

    if (t !== 'assistant') continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    if (typeof msg.model === 'string') models.add(msg.model);
    const content = msg.content as { type?: string; name?: string }[] | undefined;
    turns.push({
      timestamp: rec.timestamp,
      messageId: msg.id,
      model: msg.model,
      stopReason: msg.stop_reason ?? null,
      contentTypes: Array.isArray(content)
        ? content.map((c) => (c.type === 'tool_use' ? `tool_use:${c.name}` : c.type))
        : [],
      usage: msg.usage ?? null, // raw, complete (incl. service_tier, cache_creation 1h/5m, ...)
      ...(raw ? { rawRecord: rec } : {}),
    });
  }
  return { tool: 'claude', logPath: path, meta, models: [...models], eventCounts, requests: turns };
}

export async function detailCodex(path: string, raw = false): Promise<Record<string, unknown>> {
  let sessionMeta: Record<string, unknown> | null = null;
  const turnContexts: Record<string, unknown>[] = [];
  const tokenTimeline: Record<string, unknown>[] = [];
  const eventCounts: Record<string, number> = {};
  const models = new Set<string>();

  for await (const rec of jsonlRecords(path)) {
    const t = String(rec.type ?? 'unknown');
    const payload = rec.payload as Record<string, unknown> | undefined;
    const sub = payload && typeof payload.type === 'string' ? `:${payload.type}` : '';
    eventCounts[t + sub] = (eventCounts[t + sub] ?? 0) + 1;
    if (!payload) continue;

    if (t === 'session_meta' && !sessionMeta) {
      // Keep everything except huge embedded texts/schemas (unless --raw).
      const { base_instructions, dynamic_tools, ...rest } = payload;
      sessionMeta = raw ? payload : rest;
    } else if (t === 'turn_context') {
      if (typeof payload.model === 'string') models.add(payload.model);
      turnContexts.push({ timestamp: rec.timestamp, ...payload });
    } else if (t === 'event_msg' && payload.type === 'token_count') {
      tokenTimeline.push({
        timestamp: rec.timestamp,
        info: payload.info ?? null,          // total + last usage, context window
        rate_limits: payload.rate_limits ?? null, // used_percent, plan_type, credits...
      });
    }
  }
  return {
    tool: 'codex',
    logPath: path,
    meta: sessionMeta,
    models: [...models],
    eventCounts,
    turnContexts,
    tokenTimeline,
  };
}

export async function detail(
  tool: string,
  path: string,
  raw = false
): Promise<Record<string, unknown>> {
  if (tool === 'claude') return detailClaude(path, raw);
  if (tool === 'codex') return detailCodex(path, raw);
  throw new Error(`detail not supported for tool: ${tool}`);
}
