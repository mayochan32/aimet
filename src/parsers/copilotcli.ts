import { basename, dirname } from 'node:path';
import type { Parser, SessionMetrics, TokenUsage } from '../types.js';
import { jsonlRecords, activeSeconds, durationSeconds } from './util.js';

/**
 * GitHub Copilot CLI (the standalone `@github/copilot` agent) session logs:
 *   ~/.copilot/session-state/<session-uuid>/events.jsonl
 *
 * Event stream (each record: { type, timestamp, id, parentId, data }).
 *   session.start        -> data.sessionId, data.context.{cwd,repository}, copilotVersion
 *   session.model_change -> data.newModel
 *   assistant.turn_start -> one per assistant turn
 *   assistant.message    -> data.model, data.outputTokens (measured output tokens)
 *   tool.execution_*, function -> tool activity
 *
 * IMPORTANT LIMITATION: Copilot CLI records OUTPUT tokens only. There is no
 * input / cache / prompt token field anywhere in the log, so input, cacheR,
 * cacheW and reasoning are always 0, and cost is left null (an output-only
 * API-equivalent would badly understate the real cost, so we don't fake one).
 */
export const copilotCliParser: Parser = {
  tool: 'copilot-cli',

  defaultDirs() {
    return ['.copilot/session-state'];
  },

  isLogFile(path: string) {
    return basename(path) === 'events.jsonl';
  },

  async parseFile(path: string): Promise<SessionMetrics | null> {
    const timestamps: string[] = [];
    let sessionId = '';
    let cwd = '';
    let model = '';
    let turns = 0;
    let output = 0;

    for await (const rec of jsonlRecords(path)) {
      const ts = rec.timestamp as string | undefined;
      if (ts) timestamps.push(ts);
      const type = rec.type as string | undefined;
      const data = (rec.data ?? {}) as Record<string, unknown>;

      if (type === 'session.start') {
        if (typeof data.sessionId === 'string') sessionId = data.sessionId;
        const ctx = (data.context ?? {}) as Record<string, unknown>;
        if (typeof ctx.cwd === 'string') cwd = ctx.cwd;
        else if (typeof ctx.repository === 'string') cwd = ctx.repository;
      } else if (type === 'session.model_change') {
        if (typeof data.newModel === 'string') model = data.newModel;
      } else if (type === 'assistant.turn_start') {
        turns++;
      }

      // Output tokens can appear on assistant.message (and possibly function)
      // events; sum whatever is present. Model is also carried on messages.
      if (typeof data.model === 'string' && data.model) model = data.model;
      if (typeof data.outputTokens === 'number') output += data.outputTokens;
    }

    if (timestamps.length === 0) return null;
    timestamps.sort();
    const first = timestamps[0];
    const last = timestamps[timestamps.length - 1];

    const tokens: TokenUsage = {
      input: 0, // not recorded by Copilot CLI
      output,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    };

    return {
      tool: 'copilot-cli',
      sessionId: sessionId || basename(dirname(path)),
      logPath: path,
      project: cwd || 'unknown',
      model: model || 'unknown',
      startedAt: first,
      endedAt: last,
      durationSec: durationSeconds(first, last),
      activeSec: activeSeconds(timestamps),
      tokens,
      // Input tokens are unknown, so a meaningful API-equivalent cost cannot be
      // computed. Report null rather than a misleading output-only figure.
      costUsd: null,
      estimated: false, // the output tokens we do report are measured, not guessed
      turns,
      lastEventAt: last,
    };
  },
};
