# aimetのWindows実機Copilot計測・検証作業依頼書

## この文書を読むAIへ

この文書は、これまでの会話やaimetに関する前提知識を持たないAIに、Windows PC上で検証作業を引き継がせるための完結した作業依頼書です。手順だけでなく、プロジェクトの目的、問題の背景、修正方針、検証の合格条件、作業範囲もすべてここに記載しています。

この文書を上から最後まで読んだ上で作業してください。単にコマンドを実行するのではなく、「Copilotの生ログとaimetの集計値が一致し、サブエージェントが二重計上されていないことをWindows実機で証明する」ことが作業の目的です。

## プロジェクトの基本情報

- プロジェクト名: **aimet — AI Metrics**
- GitHubリポジトリ: <https://github.com/mayochan32/aimet>
- 検証対象ブランチ: `codex/copilot-accounting-fix`
- 正式ブランチの方針: 今後は `master` に一本化し、`main` は廃止予定
- 開発言語: TypeScript / Node.js
- 必要なNode.js: 22.5以上
- 主な保存先: SQLite（通常は `~/.aimet/metrics.db`）

aimetは、Claude Code、Codex CLI、GitHub CopilotがローカルPCに保存したJSONL形式のセッションログを読み、次の情報をセッション単位でSQLiteに保存・集計するCLIツールです。

- 入力トークン
- 出力トークン
- キャッシュ読取・書込トークン
- 作業時間
- API換算コストまたはCopilotの実測AI Credits
- 親エージェントとサブエージェントの関係

組織向けの管理APIは使わず、利用者のPCに残るローカルログだけを情報源にします。そのため、ログの読み方と二重計上防止の正しさが、ツールの信頼性そのものです。

今回の修正とWindows検証に関係する主なファイルは次のとおりです。失敗を診断する場合は、これらの責務を区別してください。

| ファイル | 責務 |
|---|---|
| `src/parsers/copilot.ts` | `chatSessions` のObjectMutationLog復元とChat親セッションの計測 |
| `src/parsers/copilotsubagent.ts` | `main.jsonl` の親と `runSubagent-*` の子のスパン計測 |
| `src/store.ts` | DBスキーマ、冪等upsert、同じ親IDでの `main.jsonl` 優先 |
| `src/report.ts` / `src/markdown.ts` | `own` / `tree` に基づく共通の親子集計 |
| `src/paths.ts` | macOS / Windows / LinuxのVS Codeログパス解決 |
| `test/e2e/copilot-windows.ps1` | Windowsでシングル・マルチを起動する受け入れ試験 |
| `test/e2e/verify-copilot-logs.mjs` | aimet本体のパーサを使わず、生ログとDBを照合する独立検算器 |
| `test/fixtures/real/` | macOS実ログを匿名化したgolden fixture |

## 今回の開発の背景

VS CodeのGitHub Copilot Chatでサブエージェントを使った場合、親と子のトークン量・AI Creditsをどのように合算するかが問題になりました。親の値に既に子の値が含まれているのに子を再度加算すると、サブエージェントの消費が二重計上されます。反対に、親が親自身の値しか持たないのに子を除外すると、大幅な過少計上になります。

過去の `main` ブランチのコミット `4d980b8` では、Copilot CLIの「親の終了時累計が子を含む」形式をVS Code Chatにも一般化し、親の値から子を差し引く方法が試されました。しかし、VS Code Chatの親AI Creditsは親自身の消費であり、子は別に記録・課金されるため、この一般化は正しくありませんでした。そのため後続の `2be37a5` でその方式は撤回されています。今回は `main` ブランチを丸ごと採用せず、`origin/master` を基点に実ログで確認できた規則だけを実装し直しています。

実ログの調査で、VS Code Copilotの現在のログは次の構造であることが分かりました。

- `chatSessions/<session-id>.jsonl`: VS Code Chatセッションのスナップショット。親の内部LLM呼び出しをすべて網羅しない場合がある。
- `GitHub.copilot-chat/debug-logs/<parent-id>/main.jsonl`: 親エージェント自身のLLM呼び出し。
- `GitHub.copilot-chat/debug-logs/<parent-id>/runSubagent-*.jsonl`: 各サブエージェント自身のLLM呼び出し。

この構造に基づき、修正版は次の規則で集計します。

1. 同じ親IDの `chatSessions` と `main.jsonl` がある場合は、情報量の多い `main.jsonl` を必ず優先する。
2. `main.jsonl` の親と各 `runSubagent-*` の子は、それぞれ「自分のLLM呼び出しだけ」を保持する（`metric_scope = own`）。
3. 親子合計では親と子をそれぞれ1回だけ加算する。
4. 過去形式のように親が子込みの累計値を持つ場合は `metric_scope = tree` とし、子を再加算しない。
5. 各LLMリクエストの `copilotUsageNanoAiu` / `aiu` から実測AI Creditsを取得する。欠損したリクエストだけ、モデル単価によるAPI換算を使う。
6. report、session、Markdownのすべてが同じ親子ロールアップ規則を使う。

この修正は `codex/copilot-accounting-fix` ブランチに実装済みです。macOSでは実ログと照合し、次のマルチエージェントセッションが一致しています。これはWindowsで同じ数値を出すべきという意味ではなく、検証方法が実績を持つことの参考値です。Windowsでは新しいセッションが作られるため、数値自体は異なります。

- 親: 1セッション / 6 LLMリクエスト
- 子: 4セッション / 5 + 6 + 7 + 7 LLMリクエスト
- 非キャッシュ入力: 135,577
- cacheR: 505,344
- 出力: 23,819
- 合計: 22.0478895 AI Credits

## Windowsで今回やりたいこと

今回のWindows作業は、Windows用exeの作成や新機能の実装ではありません。ネイティブWindows環境でVS Code Copilotを実際に動かし、次を証明する受け入れ試験です。WSLは対象外です。

1. `%APPDATA%` 配下のVS Codeログを `--dir` なしで発見できる。
2. Windowsのパス区切り、ドライブ文字、`file://` URI、空白、日本語を正しく扱える。
3. シングルエージェントのトークン数とAI Creditsが生ログとDBで一致する。
4. 親が2つのサブエージェントを呼び出すセッションで、親・子それぞれのin / cacheR / out / AI Creditsが生ログとDBで一致する。
5. 子の `parent_session_id` が正しい親を指す。
6. 親子合計で各セッションが1回ずつだけ加算される。
7. 同じログを再取り込みしても、DBに行が増えず更新も発生しない。

## AIの作業範囲と禁止事項

この作業でAIに許可されているのは、事前条件の確認、テストの実行、一時データの作成、結果の検証、失敗原因の診断、結果報告です。

- `master` へのmerge、`main` の削除、ブランチの強制更新はしない。
- Windows用exe化は今回の範囲外。exe作成のための修正を加えない。
- 利用者の通常の `~/.aimet/metrics.db` をテストに使わない。E2Eスクリプトが作る一時DBのみを使う。
- 既存の作業ツリーに別の未コミット変更がある場合、勝手に破棄・上書きしない。
- テストが失敗した場合、原因を診断せずに数値や合格条件を弱めない。
- 失敗を通すためにテストをskipしたり、独立検算をaimet本体のパーサに置き換えたりしない。
- Copilotの生ログは、プロンプト、応答、ファイル内容を含む可能性がある。必要な確認の範囲を超えて外部に送信しない。
- 追加のソース修正が必要と判断した場合は、先に原因、根拠、修正範囲を報告する。検証作業から大きく外れる変更を無断で行わない。

## 受け入れ試験の合格条件

次のすべてを満たした場合のみ、Windows実機検証を合格と判定してください。

1. `npm test` が成功する。Windows専用パステストはskipされず成功する。
2. E2Eの最後に `Windows Copilot E2E passed.` が表示される。
3. 結果JSONの `ok` が `true` である。
4. `chatOnlyChecked >= 1`。これはシングルエージェントが検算されたことを示す（フィールド名は旧形式との互換のため維持。現行版の `main.jsonl` 形式も対象）。
5. `childrenChecked >= 2`。これは同じ親に属する2つ以上のサブエージェントが検算されたことを示す。
6. 検算対象の全セッションで、DBのin / cacheR / out / AI Creditsが生ログから直接計算した値と一致する。
7. 検算対象の全セッションで `cost_source = actual`、`metric_scope = own`、`estimated = 0` である。
8. 各子の `parent_session_id` が存在する親セッションを指す。
9. 2回目の取り込みが `+0 new, ~0 updated` になる。
10. 上記の判定を、コンソール出力と `windows-copilot-e2e.json` の両方で報告する。

## この文書の以降の構成

ここから先は、上記の背景と合格条件に従って、Windows PC上で実際に作業するための手順です。

この手順では、Windows版VS CodeのGitHub Copilotを実際に動かし、次の2ケースを自動検証します。

1. サブエージェントを使わないシングルエージェント
2. 2つのサブエージェントを使うマルチエージェント

テストは、Copilotの生ログから独立して計算したトークン数・AI Creditsと、aimetがSQLite DBに保存した値を照合します。同じログの2回目の取り込みで追加・更新が0件になることも確認します。

> 注意: このテストは実際にCopilotを呼び出すため、AI Creditsを消費します。WSLではなく、WindowsのPowerShellで実行してください。

## 1. 必要なもの

- Windows 10 / 11
- Git
- Node.js 22.5以上（Node.js 22または24を推奨）
- 最新のVisual Studio Code Stable、Insiders、またはVSCodium
- VS CodeでGitHubアカウントにサインイン済み
- GitHub Copilot ChatとAgent modeを利用できるアカウント
- サブエージェントの `agent/runSubagent` ツールが利用可能

PowerShellを開き、次を実行します。

```powershell
git --version
node --version
npm --version
```

`node --version` が `v22.5.0` 以上でない場合は、Node.jsを更新してください。

## 2. VS Codeのデバッグログを有効にする

aimetが親・子それぞれの正確なトークン数とAI Creditsを検算するには、Copilot Chatのファイルログが必要です。

1. VS Codeを開きます。
2. `Ctrl+,` でSettingsを開きます。
3. `github.copilot.chat.agentDebugLog.fileLogging.enabled` を検索し、有効にします。
   - 現行版では、この設定だけでデバッグイベントの収集とファイル出力が有効になります。
   - 従来版で `github.copilot.chat.agentDebugLog.enabled` も表示される場合は、互換性のためそちらも有効にします。現行版では旧設定は非推奨で、`fileLogging.enabled` に統合されています。
4. Copilot ChatをAgent modeにし、ツール一覧で `agent/runSubagent` が有効であることを確認します。
5. VS Codeを一度終了して再起動します。

現行実装での統合は、Microsoft公式Copilot Chatリポジトリの設定定義にも明記されています。

- [VS Code: AI settings reference](https://code.visualstudio.com/docs/agents/reference/ai-settings#_debugging-settings)
- [Copilot: current setting and legacy deprecation](https://github.com/microsoft/vscode/blob/main/extensions/copilot/package.nls.json)
- [VS Code: Subagents](https://code.visualstudio.com/docs/agents/run/subagents)

## 3. 検証ブランチを取得する

既にaimetをclone済みの場合は、リポジトリのフォルダで次を実行します。

```powershell
git fetch origin
git switch codex/copilot-accounting-fix
git pull --ff-only
git rev-parse --short HEAD
```

最後の出力が `9d677f7` またはそれより新しいコミットであることを確認します。このコミット自体がまだリモートにない場合は、作業依頼者にpush済みか確認し、古いブランチのまま検証を続けないでください。

まだcloneしていない場合は、作業したいフォルダで次を実行します。

```powershell
git clone --branch codex/copilot-accounting-fix https://github.com/mayochan32/aimet.git
Set-Location aimet
```

## 4. 事前確認を実行する

最初に、ネイティブWindowsであることと、作業ツリーに未コミット変更がないことを確認します。

```powershell
$env:OS
git branch --show-current
git status --short
```

- `$env:OS` は `Windows_NT`
- ブランチは `codex/copilot-accounting-fix`
- `git status --short` は出力なし

であることが期待値です。未コミット変更がある場合は、それを破棄せず依頼者に報告してください。

```powershell
npm ci
npm test
```

全テストが成功し、Windows専用の次のテストがskipではなく成功することを確認します。

```text
Windows collect discovers Copilot logs from APPDATA without --dir
```

## 5. Copilotの実機E2Eを実行する

VS Codeを起動し、Copilotにサインイン済みの状態にしたまま、PowerShellで次を実行します。

```powershell
npm run test:e2e:copilot-windows
```

スクリプトは次の処理を自動で行います。

1. 通常の自動テストを再実行
2. 日本語と空白を含むWindows上の一時パスを作成
3. VS Code Copilotでシングルエージェントを実行
4. VS Code Copilotで2つのサブエージェントを実行
5. 新しく生成されたログが20秒間安定するまで待機
6. aimetで取り込み
7. 生ログを直接読む独立検算器で、各親・子のin / cacheR / out / AI CreditsをDBと照合
8. 2回目の取り込みが冪等であることを確認

Copilotの応答速度により、数分かかることがあります。シングル、マルチのそれぞれに最大10分待機します。実行中に開いたVS Codeウィンドウは閉じないでください。

## 6. 成功時の表示

正常終了すると、最後に次のように表示されます。

```text
Windows Copilot E2E passed. Result: C:\Users\...\AppData\Local\Temp\...\windows-copilot-e2e.json
```

あわせて、2回目の取り込み結果が次になっていることを確認します。

```text
+0 new, ~0 updated
```

結果JSONの `ok` が `true`、`chatOnlyChecked` が1以上、`childrenChecked` が2以上であれば、シングルとマルチの両方を検証できています。

## 7. 実行後に共有するもの

次の2つをこの作業タスクに貼り付けてください。

1. PowerShellの最後の出力（成功メッセージと取り込み結果を含む範囲）
2. 表示された `windows-copilot-e2e.json` の内容

`captured logs` フォルダにはプロンプトやファイル内容が含まれる可能性があるため、フォルダ全体はそのまま共有しないでください。追加調査が必要な場合のみ、共有範囲を確認します。

### AIが返す最終報告の形式

AIは、成功・失敗のどちらでも次の形式で報告してください。「成功した」という結論だけでは不十分です。

```text
【結論】合格 / 不合格 / 事前条件不足で未実行
【環境】Windowsバージョン、VS Code種別・バージョン、Node.jsバージョン
【リポジトリ】ブランチ名、HEADコミット
【自動テスト】npm testの成功数・失敗数・skip数
【E2E】ok、sessionsChecked、parentsChecked、chatOnlyChecked、childrenChecked
【合計値】input、cacheRead、output、AI Credits
【冪等性】2回目のcollect結果
【結果ファイル】windows-copilot-e2e.jsonのパス
【補足】警告、人間の操作が必要だった箇所、未解決事項
```

不合格または未実行の場合は、次に何を確認すればよいかを具体的に書いてください。ログがないのか、サブエージェントが起動しないのか、値の照合が失敗したのかを区別して報告します。

## トラブルシューティング

### `VS Code CLI (code/code-insiders/codium) was not found`

VS Codeを標準の場所にインストールするか、VS Codeのインストーラで `Add to PATH` を有効にします。PowerShellを再起動してから再実行してください。

### `VS Code Copilot log roots were not found`

VS Codeで一度任意のフォルダを開き、Copilot Chatを1回実行してから再試行します。非標準のuser-data-dirを使っている場合は、PowerShellで次を設定してから実行します。

```powershell
$env:AIMET_COPILOT_DIR = 'D:\path\to\User'
npm run test:e2e:copilot-windows
```

### `Timed out waiting for Copilot logs`

次を順番に確認します。

1. VS CodeでGitHub Copilotがサインイン済みか
2. Agent modeと `agent/runSubagent` ツールが利用できるか
3. `github.copilot.chat.agentDebugLog.fileLogging.enabled` が有効か（従来版では `agentDebugLog.enabled` も有効か）
4. VS CodeのChat画面にエラーや確認待ちが出ていないか
5. 次のコマンドで `main.jsonl` と `runSubagent-*.jsonl` が生成されているか

```powershell
Get-ChildItem "$env:APPDATA\Code\User" -Recurse -File |
  Where-Object { $_.Name -eq 'main.jsonl' -or $_.Name -like 'runSubagent-*.jsonl' } |
  Select-Object FullName, Length, LastWriteTime
```

### マルチエージェントだけ失敗する

Copilot Chatのツール一覧で `agent/runSubagent` を明示的に有効にします。組織ポリシーでAgent modeやサブエージェントが禁止されている場合は、GitHub組織の管理者に確認してください。

## Windows版ChatGPT / Codexに実行を任せる場合

Windows PCでこのリポジトリを開いたChatGPT / Codexに、次の指示を送ってください。

```text
あなたはWindows実機上でaimetのCopilot計測を検証する担当者です。
これまでの会話には前提情報がありません。まず docs/windows-copilot-e2e.md を上から最後まで読み、プロジェクトの目的、バグの背景、修正方針、作業範囲、合格条件を理解してください。
理解した作業目的と禁止事項を簡潔に説明した後、同文書の手順に従って事前確認とWindows実機Copilot E2Eを実行してください。
VS CodeとCopilotのサインインなど、人間の操作が必要な場合だけ依頼し、可能な検査と実行は自動で進めてください。
npm run test:e2e:copilot-windows が成功しても、文書の受け入れ条件を個別に確認してください。
成功時はPowerShellの最後の出力とwindows-copilot-e2e.jsonの内容を根拠とし、文書の報告形式で報告してください。
失敗時は勝手に本番DBや合格条件を変更せず、どの事前条件または照合が失敗したかを診断して報告してください。
```
