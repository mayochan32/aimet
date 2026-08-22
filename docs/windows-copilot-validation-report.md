# AIMET Windows Copilot E2E検証・修正レポート

検証日: 2026-08-22（JST）

## 1. 結論

Windows実機でGitHub Copilotのシングルエージェントとマルチエージェントを実際に実行し、AIMETによるトークン、キャッシュ、AI Credits、親子関係の収集結果を、生ログから独立計算した値と照合した。

検証結果は成功であり、今回採取したセッションでは次を確認した。

- 現行Copilotの`globalStorage`ログを収集できる。
- シングルエージェントとサブエージェントを識別できる。
- 親と子のトークン、AI Creditsが生ログと一致する。
- `main.jsonl`と`chatSessions`の重複による二重カウントがない。
- 同一ログの再収集でDB行や合計が増えない。
- Windows固有のパス探索が機能する。
- プロジェクトを特定できるログでは、`globalStorage`でも復元できる。
- 確実な根拠がない場合は、誤推測せず`project = unknown`とする。

実装、README、E2E手順は検証ブランチへpush済みで、GitHub Actionsも成功している。

## 2. 対象ブランチと成果物

- リポジトリ: `mayochan32/aimet`
- ブランチ: `codex/copilot-accounting-fix`
- 検証実装コミット: `9b9ce9d9a227aa83ec9d68c1bc2ce4c23c157d3c`
- コミットメッセージ: `fix: support current Copilot global storage logs`

リンク:

- [検証ブランチ](https://github.com/mayochan32/aimet/tree/codex/copilot-accounting-fix)
- [検証実装コミット](https://github.com/mayochan32/aimet/commit/9b9ce9d9a227aa83ec9d68c1bc2ce4c23c157d3c)
- [GitHub Actions実行結果](https://github.com/mayochan32/aimet/actions/runs/32560729934)
- [README](../README.md)
- [Windows Copilot E2E手順](windows-copilot-e2e.md)

## 3. 検証環境

| 項目 | 検証環境 |
|---|---|
| OS | Windows 11 Pro 25H2、x64 |
| OS build | `26200.8973` |
| VS Code | Stable `1.134.0`、x64 |
| VS Code commit | `110a328ea54b42367b803ec53ee0bf52ef26b419` |
| GitHub Copilot | VS Code同梱版 `0.62.0` build `1` |
| Copilot対応VS Code | `^1.134.0` |
| Node.js | `v24.11.1`、x64 |
| npm | `11.6.2` |
| PowerShell | Windows PowerShell `5.1.26100.8972` |
| Git | Git for Windows `2.46.0.windows.1` |

Microsoft公式更新APIは、インストールされているVS Code 1.134.0に対して`204 No Content`を返した。このため、検証時点でVS Code Stableに利用可能な更新はない。

VS Code本体の開発ブランチにはCopilot `0.63.0`が存在するが、これはVS Code `1.135.0`向けである。現在のStable 1.134.0では、同梱Copilot `0.62.0`が対応する最新版となる。

参考情報:

- [Microsoft公式Copilot package.json](https://github.com/microsoft/vscode/blob/main/extensions/copilot/package.json)
- [GitHub Copilot Marketplace](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot)
- [VS Code 1.134 release notes](https://code.visualstudio.com/updates/v1_134)
- [Windows 11 release information](https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information)

## 4. 実施したWindows実機E2E

### 4.1 シングルエージェント

VS Code CLIから新しいCopilot Agentウィンドウを起動し、添付ファイルの先頭行と末尾行を回答させた。

プロンプトでは次を禁止した。

- サブエージェントへの委任
- ファイル編集
- ターミナルコマンド実行

これにより、親単体のLLM利用量を検証した。

### 4.2 マルチエージェント

2つの異なる入力ファイルを添付し、親エージェントへ次を指示した。

- サブエージェントを正確に2つ起動する。
- 2つを並列実行する。
- 各子は別々のファイルを読む。
- 親は子の結果をまとめるだけとする。
- ファイル編集とターミナル実行は禁止する。

これにより、親1セッションと子2セッションを生成した。

### 4.3 検算方法

Copilotが生成した次のログを採取した。

```text
main.jsonl
runSubagent-*.jsonl
chatSessions/*.jsonl（存在する場合）
```

その後、次の順序で検証した。

1. AIMETで一時SQLite DBへログを収集する。
2. AIMET本体とは独立した検算器でJSONLを直接解析する。
3. 各`llm_request`の値を直接合計する。
4. 同じ`spanId`を重複排除する。
5. DBの各セッション行と比較する。
6. 同じログをもう一度収集する。
7. 追加・更新が発生しないことを確認する。

通常利用中の`~/.aimet/metrics.db`は使用せず、E2E専用の一時DBを使用した。

## 5. 実測結果

### 5.1 セッション構成

| 種別 | セッション数 |
|---|---:|
| シングルエージェント | 1 |
| マルチエージェント親 | 1 |
| サブエージェント | 2 |
| 合計 | 4 |

### 5.2 セッション別の実測値

| セッション | 非キャッシュinput | cacheRead | output | AI Credits | LLM requests |
|---|---:|---:|---:|---:|---:|
| マルチ親 | 16,480 | 16,094 | 422 | 0.4453182 | 2 |
| 子1 | 734 | 43,629 | 236 | 0.1205082 | 2 |
| 子2 | 22,280 | 22,113 | 267 | 0.5699124 | 2 |
| シングル | 15,998 | 0 | 35 | 0.3637215 | 1 |
| 合計 | 55,492 | 81,836 | 960 | 1.4994603 | 7 |

AI Creditsを1クレジットあたり`$0.01`として扱う場合、実測コストは次のとおり。

```text
1.4994603 × $0.01 = $0.014994603
```

すべての対象セッションで、次のDB項目が生ログから直接計算した値と一致した。

- `parent_session_id`
- `input_tokens`
- `cache_read_tokens`
- `output_tokens`
- `cost_usd`
- `cost_source = actual`
- `estimated = 0`
- `metric_scope = own`

### 5.3 再収集結果

1回目:

```text
scanned 4 files: +4 new, ~0 updated, 0 unchanged, 0 errors
```

2回目:

```text
scanned 4 files: +0 new, ~0 updated, 4 unchanged, 0 errors
```

再収集による行追加、数値増加、更新は発生しなかった。

## 6. 今回新しく判明した問題

### 6.1 Copilotログの格納先が変更されている

従来版ではデバッグログが次に保存されていた。

```text
User/workspaceStorage/<workspace-hash>/
  GitHub.copilot-chat/
    debug-logs/<parent-id>/
```

現行版では次へ移動している。

```text
User/globalStorage/
  github.copilot-chat/
    debug-logs/<parent-id>/
```

従来の`workspaceStorage`だけを探索すると、現行版の親の`main.jsonl`と子ログを見落とす。結果として、親内部のLLM呼び出しやサブエージェントの利用量が過少計上される。

### 6.2 現行版ではシングルエージェントにも`main.jsonl`が生成される

以前は、シングルエージェントは`chatSessions`、マルチエージェントは`main.jsonl`と`runSubagent-*`に分かれると想定していた。

しかし現行Copilotでは、委任しないシングルエージェントにも`main.jsonl`が生成された。このため、旧E2Eの「シングルエージェントでは`chatSessions`が最低1件必要」という条件は正しくなかった。

修正後はログの種類ではなく、トップレベルセッションであり、子を持たず、1件以上のLLMリクエストがあることを確認する。これにより新旧両形式のシングルエージェントを検証できる。

### 6.3 デバッグ設定名が変更されている

現行版で利用できる設定は次のとおり。

```json
{
  "github.copilot.chat.agentDebugLog.fileLogging.enabled": true
}
```

旧設定は次のとおり。

```json
{
  "github.copilot.chat.agentDebugLog.enabled": true
}
```

現行版では旧設定が設定画面に表示されず、ファイルロギング設定へ統合されている。

対応方針は次のとおり。

- 現行版では`fileLogging.enabled`を有効化する。
- 旧設定が存在するバージョンでは両方を有効化できる。
- AIMET側は設定値そのものには依存せず、実際に存在する新旧ログを探索する。
- READMEとE2E手順では現行設定を主として案内する。

参考:

- [VS Code公式Copilot設定定義](https://github.com/microsoft/vscode/blob/main/extensions/copilot/package.nls.json)
- [VS Code同梱Copilot package.json](https://github.com/microsoft/vscode/blob/main/extensions/copilot/package.json)

### 6.4 `globalStorage`ではプロジェクト情報を直接復元できない

従来の`workspaceStorage`では、ログの近くにある`workspace.json`からプロジェクトパスを復元できる。

現行の`globalStorage`では次の問題がある。

- 全ワークスペース共通の保存場所である。
- ログの近くに`workspace.json`がない。
- span traceの`session_start`にworkspaceパスがない場合がある。
- ログを収集したカレントディレクトリと、対象セッションのプロジェクトが同じとは限らない。

この状態で収集時のカレントディレクトリを採用すると、別案件へコストを誤配賦する危険がある。

### 6.5 同一セッションのログが複数存在する

同じ親セッションについて次が両方存在する場合がある。

```text
chatSessions/<session-id>.jsonl
debug-logs/<session-id>/main.jsonl
```

両方の数値を合計すると、同一親セッションを二重計上する。ただし、それぞれ保持する情報が異なる。

| 情報源 | 強み |
|---|---|
| `chatSessions` | workspaceとの関連を取得できる場合がある |
| `main.jsonl` | 親内部のLLM呼び出し、cache、AI Creditsが詳細で正確 |

したがって、どちらかを単純に捨てるのではなく、メトリクスとメタデータを区別して扱う必要がある。

## 7. 行った修正

### 7.1 新旧ログ保存先の自動探索

Stable、Insiders、VSCodiumそれぞれについて、次を両方探索する。

```text
User/workspaceStorage
User/globalStorage/github.copilot-chat
```

Windowsでは`%APPDATA%\<product>\User`を基準とし、`APPDATA`がない場合は`<home>\AppData\Roaming\<product>\User`へフォールバックする。

非標準のuser-data-dirは`AIMET_COPILOT_DIR`で追加できる。Windowsの複数パスはセミコロン区切りとする。

```powershell
$env:AIMET_COPILOT_DIR = 'D:\VSCodeData\User;E:\VSCodiumData\User'
```

### 7.2 `main.jsonl`と参照された子ログのspan解析

現行版では、親の`main.jsonl`にある`child_session_ref.attrs.childLogFile`を子ファイル名の正式な根拠とする。Microsoftの現行VS Codeソースで説明されている`runSubagent-*`と`searchSubagent-*`は、参照が欠けた旧ログや部分コピー用の互換フォールバックとしても認識する。UI用の`title-*`、`categorization-*`、`summarize-*`は作業セッションとして集計しない。

親と子のspan traceから、リクエスト単位で次を取得する。

- セッションID
- 親セッションID
- モデル
- input tokens
- cached tokens
- output tokens
- `copilotUsageNanoAiu`
- `aiu`
- 開始・終了時刻
- LLMリクエスト数

`inputTokens`には`cachedTokens`が含まれるため、次のように分離する。

```text
非キャッシュinput = inputTokens - cachedTokens
cacheRead = cachedTokens
```

同一`spanId`は一度だけ集計する。

AI Creditsは`copilotUsageNanoAiu`、`aiu`の順に使用し、欠損したリクエストだけモデル単価によるAPI換算へフォールバックする。

結果は次のように区別する。

- 全件実測: `actual`
- 実測と推定の混在: `mixed`
- 全件推定: `estimated`

### 7.3 親子集計の修正

VS Code Copilotの実ログでは、親と子がそれぞれ自分自身のLLM呼び出しを保持していた。

そのため、`main.jsonl`と参照された子JSONLはいずれも`metric_scope = own`とする。

親子合計は次の式となる。

```text
合計 = 親自身 + 子1自身 + 子2自身 + ...
```

一方、親がすでに子を含む累計形式では`metric_scope = tree`を使用し、子を合計へ再加算しない。

この規則を通常レポート、セッション詳細、Markdownレポート、期間別・プロジェクト別集計で共通化した。

### 7.4 同一セッションの情報源優先順位

同じ`session_id`に複数候補がある場合、次の順位を使う。

```text
main.jsonl / child_session_refで参照された子JSONL
  > chatSessions/*.jsonl
  > その他
```

DBの主キーは`(tool, session_id)`である。このため、同じ親IDの`main.jsonl`と`chatSessions`が別行として保存されることはない。

処理規則:

- `main.jsonl`のメトリクスを採用する。
- `chatSessions`の数値は加算しない。
- `main.jsonl`の数値を`chatSessions`で置き換えない。
- `main`のprojectが不明で、`chatSessions`だけが確実なprojectを持つ場合、projectメタデータだけ補完する。
- 取り込み順序が逆でも最終結果を同じにする。

### 7.5 `globalStorage`のプロジェクト特定

次の優先順位でプロジェクトを決定する。

| 優先度 | 情報源 | 処理 |
|---:|---|---|
| 1 | `session-store.db` | `sessions.id`とセッションIDを完全一致させ、`cwd`を採用 |
| 2 | 近傍の`workspace.json` | 旧`workspaceStorage`ログからfolder/workspace URIを復号 |
| 3 | ログ中のファイル参照 | 登録済みworkspaceのうち1件だけに属する場合に採用 |
| 4 | 同一IDの別ログ | `chatSessions`の既知projectを`main`へ補完 |
| 5 | 親セッション | 子が不明なら既知の親projectを継承 |
| 6 | 特定不能 | `unknown`として保存 |

`session-store.db`の使用条件:

- 読み取り専用で開く。
- `sessions.id`と`sessions.cwd`だけを利用する。
- 会話本文や`turns`は参照しない。
- WALの更新もキャッシュ更新判定へ含める。
- DBがない、スキーマが違う、一時的に読めない場合も収集全体を失敗させない。

ファイル参照による補完では、任意の添付ファイルの共通親を勝手にプロジェクトとして採用しない。既存の`workspace.json`へ登録されているworkspaceとの一致だけを使用し、複数候補が一致する場合は`unknown`のままとする。レビュー後の修正では`userRequest`、プロンプト、メッセージ本文などの自由記述を判定対象から除外し、構造化されたファイル／URI／ツール引数だけを使用する。

また、DBへ`project_source`を保存する。親継承や構造化参照より`workspace.json`と`session-store.db`を高く評価し、後の再収集でより確実な根拠が得られた場合は、イベント時刻が同じでもprojectメタデータだけを更新する。トークン、cacheRead、output、AI Creditsは更新しない。

### 7.6 Windows固有処理

次を追加・検証した。

- `%APPDATA%`優先
- Stable、Insiders、VSCodium探索
- Windowsの`;`区切り
- `C:\...`形式
- Windowsの`file://` URI
- ドライブ文字の前に付く不要な`/`の除去
- 空白を含むパス
- 非ASCII文字を含む一時パス
- UTF-8 BOM付きJSONL
- PowerShell 5.1でのE2Eスクリプト構文

## 8. 二重カウントの検証結果

今回の実機検証では、二重カウントは発生していない。

根拠は次のとおり。

### 8.1 同じ親の`main`と`chatSessions`

- 同一`session_id`を使用する。
- 同一DB主キーに保存される。
- `main`のsource rankが高い。
- `chatSessions`のメトリクスは加算されない。

### 8.2 親と子

- 親は`metric_scope = own`。
- 子も`metric_scope = own`。
- 親と各子をそれぞれ1回だけ加算する。

### 8.3 同じLLM span

- `spanId`単位で重複排除する。

### 8.4 再収集

- 2回目は追加0。
- 更新0。
- 4件すべて`unchanged`。

### 8.5 独立検算

AIMET本体とは別の検算器が、生ログのLLM spanを直接合計した値とDBを比較し、全項目が一致した。

また、匿名化した実ログgolden fixtureでも、親1セッション、子4セッション、合計`22.0478895 AI Credits`を固定値検証している。

## 9. テスト結果

### 9.1 ローカル自動テスト

```text
tests: 40
pass: 40
fail: 0
```

主なテスト対象:

- Copilot差分ログのSet、Push、Delete
- `requests`配列の穴
- プロトタイプ汚染防止
- span ID重複排除
- AI Creditsの実測、混在、推定
- 親子リンク
- `own`、`tree`集計
- `main`優先
- projectメタデータのみの補完
- 子のproject継承
- 再収集の冪等性
- Windowsパス
- `globalStorage`探索
- `session-store.db`
- 登録済みworkspaceとの一意照合

### 9.2 GitHub Actions

CIは成功した。

| OS | Node.js |
|---|---|
| Ubuntu latest | 22.x / 24.x |
| Windows latest | 22.x / 24.x |
| macOS latest | 22.x / 24.x |

合計6構成で`npm ci`、TypeScript build、全自動テストを実行した。WindowsではPowerShell E2Eスクリプトの構文解析も実行した。

## 10. README・E2E手順への反映

READMEには次を追加した。

- Copilotログが複数箇所に存在する理由
- 新旧保存先一覧
- OS、VS Code製品ごとの探索方法
- ログ選択順位
- `main`と`chatSessions`の重複防止
- 親子の`own`、`tree`規則
- AI Creditsの実測と推定フォールバック
- `globalStorage`のproject特定方法
- `session-store.db`の参照範囲
- `unknown`が正しい場合
- デバッグ設定の新旧互換
- Windows実機検証環境
- バージョン情報の確認元と公式URL
- 将来の再検証時の注意

E2E手順には次を追加・修正した。

- 現行`globalStorage`の探索
- 新旧両方のログルート監視
- シングルにも`main.jsonl`が生成される挙動
- 独立検算器による成功条件
- AI Creditsを消費すること
- 通常のAIMET DBを使用しないこと
- native Windowsで実行すること
- Copilotサインイン、Agent mode、runSubagentの前提

## 11. 残る制約

### 11.1 空ウィンドウでは`project = unknown`になる場合がある

今回のE2Eは`code chat -n`で新しい空ウィンドウを開く。この場合、Copilot側に次の情報が残らないことがある。

- `session-store.db`の`cwd`
- 対応する登録済みworkspace
- workspaceを示す一意なファイル参照

その場合の`unknown`は不具合ではなく、誤配賦を防ぐための正しい結果である。トークン、cacheRead、output、AI Credits、親子集計には影響しない。

### 11.2 デバッグファイルロギングが必要

デバッグログがない場合でも`chatSessions`から取得できる範囲は集計できる。ただし、次は完全には復元できない。

- 親内部の全LLMリクエスト
- サブエージェントの正確な利用量
- リクエスト単位のcacheRead
- リクエスト単位のAI Credits

### 11.3 Copilot更新による再変更

次はバージョン依存であり、将来変更される可能性がある。

- `globalStorage`のディレクトリ構造
- `session-store.db`のスキーマ
- span traceのフィールド
- デバッグ設定名
- シングルエージェントのログ形式

VS CodeまたはCopilotの大型更新後は、同じE2Eを再実行する必要がある。

## 12. 本開発への統合提案

実装は次の条件を満たしている。

- Windows実機E2E成功
- 生ログとの独立照合成功
- 二重カウントなし
- 再収集の冪等性確認済み
- 40件のローカルテスト成功
- 6構成のGitHub Actions成功
- README、運用手順更新済み

統合前レビューでは特に次を確認することを推奨する。

1. `session-store.db`を読み取り専用で参照する設計
2. `main`をメトリクス源として優先する設計
3. `chatSessions`からprojectだけを補完する設計
4. `unknown`を無理に推測しない方針
5. `own`、`tree`による親子集計規則

これらに問題がなければ、`codex/copilot-accounting-fix`を`master`へ統合できる状態と判断する。
