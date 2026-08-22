import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const cli = join(import.meta.dirname, '..', 'dist', 'cli.js');
const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('CLI --version prints the installed package version and exits successfully', () => {
  const result = run('--version');
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), pkg.version);
});

test('CLI help documents --version and exits successfully', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /aimet --version/);
  assert.match(result.stdout, /show the installed aimet version/);
});

test('detail --file requires an explicit supported tool', () => {
  const missing = run('detail', '--file', 'anything.jsonl');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /--file requires --tool/);

  const unknown = run('detail', '--tool', 'other', '--file', 'anything.jsonl');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown tool/);
});

test('hook failures are advisory and never fail the host tool', () => {
  const result = spawnSync(process.execPath, [cli, 'hook', 'codex'], {
    encoding: 'utf8',
    env: { ...process.env, AIMET_DB: import.meta.dirname },
  });
  assert.equal(result.status, 0);
  assert.match(result.stderr, /aimet:/);
});

test('hook ingests a Copilot child transcript using its exact log parser', () => {
  const root = mkdtempSync(join(tmpdir(), 'aimet-hook-child-'));
  const dbPath = join(root, 'metrics.db');
  const fixture = join(
    import.meta.dirname,
    'fixtures',
    'copilot-debug',
    'searchSubagent-call_search_fixture.jsonl'
  );
  const debugDir = join(root, 'GitHub.copilot-chat', 'debug-logs', 'parent-session-1');
  mkdirSync(debugDir, { recursive: true });
  const transcript = join(debugDir, 'searchSubagent-call_search_fixture.jsonl');
  copyFileSync(fixture, transcript);
  const result = spawnSync(process.execPath, [cli, 'hook', 'copilot'], {
    encoding: 'utf8',
    input: JSON.stringify({ agent_transcript_path: transcript }),
    env: { ...process.env, AIMET_DB: dbPath },
  });
  assert.equal(result.status, 0);
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT parent_session_id, metric_scope FROM sessions').get();
  db.close();
  assert.equal(row.parent_session_id, 'parent-session-1');
  assert.equal(row.metric_scope, 'own');
});
