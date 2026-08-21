import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import type { Parser, SessionMetrics, TokenUsage } from '../types.js';
import { costUsd } from '../pricing.js';
import { jsonlRecords } from './util.js';
import { copilotWorkspaceRoots } from '../paths.js';

/**
 * GitHub Copilot Chat (VS Code) session logs:
 *   <userData>/User/workspaceStorage/<hash>/chatSessions/<session-uuid>.jsonl
 *
 * Format: VS Code ObjectMutationLog records.
 *   kind:0 = initial snapshot, kind:1 = Set, kind:2 = Push, kind:3 = Delete.
 * The reduced object has requests[] with measured promptTokens /
 * completionTokens, resolvedModel, elapsedMs and copilotCredits.
 *
 * main.jsonl span traces, when available, deterministically supersede this
 * task-level snapshot because they contain every parent-side LLM request.
 */

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/** Reject keys that could pollute the prototype chain or aren't plain path segments. */
function isSafeKey(key: unknown): key is string | number {
  return (
    (typeof key === 'string' && key.length > 0 && !BLOCKED_KEYS.has(key)) ||
    (typeof key === 'number' && Number.isInteger(key) && key >= 0)
  );
}

function navigateToParent(
  obj: Record<string, unknown>,
  path: unknown[]
): { parent: Record<string, unknown>; key: string | number } | null {
  if (path.length === 0 || !path.every(isSafeKey)) return null;
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] as string | number;
    const next = cur[key as string];
    if (typeof next !== 'object' || next === null) {
      cur[key as string] = typeof path[i + 1] === 'number' ? [] : Object.create(null);
    }
    cur = cur[key as string] as Record<string, unknown>;
  }
  return { parent: cur, key: path[path.length - 1] as string | number };
}

function setPath(obj: Record<string, unknown>, path: unknown[], value: unknown): void {
  const loc = navigateToParent(obj, path);
  if (loc) loc.parent[loc.key as string] = value;
}

function deletePath(obj: Record<string, unknown>, path: unknown[]): void {
  const loc = navigateToParent(obj, path);
  if (!loc) return;
  // Match JavaScript's `delete` semantics: an array index becomes a hole.
  // Later mutations may still address the original indices; requests are
  // compacted only after the complete log has been replayed.
  delete loc.parent[loc.key as string];
}

function applyPush(obj: Record<string, unknown>, path: unknown[], values: unknown, index: unknown): void {
  const loc = navigateToParent(obj, path);
  if (!loc) return;
  const existing = loc.parent[loc.key as string];
  const array = Array.isArray(existing) ? existing : [];
  if (typeof index === 'number' && Number.isInteger(index) && index >= 0) array.length = index;
  if (Array.isArray(values)) array.push(...values);
  loc.parent[loc.key as string] = array;
}

/** Reduce the incremental records into the final session object. */
export async function reduceSession(path: string): Promise<Record<string, unknown>> {
  let session: Record<string, unknown> = {};
  for await (const rec of jsonlRecords(path)) {
    if (rec.kind === 0) {
      session = (rec.v as Record<string, unknown>) ?? {};
    } else if (rec.kind === 2 && Array.isArray(rec.k)) {
      // Current VS Code Push records target an array and carry an array value.
      // Older/synthetic logs used kind:2 as an indexed Set; retain compatibility.
      if (Array.isArray(rec.v)) applyPush(session, rec.k as unknown[], rec.v, rec.i);
      else setPath(session, rec.k as unknown[], rec.v);
    } else if (rec.kind === 3 && Array.isArray(rec.k)) {
      deletePath(session, rec.k as unknown[]);
    } else if (rec.kind === 1 && Array.isArray(rec.k)) {
      setPath(session, rec.k as unknown[], rec.v);
    }
  }
  if (Array.isArray(session.requests)) {
    session.requests = session.requests.filter(
      (r): r is Record<string, unknown> => r !== null && r !== undefined && typeof r === 'object'
    );
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
        if (folder) {
          if (folder.startsWith('file://')) {
            const decoded = fileURLToPath(folder);
            return decoded.replace(/^\/([A-Za-z]:[\\/])/, '$1');
          }
          return decodeURIComponent(folder);
        }
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

function finite(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function cacheRatio(details: unknown): number {
  if (!Array.isArray(details)) return 0;
  let pct = 0;
  for (const item of details) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (/cache/i.test(`${rec.category ?? ''} ${rec.label ?? ''}`)) {
      pct += finite(rec.percentageOfPrompt) ?? 0;
    }
  }
  return Math.max(0, Math.min(100, pct)) / 100;
}

export const copilotParser: Parser = {
  tool: 'copilot',

  defaultDirs() {
    return copilotWorkspaceRoots();
  },

  isLogFile(path: string) {
    const normalized = path.replace(/\\/g, '/');
    return normalized.includes('/chatSessions/') && normalized.toLowerCase().endsWith('.jsonl');
  },

  async parseFile(path: string): Promise<SessionMetrics | null> {
    const s = await reduceSession(path);
    const requests = (s.requests as Record<string, unknown>[]) ?? [];
    if (!Array.isArray(requests) || requests.length === 0) return null;

    const tokens: TokenUsage = { input: 0, output: 0, cacheRead: null, cacheWrite: null, reasoning: null };
    const timestamps: number[] = [];
    let model = '';
    let actualCost = 0;
    let estimatedCost = 0;
    let actualRequests = 0;
    let estimatedRequests = 0;
    let unknownCost = false;
    let activeMs = 0;
    let promptTotal = 0;
    let cacheTotal = 0;
    let allCacheDetailsKnown = true;

    let turns = 0;
    for (const r of requests) {
      // The incremental log addresses requests by index; a removed/edited
      // request can leave a hole (undefined) in the reconstructed array.
      if (!r || typeof r !== 'object') continue;
      turns++;
      if (typeof r.timestamp === 'number') timestamps.push(r.timestamp);
      const prompt = finite(r.promptTokens) ?? 0;
      const hasCacheDetails = Array.isArray(r.promptTokenDetails);
      const cached = Math.round(prompt * cacheRatio(r.promptTokenDetails));
      promptTotal += prompt;
      cacheTotal += cached;
      allCacheDetailsKnown &&= hasCacheDetails;
      tokens.output = (tokens.output ?? 0) + (finite(r.completionTokens) ?? 0);
      if (typeof r.elapsedMs === 'number') activeMs += r.elapsedMs;
      const md = ((r.result as Record<string, unknown>)?.metadata ?? {}) as Record<string, unknown>;
      if (typeof md.resolvedModel === 'string') model = md.resolvedModel;
      else if (typeof r.modelId === 'string' && !model) model = r.modelId;
      const requestModel = typeof md.resolvedModel === 'string'
        ? md.resolvedModel
        : typeof r.modelId === 'string' ? r.modelId : model;
      const requestCredits = finite(r.copilotCredits);
      if (requestCredits !== null) {
        actualCost += requestCredits * 0.01;
        actualRequests++;
      } else {
        const estimated = requestModel
          ? costUsd(requestModel, { input: Math.max(0, prompt - cached), output: finite(r.completionTokens) ?? 0, cacheRead: cached, cacheWrite: 0, reasoning: 0 })
          : null;
        if (estimated === null) unknownCost = true;
        else estimatedCost += estimated;
        estimatedRequests++;
      }
      const done = (r.modelState as Record<string, number>)?.completedAt;
      if (typeof done === 'number') timestamps.push(done);
    }
    if (turns === 0) return null; // every request slot was a hole
    tokens.input = allCacheDetailsKnown ? Math.max(0, promptTotal - cacheTotal) : promptTotal;
    tokens.cacheRead = allCacheDetailsKnown ? cacheTotal : null;
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
      costUsd: unknownCost ? null : actualCost + estimatedCost,
      estimated: estimatedRequests > 0,
      costSource: actualRequests > 0 && estimatedRequests > 0
        ? 'mixed'
        : actualRequests > 0 ? 'actual' : 'estimated',
      metricScope: 'own',
      turns,
      lastEventAt: iso(last),
    };
  },
};
