import type { Parser, Tool } from '../types.js';
import { claudeParser } from './claude.js';
import { codexParser } from './codex.js';
import { copilotParser } from './copilot.js';

/**
 * Parser registry. copilot = GitHub Copilot Chat in VS Code
 * (workspaceStorage/<hash>/chatSessions). Copilot CLI
 * (~/.copilot/session-state/) is a possible future addition.
 */
export const parsers: Parser[] = [claudeParser, codexParser, copilotParser];

export function parserFor(tool: string): Parser | undefined {
  return parsers.find((p) => p.tool === (tool as Tool));
}
