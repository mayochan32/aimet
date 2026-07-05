# aim — AI Metrics

**Claude Code / Codex / GitHub Copilot のローカルセッションログから、AIエージェント開発にかかった時間・トークン数・API換算コストを採取する個人向けメトリクスツール。**

チームの管理API（組織機能）を使わず、各ツールが手元に残すセッションログ（JSONL）だけを情報源にします。採取したデータはプロジェクトマネジメントの数値データ（工数見積もり、案件別コスト配賦、モデル選定の判断材料など）として利用できます。

- 依存パッケージゼロ（Node.js 22.5+ の `node:sqlite` を使用）
- データは `~/.aim/metrics.db` （SQLite）に蓄積
- 冪等設計：何度実行しても二重計上しない

## 対応状況

| ツール | ログの場所 | 取得できるトークン | 状態 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | 実測（in / out / cacheR / cacheW、1h/5mキャッシュ内訳） | ✅ |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` | 実測（in / cached / out / reasoning）＋レート制限時系列 | ✅ |
| GitHub Copilot | `~/.copilot/session-state/` | 総量のみ・一部推定 | 🚧 予定 |

## インストール

```bash
git clone <this-repo> && cd aim
npm install && npm run build
npm link        # `aim` コマンドをグローバルに登録
```

## 機能と使い方

### 1. 手動発動 — いつでも取り込み・集計

```bash
aim collect                       # 全ログを走査して取り込み（冪等・再実行安全）
aim collect --since 7             # 直近7日に更新されたログのみ
aim report                        # 日次サマリー（テキスト表）
aim report --period weekly --by project
aim report --by model --json      # JSON出力（BI・スプレッドシート連携用）
aim session --tool claude         # 直近セッションのサマリ
aim detail --tool codex           # 直近セッションの全記録をJSONダンプ
aim detail --tool codex --raw     # 除外なし完全ダンプ（システムプロンプト全文等も）
aim detail --file <log.jsonl>     # DB未登録のログを直接ダンプ
```

すべての出力レベルは `--md <ファイル>` でMarkdownファイルに整形出力できます。

```bash
aim report --by tool --md report.md
aim session --tool codex --md session.md
aim detail --tool claude --md detail.md
```

### 2. 自動発動 — セッション終了時に自動記録

`aim init <tool>` が各開発環境にフックを組み込みます（`--dry-run` で書き込み内容を事前確認できます）。

```bash
aim init claude   # ~/.claude/settings.json に SessionEnd フックを登録
aim init codex    # ~/.codex/hooks.json にフックを登録
```

以後、セッションが終わるたびに `aim hook <tool>` が自動で呼ばれ、そのセッションのログを即時パースしてDBへ記録します。フックはstdinのイベントJSON（`transcript_path` 等）からログを特定し、特定できない場合は直近2日分の差分スキャンにフォールバックします。**ホスト環境を絶対に失敗させないよう常に exit 0** で終了します。

> **注意（Codex）**: `hooks.json` のスキーマはバージョンにより変わる可能性があります。組み込み後にTUIの `/hooks` で有効になっているか確認してください。

### 3. 対話発動 — エージェントに聞く

`aim init` は各環境に `/metrics` コマンドも配置します（Claude Code: `~/.claude/commands/metrics.md`、Codex: `~/.codex/prompts/metrics.md`）。開発中に `/metrics` と打つと、エージェントが `aim session` を実行して現在の使用状況を答えます。

## 3種類のレポートの見方

### レベル1: `aim report` — 期間集計（PM向けサマリ)

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

### レベル2: `aim session` — 1セッションのサマリ

直近（または `--id <プレフィックス>` で指定した）セッション1件の詳細サマリ。項目はレベル1と同じ意味に加えて:

| 項目 | 意味 |
|---|---|
| project | 作業ディレクトリ（案件の識別子として使える） |
| model | 使用モデル名 |
| reasoning | 推論トークン（Codexのみ。outputの内数） |
| log file | 元ログファイルのパス（detailで深掘りする際の入口） |

### レベル3: `aim detail` — ログの全記録

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

## 設定

- **DBの場所**: `~/.aim/metrics.db`（環境変数 `AIM_DB` で変更可）
- **単価表**: `src/pricing.ts` にモデル名プレフィックスマッチで内蔵。`~/.aim/pricing.json` で上書き・追加できます。形式は `{"モデル名プレフィックス": [input, output, cacheRead, cacheWrite]}`（1MトークンあたりUSD）。

```json
{ "gpt-5.5": [1.75, 14.0, 0.175, 0] }
```

## 設計メモ

- **冪等性**: `(tool, session_id)` を主キーに、最終イベント時刻が進んだ場合のみ更新。フックの多重発動や `collect` の再実行で二重計上しません。
- **Codexのトークン**: `token_count` は累積値のため最大値を採用。`input_tokens` は `cached_input_tokens` を含むため、共通スキーマでは差し引いて「非キャッシュ入力」として記録します。
- **重複排除**: Claudeのログは同一APIメッセージが複数レコードに分かれることがあるため、messageIdで重複排除して集計します（detailはあるがまま出力）。
- **推定値フラグ**: ログから実測できない値は `estimated` フラグ付きで区別します。
- **ストリームパース**: ログは1ファイル数MBになるため逐次読みで処理します。未知のフィールド・イベント種別は無視し、ツールのバージョンアップに寛容です。

## ロードマップ

- GitHub Copilot CLIパーサー（`session-state` スキーマ確認後）
- `aim serve`: ローカルHTMLダッシュボード
- MCPサーバー化（3環境共通の対話発動口）

## License

MIT
