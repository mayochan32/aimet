import { basename } from 'node:path';
import type { Parser, SessionMetrics, TokenUsage } from '../types.js';
import { costUsd } from '../pricing.js';
import { jsonlRecords, activeSeconds, durationSeconds } from './util.js';

/**
 * Codex CLI rollout logs: ~/.codex/sessions/**&#47;rollout-<ts>-<uuid>.jsonl
 * token_count events carry CUMULATIVE totals (info.total_token_usage),
 * so we keep the maximum observed rather than summing.
 * Note: input_tokens INCLUDES cached_input_tokens; we split them apart
 * to match the common schema (input = uncached input).
 */
export const codexParser: Parser = {
  tool: 'codex',

  defaultDirs() {
    return ['.codex/sessions'];
  },

  isLogFile(path: string) {
    return basename(path).startsWith('rollout-') && path.endsWith('.jsonl');
  },

  async parseFile(path: string): Promise<SessionMetrics | null> {
    const timestamps: string[] = [];
    let sessionId = '';
    let model = '';
    let cwd = '';
    let turns = 0;
    let best: Record<string, number> | null = null; // largest cumulative usage
    let parentSessionId: string | null = null;
    let subagentLabel = '';

    for await (const rec of jsonlRecords(path)) {
      const ts = rec.timestamp as string | undefined;
      if (ts) timestamps.push(ts);
      const payload = rec.payload as Record<string, unknown> | undefined;
      if (!payload) continue;

      if (rec.type === 'session_meta') {
        // Multi-agent v2 (CLI >= 0.137): subagent threads are SEPARATE
        // rollout files where payload.session_id holds the PARENT's id and
        // payload.id holds this thread's own id. Keying by session_id there
        // would collide with the parent row, so distinguish the two.
        const own = typeof payload.id === 'string' ? payload.id : '';
        const sess = typeof payload.session_id === 'string' ? payload.session_id : '';
        if (payload.thread_source === 'subagent') {
          sessionId = own || sess;
          if (sess && sess !== sessionId) parentSessionId = sess;
          const src = payload.source as Record<string, unknown> | undefined;
          const sub = src?.subagent as Record<string, unknown> | undefined;
          const kind = sub && typeof sub === 'object' ? Object.values(sub)[0] : undefined;
          if (typeof kind === 'string') subagentLabel = kind;
        } else {
          sessionId = sess || own;
        }
        if (typeof payload.cwd === 'string') cwd = payload.cwd;
      } else if (rec.type === 'turn_context') {
        if (typeof payload.model === 'string') model = payload.model;
        if (typeof payload.cwd === 'string' && !cwd) cwd = payload.cwd;
      } else if (rec.type === 'event_msg') {
        const pt = payload.type;
        if (pt === 'task_started') turns++;
        if (pt === 'token_count') {
          const info = payload.info as Record<string, unknown> | undefined;
          const total = info?.total_token_usage as Record<string, number> | undefined;
          if (total && (!best || (total.total_tokens ?? 0) >= (best.total_tokens ?? 0))) {
            best = total;
          }
        }
      }
    }

    if (timestamps.length === 0 || !best) return null;
    timestamps.sort();
    const first = timestamps[0];
    const last = timestamps[timestamps.length - 1];

    const cached = best.cached_input_tokens ?? 0;
    const tokens: TokenUsage = {
      input: Math.max(0, (best.input_tokens ?? 0) - cached),
      output: best.output_tokens ?? 0,
      cacheRead: cached,
      cacheWrite: 0,
      reasoning: best.reasoning_output_tokens ?? 0,
    };

    // Filename fallback: rollout-2026-07-04T17-10-43-<uuid>.jsonl
    const idFromName = basename(path, '.jsonl').split('-').slice(7).join('-');

    // When the log carries no model name we fall back to gpt-5-codex pricing.
    // Tokens are still measured, but the unit price is a guess -> mark estimated.
    const modelKnown = model !== '';
    const resolvedModel = model || 'gpt-5-codex';
    return {
      tool: 'codex',
      sessionId: sessionId || idFromName || basename(path, '.jsonl'),
      logPath: path,
      project: cwd || 'unknown',
      model: `${resolvedModel}${subagentLabel ? ` (subagent:${subagentLabel})` : ''}`,
      startedAt: first,
      endedAt: last,
      durationSec: durationSeconds(first, last),
      activeSec: activeSeconds(timestamps),
      tokens,
      costUsd: costUsd(resolvedModel, tokens),
      estimated: !modelKnown,
      turns,
      lastEventAt: last,
      parentSessionId,
    };
  },
};
