# aimet — AI Metrics

**Claude Code / Codex / GitHub Copilot のローカルセッションログから、AIエージェント開発にかかった時間・トークン数・API換算コストを採取するメトリクスツール。**

チームの管理API（組織機能）を使わず、各ツールが手元に残すセッションログとローカル索引だけを情報源にします。計測値はJSONLから取得し、現行Copilotのプロジェクト特定に限ってローカルの`session-store.db`も参照します。採取したデータはプロジェクトマネジメントの数値データ（工数見積もり、案件別コスト配賦、モデル選定の判断材料など）として利用できます。

- 依存パッケージゼロ（Node.js 22.5+ の `node:sqlite` を使用）
- データは `~/.aimet/metrics.db` （SQLite）に蓄積
- 冪等設計：何度実行しても二重計上しない

## 対応状況

| ツール | ログの場所 | 取得できるトークン | 状態 |
|---|---|---|---|
| Claude Code | `<Claude保存ルート>/projects/**/*.jsonl`（既定: `~/.claude`） | 実測（in / out / cacheR / cacheW、1h/5mキャッシュ内訳） | ✅ |
| Claude Code サブエージェント | `<Claude保存ルート>/projects/<project>/<session-id>/subagents/agent-<agent-id>.jsonl` | 親と独立した実測（in / out / cacheR / cacheW） | ✅ |
| Codex（CLI / IDE拡張 / ChatGPTデスクトップアプリのローカルCodex） | `<Codex保存ルート>/sessions/**/rollout-*.jsonl`（既定: `~/.codex`） | 実測（in / cached / out / reasoning）＋レート制限時系列 | ✅ |
| GitHub Copilot (VS Code Chat) | `workspaceStorage/<hash>/chatSessions/*.jsonl` + `workspaceStorage`（旧）または `globalStorage`（現行）の `debug-logs/<uuid>/main.jsonl` | 実測（in / cached / out）＋消費AI Credits | ✅ |
| GitHub Copilot サブエージェント | `workspaceStorage/<hash>/GitHub.copilot-chat`（旧）または `globalStorage/github.copilot-chat`（現行）の `debug-logs/<親uuid>/*Subagent-*.jsonl` | 実測（in / cached / out / AI Credits、リクエスト単位） | ✅ |
| GitHub Copilot CLI | `<Copilot CLI保存ルート>/session-state/<uuid>/events.jsonl`（既定: `~/.copilot`） | 実測（**出力トークンのみ**） | ✅ |

### Claude Code / Codexログの保存仕様と自動探索

aimetがトークン集計に使うのは、デバッグ用のテキストログではなく、各製品がセッション再開用に保存するJSONLトランスクリプトです。`aimet collect`を`--dir`なしで実行した場合、次の優先順位で保存ルートを決定します。`aimet init claude/codex`も同じルートを使うため、変更先と既定先の別々の場所へ設定を書くことはありません。

| ツール | 保存ルート | 主セッション | サブエージェント |
|---|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR`があればその値、なければ`~/.claude` | `projects/<project>/<session-id>.jsonl` | `projects/<project>/<session-id>/subagents/agent-<agent-id>.jsonl` |
| Codex | `CODEX_HOME`があればその値、なければ`~/.codex` | `sessions/YYYY/MM/DD/rollout-*.jsonl` | 親とは別の`rollout-*.jsonl`（ログ内の親IDで紐付け） |

- Windowsの`~/.claude`と`~/.codex`はユーザーホーム（通常は`%USERPROFILE%`）配下です。aimetはNode.jsが解決したホームを使い、Windows / macOS / Linuxで同じ規則を適用します。
- `--dir <path>`を指定した収集では、調査用の明示パスを優先し、上記の自動探索ルートを使いません。
- Claude Codeの公式仕様は、トランスクリプトのJSONL内部形式がバージョン間で変更され得ることも明記しています。aimetは既知形式をfixtureで固定テストしますが、Claude Code更新後は実ログでの再検証が必要です。
- Claude Codeで`CLAUDE_CODE_SKIP_PROMPT_HISTORY`または`--no-session-persistence`、Codexで`--ephemeral`を使ったセッションはローカルJSONLを保存しないため、aimetでは取得できません。
- Claude Codeの現行デバッグログは`<Claude保存ルート>/debug/`、Codexの運用ログは`<Codex保存ルート>/log/`です。これらはセッション別トークンの集計元ではありません。Claude Codeの旧`logs/`ディレクトリは現行版では書き込まれません。

#### Codexの対応クライアントと取得範囲

aimetのCodex対応はCLIのプロセスだけを識別しているのではなく、ローカルに保存された`rollout-*.jsonl`を収集する仕組みです。そのため、同じCodexのローカル実行基盤がセッショントランスクリプトを保存する次のクライアントを対象にできます。

- **Codex CLI**の通常セッション
- **Codex IDE拡張**のローカルセッション
- **ChatGPTデスクトップアプリの「Codex」**でフォルダを開いて実行したローカルタスク
- 上記から起動されたサブエージェント。親とは別のrolloutを読み、ログ内の親IDでグループ化します

ChatGPTデスクトップアプリには「ChatGPT」と「Codex」という異なる実行先があります。aimetが対象にするのは、`<Codex保存ルート>/sessions/`にrolloutが作られる**Codexのローカルタスクだけ**です。通常のChatGPTチャットやWorkの会話履歴を、ChatGPTアカウントやクラウドの履歴APIから取得する機能ではありません。`state_*.sqlite`などのアプリ内部の索引・状態DBも、トークン集計元には使用しません。

次のケースは取得できません。

- ChatGPTデスクトップアプリの通常の**ChatGPTチャット／Work**で、Codex rolloutが作られない会話
- ChatGPTのWeb版・モバイル版だけで行った会話
- **Codex cloud／remoteだけ**で完結し、ローカルへ同期・再開されずrolloutが存在しないタスク
- Codex CLIの`--ephemeral`など、セッション永続化を無効にした実行
- 収集前に削除・移動され、探索先に存在しなくなったrollout

クラウドタスクをローカルへ同期・再開した場合も、aimetが取得できるのはローカルのrolloutに実際に記録された範囲です。なお、rolloutのディレクトリ階層は**セッションを最初に作成した日付**です。後日デスクトップアプリで再開すると元の日付ディレクトリのファイルへ追記されるため、更新日のディレクトリだけを手作業で確認すると見落とします。aimetは`sessions/`以下を再帰探索するため、この再開ケースも収集できます。

##### Codexの`session_meta`重複とサブエージェント識別の注意

> [!CAUTION]
> Codexの公式資料では、サブエージェントが独立したAgent threadでモデル・ツール作業を行うことと、`SubagentStop`が子の`agent_id`と`agent_transcript_path`を渡すことは確認できます。一方、rollout JSONL内部の`session_meta`が何件現れるか、子と親のメタデータがどの順序で並ぶかは公開仕様で保証されていません。aimetは「最初の1件」や「最後の1件」という出現順序をセッション識別の根拠にしません。

2026-08-23の実機検証で、クライアントとCodexバージョンによって次の形状差を確認しました。これはOS固有の仕様ではなく、実測したクライアント／バージョンの差です。

- macOSのChatGPTデスクトップアプリで確認したCodex `0.142.3`～`0.148.0-alpha.9`の子17 rolloutは、いずれも子自身の`session_meta`を1件だけ持っていました。親rolloutに同一IDの`session_meta`が繰り返される例はありましたが、どのレコードを選んでも識別結果は同じでした。
- WindowsのVS Code拡張に同梱されたCodex `0.149.0-alpha.4.1`では、1つの子rolloutに「子の`thread_source: "subagent"`と`parent_thread_id`を持つメタデータ」と「親の`thread_source: "user"`を持つメタデータ」の両方が含まれる例を確認しました。検証ログでは子→親の順でしたが、その順序を保証する公式仕様は確認できません。

過去のパーサは`session_meta`を出現順に処理していたため、後から現れた親IDで子IDを上書きし、親と子が同じDB主キーになる不具合がありました。その結果、子が既存の親と重複したように扱われ、サブエージェントのトークンが集計から消える可能性がありました。

現行aimetは、次の順序非依存ロジックで処理します。

1. 1ファイル内のすべての`session_meta`を候補として読み取り、読み取り中はセッションIDを確定しません。
2. `rollout-<timestamp>-<uuid>.jsonl`のUUIDと候補の自スレッドIDが一致する場合は、その一致をファイル自身の識別候補を絞る整合性根拠にします。この対応関係もJSONLの公開安定APIではないため、後述の明示メタデータと矛盾しないことも確認します。
3. ファイル名だけで確定できない場合は、`thread_source: "subagent"`または`source.subagent`を持つ候補を子として優先します。子の自IDに`payload.id`を使い、親IDは現行形式の`payload.parent_thread_id`、それがない旧形式では子IDと異なる`payload.session_id`から取得します。
4. 同じ子ID・親IDのメタデータが複数回現れても同一候補として扱います。子→親、親→子のどちらの順序でも同じ結果になります。
5. 異なる子IDが複数候補になる、または同じ子IDに異なる親IDが紐付くなど、根拠が矛盾する場合は推測でDBへ保存しません。`aimet collect`は対象ファイルを収集エラーとしてstderrに表示し、最後の`N errors`に含めます。
6. IDと親子関係を決定した後、選ばれた各rolloutの`token_count.info.total_token_usage`の累積最大値を1回だけ保存します。`session_meta`の件数はトークンの加算回数に影響しません。

`aimet hook codex`はCodexの終了処理を失敗させないため、収集に失敗してもexit 0と有効なJSONを返します。Codex更新後や重要な集計の前は、手動の`aimet collect --tool codex`を実行して`0 errors`を確認してください。新しいログ形式を検出した場合は、ログ全体を公開せず、`session_meta`のIDやパスを匿名化した最小再現例で報告してください。

公式仕様で確認できる範囲と、aimetが互換性対応する内部ログの境界は次を参照してください。

- [OpenAI: Codex Subagents（子は独立したAgent threadでモデル・ツール作業を行う）](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenAI: Codex Hooks（`SessionEnd`は親のみ、`SubagentStop`は`agent_id`と`agent_transcript_path`を持つ）](https://learn.chatgpt.com/docs/hooks)

rollout JSONLの`session_meta`配置と順序は、上記の公式ページに安定仕様として記載されていません。そのためaimetは、公式に確認できる親・子のスレッド分離を前提にしつつ、既知のJSONL形式を自動テストと実機E2Eで継続的に検証します。

##### `CODEX_HOME`を変更するときの注意

OpenAIの公式仕様では、`CODEX_HOME`はCLI・IDE拡張・app-serverが使うCodex状態ルートで、未設定時は`~/.codex`です。aimetも**aimetプロセスから見える`CODEX_HOME`**を読み、`<CODEX_HOME>/sessions`を自動探索します。既定値を使う場合は通常、各クライアントとaimetが同じ場所を参照します。

カスタム値を使う場合は、Codexクライアントとaimetの双方から同じ`CODEX_HOME`が見えている必要があります。環境変数は設定ファイルに書いただけでは、すでに起動しているGUIアプリへ遡って反映されません。またmacOSでFinderから起動したアプリはシェルの`.zshrc`、Linuxのデスクトップランチャーは対話シェルの初期化ファイルを必ずしも読みません。Windowsでもユーザー／システム環境変数を変更した後は、起動済みのChatGPT・VS Code・ターミナルをいったん終了して起動し直してください。片方だけにカスタム値が設定されると、Codexは変更先へ保存する一方、aimetは既定の`~/.codex`を探索する（またはその逆）ため、ログが0件に見えます。

カスタム保存先を使う場合は、次のいずれかで探索先を一致させてください。

1. OSまたは各アプリの起動環境で同じ`CODEX_HOME`を設定し、Codexクライアントとaimetを再起動する。
2. 一時的な確認では`aimet collect --tool codex --dir <実際のCODEX_HOME>/sessions`と明示する。
3. `aimet init codex`を使う場合も、実行時の`CODEX_HOME`をCodexクライアントと一致させる。`init`と`collect`は同じ解決規則を使います。

`config.toml`の`log_dir`は運用・診断ログの保存先であり、セッショントランスクリプトの`sessions/`を移す設定ではありません。`log_dir`を変えても、aimetのrollout探索先は変わりません。

##### Codexの終了フックとaimet Skill

`aimet init codex`は、`<CODEX_HOME>/hooks.json`に親用の`SessionEnd`と子用の`SubagentStop`を登録します。Codex公式仕様では`SessionEnd`はメインスレッドにだけ発火し、子の終了は`SubagentStop`で通知されます。後者が渡す`agent_transcript_path`を優先的に取り込むことで、親だけでなく子のrolloutも終了時に収集します。`SessionEnd`は公式の上限である3秒に設定し、aimet側の失敗はCodexの終了処理を失敗させないようexit 0と有効なJSON出力で終了します。

対話からの呼び出しは、現行Codexの公式拡張形式であるSkillを使います。`$HOME/.agents/skills/aimet-metrics/`に`SKILL.md`と`agents/openai.yaml`を配置し、`$aimet-metrics`で明示的に呼び出せます。Skillのユーザー配置先は`CODEX_HOME`ではなく`$HOME/.agents/skills`である点に注意してください。旧版aimetが作成した`<CODEX_HOME>/prompts/metrics.md`が既にある場合は、利用者のファイルを勝手に削除せずそのまま残し、新規には作成しません。

公式仕様・実装の参照先：

- [OpenAI: Codex Hooks（イベント、JSON構造、`SessionEnd`の3秒上限、`agent_transcript_path`）](https://learn.chatgpt.com/docs/hooks)
- [OpenAI: Codex Skills（`SKILL.md`、`$HOME/.agents/skills`、`agents/openai.yaml`）](https://learn.chatgpt.com/docs/build-skills)
- [OpenAI: Codex Subagents（子は独自のモデル・ツール作業を行い、トークンを消費）](https://learn.chatgpt.com/docs/agent-configuration/subagents)

#### Claude Codeの親・サブエージェント識別と集計

Anthropicの公式仕様では、親会話の`sessionId`と、個々のサブエージェントの`agentId`は別の識別子です。ディスク上では次の階層になります。

```text
${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<project-key>/
  <session-id>.jsonl
  <session-id>/
    subagents/
      agent-<agent-id>.jsonl
```

Agent SDKの公式`SessionStore`も、トランスクリプトを`sessionId`だけでなく`(projectKey, sessionId, subpath)`で識別し、子を`subpath = subagents/agent-<id>`として扱います。`SubagentStop`フックでも、親の`session_id`と子の`agent_id`、`agent_transcript_path`が別フィールドで渡されます。したがって、子JSONL内の`sessionId`だけをDBキーにすると、親または兄弟の行と衝突する可能性があります。

aimetは以下の規則で取り込みます。

- 親の`session_id`はログ内の`sessionId`（欠落時は主JSONLのファイル名）です。
- `.../<parent-session-id>/subagents/agent-<agent-id>.jsonl`を公式配置の子ログと判定します。`subagents/`直下のその他のJSONLは取り込みません。
- 子のDB上の`session_id`は`<parent-session-id>/agent-<agent-id>`とし、`parent_session_id`に親IDを保存します。これはaimet内で一意にするための複合IDであり、Claude Codeが発行する新しいセッションIDではありません。
- 親と各子は別トランスクリプトの`assistant.message.usage`をそれぞれ合計し、どちらも`metric_scope = own`として保存します。レポートでは親1回＋各子1回だけを加算します。
- 同じAPIメッセージが再送・ストリーミングで複数行に現れても、`message.id`で重複排除します。サブエージェントを再開して同じファイルに追記された場合も、再収集でDB行を更新し、行数を増やしません。
- 子ログに`cwd`がない場合は、`subagents`と親IDの2階層をさかのぼった`<project-key>`からprojectをベストエフォートで復元します。`project-key`のハイフンが元パスの区切りか文字かは完全に逆変換できないため、正確性はログ内の`cwd`を優先します。

`aimet init claude`は、親用の`SessionEnd`だけでなく子用の`SubagentStop`も`settings.json`の公式の入れ子フック形式で登録します。`SubagentStop`が渡す`agent_transcript_path`を読むため、フック経由でも親と子のパスを取り違えません。フックにパスがない、またはファイルがまだ読めない場合は、Claude保存ルートの直近2日をフォールバック探索します。

親が子の最終結果を次の入力として読む場合、子の出力トークンと親の後続入力トークンの両方が計上されます。これらは別々のAPI利用で課金されるため、二重計上ではありません。二重計上となるのは、同じトランスクリプトまたは同じAPIメッセージを2回足した場合であり、上記のIDと重複排除で防ぎます。

> [!IMPORTANT]
> Claude Codeはサブエージェントトランスクリプトを`cleanupPeriodDays`（既定30日）に従って自動削除します。削除後の初回収集では子の利用量を復元できません。定期的に`aimet collect`を実行してください。一度aimetのDBへ取り込んだ行は、元JSONLが後で削除されても残ります。

この実装の根拠となるAnthropic公式情報：

- [Claude Code: サブエージェントのトランスクリプト配置・再開・保持期間](https://code.claude.com/docs/en/sub-agents)
- [Claude Code Hooks: `session_id`、`agent_id`、`agent_transcript_path`](https://code.claude.com/docs/en/hooks#subagentstop)
- [Claude Agent SDK SessionStore: `SessionKey`と子の`subpath`](https://code.claude.com/docs/en/agent-sdk/session-storage#subagent-transcripts)

公式仕様・実装の参照先：

- [Claude Code: Where transcripts are stored](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)
- [Claude Code: Application dataとWindowsの保存ルート](https://code.claude.com/docs/en/claude-directory#application-data)
- [Claude Code: サブエージェントのトランスクリプト](https://code.claude.com/docs/en/sub-agents)
- [OpenAI: Codexの`CODEX_HOME`仕様](https://learn.chatgpt.com/docs/config-file/environment-variables)
- [OpenAI: ChatGPTデスクトップアプリ（ChatGPTとCodexの選択）](https://learn.chatgpt.com/docs/app)
- [OpenAI: Codex App Server（リッチクライアントの共通基盤）](https://learn.chatgpt.com/docs/app-server)
- [OpenAI: Codex設定リファレンス（`log_dir`）](https://learn.chatgpt.com/docs/config-file/config-reference)
- [OpenAI公式ソース: rolloutの保存先とファイル名](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/recorder.rs)
- [OpenAI: Codex CLIの`--ephemeral`](https://developers.openai.com/codex/cli/reference)

> Copilot Chat（VS Code）のスナップショットは `User/workspaceStorage/`、デバッグログは従来版では同じ `workspaceStorage` 配下、現行版では `User/globalStorage/github.copilot-chat/` にあります。aimetはStable / Insiders / VSCodiumの新旧両方に加え、`VSCODE_PORTABLE`、`VSCODE_APPDATA`、Windowsの`APPDATA`、Linuxの`XDG_CONFIG_HOME`を自動探索に反映します。それ以外の非標準パスは `--dir` または `AIMET_COPILOT_DIR`（Windowsは `;`区切り、macOS/Linuxは `:`区切り）で指定できます。記録されるのは**Chat/エージェントモードの対話のみ**です。
>
> **Copilot CLI（`@github/copilot`）の注意**: レポート上は `copilot`（Chat版）と区別するため **`copilot-cli`** という別ツールとして集計します。CLIのログは**出力トークンしか記録しない**（入力・キャッシュのフィールドが存在しない）ため、`in` / `cacheR` / `cacheW` は **`-`（null）**、コストも **`-`（null）** になります。取得できるのは出力トークン・実行時間・ターン数・モデル・プロジェクトです。

### Copilot CLIログの保存先と`COPILOT_HOME`

Copilot CLIはセッションイベントを`<Copilot CLI保存ルート>/session-state/<session-id>/events.jsonl`に保存します。保存ルートは`COPILOT_HOME`が設定されていればその値、なければ`~/.copilot`です。aimetの`collect --tool copilot-cli`と`init copilot`も同じ解決規則を使います。相対パスの`COPILOT_HOME`はaimetのカレントディレクトリから絶対パス化します。

`~/.copilot/hooks/` はVS Code側のユーザーフック保存先でもあるため、`aimet init copilot`は標準位置の`~/.copilot/hooks/aimet.json`を必ず設定します。`COPILOT_HOME`が別ディレクトリを指す場合は、Copilot CLIも取りこぼさないよう`<COPILOT_HOME>/hooks/aimet.json`にも同じ`Stop`と`SubagentStop`フックを配置します。フックファイルには公式スキーマの`"version": 1`を付けます。

参照: [GitHub Copilot CLIの設定ディレクトリ](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference)、[GitHub Copilot Hooksリファレンス](https://docs.github.com/en/copilot/reference/hooks-reference)

Copilotの`Stop`（互換名。CLI形式では`agentStop`）は親エージェントの1ターン完了時、`SubagentStop`は対応する子の正常完了時に発火します。公式仕様上、組み込みの`general-purpose`エージェントだけは`SubagentStop`を発火しません。その場合も親の`Stop`でaimetが直近ログを探索し、親が参照する子デバッグJSONLをまとめて取り込むため、親のターン完了後には回収できます。これは子の終了直後ではなく親の完了時に反映されるというタイミング差であり、親子の加算規則は変わりません。

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

`aimet collect`を`--dir`なしで実行すると、VS Code公式実装と同じ優先順位でUserディレクトリを組み立てます。

| 優先順位 | 条件 | Userディレクトリ |
|---:|---|---|
| 1 | `VSCODE_PORTABLE` | `<VSCODE_PORTABLE>/user-data/User`（Portable Modeは単一製品ルート） |
| 2 | `VSCODE_APPDATA` | `<VSCODE_APPDATA>/<product>/User` |
| 3 | Windows | `%APPDATA%\<product>\User`（なければ`%USERPROFILE%\AppData\Roaming`） |
| 3 | macOS | `~/Library/Application Support/<product>/User` |
| 3 | Linux | `${XDG_CONFIG_HOME:-~/.config}/<product>/User` |

`VSCODE_PORTABLE`と`VSCODE_APPDATA`が両方ある場合はPortable Modeを優先します。相対パスはVS Codeと同様に`VSCODE_CWD`（なければaimetのカレントディレクトリ）から解決します。これらの環境変数は`aimet collect`プロセスから見える必要があります。

`<product>`は`Code`、`Code - Insiders`、`VSCodium`の3種類です（Portable Modeを除く）。それぞれについて次の2ルートを**両方**、再帰的に探索します。

```text
User/workspaceStorage
User/globalStorage/github.copilot-chat
```

このため、従来版と現行版のログが同じPCに残っていても、利用者がVS Codeのバージョンを指定する必要はありません。アクセスできない、または存在しないディレクトリは読み飛ばします。

VS Codeを`--user-data-dir <dir>`で起動した場合、その起動引数は別プロセスのaimetから取得できません。`AIMET_COPILOT_DIR=<dir>/User`で探索ルートを**追加**するか、収集時に`--dir <dir>/User`を指定してください。`AIMET_COPILOT_DIR`は複数指定も可能です。

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

参照: [VS Code公式ソースのuser-data-path解決](https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/node/userDataPath.ts)、[VS Code CLIの`--user-data-dir`](https://code.visualstudio.com/docs/configure/command-line#_advanced-cli-options)、[Portable Mode](https://code.visualstudio.com/docs/setup/portable)

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

従来版で`github.copilot.chat.agentDebugLog.enabled`も設定画面に表示される場合は、互換性のため両方を有効にします。現行版では旧設定は非推奨で、`fileLogging.enabled`へ統合されています。詳細は[VS Code公式AI設定一覧](https://code.visualstudio.com/docs/agents/reference/ai-settings)、[Chat Debug viewの公式トラブルシューティング](https://code.visualstudio.com/docs/agents/agent-troubleshooting/chat-debug-view)、[Microsoft公式Copilot設定定義](https://github.com/microsoft/vscode/blob/main/extensions/copilot/package.nls.json)を参照してください。

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

それでも、VS Codeでフォルダーを開かずに作成した空ウィンドウのセッションなど、Copilot自身が`cwd`を記録せず登録済みworkspaceとの対応もない場合は`project = unknown`が正しい結果です。Windows E2Eスクリプトで使う`code chat -n`も空ウィンドウを明示するため、このケースに該当します。これはinput／cacheRead／output／AI Creditsや親子集計の正確性には影響しませんが、`aimet report --by project`では`unknown`へまとめられます。

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

すべての修正とリリースでは、変更対象がモデル処理であるかどうかにかかわらず、作業時点の[OpenAI公式モデル一覧](https://developers.openai.com/api/docs/models)、[OpenAI公式料金](https://openai.com/api/pricing/)、[Anthropic公式料金](https://platform.claude.com/docs/en/about-claude/pricing)、[GitHub Copilot公式モデル別課金](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)を確認します。モデルID、別名、input / output / cache read / cache write、長文・高速・地域別などの条件付き料金を`src/pricing.ts`と照合し、変更がなくても確認日をPRまたは作業記録へ残してください。手順の詳細は[CONTRIBUTING.md](CONTRIBUTING.md)に記載しています。

パーサ、DB更新、集計、セキュリティ、macOS/Windowsのパス解決をfixtureベースで自動検証します。さらに、Windows実機でVS Code Copilotのシングル／マルチエージェントを起動し、生ログとDBを独立した検算器で照合するE2Eスクリプトも用意しています（VS CodeへのサインインとCopilotの利用権が必要）。

```powershell
npm run test:e2e:copilot-windows
```

スクリプトは現在のサインイン済みVS Codeプロファイルを使ってシングル／マルチエージェントを実行します。実行前後の標準ログルート（または`AIMET_COPILOT_DIR`）を比較し、今回作成・更新されたログだけを一時ディレクトリへコピーして、専用DBで検証します。作成された`main.jsonl`と参照された子JSONLを独立検算器が直接合計し、aimetのDBとトークン数・AI Credits・親子関係を照合します。VS CodeとCopilotへのサインインに加え、事前にデバッグファイルロギングを有効にしておく必要があります。テスト用workspace、添付ファイル、コピーしたログ、DB、結果JSONは一時ディレクトリに作成しますが、テスト会話と元のデバッグログは通常のVS Codeプロファイル側にも残ります。

このE2Eと以下のfixtureテストは**リポジトリをcloneした開発環境向け**です。npm配布パッケージは実行時コード、README、利用例、Codex Skillだけを含み、`test/`は含めません。配布パッケージを展開した場所でこのnpm scriptを実行するのではなく、上記のclone手順で取得したリポジトリから実行してください。

**`test/cli.test.js` — CLIバージョンとヘルプ**

- `aimet --version`が実行中の配布パッケージの`package.json`と同じバージョンを出力し、終了コード0になることを検証します。
- `aimet --help`がバージョン確認コマンドを含むUsageを表示し、終了コード0になることを検証します。
- `detail --file`で形式を決める`--tool`を必須とし、Copilotの子パスにChat用パーサを誤適用しないことを検証します。
- Codex/Claude系の`agent_transcript_path`とCopilot互換形式の`transcript_path`のどちらからでも子JSONLを取り込み、パスに一致するCopilot子パーサを選べること、DBエラーを含むフック失敗時もホスト向けの終了コードが0で、Codex向けは有効なJSONを返すことを検証します。

**`test/parsers.test.js` — 各ツールパーサの正しさ**

- **Claude**: assistantレコードの `usage` を合計し、`in` / `out` / `cacheR` / `cacheW` が期待値になること。リトライ/ストリーミングで**同じmessage IDが重複しても二重計上せず**、ターン数も過大計上しないこと。公式の`<session-id>/subagents/agent-<agent-id>.jsonl`配置では親と子を別行にし、同じ`sessionId`が記録されても衝突せず、親子合計に各1回だけ含まれること。途中に壊れたJSONL行があっても無視して処理を続けること。
- **未知モデルとゼロ使用量**: 単価表にないモデルの非ゼロ使用量はコストを`null`にすること。一方、in / out / cacheR / cacheWがすべて明示的に`0`なら、未知モデルでも正確な`$0`とすること。`null`（未計測）はゼロとみなさないこと。
- **Codex**: `token_count` の累積値から**最大値**を採用し、`input_tokens` から `cached_input_tokens` を差し引いて非キャッシュ入力に分離すること。reasoningトークンも取得すること。子→親と親→子の両方の`session_meta`順序で同じ親子IDになり、同一メタデータの重複は許容する一方、異なる子IDや親IDの矛盾はエラーにすること。
- **Codex（モデル不明）**: 既定単価にフォールバックしつつ、単価が推定であることを **`estimated: true`** で明示すること。
- **Copilot（Chat）**: ObjectMutationLogの`Set` / `Push` / `Delete`を順番どおり復元できること。`main.jsonl`と`child_session_ref`で参照された各子JSONLはスパンIDで重複排除し、親子のトークンとnano-AIUが生ログの値に一致すること。
- **Copilot（親子集計）**: `main.jsonl` を同じIDの `chatSessions` より優先し、親と子を各1回だけ加算すること。実ログから匿名化したgolden fixtureで **22.0478895 AI Credits** と正確なトークン数を固定値照合すること。
- **Copilot（プロジェクト特定）**: 現行`globalStorage`ログを同じセッションIDの`session-store.db.sessions.cwd`へ結び付けること。自由記述中のパスを帰属根拠にせず、より確実な`project_source`へ更新しても`main.jsonl`の数値を保ち、サブエージェントが親のプロジェクトを継承すること。
- **Copilot CLI**: 出力トークンを合計しターン数を数える一方、**入力トークンは未計測（`null`）**、コストも算出不可の **`null`** になること。壊れた行は無視すること。

**`test/store.test.js` — 保存と冪等性**

- `upsert` が `inserted → skipped → updated` と正しく遷移し、**同じログを何度取り込んでも行が増えない**こと（`last_event_at` による重複防止）。
- `collect` を同じログに再実行すると、2回目は**すべてskip**されること。
- Copilotの `own`（自分のみ）と `tree`（子を含む）の両形式で、report / session / Markdownが同じ二重計上防止規則を使うこと。
- 親子の一部でトークンまたはコストが`null`の場合、既知分だけを完全な合計に見せず、report / session / Markdownすべてで集計値も`null`にすること。

**`test/paths.test.js` — macOS / Windows互換性**

- `VSCODE_PORTABLE` / `VSCODE_APPDATA` / `%APPDATA%` / `XDG_CONFIG_HOME`の優先順位、Windowsのフォールバック、Stable / Insiders / VSCodium、新旧の `workspaceStorage` / `globalStorage`、`AIMET_COPILOT_DIR`の `;` 区切り、Windows `file://` URIを検証します。
- Portable Modeの変更先に置いたCopilot JSONLと、`CLAUDE_CONFIG_DIR` / `CODEX_HOME`の変更先に置いた実JSONLを`--dir`なしで収集し、DBへ取り込めることを検証します。
- `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `COPILOT_HOME`の既定値と上書きをmacOS / Linux / Windows形式で検証します。
- `session-store.db`のセッションID完全一致、構造化されたログ中のパスだけを使う安全な補完、自由記述の除外、より高信頼なプロジェクト根拠へのメタデータ限定更新を検証します。
- CIのWindowsジョブでは、`--dir` なしの自動探索から取り込みまで実行します。

**`test/init.test.js` — フックと対話コマンド／Skillの安全な初期化**

- Claude / Codex / Copilotそれぞれで、未作成の明示ルートをdry-runに表示しつつ、ファイルやディレクトリを作成しないことを検証します。
- 通常実行で既存設定を保持し、`.bak`を作り、親・子の両フックとClaude/Copilotのプロンプト、CodexのSkillを配置し、再実行してもフックが重複しないことを検証します。
- 別コマンドの部分文字列や間違ったフック構造を「登録済み」と誤判定せず、`type: command`とコマンドの完全一致で判定することを検証します。
- `COPILOT_HOME`が標準位置と異なるときは両方に`version: 1`付きの`Stop` / `SubagentStop`を1件ずつ配置し、Codexの旧`prompts/metrics.md`は削除・上書きしないことを検証します。
- `hooks`やイベント配列が不正な型の場合は、利用者設定を上書きせず停止することを検証します。
- 3ツールとも既存設定が不正なJSONなら上書きせず停止することを検証します。

**`test/security.test.js` — レビュー指摘の再発防止**

- **プロトタイプ汚染**: `__proto__` / `constructor` を含む細工Copilotログを読んでも `Object.prototype` が汚染されないこと。正当なデータは正しく復元されること。
- **SQLホワイトリスト**: `report` の `--by` / `--period` に想定外の値（例: `tool; DROP TABLE ...`）を渡すと、SQLを組み立てる前に例外で弾くこと。
- **pricing.json検証**: ユーザー単価表の不正エントリ（型不正・危険キー）は読み飛ばし、正当な上書きだけ採用すること。

**`test/examples.test.js` — 配布サンプルの品質**

- `examples/`の9種類（report、3ツールのsession、Claude/Codex/Copilot Chat/Copilotスパン/Copilot CLIのdetail）が欠けていないことを検証します。
- 個人ホームパスが残っていないこと、コストのツール別意味、デバッグスパンの現行見出し、不明な子コストを含む合計の`n/a`表示がサンプルに反映されていることを検証します。
- READMEからリンクする各サンプルが実在することを検証します。`examples/`はnpm配布パッケージにも含めます。

## 機能と使い方

### 1. 手動発動 — いつでも取り込み・集計

```bash
aimet --version                      # 現在使っているaimetのバージョン
aimet collect                       # 全ログを走査して取り込み（冪等・再実行安全）
aimet collect --since 7             # 直近7日に更新されたログのみ
aimet report                        # 日次サマリー（テキスト表）
aimet report --period weekly --by project
aimet report --tool claude          # 特定ツールに絞り込み
aimet report --by model --json      # JSON出力（BI・スプレッドシート連携用）
aimet session --tool claude         # 直近セッションのサマリ
aimet detail --tool codex           # 直近セッションの構造化された詳細をJSON出力
aimet detail --tool codex --raw     # 対応する元レコード・巨大フィールドも追加
aimet detail --tool claude --file <log.jsonl>  # DB未登録のログを直接ダンプ
```

すべての出力レベルは `--md <ファイル>` でMarkdownファイルに整形出力できます。

```bash
aimet report --by tool --md report.md
aimet session --tool codex --md session.md
aimet detail --tool claude --md detail.md
```

### 2. 自動発動 — セッション終了時／エージェントのターン完了時に自動記録

`aimet init <tool>` が各開発環境にフックを組み込みます（`--dry-run` で書き込み内容を事前確認できます）。

```bash
aimet init claude    # settings.jsonにSessionEnd / SubagentStopを登録
aimet init codex     # hooks.jsonにSessionEnd / SubagentStop、ユーザー領域にSkillを配置
aimet init copilot   # aimet.jsonにStop / SubagentStopを登録（VS Code / Copilot CLI）
```

以後、Claude/Codexでは親セッションまたはサブエージェントの終了時、Copilotでは親のターン完了時または対応するサブエージェントの終了時に`aimet hook <tool>`が呼ばれ、そのログをパースしてDBへ記録します。フックはstdinのイベントJSON（`agent_transcript_path`、`transcript_path`、`rollout_path`等）から実在するログを特定し、同じツールに複数のJSONL形式がある場合はファイルパスに一致するパーサを選びます。特定またはパースできない場合は直近2日分の差分スキャンにフォールバックします。**ホスト環境を失敗させないよう常にexit 0**で終了します。同じセッションへ複数回発火しても、DBの主キーと更新判定により二重計上しません。

> **注意（Codex）**: `aimet init codex`は現行公式スキーマの入れ子構造でフックを登録します。組み込み後は`/hooks`で登録状態、`/skills`または`$aimet-metrics`でSkillの認識を確認できます。Codexを再起動してもSkillが見えない場合は、`$HOME/.agents/skills/aimet-metrics/SKILL.md`の存在と、起動したユーザーのホームを確認してください。

> **注意（Copilot / VS Code）**: VS CodeのAgent hooksは**プレビュー機能**です（フック形式はClaude Code互換で、ユーザーレベルの置き場所が `~/.copilot/hooks/*.json`）。組み込み後、Copilot Chatで `/hooks` と打つか、出力パネルの「GitHub Copilot Chat Hooks」チャンネルで発火を確認してください。フックが使えない環境では、定期実行で代替できます：
> ```bash
> # cronで1時間ごとに差分取り込み（フック不要の代替手段）
> 0 * * * * aimet collect --since 2
> ```

### 3. 対話発動 — エージェントに聞く

`aimet init`は、Claude CodeとCopilotにプロンプトファイル、CodexにSkillを配置します。開発中に呼び出すと、エージェントが`aimet session`等を実行して使用状況を答えます。

| 環境 | 配置先 | 呼び出し方 |
|---|---|---|
| Claude Code | `<Claude保存ルート>/commands/metrics.md` | `/metrics` |
| Codex（デスクトップアプリ / CLI / IDE拡張） | `$HOME/.agents/skills/aimet-metrics/` | `$aimet-metrics`（CLI / IDEでは`/skills`からも確認） |
| Copilot (VS Code) | `<userData>/User/prompts/metrics.prompt.md` | チャットで `/metrics`（プロンプトファイル） |

Copilotの場合、エージェントモードでターミナルコマンドの実行許可を求められたら承認してください（`aimet collect` と `aimet session` を実行します）。

## コマンドリファレンス

```
aimet <command> [options]
```

すべてのコマンドに共通: データベースは `~/.aimet/metrics.db`（環境変数 `AIMET_DB` で変更可）。引数なしの`aimet`または`aimet --help`で使用方法を表示します。

---

### aimet --version — インストール済みバージョンの確認

```console
$ aimet --version
2.1.0
```

実行中のaimetと同じ配布パッケージの`package.json`からバージョンを表示します。複数PCや複数ユーザーで調査する場合は、不具合報告にこの出力を含めてください。

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

### aimet detail — セッションログの構造化詳細

```
aimet detail [--tool <tool>] [--id <prefix>] [--file <log.jsonl>]
             [--raw] [--md <file>]
```

セッションログから、メタデータ、モデル一覧、イベント件数、リクエスト別usage、ツール固有の時系列を集計とは別の調査用JSONとして出力する。対象セッションはDBから解決する（`--file`指定時はDB不要）。ログの全フィールド・全行を無加工で複製するコマンドではない。

| オプション | 説明 |
|---|---|
| `--tool <tool>` / `--id <prefix>` | 対象セッションの指定（省略時は最新） |
| `--file <log.jsonl>` | ログファイルを直接指定する。DB未登録のファイルも可（`--tool` で形式を指定） |
| `--raw` | 通常除外する巨大フィールドや、対応する元レコードを構造化詳細に追加（Codexの`base_instructions`・`dynamic_tools`、Claude/Copilotの元レコード等） |
| `--md <file>` | 整形したMarkdownとしてファイルに書き出す |

> **⚠️ 機密情報の注意**: `detail`（特に `--raw`）の出力には、プロジェクトパス・作業時刻・会話の断片・ツール設定・システムプロンプトが含まれ得ます。**GitHub Issue・Slack・社外のAIサービス等に貼る前に必ず中身を確認**してください。`--raw` 実行時はこの旨の警告をstderrに表示します。

---

### aimet hook — フック用エントリポイント（内部利用）

```
aimet hook <tool>
```

各開発環境のフックから呼ばれる想定のコマンド（`aimet init`が登録する）。stdinのイベントJSONから`agent_transcript_path`、`transcript_path`、`rollout_path`、`session_file`、`log_path`の順に実在パスを探し、該当セッションだけを即時取り込む。特定できない場合は該当ツールの直近2日分を差分スキャンする。CopilotフックのフォールバックはVS Code ChatとCopilot CLIの両方を探す。**ホスト環境を失敗させないため常にexit 0**で終了し、Codexには成功応答として空のJSONオブジェクトも返す。手動実行も可能（stdinなしで差分スキャンとして動く）。

---

### aimet init — 開発環境への組み込み

```
aimet init <claude|codex|copilot> [--dry-run]
```

指定ツールに親・サブエージェントの自動発動フックと、対話からメトリクスを呼び出すプロンプトまたはSkillをインストールする。既存設定はマージし、登録済みなら重複追加しない。

> **⚠️ 既存設定への影響**: 初回は `--dry-run` で書き込み内容を確認してから実行することを推奨します。既存の設定ファイルが不正なJSON（コメント付き等を含む）の場合、`init` は**上書きせず明示的にエラーで停止**します。実際に書き込む際は、既存ファイルを `<path>.bak` としてバックアップし、一時ファイル経由の原子的書き込み（temp→rename）で更新します。

| 対象 | 書き込み先 |
|---|---|
| `claude` | `CLAUDE_CONFIG_DIR`配下（未設定時は`~/.claude`）の`settings.json`（`SessionEnd` / `SubagentStop`）、`commands/metrics.md` |
| `codex` | `CODEX_HOME`配下（未設定時は`~/.codex`）の`hooks.json`（公式の入れ子構造で`SessionEnd` / `SubagentStop`）、`$HOME/.agents/skills/aimet-metrics/` |
| `copilot` | `~/.copilot/hooks/aimet.json`と、別の`COPILOT_HOME`がある場合の`<COPILOT_HOME>/hooks/aimet.json`（`version: 1`、`Stop` / `SubagentStop`）、`<userData>/User/prompts/metrics.prompt.md` |

> **copilot-cliについて**: 専用の`init`はありません。`aimet init copilot`はVS Codeの標準位置と、必要なら`COPILOT_HOME`の変更先の両方にフックを配置します。フックのフォールバックスキャンは`copilot`と`copilot-cli`の両方を取り込みます。

| オプション | 説明 |
|---|---|
| `--dry-run` | 書き込む予定のファイルを表示するだけで、実際には変更しない |

---

### 環境変数

| 変数 | 説明 |
|---|---|
| `AIMET_DB` | データベースファイルのパス（デフォルト: `~/.aimet/metrics.db`） |
| `CLAUDE_CONFIG_DIR` | Claude Codeの設定・セッション保存ルート。aimetの収集と`init claude`も尊重（未設定時: `~/.claude`） |
| `CODEX_HOME` | Codexの設定・セッション保存ルート。CLI・IDE拡張・app-serverと、aimetの収集・`init codex`が参照（未設定時: `~/.codex`）。GUIアプリとaimetで見える値が異なると収集できないため、変更時は「Codexの対応クライアントと取得範囲」を参照 |
| `COPILOT_HOME` | GitHub Copilot CLIの状態ルート。`session-state`JSONLの収集と`init copilot`のCLI向けフック配置に使用（未設定時: `~/.copilot`）。VS Codeの標準フック位置は変更先とは別に保持 |
| `VSCODE_PORTABLE` | VS Code Portable Modeのルート。Copilotの`<value>/user-data/User`を自動探索 |
| `VSCODE_APPDATA` | VS Code全体のユーザーデータ基点。`VSCODE_PORTABLE`未設定時にCopilot探索へ反映 |
| `APPDATA` / `XDG_CONFIG_HOME` | Windows / LinuxのVS Code標準ユーザーデータ基点。上記2変数の未設定時に使用 |
| `AIMET_COPILOT_DIR` | Copilotの追加探索ルート。Windowsは`;`、macOS / Linuxは`:`区切り。`--user-data-dir`使用時の明示指定に利用 |

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
| cacheW | キャッシュ書き込みトークン（Claude、およびログに記録されたGPT-5.6系Codex） |
| cost($) | ツール別のコストUSD。Claude/CodexはAPI換算、Copilotの`actual`はAI Credits × $0.01、Copilot CLIは取得不可。`*`付きは推定値を含む |

読み方のヒント: `active/wall` の比が低いほど「AIに任せて放置できた」ことを意味します。`cacheR` が大きいほどコンテキスト再利用が効いています。`cost/turns` で1タスクあたり単価が出せます。

#### `-`（ハイフン）と `0` の違い

**`-` は「そのツールのログに記録が存在しない（計測不能）」、`0` は「計測できていて値がゼロ」**を意味します。DBでもNULLと0を区別して保存しています（JSON出力ではnull）。ツール別の計測可否（クレジット実費・親子リンク等まで含む完全版は[コスト計算の仕組み](#ツール別取得できる情報の一覧)を参照）：

| | in | out | cacheR | cacheW | reasoning |
|---|---|---|---|---|---|
| claude | ✅ | ✅ | ✅ | ✅ | −（APIが個別に返さない） |
| codex | ✅ | ✅ | ✅ | GPT-5.6系は✅（ログにフィールドがない旧rollout・旧モデルは−） | ✅ |
| copilot (Chat) | ✅ | ✅ | ✅（`main.jsonl`。Chatスナップショットだけの場合は−） | − | − |
| copilot サブエージェント | ✅ | ✅ | ✅ | − | − |
| copilot-cli | − | ✅ | − | − | − |

集計行（report）では、グループ内の1セッションでも対象項目が未計測なら、その項目の合計全体を`-`にします。既知分だけの部分合計を完全な合計のように表示しないためです。例えばCopilot CLIと他ツールを同じ行にまとめると入力とコストは`-`になります。`--by tool`で分ければ、取得可否とコストの意味が異なるツールの混在を避けられます。

オプション: `--period daily|weekly|monthly`、`--by tool|project|model`（横断比較）、`--since <日数>`。

### レベル2: `aimet session` — 1セッションのサマリ

直近（または `--id <プレフィックス>` で指定した）セッション1件の詳細サマリ。項目はレベル1と同じ意味に加えて:

| 項目 | 意味 |
|---|---|
| project | 作業ディレクトリ（案件の識別子として使える） |
| model | 使用モデル名 |
| reasoning | 推論トークン（Codexのみ。outputの内数） |
| log file | 元ログファイルのパス（detailで深掘りする際の入口） |

### レベル3: `aimet detail` — ログの構造化詳細

集計合計ではなく、JSONLの既知フィールドを調査しやすい共通構造で出します。構成はツールごとに異なります。

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

**GitHub Copilot Chat（Chatスナップショット）**: `requests[]`にリクエストごとの時刻、プロンプトの短い先頭、`modelId` / `resolvedModel`、入出力トークン、`copilotCredits`、経過時間、ツール呼び出しラウンド数を出します。ObjectMutationLogを復元した結果であり、同じセッションの`main.jsonl`がある場合の期間・セッション集計はより詳細な後者を優先します。

**GitHub Copilotの親／子デバッグスパン**: `format: "span"`とし、`requests[]`に時刻、モデル、`debugName`、非キャッシュ入力、キャッシュ入力、出力、TTFT、処理時間、ステータスを出します。`meta.parentSessionId`により子単体のdetailから親を追跡できます。`main.jsonl`も同じスパン形式なので、見出しは「agent debug span trace」とし、子専用とは表現しません。

**GitHub Copilot CLI**: `requests[]`に`assistant.message`と出力トークンを持つ関連イベントを並べ、時刻、モデル、フェーズ、出力トークン、ターンIDを出します。ログにない入力・キャッシュ・コストを推測で埋めることはしません。

`--raw`を付けると、通常は除外している巨大フィールド（Codexの`base_instructions`＝システムプロンプト全文、`dynamic_tools`＝ツールスキーマ定義、Claudeの元レコード、Copilotの元リクエスト／元スパン等）も含めます。ツールのログ形式そのものが持たない情報を新たに復元するオプションではありません。

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

> **Claude detailテーブルの注意 — `out`列を縦に合計しないこと。** Claude detailは1つのAI応答をcontentブロックごと（thinking / text / tool_use）に複数行へ展開しますが、`in` / `out` / `cacheR` / `cacheW`は**ターン単位の同じusageを各行にコピー表示**しています。例えばthinking行とtext行の両方に`out=59`とあるのは「思考59＋本文59」ではなく「**このターンの生成合計が59**」の意味です。行ごとに足すと二重計上になります。集計側のreport / sessionはmessageIdで重複排除するため、合計値は正しくなります。
>
> **detail全般の注意**: detailは個別リクエストや累積時系列を調査する表示であり、report / sessionと別の利用量ではありません。特にCodexの`tokenTimeline`はセッション累積なので、各行を縦に合計しないでください。正式なセッション合計は`aimet session`、期間合計は`aimet report`を使います。

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

- **cacheW（キャッシュ書き込み）**: コンテキストをキャッシュに保存したトークン量。ClaudeとGPT-5.6系の明示的キャッシュ書き込みでは、通常の入力より**割高**に課金される
- **cacheR（キャッシュ読み取り）**: キャッシュにヒットして再利用されたトークン量。通常の入力より**大幅に安く**課金される

### 課金倍率（通常入力価格に対する倍率）

| 種別 | Anthropic (Claude Code) | OpenAI (Codex) |
|---|---|---|
| キャッシュ書き込み（5分TTL） | **1.25倍** | GPT-5.6系の明示的書き込みは**1.25倍**。それ以前の自動キャッシュには書き込み課金なし |
| キャッシュ書き込み（1時間TTL） | **2.0倍** | — |
| キャッシュ読み取り | **0.1倍**（90%割引） | 対応モデルは**0.1倍**（90%割引）。Pro系など例外あり |

Anthropicは明示的にキャッシュポイントを指定する方式で、TTL（保持時間）5分か1時間を選べます。書き込みが割高な代わりに、5分TTLなら**1回ヒットした時点で元が取れます**（1.25 + 0.1 < 1.0 + 1.0）。1時間TTLでも2回ヒットで黒字化します。OpenAIの従来モデルは自動プレフィックスキャッシュの読み取り分を割引し、書き込みを独立した課金項目として扱いません。一方、GPT-5.6系は公式モデルガイドに明示的キャッシュ書き込みが定義され、aimetはCodex rolloutの`cache_write_input_tokens`をcacheWとして分離し、1.25倍で計算します。読み取り割引やキャッシュ書き込みの有無はモデルごとに異なるため、最新条件は[OpenAI公式モデル一覧](https://developers.openai.com/api/docs/models)と[GPT-5.6公式モデルガイド](https://developers.openai.com/api/docs/guides/latest-model)で確認してください。

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
3. **根拠が足りないものは出さない** — 主要な課金項目（入力トークン）自体が記録されていない場合、過小評価の嘘をつくくらいなら **`-`（null）** にします。未計測値が0円として集計されることはありません。例外は、全課金対象トークンが実測`0`の場合だけです。

この方針の裏返しとして、トークン列も「未計測（`-`）」と「計測ゼロ（`0`）」を区別しています（前セクション参照）。

### ツール別・取得できる情報の一覧

| 取得項目 | Claude Code | Codex | Copilot Chat | Copilot サブエージェント | Copilot CLI |
|---|---|---|---|---|---|
| 入力トークン（非キャッシュ） | ✅ 実測 | ✅ 実測 | ✅ 実測（`main.jsonl`） | ✅ 実測 | − |
| 出力トークン | ✅ 実測 | ✅ 実測 | ✅ 実測 | ✅ 実測 | ✅ 実測 |
| キャッシュ読取（cacheR） | ✅ 実測 | ✅ 実測 | ✅ 実測（`main.jsonl`） | ✅ 実測 | − |
| キャッシュ書込（cacheW） | ✅ 実測（1h/5m TTL内訳付き） | GPT-5.6系は✅実測（フィールドのない旧rollout・旧モデルは−） | − | − | − |
| 推論トークン（reasoning） | − | ✅ 実測 | − | − | − |
| 実際の消費額 | − | − | ✅ AI Credits実測 | ✅ AI Credits実測 | − |
| モデル名 | ✅ | ✅ | ✅（resolvedModel） | ✅ | ✅ |
| 時間（wall / active） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 親子リンク | ✅（公式パスのsessionId / agentId） | ✅ | ✅ | ✅ | − |
| 補足情報 | service_tier、サーバーツール使用回数 | レート制限使用率の時系列、effort | ttft、ツールラウンド数 | ttft、スパン構造 | ターン・ツールイベント |

「−」はそのツールのログに記録が存在しないことを意味します（aimetの表示も `-`）。

### 計算式

```
cost = ( input × 入力単価
       + output × 出力単価
       + cacheR × キャッシュ読取単価
       + cacheW × キャッシュ書込単価 ) / 1,000,000
```

単価は1Mトークンあたり米ドル。内蔵単価は正規のモデルIDまたはその日付付きsnapshotにだけ一致させます。例えば未知の`gpt-5.7`を古い`gpt-5`単価で計算することはありません。一致する単価がない非ゼロ使用量は`-`（null）となり、0円として集計しません。ただし、`input`、`output`、`cacheRead`、`cacheWrite`の4項目がすべて未計測ではなく明示的な`0`なら、どの単価を掛けても結果は同じなので、未知モデルでも正確な`$0`とします。リクエストが課金前に失敗し、生のルーティングID（例: `copilot/auto`）だけが残るケースを想定した処理です。

単価は変動するため、`~/.aimet/pricing.json` で上書き・追加できます：

```json
{
  "gpt-5.6-sol": [4, 20, 0.4, 5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5]
}
```

利用者ファイルのキーは意図的にプレフィックスとして扱うため、対象を広げたくない場合は完全なモデルIDを書いてください。配列は`[input, output, cacheRead, cacheWrite]`の順、1MトークンあたりUSDです。条件付き倍率はaimet本体の処理であり、この4値だけでは追加できません。

### 内蔵単価で対応しているモデル

以下は**v2.1.0、2026-08-25確認時点**の`src/pricing.ts`と一致する一覧です。金額はすべて1MトークンあたりUSDで、cacheWはClaudeでは5分TTLの書き込み単価です。Claudeの1時間TTLはログの内訳を使って表のcacheWの1.6倍で計算します。同じ行に複数のIDがある場合は同一単価です。

| 提供元 | モデル | 対応するモデルID | input | output | cacheR | cacheW | 条件・備考 |
|---|---|---|---:|---:|---:|---:|---|
| Anthropic | Claude Fable 5 | `claude-fable-5` | 10 | 50 | 1 | 12.5 | 5分cacheW。1時間は20 |
| Anthropic | Claude Mythos 5 | `claude-mythos-5` | 10 | 50 | 1 | 12.5 | 5分cacheW。1時間は20 |
| Anthropic | Claude Opus 5 | `claude-opus-5` | 5 | 25 | 0.5 | 6.25 | 5分cacheW。1時間は10 |
| Anthropic | Claude Sonnet 5 | `claude-sonnet-5` | 2 | 10 | 0.2 | 2.5 | 5分cacheW。1時間は4 |
| Anthropic | Claude Opus 4.5～4.8 | `claude-opus-4-5` / `4-6` / `4-7` / `4-8` | 5 | 25 | 0.5 | 6.25 | Copilotの`4.5`～`4.8`表記にも対応。1時間cacheWは10 |
| Anthropic | Claude Opus 4 / 4.1 | `claude-opus-4` / `claude-opus-4-1` | 15 | 75 | 1.5 | 18.75 | Copilotの`claude-opus-4.1`にも対応。1時間cacheWは30 |
| Anthropic | Claude Sonnet 4.5 / 4.6 | `claude-sonnet-4-5` / `claude-sonnet-4-6` | 3 | 15 | 0.3 | 3.75 | Copilotの`4.5` / `4.6`表記にも対応。1時間cacheWは6 |
| Anthropic | Claude Sonnet 4 | `claude-sonnet-4` | 3 | 15 | 0.3 | 3.75 | 5分cacheW。1時間は6 |
| Anthropic | Claude Haiku 4 / 4.5 | `claude-haiku-4` / `claude-haiku-4-5` | 1 | 5 | 0.1 | 1.25 | Copilotの`claude-haiku-4.5`にも対応。1時間cacheWは2 |
| Anthropic | Claude 3.5 Haiku | `claude-3-5-haiku` | 0.8 | 4 | 0.08 | 1 | 5分cacheW。1時間は1.6 |
| OpenAI | GPT-5.6 Cyber | `gpt-5.6-cyber` | 12.5 | 75 | 1.25 | 15.625 | 272K超の入力で入力2倍・出力1.5倍 |
| OpenAI | GPT-5.6 Sol | `gpt-5.6-sol` / `gpt-5.6` | 4 | 20 | 0.4 | 5 | `gpt-5.6`はSolの別名。272K超料金あり |
| OpenAI | GPT-5.6 Terra | `gpt-5.6-terra` | 2 | 12 | 0.2 | 2.5 | 272K超料金あり |
| OpenAI | GPT-5.6 Luna | `gpt-5.6-luna` | 0.2 | 1.2 | 0.02 | 0.25 | 272K超料金あり |
| OpenAI | GPT-5.5 Pro | `gpt-5.5-pro` | 30 | 180 | 30 | 0 | キャッシュ読取割引なし。272K超料金あり |
| OpenAI | GPT-5.5 | `gpt-5.5` | 5 | 30 | 0.5 | 0 | 272K超料金あり |
| OpenAI | GPT-5.4 Pro | `gpt-5.4-pro` | 30 | 180 | 30 | 0 | キャッシュ読取割引なし。272K超料金あり |
| OpenAI | GPT-5.4 | `gpt-5.4` | 2.5 | 15 | 0.25 | 0 | 272K超料金あり |
| OpenAI | GPT-5.4 mini | `gpt-5.4-mini` | 0.75 | 4.5 | 0.075 | 0 | — |
| OpenAI | GPT-5.4 nano | `gpt-5.4-nano` | 0.2 | 1.25 | 0.02 | 0 | — |
| OpenAI | GPT-5.3 / GPT-5.3-Codex | `gpt-5.3` / `gpt-5.3-codex` | 1.75 | 14 | 0.175 | 0 | — |
| OpenAI | GPT-5.2 / GPT-5.2-Codex | `gpt-5.2` / `gpt-5.2-codex` | 1.75 | 14 | 0.175 | 0 | — |
| OpenAI | GPT-5.1 | `gpt-5.1` | 1.25 | 10 | 0.125 | 0 | — |
| OpenAI | GPT-5.1-Codex / Max | `gpt-5.1-codex` / `gpt-5.1-codex-max` | 1.25 | 10 | 0.125 | 0 | 非推奨モデル。既存・過去ログを正しく計算するため明示対応 |
| OpenAI | GPT-5.1-Codex mini | `gpt-5.1-codex-mini` | 0.25 | 2 | 0.025 | 0 | 非推奨モデル。既存・過去ログを正しく計算するため明示対応 |
| OpenAI | GPT-5 / GPT-5-Codex | `gpt-5` / `gpt-5-codex` | 1.25 | 10 | 0.125 | 0 | モデル名のない旧Codexログは`gpt-5-codex`へ推定フォールバック |
| OpenAI | GPT-5 mini | `gpt-5-mini` | 0.25 | 2 | 0.025 | 0 | — |
| OpenAI | o4-mini | `o4-mini` | 1.1 | 4.4 | 0.275 | 0 | — |

内蔵IDは完全一致または`-YYYYMMDD`形式の日付付きsnapshotに対応します。表にない新しいモデルは、名前が似ていても旧モデルの単価を流用せずコストを`-`にします。GitHub Copilot Chat／サブエージェントは表にある`resolvedModel`をAI Credits欠損時のAPI換算に利用しますが、AI Creditsが記録されている場合はモデルにかかわらずGitHubの実消費額を優先します。料金は公開後にも変更され得るため、この一覧は自動更新の保証ではありません。

### ツールごとのコスト計算方法

**Claude Code — 完全内訳による正確なAPI換算**。APIリクエストごとの実測usageをmessageIdで重複排除して合算します。`input_tokens`はキャッシュ分を含まない生の値なのでそのまま使用でき、cacheR（0.1倍）・cacheW（割増）を含む**4項目すべてを常に実測**できます。キャッシュ書き込みはTTLで単価が違うため（5分=1.25倍、1時間=2.0倍）、ログの`cache_creation`内訳から**TTL別に正しく計算**します（単価表のcacheW列は5分TTLの単価。1時間TTL分は内部で1.6倍換算）。親とサブエージェントは公式の`sessionId + agentId`で別セッションとして識別し、それぞれの独立したusageを1回だけ合算します。Anthropicの課金体系をログから完全に再現できるため、API換算値としての精度は最も高くなります。

**Codex — 累積台帳とリクエスト単位の課金を分けて計算**。`token_count`イベントの`total_token_usage`は累積値なので最大値をセッショントークンとして使用し、コストは累積が増えた時の`last_token_usage`をリクエスト単位で検算して合計します。(1) `input_tokens`は`cached_input_tokens`と`cache_write_input_tokens`を含むため、両方を差し引いて非キャッシュ入力、cacheR、cacheWの相互排他的な3区分へ分けます。(2) `reasoning_output_tokens`は`output_tokens`の内数なのでコストへ再加算しません。(3) GPT-5.6は[OpenAI公式モデルガイド](https://developers.openai.com/api/docs/guides/latest-model)に従い、明示的なcacheWを非キャッシュ入力単価の1.25倍で計算します。(4) GPT-5.4 / 5.5 / 5.6系は、1リクエストの入力が272Kを超える場合、そのリクエスト全体へ入力2倍・出力1.5倍を適用します。古いrolloutにリクエスト内訳または課金対象のcacheWがなければ、基準単価で計算して`estimated`を立てます。モデル名自体がない形式は従来どおり`gpt-5-codex`へフォールバックします。サブエージェントは別rolloutの独立台帳なので、親子を各1回だけ合算します。

**Copilotクレジット（AI Credits）とは**。GitHub Copilotの課金単位で、**1クレジット = $0.01の固定レート**です。2026年6月に従来のプレミアムリクエスト（PRU）制から移行した従量課金モデルで、プランに含まれる月間クレジット枠を消費し、超過分は追加課金されます。重要なのは、**消費クレジット数はモデルや処理量によって変動する**（高価なモデルほど1リクエストあたりの消費が大きい）ため、トークン数から外部で正確に再計算することはできない、という点です。幸いVS CodeのCopilot Chatはリクエストごとの実消費（`copilotCredits`）をログに記録するので、aimetはこれをそのまま採用します — つまりCopilot Chatのcostは推定ではなく**GitHubが実際に差し引いた金額**です。キャッシュの効きやモデルの内部事情もすべて織り込み済みの値なので、キャッシュ内訳（cacheR/cacheW）がログに無くてもコストの正確性には影響しません。GitHub側の単位・開始時期・従量課金の説明は[組織・Enterprise向けAI Creditsの公式説明](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises)と[Copilotのモデル別課金リファレンス](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)を参照してください。

**GitHub Copilot Chat — 実測AI Credits優先、API換算はリクエスト単位のフォールバック**。`main.jsonl` の各LLMスパンにある `copilotUsageNanoAiu` / `aiu` を合計し、AI Creditsを $0.01/クレジットで表示します。`main.jsonl` がない場合は `chatSessions` の `copilotCredits` とトークンを使います。AI Creditsが欠損したリクエストだけ、実測トークン×resolvedModel単価でAPI換算し、全件実測は `actual`、一部フォールバックは `mixed`、全件フォールバックは `estimated` と区別します。

**Copilotサブエージェント — トークンとAI Creditsをリクエスト単位で実測**。親の`child_session_ref`で参照された子JSONL（`runSubagent-*`、`searchSubagent-*`など）のLLMスパンからin / cached / outとnano-AIUを取得します。同じ`spanId`は1回だけ数え、親は`main.jsonl`の自分のスパン、子は各子JSONLの自分のスパンだけを持つため、親子合計で二重計上しません。AI Credits欠損時のみ、Chatと同じルールでそのリクエストをAPI換算します。

**Copilot CLI — コストは出さない（n/a）**。ログに出力トークンしか記録されず、コストの大半を占める入力トークンが不明です。出力だけで計算した金額は大幅な過小評価になるため、aimetは**誠実にコストをnull（表示 `-`、セッション詳細では `n/a`）**とし、0円として合算に紛れ込ませません。取得できる出力トークン・時間・ターン数は工数指標として利用できます。

### 精度に関する注意

- **Copilotの`main.jsonl`と参照された子JSONLがある場合、キャッシュ読取内訳とAI Creditsをともに実測できます**。debug-logsがないChatセッションは`chatSessions`に記録された粒度に制限されます。AI Creditsがある行はGitHubの実消費を使うため、aimetのAPI単価表が新モデルへ未対応でも実費値には影響しません。
- 単価表が古いとClaude / CodexのAPI換算値とCopilotのAI Credits欠損時フォールバックがずれます。重要な集計の前だけでなく、**すべての修正・リリース時**に[Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)・[OpenAIモデル一覧](https://developers.openai.com/api/docs/models)・[OpenAI料金](https://openai.com/api/pricing/)の最新内容と`src/pricing.ts`を照合してください。単純な単価差だけなら`~/.aimet/pricing.json`で上書きできますが、新しい課金項目や条件付き倍率は本体対応が必要です。
- バッチ割引、優先スループット課金、サーバーツール（Web検索等）の従量課金は含みません
- Codexの累積トークンはセッション途中のコンテキスト圧縮（compaction）後も引き継がれる前提です。異常に大きい値が出た場合は `aimet detail` の `tokenTimeline` で推移を確認してください

#### 1セッション中にモデルを変更した場合

現行のaimetスキーマは1セッションを1行で保存し、`model`も1値だけ持ちます。セッション中にモデルを変更した場合、モデルごとのトークン台帳に分割しては保存しません。そのため次の制限があります。

- `aimet report --by model`は、セッション全体を最後に観測したモデルの行へ帰属させるため、モデル別の正確な配分にはなりません。
- Claude CodeとCodexのAPI換算コストは、セッション合計トークンに1つのモデル単価を適用するため、途中で単価の異なるモデルへ変更したセッションのコストは正確ではありません。
- Copilotの実測AI Creditsはリクエストごとの消費を合計するため金額合計自体は保てますが、`--by model`のモデル別帰属は同様に正確ではありません。モデル単価へフォールバックした推定分はリクエスト単位で計算します。

監査時は`aimet detail`のClaude `requests[].model`、Codex `turnContexts[].model`、Copilot `requests[]`を確認してください。正確なモデル別集計が必要な運用では、モデルを変える前にセッションを終了し、新しいセッションを開始してください。モデル切替点ごとのトークン・コスト分割は今後の対応課題です。

## 設定

- **DBの場所**: `~/.aimet/metrics.db`（環境変数 `AIMET_DB` で変更可）
- **単価表**: `src/pricing.ts` の内蔵単価は正規のモデルIDまたはその日付付きsnapshotにだけ一致します。未知の将来モデルへ旧単価を誤適用しません。`~/.aimet/pricing.json` で上書き・追加でき、利用者定義のキーは意図的にプレフィックス一致します。形式は `{"モデル名またはプレフィックス": [input, output, cacheRead, cacheWrite]}`（1MトークンあたりUSD）。

```json
{ "gpt-5.6-sol": [4.0, 20.0, 0.4, 5.0] }
```

## 設計メモ

- **冪等性**: `(tool, session_id)` を主キーに、最終イベント時刻とログの情報量で更新を判定します。Copilotの同じ親IDは `main.jsonl` > `chatSessions` の固定優先順位とし、取り込み順や時刻に左右されません。
- **Copilotの集計範囲**: スパントレース由来の親子は `own`（自分のLLM呼び出しのみ）として保存します。過去形式の親が `tree`（子を含む累計）の場合は、集計時に子を再加算しません。report / session / Markdownはすべて同じ共通ロールアップを使います。
- **Codexのトークン**: `token_count` は累積値のため最大値を採用。`input_tokens` は `cached_input_tokens` を含むため、共通スキーマでは差し引いて「非キャッシュ入力」として記録します。
- **Codexのマルチエージェント**: サブエージェントは別のrolloutファイルになり、ファイル内のすべての`session_meta`を読んだ後に識別を決定します。rolloutファイル名のUUIDと自スレッドIDの一致を検証し、`session_meta.thread_source: "subagent"`または`source.subagent`で子候補を判別します。自スレッドのキーは`payload.id`とし、現行形式では`payload.parent_thread_id`、旧形式では自IDと異なる`payload.session_id`を親として`parent_session_id`へ保存します。出現順序には依存せず、矛盾する候補は誤って合算せず収集エラーにします。トークン台帳はスレッドごとに独立しているため、親1回＋子ごと1回を加算します。詳細は「Codexの`session_meta`重複とサブエージェント識別の注意」を参照してください。参照: [OpenAI公式ソースのrollout ThreadItem](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/list.rs)、[OpenAI公式ソースのサブエージェント作成](https://github.com/openai/codex/blob/main/codex-rs/core/src/codex_delegate.rs)、[OpenAI: Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- **Claude Codeのサブエージェント**: 公式配置`<session-id>/subagents/agent-<agent-id>.jsonl`から親IDと子IDを取得し、子を`<parent-session-id>/agent-<agent-id>`の一意なDB行として親へリンクします。親・子とも`own`スコープなので、グループ集計は各トランスクリプトを1回だけ加算します。
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

( * = includes estimated values | Claude/Codex: API-equivalent USD | Copilot actual: AI Credits x $0.01; estimated/mixed rows may include API-equivalent estimates | Copilot CLI: cost unavailable )
コストは参考値。実際の実行環境に合わせて計算してください。
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

### 構造化詳細の出力（ログ解析・監査用）

```console
$ aimet detail --tool codex                    # 最新セッションの構造化詳細をJSONで
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
- [detail-claude.md](examples/detail-claude.md) / [detail-codex.md](examples/detail-codex.md) / [detail-copilot.md](examples/detail-copilot.md) / [detail-copilot-subagent.md](examples/detail-copilot-subagent.md) / [detail-copilotcli.md](examples/detail-copilotcli.md) — セッションログの構造化詳細

## ロードマップ

- `aimet serve`: ローカルHTMLダッシュボード
- MCPサーバー化（3環境共通の対話発動口）

## License

MIT
