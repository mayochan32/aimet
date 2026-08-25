import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const examplesDir = join(root, 'examples');

test('published examples are sanitized and use current output semantics', () => {
  const files = readdirSync(examplesDir).filter((name) => name.endsWith('.md')).sort();
  assert.deepEqual(files, [
    'detail-claude.md',
    'detail-codex.md',
    'detail-copilot-subagent.md',
    'detail-copilot.md',
    'detail-copilotcli.md',
    'report.md',
    'session-claude.md',
    'session-codex.md',
    'session-copilot.md',
    'sessions.md',
  ]);
  const combined = files.map((name) => readFileSync(join(examplesDir, name), 'utf8')).join('\n');
  assert.doesNotMatch(combined, /\/Users\/hal|\\Users\\hal/i);
  assert.match(
    readFileSync(join(examplesDir, 'detail-copilot-subagent.md'), 'utf8'),
    /agent debug span trace/
  );
  assert.match(
    readFileSync(join(examplesDir, 'report.md'), 'utf8'),
    /AI Credits × \$0\.01/
  );
  assert.match(
    readFileSync(join(examplesDir, 'session-codex.md'), 'utf8'),
    /TOTAL \(parent \+ subagents\).*cost n\/a/
  );
  assert.match(
    readFileSync(join(examplesDir, 'sessions.md'), 'utf8'),
    /last: 最後に観測したイベント日時/
  );
});

test('every local examples link in README resolves to a distributed file', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const links = [...readme.matchAll(/\]\((examples\/[^)]+\.md)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0);
  for (const path of links) assert.ok(existsSync(join(root, path)), `missing ${path}`);
});
