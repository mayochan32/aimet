# aimet — AI Metrics

**Claude Code / Codex / GitHub Copilot のローカルセッションログから、AIエージェント開発にかかった時間・トークン数・API換算コストを採取するメトリクスツール。**

チームの管理API（組織機能）を使わず、各ツールが手元に残すセッションログ（JSONL）だけを情報源にします。採取したデータはプロジェクトマネジメントの数値データ（工数見積もり、案件別コスト配賦、モデル選定の判断材料など）として利用できます。

- 依存パッケージゼロ（Node.js 22.5+ の `node:sqlite` を使用）
- データは `~/.aimet/metrics.db` （SQLite）に蓄積
- 冪等設計：何度実行しても二重計上しない

## 対応状況

| ツール | ログの場所 | 取得できるトークン | 状態 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | 実測（in / out / cacheR / cacheW、1h/5mキャッシュ内訳） | ✅ |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | 実測（in / cached / out / reasoning）＋レート制限時系列 | ✅ |
| GitHub Copilot (VS Code Chat) | `<userData>/User/workspaceStorage/<hash>/chatSessions/*.jsonl` | 実測（prompt / completion）＋消費クレジット | ✅ |
| GitHub Copilot CLI | `~/.copilot/session-state/<uuid>/events.jsonl` | 実測（**出力トークンのみ**） | ✅ |

> Copilot Chat（VS Code）のログの場所（macOS）: `~/Library/Application Support/Code/User/workspaceStorage/`。記録されるのは**Chat/エージェントモードの対話のみ**で、インライン補完は残りません。VS Code Insiders等を使う場合は `aimet collect --dir` でパスを指定してください。
>
> **Copilot CLI（`@github/copilot`）の注意**: レポート上は `copilot`（Chat版）と区別するため **`copilot-cli`** という別ツールとして集計します。CLIのログは**出力トークンしか記録しない**（入力・キャッシュのフィールドが存在しない）ため、`in` / `cacheR` / `cacheW` は常に0、コストは入力が不明で算出できないため **`-`（null）** になります。取得できるのは出力トークン・実行時間・ターン数・モデル・プロジェクトです。

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

テスト内容は3ファイルに分かれています。

**`test/parsers.test.js` — 各ツールパーサの正しさ**

- **Claude**: assistantレコードの `usage` を合計し、`in` / `out` / `cacheR` / `cacheW` が期待値になること。リトライ/ストリーミングで**同じmessage IDが重複しても二重計上せず**、ターン数も過大計上しないこと。途中に壊れたJSONL行があっても無視して処理を続けること。
- **Claude（未知モデル）**: 単価表にないモデルはコストを **`0`ではなく `null`** にすること。
- **Codex**: `token_count` の累積値から**最大値**を採用し、`input_tokens` から `cached_input_tokens` を差し引いて非キャッシュ入力に分離すること。reasoningトークンも取得すること。
- **Codex（モデル不明）**: 既定単価にフォールバックしつつ、単価が推定であることを **`estimated: true`** で明示すること。
- **Copilot（Chat）**: インクリメンタル差分ログを復元して `requests[]` を組み立て、クレジットが記録されていれば**API換算ではなく実費**（1クレジット=$0.01）でコストを出すこと。
- **Copilot CLI**: 出力トークンを合計しターン数を数える一方、**入力トークンは記録が無いため0**、コストは算出不可の **`null`** になること。壊れた行は無視すること。

**`test/store.test.js` — 保存と冪等性**

- `upsert` が `inserted → skipped → updated` と正しく遷移し、**同じログを何度取り込んでも行が増えない**こと（`last_event_at` による重複防止）。
- `collect` を同じログに再実行すると、2回目は**すべてskip**されること。

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
             [--tool <tool>] [--since <days>] [--json] [--md <file>]
```

DB内のセッションを期間バケットで集計して表示する。

| オプション | 説明 |
|---|---|
| `--period <daily\|weekly\|monthly>` | 集計単位（デフォルト: daily）。ローカル日付基準 |
| `--by <tool\|project\|model>` | 指定軸で行を分割し横断比較する |
| `--tool <tool>` | 指定ツールのセッションのみ集計する（`--by` と併用可） |
| `--since <days>` | 直近N日のセッションのみ集計する |
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

**cost($)はすべて「API換算コスト」です。** 従量課金（API直叩き）だった場合にいくらになるかを、ログに記録された実測トークン数 × 公開単価で計算した理論値であり、**実際の請求額ではありません**。ClaudeのProプラン/MaxプランやChatGPT Plusのような定額サブスクリプションで使っている場合、実際の限界コストは0円です。この値は「サブスクでどれだけ得しているか」「従量課金に切り替えたらいくらか」「タスクあたりの資源消費量」の指標として使ってください。

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

### ツールごとの違い

**Claude Code**: APIリクエストごとの実測usageをmessageIdで重複排除して合算します。`input_tokens` はキャッシュ分を含まない生の値なのでそのまま使用。キャッシュ書き込みはTTLで単価が違うため（5分=1.25倍、1時間=2.0倍）、ログの `cache_creation` 内訳から**TTL別に正しく計算**します（単価表のcacheW列は5分TTLの単価。1時間TTL分は内部で1.6倍換算）。

**Codex**: `token_count` イベントの累積値（最大値）を使用します。注意点が2つ。(1) ログの `input_tokens` は `cached_input_tokens` を**含む**ため、二重計上を避けるべく差し引いて「非キャッシュ入力」として記録します。(2) `reasoning_output_tokens` は `output_tokens` の内数で、課金も出力単価に含まれるため、コスト計算では加算しません（参考値としてreasoning列に表示）。OpenAIはキャッシュ書き込み課金がないためcacheW単価は0です。

**GitHub Copilot（VS Code Chat）**: 他の2ツールと違い、**実際の消費クレジットが記録されるため実費で計算します**（`copilotCredits` × $0.01。1クレジット=$0.01）。表示には `(actual, Copilot credits)` と付き、API換算値と区別されます。クレジットが記録されていないセッションのみ、実測トークン×resolvedModelの単価でAPI換算し `estimated` フラグ（表示は `*`）を立てます。つまり**Copilotのcost($)だけは「実際に減ったクレジット」**で、claude/codexの「従量課金だったらいくらか」とは意味が異なる点に注意してください。トークンは `promptTokens` / `completionTokens` の実測値で、キャッシュの内訳は記録されないためcacheR/cacheWは常に0です。

### 精度に関する注意

- 単価表が古いとコストがずれます。重要な集計の前に[Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)・[OpenAI](https://openai.com/api/pricing/)の最新単価と `src/pricing.ts` を照合し、必要なら `~/.aimet/pricing.json` で上書きしてください
- バッチ割引、優先スループット課金、サーバーツール（Web検索等）の従量課金は含みません
- Codexの累積トークンはセッション途中のコンテキスト圧縮（compaction）後も引き継がれる前提です。異常に大きい値が出た場合は `aimet detail` の `tokenTimeline` で推移を確認してください

## 設定

- **DBの場所**: `~/.aimet/metrics.db`（環境変数 `AIMET_DB` で変更可）
- **単価表**: `src/pricing.ts` にモデル名プレフィックスマッチで内蔵。`~/.aimet/pricing.json` で上書き・追加できます。形式は `{"モデル名プレフィックス": [input, output, cacheRead, cacheWrite]}`（1MトークンあたりUSD）。

```json
{ "gpt-5.5": [1.75, 14.0, 0.175, 0] }
```

## 設計メモ

- **冪等性**: `(tool, session_id)` を主キーに、最終イベント時刻が進んだ場合のみ更新。フックの多重発動や `collect` の再実行で二重計上しません。
- **Codexのトークン**: `token_count` は累積値のため最大値を採用。`input_tokens` は `cached_input_tokens` を含むため、共通スキーマでは差し引いて「非キャッシュ入力」として記録します。
- **重複排除**: Claudeのログは同一APIメッセージが複数レコードに分かれることがあるため、messageIdで重複排除して集計します（detailはあるがまま出力）。
- **推定値フラグ**: ログから実測できない値は `estimated` フラグ付きで区別します。
- **ストリームパース**: ログは1ファイル数MBになるため逐次読みで処理します。未知のフィールド・イベント種別は無視し、ツールのバージョンアップに寛容です。

## 出力サンプル

実際のセッションログから生成した各出力レベルのサンプルを [`examples/`](examples/) に置いています。

- [report.md](examples/report.md) — 期間集計（`aimet report --by tool --md`）
- [session-claude.md](examples/session-claude.md) / [session-codex.md](examples/session-codex.md) / [session-copilot.md](examples/session-copilot.md) — セッションサマリ
- [detail-claude.md](examples/detail-claude.md) / [detail-codex.md](examples/detail-codex.md) / [detail-copilot.md](examples/detail-copilot.md) / [detail-copilotcli.md](examples/detail-copilotcli.md) — 全記録の詳細ダンプ

## ロードマップ

- `aimet serve`: ローカルHTMLダッシュボード
- MCPサーバー化（3環境共通の対話発動口）

## License

MIT
