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
| GitHub Copilot CLI | `~/.copilot/session-state/` | 総量のみ | 🚧 予定 |

> Copilotのログの場所（macOS）: `~/Library/Application Support/Code/User/workspaceStorage/`。記録されるのは**Chat/エージェントモードの対話のみ**で、インライン補完は残りません。VS Code Insiders等を使う場合は `aimet collect --dir` でパスを指定してください。

## インストール

```bash
git clone <this-repo> && cd aimet
npm install && npm run build
npm link        # `aimet` コマンドをグローバルに登録
```

## 機能と使い方

### 1. 手動発動 — いつでも取り込み・集計

```bash
aimet collect                       # 全ログを走査して取り込み（冪等・再実行安全）
aimet collect --since 7             # 直近7日に更新されたログのみ
aimet report                        # 日次サマリー（テキスト表）
aimet report --period weekly --by project
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
aimet init claude   # ~/.claude/settings.json に SessionEnd フックを登録
aimet init codex    # ~/.codex/hooks.json にフックを登録
```

以後、セッションが終わるたびに `aimet hook <tool>` が自動で呼ばれ、そのセッションのログを即時パースしてDBへ記録します。フックはstdinのイベントJSON（`transcript_path` 等）からログを特定し、特定できない場合は直近2日分の差分スキャンにフォールバックします。**ホスト環境を絶対に失敗させないよう常に exit 0** で終了します。

> **注意（Codex）**: `hooks.json` のスキーマはバージョンにより変わる可能性があります。組み込み後にTUIの `/hooks` で有効になっているか確認してください。

### 3. 対話発動 — エージェントに聞く

`aimet init` は各環境に `/metrics` コマンドも配置します（Claude Code: `~/.claude/commands/metrics.md`、Codex: `~/.codex/prompts/metrics.md`）。開発中に `/metrics` と打つと、エージェントが `aimet session` を実行して現在の使用状況を答えます。

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
- [detail-claude.md](examples/detail-claude.md) / [detail-codex.md](examples/detail-codex.md) / [detail-copilot.md](examples/detail-copilot.md) — 全記録の詳細ダンプ

## ロードマップ

- GitHub Copilot CLIパーサー（`~/.copilot/session-state/`、スキーマ確認後）
- `aimet serve`: ローカルHTMLダッシュボード
- MCPサーバー化（3環境共通の対話発動口）

## License

MIT
