import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { platform, tmpdir } from 'node:os';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { copilotWorkspaceRoots, vscodeUserDirs } from '../dist/paths.js';
import {
  collectKnownWorkspaceReferences,
  copilotParser,
  knownWorkspaceProjects,
  projectInfoOf,
  projectOf,
} from '../dist/parsers/copilot.js';
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

test('Copilot roots include legacy workspaceStorage and current globalStorage', () => {
  const roots = copilotWorkspaceRoots({ APPDATA: 'D:\\Roaming' }, 'win32', 'C:\\Users\\tester');
  assert.deepEqual(roots, [
    'D:\\Roaming\\Code\\User\\workspaceStorage',
    'D:\\Roaming\\Code\\User\\globalStorage\\github.copilot-chat',
    'D:\\Roaming\\Code - Insiders\\User\\workspaceStorage',
    'D:\\Roaming\\Code - Insiders\\User\\globalStorage\\github.copilot-chat',
    'D:\\Roaming\\VSCodium\\User\\workspaceStorage',
    'D:\\Roaming\\VSCodium\\User\\globalStorage\\github.copilot-chat',
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
  assert.equal(copilotSubagentParser.isLogFile('C:\\x\\GitHub.copilot-chat\\debug-logs\\s\\searchSubagent-call.jsonl'), true);
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
  const chatDir = join(base, 'Code', 'User', 'workspaceStorage', 'hash', 'chatSessions');
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(join(chatDir, 'session.jsonl'),
    '{"kind":0,"v":{"sessionId":"win-live-fixture","creationDate":1783000000000,"requests":[{"timestamp":1783000001000,"promptTokens":10,"completionTokens":2,"copilotCredits":0.1}]}}\r\n');
  const debugDir = join(
    base, 'Code', 'User', 'globalStorage', 'github.copilot-chat',
    'debug-logs', 'parent-session-1'
  );
  mkdirSync(debugDir, { recursive: true });
  copyFileSync(join(import.meta.dirname, 'fixtures', 'copilot-debug', 'main.jsonl'), join(debugDir, 'main.jsonl'));
  const oldAppData = process.env.APPDATA;
  const oldExplicit = process.env.AIMET_COPILOT_DIR;
  process.env.APPDATA = base;
  delete process.env.AIMET_COPILOT_DIR;
  const store = new Store(join(base, 'aimet db', 'metrics.db'));
  try {
    const result = await collect({ store, tools: ['copilot'], quiet: true });
    assert.equal(result.inserted, 2);
    assert.equal(store.query('SELECT COUNT(*) AS n FROM sessions')[0].n, 2);
    const rows = store.query('SELECT session_id, log_path FROM sessions ORDER BY session_id');
    assert.ok(rows.some((row) => String(row.log_path).includes('workspaceStorage')));
    assert.ok(rows.some((row) => String(row.log_path).includes('globalStorage')));
  } finally {
    store.close();
    if (oldAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = oldAppData;
    if (oldExplicit === undefined) delete process.env.AIMET_COPILOT_DIR;
    else process.env.AIMET_COPILOT_DIR = oldExplicit;
  }
});

test('current globalStorage project resolves from exact session-store cwd', () => {
  const userDir = mkdtempSync(join(tmpdir(), 'aimet-copilot-user-'));
  const copilotDir = join(userDir, 'globalStorage', 'github.copilot-chat');
  const debugDir = join(copilotDir, 'debug-logs', 'indexed-session');
  mkdirSync(debugDir, { recursive: true });
  const log = join(debugDir, 'main.jsonl');
  writeFileSync(log, '');

  const db = new DatabaseSync(join(copilotDir, 'session-store.db'));
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT)');
  db.prepare('INSERT INTO sessions (id, cwd) VALUES (?, ?)')
    .run('indexed-session', 'C:\\Work\\Indexed Project');
  db.close();

  assert.equal(projectOf(log, 'indexed-session'), 'C:\\Work\\Indexed Project');
  assert.equal(projectOf(log, 'different-session'), 'unknown', 'never use another session cwd');
  assert.deepEqual(projectInfoOf(log, 'indexed-session'), {
    project: 'C:\\Work\\Indexed Project',
    source: 'session-store',
  });
});

test('current globalStorage project falls back to one referenced registered workspace', async () => {
  const userDir = mkdtempSync(join(tmpdir(), 'aimet-copilot-reference-'));
  const workspaceDir = join(userDir, 'workspaceStorage', 'known-hash');
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, 'workspace.json'),
    JSON.stringify({ folder: 'file:///C:/Work/Known%20Project' })
  );

  const debugDir = join(
    userDir, 'globalStorage', 'github.copilot-chat', 'debug-logs', 'referenced-session'
  );
  mkdirSync(debugDir, { recursive: true });
  const log = join(debugDir, 'main.jsonl');
  const records = [
    { ts: 1000, sid: 'referenced-session', type: 'session_start', name: 'session_start', attrs: {} },
    {
      ts: 2000, dur: 20, sid: 'referenced-session', type: 'llm_request',
      name: 'chat:test', spanId: 'span-1', attrs: {
        model: 'gpt-5.2', inputTokens: 10, outputTokens: 2, cachedTokens: 0,
        copilotUsageNanoAiu: 1000,
        toolArgs: JSON.stringify({ filePath: 'C:\\Work\\Known Project\\src\\index.ts' }),
      },
    },
  ];
  writeFileSync(log, records.map(JSON.stringify).join('\n'));

  const projects = knownWorkspaceProjects(log);
  assert.deepEqual(projects.map((project) => project.replace(/\\/g, '/')), [
    'C:/Work/Known Project',
  ]);
  const matches = new Set();
  collectKnownWorkspaceReferences(records[1].attrs, projects, matches);
  assert.deepEqual([...matches].map((project) => project.replace(/\\/g, '/')), [
    'C:/Work/Known Project',
  ]);

  const metrics = await copilotSubagentParser.parseFile(log);
  assert.ok(metrics);
  assert.equal(metrics.project.replace(/\\/g, '/'), 'C:/Work/Known Project');
  assert.equal(metrics.projectSource, 'structured-reference');
});

test('free-form prompt path mention is not used for project attribution', async () => {
  const projects = ['C:\\Work\\Known Project'];
  const matches = new Set();
  collectKnownWorkspaceReferences({
    userRequest: JSON.stringify([{ text: 'Discuss C:\\Work\\Known Project\\src\\index.ts' }]),
    prompt: 'Compare C:\\Work\\Known Project with another repository',
    message: { path: 'C:\\Work\\Known Project\\src\\index.ts' },
  }, projects, matches);
  assert.deepEqual([...matches], []);

  collectKnownWorkspaceReferences({
    toolArgs: JSON.stringify({ filePath: 'C:\\Work\\Known Project\\src\\index.ts' }),
  }, projects, matches);
  assert.deepEqual([...matches], projects, 'structured tool file arguments remain usable');
});
