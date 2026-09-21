# aimet開発・リリース確認手順

aimetのトークン値とコストは、各製品のローカルログ形式、モデルID、料金体系に依存します。モデルと料金はコード変更とは無関係なタイミングでも更新されるため、**すべての修正とリリースで以下を確認してください**。

## 必須: 最新モデル・料金監査

1. 作業日に次の公式情報を開く。
   - [OpenAI Models](https://developers.openai.com/api/docs/models)
   - [OpenAI API Pricing](https://openai.com/api/pricing/)
   - [Anthropic Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
   - [GitHub Copilot models and pricing](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)
2. `src/pricing.ts`と公式情報を照合する。
   - 正式なモデルID、別名、日付付きsnapshot
   - input、output、cache read、cache write
   - 長文コンテキスト、fast mode、地域、batchなどの条件付き料金
   - 廃止モデルと価格改定
3. 新しい課金項目やusageフィールドがある場合、単価表だけで済ませず実ログを確認する。原本を変更せず、フィールド名と数値関係だけを匿名化して記録する。
4. 対応が必要なら、単価、パーサー、テスト、READMEを同じ変更に含める。対応不要でも、確認日と「公式情報との差分なし」をPRまたは作業記録へ残す。

実行時に料金サイトへ自動アクセスする実装は、再現性、オフライン利用、外部通信を避けるため採用しません。組み込み単価はレビュー済みのソースとして固定し、利用者は単純な単価差を`~/.aimet/pricing.json`で上書きできます。

## 週次監視

`.github/workflows/weekly-monitor.yml`は週1回、公式モデル・料金・変更履歴・OTel資料の本文ハッシュを前回の監視結果と比較し、`npm test`で既存のfixtureを検証します。初回は比較元の記録です。毎回、変更候補・変更候補なし・確認未完了のいずれかを新しい`aimet 週次監視レポート` Issueとして、担当者割当と直接メンション付きで投稿します。公式ページの些細な編集でも変更候補になり得るため、必ずリンク先の内容を人が確認してください。ローカル実ログの変更はGitHub Actionsから検出できません。

変更候補が見つかったら、公式資料と匿名化した実ログで、モデルID、usageフィールド、キャッシュ内訳、親子エージェントの重複、時間の意味を照合します。必要な修正はPRで提出し、人が内容を確認してからマージします。週次監視はコード・単価表・ベースブランチを書き換えません。

## 料金変更時のテスト

- 正式IDと日付付きsnapshotが期待単価へ一致する。
- 未知の将来モデルが古いモデル単価へ誤一致せず`null`になる。
- 明示的な使用量ゼロだけは未知モデルでも正確な`$0`になる。
- cache read / writeを非キャッシュinputから分離し、二重計上しない。
- 条件付き倍率はセッション累積ではなく課金単位のリクエストへ適用する。
- Copilotの実測AI CreditsをAPI換算値で上書きしない。

## 最終確認

```bash
npm ci
npm test
npm pack --dry-run
```

OS・保存場所・ログ形式へ影響する変更では、該当する実機E2Eも実施してください。ログ、DB、利用者設定、検証報告書をリポジトリへ追加しないでください。
