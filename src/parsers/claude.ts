import { basename, dirname } from 'node:path';
import type { Parser, SessionMetrics, TokenUsage } from '../types.js';
import { costUsd } from '../pricing.js';
import { jsonlRecords, activeSeconds, durationSeconds } from './util.js';

/**
 * Claude Code session logs: ~/.claude/projects/<dashed-cwd>/<session-uuid>.jsonl
 * Each assistant record carries message.usage with a full token breakdown.
 * Token counts are per-request, so we sum them (deduped by message id).
 */
export const claudeParser: Parser = {
  tool: 'claude',

  defaultDirs() {
    return ['.claude/projects'];
  },

  isLogFile(path: string) {
    return path.endsWith('.jsonl');
  },

  async parseFile(path: string): Promise<SessionMetrics | null> {
    const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    const timestamps: string[] = [];
    const seenMsgIds = new Set<string>();
    let sessionId = '';
    let model = '';
    let cwd = '';
    let turns = 0;
    let cw1h = 0; // 1-hour-TTL cache writes (billed 2.0x input, vs 1.25x for 5m)
    let cw5m = 0;

    for await (const rec of jsonlRecords(path)) {
      const ts = rec.timestamp as string | undefined;
      if (ts) timestamps.push(ts);
      if (!sessionId && typeof rec.sessionId === 'string') sessionId = rec.sessionId;
      if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;

      if (rec.type !== 'assistant') continue;
      const msg = rec.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      if (typeof msg.model === 'string') model = msg.model;

      // Dedupe retried/streamed duplicates of the same API message.
      // Count the turn only AFTER dedup so retries don't inflate the turn count.
      const id = (msg.id as string) ?? (rec.uuid as string) ?? '';
      if (id) {
        if (seenMsgIds.has(id)) continue;
        seenMsgIds.add(id);
      }
      turns++;
      const u = msg.usage as Record<string, number> | undefined;
      if (!u) continue;
      tokens.input += u.input_tokens ?? 0;
      tokens.output += u.output_tokens ?? 0;
      tokens.cacheRead += u.cache_read_input_tokens ?? 0;
      tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
      const cc = (u as Record<string, unknown>).cache_creation as
        | Record<string, number>
        | undefined;
      cw1h += cc?.ephemeral_1h_input_tokens ?? 0;
      cw5m += cc?.ephemeral_5m_input_tokens ?? 0;
    }

    if (timestamps.length === 0) return null;
    timestamps.sort();
    const first = timestamps[0];
    const last = timestamps[timestamps.length - 1];
    // Fall back: recover project path from the dashed directory name.
    const project = cwd || dirname(path).split('/').pop()!.replace(/^-/, '/').replace(/-/g, '/');

    return {
      tool: 'claude',
      sessionId: sessionId || basename(path, '.jsonl'),
      logPath: path,
      project,
      model: model || 'unknown',
      startedAt: first,
      endedAt: last,
      durationSec: durationSeconds(first, last),
      activeSec: activeSeconds(timestamps),
      tokens,
      // Pricing: the cacheWrite rate in the table is the 5m rate (1.25x input).
      // 1h-TTL writes are billed 2.0x input = 1.6x the 5m rate, so convert
      // them to "5m-equivalent" tokens for cost purposes when the split is known.
      costUsd: model
        ? costUsd(
            model,
            cw1h + cw5m > 0
              ? { ...tokens, cacheWrite: Math.round(cw5m + 1.6 * cw1h) }
              : tokens
          )
        : null,
      estimated: false,
      turns,
      lastEventAt: last,
    };
  },
};
