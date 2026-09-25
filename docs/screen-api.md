# 汎用画面API — Plugin 0.4.0

最新Plugin 0.6.0でも同じ画面APIを使う。G2の残量は [GET /api/device](device-api.md) から取得して任意のsceneへ組み込める。カスタム画面への自動挿入はしない。

PCが画面全体を定義し、G2クライアントは描画・画像のコマ再生・ページ切替・再接続だけを行う。Agent名やアイコンの絵柄はクライアントに内蔵しない。既存の進捗画面もPC側の `agent-scene.ts` と `agent-icons.ts` で生成している。

通常の表示アプリは[ライブ画面API](architecture.md)で期限付きの画面を投稿する。以下の/api/screenは永続的な手動上書き用。

## 使い始める

初回に `releases/agent-dashboard-0.4.0.ehpk` をG2側へインストールする。その後、配置や画像を変えるだけならアプリの更新は不要。

リポジトリーのルートで実行する。

```powershell
# 用意したサンプル画面を送る（文字・グラフ画像・回転アニメーション）
pnpm screen set examples/screen-demo.json
# モードとページ一覧を確認
pnpm screen status
# カスタム画面を解除して、通常のAgent進捗画面へ戻す
pnpm screen reset
```

サンプルをコードから作り直す場合は `scripts/make-screen-demo.ts` を編集し、`pnpm screen:demo` を実行する。これはJSON生成だけで、配信しない。生成したJSONを `pnpm screen set` で送る。グラフは見本であり実データではない。

CLIは `.env` のAPI_TOKENを使用する。接続先はAGENT_SERVER_URL、未設定時はlocalhostのPORT（既定3000）。別のプログラムからは以下のREST APIを使用できる。

## APIとモード

| 操作   | エンドポイント | 動作                                                          |
| ------ | -------------- | ------------------------------------------------------------- |
| PUT    | `/api/screen`  | JSONの全ページで画面を置換し、customモードにする              |
| GET    | `/api/screen`  | mode、document、updatedAtを返す                               |
| DELETE | `/api/screen`  | カスタム画面を解除。表示アプリへ戻る（live / offline / idle） |
| GET    | `/api/display` | 現在配信する画面。従来のversion 1にsceneを追加                |
| WS     | `/ws/display`  | 接続直後と変更時に全画面を配信。15秒ごとの再送も継続          |

PUT / DELETEには、サーバーにAPI_TOKENを設定している場合 `Authorization: Bearer ...` が必要。認証・アクセス範囲は既存の項目APIと同じ。PUT成功時は200、DELETE成功時は204、不正なJSONや配置は400、認証不一致は401、本文4 MiB超過は413。拒否されたPUTは元の画面を変更しない。

カスタム画面はSQLiteへ保存し、サーバー再起動後も維持する。監視や項目APIは引き続き動作するが、customモードの画面を上書きしない。DELETEは保存済みカスタム画面を削除するので、作成元JSONを手元に残しておく。

## 最小の画面

以下を `my-screen.json` に保存し、`pnpm screen set my-screen.json` で表示する。

```json
{
  "pages": [
    {
      "id": "main",
      "content": "Hello G2",
      "offlineContent": "OFFLINE / Hello G2",
      "scene": {
        "elements": [
          {
            "id": "title",
            "type": "text",
            "x": 20,
            "y": 20,
            "width": 536,
            "height": 40,
            "text": "Hello G2"
          }
        ]
      }
    }
  ]
}
```

pagesは1〜16ページ、ページIDは重複不可。G2のタップで順に切り替える。ページ番号を表示したければ、自分でtext要素に含める。

contentは旧クライアントと画像エラー時の代替テキスト。offlineContentは接続が切れた場合の代替テキスト。両方必須、各999 UTF-8バイト以下。0.2 / 0.3クライアントはsceneを無視して代替テキストを表示できる。

任意でofflineSceneを指定でき、形式はsceneと同じ。切断中はofflineSceneを表示してアニメーションを止め、各画像の最初のコマを使用する。未指定ならofflineContentの文字画面に切り替える。オフライン用の場面にはOFFLINEなどの表示を入れることを推奨する。キャッシュはWebViewのlocalStorageへ保存し、容量不足でもオンライン表示は続行する。

## 要素

sceneは `{ "elements": [...] }`。画面座標は左上(0,0)、横576・縦288ピクセル。要素の順番が描画順で、後ろの要素ほど手前。要素IDは同じscene内で重複不可、64文字まで。座標・寸法は整数で画面内に収める。

| type  | 必須フィールド                  | 任意フィールド                    |
| ----- | ------------------------------- | --------------------------------- |
| text  | id, x, y, width, height, text   | padding=0, border=0, brightness=4 |
| image | id, x, y, width, height, frames | frameMs=500, loop=true            |

テキストは1sceneに最大8個。各999 UTF-8バイト以下。paddingは0〜16px、borderは0〜4px、brightnessは0〜4。G2の内蔵フォントを使用し、文字サイズや書体の指定はない。ピクセル単位で書体を変えたい場合は、PCで画像化して送る。

画像は1sceneに最大4個。幅20〜288px（偶数のみ）、高さ20〜144px。全画面の画像は288×144の画像4枚に分割すれば576×288を覆える。画像だけのsceneにもクライアントが背面の入力受付用コンテナーを自動追加する。

### 画像の形式

framesの各コマは **Gray4の16進文字列**。1ピクセルが1文字で、`0`が黒、`f`が最も明るい。行を左から右、上から下へ並べる。コマの文字数は必ずwidth×height。例として20×20の白い四角は `"f".repeat(400)` で生成できる（JSON内に式は書かず、生成結果の文字列を入れる）。SDKに渡す際は2ピクセルを1バイトにまとめ、左のピクセルが上位4bitになる。

PNG/JPEGや外部画像URLを直接参照するAPIではない。PC側で画像をGray4に変換して渡す。任意のドット絵・グラフ・文字の画像化を扱える。画像データと描画命令のみを受け取り、JavaScriptやHTMLは実行しない。

コマは1〜16枚。1枚なら静止画、複数ならframeMsごとに再生する。frameMsは250〜60,000ms。loop=falseなら最後のコマで止まり、loop=trueなら繰り返す。1sceneの全コマの文字数は合計1 MiB以下、APIの画面ドキュメント全体は4 MiB以下。

TypeScriptの作成コードでは `packages/protocol/src/scene.ts` のpaintGray4(width, height, pixel)を利用できる。pixel(x,y)が0〜15の明るさを返す。完全な例は `scripts/make-screen-demo.ts` を参照。

## 更新と負荷

各PUTは画面全体の置換。内容だけが変わる場合、G2への転送は変更された文字・画像に限る。配置や要素構成が変わる場合はページコンテナーを再構築する。アプリ起動時のcreateは1回のみ。

アニメーションはコマ一式を受け取ったクライアント内で再生し、PCから毎フレーム通信しない。画像転送は必ず直列化し、遅い転送で遅れたコマは飛ばす。メニュー中・終了後は停止、切断中は静止。実機のBLE速度やファームウェアに依存するため、指定間隔は目標でありフレームレート保証ではない。

画像転送の失敗時は次回の描画再試行でcontentの文字画面に戻す。画像の復帰はPluginの再起動などで再試行する。サーバーへの接続復旧とSDKの再接続時にも再送する。

## 確認状況

2026-09-25、サンプルのPUTからWebSocket配信・ブラウザプレビューで任意配置の文字、グラフ画像、回転画像を確認し、DELETEで元の進捗画面に戻した。進捗画面も同じscene描画を使用する。自動テストでは保存・再起動復元、認証、入力拒否、WebSocket更新、画像のみの全画面分割、直列転送、独立した再生間隔と一回再生、オフライン・終了・メニューでの停止を検証。

G2実機の配置・画像・アニメーションは0.4.0をインストール後に確認が必要。ブラウザの文字幅や行高は近似表示で、実機のフォントと完全には一致しない。
