# Phase 1 検証記録

2026-09-25 / Windows / Node 26.4.0 / SDK 0.0.16 / Simulator 0.9.5。

## 確認済み

- `pnpm check`: TypeScript、ESLint、12件のテスト、build、Prettierが成功（v0.2.0）。
- `pnpm pack:g2`: `.local/agent-dashboard.ehpk` を生成。CLIがEven App下限を2.2.10に設定。
- 実HTTPのPOST → SQLite → WebSocket → 公式Simulator → テキスト描画を確認。
- `Hello G2` と日本語descriptionが表示された。
- NOW/SOON/WAITINGを各1件表示して288pxに収まることを確認。
- タップで2ページ目に移動。全項目への到達を確認。
- 自動テストでPATCH/DELETE配信、複数クライアント、再接続、SQLite再起動、期限切れを検証。
- Tailscale Serve有効化後、PCからHTTPSページ200、REST state、WSS経由のHello G2 state受信を確認。
- iPhoneのEven AppでQRを読み取り、実機G2に `Hello G2` が表示されたことをユーザーが確認。確認時のServer WebSocket接続数は1。
- v0.1.1再読込後にServerへPOSTした `Update test 2` が、再読込なしで実機G2に反映されたことをユーザーが確認。起動後のリアルタイム更新に成功。

ローカル画像: `.local/g2-hello-preview.png`、`.local/g2-all-sections-preview.png`、`.local/g2-page-two-preview.png`。Simulator framebufferは透明度に輝度が入るため、確認用画像は黒背景に合成したもの。

## 未確認 / 実機確認が必要

- 実機でのPATCH/DELETE反映、ページ切替。
- 実機フォント、日本語、描画遅延、Bluetooth切断からの復帰。
- ロック/背景移動からの復帰。
- v0.2.0のロック中更新。パッケージ提供後の起動・更新反映は確認済みだが、Beta / Privateなどの導入経路はユーザー報告では明言されていない。
- 標準終了確認とキャンセル後の動作。

Simulator 0.9.5では `shutDownPageContainer(1)` 後に確認ダイアログではなく画面消去を観測し、その後の終了イベントも届かなかった。アプリは公式契約に従って終了イベントで購読を解放するため、このSimulatorでは終了後の更新が「container not found」になる。実機の終了確認が動いたとは報告しない。

Phase 1の基本動作「POST → Server → WebSocket → Even Hub Plugin → 実機G2表示」を、初回表示と起動後の更新の両方で確認した。復帰など上記の追加実機検証は未実施。MCPは未着手。後続作業でローカルAgent進捗収集を追加した。

## ローカルAgent進捗表示

2026-09-25、LOCAL_AGENT_MONITOR=1を常駐サーバーへ適用。既存のG2 Plugin 0.2.0から接続を継続し、Codexのこの作業を「Codex 実行 even-agent」として配信。Simulatorで1タスク1行の表示を確認（.local/g2-agents-preview.png）。Claudeは現在動かしていないとのユーザー回答と、最近の稼働記録がない結果が一致した。

進捗判定・取得・画面・APIの6件を追加し、pnpm checkの全18件が成功。Claudeの実作業による遷移確認と、今回の省スペース表示の実機確認は未実施。収集範囲は [進捗モニター](agent-monitor.md) を参照。

## Claude Codeクラウド進捗表示

同日13:53、CLAUDE_CLOUD_MONITOR=1を常駐サーバーへ適用。実アカウントのlauncherクラウドセッションを内部APIから取得し、idleを確認。ローカルCodeのbridgeセッションと区別できた。期限切れだった認証はClaude CLI起動時の正規処理で更新された。信頼確認はキャンセルし、作業の再開・移動はしていない。

追加4テストを含む全22テストとtypecheck / lint / build / formatが成功。再起動後の/api/agentsでsources.claudeCloud=ok、/healthでdisplayClients=1、Tailscale HTTPSの画面配信を確認。過去の完了セッションは2分の表示期限を過ぎているため画面に再表示していない。クラウド実作業の状態遷移と実機上のClaude雲行の確認は未実施。

## 0.3.0 ドット絵・回転アイコン

2026-09-25、Codex / Claudeの18×18ドット絵と状態アイコンを追加。常駐サーバーはiconRowsを配信済みで、旧パッケージは従来の文字列表示を維持する。0.3.0のehpkを生成済み。

- 全26テストとtypecheck / lint / build / format、パッケージ生成が成功。
- ブラウザプレビューで両Agentのドット絵を目視確認。G2のフォント・BLE描画とは別の確認。
- 画像更新の直列化、遅い送信中の最新状態への集約、静止文字の再送抑制、切断・メニュー・終了での停止、画像エラー時の文字表示への切替をテスト。
- SDKのコンテナー構成検証を通過。画像サイズ48×112を2個、テキスト8個。
- 公式Simulatorの起動はツールの自動承認審査で拒否（理由はblocked by policyのみ）されたため、Simulator描画は未確認。通常ブラウザではFlutter handlerがなく、G2のstartup code 1となるがプレビューは動作する。
- 実機での回転、画像と文字の縦位置、画像転送失敗からの復帰、終了確認をキャンセルした後の動作、電池消費は未検証。

## v0.1.1: G2メニュー終了後の更新停止を修正

`FOREGROUND_EXIT_EVENT=5` をアプリの背景移動として解釈していたが、公式の [Contextual Menu仕様](https://hub.evenrealities.com/docs/build/contextual-menu) ではメニューを閉じたときにも届く。このイベントで表示を停止し続ける不具合を修正した。

`FOREGROUND_ENTER_EVENT=4` はシステムメニュー表示中としてSDK書込を保留し、5で最新テキストを再送する。WebSocketを切断しない。実際のアプリ終了は6/7で処理する。

Simulatorの `context_menu` 操作でイベント4→5を観測し、メニュー表示中にPOSTした `Menu recovery OK` が、閉じた後のG2 framebufferに表示されることを確認。画像: `.local/g2-menu-recovery-preview.png`。実機でもv0.1.1再読込後の通知 `Update test 2` に対してユーザーから「うごいた」と確認を得た。

## v0.2.0: PCで画面を生成・サーバーを常駐

- ページ生成・時計をPCへ移動。Pluginは完成済み画面の描画・最後の画面の保存・再接続を担当する。
- 自動テストでdisplay API/WSの全画面配信、再接続、パッケージoriginからの読取CORSを検証。
- `releases/agent-dashboard-0.2.0.ehpk` を生成。Even App下限2.2.10。
- Windowsログイン時のタスク `Even Agent Server` を登録・起動。子サーバーを強制終了し、3秒後の別PIDへの再起動とHTTPS health/display復旧を確認。
- `pnpm server:stop` で停止し、タスクを再起動して復旧を確認。
- ログイン時トリガーの登録は確認済み。Windows再起動による実ログイン試験は未実施。
- 公式Simulatorでv0.2.0を起動し、HTTPS経由のdisplay接続とPOST後の全画面更新を確認。画像: `.local/g2-v020-preview.png`。確認用項目を削除し、Simulatorは停止済み。
- パッケージ提供後にユーザーが「起動できた」と報告。13:20:35（JST）に既存項目をPATCHし、タイトルを「接続テスト成功」、補足を「PCから更新しました 13:20:35」へ変更。ユーザーが実機G2で「変わった」と確認した。確認時のdisplayClientsは1。ロック中の試験とは区別する。

## 0.4.0 汎用画面

- PUT / GET / DELETE /api/screenで、任意の文字・Gray4画像・アニメーション・配置を保存し配信する。
- Codex / Claudeの絵とレイアウトはPCへ移動。G2クライアントの専用アイコン処理を削除し、進捗表示も同じsceneで描画する。
- 2026-09-25 14:14、実際の常駐サーバーへexamples/screen-demo.jsonをPUTし、ブラウザで自由配置の文字・グラフ・回転画像を確認。DELETEでagentsモードに復帰し、Tailscale HTTPSのhealthでも確認。
- 自動テストは29件。認証・入力検証・永続化と再起動・WebSocket配信・画像4枚の全画面配置・変更時の再構築・直列画像送信・一回再生・切断/メニュー/終了での停止を検証。
- 実機描画は未検証。Simulator起動は前回ツールの自動承認審査で拒否されており、今回は再試行せず、ブラウザプレビューとSDK構成検証を使用した。
- API仕様はdocs/screen-api.md。パッケージ0.4.0へ初回更新が必要。その後の配置・画像の変更はPC側のみで反映できる。

## 0.6.0 端末情報・音声・IMU（2026-09-25）

- 端末状態に装着・ケース・詳細接続状態・起動元を追加。操作イベントをPCへ送り、5分/100件の短い履歴として公開。
- POST /api/device/commandsでaudio / imuを開始停止。SDK応答付き。WS /ws/device/streamはその間だけ生データを購読者へ配信し、PCに保存しない。
- pnpm release:g2で型検証、lint、37件のテスト、build、format、パッケージ作成まで成功。
- 模擬SDKと実HTTP/WSでPCM/IMU転送、Bearer認証、期限、明示停止、再接続時に再開しない動作、遅れたSDK開始の停止、SDK拒否、複数端末の指定、別接続からのACK拒否、コマンドタイムアウトを確認。
- 常駐サーバー更新後、local/HTTPSのstreams API、CLI status、WSのstreamHelloとagentsモードを確認。実機の音声/IMU取得コマンドは発行していない。
- 実機センサーの取得・音質・値の意味・ロック中の挙動は0.6.0更新後に確認する。追加マイク権限を宣言したが自動取得はしない。

## APIサーバーと表示アプリの分離（2026-09-25）

- apps/dashboardへ監視・時計・レイアウトを移動し、3001番の独立プロセス化。APIサーバー3000番には汎用ライブ画面受付・リース管理を追加。
- 40テスト、型検査、lint、ビルド、整形を確認。HTTP経由の状態・残量・項目反映、認証、送信者競合、リース期限切れ、カスタム画面優先、API再起動復帰を検証。
- 実際の常駐環境でdashboard:restartを実行し、表示アプリPIDのみ変更、API PIDとG2セッションIDが維持されたことを確認。
- api:restartも実行し、API PIDのみ変更、表示アプリPID維持、ライブ画面再投稿とTailscale HTTPS healthの復帰を確認。
- ブラウザで日時・曜日・時計・G2残量・AI行を確認。実機へ接続中のPluginは既存0.6.0を使用。今回の変更後のG2目視はユーザー確認待ち。

## ヘッダーのスクロールバー修正（2026-09-26）

- ユーザー報告を受け、公式EvenHub Simulator 0.9.5で再現。文字枠28pxに上下4pxのpaddingを指定したため、時計・Claude・Codex枠の右端にスクロールバーが出ていた。ブラウザプレビューでは再現しなかった。
- 文字の1行分28pxと上下paddingの合計36pxを確保し、2行の場合は64pxへ変更。罫線も4px下へ移動。
- localhost:3002の検証用APIへ本番の表示データを複製し、Vite経由でSimulatorを接続。模擬端末情報は検証APIにだけ送られ、実機情報には混ざらない。
- Simulatorのglasses framebufferで修正前後を確認。PNGは緑RGBと透明度で表現されるため、確認画像は黒背景に合成して可視化した。
- pnpm check成功（44テスト、型・lint・build・format）。ヘッダーの有効高さを検査する回帰チェックを追加。表示アプリのみ更新、Plugin更新は不要。実機の目視は未確認。
