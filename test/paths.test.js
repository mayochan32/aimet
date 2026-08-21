import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';

import { copilotWorkspaceRoots, vscodeUserDirs } from '../dist/paths.js';
import { copilotParser, projectOf } from '../dist/parsers/copilot.js';
import { copilotSubagentParser } from '../dist/parsers/copilotsubagent.js';
import { Store } from '../dist/store.js';
import { collect } from '../dist/collect.js';

test('Windows paths prefer APPDATA and include Stable, Insiders and VSCodium', () => {
  const dirs = vscodeUserDirs({ APPDATA: 'D:\\Roaming' }, 'win32', 'C:\\Users\\tester');
  assert.deepEqual(dirs, [
    'D:\\Roaming\\Code\\User',
    'D:\\Roaming\\Code - Insiders\\User',
    'D:\\Roaming\\VSCodium\\User',
  ]);
});

test('Windows paths fall back to USERPROFILE-style home and accept explicit roots', () => {
  const roots = copilotWorkspaceRoots(
    { AIMET_COPILOT_DIR: 'D:\\Custom One;E:\\Custom Two' },
    'win32',
    'C:\\Users\\tester'
  );
  assert.deepEqual(roots.slice(0, 2), ['D:\\Custom One', 'E:\\Custom Two']);
  assert.ok(roots.includes('C:\\Users\\tester\\AppData\\Roaming\\Code\\User\\workspaceStorage'));
});

test('Copilot predicates recognize Windows separators without accepting unrelated JSONL', () => {
  assert.equal(copilotParser.isLogFile('C:\\x\\workspaceStorage\\h\\chatSessions\\a.jsonl'), true);
  assert.equal(copilotParser.isLogFile('C:\\x\\workspaceStorage\\h\\state.vscdb.jsonl'), false);
  assert.equal(copilotSubagentParser.isLogFile('C:\\x\\GitHub.copilot-chat\\debug-logs\\s\\runSubagent-A-call.jsonl'), true);
});

test('workspace file URI loses the spurious slash before a Windows drive', () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-project-uri-'));
  const chat = join(root, 'chatSessions');
  mkdirSync(chat);
  writeFileSync(join(root, 'workspace.json'), JSON.stringify({ folder: 'file:///C:/Work/My%20Project' }));
  const project = projectOf(join(chat, 'session.jsonl'));
  assert.equal(project.replace(/\\/g, '/'), 'C:/Work/My Project');
});

test('Windows collect discovers Copilot logs from APPDATA without --dir', { skip: platform() !== 'win32' }, async () => {
  const base = mkdtempSync(join(tmpdir(), 'aimet appdata 日本語-'));
  const logDir = join(base, 'Code', 'User', 'workspaceStorage', 'hash', 'chatSessions');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'session.jsonl'),
    '{"kind":0,"v":{"sessionId":"win-live-fixture","creationDate":1783000000000,"requests":[{"timestamp":1783000001000,"promptTokens":10,"completionTokens":2,"copilotCredits":0.1}]}}\r\n');
  const oldAppData = process.env.APPDATA;
  process.env.APPDATA = base;
  const store = new Store(join(base, 'aimet db', 'metrics.db'));
  try {
    const result = await collect({ store, tools: ['copilot'], quiet: true });
    assert.equal(result.inserted, 1);
    assert.equal(store.query('SELECT COUNT(*) AS n FROM sessions')[0].n, 1);
  } finally {
    store.close();
    if (oldAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = oldAppData;
  }
});
