# Even Hub SDK 調査 / Phase 1設計

確認日: 2026-09-25。公式ドキュメント、公式テンプレート、npm配布SDKの型定義を照合。

## 採用版

- `@evenrealities/even_hub_sdk`: **0.0.16**（npm latestを確認し固定）
- SDKの `minAppVersion`: **2.2.10**
- CLI: **0.1.14**、Simulator: **0.9.5**
- ドキュメント・サンプルには旧版番号が残っているため、APIシグネチャはインストールしたSDKの `dist/index.d.ts` でも検証。

## SDKとの整合

G2がWebSocketに直接接続するのではなく、iPhone/AndroidのEven App内WebViewが通信し、SDKがBluetooth転送を担当する。Serverを正とする構成と整合する。

画面は576×288。通常のHTMLをG2へ投影することはできない。Phase 1はイベント取得用の全画面テキストコンテナ1個を使う。NOW/SOON/WAITING各1件までを1ページに収め、タップで全項目に巡回できる。長い文は省略し、全文はAPIに保持する。文字幅の近似上限を設けるが、日本語グリフ・折り返しは実機確認が必要。

起動は `waitForEvenAppBridge()` → `createStartUpPageContainer()`。初回生成は1回だけ。以降はID/nameを合わせた `textContainerUpgrade()` を直列化し、連続更新は最新内容に集約する。失敗時は表示状態を成功扱いにしない。

`CLICK_EVENT=0` はprotobufで省略される。イベントの包み自体が存在するときだけ省略値をクリック扱いにする。タップは次ページ、スクロールはfirmwareに任せ、ダブルタップは `shutDownPageContainer(1)` で標準終了確認。終了イベントで購読・通信・タイマーを解放する。

`FOREGROUND_ENTER_EVENT=4` / `FOREGROUND_EXIT_EVENT=5` はG2のシステムメニューが開く/閉じる際にも発生する。5をアプリ停止扱いにしない。メニュー表示中に受け取った最新stateは閉じた後に送信する。[公式Contextual Menu仕様](https://hub.evenrealities.com/docs/build/contextual-menu)

ネットワーク権限には接続先の完全なHTTP(S) originを指定。別origin配信時はCORSも必要。開発時はVite proxy、QR時はPlugin/APIの同一origin配信を使う。v0.2.0パッケージはPCのoriginをビルド時に指定し、読取専用 `/api/display` は任意originを許可する。HTTPS接続ではWSSを使う。

WebView停止時の常時通信は保証しない。v0.2.0は起動・復帰・再接続時にServerが生成した全画面ページを再取得する。ローカルQRテストとパッケージ版では背景動作が異なるため、ロック中動作は自分用ベータとしてインストール後、実機で確認する。導入手順は [常用版インストール](install-beta.md)。

標準Dashboardへの組み込みAPIは使わず、起動中の独立したPluginとして表示する。MCP・Actions実行・AI判断は後続段階。2026-09-25、PC側にCodex・Claudeのローカル進捗収集を追加した（[進捗モニター](agent-monitor.md)）。

## 公式参照

- [Display & UI](https://hub.evenrealities.com/docs/build/display)
- [Page Lifecycle](https://hub.evenrealities.com/docs/build/page-lifecycle)
- [Networking](https://hub.evenrealities.com/docs/build/networking)
- [Background & Lifecycle](https://hub.evenrealities.com/docs/build/background-lifecycle)
- [Local Testing](https://hub.evenrealities.com/docs/test/local-testing)
- [Packaging](https://hub.evenrealities.com/docs/ship/packaging)
- [CLI](https://hub.evenrealities.com/docs/reference/cli)
- [Simulator](https://hub.evenrealities.com/docs/test/simulator)
- [公式minimalサンプル](https://github.com/even-realities/evenhub-templates/blob/main/minimal/src/main.ts)
- [SDK配布元](https://www.npmjs.com/package/@evenrealities/even_hub_sdk)
