# aimet — AI Metrics

Claude Code、Codex、GitHub Copilotがローカルに保存するセッションログから、作業時間・トークン量・コスト指標を収集するCLIです。組織の管理APIやクラウドの会話履歴は使いません。

- Node.js 22.5以上、実行時依存パッケージなし
- SQLite DBは既定で`~/.aimet/metrics.db`
- 同じログの再収集は追加ではなく更新となる冪等設計
- 親・サブエージェントを別セッションとして保存し、1回だけ合算
- 未計測の`-` / `n/a`と実測ゼロの`0`を区別

## 対応範囲

| ツール | 主な収集元 | トークン | コスト |
|---|---|---|---|
| Claude Code | `<CLAUDE_CONFIG_DIR>/projects/**/*.jsonl` | in / out / cacheR / cacheW | API換算USD |
| Codex（CLI・IDE拡張・デスクトップのローカルCodex） | `<CODEX_HOME>/sessions/**/rollout-*.jsonl` | in / out / cacheR / reasoning | API換算USD |
| GitHub Copilot Chat / agent mode | VS Codeの`chatSessions` / `debug-logs` | in / out / cacheR | 実測AI Credits優先 |
| GitHub Copilot CLI | `<COPILOT_HOME>/session-state/*/events.jsonl` | outのみ | 算出不可 |

Claude、Codex、Copilot Chatのサブエージェントも対応します。以下の「ツール別の収集仕様」に、判定方法と公式情報をまとめています。

## インストール

```console
npm install -g @mayo32/aimet
aimet --version
aimet --help
```

開発用にリポジトリから実行する場合：

```console
npm install
npm run build
npm test
npm link
```

## クイックスタート

```console
# 収集済みDBを更新
aimet collect

# 日次・ツール別レポート
aimet report --by tool

# 最新セッションとサブエージェントの合計
aimet session --tool codex

# 期間・プロジェクト別
aimet report --period weekly --by project --since 30
```

`aimet collect`は現在のOSと環境変数から各ツールの保存先を自動探索します。調査時は`--tool`と`--dir`で対象を固定できます。

## コマンド

### `aimet --version`

インストール済みパッケージのバージョンを表示します。

### `aimet collect`

```console
aimet collect [--tool claude|codex|copilot|copilot-cli] [--since <days>] [--dir <path>]
```

- `--tool`：対象を1ツに限定
- `--since`：更新時刻が直近N日のログに限定
- `--dir`：自動探索を使わず指定ディレクトリを再帰探索

### `aimet report`

```console
aimet report [--period daily|weekly|monthly] [--by tool|project|model]
             [--tool <tool>] [--since <days>]
             [--start <YYYYMMDDhhmmss>] [--end <YYYYMMDDhhmmss>]
             [--json] [--md <file>]
```

`--start` / `--end`は実行環境のローカル時刻です。`20260801`のような短い指定は、開始ではその単位の先頭、終了では末尾に補完します。

### `aimet session`

```console
aimet session [--tool <tool>] [--id <session-id-prefix>] [--md <file>]
```

最新または指定セッションの要約を表示します。親セッションに子がある場合は、子ごとの値とグループ合計も表示します。

### `aimet detail`

```console
aimet detail [--tool <tool>] [--id <session-id-prefix>]
aimet detail --tool <tool> --file <log.jsonl> [--raw] [--md <file>]
```

ログからリクエスト、モデル、usage、レート制限時系列などの構造化データを出力します。これはログ全体の無加工ダンプではありません。

`--raw`は対応するエントリに元レコードを付加します。システムプロンプト、ツール定義、パス、会話断片などが含まれ得るため、issueや外部AIへそのまま貼り付けないでください。`--file`使用時は形式を正しく判定するため`--tool`が必須です。

### `aimet hook`

```console
aimet hook <tool>
```

Claude Code、Codex、Copilotのhookから呼ぶ内部エントリポイントです。stdinの`transcript_path`や`agent_transcript_path`などを優先し、利用できない場合は直近2日を差分スキャンします。DBやログの一時エラーでホストのエージェントを失敗させないよう、hookは常に終了コード0を返します。

### `aimet init`

```console
aimet init claude|codex|copilot [--dry-run]
```

| 対象 | 設定するhook | 導入する呼び出し方 |
|---|---|---|
| Claude Code | `SessionEnd` + `SubagentStop` | `~/.claude/commands/metrics.md`の`/metrics` |
| Codex | `SessionEnd` + `SubagentStop` | `$aimet-metrics` Skill |
| Copilot | `Stop` + `SubagentStop` | VS Codeの`metrics.prompt.md` |

既存JSONは読み込んでaimetのエントリだけを追加し、書き込み前に`.bak`を作成、一時ファイルから原子的に置換します。不正なJSONは上書きせずエラーにします。再実行してもhookを重複登録しません。旧版aimetがCodexに書いた直下形式のhookは現行の公式ネスト形式へ移行します。

`--dry-run`で保存先と書き込み予定を確認してから実行できます。

## ツール別の収集仕様

### Claude Code

#### 保存先と環境変数

Claude Codeの状態ルートは`CLAUDE_CONFIG_DIR`、未設定では`~/.claude`です。Windowsの`~`は通常`%USERPROFILE%`です。aimetは次を読みます。

```text
${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<project-key>/
  <session-id>.jsonl
  <session-id>/subagents/agent-<agent-id>.jsonl
```

`CLAUDE_CONFIG_DIR`は`~/.claude`下のパス全体を移します。`CLAUDE_CODE_SKIP_PROMPT_HISTORY`や`--no-session-persistence`によりトランスクリプトが保存されないセッションは収集できません。

#### サブエージェントと重複排除

- 親はログ内の`sessionId`、子は公式パスの親IDと`agent-<agent-id>`で識別します。
- aimet DB上の子IDは`<parent-session-id>/agent-<agent-id>`で、`parent_session_id`に親IDを保存します。
- 親と子は別トランスクリプトの自分のusageだけを持つ`own`スコープです。
- 同じ`assistant.message`が再送やストリーミングで複数行に現れる場合は`message.id`で重複排除します。
- `SessionEnd`は親、`SubagentStop`は`agent_transcript_path`で子を速やかに取り込みます。取りこぼしは後の`collect`で回収できます。

サブエージェントのトランスクリプトは`cleanupPeriodDays`（既定30日）で削除され得ます。削除後の初回収集では復元できないため、定期収集またはhookの導入を推奨します。

公式情報：

- [Claude Code directoryの保存先・Windowsパス・`CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/claude-directory)
- [Subagentsの保存先と保持期間](https://code.claude.com/docs/en/sub-agents)
- [Hooksの`SessionEnd` / `SubagentStop`入力](https://code.claude.com/docs/en/hooks)
- [Agent SDK SessionStoreの親子キー](https://code.claude.com/docs/en/agent-sdk/session-storage)

### Codex

#### 対応するクライアントと保存先

aimetはプロセス名ではなく、`CODEX_HOME`（未設定では`~/.codex`）のローカルrolloutを収集します。

```text
${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-*.jsonl
```

このため、同じローカルCodex基盤がrolloutを保存する次の実行を対象にできます。

- Codex CLIの通常セッション
- Codex IDE拡張のローカルセッション
- ChatGPTデスクトップアプリの「Codex」でフォルダを開いて実行し、ローカルrolloutが作られたタスク
- それらから起動し、別rolloutを持つサブエージェント

通常のChatGPT / Workの会話、Web・モバイルだけの会話、ローカルにrolloutがないCodex cloud実行、`--ephemeral`実行は収集できません。クラウドタスクをローカルで再開した場合も、取得できるのはrolloutに実際に記録された範囲です。

`config.toml`の`log_dir`はTUIの診断テキストログ用で、`sessions/`のrollout保存先を移す設定ではありません。`CODEX_HOME`を変えた場合はCodexとaimetの両プロセスから同じ値が見える必要があります。GUIアプリはシェルの起動設定を自動で読まないことがあるため、環境変数変更後はアプリとターミナルを再起動してください。

#### サブエージェントとhook

- サブエージェントは親と別のrolloutと独立したトークン台帳を持ちます。
- 現在対応するrolloutでは`session_meta.payload.thread_source === "subagent"`を子の判定に使い、`payload.id`を子自身のID、`payload.session_id`を親IDとして使います。
- 親と子は`own`スコープとして1回ずつ合算します。Codexのサブエージェントが個別にトークンを消費することは公式説明とも一致します。
- `aimet init codex`は公式のネスト形式で`SessionEnd`と`SubagentStop`を`<CODEX_HOME>/hooks.json`へ追加します。`SessionEnd`は主エージェントだけで発火するため、子は`SubagentStop`で補います。
- Codexの`SessionEnd`は助言的なhookで、タイムアウトの公式上限3秒を設定します。

`aimet init codex`は現行のCodex Skill配置`<CODEX_HOME>/skills/aimet-metrics/SKILL.md`も導入します。旧版aimetの`prompts/metrics.md`があっても、ユーザーが編集した可能性があるため自動削除しません。

公式情報：

- [Codexの`CODEX_HOME`と保存ディレクトリ](https://learn.chatgpt.com/docs/config-file/environment-variables)
- [Codex設定リファレンス（`hooks`・`log_dir`）](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex Hooks（スキーマ、イベント、タイムアウト）](https://learn.chatgpt.com/docs/hooks)
- [Codex subagentsの独立トークン消費](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Codex Skills](https://learn.chatgpt.com/docs/build-skills)
- [ChatGPTデスクトップのCodex](https://learn.chatgpt.com/docs/app)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI公式ソースのrolloutレコーダ](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs)

### GitHub Copilot Chat / agent mode

#### VS Codeの保存先

Copilot Chatは、Chatスナップショットとagent debug logに異なる情報を保存します。aimetはStable、Insiders、VSCodiumについて、新旧の保存先を両方探索します。

```text
<VS Code User>/workspaceStorage/<workspace-hash>/chatSessions/*.jsonl
<VS Code User>/workspaceStorage/<workspace-hash>/GitHub.copilot-chat/debug-logs/<session-id>/*.jsonl  # 旧
<VS Code User>/globalStorage/github.copilot-chat/debug-logs/<session-id>/*.jsonl                 # 現行
<VS Code User>/globalStorage/github.copilot-chat/session-store.db                               # project特定のみ
```

OSごとの既定`<VS Code User>`：

| OS | 既定位置の例 |
|---|---|
| Windows | `%APPDATA%\Code\User` |
| macOS | `~/Library/Application Support/Code/User` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/Code/User` |

`VSCODE_PORTABLE`は`<value>/user-data/User`、`VSCODE_APPDATA`はカスタムルートとして既定値より優先します。Windowsはプロファイルリダイレクトに対応するため`APPDATA`を優先します。それ以外の保存先は`--dir`または`AIMET_COPILOT_DIR`で追加できます。複数パスはWindowsで`;`、macOS / Linuxで`:`区切りです。

#### debug logの生成仕様

VS Codeの公式設定で次の2項目は既定`false`です。トークンと親子別AI Creditsを最も詳しく取るには両方を有効にします。

```json
{
  "github.copilot.chat.agentDebugLog.enabled": true,
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true
}
```

現行の公式Copilot Chatソースでは、親エージェントの`main.jsonl`、モデル情報の`models.json`、システムプロンプト、ツール定義、`runSubagent-*`、`searchSubagent-*`、UI内部用のタイトル・分類・要約ログなどが作られます。aimetは無関係なJSONLを数えず、`main.jsonl`と、その`child_session_ref`が参照する子JSONLを読みます。互換性のため、参照元が欠けた古い保存物でも`runSubagent-*` / `searchSubagent-*`は認識します。

#### 親子集計と同一セッションの選択

- `main.jsonl`は親自身、各子JSONLは子自身のLLMスパンだけを持つ`own`スコープです。
- 同じ`spanId`は1回だけ数えます。
- 同じ親IDにChatスナップショットと`main.jsonl`がある場合、数値は情報量の多い`main.jsonl`だけを採用します。低優先度のChatスナップショットからは、正確なproject情報のみを補完できます。
- 過去形式の親が子込み累計の`tree`スコープである場合は、レポートで子を再加算しません。
- projectは同一IDの`session-store.db`の`cwd`を優先し、旧`workspaceStorage`では`workspace.json`を使います。プロンプト中のパスらしき文字列は安全なproject識別根拠にしません。

#### Copilot hook

VS Codeのagent hookはPreview機能で、ユーザーhookは`~/.copilot/hooks/*.json`です。`Stop`は会話ファイルの永続的な「セッション終了」ではなく、現在のagent実行・ターンが止まったイベントです。`SubagentStop`は子の停止で発火します。

`aimet init copilot`はVS Code用の既定`~/.copilot/hooks/aimet.json`へ両方を登録します。`COPILOT_HOME`が別の値なら、Copilot CLIも読めるよう`<COPILOT_HOME>/hooks/aimet.json`にも同じhookを登録します。同じhookディレクトリをVS CodeとCopilot CLIが読み得るため、`aimet hook copilot`のフォールバックはChatとCLIの直近ログを両方探索します。

公式情報：

- [VS Code AI settings（debug log設定と既定値）](https://code.visualstudio.com/docs/agents/reference/ai-settings)
- [Chat Debug viewとfile logging](https://code.visualstudio.com/docs/agents/agent-troubleshooting/chat-debug-view)
- [Copilot Chat公式ソースのdebug logファイル仕様](https://github.com/microsoft/vscode-copilot-chat/blob/main/assets/prompts/skills/troubleshoot/SKILL.md)
- [VS Code subagents](https://code.visualstudio.com/docs/agents/run/subagents)
- [VS Code agent hooksの設定場所](https://code.visualstudio.com/docs/agent-customization/hooks)
- [VS Code hooks reference（`Stop`・`SubagentStop`）](https://code.visualstudio.com/docs/agents/reference/hooks-reference)
- [VS Code公式ソースのuser-data-path解決](https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/node/userDataPath.ts)
- [VS Code CLIの`--user-data-dir`](https://code.visualstudio.com/docs/configure/command-line#_advanced-cli-options)
- [VS Code Portable Mode](https://code.visualstudio.com/docs/setup/portable)

### GitHub Copilot CLI

Copilot CLIは`COPILOT_HOME`（未設定では`~/.copilot`）下の次のログを読みます。

```text
${COPILOT_HOME:-~/.copilot}/session-state/<session-id>/events.jsonl
```

`events.jsonl`にはセッション、モデル変更、ターン、ツール実行などが記録されます。現在aimetが確認している形式では`assistant.message.data.outputTokens`はありますが、入力・キャッシュトークンはありません。そのため`out`だけを実測値とし、`in` / `cacheR` / `cacheW`とコストは`-`にします。出力だけでAPIコストを計算すると大幅な過小評価になるためです。

Copilot CLIのhookは既定`~/.copilot/hooks`、`COPILOT_HOME`設定時は`<COPILOT_HOME>/hooks`で、JSONに`"version": 1`が必要です。`aimet init copilot`がこれを導入します。

公式情報：

- [Copilot CLI configuration directory（`COPILOT_HOME`・session state）](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)
- [Copilot CLI hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference)
- [Copilot CLI chronicle / local sessions](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/chronicle)
- [Copilot CLI command reference（セッション中のモデル変更）](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference)

## 集計値の意味

### `in` / `out` / `cacheR` / `cacheW`

- `in`：非キャッシュ入力。Codexの`input_tokens`はキャッシュ分を含むため、`cached_input_tokens`を差し引いて保存します。
- `out`：モデルの出力。Codexの`reasoning_output_tokens`は`out`の内数なのでコストで再加算しません。
- `cacheR`：プロンプトキャッシュから読んだ入力。
- `cacheW`：キャッシュに書いた入力。Claudeは5分 / 1時間TTLの内訳をコスト計算に反映します。OpenAI系には独立したキャッシュ書込課金がないため、未記録でも課金項目の欠落ではありません。

`-`または`n/a`は「ログに記録されず不明」、`0`は「記録された値がゼロ」です。期間集計や親子合計で、対象行に不明値が1つでもある列は、既知分のみを完全な合計として表示せず`-` / `n/a`にします。

### 時間

- `wall`：最初と最後のログ時刻の差
- `active`：イベント間の差が5分以内の部分だけを合計した参考工数

PCが起動していた時間や人間が実際に操作した時間を直接測った値ではありません。

## コスト計算

> コストは参考値です。実際の実行環境、契約、請求明細に合わせて利用してください。

### 表示の3段階

1. 課金項目を実測できるものはAPI換算値、実消費額を持つCopilotは`actual`として表示します。
2. モデルやキャッシュ内訳に推定がある値は`*`、`estimated`、または`mixed`を付けます。
3. 主要な課金項目が不明な場合は`-` / `n/a`にし、ゼロとして合計しません。

全課金対象トークンが厳密に実測`0`の場合だけは、未知モデルでも数学的に正確な`$0`とします。`null`（未記録）はこの判定に使いません。

### API換算式

```text
cost = (in × input単価
      + out × output単価
      + cacheR × cache-read単価
      + cacheW × cache-write単価) / 1,000,000
```

| ツール | 計算方法 |
|---|---|
| Claude Code | `assistant.message.usage`を`message.id`で重複排除。5分 / 1時間cache write単価も反映したAPI換算 |
| Codex | 累積`token_count`の最大値を使い、cached inputを分離したAPI換算 |
| Copilot Chat | リクエスト単位の`copilotUsageNanoAiu` / `aiu` / `copilotCredits`を優先。欠損リクエストのみモデル単価で推定 |
| Copilot CLI | 入力トークン不明のため算出しない |

Copilotは1 AI Credit = $0.01として表示します。`actual`はログの実消費、`estimated`はAPI換算、`mixed`はその混在です。

GitHub公式情報：

- [AI Creditsの使用量監視](https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-ai-usage)
- [Copilot CLIのAI Creditsセッション上限（1 credit = $0.01）](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/set-session-limit)

### 単価表と`~/.aimet/pricing.json`

内蔵単価表は`src/pricing.ts`にあり、モデル名のプレフィックス最長一致で選びます。単価は変わるため、重要な集計前に[Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)と[OpenAI API Pricing](https://openai.com/api/pricing/)を照合してください。

`~/.aimet/pricing.json`は配布パッケージに同梱しません。必要な利用者が作成する任意の上書きファイルで、実行時に内蔵表へマージされます。

```json
{
  "gpt-5.5": [1.75, 14.0, 0.175, 0]
}
```

配列は`[input, output, cacheRead, cacheWrite]`の順で、1MトークンあたりUSDです。4個の有限非負数以外のエントリは警告して無視します。不正JSONでも内蔵表は維持します。

バッチ割引、優先スループット、Web検索等のサーバーツール料金、定額契約の実際の請求はAPI換算値に含まれません。

## 重要な制約：セッション中のモデル変更

v2.0.0ではDBの1セッション行にモデル名を1つだけ保存します。ログ中でモデルが変わると、原則として最後に検出したモデルにセッション全体を帰属させます。

- 合計トークン量はログのusageから取るため、通常はモデル変更で失われません。
- `report --by model`はセッション全体が1モデルに帰属するため正確ではありません。
- Claude / CodexのAPI換算コストは、複数モデル分のusageを1つの単価で計算するため正確ではありません。
- Copilotの実測AI Creditsはリクエスト単位で足すため合計は維持できますが、モデル別帰属は正確ではありません。

厳密なモデル別値が必要な作業では、モデル変更前にセッションを分けてください。リクエスト単位のモデル別台帳は将来対応です。

## 環境変数

| 変数 | 用途 |
|---|---|
| `AIMET_DB` | aimetのSQLite DBを変更 |
| `CLAUDE_CONFIG_DIR` | Claude Codeの状態ルート |
| `CODEX_HOME` | Codexの状態ルート |
| `COPILOT_HOME` | Copilot CLIの状態ルート |
| `AIMET_COPILOT_DIR` | aimetのCopilot Chat探索先を追加 |
| `VSCODE_PORTABLE` | VS Code Portableのuser-dataルート |
| `VSCODE_APPDATA` | VS Code user-dataのカスタムルート |
| `APPDATA` | WindowsのVS Code user-data既定ルート |
| `XDG_CONFIG_HOME` | LinuxのVS Code user-data既定ルート |

相対パスの`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`COPILOT_HOME`、`VSCODE_PORTABLE`、`VSCODE_APPDATA`はaimet実行時の作業ディレクトリから解決します。予期しない差を防ぐには絶対パスを推奨します。

## examples

`examples/`は個人情報を含まない固定fixtureから生成した出力です。npmパッケージにも含まれ、テストで現在の出力との差を検出します。

- [`report.md`](examples/report.md)：期間集計
- [`session-claude.md`](examples/session-claude.md) / [`session-codex.md`](examples/session-codex.md) / [`session-copilot.md`](examples/session-copilot.md)：セッションと親子合計
- [`detail-claude.md`](examples/detail-claude.md) / [`detail-codex.md`](examples/detail-codex.md) / [`detail-copilot.md`](examples/detail-copilot.md) / [`detail-copilot-subagent.md`](examples/detail-copilot-subagent.md) / [`detail-copilotcli.md`](examples/detail-copilotcli.md)：ツール別の構造化詳細

## テスト

```console
npm test
npm run test:e2e:copilot-windows
```

自動テストは、各パーサ、不正JSONL、冪等更新、親子の一意性、`own` / `tree`ロールアップ、Copilotの同一親ログ選択、Windowsパス、環境変数、hookのフェイルセーフ、不完全合計の`n/a`を検証します。Windows E2Eは実機のVS Code / Copilotが生成したログを収集し、シングル・マルチエージェントの件数とトークンを確認するためのものです。

各製品のJSONLは外部向けの安定APIではなく、製品更新で形式が変わる可能性があります。バージョン更新後はfixtureテストだけでなく、シングル・マルチエージェントの実ログでも総トークンと親子関係を再確認してください。

## License

MIT
