import { basename } from 'node:path';
import type { Parser, SessionMetrics, TokenUsage } from '../types.js';
import { costUsd } from '../pricing.js';
import { jsonlRecords } from './util.js';
import { projectOf } from './copilot.js';

/**
 * GitHub Copilot Chat SUBAGENT sessions (multi-agent, VS Code):
 *   <userData>/User/workspaceStorage/<hash>/GitHub.copilot-chat/
 *     debug-logs/<parent-session-uuid>/runSubagent-<Agent>-<callId>.jsonl
 *
 * Span-trace format (one span per line):
 *   { v?, ts(ms), dur(ms), sid, type, name, spanId, parentSpanId?, status, attrs }
 *   - session_start: attrs.{copilotVersion, vscodeVersion, parentSessionId, label}
 *   - llm_request:   attrs.{model, inputTokens, outputTokens, cachedTokens, ttft}
 *   - turn_start / turn_end / tool_call / agent_response / subagent
 *
 * Why only runSubagent-*.jsonl:
 *   main.jsonl in the same directory records the PARENT session, which is
 *   already ingested from chatSessions/ — parsing it would double count.
 *   title-*.jsonl is the tiny title-generation request; skipped as noise.
 *
 * Cost: span logs record measured tokens but no credits, so cost is the
 * API-equivalent estimate by model (estimated=true, consistent with the
 * chat parser's no-credit fallback).
 *
 * NOTE: these logs exist only when Copilot Chat's debug file logging is
 * active. Without it, subagent usage is not recoverable from disk.
 */
export const copilotSubagentParser: Parser = {
  tool: 'copilot',

  defaultDirs() {
    return [
      'Library/Application Support/Code/User/workspaceStorage', // macOS
      '.config/Code/User/workspaceStorage', // Linux
      'AppData/Roaming/Code/User/workspaceStorage', // Windows
    ];
  },

  isLogFile(path: string) {
    return basename(path).startsWith('runSubagent-') && path.endsWith('.jsonl');
  },

  async parseFile(path: string): Promise<SessionMetrics | null> {
    const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    let sessionId = '';
    let parentSessionId: string | null = null;
    let label = '';
    let model = '';
    let turns = 0;
    let requests = 0;
    let firstTs = Infinity;
    let lastTs = 0;
    let activeMs = 0;

    for await (const rec of jsonlRecords(path)) {
      const ts = Number(rec.ts ?? 0);
      const dur = Number(rec.dur ?? 0);
      if (ts > 0) {
        firstTs = Math.min(firstTs, ts);
        lastTs = Math.max(lastTs, ts + (Number.isFinite(dur) ? dur : 0));
      }
      const attrs = (rec.attrs ?? {}) as Record<string, unknown>;

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
          requests++;
          const cached = Number(attrs.cachedTokens ?? 0);
          // inputTokens includes cachedTokens (OpenAI-style); split them.
          tokens.input += Math.max(0, Number(attrs.inputTokens ?? 0) - cached);
          tokens.cacheRead += cached;
          tokens.output += Number(attrs.outputTokens ?? 0);
          if (typeof attrs.model === 'string') model = attrs.model;
          if (Number.isFinite(dur)) activeMs += dur;
          break;
        }
      }
    }

    if (!sessionId || requests === 0 || !Number.isFinite(firstTs)) return null;

    return {
      tool: 'copilot',
      sessionId,
      logPath: path,
      project: projectOf(path),
      model: `${model || 'unknown'}${label ? ` (${label})` : ''}`,
      startedAt: new Date(firstTs).toISOString(),
      endedAt: new Date(lastTs).toISOString(),
      durationSec: Math.round((lastTs - firstTs) / 1000),
      activeSec: Math.round(activeMs / 1000),
      tokens,
      costUsd: model ? costUsd(model, tokens) : null,
      estimated: true, // API-equivalent (span logs carry no credit spend)
      turns,
      lastEventAt: new Date(lastTs).toISOString(),
      parentSessionId,
    };
  },
};
