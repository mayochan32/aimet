/** Common metrics schema shared by all tool parsers. */

export type Tool = 'claude' | 'codex' | 'copilot' | 'copilot-cli';

/** How a model request was routed. Kept separate from provider and model id. */
export type AccessMode = 'byok' | 'copilot' | 'mixed' | 'unknown';

/** Evidence used to associate a session with a project. */
export type ProjectSource =
  | 'unknown'
  | 'legacy'
  | 'parent'
  | 'structured-reference'
  | 'workspace-json'
  | 'session-store'
  | 'log';

/**
 * Token counts. `null` means "the tool's log does NOT record this value"
 * (rendered as `-`), as opposed to a measured 0.
 * Availability by tool:
 *   claude:           in/out/cacheR/cacheW measured, reasoning null
 *   codex:            in/out/cacheR/reasoning measured; GPT-5.6/6 cacheW measured
 *                     when present (older rollouts/models use null)
 *   copilot (chat):   in/out measured, cacheR/cacheW/reasoning null
 *   copilot subagent: in/out/cacheR measured, cacheW/reasoning null
 *   copilot-cli:      events.jsonl has output only; OTel can also provide input,
 *                     cacheR/cacheW and exact root AI Credits
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
  /** evidence supporting project; higher-confidence evidence may replace lower */
  projectSource?: ProjectSource;
  /** primary model used in the session */
  model: string;
  /** direct provider key (BYOK), Copilot entitlement, mixed, or not observable */
  accessMode?: AccessMode;
  /** LLM provider reported by the source telemetry (for example github/openai/anthropic) */
  provider?: string;
  /** API hostname reported by the source telemetry, when available */
  serverAddress?: string | null;
  startedAt: string; // ISO 8601
  /** wall clock duration in seconds */
  durationSec: number;
  /** active time: sum of event gaps <= GAP_THRESHOLD, in seconds */
  activeSec: number;
  tokens: TokenUsage;
  /** API-equivalent cost in USD; null if model pricing unknown */
  costUsd: number | null;
  /** true when tokens are estimated rather than read from the log */
  estimated: boolean;
  /** whether this row measures only itself or already includes descendants */
  metricScope?: 'own' | 'tree';
  /** origin of the monetary value, independent of token measurement */
  costSource?: 'actual' | 'estimated' | 'mixed';
  /** number of assistant turns / tasks observed */
  turns: number;
  /** Last observed event in ISO 8601; not proof that the session completed. */
  lastEventAt: string;
  /** parent session id when this is a subagent (child) session; else null */
  parentSessionId?: string | null;
}

/** Gap threshold (ms) above which time is considered idle. */
export const GAP_THRESHOLD_MS = 5 * 60 * 1000;

export interface Parser {
  tool: Tool;
  /** environment-aware default log locations, absolute or relative to $HOME */
  defaultDirs(): string[];
  /** glob-ish predicate for candidate log files */
  isLogFile(path: string): boolean;
  /** Parse one source file. Container formats such as OTel SQLite may yield many sessions. */
  parseFile(path: string): Promise<SessionMetrics | SessionMetrics[] | null>;
}
