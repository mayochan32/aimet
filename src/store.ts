import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { SessionMetrics } from './types.js';

export function defaultDbPath(): string {
  return process.env.AIMET_DB ?? join(homedir(), '.aimet', 'metrics.db');
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string = defaultDbPath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        tool TEXT NOT NULL,
        session_id TEXT NOT NULL,
        log_path TEXT NOT NULL,
        project TEXT NOT NULL,
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
        turns INTEGER NOT NULL,
        last_event_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tool, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    `);
  }

  /** Idempotent upsert keyed by (tool, session_id); skips stale data. */
  upsert(m: SessionMetrics): 'inserted' | 'updated' | 'skipped' {
    const existing = this.db
      .prepare('SELECT last_event_at FROM sessions WHERE tool = ? AND session_id = ?')
      .get(m.tool, m.sessionId) as { last_event_at: string } | undefined;
    if (existing && existing.last_event_at >= m.lastEventAt) return 'skipped';
    this.db
      .prepare(
        `INSERT INTO sessions (tool, session_id, log_path, project, model,
           started_at, ended_at, duration_sec, active_sec,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
           cost_usd, estimated, turns, last_event_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(tool, session_id) DO UPDATE SET
           log_path=excluded.log_path, project=excluded.project, model=excluded.model,
           started_at=excluded.started_at, ended_at=excluded.ended_at,
           duration_sec=excluded.duration_sec, active_sec=excluded.active_sec,
           input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
           cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens,
           reasoning_tokens=excluded.reasoning_tokens, cost_usd=excluded.cost_usd,
           estimated=excluded.estimated, turns=excluded.turns,
           last_event_at=excluded.last_event_at, updated_at=excluded.updated_at`
      )
      .run(
        m.tool, m.sessionId, m.logPath, m.project, m.model,
        m.startedAt, m.endedAt, m.durationSec, m.activeSec,
        m.tokens.input, m.tokens.output, m.tokens.cacheRead, m.tokens.cacheWrite,
        m.tokens.reasoning, m.costUsd, m.estimated ? 1 : 0, m.turns,
        m.lastEventAt, new Date().toISOString()
      );
    return existing ? 'updated' : 'inserted';
  }

  query(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  }

  close(): void {
    this.db.close();
  }
}
