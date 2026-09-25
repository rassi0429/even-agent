# Even Agent APIサーバー仕様書

2026-09-25更新。APIサーバーと表示アプリは別プロセスに分離済み。[構成とライブ画面投稿API](architecture.md)、[起動・停止・運用](server-operations.md)を参照。Pluginは0.6.0のままで利用できる。

## 1. 目的と責務

apps/serverは入力検証・項目保存・汎用画面配信・G2端末情報・センサー中継を担当する。時計、Codex/Claudeの監視、アイコン、レイアウトはapps/dashboardが生成し、HTTPで画面を投稿する。両者の実行コードに直接のimport依存はない。

- 継続更新する表示アプリ: PUT /api/display/live（メモリー上、リース方式）
- 手動カスタム画面: PUT /api/screen（SQLiteに保存、最優先）
- 受信側: GET /api/display、WS /ws/display（既存version 1）
- 端末・センサー: [端末API](device-api.md)、[音声・IMU API](sensor-api.md)

表示アプリが停止した場合はリース満了後にofflineContent / offlineSceneへ切り替える。APIが起動しているだけでは時計・進捗は更新しない。

## 2. 実行環境と配置

Node.js 24以上、pnpm 11.11.0。Fastify / WebSocket / Zod / node:sqlite（WAL）。APIは127.0.0.1:3000、ダッシュボードの状態確認APIは127.0.0.1:3001。Tailscale Serveはhttps://neoneo-1.tailb20a71.ts.netから3000番へ転送する。

APIはapps/even-g2/distを静的配信する。G2自身がPCへ接続するのではなく、iPhoneのEven App内PluginがWebSocketで受信し、SDK経由で描画する。APIサーバー自体の複数インスタンス間で配信状態を同期する機能はない。

## 3. 項目データモデル

文字数制約はZodの文字列長に基づく。画面上の表示幅やUTF-8バイト数とは異なる。

| フィールド  | 型・制約                 | POST     | 意味                                |
| ----------- | ------------------------ | -------- | ----------------------------------- |
| title       | string、trim後1〜160文字 | 必須     | 見出し                              |
| description | string、0〜1000文字      | 任意     | 補足                                |
| section     | now / soon / waiting     | 必須     | 表示カテゴリ                        |
| priority    | high / normal / low      | 必須     | カテゴリ内の優先順位                |
| source      | string、trim後1〜80文字  | 必須     | 呼出元の名前                        |
| expiresAt   | 非負の安全な整数         | 任意     | 期限。UNIXミリ秒                    |
| actions     | 最大8個の配列            | 任意     | 保存のみ。実行・画面操作は未実装    |
| id          | UUID文字列               | 指定不可 | サーバーが生成                      |
| createdAt   | UNIXミリ秒               | 指定不可 | サーバーが生成。PATCHでは変わらない |

actionsの各要素は `{ "id": "open", "label": "開く" }`。idはtrim後1〜100文字、labelはtrim後1〜60文字。未知フィールドを拒否する。

POST/PATCHの項目本体でも未知フィールドを拒否する。PATCHは1フィールド以上必要で、description / expiresAt / actionsのみnullで削除できる。省略フィールドは維持する。

### 並び順と期限

各カテゴリ内でpriorityがhigh → normal → low、同優先順位ではcreatedAtが新しい順、同時刻ではidのlocaleCompare順。PATCHしただけではcreatedAtによる順位は変わらない。GET /api/itemsはnow、soon、waitingの順に各配列を連結する。

現在時刻がexpiresAt以上になった項目は表示対象から外れる。通常は1秒間隔で期限切れをDBから削除し、接続中のクライアントへ通知する。読み取りや更新の一部処理でも期限切れを清掃する。既に期限切れの値でPOSTした場合も201を返すが、その項目は直後の有効一覧に残らない。タイマー遅延やPC停止時の厳密な1秒以内処理は保証しない。

### 更新番号

state.updatedAtは永続化された更新番号を兼ねるUNIXミリ秒相当の整数。各変更トランザクションで `max(前回値 + 1, 現在時刻)` にする。同じミリ秒の更新でも増えるため、厳密な実時計としては扱わない。新規DBは0。期限切れ削除や同値のPATCHでも更新される。期限清掃が起きない単純なGETでは変わらない。

## 4. HTTP API

JSONを送る際は `Content-Type: application/json` を指定する。HTTPリクエストボディ上限は16 KiB。API_TOKEN設定時の書込には `Authorization: Bearer <token>` が必要。

| Method / Path            | 成功 | レスポンス・動作                     |
| ------------------------ | ---- | ------------------------------------ |
| GET /health              | 200  | 稼働状態とWS接続数                   |
| GET /api/items           | 200  | 有効項目の配列。全件、ページングなし |
| POST /api/items          | 201  | idとcreatedAtを加えた保存項目        |
| PATCH /api/items/:id     | 200  | 部分更新後の項目                     |
| DELETE /api/items/:id    | 204  | 本文なし                             |
| GET /api/state           | 200  | now / soon / waiting / updatedAt     |
| GET /api/display         | 200  | 完成済み画面の全ページ               |
| GET /api/display/live    | 200  | ライブ画面の送信者・期限・接続状態   |
| PUT /api/display/live    | 200  | ライブ画面投稿。競合は409            |
| DELETE /api/display/live | 204  | 自分のリース解放                     |

GET /api/items/:idは未実装。クエリでの絞り込み、バルク更新、冪等性キー、条件付き更新も未実装。同じPOSTを再送すると別UUIDの項目が増える。呼出元は返却されたidを保存し、継続更新にPATCHを使う。

healthの例:

```json
{
  "status": "ok",
  "service": "even-agent",
  "displayProtocol": 1,
  "clients": 1,
  "displayClients": 1
}
```

clientsは両WSエンドポイントの合計、displayClientsは/ws/displayだけの接続数。接続数はG2台数や表示成功数ではない。シミュレーターやプレビューも含み、サーバーはG2への描画完了ACKを受け取らない。screenMode（custom / live / offline / idle）とpublisher（online / publisherId / expiresAt）も返す。agentMonitorと/api/agentsは表示アプリの3001番へ移動した。

エラー:

| Status | 条件                                 | 本文                                                              |
| ------ | ------------------------------------ | ----------------------------------------------------------------- |
| 400    | POST/PATCHのスキーマ違反             | `{ "error": "Invalid itemまたはInvalid patch", "issues": [...] }` |
| 401    | 設定した書込トークンの欠落・不一致   | `{ "error": "Unauthorized" }`                                     |
| 404    | 更新・削除対象がない、または期限切れ | `{ "error": "Item not found" }`                                   |
| 413    | HTTPボディ上限超過                   | Fastify標準エラー                                                 |

不正JSON、未実装ルート、その他のHTTPエラーもFastifyが返す。全エラーを独自の共通形式に統一してはいない。

## 5. 画面配信プロトコル

GET /api/displayは以下のオブジェクトを返す。`Cache-Control: no-store` を付与する。

```json
{
  "version": 1,
  "updatedAt": 1790310035000,
  "generatedAt": 1790310036000,
  "pages": [
    {
      "id": "page-0",
      "content": "13:20  LIVE  1/1\nNOW  1/1\n接続テスト成功\nPCから更新しました\nSOON\n-\nWAITING\n-",
      "offlineContent": "13:20  OFFLINE  1/1\nNOW  1/1\n接続テスト成功\nPCから更新しました\nSOON\n-\nWAITING\n-"
    }
  ]
}
```

generatedAtはAPIが画面を配信する時刻。updatedAtが同じでも時計更新によってgeneratedAtやcontentは変わる。クライアントはupdatedAtが同じという理由だけで画面を捨てない。

pagesは最低1ページ（ライブ投稿は最大16ページ）。idは表示アプリが指定する。共通スキーマのid上限は100文字、content / offlineContentは各1〜999文字。Pluginは受信データをスキーマ検証する。

### 画面生成の所在

通常の表示はapps/dashboardが担当する。監視有効時は日付・曜日・時計・バッテリーと下部のAI行を生成する。無効時は従来のNOW / SOON / WAITINGテキスト表示。詳しくは[進捗モニター](agent-monitor.md)。

APIサーバーは投稿された画面を検証・配信するだけで、タイトルや日時を追加しない。画面レイアウトの変更は表示アプリだけの再起動で反映できる。汎用描画の範囲内ならPlugin更新は不要。

## 6. WebSocket

| Path        | JSON形式                                      | 配信契機                                           |
| ----------- | --------------------------------------------- | -------------------------------------------------- |
| /ws         | `{ "type": "state", "data": DashboardState }` | 接続直後、項目変更、期限切れ削除                   |
| /ws/display | `{ "type": "display", "data": DisplayState }` | 接続直後、画面投稿・切替、リース期限切れ、15秒ごと |

DashboardStateは `{ now: Item[], soon: Item[], waiting: Item[], updatedAt: number }`。DisplayStateは前節のオブジェクト。HTTPS接続先ではwssを使う。このPCでは `wss://neoneo-1.tailb20a71.ts.net/ws/display`。

どちらも差分ではなく全スナップショットを送る。クライアントから購読メッセージを送る必要はなく、WS経由の項目更新やACKは未実装。再接続時は受信した全状態で置き換える。切断中のイベント履歴を再生する機能はない。

サーバーは15秒間隔でpingし、前回の確認以降pongを受け取れない接続を次回チェックで切断する。送信待ちバッファが1 MiBを超えている接続も送信時に切断する。クライアントからのWSメッセージ上限は1 KiB。これらは項目総数やサーバー送信スナップショットの上限ではない。

## 7. Pluginの接続・描画動作

- 起動時に最後の保存画面を読み込み、あればOFFLINE表示。その後REST取得、WS接続の順に進む。
- REST待機は最大8秒。失敗してもWS接続を試みる。WSの最初のスナップショット待機は10秒。
- 有効なWSスナップショットを受けてLiveになる。その後45秒間受信がなければ再接続。
- 再試行間隔は1、2、4、8、16、30秒…に0〜250msの揺らぎを加える。受信成功でリセット。
- ブラウザーのonlineイベント、画面可視状態への復帰でも再接続する。
- 最後の全ページと選択ページを接続先ごとのlocalStorageに保存。保存不可でも動作を続ける。
- 576×288の全画面テキストコンテナ1個を作り、その後は同じコンテナのテキスト全体を更新する。
- SDKへの書込は直列化し、連続変更は最新内容にまとめる。同じ内容は再送しない。失敗した更新は3秒周期の描画処理などで再試行。
- 初回コンテナ生成に失敗した場合は自動で生成を繰り返さず、Pluginの開き直しが必要。
- タップで次ページ。システムメニュー中は書込を保留し、閉じた後に最新画面を再送。ダブルタップは標準終了確認。

自動終了タイマーはない。ただしPlugin終了、iOSによるWebView停止、Even App強制終了後にも動作が続くという意味ではない。WebView停止中はOFFLINEへの書換え自体も実行できない。PC、Tailscale、iPhone、Bluetooth、G2の接続が必要で、時計・期限は復旧時にPCの最新状態へ合わせる。

## 8. SQLiteと永続化

既定パスはリポジトリ内の `.local/dashboard.db`。ディレクトリは起動時に作成する。busy_timeoutは5000ms。

```sql
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX items_expiry ON items(expires_at);
CREATE TABLE metadata (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
```

dataは項目全体のJSON。expires_atは期限検索用に重複保存する。metadataのupdatedAtは変更時に同じトランザクション内で更新する。変更はBEGIN IMMEDIATE / COMMIT、例外時はROLLBACK。履歴、監査ログ、スキーマ移行管理、削除の取り消しは未実装。

再起動後も項目と更新番号が残る。通常のSIGINT/SIGTERMではソケット・タイマーとDBを閉じる。Windowsの強制終了を伴う停止ではそのハンドラーが必ず走るとは限らないため、WALを含めたSQLiteの復旧に依存する。

## 9. 設定とアクセス制御

サーバーは起動時にルートの.envを読む。編集後はサーバー再起動が必要。既存のプロセス環境変数がある場合はそちらが優先される。

| 変数                  | 既定値・用途                                                     |
| --------------------- | ---------------------------------------------------------------- |
| HOST                  | 127.0.0.1                                                        |
| PORT                  | 3000                                                             |
| DATABASE_PATH         | .local/dashboard.db。相対パスはリポジトリ基準                    |
| API_TOKEN             | 未設定。設定時、GET/HEAD/OPTIONS以外のHTTPリクエストにBearer検証 |
| CORS_ORIGINS          | 空。追加の許可originをカンマ区切りで指定                         |
| VITE_AGENT_SERVER_URL | Pluginのビルド時接続先。サーバーのlisten設定ではない             |

読み取りAPIと表示WSは認証なし。センサー購読WS /ws/device/streamはAPI_TOKEN設定時にBearer認証が必要。API_TOKEN未設定なら書込も認証なし。Tailscaleのネットワーク到達制御を前提とする。CORSは認証ではなく、非ブラウザーの呼出元を制限しない。

パッケージ内WebViewからの単純GETを許可するため、GET /api/displayだけは `Access-Control-Allow-Origin: *` を返す。ほかのAPIのCORSはCORS_ORIGINSに従う。Pluginに書込トークンを埋め込まない。WSのOrigin許可検証、読取認証、ユーザー別権限、レート制限は未実装。

## 10. Windows常駐運用

タスク名は **Even Agent Server**。現在のユーザーのログイン時に、通常権限・非表示で起動する。ログイン前やログアウト後の稼働を提供するWindowsサービスではない。

```text
Windows Task Scheduler
  → scripts/run-server.ps1
    → scripts/server-supervisor.mjs
      → node --import tsx apps/server/src/main.ts
      → node --import tsx apps/dashboard/src/main.ts
```

登録時の実Node実行ファイルのパスを.local/server-runtime.jsonに記録する。監督プロセスは各子の終了後3秒で該当する子だけ再起動。タスクには多重起動無視、実行時間制限なし、失敗時の1分間隔・最大3回再試行を設定している。ハングをhealthで検知して再起動する機能はない。

```powershell
# リポジトリルートで実行
pnpm server:install
Start-ScheduledTask -TaskName 'Even Agent Server'
Get-ScheduledTask -TaskName 'Even Agent Server'
Invoke-RestMethod http://127.0.0.1:3000/health
tailscale serve status

# 停止。次回ログイン時の起動設定は残る
pnpm server:stop

# 自動起動も止める場合
Disable-ScheduledTask -TaskName 'Even Agent Server'
# 再び有効化して起動
Enable-ScheduledTask -TaskName 'Even Agent Server'
Start-ScheduledTask -TaskName 'Even Agent Server'
```

pnpm startと常駐タスクを同時に起動しない。Nodeの保存先を変更・削除した場合はserver:installで登録し直す。PCの電源とネットワークが必要。Codex画面を閉じても独立して動く。

| ファイル                   | 内容                                |
| -------------------------- | ----------------------------------- |
| .local/server.log          | サーバー標準出力・HTTPログ          |
| .local/server-error.log    | サーバー標準エラー                  |
| .local/supervisor.log      | 子プロセス起動・終了                |
| .local/supervisor.json     | PID、リポジトリ、監督状態、記録時刻 |
| .local/server-runtime.json | 登録時のNode実行ファイルパス        |

各ログは書込前に5 MiB超なら末尾2 MiBへ縮める。厳密な最大サイズ保証や世代バックアップではない。supervisor.jsonは起動・終了時の記録であり、生存を保証するheartbeatではない。

### バックアップと障害切り分け

DBをファイルコピーする場合は、server:stopで停止し、タスクとプロセスの停止を確認してから.local/dashboard.dbと存在する同名の-wal / -shmを一組で保存する。WALモードの稼働中に.dbだけをコピーしない。復元も停止中に行い、別時点のDBとWALを混在させない。自動バックアップは未実装。

更新されない場合は、health → api/display → Tailscale到達性 → Even App内プレビュー → G2の順に確認する。displayClientsが0ならPluginのWS接続を、1以上でプレビューだけ更新されるならSDK表示状態・Bluetooth・システムメニューを確認する。描画完了はhealthだけでは判定できない。

## 11. 検証状況と未実装

- TypeScript、lint、40件の自動テスト、build、format検証を実施済み（表示アプリ分離後）。
- REST CRUD、SQLite再起動、全state配信、再接続、期限切れ、画面生成、読取CORS、SDK書込直列化をテスト。
- サーバー子プロセスの異常終了→3秒後の復旧、タスク停止・再起動、HTTPS配信を確認済み。
- 2026-09-25、0.2.0パッケージ提供後にユーザーが起動を報告。13:20:35のPATCHで「接続テスト成功」へ変更し、実機G2で反映を確認したとの報告あり。
- iPhoneをロックしたままの長時間更新、Bluetooth切断復旧、Windows再ログインによる自動起動は未確認。導入経路がBetaかPrivateかは今回のユーザー報告だけでは確定していない。

Codex・Claudeのローカル進捗収集を追加済み。汎用画面・画像描画・G2操作のサーバー送信は実装済み。MCP、その他のCollector、AIによる情報選別、actions実行、描画ACK、通知履歴、複数ユーザー管理、通常読取APIの認証、負荷上限の測定は未実装。登録項目数に上限がないため、現段階では個人利用の少数項目を想定する。

## 12. 関連資料と実装箇所

- [AgentからのAPI利用例](api-examples.md)
- [インストール・常用手順](install-beta.md)
- [検証記録](validation.md)
- [データ型・入力検証](../packages/protocol/src/index.ts)
- [HTTP・WebSocket](../apps/server/src/app.ts)
- [SQLite](../apps/server/src/store.ts)
- [画面生成](../apps/dashboard/src/display.ts)
- [起動設定](../apps/server/src/main.ts)
- [クライアント同期](../apps/even-g2/src/sync.ts)
- [G2描画](../apps/even-g2/src/renderer.ts)
- [常駐登録](../scripts/install-server-task.ps1)・[プロセス監督](../scripts/server-supervisor.mjs)
