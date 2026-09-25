# 端末情報・操作API — Plugin 0.6.0

PluginはSDK 0.0.16から状態と操作を受け取り、PCへ返す。音声・IMUは別の[コマンド/ストリームAPI](sensor-api.md)で明示的に開始する。画面には今までどおり時計・残量・進捗を表示する。

| 情報                                           | 参照先                       |
| ---------------------------------------------- | ---------------------------- |
| 残量・充電・装着・ケース収納・接続状態・起動元 | GET /api/device              |
| タップ・スクロール・長押し・メニュー開閉・終了 | GET /api/device/events       |
| 音声・IMUの開始停止、データ受信                | [センサーAPI](sensor-api.md) |

位置情報、ユーザー情報、スマホ写真/カメラにもSDKの入口はあるが、このPluginでは収集・公開しない。シリアル番号はリング等の別端末イベントを除外するためPlugin内だけで使用する。左右別・ケース残量はSDKのDeviceStatusにない。

## GET /api/device

```json
{
  "version": 1,
  "source": "client-reported",
  "device": {
    "model": "g2",
    "connected": true,
    "connectionState": "connected",
    "batteryLevel": 75,
    "isCharging": false,
    "isWearing": true,
    "isInCase": false,
    "launchSource": "glassesMenu",
    "controlVersion": 1
  },
  "observedAt": 1790300000000,
  "latestReport": {
    "sessionId": "decb9f5b-221f-487a-b57c-38c49f0aa069",
    "observedAt": 1790300000000,
    "data": {
      "model": "g2",
      "connected": true,
      "batteryLevel": 75,
      "isCharging": false
    }
  }
}
```

値は例。実際のlatestReport.dataには受信した追加フィールドも入る。deviceは90秒以内の接続中の報告のうち最新。latestReportは切断状態を含む最新。該当しなければそれぞれnull。observedAtはdeviceのPC受信時刻（Unixミリ秒）。sessionIdはWS接続ごとに変わり、端末固有の識別子ではない。

connectionStateはnone / connecting / connected / disconnected / connectionFailed / null。connectedとの不整合は拒否する。batteryLevelは0〜100の整数かnull。isCharging / isWearing / isInCaseはbooleanかnull。切断中はこの4項目をnullにする。launchSourceはappMenu / glassesMenu / null。旧Pluginの追加フィールドは省略されることがある。controlVersion: 1はセンサーコマンド対応の自己申告で、実際にセンサーが起動できるかはSDK応答で判断する。

SDKの未定義はnullにする。ただしSDK 0.0.16自身がDeviceStatusの省略値を0/falseへ補完するため、補完後の値と実測0%/falseをアプリから区別できない。SDK報告値として扱う。

初回・30秒ごとのgetDeviceInfoと状態イベントで更新する。時計横には残量と充電だけを表示（例: G2 75%、充電中は末尾+）。独自画面にはPC側でこのAPIを読みsceneへ組み込む。カスタム画面への自動挿入はしない。

## GET /api/device/events?after=0

```json
{
  "version": 1,
  "source": "client-reported",
  "instanceId": "98122d69-86b3-4f9d-a8d5-d247c26de6b3",
  "cursor": 1,
  "oldestSequence": 1,
  "events": [
    {
      "sequence": 1,
      "sessionId": "decb9f5b-221f-487a-b57c-38c49f0aa069",
      "observedAt": 1790300000000,
      "data": { "kind": "long-press", "channel": "system", "source": "ring" }
    }
  ]
}
```

afterより大きいsequenceを返す。次回はcursorをafterへ渡す。instanceIdが変わればサーバー再起動なのでafter=0から読み直す。直近5分・最大100件のみメモリ保持し、DB・ファイルへ保存しない。oldestSequenceとの比較で取りこぼしを検出できる。操作の確実な配送や実行キューではない。

kind: tap / double-tap / scroll-top / scroll-bottom / long-press / long-press-release / overlay-open / overlay-close / exit / abnormal-exit。

channel: system / text / list。source: left-temple / right-temple / ring / unknown（SDKが発生元を返さない場合）。containerId / itemIndexは値がある場合のみ。コンテナ名・項目名・音声・IMU生データは操作履歴に混ぜない。システムメニューの開閉はiPhoneの前景状態とは別。既存のページ送り・終了操作は継続する。

## Plugin → PC

既存の /ws/display で送信する。

```json
{
  "type": "deviceStatus",
  "data": {
    "model": "g2",
    "connected": true,
    "batteryLevel": 75,
    "isCharging": false,
    "isWearing": true,
    "isInCase": false,
    "connectionState": "connected",
    "launchSource": null,
    "controlVersion": 1
  }
}
```

```json
{
  "type": "deviceEvent",
  "data": {
    "kind": "tap",
    "channel": "text",
    "source": "unknown",
    "containerId": 1
  }
}
```

通常の状態・操作は各1KiBまで、各20件/秒/接続。切断報告は即時受け付ける。余分なフィールド・不正値は拒否。WS切断で状態を削除し、受信から90秒で失効する。失効後の画面反映は通常の15秒周期の配信までに行う。再接続時は取得後60秒以内の状態だけを再送し、操作履歴は再送しない。オフライン画面は最後の表示値をOFFLINE付きで残す。

情報は表示用WSで受信するクライアント自己申告で、端末の真正性・描画成功を証明しない。センサー開始停止は別のHTTP APIで、API_TOKEN設定時はBearer認証を使う。普通のブラウザは実機の状態を取得できない。実機の各フィールド・イベントは0.6.0更新後の確認が必要。

参照: [公式Device APIs](https://hub.evenrealities.com/docs/build/device-apis)、固定依存SDK 0.0.16の型定義・README。
