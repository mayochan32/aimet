import { basename, dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Parser, SessionMetrics, TokenUsage } from '../types.js';
import { costUsd } from '../pricing.js';
import { jsonlRecords } from './util.js';

/**
 * GitHub Copilot Chat (VS Code) session logs:
 *   <userData>/User/workspaceStorage/<hash>/chatSessions/<session-uuid>.jsonl
 *
 * Format: incremental key-path records.
 *   kind:0 -> { v: <base session object> }
 *   kind:1 / kind:2 -> { k: [path segments], v: <value> }  (set value at path)
 * The reduced object has requests[] with measured promptTokens /
 * completionTokens, resolvedModel, elapsedMs and copilotCredits.
 *
 * Cost: prefer actual spend (copilotCredits x $0.01). Fall back to the
 * API-equivalent estimate (estimated=true) when no credits are recorded.
 */

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Reject keys that could pollute the prototype chain or aren't plain path segments. */
function isSafeKey(key: unknown): key is string | number {
  return (
    (typeof key === 'string' && key.length > 0 && !BLOCKED_KEYS.has(key)) ||
    (typeof key === 'number' && Number.isInteger(key) && key >= 0)
  );
}

function setPath(obj: Record<string, unknown>, path: unknown[], value: unknown): void {
  if (path.length === 0 || !path.every(isSafeKey)) return; // ignore empty/unsafe paths
  let cur: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as string | number;
    const next = (cur as Record<string, unknown>)[key as string];
    if (typeof next !== 'object' || next === null) {
      (cur as Record<string, unknown>)[key as string] =
        typeof path[i + 1] === 'number' ? [] : Object.create(null);
    }
    cur = (cur as Record<string, unknown>)[key as string] as Record<string, unknown>;
  }
  (cur as Record<string, unknown>)[path[path.length - 1] as string] = value;
}

/** Reduce the incremental records into the final session object. */
export async function reduceSession(path: string): Promise<Record<string, unknown>> {
  let session: Record<string, unknown> = {};
  for await (const rec of jsonlRecords(path)) {
    if (rec.kind === 0) {
      session = (rec.v as Record<string, unknown>) ?? {};
    } else if (Array.isArray(rec.k)) {
      setPath(session, rec.k as unknown[], rec.v);
    }
  }
  return session;
}

const iso = (ms: unknown): string =>
  typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : '';

/**
 * Workspace folder from workspace.json (best effort). Walks up from the log
 * file because the depth differs: chatSessions/*.jsonl sits 2 levels below
 * the <hash> dir, debug-logs/<uuid>/*.jsonl sits 4 levels below.
 */
export function projectOf(logPath: string): string {
  let dir = dirname(logPath);
  for (let i = 0; i < 5; i++) {
    const ws = join(dir, 'workspace.json');
    if (existsSync(ws)) {
      try {
        const folder = (JSON.parse(readFileSync(ws, 'utf8')) as { folder?: string }).folder;
        if (folder) return decodeURIComponent(folder.replace(/^file:\/\//, ''));
      } catch {
        /* fall through */
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'unknown';
}

export const copilotParser: Parser = {
  tool: 'copilot',

  defaultDirs() {
    return [
      'Library/Application Support/Code/User/workspaceStorage', // macOS
      '.config/Code/User/workspaceStorage', // Linux
      'AppData/Roaming/Code/User/workspaceStorage', // Windows
    ];
  },

  isLogFile(path: string) {
    // Content is validated in parseFile (returns null unless the file
    // reduces to a session with requests), so the extension is enough here.
    return path.endsWith('.jsonl');
  },

  async parseFile(path: string): Promise<SessionMetrics | null> {
    const s = await reduceSession(path);
    const requests = (s.requests as Record<string, unknown>[]) ?? [];
    if (!Array.isArray(requests) || requests.length === 0) return null;

    const tokens: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    const timestamps: number[] = [];
    let model = '';
    let credits = 0;
    let activeMs = 0;

    for (const r of requests) {
      if (typeof r.timestamp === 'number') timestamps.push(r.timestamp);
      tokens.input += Number(r.promptTokens ?? 0);
      tokens.output += Number(r.completionTokens ?? 0);
      credits += Number(r.copilotCredits ?? 0);
      if (typeof r.elapsedMs === 'number') activeMs += r.elapsedMs;
      const md = ((r.result as Record<string, unknown>)?.metadata ?? {}) as Record<string, unknown>;
      if (typeof md.resolvedModel === 'string') model = md.resolvedModel;
      else if (typeof r.modelId === 'string' && !model) model = r.modelId;
      const done = (r.modelState as Record<string, number>)?.completedAt;
      if (typeof done === 'number') timestamps.push(done);
    }
    if (typeof s.creationDate === 'number') timestamps.unshift(s.creationDate);
    if (timestamps.length === 0) return null;
    timestamps.sort((a, b) => a - b);
    const first = timestamps[0];
    const last = timestamps[timestamps.length - 1];

    return {
      tool: 'copilot',
      sessionId: (s.sessionId as string) || basename(path, '.jsonl'),
      logPath: path,
      project: projectOf(path),
      model: model || 'unknown',
      startedAt: iso(first),
      endedAt: iso(last),
      durationSec: Math.round((last - first) / 1000),
      activeSec: Math.round(activeMs / 1000),
      tokens,
      // Actual spend when credits are recorded (1 credit = $0.01),
      // otherwise API-equivalent estimate by resolved model.
      costUsd: credits > 0 ? credits * 0.01 : costUsd(model, tokens),
      estimated: credits > 0 ? false : true,
      turns: requests.length,
      lastEventAt: iso(last),
    };
  },
};
