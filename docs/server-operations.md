# サーバーの起動・停止・運用手順

このPCではWindowsのタスク **Even Agent Server** に登録済み。Windowsへログインすると、非表示でAPIサーバーと表示アプリの2プロセスが起動する。Codexを閉じても動き続ける。以下はPowerShellで実行する。

## このPCで普段使う操作

最初にプロジェクトへ移動する。

```powershell
Set-Location -LiteralPath 'C:\Users\neo\GitHub\even-agent'
```

起動:

```powershell
Start-ScheduledTask -TaskName 'Even Agent Server'
```

停止:

```powershell
pnpm server:stop
```

再起動（設定やサーバーコードを変更した後）:

```powershell
pnpm server:stop
Start-ScheduledTask -TaskName 'Even Agent Server'
```

起動確認:

```powershell
Get-ScheduledTask -TaskName 'Even Agent Server' | Select-Object TaskName, State
Invoke-RestMethod http://127.0.0.1:3000/health
Invoke-RestMethod http://127.0.0.1:3001/health
```

タスクがRunning、両方のhealthが `status: ok` なら起動している。起動直後は数秒かかる場合があるため、接続できなければ少し待ってhealthを再確認する。タスクがRunningでも子サーバーが起動に失敗している場合があるので、healthまで確認する。

| 用途                       | このPCのURL                        |
| -------------------------- | ---------------------------------- |
| PCブラウザのプレビュー     | http://127.0.0.1:3000/             |
| iPhone / G2 Pluginの接続先 | https://neoneo-1.tailb20a71.ts.net |
| 稼働確認                   | http://127.0.0.1:3000/health       |

`server:stop` は現在のプロセスを停止するだけで、自動起動の登録は残る。常駐中に `pnpm start` や `pnpm dev` も起動すると3000番ポートが競合するので、どちらか一方を使う。

## 片方だけ再起動する

時計・AI監視・配置を変更したときは、表示アプリだけ更新できる。G2の接続は切らない。

```powershell
pnpm dashboard:restart
```

APIサーバーだけ再起動:

```powershell
pnpm api:restart
```

上の2コマンドは監督プロセスが動いているとき専用。該当する子を停止し、3秒後に監督プロセスが再起動する。表示アプリの強制再起動では、旧リースの満了まで最大20秒待つことがある。

## 自動起動の有効・無効

自動起動を無効にして、現在の稼働も停止:

```powershell
Disable-ScheduledTask -TaskName 'Even Agent Server'
pnpm server:stop
```

再び有効にして起動:

```powershell
Enable-ScheduledTask -TaskName 'Even Agent Server'
Start-ScheduledTask -TaskName 'Even Agent Server'
```

これは現在のWindowsユーザーのログイン時に起動する仕組みで、ログイン前やログアウト後の稼働を保証するWindowsサービスではない。PCのスリープ・電源OFF・ネットワーク断の間は配信できない。

監督プロセスがAPIサーバー・表示アプリそれぞれの終了を検知すると、その子だけを3秒後に再起動する。ハングをhealthで検知して復旧する仕組みはない。停止には監督プロセスも終了する `pnpm server:stop` を使う。

## 初めてセットアップする場合

必要な環境はNode.js 24以上、pnpm 11.11.0。Node 26.4.0で検証済み。プロジェクトのルートで実行する。

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
}
pnpm build
pnpm server:install
Start-ScheduledTask -TaskName 'Even Agent Server'
```

既存の.envは上書きしない。新規の.env.exampleでは進捗監視が無効なので、必要なら.envの `LOCAL_AGENT_MONITOR=1`、`CLAUDE_CLOUD_MONITOR=1` を設定してから起動する。クラウド監視には既存のClaude CLIログインが必要。[監視仕様](agent-monitor.md)を参照。

`server:install` は登録のみで、直後の起動にはStart-ScheduledTaskが必要。登録時のNode実行ファイルの絶対パスを `.local/server-runtime.json` へ保存する。Nodeのインストール先が変わった場合は停止後に登録し直す。リポジトリを移動した場合、同名の既存タスクを別プロジェクトと判断して登録を拒否するので、古いタスクの参照先を確認してから移設する。

このPCの作業フォルダーとHTTPS名は固有の設定。別PCではパスと接続先を置き換える。

## 手動起動・開発

ログをターミナルで見たい場合は、先に常駐を止めて手動起動する。

```powershell
pnpm server:stop
pnpm build
pnpm start
```

`pnpm start` は監督プロセスを前景で動かし、APIと表示アプリを起動する。子のログは.localへ保存する。停止はCtrl+C。その後、常駐へ戻すにはStart-ScheduledTaskを使う。常駐をまだ一度も起動していない新規環境では、先頭のserver:stopは不要。

別ターミナルで個別に前景起動する場合（常駐を止めてから）:

```powershell
# ターミナル1：APIだけ
pnpm start:server
# ターミナル2：表示アプリだけ
pnpm start:dashboard
```

表示アプリを止めたままAPIを使いたい場合は、ターミナル1だけ起動する。APIは時計や進捗を自動生成しない。別の表示アプリから[ライブ画面API](architecture.md)へ投稿できる。

ソースの変更を自動反映しながら開発する場合:

```powershell
pnpm dev
```

APIは3000番、表示アプリの状態確認は3001番、Viteのプレビューは5173番。Viteは `/api` と `/ws` をAPIサーバーへ転送する。`.env.local` の `VITE_AGENT_SERVER_URL` が指定されている場合は、その指定先へ接続する。PC内だけの開発へ切り替えるときは値を空にしてViteを再起動する。

通常のブラウザにはEven Appのネイティブ機能がないため、G2側のStartupエラー等が表示される場合がある。Server: Liveとプレビューの更新を確認し、実機の表示・残量・センサー動作とは区別する。

## 更新の反映方法

| 変更内容                         | 必要な操作                                                |
| -------------------------------- | --------------------------------------------------------- |
| 監視・時計・レイアウト生成       | pnpm dashboard:restart                                    |
| API・端末通信                    | pnpm api:restart                                          |
| 両方に関わる.env / API_TOKEN     | 全体再起動                                                |
| 依存パッケージ                   | 停止 → pnpm install --frozen-lockfile → pnpm build → 起動 |
| PCから送るカスタム画面           | 画面APIへ投稿するだけ。再起動不要                         |
| ブラウザ用クライアントのコード   | pnpm build後にブラウザを再読み込み                        |
| G2 PluginのSDK処理・権限・接続先 | pnpm release:g2で再パッケージし、Even App側も更新         |

サーバーはTypeScriptソースをtsx経由で実行する。サーバーコードの変更だけなら再ビルドは不要だが、変更の確認には `pnpm check` を使う。ブラウザへ配るファイルは `apps/even-g2/dist` なので、その更新にはビルドが必要。

接続先を変更する場合は `.env.local` のVITE_AGENT_SERVER_URLとapp.jsonのnetwork whitelistを合わせて更新する。既存のマイク権限を保持する。現行の `pnpm device:setup` はpermissions全体をnetworkだけに置き換えるため、0.6.0の権限を保った移設にはそのまま使わず、設定ファイルの該当項目を編集する。

## TailscaleとiPhoneからの接続

現在の配信先はtailnet内限定の `https://neoneo-1.tailb20a71.ts.net`。PCとiPhoneを同じTailscaleネットワークへ接続する。

```powershell
tailscale serve status
Invoke-RestMethod https://neoneo-1.tailb20a71.ts.net/health
```

Serveの設定がない場合、このサーバーをHTTPSで配信する設定:

```powershell
tailscale serve --bg http://127.0.0.1:3000
```

初回はTailscale管理画面でServeの有効化が必要な場合がある。PCサーバーを再起動するたびにServeを設定し直す必要はない。G2側ではEven Appとの接続とDashboardの起動が必要。[Pluginのインストール手順](install-beta.md)を参照。

## 設定・保存場所

| 場所                       | 内容                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------- |
| .env                       | HOST / PORT / DATABASE_PATH / 監視設定 / API_TOKEN / CORS_ORIGINS。サーバー再起動で反映 |
| .env.local                 | VITE_AGENT_SERVER_URLなど、クライアントのビルド設定                                     |
| .local/dashboard.db        | 項目とカスタム画面。既定のSQLite保存先                                                  |
| .local/server.log          | サーバーの標準出力・HTTPログ                                                            |
| .local/server-error.log    | サーバーの標準エラー                                                                    |
| .local/dashboard.log       | 表示アプリの標準出力                                                                    |
| .local/dashboard-error.log | 表示アプリの標準エラー                                                                  |
| .local/supervisor.log      | 子サーバーの起動・終了記録                                                              |
| .local/supervisor.json     | 監督プロセス・API・表示アプリのPID・作業フォルダー                                      |
| .local/server-runtime.json | 常駐起動で使うNodeのパス                                                                |

各ログは5MiBを超えたときに末尾2MiBへ切り詰める。DBをバックアップするときは停止してから、dashboard.dbと存在する同名の-wal / -shmを一組でコピーする。状態確認のために.envや認証情報をログへ貼り付ける必要はない。

API_TOKEN設定時はHTTP書込とセンサー受信WSにBearer認証が必要。通常の表示読取は認証なし。現在のネットワーク構成はTailscaleの到達制御を前提とする。[API仕様](server-spec.md)、[音声・IMU仕様](sensor-api.md)を参照。

## 更新されないとき

1. localhostのhealthを確認する。応答なしならタスク状態とログを見る。
2. localhostが正常なら、TailscaleのHTTPS healthを確認する。
3. `:3000/api/display` と `:3001/api/agents` を見て、PC側の画面・監視内容を確認する。
4. iPhoneのEven App内プレビュー、G2実機の順で確認する。

```powershell
Get-Content -LiteralPath '.local/server-error.log' -Tail 60
Get-Content -LiteralPath '.local/supervisor.log' -Tail 40
Invoke-RestMethod http://127.0.0.1:3000/api/screen
Invoke-RestMethod http://127.0.0.1:3001/api/agents
pnpm device status
pnpm device streams
```

- **EADDRINUSE**: 手動起動や開発サーバーと3000番が競合していないか確認する。
- **No supervisor status file found**: 常駐をまだ起動していないか、.localが別の場所にある。手動起動したサーバーは、そのターミナルでCtrl+Cを使って止める。
- **タスクなし**: 正しい作業フォルダーで `pnpm server:install` を実行する。
- **画面が監視内容へ戻らない**: `/api/screen` がcustomモードなら、意図的にカスタム画面を解除するときだけ `pnpm screen reset` を実行する。
- **残量なし・streamsが空**: 対応Pluginの起動・更新とG2接続を確認する。普通のブラウザだけでは端末情報は届かない。

healthのdisplayClientsにはブラウザも含むため、接続数だけで実機への描画成功は判断できない。

作成・確認: 2026-09-25。既存スクリプトと実行中タスク、local health、Tailscale Serve設定に照合済み。

分離後の依存関係・画面の優先順位は[アーキテクチャ](architecture.md)を参照。DASHBOARD_PORTは3001、DASHBOARD_SERVER_URL未設定時はlocalhostのPORTへ投稿する。APIは正常でも画面がOFFLINEなら:3001/healthとdashboard-error.logを確認する。
