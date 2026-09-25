# Agent Dashboard 0.6.0 — 汎用画面版のインストール

PC側の起動・停止・自動起動は[サーバー運用手順](server-operations.md)を参照。

このパッケージはPCから届く完成済み画面をG2に表示するクライアント。
PCに保存・優先順位・ページ生成・時計を集約し、Plugin側は描画と通信復旧を担当する。
自動終了タイマーはなく、G2で終了を選ぶまで利用を続ける。iPhoneをロックした状態での動作は、次のベータ版インストール後に実機で確認する。

## インストールするファイル

0.6.0には装着・ケース・接続・起動元の状態、操作イベント、PCコマンドで開始停止する音声とIMUのストリームをまとめた。0.5.0を経由せず、この版へ直接更新できる。マイク権限を追加したが、起動時はOFFで明示的なstartだけで取得する。[端末API](device-api.md)、[音声・IMU API](sensor-api.md) を参照。

0.5.0で追加したG2の残量・充電状態にも対応。進捗画面の時計横に `G2 75%`（例）、充電中は末尾に `+` を表示する。0.4.0以前は残量を送信しないため、パッケージ更新が必要。実機の残量取得は更新後に確認する。[端末API](device-api.md) を参照。

`releases/agent-dashboard-0.6.0.ehpk`。必要なEven Appは **2.2.10以上**。
接続先は `https://neoneo-1.tailb20a71.ts.net`。iPhoneとPCを同じTailscaleネットワークへ接続する。
ファイルは自分用ベータテストのためのもの。ストアへの一般公開は不要。

0.6.0はPCから任意のテキスト・配置・Gray4画像・アニメーションのコマを受信して描画する。Codex / Claudeの絵もPCから送信するため、アプリ更新なしで別の絵や画面を追加できる。初回はこの0.6.0への更新が必要。[汎用画面API](screen-api.md) と `examples/screen-demo.json` を参照。

サーバーでは既存の進捗画面を汎用sceneで配信済み。カスタム画面は `pnpm screen set examples/screen-demo.json`、元に戻すには `pnpm screen reset`。実機での汎用画像描画は未検証。

0.3.0ではCodex / Claude名を18×18のドット絵にし、横に状態アイコンを表示する。実行中は500msごとに回転、確認待ちは !、完了はチェック、失敗は×、停止は一時停止マーク、更新なしは薄い輪。クラウド版Claudeは作業名の前に「雲」を表示する。

アイコンを使うにはG2側のパッケージ更新が必要。PCサーバーの変更だけでは0.2.0の表示は変わらず、従来の文字表示を続ける。0.3.0はブラウザプレビューと自動テスト26件で検証済み。実機の画像転送・ちらつき・電池消費は未検証。

## 自分用のベータ版としてインストール

1. [Even Hub開発者サイト](https://hub.evenrealities.com/login) にEven Appと同じアカウントでログインする。
2. Agent Dashboardのプロジェクトを作成／選択し、ビルドに `.ehpk` をアップロードする。
3. テストグループへ自分のEvenアカウントを追加し、アップロードしたビルドを割り当てる。
4. テスター招待が表示・送付された場合は自分のアカウントで受諾し、Even Appのテスト用アプリ一覧からインストールする。
5. G2のアプリメニューからAgent Dashboardを起動する。

公式手順のラベルはBeta groups / Builds / Me → Beta tester。ただし、今回Prototype Modeでも案内と実際のUI階層に差があったため、項目名が違う場合は現在のポータルとEven Appの画面で確認する。

**Prototype ModeのQRを読み込むだけでは、ベータ版インストールにはならない。**
Private Testingも長時間ロックの検証には不十分とされているため、自分をテスターにしたBeta Testingを使う。

参照: [公式Beta Testing](https://hub.evenrealities.com/docs/test/beta-testing)、[テスト方式の比較](https://hub.evenrealities.com/docs/test)。

## 常時利用時の条件

- G2ではAgent Dashboardを起動したままにする。ダブルタップの標準終了確認は残している。
- iPhoneはホーム画面へ戻す／画面ロックで使う想定。Even AppをAppスイッチャーから強制終了しない。
- iPhoneのBluetoothとTailscale接続を維持する。
- PCは電源ONで、このユーザーがログイン済みであること。Windowsのタスクはログイン時起動。
- このPCの現在のAC電源スリープ設定は「なし」。電源設定の変更は行っていない。

G2の再起動後やPluginの明示的な終了後に、自動でPluginを再起動する機能はない。
ベータ版でもiOS/Even Appによる中断があり得るため、無期限の常時接続は保証しない。
切断中は保存しておいた最後の画面にOFFLINEを表示し、再接続時にServerの最新画面で置き換える。
時計や項目の期限判定をスマホ側で進めず、復旧時にPCの判断に合わせる。

## PCサーバーの常駐

タスク名: **Even Agent Server**。Windowsユーザーのログイン時に非表示で起動。
子サーバープロセスが終了すると3秒後に再起動する。ログは `.local` 内で容量を制限して保存する。

```powershell
# 登録（別PCに移す場合など）
pnpm server:install
# 起動
Start-ScheduledTask -TaskName 'Even Agent Server'
# 状態確認
Get-ScheduledTask -TaskName 'Even Agent Server'
Invoke-RestMethod http://127.0.0.1:3000/health
# 停止
pnpm server:stop
# 次回以降の自動起動も止める場合
Disable-ScheduledTask -TaskName 'Even Agent Server'
```

再開は `Enable-ScheduledTask -TaskName 'Even Agent Server'` の後にStartを実行する。
ログ: `.local/server.log`、`.local/server-error.log`、`.local/supervisor.log`。
Tailscale Serveの設定は別に保持される。確認は `tailscale serve status`。

## ロック中の更新テスト

1. インストールしたベータ版を起動し、接続を確認する。
2. iPhoneをロックし、5分以上待つ。
3. PCで `pnpm hello` を実行。iPhoneを開かずにG2が更新されるか見る。
4. iPhoneを開き直してもPluginが復旧することを確認する。
5. Tailscale切断→復旧、Bluetooth切断→復旧も別に確認する。

0.2.0のパッケージ生成とPC側テストは実施済み。2026-09-25、パッケージ提供後にユーザーが起動し、PCから更新した「接続テスト成功」が実機G2に反映されたことを確認した。Beta / Privateなどの導入経路は未確認。ロック中の実機試験は未実施。
