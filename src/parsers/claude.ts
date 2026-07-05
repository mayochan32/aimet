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

    for await (const rec of jsonlRecords(path)) {
      const ts = rec.timestamp as string | undefined;
      if (ts) timestamps.push(ts);
      if (!sessionId && typeof rec.sessionId === 'string') sessionId = rec.sessionId;
      if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;

      if (rec.type !== 'assistant') continue;
      const msg = rec.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      turns++;
      if (typeof msg.model === 'string') model = msg.model;

      // Dedupe retried/streamed duplicates of the same API message.
      const id = (msg.id as string) ?? (rec.uuid as string) ?? '';
      if (id) {
        if (seenMsgIds.has(id)) continue;
        seenMsgIds.add(id);
      }
      const u = msg.usage as Record<string, number> | undefined;
      if (!u) continue;
      tokens.input += u.input_tokens ?? 0;
      tokens.output += u.output_tokens ?? 0;
      tokens.cacheRead += u.cache_read_input_tokens ?? 0;
      tokens.cacheWrite += u.cache_creation_input_tokens ?? 0;
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
      costUsd: model ? costUsd(model, tokens) : null,
      estimated: false,
      turns,
      lastEventAt: last,
    };
  },
};
