# ヘッダーの残り利用枠

時計・G2バッテリーの右に、Claudeのドット絵と `5H 59% W 50%`、Codexのドット絵と `55%` を表示する。文字は時計と同じG2標準フォント・サイズ・明るさ・上位置に揃える。数字は使用済みではなく**残り％**。小数点以下は切り捨てる。

- Claude: `5H` は5時間枠、`W` は週枠。それぞれ `100 - utilization`。
- Codex: コアのcodex枠のprimary / secondaryのうち、残りが少ない方。取得時点で週枠だけの場合は週枠の残り。通常のChatGPTチャットの利用枠ではない。
- 追加購入クレジット、モデル専用枠、リセット権の数は含めない。
- 欠損・取得失敗・認証切れは `--%`。0%と不明を区別する。取得から10分経過、または取得済みのリセット時刻到達後も、再取得まで数字を出さない。

取得と描画は独立した表示アプリ `apps/dashboard` にある。APIサーバーとG2 Pluginは汎用のまま。Plugin更新は不要。USAGE_MONITOR未設定または1で有効、0で無効。進捗モニター（LOCAL_AGENT_MONITOR=1）用ヘッダーに表示する。

## 取得方法

Codexはインストール済みCLIの `codex app-server --stdio` を短時間起動し、initialize / initialized後に `account/rateLimits/read` だけを実行する。新しいタスクやモデル実行、クレジット消費・リセットは行わない。毎分取得、15秒でタイムアウト。CLIが既存アカウントの認証を扱い、このアプリはCodexのトークンを直接読み出さない。`rateLimitsByLimitId.codex` を優先し、旧形式の場合のみrateLimitsへフォールバックする。[公式App Server仕様](https://learn.chatgpt.com/docs/app-server)

WindowsではLOCALAPPDATA内の既存Codexインストール、なければPATHを利用する。CODEX_BINで実行ファイルの絶対パスを指定できる。

Claudeは既存Claude Codeログインの `.credentials.json` から認証情報をメモリー内で読み、固定宛先 `https://api.anthropic.com/api/oauth/usage` をGETする。これはローカルCLI実装で確認した**非公開のメタデータAPI**で、変更される可能性がある。トークンの更新や再ログインはClaude側に任せる。5分間隔、HTTP 429は少なくとも5分待ち、Retry-Afterの秒数を最大30分まで尊重する。リダイレクトを拒否し、応答からfive_hour / seven_dayの使用率とリセット時刻だけを採用する。

Claudeの公式statuslineにも5時間・週の使用率とリセット時刻が定義されている。今回statusline設定は変更していない。[公式statuslineのフィールド説明](https://code.claude.com/docs/en/statusline#available-data)

どちらも認証情報、応答原文、アカウントIDをログやAPIへ出さず、残り枠の情報だけをメモリーに保持する。表示アプリ終了時は取得を中断する。

## 確認

```powershell
Invoke-RestMethod http://127.0.0.1:3001/api/usage | ConvertTo-Json -Depth 5
pnpm dashboard:restart
```

usage APIは各サービスのstatus / remainingPercent / windows / observedAtを返す。remainingPercentは取得済み全体枠の最小残量。Claudeヘッダーの5HとWはwindowsから個別に表示する。windowsのresetsAt、observedAtはUNIXミリ秒。API_TOKEN設定の有無にかかわらず3001番は既存の状態確認APIと同じlocalhost限定である。

ヘッダーのアイコンと罫線は上半分の画像2枚に含め、数値は時計と同じネイティブテキストで描画する。進捗は1ページ最大8段。実行中と完了後1分以内は全幅の1行に名前とactivity、その他は左右2列で最大16件を表示する。全幅と2列のグループごとに文字枠を分け、本文最大5個・ヘッダー込みテキスト最大8個、下半分のアイコン帯と合わせて画像最大4枚を使用する。段数または文字枠の上限に入り切らない分はページ送りで全件を表示する。通信断用の画面には残量を載せず `--%` にする。
