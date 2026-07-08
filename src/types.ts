/** Common metrics schema shared by all tool parsers. */

export type Tool = 'claude' | 'codex' | 'copilot' | 'copilot-cli';

/**
 * Token counts. `null` means "the tool's log does NOT record this value"
 * (rendered as `-`), as opposed to a measured 0.
 * Availability by tool:
 *   claude:           in/out/cacheR/cacheW measured, reasoning null
 *   codex:            in/out/cacheR/reasoning measured, cacheW null (no such billing)
 *   copilot (chat):   in/out measured, cacheR/cacheW/reasoning null
 *   copilot subagent: in/out/cacheR measured, cacheW/reasoning null
 *   copilot-cli:      out measured, everything else null
 */
export interface TokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** reasoning tokens (Codex); included in output */
  reasoning: number | null;
}

export interface SessionMetrics {
  tool: Tool;
  sessionId: string;
  /** absolute path of the source log file */
  logPath: string;
  /** working directory / project path (best effort) */
  project: string;
  /** primary model used in the session */
  model: string;
  startedAt: string; // ISO 8601
  endedAt: string;   // ISO 8601
  /** wall clock duration in seconds */
  durationSec: number;
  /** active time: sum of event gaps <= GAP_THRESHOLD, in seconds */
  activeSec: number;
  tokens: TokenUsage;
  /** API-equivalent cost in USD; null if model pricing unknown */
  costUsd: number | null;
  /** true when tokens are estimated rather than read from the log */
  estimated: boolean;
  /** number of assistant turns / tasks observed */
  turns: number;
  /** ISO timestamp of the last event ingested (for idempotent upsert) */
  lastEventAt: string;
  /** parent session id when this is a subagent (child) session; else null */
  parentSessionId?: string | null;
}

/** Gap threshold (ms) above which time is considered idle. */
export const GAP_THRESHOLD_MS = 5 * 60 * 1000;

export interface Parser {
  tool: Tool;
  /** default log locations to scan, relative to $HOME */
  defaultDirs(): string[];
  /** glob-ish predicate for candidate log files */
  isLogFile(path: string): boolean;
  /** parse a single session log file */
  parseFile(path: string): Promise<SessionMetrics | null>;
}
