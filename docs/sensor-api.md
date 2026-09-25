# 音声・IMUコマンドとストリーム — Plugin 0.6.0

PCがHTTPで取得開始を指示し、PluginがSDKでセンサーを起動してPCへデータを返す。PCはWebSocket購読者へリアルタイム転送する。通常起動時は両方OFF。音声認識・ファイル保存・姿勢推定は別プログラムから組み合わせる。

## コマンドで使う

0.6.0をEven Appへインストールし、G2上で起動する。iPhoneとG2を接続し、PCとのTailscale接続を保つ。マイクはEven App側の権限許可が必要。パッケージにg2-microphone / phone-microphoneを宣言済み。

受信用ターミナルを先に開く。listenは購読のみで取得を開始しない。

```powershell
pnpm device streams
pnpm device listen
```

別のターミナルで開始・停止する。音声とIMUは同時取得できる。

```powershell
pnpm device start audio 30
pnpm device start imu 30
pnpm device stop audio
pnpm device stop imu
```

startは実際にセンサーを起動する。CLIは.envのAPI_TOKENを使い、AGENT_SERVER_URLがあればそのサーバーへ接続する。既定はlocalhost:3000。listenの出力はJSON Lines。

## API

| 方法 | パス                 | 内容                                  |
| ---- | -------------------- | ------------------------------------- |
| GET  | /api/device/streams  | 対応接続のsessionIdと現在のストリーム |
| POST | /api/device/commands | audio / imuのstart / stop             |
| WS   | /ws/device/stream    | センサーデータと状態通知の受信        |

POSTの例:

```json
{
  "sensor": "audio",
  "action": "start",
  "source": "glasses",
  "durationSeconds": 30
}
```

```json
{ "sensor": "imu", "action": "start", "reportFrq": 500, "durationSeconds": 30 }
```

```json
{ "sensor": "audio", "action": "stop" }
```

sourceはglasses / phone、既定glasses。reportFrqは100〜1000の100刻み、既定100。これはSDKのペースコードで、Hzではない。durationSecondsは1〜600、既定60。時間は自動延長しない。設定変更時はstopしてからstartする。

対応接続が1つならsessionId省略可。複数あればGETのsessionIdをPOST本文へ追加する。CLIの開始にも秒数の後へsessionIdを指定できる。同一センサーの重複開始は409。0.5.0以前には制御メッセージを送らない。

成功は200で `{commandId, streamId, sessionId, ok:true, action}` を返す。400入力不正、401認証失敗、409未接続/複数接続/競合、502 SDK拒否または停止未確認、503通信断、504応答タイムアウト（8秒）。開始タイムアウト時は停止を追加で要求する。成功応答はSDKの受付を意味し、データ到着はsensorFrameで確認する。

## 受信データ

接続直後にstreamHello、その後sensorFrame / commandResult / streamStoppedが届く。全接続を配信するのでsessionId / streamId / sensorで選別する。過去の音声・IMUは再送せず、サーバーのDB・ログ・ファイルにも保存しない。

```json
{
  "type": "sensorFrame",
  "sensor": "audio",
  "sessionId": "...",
  "streamId": "...",
  "sequence": 0,
  "receivedAt": 1790300000000,
  "pcmBase64": "AQD/fw==",
  "source": "glasses",
  "direction": null,
  "speakerRole": "unknown"
}
```

音声は16kHz・符号付き16bit little-endian・モノラルPCM。Base64復号後のバイト列にWAVヘッダーはない。フレームの復号上限は16KiB。directionはSDKの符号付き16bitタグをそのまま返し、単位を変換しない。speakerRoleはself / other / unknownでEven Appの推定結果。

```json
{
  "type": "sensorFrame",
  "sensor": "imu",
  "sessionId": "...",
  "streamId": "...",
  "sequence": 0,
  "receivedAt": 1790300000000,
  "x": 1.0,
  "y": 2.0,
  "z": 3.0
}
```

x/y/zはSDK値で、単位・座標系・角度か加速度かをここでは断定しない。receivedAtはPC受信時刻で、センサーの採取時刻ではない。sequenceはストリーム単位の連番。混雑による欠落は連番で検出する。

Node.jsの受信例（wsパッケージ）:

```javascript
import { WebSocket } from 'ws';
const ws = new WebSocket('ws://127.0.0.1:3000/ws/device/stream', {
  headers: process.env.API_TOKEN
    ? { Authorization: `Bearer ${process.env.API_TOKEN}` }
    : {},
});
ws.on('message', (raw) => {
  const message = JSON.parse(String(raw));
  if (message.type !== 'sensorFrame') return;
  if (message.sensor === 'audio') {
    const pcm = Buffer.from(message.pcmBase64, 'base64');
    // 自分の録音や音声認識処理へpcmを渡す。
    console.log(message.streamId, pcm.length);
  } else console.log(message.x, message.y, message.z);
});
```

## 接続と停止

PCとPluginの両方に取得時間のタイマーがある。stop時は先に転送を止め、SDK停止を要求する。WS切断、G2切断、Plugin終了でも停止を要求し、再接続でstartを再送しない。streamStopped.confirmedはSDKの停止確認結果で、未確認はfalse。iOSや端末が停止している場合、PCから物理マイクの停止完了は保証できない。遅れて届いたSDK開始成功には再度停止を要求する。

有効な接続・streamId・取得時間のフレームのみ転送する。Plugin送信待ち64KiB超ではフレームを捨てる。PC入力は1接続256KiB/秒、WSメッセージは64KiBまで。購読者の送信待ち256KiB超でその購読接続を閉じる。購読者が離れても取得はstopまたは期限まで継続する。

API_TOKEN設定時はPOSTと受信WSに `Authorization: Bearer ...` が必要。任意ヘッダーを付けられるNode/Python等のPC側クライアントで使う。トークン未設定ではTailscaleの到達制御がアクセス境界。Pluginへ制御トークンは埋め込まない。端末WSは自己申告で、ハードウェア認証ではない。

模擬SDKと実HTTP/WSで開始・停止・転送・認証・期限・切断を検証。実機の音質、IMU値の意味、iPhoneロック中の継続、電池消費は更新後に確認が必要。

参照: [公式Device APIs（Audio / IMU）](https://hub.evenrealities.com/docs/build/device-apis)。
