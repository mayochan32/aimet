/** Common metrics schema shared by all tool parsers. */

export type Tool = 'claude' | 'codex' | 'copilot' | 'copilot-cli';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** reasoning tokens (Codex); included in output */
  reasoning: number;
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
