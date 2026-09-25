# Even G2 Agent Dashboard

PC上の汎用APIサーバー、独立した表示アプリ、Even G2向けPluginのpnpm + TypeScript monorepo。

```text
Codex / Claude → dashboard (:3001) → 画面投稿API → server (:3000)
                         ↑ 項目・端末情報API             ↕ WebSocket
                                                 iPhone Plugin → G2
```

## 構成

- `packages/protocol`: 型・実行時検証・stateメッセージ。
- `apps/server`: 汎用画面・端末API、SQLite、WebSocket、Plugin静的配信。
- `apps/dashboard`: 独立した表示アプリ。時計・AI監視・レイアウトを作り、HTTPで投稿。
- `apps/even-g2`: Vite、Even Hub SDK 0.0.16、テキスト表示と自動再接続。
- `packages/agent-tools`: Phase 2用の設計メモ。MCPはまだ実装していない。
- [SDK調査と設計](docs/sdk-research.md)
- [サーバー仕様書](docs/server-spec.md)
- [分離後の構成と表示アプリAPI](docs/architecture.md)
- [サーバーの起動・停止・再起動・自動起動](docs/server-operations.md)
- [AgentからのAPI利用例](docs/api-examples.md)
- [Codex・Claude進捗モニター](docs/agent-monitor.md)

最新版: [Agent Dashboard 0.6.0](releases/agent-dashboard-0.6.0.ehpk)。PCから任意のテキスト・画像・アニメーション・配置を指定する汎用クライアント。[画面API・サンプル](docs/screen-api.md)、[インストール](docs/install-beta.md)。

0.6.0は[端末情報・操作API](docs/device-api.md)と[音声・IMUの開始停止/ストリームAPI](docs/sensor-api.md)にも対応。`pnpm device status`、`pnpm device listen`、`pnpm device start audio 30` / `start imu 30` でPCから利用する。

- [パッケージのインストール手順](docs/install-beta.md)

## ローカル起動

Node.js **24以上**（`node:sqlite`使用）、pnpm **11.11.0**。この環境ではNode 26.4.0で検証。

このPCの普段の起動・停止は[サーバー運用手順](docs/server-operations.md)を参照。以下は開発用。常駐サーバーが起動中なら先に `pnpm server:stop` で停止する。

```powershell
pnpm install
if (-not (Test-Path -LiteralPath '.env')) { Copy-Item .env.example .env }
pnpm dev
```

別ターミナルで `pnpm hello`。PCで `http://localhost:5173` を開くとプレビューに `Hello G2` が表示される。通常ブラウザーにはG2 bridgeがないため、SDK待機表示のままで正常。

`pnpm dev` はAPIを127.0.0.1:3000、Viteを0.0.0.0:5173で起動する。Viteは `/api` と `/ws` をAPIへ転送する。`.env` はリポジトリルートに置く。

## iPhone + 別の場所のPC（Tailscale）

iPhoneとPCを同じtailnetへ接続し、Even AppとG2をペアリングする。Even App **2.2.10以上**を使う。開発者モードを有効にしてEven HubのQR読取を使う。

QR読取メニューがない場合は、まず [Even Hubのログインページ](https://hub.evenrealities.com/login) に **Even Appと同じアカウント** でログインする。その後、iPhoneのAppスイッチャーからEven Appを上へスワイプして完全終了し、再起動する。公式手順では、この操作でEven Hubタブ右上に開発者メニューが現れる。プロフィール内の **Prototype Mode** からQRを読み取る。参照: [開発者メニューの有効化](https://hub.evenrealities.com/docs/get-started/quickstart/hardware#enable-developer-mode)、[公式動画EP05・EP06](https://hub.evenrealities.com/docs/learn/videos)。

PCでは以下を実行する。`tailscale serve` はtailnet内のHTTPS配信。初回に有効化URLが表示された場合は、管理画面でServeを有効化する。

```powershell
pnpm build
pnpm start
# 別ターミナル
tailscale serve --bg http://127.0.0.1:3000
tailscale serve status
```

表示されたHTTPS originを設定する（以下のホスト名は置き換える）。

```powershell
pnpm device:setup https://your-pc.your-tailnet.ts.net
pnpm build
pnpm --filter @even-agent/even-g2 qr --url https://your-pc.your-tailnet.ts.net
pnpm hello
```

1. iPhone SafariでHTTPS URLが開き、`Server: Live` と `Hello G2` を確認する。
2. PC画面のQRをEven AppのEven Hub → Scan QRで読む。
3. G2で `Hello G2` を確認する。G2表示確認はSafariプレビューとは別。
4. 再度 `pnpm hello` または下のPATCHを送り、起動後の更新も確認する。

`device:setup` は `app.json` のnetwork whitelistと、git対象外の `.env.local` の `VITE_AGENT_SERVER_URL` を更新する。パッケージ内ではページoriginがPCとは限らないため接続先を明示する。ビルドに書込用の `API_TOKEN` は含めない。

読取用QR画像も `.local/device-qr.png` に生成する。

PCだけの同一origin開発へ戻す場合は、`.env.local` の `VITE_AGENT_SERVER_URL` を空にしてViteを再起動（静的配信なら再ビルド）する。`.env.local` は `.env` より優先される。

HTTPSを有効化できない場合は `.env` の `HOST` をPCのTailscale IPv4へ変更して再起動し、`http://100.x.y.z:3000` を `device:setup` とQRに指定する。これは開発接続用。iPhone側でHTTPが制限される場合はHTTPSを使う。LAN接続も同様にPCのLAN IPを使える。

常用時は `pnpm server:install` の後、`Start-ScheduledTask -TaskName 'Even Agent Server'` で起動する。このPCでは登録・起動済み。Windowsユーザーのログイン時に非表示で起動し、子サーバーの終了から3秒後に再起動する。停止は `pnpm server:stop`。手動の `pnpm start` と同時に起動しない。PCのスリープ・終了中は配信できない。Tailscale配信の停止は `tailscale serve --https=443 off`。一般公開は行わない。

## curl / API

Bash:

```bash
curl -X POST http://localhost:3000/api/items \
  -H 'Content-Type: application/json' \
  -d '{"title":"Hello G2","description":"Agent Serverからのテスト","priority":"normal","section":"now","source":"test"}'
```

PowerShell（Windowsのcurl引用符差異を避ける）:

```powershell
$body = @{ title='Hello G2'; description='Agent Serverからのテスト'; priority='normal'; section='now'; source='test' } | ConvertTo-Json
$item = Invoke-RestMethod http://localhost:3000/api/items -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
Invoke-RestMethod "http://localhost:3000/api/items/$($item.id)" -Method Patch -ContentType application/json -Body '{"title":"Build completed","section":"soon"}'
Invoke-RestMethod "http://localhost:3000/api/items/$($item.id)" -Method Delete
```

| Endpoint                | 動作                                     |
| ----------------------- | ---------------------------------------- |
| `POST /api/items`       | 登録。201と生成ID/createdAtを返す        |
| `GET /api/items`        | 有効な全項目の配列                       |
| `GET /api/state`        | NOW/SOON/WAITINGとupdatedAt              |
| `GET /api/display`      | PCで生成した完成済み画面の全ページ       |
| `PATCH /api/items/:id`  | 部分更新。任意フィールドはnullで解除可能 |
| `DELETE /api/items/:id` | 削除。204                                |
| `GET /health`           | 稼働状態とWebSocket接続数                |
| `WS /ws`                | 接続直後・変更後・期限切れ時の全state    |
| `WS /ws/display`        | 完成済み画面。変更時と15秒ごとに全ページ |

`expiresAt` と `createdAt` はUNIXミリ秒。既に期限切れの登録は保存直後に消える。期限切れは最大約1秒で配信。各セクションはpriority高順、その中で新しい順。`updatedAt` はSQLiteに保存する単調増加の更新時刻（同ミリ秒の更新は+1）。GETだけでは変更しない。

入力不正は400、存在しないIDは404、設定した書込トークンの不一致は401。空PATCHや未知フィールドも拒否する。`actions` は保存するだけで実行しない。

```json
{
  "type": "state",
  "data": { "now": [], "soon": [], "waiting": [], "updatedAt": 0 }
}
```

v0.2.0 Pluginは `/api/display` と `/ws/display` を使用する。PCで並び順・長文省略・ページ・時計を生成し、Pluginは完成したテキストを全画面コンテナへ反映する。表示は各カテゴリ1件/ページ、タップで次ページ、ダブルタップで標準終了確認。

このPCでは現在 `LOCAL_AGENT_MONITOR=1` を有効化し、1タスク1行の進捗表示へ切替済み。時計とカテゴリ見出しを省略する。CodexのローカルDB、Claude Codeとホスト側Coworkの履歴を3秒周期で読み取る。取得範囲・制約は上の進捗モニター資料を参照。項目APIは維持する。

`CLAUDE_CLOUD_MONITOR=1` も有効化済み。既存Claude CLIのログインを利用して、Claude Codeクラウドの状態を30秒周期で取得し、`Claude雲` と表示する。内部APIを使う試験対応で、認証期限切れ時はCLI側での認証更新が必要。通常チャットは対象外。

起動時REST取得後、WS接続直後のスナップショットで最新状態に確定する。切断時は保存した最後の画面にOFFLINEを表示し、指数バックオフ（最大約30秒）で再接続する。45秒間スナップショットが届かない場合も再接続し、毎回全ページを置き換える。

## 配信と設定

`pnpm build && pnpm start` でビルド済みPluginもAPIと同じ3000番から配信する。TLSはTailscale Serve等のリバースプロキシで終端し、`/ws` も転送する。

- `HOST`: デフォルト127.0.0.1。
- `PORT`: デフォルト3000。
- `DATABASE_PATH`: リポジトリ基準。デフォルト `.local/dashboard.db`。
- `API_TOKEN`: 任意。POST/PATCH/DELETEに `Authorization: Bearer ...` が必要。
- `CORS_ORIGINS`: APIへの別originアクセスのカンマ区切り許可リスト。パッケージ用の読取専用 `/api/display` だけは任意originを許可する。
- `VITE_AGENT_SERVER_URL`: Plugin用HTTP(S) origin。空ならページorigin。

Phase 1の読取API/WSは認証なし。信頼できるLANまたはtailnet内で使用する。一般公開する場合は読取認証も先に追加する。API_TOKENは書込のみを保護する。

## 検証とパッケージ

```powershell
pnpm check
pnpm pack:g2
# 検証・ビルド・配布用ファイルを一括生成:
pnpm release:g2
# pnpm startを起動した状態で別ターミナル:
pnpm --filter @even-agent/even-g2 exec evenhub-simulator http://localhost:3000 --automation-port 9898
```

`.local/agent-dashboard.ehpk` が生成される。配布前に `device:setup` で実際の接続originを設定する。パッケージ生成は公開・アップロードを行わない。

`release:g2` は `releases/agent-dashboard-0.2.0.ehpk`、SHA256、インストール手順も生成する。常用時はPrototype QRではなく、自分をテスターにしたBeta Testingでインストールする。iPhoneロック中の実機試験はインストール後に行う。

自動テストはREST検証・CRUD・SQLite再起動・WS全state配信・切断復旧・期限切れ・G2更新直列化・ページ分割・入力イベントを対象とする。シミュレーターではBLEやiPhone背景動作を検証できない。

2026-09-25、iPhoneのEven AppとTailscale経由で、実機G2への **Hello G2初回表示と、v0.1.1での起動後のリアルタイム更新をユーザーが確認済み**。Phase 1の基本動作を確認した。

同日、0.2.0パッケージ提供後にもユーザーが起動を報告。PCからPATCHした「接続テスト成功」が実機G2へ反映されたことを確認済み。iPhoneロック中の継続更新は未確認。

追加の実機検証: PATCH/DELETE反映、通信再接続後の復元、日本語表示、タップによるページ切替、終了確認。ロック/バックグラウンドからの復帰はパッケージ版でも確認する。進捗は [検証記録](docs/validation.md) を参照。
