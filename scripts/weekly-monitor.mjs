import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// These are official, public documents. Prefer Markdown or the vendor's own
// documentation repository so navigation and page chrome do not cause alerts.
export const SOURCES = [
  ['OpenAI models', 'https://developers.openai.com/api/docs/models/all.md'],
  ['OpenAI pricing', 'https://developers.openai.com/api/docs/pricing.md'],
  ['OpenAI API changelog', 'https://developers.openai.com/api/docs/changelog.md'],
  ['Anthropic models', 'https://platform.claude.com/docs/en/models/overview.md'],
  ['Anthropic pricing', 'https://platform.claude.com/docs/en/about-claude/pricing.md'],
  ['Claude Code changelog', 'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md'],
  ['GitHub Copilot models and pricing', 'https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing.md'],
  ['GitHub Copilot CLI OTel', 'https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference.md'],
  ['GitHub Copilot CLI changelog', 'https://raw.githubusercontent.com/github/copilot-cli/main/changelog.md'],
  ['VS Code agent OTel', 'https://raw.githubusercontent.com/microsoft/vscode-docs/main/docs/agents/guides/monitoring-agents.md'],
];

const ISSUE_TITLE_PREFIX = 'aimet 週次監視レポート';
const STATE_PREFIX = '<!-- aimet-weekly-monitor:v1:';

export function fingerprint(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n').replace(/[\t ]+$/gm, '').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

export function compareSources(previous, current) {
  if (!previous) return { firstRun: true, changed: [] };
  return {
    firstRun: false,
    changed: Object.keys(current).filter((url) => previous[url] !== current[url]),
  };
}

export function encodeState(state) {
  return `${STATE_PREFIX}${Buffer.from(JSON.stringify(state)).toString('base64url')} -->`;
}

export function decodeState(text) {
  const match = text.match(/<!-- aimet-weekly-monitor:v1:([A-Za-z0-9_-]+) -->/);
  if (!match) return null;
  try {
    const value = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    return value && typeof value === 'object' && value.hashes && typeof value.hashes === 'object'
      ? value : null;
  } catch {
    return null;
  }
}

async function fetchDocument([name, url]) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'aimet-weekly-monitor/1.0' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!['developers.openai.com', 'platform.claude.com', 'docs.github.com', 'raw.githubusercontent.com']
      .includes(new URL(response.url).hostname)) throw new Error('想定外の転送先です');
    if (!/^(text\/markdown|text\/plain)/i.test(response.headers.get('content-type') ?? '')) {
      throw new Error('Markdown以外の応答です');
    }
    const body = await response.text();
    if (body.length < 500) throw new Error('本文が短すぎます');
    return { name, url, hash: fingerprint(body) };
  } catch (error) {
    return { name, url, error: error instanceof Error ? error.message : String(error) };
  }
}

async function github(method, path, token, body) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'aimet-weekly-monitor/1.0',
      'x-github-api-version': '2022-11-28',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub API ${method} ${path}: HTTP ${response.status}`);
  return response.json();
}

async function previousReports(repo, token, currentRunId) {
  let previous = null;
  let current = null;
  for (let page = 1; page <= 20; page++) {
    const issues = await github('GET', `/repos/${repo}/issues?state=all&per_page=100&page=${page}`, token);
    for (const issue of issues) {
      if (issue.pull_request || !issue.title.startsWith(ISSUE_TITLE_PREFIX)) continue;
      if (issue.title.endsWith(`#${currentRunId}`)) {
        current = issue;
        continue;
      }
      const state = decodeState(issue.body ?? '');
      if (state && (!previous || issue.created_at > previous.created_at)) previous = { ...issue, state };
    }
    if (issues.length < 100) return { previous, current };
  }
  throw new Error('過去の週次監視Issueを探せませんでした');
}

export async function main() {
  const documents = await Promise.all(SOURCES.map(fetchDocument));
  const errors = documents.filter((document) => document.error);
  const current = Object.fromEntries(documents.filter((document) => document.hash)
    .map(({ url, hash }) => [url, hash]));

  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ checked: documents.length, failures: errors }, null, 2));
    if (errors.length) process.exitCode = 1;
    return;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const recipient = process.env.AIMET_MONITOR_RECIPIENT;
  if (!repo || !token || !recipient || !/^[A-Za-z0-9-]+$/.test(recipient)) {
    throw new Error('GITHUB_REPOSITORY、GITHUB_TOKEN、AIMET_MONITOR_RECIPIENTが必要です');
  }
  const testResult = process.env.AIMET_MONITOR_TEST_RESULT ?? 'unknown';
  const runId = process.env.GITHUB_RUN_ID;
  if (!runId || !/^\d+$/.test(runId)) throw new Error('GITHUB_RUN_IDが必要です');
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${runId}`;
  const { previous, current: existing } = await previousReports(repo, token, runId);
  if (existing) {
    console.log(`この実行のレポートはすでに作成済みです：${existing.html_url}`);
    return;
  }
  const previousHashes = previous?.state.hashes ?? null;
  const { firstRun, changed } = compareSources(previousHashes, current);
  const hashes = { ...(previousHashes ?? {}), ...current };
  const status = errors.length || testResult !== 'success' ? '確認未完了'
    : firstRun ? '初回記録（比較元なし）'
      : changed.length ? '公式情報に変更候補あり' : '変更候補なし';
  const changedLines = changed.length ? changed.map((url) => {
    const document = documents.find((item) => item.url === url);
    return `- [${document.name}](${url})：前回 ${previousHashes[url]?.slice(0, 12) ?? '未登録'} → 今回 ${current[url].slice(0, 12)}`;
  }).join('\n') : '- なし';
  const errorLines = errors.length ? errors.map(({ name, url, error }) => `- [${name}](${url})：${error}`).join('\n') : '- なし';
  const body = [
    `@${recipient} 週次確認結果：**${status}**`,
    '',
    `- 実行日時：${new Date().toISOString()}`,
    `- 確認した公式資料：${documents.length - errors.length}/${documents.length}件`,
    `- fixtureテスト：${testResult}`,
    `- [GitHub Actions実行結果](${runUrl})`,
    '',
    '変更候補（資料本文の差分。モデル・料金の変更と断定はしません）：',
    changedLines,
    '',
    '取得できなかった資料：',
    errorLines,
    '',
    'ローカルの実ログはGitHub Actionsから確認できません。変更候補があれば公式資料と実ログを人が確認し、修正PRの反映も人が判断してください。',
    '',
    encodeState({ hashes }),
  ].join('\n');
  const date = new Date().toISOString().slice(0, 10);
  const issue = await github('POST', `/repos/${repo}/issues`, token, {
    title: `${ISSUE_TITLE_PREFIX} ${date}：${status} #${runId}`,
    body,
    assignees: [recipient],
  });
  console.log(`週次レポート：${status}（${issue.html_url}）`);
  if (errors.length || testResult !== 'success') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
