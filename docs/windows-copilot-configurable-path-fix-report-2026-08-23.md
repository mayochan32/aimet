# Windows Copilot configurable-path dry-run 修正・検証レポート

## 結論

Windows実機検証で見つかった `aimet init copilot --dry-run` の設定可能パス判定を修正した。

未作成の `VSCODE_PORTABLE` を指定した場合でも、dry-runは解決した
`user-data\User\prompts\metrics.prompt.md` の配置予定を表示する。通常実行時は従来どおり、
実在するVS Code Userディレクトリだけを対象とするため、通常実行の書き込み範囲は広げていない。

修正後は自動テスト51件が全件成功し、作業依頼書に記載されたWindows configurable-path
init確認ブロックも成功した。直前に実施したSonnet 5の実機Copilot E2Eでは、シングル／
マルチエージェントの実ログ収集、独立検算、親子関係、実測AI Credits、冪等性がすべて
合格している。

## 検証環境

- OSレジストリ値: Windows 10 Pro、DisplayVersion 25H2、build 26200.8973、x64
- Visual Studio Code Stable: 1.134.0、x64
- 内蔵GitHub Copilot: 0.62.0
- Node.js: v24.11.1
- npm: 11.6.2
- Git: 2.46.0.windows.1
- ブランチ: `codex/copilot-accounting-fix`
- 修正前HEAD: `9904d36f1a1bc21eebf592acd9f64ac54ee4f59e`

## 発見した問題

作業依頼書のPowerShellブロックは、まだ存在しない一時ディレクトリを
`VSCODE_PORTABLE` に指定し、次の配置予定がdry-run出力に含まれることを検証する。

```text
<VSCODE_PORTABLE>\user-data\User\prompts\metrics.prompt.md
```

修正前は、次の出力となり検証に失敗した。

```text
Copilot prompt path mismatch:
[dry-run] would write C:\Users\km\.copilot\hooks\aimet.json
note: VS Code agent hooks are in Preview. Verify with /hooks in Copilot Chat
note: no VS Code user dir found; /metrics prompt file was not installed
```

Claude Codeの `CLAUDE_CONFIG_DIR` とCodexの `CODEX_HOME` の判定は成功しており、
失敗したのはCopilotプロンプトのdry-run表示だけだった。

## 原因

`initCopilot()` はdry-runかどうかに関係なく、`vscodeUserDirs()` が返した候補を
`existsSync()` で絞り込んでいた。

```ts
const userDirs = vscodeUserDirs().filter((d) => existsSync(d));
```

このため、配置先を確認することが目的のdry-runでも、未作成の明示パスが候補から消えていた。
既存テストは先にPortableのログディレクトリを作成していたため、この条件を検出できなかった。

## 修正内容

`VSCODE_PORTABLE` または `VSCODE_APPDATA` でユーザーデータルートが明示されている場合、
dry-runに限って未作成の候補を残すよう変更した。

```ts
const hasConfiguredUserDataRoot = Boolean(
  process.env.VSCODE_PORTABLE?.trim() || process.env.VSCODE_APPDATA?.trim()
);
const userDirs = vscodeUserDirs().filter(
  (d) => existsSync(d) || (dryRun && hasConfiguredUserDataRoot)
);
```

この条件により、挙動は次のようになる。

| 実行方式 | 明示パスが未作成 | 動作 |
|---|---:|---|
| `--dry-run` | はい | 解決した配置予定を表示する。ディスクには作成しない |
| 通常実行 | はい | 従来どおり対象外とし、存在しないVS Code環境へ書き込まない |
| 通常実行 | いいえ | 従来どおりプロンプトを配置する |

## 追加した回帰テスト

次の条件をまとめて検証するテストを追加した。

- Portableルートはテスト開始時に存在しない
- パスには空白と日本語を含む
- dry-run出力に期待する `metrics.prompt.md` が含まれる
- `no VS Code user dir found` が表示されない
- dry-run後もPortableルートが作成されていない
- 変更した環境変数をテスト終了時に復元する

テスト名:

```text
Copilot init dry-run reports a configured portable prompt path before it exists
```

## 自動テスト結果

```text
tests 51
suites 0
pass 51
fail 0
cancelled 0
skipped 0
todo 0
```

今回追加した回帰テストを含め、`VSCODE_PORTABLE`、`VSCODE_APPDATA`、
`CLAUDE_CONFIG_DIR`、`CODEX_HOME` 関連テストはskipされず成功した。

## Windows configurable-path init再検証

作業依頼書のPowerShellブロックを変更せず再実行した。

```text
Windows configurable-path init check passed.
```

`--dry-run` のため、ユーザーのClaude、Codex、VS Code設定には書き込んでいない。

## Copilot実機E2E結果

修正直前に、同じWindows環境とブランチでSonnet 5を指定し、VS Code Copilotを実際に
起動するシングル／マルチエージェントE2Eを実施した。dry-runやモックログではなく、
VS Codeが生成した実ログを一時DBへ取り込み、生ログから独立計算した値と照合している。

```text
ok: true
sessionsChecked: 4
parentsChecked: 2
singleAgentsChecked: 1
chatOnlyChecked: 1
childrenChecked: 2
input: 106196
cacheRead: 564129
output: 3057
AI Credits: 40.88698000000001
```

検算対象4セッションはすべて次の条件を満たした。

- モデルは `claude-sonnet-5` 系
- `cost_source = actual`
- `metric_scope = own`
- `estimated = 0`
- 子2件の `parent_session_id` は同じ実在する親を参照
- 親子合計は各セッションを1回だけ加算し、二重カウントなし

2回目の取り込み結果:

```text
scanned 4 files: +0 new, ~0 updated, 4 unchanged, 0 errors
```

最終出力:

```text
Windows Copilot E2E passed.
```

今回変更したのはCopilot初期化のdry-run候補判定とそのテストだけであり、ログ収集、
パース、DB保存、集計処理には変更がない。そのため修正後にAI Creditsを再消費する
実機E2Eの再実行は行わず、修正後の自動テストとconfigurable-pathブロックを再実行した。

## 変更ファイル

- `src/init.ts`
- `test/paths.test.js`
- `docs/windows-copilot-configurable-path-fix-report-2026-08-23.md`

## 補足

以前作成された未追跡ファイル
`docs/windows-copilot-e2e-result-2026-08-22.md` は、依頼者の指示どおり今回のコミットには
含めず、内容も変更していない。
