import type { Parser, Tool } from '../types.js';
import { claudeParser } from './claude.js';
import { codexParser } from './codex.js';
import { copilotParser } from './copilot.js';
import { copilotCliParser } from './copilotcli.js';

/**
 * Parser registry.
 *   copilot     = GitHub Copilot Chat in VS Code (workspaceStorage/<hash>/chatSessions)
 *   copilot-cli = GitHub Copilot CLI agent (~/.copilot/session-state/<uuid>/events.jsonl)
 */
export const parsers: Parser[] = [claudeParser, codexParser, copilotParser, copilotCliParser];

export function parserFor(tool: string): Parser | undefined {
  return parsers.find((p) => p.tool === (tool as Tool));
}
