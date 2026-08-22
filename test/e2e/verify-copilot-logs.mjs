import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [dbPath, logRoot, resultPath] = process.argv.slice(2);
if (!dbPath || !logRoot) {
  throw new Error('usage: node verify-copilot-logs.mjs <metrics.db> <captured-log-root> [result.json]');
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

function records(path) {
  return readFileSync(path, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function setAt(root, path, value) {
  if (!Array.isArray(path) || path.length === 0) return;
  let current = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return;
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = typeof path[i + 1] === 'number' ? [] : Object.create(null);
    }
    current = current[key];
  }
  current[path.at(-1)] = value;
}

function deleteAt(root, path) {
  if (!Array.isArray(path) || path.length === 0) return;
  let current = root;
  for (const key of path.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== 'object') return;
    current = current[key];
  }
  delete current[path.at(-1)];
}

function chatOracle(path) {
  let session = {};
  for (const rec of records(path)) {
    if (rec.kind === 0) {
      session = rec.v && typeof rec.v === 'object' ? rec.v : {};
    } else if (rec.kind === 1) {
      setAt(session, rec.k, rec.v);
    } else if (rec.kind === 2) {
      if (Array.isArray(rec.v)) {
        let array = session;
        for (const key of rec.k ?? []) {
          if (!array[key] || typeof array[key] !== 'object') array[key] = [];
          array = array[key];
        }
        if (Number.isInteger(rec.i) && rec.i >= 0) array.length = rec.i;
        array.push(...rec.v);
      } else {
        setAt(session, rec.k, rec.v);
      }
    } else if (rec.kind === 3) {
      deleteAt(session, rec.k);
    }
  }

  const requests = Array.isArray(session.requests) ? session.requests.filter(Boolean) : [];
  if (typeof session.sessionId !== 'string' || requests.length === 0) return null;
  let promptTotal = 0;
  let cacheRead = 0;
  let output = 0;
  let aic = 0;
  let allCacheKnown = true;
  for (const request of requests) {
    const prompt = Number(request.promptTokens ?? 0);
    const details = request.promptTokenDetails;
    allCacheKnown &&= Array.isArray(details);
    const cacheRatio = Array.isArray(details)
      ? details.reduce((sum, item) => /cache/i.test(`${item?.category ?? ''} ${item?.label ?? ''}`)
        ? sum + Number(item.percentageOfPrompt ?? 0) : sum, 0) / 100
      : 0;
    const cached = Math.round(prompt * Math.max(0, Math.min(1, cacheRatio)));
    promptTotal += prompt;
    cacheRead += cached;
    output += Number(request.completionTokens ?? 0);
    assert.notEqual(request.copilotCredits, undefined,
      `live acceptance requires exact Copilot credits in ${path}`);
    aic += Number(request.copilotCredits);
  }
  return {
    path,
    sessionId: session.sessionId,
    parentSessionId: null,
    input: allCacheKnown ? promptTotal - cacheRead : promptTotal,
    cacheRead: allCacheKnown ? cacheRead : null,
    output,
    aic,
    requests: requests.length,
    source: 'chat',
  };
}

function directSpanOracle(path) {
  let sessionId = '';
  let parentSessionId = null;
  let input = 0;
  let cacheRead = 0;
  let output = 0;
  let aic = 0;
  let requests = 0;
  const seen = new Set();
  for (const rec of records(path)) {
    const attrs = rec.attrs && typeof rec.attrs === 'object' ? rec.attrs : {};
    if (rec.type === 'session_start') {
      sessionId ||= typeof rec.sid === 'string' ? rec.sid : '';
      parentSessionId ||= typeof attrs.parentSessionId === 'string' ? attrs.parentSessionId : null;
    }
    if (rec.type !== 'llm_request') continue;
    const spanId = typeof rec.spanId === 'string' ? rec.spanId : '';
    if (spanId && seen.has(spanId)) continue;
    if (spanId) seen.add(spanId);
    const usage = attrs.usage && typeof attrs.usage === 'object' ? attrs.usage : {};
    const totalInput = Number(attrs.inputTokens ?? usage.input_tokens ?? 0);
    const cached = Number(attrs.cachedTokens ?? usage.cached_input_tokens ?? 0);
    const out = Number(attrs.outputTokens ?? usage.output_tokens ?? 0);
    const nano = attrs.copilotUsageNanoAiu;
    const directAiu = attrs.aiu;
    assert.ok(nano !== undefined || directAiu !== undefined,
      `live acceptance requires exact AIU in ${path} span ${spanId || requests}`);
    input += Math.max(0, totalInput - cached);
    cacheRead += cached;
    output += out;
    aic += nano !== undefined ? Number(nano) / 1e9 : Number(directAiu);
    requests++;
  }
  if (!sessionId || requests === 0) return null;
  return { path, sessionId, parentSessionId, input, cacheRead, output, aic, requests, source: 'span' };
}

const allFiles = [...walk(logRoot)];
const spanFiles = allFiles.filter((path) => {
  const name = basename(path);
  return name === 'main.jsonl' || name.startsWith('runSubagent-');
});
assert.ok(spanFiles.length > 0, 'no Copilot span traces were captured');
const spanExpected = spanFiles.map(directSpanOracle).filter(Boolean);
const mainIds = new Set(spanExpected.filter((item) => !item.parentSessionId).map((item) => item.sessionId));
const chatExpected = allFiles
  .filter((path) => path.replaceAll('\\', '/').includes('/chatSessions/') && path.endsWith('.jsonl'))
  .map(chatOracle)
  .filter((item) => item && !mainIds.has(item.sessionId));
const expected = [...spanExpected, ...chatExpected];
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('SELECT * FROM sessions WHERE tool = ?').all('copilot');
const byId = new Map(rows.map((row) => [String(row.session_id), row]));

for (const exp of expected) {
  const row = byId.get(exp.sessionId);
  assert.ok(row, `aimet did not store span session ${exp.sessionId}`);
  assert.equal(row.parent_session_id, exp.parentSessionId);
  assert.equal(row.input_tokens, exp.input, `${exp.sessionId} input`);
  assert.equal(row.cache_read_tokens, exp.cacheRead, `${exp.sessionId} cacheR`);
  assert.equal(row.output_tokens, exp.output, `${exp.sessionId} output`);
  assert.ok(Math.abs(Number(row.cost_usd) - exp.aic * 0.01) < 1e-12, `${exp.sessionId} AIC cost`);
  assert.equal(row.estimated, 0, `${exp.sessionId} must use actual AIU`);
  assert.equal(row.cost_source, 'actual');
  assert.equal(row.metric_scope, 'own');
}

const children = expected.filter((item) => item.parentSessionId);
const mainSessions = spanExpected.filter((item) => !item.parentSessionId);
assert.ok(children.length >= 2, `expected at least two subagent traces, found ${children.length}`);
assert.ok(mainSessions.length >= 1, 'expected at least one parent main.jsonl');
const childCounts = new Map();
for (const child of children) {
  childCounts.set(child.parentSessionId, (childCounts.get(child.parentSessionId) ?? 0) + 1);
  assert.ok(byId.has(child.parentSessionId), `missing parent row ${child.parentSessionId}`);
}
assert.ok([...childCounts.values()].some((count) => count >= 2), 'no parent has the required two subagents');
// Older Copilot builds may only leave chatSessions for a single-agent run;
// current builds write a richer main.jsonl for it. In both cases, verify at
// least one top-level session that has no children. Keep chatOnlyChecked as a
// compatibility result field for existing acceptance tooling.
const childParentIds = new Set(childCounts.keys());
const singleAgents = expected.filter(
  (item) => !item.parentSessionId && !childParentIds.has(item.sessionId)
);
assert.ok(singleAgents.length >= 1, 'no single-agent session was captured');

const total = expected.reduce((sum, item) => ({
  input: sum.input + item.input,
  cacheRead: sum.cacheRead + item.cacheRead,
  output: sum.output + item.output,
  aic: sum.aic + item.aic,
}), { input: 0, cacheRead: 0, output: 0, aic: 0 });

const result = {
  ok: true,
  platform: process.platform,
  sessionsChecked: expected.length,
  parentsChecked: mainSessions.length + chatExpected.length,
  chatOnlyChecked: singleAgents.length,
  singleAgentsChecked: singleAgents.length,
  childrenChecked: children.length,
  total,
  sessions: expected.map(({ path, ...item }) => item),
};
const json = JSON.stringify(result, null, 2) + '\n';
if (resultPath) writeFileSync(resultPath, json);
console.log(json);
db.close();
