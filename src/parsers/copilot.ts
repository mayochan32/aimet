import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { Parser, ProjectSource, SessionMetrics, TokenUsage } from '../types.js';
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

type SessionProjectCache = {
  signature: string;
  projects: Map<string, string>;
};

const sessionProjectCaches = new Map<string, SessionProjectCache>();
const workspaceProjectCaches = new Map<string, string[]>();

export type ProjectInfo = { project: string; source: ProjectSource };

function fileSignature(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return '-';
  }
}

/**
 * Current Copilot builds keep a read-only session index next to debug-logs.
 * Query only sessions(id, cwd); turns and other conversation content are not
 * needed for project attribution. Include the WAL in the cache signature so a
 * long-running collector notices newly persisted session metadata.
 */
function sessionStoreProject(dbPath: string, sessionId: string): string {
  if (!sessionId || !existsSync(dbPath)) return 'unknown';
  const signature = `${fileSignature(dbPath)}:${fileSignature(`${dbPath}-wal`)}`;
  let cached = sessionProjectCaches.get(dbPath);
  if (!cached || cached.signature !== signature) {
    const projects = new Map<string, string>();
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare(
        `SELECT id, cwd FROM sessions
         WHERE cwd IS NOT NULL AND TRIM(cwd) <> ''`
      ).all() as { id: string; cwd: string }[];
      for (const row of rows) {
        if (typeof row.id === 'string' && typeof row.cwd === 'string' && row.cwd.trim()) {
          projects.set(row.id, row.cwd.trim());
        }
      }
    } catch {
      // Older builds may not have this database/schema, or VS Code may be in
      // the middle of replacing it. Project attribution remains best effort.
    } finally {
      db?.close();
    }
    cached = { signature, projects };
    sessionProjectCaches.set(dbPath, cached);
  }
  return cached.projects.get(sessionId) ?? 'unknown';
}

function workspaceProjectFile(path: string): string {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { folder?: string; workspace?: string };
    const value = data.folder ?? data.workspace;
    if (!value) return 'unknown';
    if (value.startsWith('file://')) {
      const decoded = fileURLToPath(value);
      return decoded.replace(/^\/([A-Za-z]:[\\/])/, '$1');
    }
    return decodeURIComponent(value);
  } catch {
    return 'unknown';
  }
}

/** Workspace folders registered for the same VS Code User data directory. */
export function knownWorkspaceProjects(logPath: string): string[] {
  let dir = dirname(logPath);
  let workspaceStorage = '';
  for (let i = 0; i < 7; i++) {
    if (basename(dir).toLowerCase() === 'globalstorage') {
      workspaceStorage = join(dirname(dir), 'workspaceStorage');
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!workspaceStorage || !existsSync(workspaceStorage)) return [];
  const cached = workspaceProjectCaches.get(workspaceStorage);
  if (cached) return cached;

  const projects: string[] = [];
  try {
    for (const entry of readdirSync(workspaceStorage, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const project = workspaceProjectFile(join(workspaceStorage, entry.name, 'workspace.json'));
      if (project !== 'unknown') projects.push(project);
    }
  } catch {
    /* best effort */
  }
  const unique = [...new Set(projects)];
  workspaceProjectCaches.set(workspaceStorage, unique);
  return unique;
}

function comparablePath(value: string): string {
  // Nested JSON strings may contain doubled backslashes. Collapse them before
  // comparing. Windows case folding is applied from the candidate workspace.
  let normalized = value;
  while (normalized.includes('\\\\')) normalized = normalized.replace(/\\\\/g, '\\');
  return normalized.replace(/\\/g, '/');
}

const DIRECT_REFERENCE_KEYS = new Set([
  'cwd', 'path', 'filepath', 'fileuri', 'fspath', 'resourcepath', 'resourceuri',
  'workspacefolder', 'workspacepath', 'workspaceuri',
]);
const REFERENCE_CONTAINER_KEYS = new Set(['attachment', 'attachments', 'file', 'files', 'reference', 'references', 'resource', 'resources']);
const ARGUMENT_CONTAINER_KEYS = new Set(['argument', 'arguments', 'args', 'toolargs', 'toolarguments', 'toolinput']);
const FREE_TEXT_KEYS = new Set(['content', 'instruction', 'instructions', 'message', 'prompt', 'query', 'text', 'userrequest']);

const normalizedKey = (key: string): string => key.replace(/[^a-z0-9]/gi, '').toLowerCase();

function addKnownWorkspaceMatches(value: string, projects: string[], matches: Set<string>): void {
  const normalized = comparablePath(value);
  for (const project of projects) {
    const candidate = comparablePath(project).replace(/\/$/, '');
    const windowsPath = /^[A-Za-z]:\//.test(candidate);
    const haystack = windowsPath ? normalized.toLowerCase() : normalized;
    const needle = windowsPath ? candidate.toLowerCase() : candidate;
    if (haystack.includes(`${needle}/`) || haystack === needle) matches.add(project);
  }
}

/**
 * Add registered VS Code workspaces referenced by structured file/resource data.
 * Free-form strings such as userRequest are deliberately ignored: mentioning a
 * path in a prompt is not evidence that the session belongs to that project.
 */
export function collectKnownWorkspaceReferences(
  value: unknown,
  projects: string[],
  matches: Set<string>,
  depth = 0,
  acceptString = false,
  parseJson = false
): void {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (acceptString) addKnownWorkspaceMatches(value, projects, matches);
    if (parseJson && (value.startsWith('{') || value.startsWith('['))) {
      try {
        collectKnownWorkspaceReferences(JSON.parse(value), projects, matches, depth + 1);
      } catch {
        /* not structured JSON arguments */
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKnownWorkspaceReferences(item, projects, matches, depth + 1, acceptString, parseJson);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalized = normalizedKey(key);
      if (FREE_TEXT_KEYS.has(normalized)) continue;
      const direct = DIRECT_REFERENCE_KEYS.has(normalized);
      const references = REFERENCE_CONTAINER_KEYS.has(normalized);
      const argumentsContainer = ARGUMENT_CONTAINER_KEYS.has(normalized);
      collectKnownWorkspaceReferences(
        item,
        projects,
        matches,
        depth + 1,
        direct || references,
        direct || references || argumentsContainer
      );
    }
  }
}

/**
 * Resolve a Copilot session's project without guessing from the collector's
 * current working directory.
 *
 * 1. Legacy workspaceStorage logs use the nearest workspace.json.
 * 2. Current globalStorage logs use the exact session id in session-store.db.
 *
 * Walk upward because chatSessions and debug-logs have different depths.
 */
export function projectInfoOf(logPath: string, sessionId = ''): ProjectInfo {
  let dir = dirname(logPath);
  for (let i = 0; i < 6; i++) {
    const ws = join(dir, 'workspace.json');
    if (existsSync(ws)) {
      const workspace = workspaceProjectFile(ws);
      if (workspace !== 'unknown') return { project: workspace, source: 'workspace-json' };
      break;
    }
    const sessionDb = join(dir, 'session-store.db');
    const indexed = sessionStoreProject(sessionDb, sessionId);
    if (indexed !== 'unknown') return { project: indexed, source: 'session-store' };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { project: 'unknown', source: 'unknown' };
}

/** Backwards-compatible value-only project lookup. */
export function projectOf(logPath: string, sessionId = ''): string {
  return projectInfoOf(logPath, sessionId).project;
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

    const projectInfo = projectInfoOf(path, (s.sessionId as string) || basename(path, '.jsonl'));
    return {
      tool: 'copilot',
      sessionId: (s.sessionId as string) || basename(path, '.jsonl'),
      logPath: path,
      project: projectInfo.project,
      projectSource: projectInfo.source,
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
