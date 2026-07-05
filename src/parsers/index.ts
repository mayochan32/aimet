import type { Parser, Tool } from '../types.js';
import { claudeParser } from './claude.js';
import { codexParser } from './codex.js';

/**
 * Parser registry. Copilot CLI (~/.copilot/session-state/) is planned:
 * add its parser here once the log schema is confirmed.
 */
export const parsers: Parser[] = [claudeParser, codexParser];

export function parserFor(tool: string): Parser | undefined {
  return parsers.find((p) => p.tool === (tool as Tool));
}
