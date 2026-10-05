import { basename, dirname, join } from 'node:path';
import type { Parser, SessionMetrics, TokenUsage } from '../types.js';
import { claudeCostUsd } from '../pricing.js';
import { claudeConfigDir } from '../paths.js';
import { jsonlRecords, activeSeconds, durationSeconds } from './util.js';

/**
 * Claude Code session logs:
 * ${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<dashed-cwd>/<session-uuid>.jsonl
 * Subagent transcripts:
 * ${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<dashed-cwd>/<session-uuid>/
 *   subagents/agent-<agent-id>.jsonl
 *
 * Claude scopes a subagent transcript by the parent session id plus a
 * subpath. Records in a child transcript can therefore carry the same
 * sessionId as the parent. Use the documented path to create a distinct
 * child key and link it back to the parent instead of trusting that field as
 * a globally unique child id.
 *
 * Each assistant record carries message.usage with a full token breakdown.
 * Token counts are per-request, so we sum them (deduped by message id).
 */
export const claudeParser: Parser = {
  tool: 'claude',

  defaultDirs() {
    return [join(claudeConfigDir(), 'projects')];
  },

  isLogFile(path: string) {
    if (!path.endsWith('.jsonl')) return false;
    if (basename(dirname(path)) !== 'subagents') return true;
    return /^agent-.+\.jsonl$/.test(basename(path));
  },

  async parseFile(path: string): Promise<SessionMetrics | null> {
    const fileName = basename(path);
    const logDir = dirname(path);
    const isSubagent =
      basename(logDir) === 'subagents' && /^agent-.+\.jsonl$/.test(fileName);
    const fileSessionId = basename(path, '.jsonl');
    const parentSessionId = isSubagent ? basename(dirname(logDir)) : null;

    // Anthropic logs do not report reasoning tokens separately -> null (= not recorded).
    const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null };
    const timestamps: string[] = [];
    const messages = new Map<string, { model: string; usage: Record<string, unknown> | null }>();
    let sessionId = '';
    let model = '';
    let cwd = '';
    let turns = 0;
    let unknownCost = false;
    let estimated = false;
    let totalCost = 0;
    let anonymous = 0;

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
      const id = typeof msg.id === 'string' ? msg.id :
        typeof rec.uuid === 'string' ? rec.uuid : `anonymous:${anonymous++}`;
      const usage = msg.usage && typeof msg.usage === 'object'
        ? msg.usage as Record<string, unknown> : null;
      const previous = messages.get(id);
      const output = Number(usage?.output_tokens ?? 0);
      const previousOutput = Number(previous?.usage?.output_tokens ?? 0);
      // Stream snapshots share an API message id. Keep the most complete
      // usage snapshot rather than the first (which may have 0 output).
      if (!previous || (usage && (!previous.usage || output >= previousOutput))) {
        messages.set(id, { model: typeof msg.model === 'string' ? msg.model : model, usage });
      }
    }

    turns = messages.size;
    const models = new Set<string>();
    for (const entry of messages.values()) {
      const u = entry.usage;
      if (!u) continue;
      const usageTokens: TokenUsage = {
        input: Number(u.input_tokens ?? 0),
        output: Number(u.output_tokens ?? 0),
        cacheRead: Number(u.cache_read_input_tokens ?? 0),
        cacheWrite: Number(u.cache_creation_input_tokens ?? 0),
        reasoning: null,
      };
      const cc = u.cache_creation && typeof u.cache_creation === 'object'
        ? u.cache_creation as Record<string, number> : null;
      const oneHour = cc?.ephemeral_1h_input_tokens ?? 0;
      const fiveMinute = cc?.ephemeral_5m_input_tokens ?? 0;
      tokens.input = (tokens.input ?? 0) + (usageTokens.input ?? 0);
      tokens.output = (tokens.output ?? 0) + (usageTokens.output ?? 0);
      tokens.cacheRead = (tokens.cacheRead ?? 0) + (usageTokens.cacheRead ?? 0);
      tokens.cacheWrite = (tokens.cacheWrite ?? 0) + (usageTokens.cacheWrite ?? 0);
      if (entry.model) models.add(entry.model);
      const writeForCost = oneHour + fiveMinute > 0
        ? (fiveMinute + 1.6 * oneHour) : usageTokens.cacheWrite;
      const priced = claudeCostUsd(entry.model, { ...usageTokens, cacheWrite: writeForCost }, u.speed);
      estimated ||= priced.estimated;
      if (priced.cost === null) unknownCost = true;
      else totalCost += priced.cost;
      // Advisor usage is NOT included in the top-level executor totals.
      const iterations = Array.isArray(u.iterations) ? u.iterations : [];
      for (const iteration of iterations) {
        if (!iteration || typeof iteration !== 'object') continue;
        const advisor = iteration as Record<string, unknown>;
        if (advisor.type !== 'advisor_message') continue;
        const advisorModel = typeof advisor.model === 'string' ? advisor.model : '';
        const advisorTokens: TokenUsage = {
          input: Number(advisor.input_tokens ?? 0),
          output: Number(advisor.output_tokens ?? 0),
          cacheRead: Number(advisor.cache_read_input_tokens ?? 0),
          cacheWrite: Number(advisor.cache_creation_input_tokens ?? 0),
          reasoning: null,
        };
        const advisorCache = advisor.cache_creation && typeof advisor.cache_creation === 'object'
          ? advisor.cache_creation as Record<string, number> : null;
        const advisor1h = advisorCache?.ephemeral_1h_input_tokens ?? 0;
        const advisor5m = advisorCache?.ephemeral_5m_input_tokens ?? 0;
        tokens.input = (tokens.input ?? 0) + (advisorTokens.input ?? 0);
        tokens.output = (tokens.output ?? 0) + (advisorTokens.output ?? 0);
        tokens.cacheRead = (tokens.cacheRead ?? 0) + (advisorTokens.cacheRead ?? 0);
        tokens.cacheWrite = (tokens.cacheWrite ?? 0) + (advisorTokens.cacheWrite ?? 0);
        if (advisorModel) models.add(advisorModel);
        const advisorPrice = claudeCostUsd(advisorModel, {
          ...advisorTokens,
          cacheWrite: advisor1h + advisor5m > 0
            ? advisor5m + 1.6 * advisor1h : advisorTokens.cacheWrite,
        }, advisor.speed);
        estimated ||= advisorPrice.estimated;
        if (advisorPrice.cost === null) unknownCost = true;
        else totalCost += advisorPrice.cost;
      }
    }

    if (timestamps.length === 0) return null;
    timestamps.sort();
    const first = timestamps[0];
    const last = timestamps[timestamps.length - 1];
    // Fall back: recover the project from its dashed directory name. A child
    // is nested two additional levels below that directory:
    // <project>/<parent>/subagents/agent-<id>.jsonl.
    const projectDir = isSubagent ? dirname(dirname(logDir)) : logDir;
    const project = cwd || basename(projectDir).replace(/^-/, '/').replace(/-/g, '/');

    // The official storage key is (parent sessionId, subagent subpath). Encode
    // that pair into aimet's single session_id column. This remains unique even
    // when every record inside the child transcript repeats the parent's id.
    const resolvedSessionId = isSubagent && parentSessionId
      ? `${parentSessionId}/${fileSessionId}`
      : sessionId || fileSessionId;

    return {
      tool: 'claude',
      sessionId: resolvedSessionId,
      logPath: path,
      project,
      projectSource: 'log',
      model: models.size > 1 ? 'mixed' : ([...models][0] || model || 'unknown'),
      startedAt: first,
      durationSec: durationSeconds(first, last),
      activeSec: activeSeconds(timestamps),
      tokens,
      // Pricing: the cacheWrite rate in the table is the 5m rate (1.25x input).
      // 1h-TTL writes are billed 2.0x input = 1.6x the 5m rate, so convert
      // them to "5m-equivalent" tokens for cost purposes when the split is known.
      costUsd: unknownCost ? null : totalCost,
      estimated,
      metricScope: 'own',
      turns,
      lastEventAt: last,
      parentSessionId,
    };
  },
};
