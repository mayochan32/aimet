import { basename, join } from 'node:path';
import type { Parser, SessionMetrics, TokenUsage } from '../types.js';
import { billsCacheWrites, costUsd, hasLongContextSurcharge } from '../pricing.js';
import { codexHome } from '../paths.js';
import { jsonlRecords, activeSeconds, durationSeconds } from './util.js';

interface CodexSessionMeta {
  sessionId: string;
  parentSessionId: string | null;
  isSubagent: boolean;
  subagentLabel: string;
  cwd: string;
}

/**
 * Codex CLI rollout logs:
 * ${CODEX_HOME:-~/.codex}/sessions/**&#47;rollout-<ts>-<uuid>.jsonl
 * token_count events carry CUMULATIVE totals (info.total_token_usage), so we
 * keep the maximum observed rather than summing. Request deltas are separately
 * validated against last_token_usage for conditional pricing.
 * Note: input_tokens includes cached reads and, on GPT-5.6, explicit cache
 * writes; we split all three mutually exclusive billing classes.
 */
export const codexParser: Parser = {
  tool: 'codex',

  defaultDirs() {
    return [join(codexHome(), 'sessions')];
  },

  isLogFile(path: string) {
    return basename(path).startsWith('rollout-') && path.endsWith('.jsonl');
  },

  async parseFile(path: string): Promise<SessionMetrics | null> {
    const timestamps: string[] = [];
    let model = '';
    let turnCwd = '';
    let turns = 0;
    let best: Record<string, number> | null = null; // largest cumulative usage
    let previousTotal: Record<string, number> | null = null;
    const requestUsages: TokenUsage[] = [];
    let requestUsageComplete = true;
    const sessionMetas: CodexSessionMeta[] = [];

    for await (const rec of jsonlRecords(path)) {
      const ts = rec.timestamp as string | undefined;
      if (ts) timestamps.push(ts);
      const payload = rec.payload as Record<string, unknown> | undefined;
      if (!payload) continue;

      if (rec.type === 'session_meta') {
        const meta = codexSessionMeta(payload);
        if (meta) sessionMetas.push(meta);
      } else if (rec.type === 'turn_context') {
        if (typeof payload.model === 'string') model = payload.model;
        if (typeof payload.cwd === 'string' && !turnCwd) turnCwd = payload.cwd;
      } else if (rec.type === 'event_msg') {
        const pt = payload.type;
        if (pt === 'task_started') turns++;
        if (pt === 'token_count') {
          const info = payload.info as Record<string, unknown> | undefined;
          const total = info?.total_token_usage as Record<string, number> | undefined;
          if (total && (!best || (total.total_tokens ?? 0) >= (best.total_tokens ?? 0))) {
            best = total;
          }
          if (total && (total.total_tokens ?? 0) > (previousTotal?.total_tokens ?? 0)) {
            const last = info?.last_token_usage as Record<string, number> | undefined;
            if (last && usageMatchesDelta(previousTotal, total, last)) {
              requestUsages.push(codexTokens(last));
            } else {
              requestUsageComplete = false;
            }
            previousTotal = total;
          }
        }
      }
    }

    if (timestamps.length === 0 || !best) return null;
    timestamps.sort();
    const first = timestamps[0];
    const last = timestamps[timestamps.length - 1];

    const tokens = codexTokens(best);

    // Filename fallback: rollout-2026-07-04T17-10-43-<uuid>.jsonl
    const idFromName = basename(path, '.jsonl').split('-').slice(7).join('-');
    const identity = resolveCodexSessionMeta(path, sessionMetas);
    const sessionId = identity?.sessionId || idFromName || basename(path, '.jsonl');
    const parentSessionId = identity?.parentSessionId ?? null;
    const subagentLabel = identity?.subagentLabel ?? '';
    const cwd = identity?.cwd || turnCwd;

    // When the log carries no model name we fall back to gpt-5-codex pricing.
    // Tokens are still measured, but the unit price is a guess -> mark estimated.
    const modelKnown = model !== '';
    const resolvedModel = model || 'gpt-5-codex';
    const needsRequestPricing = hasLongContextSurcharge(resolvedModel);
    const missingBilledCacheWrites = billsCacheWrites(resolvedModel) && tokens.cacheWrite === null;
    const exactRequestPricing = requestUsageComplete && requestUsages.length > 0 &&
      !requestUsages.some((usage) => billsCacheWrites(resolvedModel) && usage.cacheWrite === null);
    const sessionCost = needsRequestPricing && exactRequestPricing
      ? sumKnownCosts(requestUsages.map((usage) => costUsd(resolvedModel, usage)))
      : costUsd(resolvedModel, tokens, { applyLongContextSurcharge: !needsRequestPricing });
    return {
      tool: 'codex',
      sessionId: sessionId || idFromName || basename(path, '.jsonl'),
      logPath: path,
      project: cwd || 'unknown',
      model: `${resolvedModel}${subagentLabel ? ` (subagent:${subagentLabel})` : ''}`,
      startedAt: first,
      durationSec: durationSeconds(first, last),
      activeSec: activeSeconds(timestamps),
      tokens,
      costUsd: sessionCost,
      estimated: !modelKnown || missingBilledCacheWrites || (needsRequestPricing && !exactRequestPricing),
      turns,
      lastEventAt: last,
      parentSessionId,
    };
  },
};

function codexTokens(usage: Record<string, number>): TokenUsage {
  const cached = usage.cached_input_tokens ?? 0;
  const cacheWrite = typeof usage.cache_write_input_tokens === 'number'
    ? usage.cache_write_input_tokens
    : null;
  return {
    // Codex/OpenAI input_tokens includes both cached reads and explicit cache
    // writes. Store the mutually exclusive billing classes separately.
    input: Math.max(0, (usage.input_tokens ?? 0) - cached - (cacheWrite ?? 0)),
    output: usage.output_tokens ?? 0,
    cacheRead: cached,
    cacheWrite,
    reasoning: usage.reasoning_output_tokens ?? 0,
  };
}

function usageMatchesDelta(
  previous: Record<string, number> | null,
  total: Record<string, number>,
  last: Record<string, number>
): boolean {
  const fields = [
    'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
    'output_tokens', 'reasoning_output_tokens', 'total_tokens',
  ];
  return fields.every((field) => {
    if (typeof last[field] !== 'number') {
      return field === 'cache_write_input_tokens' && typeof total[field] !== 'number';
    }
    return (total[field] ?? 0) - (previous?.[field] ?? 0) === last[field];
  });
}

function sumKnownCosts(costs: Array<number | null>): number | null {
  let total = 0;
  for (const cost of costs) {
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

/**
 * Convert one session_meta payload into an identity candidate without relying
 * on its position in the JSONL file. Current subagents provide an explicit
 * parent_thread_id; older multi-agent logs used session_id for the parent.
 */
function codexSessionMeta(payload: Record<string, unknown>): CodexSessionMeta | null {
  const ownId = typeof payload.id === 'string' ? payload.id : '';
  const loggedSessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
  const src = isRecord(payload.source) ? payload.source : undefined;
  const sub = isRecord(src?.subagent) ? src.subagent : undefined;
  const isSubagent = payload.thread_source === 'subagent' || sub !== undefined;
  const sessionId = isSubagent ? (ownId || loggedSessionId) : (loggedSessionId || ownId);
  if (!sessionId) return null;

  let parentSessionId: string | null = null;
  let subagentLabel = '';
  if (isSubagent) {
    const explicitParent = typeof payload.parent_thread_id === 'string'
      ? payload.parent_thread_id
      : '';
    if (explicitParent && explicitParent !== sessionId) parentSessionId = explicitParent;
    else if (loggedSessionId && loggedSessionId !== sessionId) parentSessionId = loggedSessionId;

    const kind = sub ? Object.values(sub)[0] : undefined;
    const spawn = isRecord(kind) ? kind : undefined;
    if (typeof payload.agent_role === 'string') subagentLabel = payload.agent_role;
    else if (typeof kind === 'string') subagentLabel = kind;
    else if (typeof spawn?.agent_role === 'string') subagentLabel = spawn.agent_role;
  }

  return {
    sessionId,
    parentSessionId,
    isSubagent,
    subagentLabel,
    cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
  };
}

/**
 * Resolve the rollout's own identity from every session_meta record.
 *
 * Codex's public documentation does not promise session_meta ordering. Some
 * observed child rollouts contain both child and inherited parent metadata, so
 * "first record wins" and "last record wins" are both unsafe. A UUID matching
 * the rollout filename is the strongest consistency check. When the filename
 * cannot decide, explicit subagent metadata is preferred. Irreconcilable
 * candidates are rejected instead of silently merging a child into its parent.
 */
function resolveCodexSessionMeta(
  path: string,
  candidates: CodexSessionMeta[]
): CodexSessionMeta | null {
  if (candidates.length === 0) return null;

  const rolloutId = rolloutUuid(path);
  if (rolloutId) {
    const filenameMatches = candidates.filter(
      (candidate) => candidate.sessionId === rolloutId
    );
    if (filenameMatches.length > 0) {
      const selected = resolveEquivalentMetas(filenameMatches, path, 'rollout filename');
      return validateSelectedMeta(selected, candidates, path, 'rollout filename');
    }
  }

  const subagentCandidates = candidates.filter((candidate) => candidate.isSubagent);
  if (subagentCandidates.length > 0) {
    const selected = resolveEquivalentMetas(subagentCandidates, path, 'subagent metadata');
    return validateSelectedMeta(selected, candidates, path, 'subagent metadata');
  }

  return resolveEquivalentMetas(candidates, path, 'session metadata');
}

function resolveEquivalentMetas(
  candidates: CodexSessionMeta[],
  path: string,
  evidence: string
): CodexSessionMeta {
  const sessionIds = new Set(candidates.map((candidate) => candidate.sessionId));
  const parentIds = new Set(
    candidates
      .map((candidate) => candidate.parentSessionId)
      .filter((parent): parent is string => parent !== null)
  );

  if (sessionIds.size !== 1 || parentIds.size > 1) {
    throw new Error(`ambiguous Codex ${evidence} in ${basename(path)}`);
  }

  const subagent = candidates.find((candidate) => candidate.isSubagent);
  const withParent = candidates.find((candidate) => candidate.parentSessionId !== null);
  const withLabel = candidates.find((candidate) => candidate.subagentLabel !== '');
  const withCwd = candidates.find((candidate) => candidate.cwd !== '');
  const base = subagent ?? withParent ?? candidates[0];

  return {
    ...base,
    parentSessionId: withParent?.parentSessionId ?? base.parentSessionId,
    subagentLabel: withLabel?.subagentLabel ?? base.subagentLabel,
    cwd: withCwd?.cwd ?? base.cwd,
  };
}

function validateSelectedMeta(
  selected: CodexSessionMeta,
  candidates: CodexSessionMeta[],
  path: string,
  evidence: string
): CodexSessionMeta {
  for (const candidate of candidates) {
    if (candidate.sessionId === selected.sessionId) continue;
    // An observed child rollout may also carry metadata for its inherited
    // parent. That is consistent only when it names the selected child's
    // explicit parent and is not itself another subagent candidate.
    if (
      selected.isSubagent &&
      !candidate.isSubagent &&
      selected.parentSessionId === candidate.sessionId
    ) {
      continue;
    }
    throw new Error(`ambiguous Codex ${evidence} in ${basename(path)}`);
  }
  return selected;
}

function rolloutUuid(path: string): string {
  const match = basename(path, '.jsonl').match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
  );
  return match?.[1] ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
