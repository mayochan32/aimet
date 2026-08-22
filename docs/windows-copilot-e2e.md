# Windows実機でCopilot計測を検証する手順

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
3. 次の2項目を検索し、どちらも有効にします。
   - `github.copilot.chat.agentDebugLog.enabled`
   - `github.copilot.chat.agentDebugLog.fileLogging.enabled`
4. Copilot ChatをAgent modeにし、ツール一覧で `agent/runSubagent` が有効であることを確認します。
5. VS Codeを一度終了して再起動します。

VS Codeの公式設定リファレンスでも、この2つがAgent Debug Logとファイル出力の設定として定義されています。

- [VS Code: AI settings reference](https://code.visualstudio.com/docs/agents/reference/ai-settings#_debugging-settings)
- [VS Code: Subagents](https://code.visualstudio.com/docs/agents/run/subagents)

## 3. 検証ブランチを取得する

既にaimetをclone済みの場合は、リポジトリのフォルダで次を実行します。

```powershell
git fetch origin
git switch codex/copilot-accounting-fix
git pull --ff-only
git rev-parse --short HEAD
```

最後の出力が `bb7a585` またはそれより新しいコミットであることを確認します。

まだcloneしていない場合は、作業したいフォルダで次を実行します。

```powershell
git clone --branch codex/copilot-accounting-fix https://github.com/mayochan32/aimet.git
Set-Location aimet
```

## 4. 事前確認を実行する

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

## トラブルシューティング

### `VS Code CLI (code/code-insiders/codium) was not found`

VS Codeを標準の場所にインストールするか、VS Codeのインストーラで `Add to PATH` を有効にします。PowerShellを再起動してから再実行してください。

### `workspaceStorage was not found`

VS Codeで一度任意のフォルダを開き、Copilot Chatを1回実行してから再試行します。非標準のuser-data-dirを使っている場合は、PowerShellで次を設定してから実行します。

```powershell
$env:AIMET_COPILOT_DIR = 'D:\path\to\User\workspaceStorage'
npm run test:e2e:copilot-windows
```

### `Timed out waiting for Copilot logs`

次を順番に確認します。

1. VS CodeでGitHub Copilotがサインイン済みか
2. Agent modeと `agent/runSubagent` ツールが利用できるか
3. 2つのAgent Debug Log設定が有効か
4. VS CodeのChat画面にエラーや確認待ちが出ていないか
5. 次のコマンドで `main.jsonl` と `runSubagent-*.jsonl` が生成されているか

```powershell
Get-ChildItem "$env:APPDATA\Code\User\workspaceStorage" -Recurse -File |
  Where-Object { $_.Name -eq 'main.jsonl' -or $_.Name -like 'runSubagent-*.jsonl' } |
  Select-Object FullName, Length, LastWriteTime
```

### マルチエージェントだけ失敗する

Copilot Chatのツール一覧で `agent/runSubagent` を明示的に有効にします。組織ポリシーでAgent modeやサブエージェントが禁止されている場合は、GitHub組織の管理者に確認してください。

## Windows版ChatGPT / Codexに実行を任せる場合

Windows PCでこのリポジトリを開いたChatGPT / Codexに、次の指示を送ってください。

```text
docs/windows-copilot-e2e.md に従ってWindows実機のCopilot E2Eを実行して。
VS CodeとCopilotのサインイン状態を確認し、npm run test:e2e:copilot-windows を実行すること。
成功時はPowerShellの最後の出力とwindows-copilot-e2e.jsonの内容を報告して。
失敗時は勝手に本番DBを変更せず、どの事前条件または照合が失敗したかを報告して。
```
