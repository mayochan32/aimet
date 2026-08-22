# aimet Windows実機 init・フック登録検証作業依頼書

## この文書の目的

この文書は、aimetの事前知識やこれまでの会話を持たないAIが、ネイティブWindows PC上で今回の`aimet init`修正を検証するための完結した作業依頼書です。WSLは対象外です。

作業の目的は、Claude Code、Codex、GitHub Copilotの初期化について、次をWindows実機で証明することです。

1. 別のコマンドに`aimet hook <tool>`という文字列が含まれていても、登録済みと誤判定しない。
2. 正しいフック構造の`type: "command"`とコマンド全文が一致した場合だけ登録済みと判定する。
3. 未作成の明示パスでも`--dry-run`は配置予定を表示し、ディスクへは書き込まない。
4. 通常実行は既存設定を保持し、`.bak`を作成し、必要なフックとプロンプトを配置する。
5. 2回実行してもフックが重複しない。
6. 既存設定が不正なJSONなら、上書きせずエラーで停止する。

この検証ではVS Code Copilotへの実プロンプト送信は行いません。AI Creditsは消費しません。

## プロジェクトとバグの背景

- プロジェクト: **aimet — AI Metrics**
- GitHub: <https://github.com/mayochan32/aimet>
- 検証対象ブランチ: `codex/copilot-accounting-fix`
- 言語: TypeScript / Node.js
- 必要なNode.js: 22.5以上

aimetはClaude Code、Codex、GitHub Copilotのローカルセッションログからトークン量、AI Credits、コスト、作業時間、親子エージェント関係を収集するCLIツールです。`aimet init <tool>`は、セッション終了時の収集フックと`/metrics`用プロンプトを各ツールの設定領域へ配置します。

修正前はフックが登録済みかどうかを次のように判定していました。

```ts
JSON.stringify(list).includes('aimet hook claude')
```

この部分一致では、例えば次の別コマンドも登録済みと誤判定します。

```text
echo aimet hook claude disabled
```

その結果、本来必要な`aimet hook claude`が追加されない可能性がありました。CodexとCopilotも同じ方式だったため対象です。修正後はJSON構造を読み、期待するフック構造、`type: "command"`、コマンド全文の3条件で判定します。

今回の修正は`aimet init`に関するものです。ログ収集、トークンパース、AI Credits、親子集計、二重カウント防止の実装は変更していません。

## 主な関係ファイル

| ファイル | 役割 |
|---|---|
| `src/init.ts` | フック登録、プロンプト配置、dry-run、バックアップ |
| `src/paths.ts` | Claude / Codex / VS Codeの保存ルート解決 |
| `test/init.test.js` | 今回分離した初期化専用テスト |
| `test/paths.test.js` | Windowsパスとログ自動探索テスト |
| `test/security.test.js` | 不正入力とテスト状態分離の確認 |

## 作業範囲と禁止事項

- Windows 10 / 11のPowerShell上で実行する。WSLは使わない。
- テスト実行、結果確認、失敗原因の診断までを行う。
- 通常のユーザー設定や`~/.aimet/metrics.db`をテストに使わない。テストはOSの一時ディレクトリだけを使う。
- `master`へのmerge、`main`の削除、強制push、履歴の書き換えは行わない。
- テスト失敗を通すために期待値を弱めたり、skipしたりしない。
- 追加修正が必要な場合は、原因、再現手順、修正範囲を先に報告する。

## 受け入れ条件

次のすべてを満たした場合のみ合格です。

1. ブランチは`codex/copilot-accounting-fix`で、ローカルHEADとリモートHEADが一致する。
2. `npm test`が成功する。
3. Windowsではテスト54件がすべて成功し、失敗0件、skip 0件になる。
4. `test/init.test.js`の5件がすべて成功する。
5. Windows専用の`Windows collect discovers Copilot logs from APPDATA without --dir`がskipされず成功する。
6. `git diff --check`がエラーなしで完了する。
7. テスト後の`git status --short`が空であり、テストがリポジトリやユーザ設定にファイルを残していない。

## 1. 必要な環境

- Windows 10またはWindows 11
- PowerShell
- Git for Windows
- Node.js 22.5以上（Node.js 22または24を推奨）
- npm

Claude Code、Codex、VS Code、GitHub Copilotのインストールやサインインは不要です。

PowerShellで次を実行します。

```powershell
$env:OS
git --version
node --version
npm --version
```

- `$env:OS`は`Windows_NT`であること。
- Node.jsは`v22.5.0`以上であること。

## 2. 検証ブランチを取得する

既にリポジトリがある場合:

```powershell
git fetch origin
git switch codex/copilot-accounting-fix
git pull --ff-only
git rev-parse HEAD
git rev-parse origin/codex/copilot-accounting-fix
git status --short
```

2つのコミットIDが完全に一致し、`git status --short`が空であることを確認します。未コミット変更がある場合は破棄せず、その状態を報告してください。

まだcloneしていない場合:

```powershell
git clone --branch codex/copilot-accounting-fix https://github.com/mayochan32/aimet.git
Set-Location aimet
git rev-parse HEAD
```

## 3. 依存関係とビルドを確認する

```powershell
npm ci
npm run build
```

どちらもエラーなしで完了することを確認します。

## 4. 初期化専用テストを実行する

```powershell
node --test test/init.test.js
```

次の5テストがすべて成功することを確認します。

```text
init dry-run reports missing configured roots without creating them
normal init creates files, preserves settings, backs up, and stays idempotent
similar text or a wrong-shaped command does not masquerade as an installed hook
normal Copilot init does not create a missing configured VS Code user directory
all init targets refuse invalid JSON without overwriting it
```

このテストは日本語と空白を含むWindows一時パスを使い、Claude、Codex、Copilotの実際の設定ファイル書き込み処理を実行します。ただし保存先はOSの一時ディレクトリに注入されるため、実ユーザー設定は変更しません。

## 5. 全自動テストを実行する

```powershell
npm test
```

Windowsでの期待値:

```text
tests 54
pass 54
fail 0
skipped 0
```

特に次のWindows専用テストがskipではなく成功していることを確認します。

```text
Windows collect discovers Copilot logs from APPDATA without --dir
```

## 6. 作業ツリーの汚染と差分を確認する

```powershell
git diff --check
git status --short
```

- `git diff --check`は出力なし、終了コード0が期待値です。
- `git status --short`は出力なしが期待値です。
- 出力がある場合は勝手に破棄せず、ファイル名と状態を報告してください。

## 7. 合否を判定する

次のすべてが確認できた場合だけ「合格」と報告します。

- Windowsネイティブ環境である。
- 対象ブランチとリモートHEADが一致している。
- 初期化専用5テストが全件成功した。
- 全自動テスト54件が全件成功し、失敗とskipが0件だった。
- Windows専用APPDATA収集テストが成功した。
- 作業ツリーがテストによって変更されていない。

## 8. 失敗時の切り分け

### 初期化専用テストが失敗する

失敗したテスト名とAssertionErrorの内容を省略せず報告してください。次のどの段階で失敗したかを区別します。

- dry-runが未作成パスを表示しない。
- dry-runがファイルまたはディレクトリを作成した。
- 既存設定のキーが失われた。
- `.bak`が作成されない。
- 2回目の実行でフックが重複した。
- 別コマンドや間違った構造を登録済みと誤判定した。
- 不正JSONを上書きした。

### Windows専用テストがskipされる

`$env:OS`が`Windows_NT`かを確認してください。Git BashやWSLではなく、PowerShellから実行します。

### ビルドに失敗する

Node.jsバージョンが22.5以上か、`npm ci`が成功しているかを確認します。原因の切り分けなしに依存バージョンやテスト条件を変更しないでください。

## 9. 最終報告の形式

成功・失敗のどちらでも、次の形式で報告してください。

```text
【結論】合格 / 不合格 / 事前条件不足で未実行
【環境】Windowsバージョン、Node.jsバージョン、npmバージョン
【リポジトリ】ブランチ、HEADコミット、リモートHEADとの一致
【初期化テスト】pass / fail / skip数、5つのテスト名と結果
【全テスト】tests / pass / fail / skipped数
【Windows専用】APPDATA自動探索テストの結果
【作業ツリー】git diff --checkとgit status --shortの結果
【補足】警告、失敗原因、未解決事項
```

## Windows版ChatGPT / Codexへ渡す短い指示

次の文面をWindows PC上のChatGPT / Codexに送ってください。

```text
あなたはWindows実機上でaimetの初期化とフック登録修正を検証する担当者です。
これまでの会話やaimetの予備知識はありません。まず docs/windows-init-hook-validation.md を上から最後まで読み、プロジェクトの目的、バグの原因、修正内容、作業範囲、禁止事項、合格条件を理解してください。
その後、同文書の手順に従い、初期化専用テストと全自動テストをWindows PowerShellで実行してください。
人間の操作は必要ありません。実行と確認を可能な限り自動で進めてください。
成功時も失敗時も、文書の最終報告形式に従い、実行結果を根拠付きで報告してください。
```
