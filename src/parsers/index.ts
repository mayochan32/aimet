import type { Parser, Tool } from '../types.js';
import { claudeParser } from './claude.js';
import { codexParser } from './codex.js';
import { copilotParser } from './copilot.js';
import { copilotSubagentParser } from './copilotsubagent.js';
import { copilotCliParser } from './copilotcli.js';

/**
 * Parser registry.
 *   copilot     = GitHub Copilot Chat in VS Code (workspaceStorage/<hash>/chatSessions)
 *                 + subagent sessions from GitHub.copilot-chat/debug-logs/<uuid>/
 *                   runSubagent-*.jsonl (same tool label, linked by parent_session_id)
 *   copilot-cli = GitHub Copilot CLI agent (~/.copilot/session-state/<uuid>/events.jsonl)
 *
 * Note: copilotParser and copilotSubagentParser share the tool label
 * 'copilot' so `collect --tool copilot` sweeps both; parserFor() returns
 * the chat parser (first match), which is the right target for hook
 * transcript ingestion.
 */
export const parsers: Parser[] = [
  claudeParser,
  codexParser,
  copilotParser,
  copilotSubagentParser,
  copilotCliParser,
];

export function parserFor(tool: string): Parser | undefined {
  return parsers.find((p) => p.tool === (tool as Tool));
}
