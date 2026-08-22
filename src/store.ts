import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { ProjectSource, SessionMetrics } from './types.js';

export function defaultDbPath(): string {
  return process.env.AIMET_DB ?? join(homedir(), '.aimet', 'metrics.db');
}

/** Prefer richer Copilot span traces over task-level chat snapshots. */
function sourceRank(tool: string, logPath: string): number {
  if (tool !== 'copilot') return 1;
  const normalized = logPath.replace(/\\/g, '/');
  if (/\/GitHub\.copilot-chat\/debug-logs\/[^/]+\/main\.jsonl$/i.test(normalized)) return 3;
  if (/\/GitHub\.copilot-chat\/debug-logs\/[^/]+\/[^/]+\.jsonl$/i.test(normalized)) return 3;
  if (normalized.includes('/chatSessions/')) return 2;
  return 1;
}

function knownProject(project: string | undefined | null): project is string {
  return Boolean(project && project.trim() && project !== 'unknown');
}

function normalizedProjectSource(m: SessionMetrics): ProjectSource {
  if (!knownProject(m.project)) return 'unknown';
  // Rows produced before provenance was introduced are deliberately low trust,
  // so exact evidence discovered during a later collection can replace them.
  return m.projectSource ?? (m.tool === 'copilot' ? 'legacy' : 'log');
}

function projectSourceRank(source: string | undefined | null): number {
  switch (source) {
    case 'session-store': return 5;
    case 'workspace-json':
    case 'log': return 4;
    case 'structured-reference':
    case 'legacy': return 2;
    case 'parent': return 1;
    default: return 0;
  }
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string = defaultDbPath()) {
    // The DB records project paths, timestamps, models and token counts.
    // Keep it private to the current user (dir 0700, file 0600).
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best effort (e.g. non-POSIX filesystems) */
    }
    const existedBefore = existsSync(path);
    this.db = new DatabaseSync(path);
    if (!existedBefore) {
      try {
        chmodSync(path, 0o600);
      } catch {
        /* best effort */
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        tool TEXT NOT NULL,
        session_id TEXT NOT NULL,
        log_path TEXT NOT NULL,
        project TEXT NOT NULL,
        project_source TEXT NOT NULL DEFAULT 'unknown',
        model TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT NOT NULL,
        duration_sec INTEGER NOT NULL,
        active_sec INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        cost_usd REAL,
        estimated INTEGER NOT NULL DEFAULT 0,
        metric_scope TEXT NOT NULL DEFAULT 'own',
        cost_source TEXT NOT NULL DEFAULT 'estimated',
        turns INTEGER NOT NULL,
        last_event_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tool, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    `);
    // Migration: parent_session_id links subagent (child) sessions to their
    // parent (Copilot multi-agent). NULL for top-level sessions.
    const cols = this.db.prepare('PRAGMA table_info(sessions)').all() as {
      name: string;
      notnull: number;
    }[];
    if (!cols.some((c) => c.name === 'parent_session_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT');
    }
    // Migration: token columns become NULLABLE. NULL = "the tool's log does
    // not record this value" (rendered as -), distinct from a measured 0.
    const inputCol = cols.find((c) => c.name === 'input_tokens');
    if (inputCol && inputCol.notnull === 1) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE sessions_new (
          tool TEXT NOT NULL,
          session_id TEXT NOT NULL,
          log_path TEXT NOT NULL,
          project TEXT NOT NULL,
          project_source TEXT NOT NULL DEFAULT 'unknown',
          model TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT NOT NULL,
          duration_sec INTEGER NOT NULL,
          active_sec INTEGER NOT NULL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER,
          cache_write_tokens INTEGER,
          reasoning_tokens INTEGER,
          cost_usd REAL,
          estimated INTEGER NOT NULL DEFAULT 0,
          metric_scope TEXT NOT NULL DEFAULT 'own',
          cost_source TEXT NOT NULL DEFAULT 'estimated',
          turns INTEGER NOT NULL,
          last_event_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          parent_session_id TEXT,
          PRIMARY KEY (tool, session_id)
        );
        INSERT INTO sessions_new SELECT tool, session_id, log_path, project,
          CASE WHEN project = 'unknown' THEN 'unknown' ELSE 'legacy' END, model,
          started_at, ended_at, duration_sec, active_sec,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
          cost_usd, estimated,
          CASE WHEN tool = 'copilot-cli' THEN 'tree' ELSE 'own' END,
          CASE WHEN tool = 'copilot' AND estimated = 0 THEN 'actual' ELSE 'estimated' END,
          turns, last_event_at, updated_at, parent_session_id
          FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
        -- One-time backfill: NULL out fields that the source logs never record
        -- (previously stored as 0).
        UPDATE sessions SET reasoning_tokens = NULL WHERE tool = 'claude';
        UPDATE sessions SET cache_write_tokens = NULL WHERE tool = 'codex';
        UPDATE sessions SET cache_write_tokens = NULL, reasoning_tokens = NULL WHERE tool = 'copilot';
        UPDATE sessions SET cache_read_tokens = NULL WHERE tool = 'copilot' AND parent_session_id IS NULL;
        UPDATE sessions SET input_tokens = NULL, cache_read_tokens = NULL,
          cache_write_tokens = NULL, reasoning_tokens = NULL WHERE tool = 'copilot-cli';
        COMMIT;
      `);
    }
    const currentCols = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    if (!currentCols.some((c) => c.name === 'metric_scope')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN metric_scope TEXT NOT NULL DEFAULT 'own'`);
      this.db.exec(`UPDATE sessions SET metric_scope = 'tree' WHERE tool = 'copilot-cli'`);
    }
    if (!currentCols.some((c) => c.name === 'cost_source')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'estimated'`);
      this.db.exec(`UPDATE sessions SET cost_source = 'actual' WHERE tool = 'copilot' AND estimated = 0`);
    }
    if (!currentCols.some((c) => c.name === 'project_source')) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN project_source TEXT NOT NULL DEFAULT 'unknown'`);
      this.db.exec(`UPDATE sessions SET project_source = 'legacy' WHERE project <> 'unknown'`);
    }
  }

  /** Idempotent upsert keyed by (tool, session_id); skips stale data. */
  upsert(m: SessionMetrics): 'inserted' | 'updated' | 'skipped' {
    const existing = this.db
      .prepare('SELECT last_event_at, log_path, project, project_source FROM sessions WHERE tool = ? AND session_id = ?')
      .get(m.tool, m.sessionId) as {
        last_event_at: string;
        log_path: string;
        project: string;
        project_source: string;
      } | undefined;

    // A child debug span has its own call id, while Copilot's session index is
    // keyed by the top-level parent id. Inherit only a known parent project.
    let project = m.project;
    let projectSource = normalizedProjectSource(m);
    if (!knownProject(project) && m.parentSessionId) {
      const parent = this.db
        .prepare('SELECT project FROM sessions WHERE tool = ? AND session_id = ?')
        .get(m.tool, m.parentSessionId) as { project: string } | undefined;
      if (knownProject(parent?.project)) {
        project = parent.project;
        projectSource = 'parent';
      }
    }

    if (existing) {
      const oldRank = sourceRank(m.tool, existing.log_path);
      const newRank = sourceRank(m.tool, m.logPath);
      const improvesProject = knownProject(project) && (
        !knownProject(existing.project) ||
        projectSourceRank(projectSource) > projectSourceRank(existing.project_source)
      );

      // A lower-ranked chat snapshot must never replace exact span metrics,
      // but it may contribute the workspace.json-derived project for the same
      // session id.
      if (newRank < oldRank) {
        if (improvesProject) {
          this.db.prepare(
            `UPDATE sessions SET project = ?, project_source = ?, updated_at = ?
             WHERE tool = ? AND session_id = ?`
          ).run(project, projectSource, new Date().toISOString(), m.tool, m.sessionId);
          this.backfillChildProjects(m.tool, m.sessionId, project);
          return 'updated';
        }
        return 'skipped';
      }

      // Preserve a known project when a richer main.jsonl supersedes a chat
      // snapshot that carried the workspace association.
      if (knownProject(existing.project) && (
        !knownProject(project) ||
        projectSourceRank(projectSource) < projectSourceRank(existing.project_source)
      )) {
        project = existing.project;
        projectSource = existing.project_source as ProjectSource;
      }

      if (newRank === oldRank && existing.last_event_at >= m.lastEventAt) {
        if (improvesProject) {
          this.db.prepare(
            `UPDATE sessions SET project = ?, project_source = ?, updated_at = ?
             WHERE tool = ? AND session_id = ?`
          ).run(project, projectSource, new Date().toISOString(), m.tool, m.sessionId);
          this.backfillChildProjects(m.tool, m.sessionId, project);
          return 'updated';
        }
        return 'skipped';
      }
    }
    this.db
      .prepare(
        `INSERT INTO sessions (tool, session_id, log_path, project, project_source, model,
           started_at, ended_at, duration_sec, active_sec,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
           cost_usd, estimated, metric_scope, cost_source,
           turns, last_event_at, updated_at, parent_session_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tool, session_id) DO UPDATE SET
           log_path=excluded.log_path, project=excluded.project,
           project_source=excluded.project_source, model=excluded.model,
           started_at=excluded.started_at, ended_at=excluded.ended_at,
           duration_sec=excluded.duration_sec, active_sec=excluded.active_sec,
           input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
           cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
           reasoning_tokens=excluded.reasoning_tokens, cost_usd=excluded.cost_usd,
           estimated=excluded.estimated, metric_scope=excluded.metric_scope,
           cost_source=excluded.cost_source, turns=excluded.turns,
           last_event_at=excluded.last_event_at, updated_at=excluded.updated_at,
           parent_session_id=excluded.parent_session_id`
      )
      .run(
        m.tool, m.sessionId, m.logPath, project, projectSource, m.model,
        m.startedAt, m.endedAt, m.durationSec, m.activeSec,
        m.tokens.input, m.tokens.output, m.tokens.cacheRead, m.tokens.cacheWrite,
        m.tokens.reasoning, m.costUsd, m.estimated ? 1 : 0,
        m.metricScope ?? (m.tool === 'copilot-cli' ? 'tree' : 'own'),
        m.costSource ?? (m.tool === 'copilot' && !m.estimated ? 'actual' : 'estimated'),
        m.turns,
        m.lastEventAt, new Date().toISOString(), m.parentSessionId ?? null
      );
    if (knownProject(project)) this.backfillChildProjects(m.tool, m.sessionId, project);
    return existing ? 'updated' : 'inserted';
  }

  /** Fill children that were scanned before their parent without touching metrics. */
  private backfillChildProjects(tool: string, parentSessionId: string, project: string): void {
    this.db.prepare(
      `UPDATE sessions SET project = ?, project_source = 'parent', updated_at = ?
       WHERE tool = ? AND parent_session_id = ?
         AND (project = 'unknown' OR project_source = 'parent')`
    ).run(project, new Date().toISOString(), tool, parentSessionId);
  }

  query(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  }

  close(): void {
    this.db.close();
  }
}
