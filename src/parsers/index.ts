import type { Parser, Tool } from '../types.js';
import { claudeParser } from './claude.js';
import { codexParser } from './codex.js';
import { copilotParser } from './copilot.js';
import { copilotSubagentParser } from './copilotsubagent.js';
import { copilotCliParser } from './copilotcli.js';
import { copilotOtelParser, copilotCliOtelParser } from './copilototel.js';

/**
 * Parser registry.
 *   copilot     = GitHub Copilot Chat in VS Code (workspaceStorage/<hash>/chatSessions)
 *                 + exact parent/child spans from workspaceStorage (legacy)
 *                   or globalStorage/github.copilot-chat/debug-logs/<uuid>/ (current)
 *                   main.jsonl and runSubagent-*.jsonl. Store prefers main over
 *                   the same-id chat snapshot and links children by parent_session_id.
 *   copilot-cli = GitHub Copilot CLI agent (~/.copilot/session-state/<uuid>/events.jsonl)
 *
 * Note: copilotParser and copilotSubagentParser share the tool label
 * 'copilot' so `collect --tool copilot` sweeps both; parserFor() returns
 * the chat parser (first match) for backwards compatibility. Hook and detail
 * paths use parserForFile(), because a supplied path may be a parent or child
 * debug span rather than a chat snapshot.
 */
export const parsers: Parser[] = [
  claudeParser,
  codexParser,
  copilotParser,
  copilotOtelParser,
  copilotSubagentParser,
  copilotCliParser,
  copilotCliOtelParser,
];

export function parserFor(tool: string): Parser | undefined {
  return parsers.find((p) => p.tool === (tool as Tool));
}

/** Select the parser that owns an exact log path when a tool has multiple formats. */
export function parserForFile(tool: string, path: string): Parser | undefined {
  return parsers.find((p) => p.tool === (tool as Tool) && p.isLogFile(path));
}
