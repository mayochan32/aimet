# aimet — AI Metrics

**Claude Code / Codex / GitHub Copilot のローカルセッションログから、AIエージェント開発にかかった時間・トークン数・API換算コストを採取するメトリクスツール。**

チームの管理API（組織機能）を使わず、各ツールが手元に残すセッションログとローカル索引だけを情報源にします。計測値はJSONLから取得し、現行Copilotのプロジェクト特定に限ってローカルの`session-store.db`も参照します。採取したデータはプロジェクトマネジメントの数値データ（工数見積もり、案件別コスト配賦、モデル選定の判断材料など）として利用できます。

- 依存パッケージゼロ（Node.js 22.5+ の `node:sqlite` を使用）
- データは `~/.aimet/metrics.db` （SQLite）に蓄積
- 冪等設計：何度実行しても二重計上しない

## 対応状況

| ツール | ログの場所 | 取得できるトークン | 状態 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | 実測（in / out / cacheR / cacheW、1h/5mキャッシュ内訳） | ✅ |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | 実測（in / cached / out / reasoning）＋レート制限時系列 | ✅ |
| GitHub Copilot (VS Code Chat) | `workspaceStorage/<hash>/chatSessions/*.jsonl` + `workspaceStorage`（旧）または `globalStorage`（現行）の `debug-logs/<uuid>/main.jsonl` | 実測（in / cached / out）＋消費AI Credits | ✅ |
| GitHub Copilot サブエージェント | `workspaceStorage/<hash>/GitHub.copilot-chat`（旧）または `globalStorage/github.copilot-chat`（現行）の `debug-logs/<親uuid>/*Subagent-*.jsonl` | 実測（in / cached / out / AI Credits、リクエスト単位） | ✅ |
| GitHub Copilot CLI | `~/.copilot/session-state/<uuid>/events.jsonl` | 実測（**出力トークンのみ**） | ✅ |

> Copilot Chat（VS Code）のスナップショットは `User/workspaceStorage/`、デバッグログは従来版では同じ `workspaceStorage` 配下、現行版では `User/globalStorage/github.copilot-chat/` にあります。aimetはStable / Insiders / VSCodiumの新旧両方を自動探索します。非標準パスは `--dir` または `AIMET_COPILOT_DIR`（Windowsは `;`区切り、macOS/Linuxは `:`区切り）で指定できます。記録されるのは**Chat/エージェントモードの対話のみ**です。
>
> **Copilot CLI（`@github/copilot`）の注意**: レポート上は `copilot`（Chat版）と区別するため **`copilot-cli`** という別ツールとして集計します。CLIのログは**出力トークンしか記録しない**（入力・キャッシュのフィールドが存在しない）ため、`in` / `cacheR` / `cacheW` は **`-`（null）**、コストも **`-`（null）** になります。取得できるのは出力トークン・実行時間・ターン数・モデル・プロジェクトです。

### Copilot Chatログの探索と集計

VS Code Copilot Chatのローカルログは、VS Code／Copilot Chatのバージョンによって1か所ではなく、複数の場所に分かれて保存されます。さらに、同じ親セッションについて情報量の異なるログが複数存在する場合があります。aimetは保存場所ごとの数値を単純合算せず、次の探索・選択・親子集計規則を使います。

#### ログの種類と保存場所

| ログ | 主な保存場所 | 内容 | aimetでの扱い |
|---|---|---|---|
| Chatスナップショット | `User/workspaceStorage/<workspace-hash>/chatSessions/<session-id>.jsonl` | VS CodeのObjectMutationLog。Chat画面のセッションとリクエスト情報 | 対応。より詳細な同一IDの`main.jsonl`がなければ採用 |
| 親のデバッグログ（従来版） | `User/workspaceStorage/<workspace-hash>/GitHub.copilot-chat/debug-logs/<parent-id>/main.jsonl` | 親自身のLLM呼び出しを記録したスパントレース | Chatスナップショットより優先 |
| 子のデバッグログ（従来版） | 同じ`debug-logs/<parent-id>/runSubagent-*.jsonl` | 通常／カスタムサブエージェント自身のLLM呼び出し | 独立した子セッションとして保存 |
| 親のデバッグログ（現行版） | `User/globalStorage/github.copilot-chat/debug-logs/<parent-id>/main.jsonl` | 親自身のLLM呼び出しを記録したスパントレース | Chatスナップショットより優先 |
| 子のデバッグログ（現行版） | 同じ`debug-logs/<parent-id>/runSubagent-*.jsonl`または`searchSubagent-*.jsonl` | 通常／カスタム／検索サブエージェント自身のLLM呼び出し | 親の`child_session_ref`で確認して独立した子セッションとして保存 |
| 現行版のセッション索引 | `User/globalStorage/github.copilot-chat/session-store.db` | `sessions.id`と`cwd`などのセッションメタデータ | トークン集計には使わず、プロジェクト特定だけに使用 |

現行版では、サブエージェントを使わないシングルエージェントにも`main.jsonl`が生成されることがあります。その場合もChatスナップショット扱いには戻さず、実際のLLM呼び出しとAI Creditsを持つ`main.jsonl`を使用します。

> [!IMPORTANT]
> **Copilot公式デバッグログ仕様とaimetの判定規則**
>
> Microsoftの現行VS Codeソースは、デバッグログの構成を[Copilot troubleshoot skillのData Source節](https://github.com/microsoft/vscode/blob/main/extensions/copilot/assets/prompts/skills/troubleshoot/SKILL.md#data-source)で説明しています。これはCopilot自身がトラブルシュートに使う公式資料です。
>
> ```text
> debug-logs/<parent-session-id>/
>   main.jsonl
>   models.json
>   system_prompt_<n>.json
>   tools_<n>.json
>   runSubagent-<agent-name>-<child-id>.jsonl
>   searchSubagent-<child-id>.jsonl
>   title-<id>.jsonl
>   categorization-<id>.jsonl
>   summarize-<id>.jsonl
> ```
>
> `main.jsonl`は親セッションの会話フローと親自身のLLM呼び出しを持ちます。通常／カスタムサブエージェントは`runSubagent-*`、検索専用サブエージェントは`searchSubagent-*`へ、自分自身のLLM呼び出しを記録します。ファイル名の違いはOS差ではなくサブエージェント種別の違いです。
>
> 親は子を起動するたびに`type = child_session_ref`の行を書き、`attrs.childSessionId`へ子ID、`attrs.childLogFile`へ正確な子ファイル名を保存します。aimetはこの参照を親子対応の正式な根拠として採用します。これにより、将来新しいサブエージェント種別とファイル名が追加されても、親が明示的に参照した子を集計できます。古いログや一部だけコピーされたログでは参照がないことがあるため、公式に記載された`runSubagent-*`と`searchSubagent-*`も互換フォールバックとして認識します。
>
> `title-*`、`categorization-*`、`summarize-*`はUI用の題名生成・分類・要約であり、作業セッションやサブエージェントではないため集計しません。`models.json`、`system_prompt_*`、`tools_*`もメタデータ／参照資料であり、メトリクス行にはなりません。子として取り込むJSONLは、親から参照され、かつ自身の`session_start.attrs.parentSessionId`と1件以上の`llm_request`を持つものに限定します。
>
> なお、これはMicrosoftが現在説明しているデバッグ形式ですが、外部向けの安定APIではありません。VS Code／Copilot更新後はE2Eで形式を再確認し、固定ファイル名ではなく`child_session_ref`を優先することで変更に追随します。

#### OS・VS Code製品ごとの自動探索

`aimet collect`を`--dir`なしで実行すると、まず次のVS Code Userディレクトリを組み立てます。

| OS | Userディレクトリの基点 |
|---|---|
| Windows | `%APPDATA%\<product>\User`（`APPDATA`がなければユーザーホームの`AppData\Roaming`） |
| macOS | `~/Library/Application Support/<product>/User` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/<product>/User` |

`<product>`は`Code`、`Code - Insiders`、`VSCodium`の3種類です。それぞれについて次の2ルートを**両方**、再帰的に探索します。

```text
User/workspaceStorage
User/globalStorage/github.copilot-chat
```

このため、従来版と現行版のログが同じPCに残っていても、利用者がVS Codeのバージョンを指定する必要はありません。アクセスできない、または存在しないディレクトリは読み飛ばします。

非標準のuser-data-dirを使う場合は、`AIMET_COPILOT_DIR`で探索ルートを**追加**できます。複数指定も可能です。

```powershell
# Windows: セミコロン区切り
$env:AIMET_COPILOT_DIR = 'D:\VSCodeData\User;E:\VSCodiumData\User'
aimet collect --tool copilot
```

```bash
# macOS / Linux: コロン区切り
export AIMET_COPILOT_DIR='/path/to/code/User:/path/to/codium/User'
aimet collect --tool copilot
```

`--dir <path>`を指定した場合は、その実行に限って自動探索ルートを置き換え、指定ディレクトリだけを探索します。調査用にログを隔離したフォルダや、E2Eで採取したログだけを読みたい場合に使用します。

#### 同じセッションを二重計上しない仕組み

取り込み単位の主キーは`(tool, session_id)`です。Copilot Chatでは同じ親IDのChatスナップショットと`main.jsonl`が見つかる可能性があるため、次の順で情報源を選択します。

```text
main.jsonl / 親がchild_session_refで参照する子JSONL（詳細なスパントレース）
  > chatSessions/*.jsonl（タスクレベルのスナップショット）
  > その他
```

- 同じ親IDのChatスナップショットと`main.jsonl`は足しません。DBには情報量の多い`main.jsonl`由来の親1行だけを残します。
- 親が`child_session_ref`で参照する子JSONLは、子自身のIDで別行にし、`parent_session_id`で親へリンクします。
- 現行の親・子ログは、各セッションが自分自身のLLM呼び出しだけを持つため`metric_scope = own`です。親子合計では親1回＋各子1回だけを加算します。
- 過去形式で親が子を含む累計値を持つ場合は`metric_scope = tree`とし、子を親子合計へ再加算しません。
- 各LLMリクエストの`copilotUsageNanoAiu`または`aiu`があれば、実測AI Creditsとして`cost_source = actual`で保存します。欠損したリクエストだけモデル単価によるAPI換算へフォールバックします。
- 同じファイルや同じセッションを再度取り込んでも、最終イベント時刻と情報源の優先順位を比較して`skipped`にします。2回目の`collect`でDB行や合計が増えることはありません。

つまり、複数の保存先を探索することは「すべての数値を合算する」という意味ではありません。複数候補からセッションごとに最も正確な情報源を選び、その後で親子関係に従って各セッションを1回だけ集計します。

#### デバッグファイルロギングの設定

現行版では次を有効にし、VS Codeのウィンドウを再読み込みまたは再起動します。

```json
{
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true
}
```

従来版で`github.copilot.chat.agentDebugLog.enabled`も設定画面に表示される場合は、互換性のため両方を有効にします。現行版では旧設定は非推奨で、`fileLogging.enabled`へ統合されています。詳細は[Microsoft公式Copilot設定定義](https://github.com/microsoft/vscode/blob/main/extensions/copilot/package.nls.json)を参照してください。

デバッグログが生成されない場合、Chatスナップショットから取得できる範囲は集計できますが、親内部の全LLM呼び出しやサブエージェントの正確なトークン・AI Creditsは復元できません。

#### `globalStorage`ログのプロジェクト特定

現行版の`main.jsonl`とサブエージェントJSONLは全ワークスペース共通の`globalStorage`に置かれ、ログ自身の`session_start`にworkspaceパスが含まれない場合があります。aimetは収集コマンドを実行したカレントディレクトリや、最後に開いていたVS Codeウィンドウをプロジェクトとして採用しません。それらは対象セッションと無関係な可能性があり、誤った案件へコストを配賦するためです。

代わりに、次の優先順位でセッションごとにプロジェクトを決定します。

| 優先順位 | 情報源 | 判定方法 |
|---:|---|---|
| 1 | 現行版の`session-store.db` | デバッグログの`session_start.sid`と`sessions.id`を完全一致させ、同じ行の空でない`cwd`を採用 |
| 2 | ログの近くの`workspace.json` | 従来の`workspaceStorage/<hash>`配下なら`folder`または`workspace`の`file://` URIを復号して採用 |
| 3 | ログ中のファイル参照＋登録済みworkspace | 同じVS Code Userディレクトリの`workspaceStorage/*/workspace.json`を列挙し、構造化ログ中の絶対パスが登録済みworkspace **1つだけ**に属する場合に採用 |
| 4 | 同じセッションIDの別ログ | `chatSessions`が持つ既知のプロジェクトを、数値の正確な`main.jsonl`行へメタデータとして引き継ぐ |
| 5 | 親セッション | サブエージェント自身で決まらない場合、`parent_session_id`が指す親の既知プロジェクトを継承 |
| 6 | 特定不能 | 上記の確実な対応がなければ`unknown`のまま保存 |

`session-store.db`では`SELECT id, cwd FROM sessions`相当のメタデータだけを読み取り、`turns`などの会話本文はプロジェクト特定に使用しません。DBは読み取り専用で開き、VS CodeがWALへ新しい情報を書いた場合はキャッシュを更新します。SQLiteファイルがない旧バージョン、スキーマが異なるバージョン、または一時的に読めない状態でも収集全体は失敗させず、次の判定方法へ進みます。

ファイル参照からの補完でも、添付ファイル群の共通親ディレクトリを新しいプロジェクトとして推測することはありません。既に`workspace.json`へ登録されているworkspaceとの一致だけを使い、複数workspaceが同時に一致して曖昧な場合は採用しません。`userRequest`、プロンプト、メッセージ本文などの自由記述は判定対象外で、構造化されたファイル／URI／ツール引数だけを使用します。文章中で別プロジェクトのパスを言及しただけのセッションを誤配賦しないためです。

同じ親IDについて`chatSessions`と`main.jsonl`の両方がある場合、トークンとAI Creditsは引き続き`main.jsonl`だけを採用します。`chatSessions`から引き継ぐのは不足しているプロジェクト情報だけであり、数値を足したり`main.jsonl`を置き換えたりしません。DBには内部的に`project_source`も保存し、`unknown`、親継承、構造化参照、`workspace.json`、`session-store.db`の順で根拠を評価します。再収集時により確実な根拠が見つかれば、イベント時刻が同じでもプロジェクト情報だけを更新し、トークンとAI Creditsは変更しません。子が親より先に走査された場合も、親の取り込み後に`unknown`または親継承の子を補完します。

それでも、VS Codeでフォルダーを開かずに作成した空ウィンドウのセッションなど、Copilot自身が`cwd`を記録せず登録済みworkspaceとの対応もない場合は`project = unknown`が正しい結果です。今回のWindows E2Eで使う`code chat -n`も空ウィンドウを明示するため、このケースに該当します。これはinput／cacheRead／output／AI Creditsや親子集計の正確性には影響しませんが、`aimet report --by project`では`unknown`へまとめられます。

この実装が参照する仕様・実装情報は次のとおりです。

- [VS Code公式ソース: Copilotセッション検索（ローカルSQLiteの`sessions`、`session_files`など）](https://github.com/microsoft/vscode/blob/main/extensions/copilot/assets/prompts/skills/chronicle/SKILL.md)
- [VS Code公式ソース: 同梱Copilot拡張の`package.json`](https://github.com/microsoft/vscode/blob/main/extensions/copilot/package.json)
- [Node.js公式: `node:sqlite` / `DatabaseSync`](https://nodejs.org/api/sqlite.html)

### マルチエージェント（サブエージェント）の扱い

Copilotの親エージェントが子を起動した場合、親の全LLM呼び出しは`main.jsonl`、通常／カスタムの子は`runSubagent-*`、検索専用の子は`searchSubagent-*`へ**スパントレース形式**で保存されます。親の`child_session_ref.attrs.childLogFile`が正確な子ファイル名を示します。`chatSessions`の親リクエストは内部の複数LLM呼び出しのトークンを網羅しないため、`main.jsonl`を優先します。

aimetは両方を取り込みます：

- 子セッションは `copilot` ツールの**独立した行**としてDBに入り、`parent_session_id` で親に紐づきます（レポートの合計にも自然に含まれます）
- `aimet session --id <親ID>` を実行すると、親の値に加えて **`subagents:` 行（子の合算）と `TOTAL(parent + N subagents):`** が表示されます
- 二重計上の防止: 同じ親IDの `main.jsonl` と `chatSessions` がある場合、情報量の多い `main.jsonl` を常に優先し、DBには1行だけ保存します
- 親と子はどちらも自分自身の呼び出し（`own`）だけを保持し、親子合計では各1回だけ加算します
- `copilotUsageNanoAiu` / `aiu` がある親・子は**実測AI Credits**を使用し、欠損したリクエストだけAPI単価で推定します

> **前提条件**: debug-logs は Copilot Chat のデバッグファイルロギングが有効な場合にのみ書き出されます。現行版では `github.copilot.chat.agentDebugLog.fileLogging.enabled` を有効にします。従来版で`github.copilot.chat.agentDebugLog.enabled`が表示される場合は、互換性のため両方を有効にしてください。ログが出ていない環境では子セッションの消費はディスクから回収できません。Windows PowerShellでは`Get-ChildItem "$env:APPDATA\Code\User" -Recurse -Filter '*.jsonl' | Where-Object { $_.Name -match '^(runSubagent|searchSubagent)-' }`で公式に記載された両形式を確認できます。

## インストール

```bash
git clone https://github.com/mayochan32/aimet.git && cd aimet
npm install && npm run build
npm link        # `aimet` コマンドをグローバルに登録
```

### 開発・テスト

テストは追加依存なしのNode標準ランナー（`node:test`）で書かれています。`npm test` はビルド後に `test/` 配下のfixtureベーステストを実行します（CIはGitHub Actionsで Node 22 / 24 上で走ります）。

```bash
npm test
```

パーサ、DB更新、集計、セキュリティ、macOS/Windowsのパス解決をfixtureベースで自動検証します。さらに、Windows実機でVS Code Copilotのシングル／マルチエージェントを起動し、生ログとDBを独立した検算器で照合するE2Eスクリプトも用意しています（VS CodeへのサインインとCopilotの利用権が必要）。

```powershell
npm run test:e2e:copilot-windows
```

詳細な準備、成功判定、失敗時の確認方法は [Windows実機Copilot E2E手順](docs/windows-copilot-e2e.md) を参照してください。今回の実測値、判明した問題、修正内容、二重計上の検証結果は [Windows Copilot E2E検証・修正レポート](docs/windows-copilot-validation-report.md) にまとめています。

#### 今回のWindows実機検証環境

以下は、このブランチのCopilotログ探索・親子集計・プロジェクト特定を実測した環境です。最低動作要件ではなく、再現時に比較するためのスナップショットです。確認日は**2026-08-22（日本時間）**です。

| 項目 | 検証値 | ローカルでの確認元 | 公式情報 |
|---|---|---|---|
| OS | Windows 11 Pro 25H2、x64、OS build `26200.8973` | Windows `CurrentVersion`レジストリの`DisplayVersion`、`CurrentBuildNumber`、`UBR`。旧互換の`ProductName`は`Windows 10 Pro`と表示されるためbuild番号で判定 | [Microsoft: Windows 11 release information](https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information) |
| VS Code | Visual Studio Code Stable `1.134.0`、x64、commit `110a328ea54b42367b803ec53ee0bf52ef26b419` | `code --version`およびインストール済み`product.json`の`quality = stable` | [VS Code 1.134 release notes](https://code.visualstudio.com/updates/v1_134)、[VS Code CLI](https://code.visualstudio.com/docs/configure/command-line) |
| GitHub Copilot拡張 | 同梱版 `0.62.0` build `1`、VS Code engine `^1.134.0` | VS Codeインストール配下の`resources/app/extensions/copilot/package.json` | [Microsoft公式ソース: Copilot package.json](https://github.com/microsoft/vscode/blob/main/extensions/copilot/package.json) |
| Node.js | `v24.11.1`、x64 | `node --version` | [Node.js 24.11.1 release](https://nodejs.org/en/blog/release/v24.11.1) |
| npm | `11.6.2` | `npm --version` | [npm CLI v11 documentation](https://docs.npmjs.com/cli/v11/commands/npm/) |
| Windows PowerShell | `5.1.26100.8972` | `$PSVersionTable.PSVersion` | [Microsoft: Windows PowerShell 5.1](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_5.1?view=powershell-5.1) |
| Git for Windows | `2.46.0.windows.1` | `git --version` | [Git for Windows公式サイト](https://gitforwindows.org/) |
| aimet | branch `codex/copilot-accounting-fix`、検証開始HEAD `5cfa0c5` | `git branch --show-current`、`git rev-parse --short HEAD` | [mayochan32/aimet](https://github.com/mayochan32/aimet) |

VS CodeとCopilot拡張は自動更新されるため、将来の再検証では上表のコマンドを再実行し、新しい値とログ形式の差を記録してください。特に`globalStorage`、`session-store.db`、デバッグ設定名はバージョン依存として扱います。

同じく2026-08-22に、macOS 26.6.2（arm64）のVS Code Stable `1.134.0`／同梱Copilot `0.62.0` build `1`が作成した現行`globalStorage`ログでも再検証しました。シングル親1件、マルチ親1件、`searchSubagent-*`の子2件を独立検算器と照合し、非キャッシュ入力`33,257`、cacheR `44,837`、出力`1,125`、合計`0.8570538 AI Credits`が一致しました。同じログの再収集は`+0 new, ~0 updated, 4 unchanged`で、子の見落とし・二重計上とも発生していません。

**`test/parsers.test.js` — 各ツールパーサの正しさ**

- **Claude**: assistantレコードの `usage` を合計し、`in` / `out` / `cacheR` / `cacheW` が期待値になること。リトライ/ストリーミングで**同じmessage IDが重複しても二重計上せず**、ターン数も過大計上しないこと。途中に壊れたJSONL行があっても無視して処理を続けること。
- **Claude（未知モデル）**: 単価表にないモデルはコストを **`0`ではなく `null`** にすること。
- **Codex**: `token_count` の累積値から**最大値**を採用し、`input_tokens` から `cached_input_tokens` を差し引いて非キャッシュ入力に分離すること。reasoningトークンも取得すること。
- **Codex（モデル不明）**: 既定単価にフォールバックしつつ、単価が推定であることを **`estimated: true`** で明示すること。
- **Copilot（Chat）**: ObjectMutationLogの`Set` / `Push` / `Delete`を順番どおり復元できること。`main.jsonl`と`child_session_ref`で参照された各子JSONLはスパンIDで重複排除し、親子のトークンとnano-AIUが生ログの値に一致すること。
- **Copilot（親子集計）**: `main.jsonl` を同じIDの `chatSessions` より優先し、親と子を各1回だけ加算すること。実ログから匿名化したgolden fixtureで **22.0478895 AI Credits** と正確なトークン数を固定値照合すること。
- **Copilot（プロジェクト特定）**: 現行`globalStorage`ログを同じセッションIDの`session-store.db.sessions.cwd`へ結び付けること。自由記述中のパスを帰属根拠にせず、より確実な`project_source`へ更新しても`main.jsonl`の数値を保ち、サブエージェントが親のプロジェクトを継承すること。
- **Copilot CLI**: 出力トークンを合計しターン数を数える一方、**入力トークンは未計測（`null`）**、コストも算出不可の **`null`** になること。壊れた行は無視すること。

**`test/store.test.js` — 保存と冪等性**

- `upsert` が `inserted → skipped → updated` と正しく遷移し、**同じログを何度取り込んでも行が増えない**こと（`last_event_at` による重複防止）。
- `collect` を同じログに再実行すると、2回目は**すべてskip**されること。
- Copilotの `own`（自分のみ）と `tree`（子を含む）の両形式で、report / session / Markdownが同じ二重計上防止規則を使うこと。

**`test/paths.test.js` — macOS / Windows互換性**

- `%APPDATA%`、Windowsのフォールバック、Stable / Insiders / VSCodium、新旧の `workspaceStorage` / `globalStorage`、`AIMET_COPILOT_DIR`の `;` 区切り、Windows `file://` URIを検証します。
- `session-store.db`のセッションID完全一致、構造化されたログ中のパスだけを使う安全な補完、自由記述の除外、より高信頼なプロジェクト根拠へのメタデータ限定更新を検証します。
- CIのWindowsジョブでは、`--dir` なしの自動探索から取り込みまで実行します。

**`test/security.test.js` — レビュー指摘の再発防止**

- **プロトタイプ汚染**: `__proto__` / `constructor` を含む細工Copilotログを読んでも `Object.prototype` が汚染されないこと。正当なデータは正しく復元されること。
- **SQLホワイトリスト**: `report` の `--by` / `--period` に想定外の値（例: `tool; DROP TABLE ...`）を渡すと、SQLを組み立てる前に例外で弾くこと。
- **pricing.json検証**: ユーザー単価表の不正エントリ（型不正・危険キー）は読み飛ばし、正当な上書きだけ採用すること。
- **設定ファイル保護**: 既存設定が不正なJSONのとき、`init` が**上書きせず例外で停止**し、元ファイルを変更しないこと。

## 機能と使い方

### 1. 手動発動 — いつでも取り込み・集計

```bash
aimet collect                       # 全ログを走査して取り込み（冪等・再実行安全）
aimet collect --since 7             # 直近7日に更新されたログのみ
aimet report                        # 日次サマリー（テキスト表）
aimet report --period weekly --by project
aimet report --tool claude          # 特定ツールに絞り込み
aimet report --by model --json      # JSON出力（BI・スプレッドシート連携用）
aimet session --tool claude         # 直近セッションのサマリ
aimet detail --tool codex           # 直近セッションの全記録をJSONダンプ
aimet detail --tool codex --raw     # 除外なし完全ダンプ（システムプロンプト全文等も）
aimet detail --file <log.jsonl>     # DB未登録のログを直接ダンプ
```

すべての出力レベルは `--md <ファイル>` でMarkdownファイルに整形出力できます。

```bash
aimet report --by tool --md report.md
aimet session --tool codex --md session.md
aimet detail --tool claude --md detail.md
```

### 2. 自動発動 — セッション終了時に自動記録

`aimet init <tool>` が各開発環境にフックを組み込みます（`--dry-run` で書き込み内容を事前確認できます）。

```bash
aimet init claude    # ~/.claude/settings.json に SessionEnd フックを登録
aimet init codex     # ~/.codex/hooks.json にフックを登録
aimet init copilot   # ~/.copilot/hooks/aimet.json に Stop フックを登録（VS Code）
```

以後、セッションが終わるたびに `aimet hook <tool>` が自動で呼ばれ、そのセッションのログを即時パースしてDBへ記録します。フックはstdinのイベントJSON（`transcript_path` 等）からログを特定し、特定できない場合は直近2日分の差分スキャンにフォールバックします。**ホスト環境を絶対に失敗させないよう常に exit 0** で終了します。

> **注意（Codex）**: `hooks.json` のスキーマはバージョンにより変わる可能性があります。組み込み後にTUIの `/hooks` で有効になっているか確認してください。

> **注意（Copilot / VS Code）**: VS CodeのAgent hooksは**プレビュー機能**です（フック形式はClaude Code互換で、ユーザーレベルの置き場所が `~/.copilot/hooks/*.json`）。組み込み後、Copilot Chatで `/hooks` と打つか、出力パネルの「GitHub Copilot Chat Hooks」チャンネルで発火を確認してください。フックが使えない環境では、定期実行で代替できます：
> ```bash
> # cronで1時間ごとに差分取り込み（フック不要の代替手段）
> 0 * * * * aimet collect --since 2
> ```

### 3. 対話発動 — エージェントに聞く

`aimet init` は各環境に `/metrics` コマンドも配置します。開発中に `/metrics` と打つと、エージェントが `aimet session` を実行して現在の使用状況を答えます。

| 環境 | 配置先 | 呼び出し方 |
|---|---|---|
| Claude Code | `~/.claude/commands/metrics.md` | `/metrics` |
| Codex CLI | `~/.codex/prompts/metrics.md` | `/metrics` |
| Copilot (VS Code) | `<userData>/User/prompts/metrics.prompt.md` | チャットで `/metrics`（プロンプトファイル） |

Copilotの場合、エージェントモードでターミナルコマンドの実行許可を求められたら承認してください（`aimet collect` と `aimet session` を実行します）。

## コマンドリファレンス

```
aimet <command> [options]
```

すべてのコマンドに共通: データベースは `~/.aimet/metrics.db`（環境変数 `AIMET_DB` で変更可）。引数なしで `aimet` を実行すると使用方法を表示します。

---

### aimet collect — ログの取り込み

```
aimet collect [--tool <tool>] [--since <days>] [--dir <path>]
```

各ツールのデフォルトログディレクトリを走査し、セッションをDBへ取り込む。冪等（再実行しても二重計上しない。取り込み済みで変化のないセッションはskip）。

| オプション | 説明 |
|---|---|
| `--tool <claude\|codex\|copilot\|copilot-cli>` | 指定ツールのログのみ走査する。省略時は全ツール |
| `--since <days>` | 最終更新が指定日数以内のログファイルのみ対象（差分取り込みの高速化） |
| `--dir <path>` | デフォルトの代わりに指定ディレクトリを走査する（Insiders等の非標準パスやテスト用） |

出力例: `scanned 12 files: +3 new, ~1 updated, 8 unchanged, 0 errors`

---

### aimet report — 期間集計

```
aimet report [--period daily|weekly|monthly] [--by tool|project|model]
             [--tool <tool>] [--since <days>]
             [--start <YYYYMMDDhhmmss>] [--end <YYYYMMDDhhmmss>]
             [--json] [--md <file>]
```

DB内のセッションを期間バケットで集計して表示する。

| オプション | 説明 |
|---|---|
| `--period <daily\|weekly\|monthly>` | 集計単位（デフォルト: daily）。ローカル日付基準 |
| `--by <tool\|project\|model>` | 指定軸で行を分割し横断比較する |
| `--tool <tool>` | 指定ツールのセッションのみ集計する（`--by` と併用可） |
| `--since <days>` | 直近N日のセッションのみ集計する |
| `--start <時刻>` / `--end <時刻>` | セッション開始時刻（started_at）がこの範囲のものだけ集計する。**ローカル時刻**の `YYYYMMDDhhmmss` 形式。短縮形可：`20260707` は日全体、`2026070709` は9時台を指す（startは期間の頭、endは期間の末尾に自動補完）。`2026-07-07 09:00:00` のような区切り文字入りも受け付ける |
| `--json` | 生値（未丸め）のJSONで出力する。BI・スプレッドシート連携用 |
| `--md <file>` | Markdownの表としてファイルに書き出す |

---

### aimet session — セッションサマリ

```
aimet session [--tool <tool>] [--id <prefix>] [--md <file>]
```

条件に合う**最新の1セッション**のサマリを表示する。

| オプション | 説明 |
|---|---|
| `--tool <tool>` | 指定ツールのセッションに絞る |
| `--id <prefix>` | セッションIDの前方一致で指定する（先頭数文字でよい） |
| `--md <file>` | Markdownの表としてファイルに書き出す |

---

### aimet detail — 全記録の詳細ダンプ

```
aimet detail [--tool <tool>] [--id <prefix>] [--file <log.jsonl>]
             [--raw] [--md <file>]
```

集計せず、セッションログに記録された情報を（ほぼ）すべてJSONで出力する。対象セッションはDBから解決する（`--file` 指定時はDB不要）。

| オプション | 説明 |
|---|---|
| `--tool <tool>` / `--id <prefix>` | 対象セッションの指定（省略時は最新） |
| `--file <log.jsonl>` | ログファイルを直接指定する。DB未登録のファイルも可（`--tool` で形式を指定） |
| `--raw` | 通常除外している巨大フィールドも含めた完全ダンプ（Codexの `base_instructions`・`dynamic_tools`、Claudeの元レコード全体） |
| `--md <file>` | 整形したMarkdownとしてファイルに書き出す |

> **⚠️ 機密情報の注意**: `detail`（特に `--raw`）の出力には、プロジェクトパス・作業時刻・会話の断片・ツール設定・システムプロンプトが含まれ得ます。**GitHub Issue・Slack・社外のAIサービス等に貼る前に必ず中身を確認**してください。`--raw` 実行時はこの旨の警告をstderrに表示します。

---

### aimet hook — フック用エントリポイント（内部利用）

```
aimet hook <tool>
```

各開発環境のフックから呼ばれる想定のコマンド（`aimet init` が登録する）。stdinのイベントJSONから `transcript_path` 等を読み取り、該当セッションだけを即時取り込む。特定できない場合は該当ツールの直近2日分を差分スキャンする。**ホスト環境を失敗させないため常に exit 0** で終了する。手動実行も可能（引数のstdinなしで差分スキャンとして動く）。

---

### aimet init — 開発環境への組み込み

```
aimet init <claude|codex|copilot> [--dry-run]
```

指定ツールに自動発動フックと `/metrics` コマンドをインストールする。既存設定はマージし、登録済みなら重複追加しない。

> **⚠️ 既存設定への影響**: 初回は `--dry-run` で書き込み内容を確認してから実行することを推奨します。既存の設定ファイルが不正なJSON（コメント付き等を含む）の場合、`init` は**上書きせず明示的にエラーで停止**します。実際に書き込む際は、既存ファイルを `<path>.bak` としてバックアップし、一時ファイル経由の原子的書き込み（temp→rename）で更新します。

| 対象 | 書き込み先 |
|---|---|
| `claude` | `~/.claude/settings.json`（SessionEndフック）、`~/.claude/commands/metrics.md` |
| `codex` | `~/.codex/hooks.json`（SessionEndフック）、`~/.codex/prompts/metrics.md` |
| `copilot` | `~/.copilot/hooks/aimet.json`（Stopフック）、`<userData>/User/prompts/metrics.prompt.md` |

> **copilot-cli について**: 専用の `init` はありません。`~/.copilot/hooks/` は**VS CodeとCopilot CLIの両方が読む**ため、`aimet init copilot` で登録したStopフックがCLIセッション終了時にも発火し、フックのフォールバックスキャンは `copilot` と `copilot-cli` の両方を取り込みます。

| オプション | 説明 |
|---|---|
| `--dry-run` | 書き込む予定のファイルを表示するだけで、実際には変更しない |

---

### 環境変数

| 変数 | 説明 |
|---|---|
| `AIMET_DB` | データベースファイルのパス（デフォルト: `~/.aimet/metrics.db`） |

## 3種類のレポートの見方

### レベル1: `aimet report` — 期間集計（PM向けサマリ)

```
| period     | start                     | end                       | tool   | sessions | turns | active | wall   | input | output | cacheR | cacheW | cost($) |
| 2026-07-04 | 2026-07-04 17:11:32 (+09:00) | 2026-07-05 08:10:05 (+09:00) | codex | 1 | 24 | 2.12h | 14.98h | 2.15M | 158.2k | 26.05M | 0 | 7.52 |
```

| 項目 | 意味 |
|---|---|
| period | 集計バケット（日/週/月、**ローカル日付**基準） |
| start / end | 期間内の最初のセッション開始・最後の終了時刻（ローカル時刻、秒まで） |
| sessions | セッション数 |
| turns | エージェントの応答ターン数（≒依頼したタスクの粒度） |
| active | **実働時間**。イベント間隔が5分を超えた区間をアイドルとして除外した時間 |
| wall | **実時間**。セッション開始から終了までの経過時間（放置時間を含む） |
| input | 非キャッシュ入力トークン（Codexはcached分を差し引いた値） |
| output | 出力トークン（Codexはreasoning分を含む） |
| cacheR | キャッシュ読み取りトークン（プロンプトキャッシュのヒット量） |
| cacheW | キャッシュ書き込みトークン（Claudeのみ。OpenAIは書き込み課金なし） |
| cost($) | **API換算コストUSD**。従量課金だった場合の金額。`*` 付きは推定値を含む |

読み方のヒント: `active/wall` の比が低いほど「AIに任せて放置できた」ことを意味します。`cacheR` が大きいほどコンテキスト再利用が効いています。`cost/turns` で1タスクあたり単価が出せます。

#### `-`（ハイフン）と `0` の違い

**`-` は「そのツールのログに記録が存在しない（計測不能）」、`0` は「計測できていて値がゼロ」**を意味します。DBでもNULLと0を区別して保存しています（JSON出力ではnull）。ツール別の計測可否（クレジット実費・親子リンク等まで含む完全版は[コスト計算の仕組み](#ツール別取得できる情報の一覧)を参照）：

| | in | out | cacheR | cacheW | reasoning |
|---|---|---|---|---|---|
| claude | ✅ | ✅ | ✅ | ✅ | −（APIが個別に返さない） |
| codex | ✅ | ✅ | ✅ | −（OpenAIは書き込み課金なし） | ✅ |
| copilot (Chat) | ✅ | ✅ | − | − | − |
| copilot サブエージェント | ✅ | ✅ | ✅ | − | − |
| copilot-cli | − | ✅ | − | − | − |

集計行（report）では、そのグループ内の全セッションが未計測の場合のみ `-` になります。計測可能なツールと不能なツールが混在するグループでは計測分のみの部分合計が表示される点に注意してください（`--by tool` で分ければ混在しません）。

オプション: `--period daily|weekly|monthly`、`--by tool|project|model`（横断比較）、`--since <日数>`。

### レベル2: `aimet session` — 1セッションのサマリ

直近（または `--id <プレフィックス>` で指定した）セッション1件の詳細サマリ。項目はレベル1と同じ意味に加えて:

| 項目 | 意味 |
|---|---|
| project | 作業ディレクトリ（案件の識別子として使える） |
| model | 使用モデル名 |
| reasoning | 推論トークン（Codexのみ。outputの内数） |
| log file | 元ログファイルのパス（detailで深掘りする際の入口） |

### レベル3: `aimet detail` — ログの全記録

集計せず、JSONLに記録されている情報を（ほぼ）すべて出します。構成はツールごとに異なります。

**共通**: `meta`（セッションID、作業ディレクトリ、CLIバージョン等）、`models`（使用モデル一覧）、`eventCounts`（イベント種別ごとの件数。function_call件数＝ツール実行回数など）

**Claude Code**: `requests[]` — APIリクエスト1件ごとの記録

| 項目 | 意味 |
|---|---|
| timestamp / messageId / model | リクエストの時刻・ID・モデル |
| stopReason | 応答の終了理由（end_turn / tool_use など） |
| contentTypes | 応答の内容種別（text / thinking / tool_use:ツール名） |
| usage.input_tokens 等 | 生のトークン内訳。`cache_creation` の1h/5mはキャッシュTTL別の書き込み量 |
| usage.service_tier / speed | APIのサービス階層・速度モード |
| usage.server_tool_use | サーバー側ツール（web検索等）の実行回数 |

**Codex**: `turnContexts[]`（ターンごとの実行設定：model、reasoning effort、承認ポリシー、サンドボックス構成）と `tokenTimeline[]`（token_countイベントの全時系列）

| 項目 | 意味 |
|---|---|
| info.total_token_usage | セッション累積トークン（input / cached / output / reasoning） |
| info.last_token_usage | 直前ターンのトークン |
| info.model_context_window | コンテキストウィンドウ上限（消費推移の分析に） |
| rate_limits.primary / secondary | 5時間枠・週間枠の使用率(%)とリセット時刻 |
| rate_limits.plan_type | 契約プラン |

`--raw` を付けると、通常は除外している巨大フィールド（Codexの `base_instructions`＝システムプロンプト全文、`dynamic_tools`＝ツールスキーマ定義、Claudeの元レコード全体）も含めた完全ダンプになります。

## トークン列（in / out / cacheR / cacheW）の読み方

数字を初めて見ると `in` が `1` や `3` と極端に小さく、異常に見えます。これはバグではなく**プロンプトキャッシュの仕様**です。入力と出力で仕組みがまったく違うので、分けて説明します。

### 入力側 — `in` はキャッシュに乗らなかった“残り”だけ

Claude APIの `usage` は、1リクエストの入力トークンを**3つに分類**して記録します。表の各列はその分類そのものです。

| 列 | 元フィールド | 意味 |
|---|---|---|
| `in` | `input_tokens` | キャッシュから読まれもせず、キャッシュ作成にも使われなかった**残りの入力**だけ |
| `cacheR` | `cache_read_input_tokens` | 過去にキャッシュ済みで、今回**読み出して再利用**した入力（割引単価） |
| `cacheW(1h/5m)` | `cache_creation_input_tokens` | 今回**新しくキャッシュに書き込んだ**入力（TTL別の内訳。割増単価） |

つまり **`in` は「入力の総量」ではありません**。そのリクエストで実際にモデルが読んだ入力の総量は次式です。

```
実入力トークン = in + cacheR + cacheW
```

例（表1行目）：`3 + 11665 + 7643 ≈ 19,311` トークンが実際の入力で、うち**新規はわずか3トークン**、残りは全部キャッシュ経由。

なぜ `in` が1〜3まで小さくなるか。エージェント対話では、システムプロンプト・ツール定義・過去の会話履歴という巨大な塊が毎ターンほぼ同じで、そこはキャッシュに固定されます（→ `cacheR`）。毎ターン増える新規コンテンツ（ユーザーの一言やツール実行結果）にもキャッシュ印が付くので、その大半は `cacheW` に吸い込まれます。結果、どのキャッシュ区分にも属さず `in` に残るのは、**最後のキャッシュ区切りより後ろにはみ出す、ごく短い末尾の断片だけ**になります。値がほぼ一定（3）なのは、それが毎回同じ小さな末尾で、会話量とは連動しないためです。

> **したがって `in` が小さいのは「キャッシュがよく効いている＝コスト効率が良い」健全な状態**を意味します。会話が長くなった分は `in` ではなく `cacheR` / `cacheW` 側に積み上がります。

### 出力側 — `out` はキャッシュされず、生成した全てを合算

**キャッシュは入力専用です。出力は絶対にキャッシュされません**。モデルの生成物は毎回ゼロから作られるので、`out` に `cacheR` / `cacheW` のような分割はなく、他のどの列とも足し引きの関係を持たない独立した数字です。

`out`（`output_tokens`）が数えるのは、その応答でモデルが**生成した全トークン**で、中身は `thinking`（推論）＋ `text`（本文）＋ `tool_use`（ツール呼び出しのJSON）を**すべて合算した1つの値**です。3種すべてが出力単価で課金されます（thinkingも例外なく出力扱い）。

> **detailテーブルの注意 — `out` 列を縦に合計しないこと。** detailは1つのAI応答を content ブロックごと（thinking / text / tool_use）に複数行へ展開しますが、`in` / `out` / `cacheR` / `cacheW` は**ターン単位の同じ usage を各行にコピー表示**しているだけです。例えば `thinking` 行と `text` 行の両方に `out=59` とあるのは「思考59＋本文59」ではなく「**このターンの生成合計が59**」の意味。行ごとに足すと二重計上になります。（集計側 `report` / `session` は messageId で重複排除するため、合計値は正しく出ます。二重に見えるのは detail の生ダンプ表示のみ。）

### `out` と `cache` をつなぐ「1ターン遅れ」の関係

出力は生成された瞬間はキャッシュされません（→ `out` に計上）。しかし応答が終わるとそのテキストは会話履歴に追記され、**次のリクエストでは「入力」に化けます**。すると次ターンで `cacheW`（新規書き込み）され、それ以降は `cacheR`（読み出し）で再利用されます。

```
今ターンの out ──(1ターン後)──▶ 次ターンの cacheW ──(以降)──▶ cacheR
```

議事録に例えると、`out` は「今しゃべった言葉」、`cacheW` は「それを議事録に書き留める」、`cacheR` は「議事録を割引価格で読み返す」。**出力は1ターン遅れて入力キャッシュのパイプラインに合流します**。

ただし次ターンの `cacheW` は前ターンの `out` そのものだけでなく、間に挟まったユーザー入力やツール実行結果も含むため、数値がぴったり一致するわけではありません。「出力が入力キャッシュに流れ込む」という**方向の関係**として捉えてください。

## キャッシュ（cacheR / cacheW）の効果とコストへの影響

### プロンプトキャッシュとは

AIエージェントはAPIリクエストのたびに**会話履歴・システムプロンプト・ツール定義を毎回まるごと送り直します**。エージェントが50回ツールを実行するセッションでは、同じ数万トークンのコンテキストが50回入力される計算です。プロンプトキャッシュは、この繰り返し部分（プロンプトの先頭から一致する部分）をAPIサーバー側に一時保存し、2回目以降は大幅な割引価格で再利用する仕組みです。

- **cacheW（キャッシュ書き込み）**: コンテキストをキャッシュに保存したトークン量。通常の入力より**割高**に課金される
- **cacheR（キャッシュ読み取り）**: キャッシュにヒットして再利用されたトークン量。通常の入力より**大幅に安く**課金される

### 課金倍率（通常入力価格に対する倍率）

| 種別 | Anthropic (Claude Code) | OpenAI (Codex) |
|---|---|---|
| キャッシュ書き込み（5分TTL） | **1.25倍** | 無料（自動キャッシュ、書き込み課金なし） |
| キャッシュ書き込み（1時間TTL） | **2.0倍** | — |
| キャッシュ読み取り | **0.1倍**（90%割引） | **0.1倍**（90%割引） |

Anthropicは明示的にキャッシュポイントを指定する方式で、TTL（保持時間）5分か1時間を選べます。書き込みが割高な代わりに、5分TTLなら**1回ヒットした時点で元が取れます**（1.25 + 0.1 < 1.0 + 1.0）。1時間TTLでも2回ヒットで黒字化します。OpenAIは自動プレフィックスキャッシュ（約1024トークン以上で自動適用）で書き込み課金がなく、ヒット分が単純に9割引になります。

### 実データでの効果

このリポジトリの開発時に採取した実セッションの例：

| セッション | cacheR | キャッシュありコスト | キャッシュがなかった場合 | 削減額 |
|---|---|---|---|---|
| Codex（15時間・24タスク） | 26.05M | $3.26 | $32.56 | **約$29（90%減）** |
| Claude Code（33分・20ターン） | 292.8k | $0.09 | $0.88 | 約$0.79 |

読み方の目安：**cacheRが大きいこと自体は良いこと**です（同じ内容を割引価格で再利用できている）。逆にセッションが長いのにcacheRが小さい場合は、キャッシュが効かない使い方（コンテキストの頻繁な作り直し、5分以上の放置によるTTL切れなど）をしている可能性があります。cacheWが多くcacheRが少ないセッションは書き込み損になっているので、短時間に集中して対話する方がコスト効率が上がります。

## コスト計算の仕組み

> **⚠️ コストは参考値。実際の実行環境に合わせて計算してください。**

**cost($)の基本は「API換算コスト」です。** 従量課金（API直叩き）だった場合にいくらになるかを、ログに記録された実測トークン数 × 公開単価で計算した理論値であり、**実際の請求額ではありません**（例外はCopilot Chatで、実費が取れます。後述）。ClaudeのProプラン/MaxプランやChatGPT Plusのような定額サブスクリプションで使っている場合、実際の限界コストは0円です。この値は「サブスクでどれだけ得しているか」「従量課金に切り替えたらいくらか」「タスクあたりの資源消費量」の指標として使ってください。

### 設計思想 — 「正確に出せるか」で3段階に分ける

コスト計算の正確さはツールのログが何を記録しているかで決まります。aimetは「それらしい数字を常に出す」ことよりも「**数字の信頼度が見た目で分かる**」ことを優先し、次の3段構えで処理します。

1. **正確に出せるものはそのまま出す** — 課金項目がすべて実測できる場合（Claude Code、Codex）、または実際の消費額そのものがログにある場合（Copilot Chatのクレジット）。表示に注記なし、または `(actual)`。
2. **不確かさが残るものは推定フラグを付けて出す** — トークンは実測だが単価が確定できない、キャッシュ内訳が不明で上限側の見積もりになる、など。`estimated` フラグ（表示 `*` / `(estimated)`）で明示します。
3. **根拠が足りないものは出さない** — 主要な課金項目（入力トークン）自体が記録されていない場合、過小評価の嘘をつくくらいなら **`-`（null）** にします。0円として集計されることはありません。

この方針の裏返しとして、トークン列も「未計測（`-`）」と「計測ゼロ（`0`）」を区別しています（前セクション参照）。

### ツール別・取得できる情報の一覧

| 取得項目 | Claude Code | Codex | Copilot Chat | Copilot サブエージェント | Copilot CLI |
|---|---|---|---|---|---|
| 入力トークン（非キャッシュ） | ✅ 実測 | ✅ 実測 | ✅ 実測（`main.jsonl`） | ✅ 実測 | − |
| 出力トークン | ✅ 実測 | ✅ 実測 | ✅ 実測 | ✅ 実測 | ✅ 実測 |
| キャッシュ読取（cacheR） | ✅ 実測 | ✅ 実測 | ✅ 実測（`main.jsonl`） | ✅ 実測 | − |
| キャッシュ書込（cacheW） | ✅ 実測（1h/5m TTL内訳付き） | −（課金項目が存在しない） | − | −（同左） | − |
| 推論トークン（reasoning） | − | ✅ 実測 | − | − | − |
| 実際の消費額 | − | − | ✅ AI Credits実測 | ✅ AI Credits実測 | − |
| モデル名 | ✅ | ✅ | ✅（resolvedModel） | ✅ | ✅ |
| 時間（wall / active） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 親子リンク | −（本体側が未記録） | ✅ | ✅ | ✅ | − |
| 補足情報 | service_tier、サーバーツール使用回数 | レート制限使用率の時系列、effort | ttft、ツールラウンド数 | ttft、スパン構造 | ターン・ツールイベント |

「−」はそのツールのログに記録が存在しないことを意味します（aimetの表示も `-`）。

### 計算式

```
cost = ( input × 入力単価
       + output × 出力単価
       + cacheR × キャッシュ読取単価
       + cacheW × キャッシュ書込単価 ) / 1,000,000
```

単価は1Mトークンあたり米ドル。モデル名の**プレフィックス最長一致**で単価表（`src/pricing.ts` 内蔵）から引きます。例：ログのモデルが `gpt-5.5` で単価表に `gpt-5.5` がなければ `gpt-5` の単価が使われます。一致するものがない場合、コストは `-`（null）となり**0円として集計されることはありません**。

単価は変動するため、`~/.aimet/pricing.json` で上書き・追加できます：

```json
{ "gpt-5.5": [1.75, 14.0, 0.175, 0] }
```

（配列は `[input, output, cacheRead, cacheWrite]` の順、1MトークンあたりUSD）

### ツールごとのコスト計算方法

**Claude Code — 完全内訳による正確なAPI換算**。APIリクエストごとの実測usageをmessageIdで重複排除して合算します。`input_tokens` はキャッシュ分を含まない生の値なのでそのまま使用でき、cacheR（0.1倍）・cacheW（割増）を含む**4項目すべてが実測**できる唯一のツールです。キャッシュ書き込みはTTLで単価が違うため（5分=1.25倍、1時間=2.0倍）、ログの `cache_creation` 内訳から**TTL別に正しく計算**します（単価表のcacheW列は5分TTLの単価。1時間TTL分は内部で1.6倍換算）。Anthropicの課金体系をログから完全に再現できるため、API換算値としての精度は最も高くなります。

**Codex — 課金項目はすべて実測、cacheW欠落の影響なし**。`token_count` イベントの累積値（最大値）を使用します。(1) ログの `input_tokens` は `cached_input_tokens` を**含む**ため、二重計上を避けるべく差し引いて「非キャッシュ入力」として記録します。(2) `reasoning_output_tokens` は `output_tokens` の内数で、課金も出力単価に含まれるため、コスト計算では加算しません（参考値としてreasoning列に表示）。(3) cacheWは `-`（未計測）ですが、**OpenAIにはキャッシュ書き込み課金という料金項目自体が存在しない**（自動キャッシュ・書き込み無料）ため、コスト式から欠けている項目はありません。つまり「取れない＝不正確」ではなく、課金に関係する in / cacheR / out は全部実測です。モデル名がログにない古い形式では既定単価（gpt-5-codex）にフォールバックし、`estimated` を立てます。サブエージェント（別rollout）は独立台帳なので単純合算で二重計上になりません。

**Copilotクレジット（AI Credits）とは**。GitHub Copilotの課金単位で、**1クレジット = $0.01の固定レート**です。2026年6月に従来のプレミアムリクエスト（PRU）制から移行した従量課金モデルで、プランに含まれる月間クレジット枠を消費し、超過分は追加課金されます。重要なのは、**消費クレジット数はモデルや処理量によって変動する**（高価なモデルほど1リクエストあたりの消費が大きい）ため、トークン数から外部で正確に再計算することはできない、という点です。幸いVS CodeのCopilot Chatはリクエストごとの実消費（`copilotCredits`）をログに記録するので、aimetはこれをそのまま採用します — つまりCopilot Chatのcostは推定ではなく**GitHubが実際に差し引いた金額**です。キャッシュの効きやモデルの内部事情もすべて織り込み済みの値なので、キャッシュ内訳（cacheR/cacheW）がログに無くてもコストの正確性には影響しません。

**GitHub Copilot Chat — 実測AI Credits優先、API換算はリクエスト単位のフォールバック**。`main.jsonl` の各LLMスパンにある `copilotUsageNanoAiu` / `aiu` を合計し、AI Creditsを $0.01/クレジットで表示します。`main.jsonl` がない場合は `chatSessions` の `copilotCredits` とトークンを使います。AI Creditsが欠損したリクエストだけ、実測トークン×resolvedModel単価でAPI換算し、全件実測は `actual`、一部フォールバックは `mixed`、全件フォールバックは `estimated` と区別します。

**Copilotサブエージェント — トークンとAI Creditsをリクエスト単位で実測**。親の`child_session_ref`で参照された子JSONL（`runSubagent-*`、`searchSubagent-*`など）のLLMスパンからin / cached / outとnano-AIUを取得します。同じ`spanId`は1回だけ数え、親は`main.jsonl`の自分のスパン、子は各子JSONLの自分のスパンだけを持つため、親子合計で二重計上しません。AI Credits欠損時のみ、Chatと同じルールでそのリクエストをAPI換算します。

**Copilot CLI — コストは出さない（n/a）**。ログに出力トークンしか記録されず、コストの大半を占める入力トークンが不明です。出力だけで計算した金額は大幅な過小評価になるため、aimetは**誠実にコストをnull（表示 `-`、セッション詳細では `n/a`）**とし、0円として合算に紛れ込ませません。取得できる出力トークン・時間・ターン数は工数指標として利用できます。

### 精度に関する注意

- **Copilotの`main.jsonl`と参照された子JSONLがある場合、キャッシュ内訳とAI Creditsをともに実測できます**。debug-logsがないChatセッションは`chatSessions`に記録された粒度に制限されます。cacheWが`-`のOpenAI系は課金項目自体が存在しないため影響はありません。
- 単価表が古いとコストがずれます。重要な集計の前に[Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)・[OpenAI](https://openai.com/api/pricing/)の最新単価と `src/pricing.ts` を照合し、必要なら `~/.aimet/pricing.json` で上書きしてください。特に `gpt-5.3` / `gpt-5.4` 系の内蔵単価は近縁モデルからの推定値です
- バッチ割引、優先スループット課金、サーバーツール（Web検索等）の従量課金は含みません
- Codexの累積トークンはセッション途中のコンテキスト圧縮（compaction）後も引き継がれる前提です。異常に大きい値が出た場合は `aimet detail` の `tokenTimeline` で推移を確認してください

## 設定

- **DBの場所**: `~/.aimet/metrics.db`（環境変数 `AIMET_DB` で変更可）
- **単価表**: `src/pricing.ts` にモデル名プレフィックスマッチで内蔵。`~/.aimet/pricing.json` で上書き・追加できます。形式は `{"モデル名プレフィックス": [input, output, cacheRead, cacheWrite]}`（1MトークンあたりUSD）。

```json
{ "gpt-5.5": [1.75, 14.0, 0.175, 0] }
```

## 設計メモ

- **冪等性**: `(tool, session_id)` を主キーに、最終イベント時刻とログの情報量で更新を判定します。Copilotの同じ親IDは `main.jsonl` > `chatSessions` の固定優先順位とし、取り込み順や時刻に左右されません。
- **Copilotの集計範囲**: スパントレース由来の親子は `own`（自分のLLM呼び出しのみ）として保存します。過去形式の親が `tree`（子を含む累計）の場合は、集計時に子を再加算しません。report / session / Markdownはすべて同じ共通ロールアップを使います。
- **Codexのトークン**: `token_count` は累積値のため最大値を採用。`input_tokens` は `cached_input_tokens` を含むため、共通スキーマでは差し引いて「非キャッシュ入力」として記録します。
- **Codexのマルチエージェント（CLI 0.137以降）**: サブエージェントは別のrolloutファイルになり、`session_meta` の `thread_source: "subagent"` で判別します。子の `payload.session_id` には**親のID**が入っているため、キーには `payload.id`（自スレッドID）を使い、親は `parent_session_id` にリンクします（Copilotと同じグループビューが使えます）。トークン台帳はスレッドごとに独立しており二重計上はありません。
- **Claude Codeのサブエージェント**: Taskツールの子は同じプロジェクトディレクトリに別JSONLとして保存され、通常のセッションとして集計に含まれます（漏れなし）。ただし現状のClaude Codeは子ログに親セッションIDを記録しないため、親子リンクは未対応です（[claude-code#32175](https://github.com/anthropics/claude-code/issues/32175)）。
- **重複排除**: Claudeのログは同一APIメッセージが複数レコードに分かれることがあるため、messageIdで重複排除して集計します（detailはあるがまま出力）。
- **推定値フラグ**: ログから実測できない値は `estimated` フラグ付きで区別します。
- **ストリームパース**: ログは1ファイル数MBになるため逐次読みで処理します。未知のフィールド・イベント種別は無視し、ツールのバージョンアップに寛容です。

## 代表的なコマンドの実行例

実際のセッションログに対して実行した例です（値は実測、パスの一部は編集済み）。

### 取り込み → 日次サマリー

```console
$ aimet collect
scanned 23 files: +6 new, ~1 updated, 16 unchanged, 0 errors

$ aimet report --by tool
    period     tool  sess  turns  active    wall      in     out  cacheR  cacheW  cost($)
----------  -------  ----  -----  ------  ------  ------  ------  ------  ------  -------
2026-07-07    codex     2     32   1.47h   2.19h   1.07M   99.6k  20.54M       -     4.85
2026-07-07  copilot     5      5   0.00h   0.06h  135.6k   23.8k  505.3k       -     0.22
2026-07-05  copilot     1      1   0.01h   0.02h   31.3k    1.6k       -       -     0.06
2026-06-19   claude     1     13   0.26h   0.55h      29    3.9k  292.8k   17.4k     0.25

( * = includes estimated values | cost: claude/codex = API-equivalent USD, copilot = actual credit spend )
```

`-` は「そのツールのログに記録が存在しない」ことを示します（0とは区別されます）。

### 期間・ツールを絞った集計

```console
$ aimet report --tool codex --period weekly          # Codexだけを週次で
$ aimet report --by project --since 7                # 直近7日をプロジェクト別に
$ aimet report --start 20260705 --end 20260706       # 7/5〜7/6（ローカル時刻）
$ aimet report --start 2026070705 --end 2026070706   # 7/7の5〜6時台だけ
$ aimet report --by model --json > tokens.json       # 生値JSONでBI連携
$ aimet report --by tool --md report.md              # Markdownでファイル出力
```

### セッションの深掘り（マルチエージェントのグループビュー）

```console
$ aimet session --id golden-parent      # 実ログを匿名化したgolden fixture
session : copilot golden-parent-1eaf50d0
project : unknown
model   : gpt-5.4-mini
time    : 2026-07-06T21:36:59.000Z -> 2026-07-06T21:40:19.000Z (active 0.00h / wall 0.06h)
turns   : 1
tokens  : in 13.5k / out 2.2k / cacheR 90.1k / cacheW -
cost    : $0.0223 (actual, 2.23 Copilot credits)
subagents (4):
  - golden-child-1  gpt-5.4-mini (runSubagent-Explore)  turns 1 / in 18.4k / out 3.4k / cacheR 64.5k / $0.0307 (actual)
  - golden-child-2  gpt-5.4-mini (runSubagent-Explore)  turns 1 / in 17.6k / out 5.6k / cacheR 119.8k / $0.0428 (actual)
  - golden-child-4  gpt-5.4-mini (runSubagent-Explore)  turns 1 / in 57.0k / out 4.9k / cacheR 109.6k / $0.0656 (actual)
  - golden-child-3  gpt-5.4-mini (runSubagent-Explore)  turns 1 / in 29.1k / out 7.7k / cacheR 121.3k / $0.0590 (actual)
subagents total: turns 4 / in 122.1k / out 21.7k / cacheR 415.2k / cost +$0.1981 (actual, 19.81 Copilot credits)
TOTAL(parent + 4 subagents): in 135.6k / out 23.8k / cacheR 505.3k / cost $0.2205 (actual, 22.05 Copilot credits)
```

```console
$ aimet session --id golden-child-2       # 子セッション単体。parent行で親に遡れる
session : copilot golden-child-2
parent  : golden-parent-1eaf50d0
model   : gpt-5.4-mini (runSubagent-Explore)
tokens  : in 17.6k / out 5.6k / cacheR 119.8k / cacheW -
cost    : $0.0428 (actual, 4.28 Copilot credits)
```

Codexのマルチエージェントも同様に親子で表示されます：

```console
$ aimet session --id 019f392e      # Codexの親セッション
session : codex 019f392e-fe29-7150-841a-6a97512b932e
model   : gpt-5.5
tokens  : in 1.05M / out 98.7k / cacheR 20.45M / cacheW -
cost    : $4.8534 (API-equivalent)
subagents (1):
  - 019f3930-4586-7013-bf2d-  codex-auto-review (subagent:guardian)  turns 6 / in 25.4k / out 867 / cacheR 85.9k / cost n/a
```

### 全記録のダンプ（ログ解析・監査用）

```console
$ aimet detail --tool codex                    # 最新セッションの全記録をJSONで
$ aimet detail --id call_6NQ --md detail.md    # サブエージェントをMarkdownで
$ aimet detail --tool codex --raw | jq '.tokenTimeline[-1].rate_limits'
{
  "primary":   { "used_percent": 7,  "window_minutes": 300 },
  "secondary": { "used_percent": 28, "window_minutes": 10080 },
  "plan_type": "plus"
}
```

### 開発環境への組み込み

```console
$ aimet init claude --dry-run      # 書き込み内容を事前確認
[dry-run] would write ~/.claude/settings.json
[dry-run] would write ~/.claude/commands/metrics.md

$ aimet init claude
wrote ~/.claude/settings.json
wrote ~/.claude/commands/metrics.md
```

## 出力サンプル

実際のセッションログから生成した各出力レベルのサンプルを [`examples/`](examples/) に置いています。

- [report.md](examples/report.md) — 期間集計（`aimet report --by tool --md`）
- [session-claude.md](examples/session-claude.md) / [session-codex.md](examples/session-codex.md) / [session-copilot.md](examples/session-copilot.md) — セッションサマリ
- [detail-claude.md](examples/detail-claude.md) / [detail-codex.md](examples/detail-codex.md) / [detail-copilot.md](examples/detail-copilot.md) / [detail-copilot-subagent.md](examples/detail-copilot-subagent.md) / [detail-copilotcli.md](examples/detail-copilotcli.md) — 全記録の詳細ダンプ

## ロードマップ

- `aimet serve`: ローカルHTMLダッシュボード
- MCPサーバー化（3環境共通の対話発動口）

## License

MIT
