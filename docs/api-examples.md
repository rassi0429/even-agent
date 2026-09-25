# AgentからのAPI利用例

対象: Agent Dashboard 0.2.0提供時点。詳細は [サーバー仕様書](server-spec.md)。項目を登録・更新するとPCが全画面を生成し、接続中のPluginへ配信する。

## PowerShellで登録・更新・削除

この例は実行するとG2の表示を変更する。PC内のAgentならlocalhost、別端末なら同じtailnetからHTTPS URLを使う。トークンはAPI_TOKENをサーバーに設定した場合だけ必要。

```powershell
$baseUrl = 'http://127.0.0.1:3000'
# 別端末の場合:
# $baseUrl = 'https://neoneo-1.tailb20a71.ts.net'
$headers = @{}
if ($env:API_TOKEN) {
  $headers.Authorization = 'Bearer ' + $env:API_TOKEN
}

# 10分後に消える通知を作成
$body = @{
  title = 'ビルド完了'
  description = 'テストを通過しました'
  section = 'now'
  priority = 'high'
  source = 'build-agent'
  expiresAt = [DateTimeOffset]::UtcNow.AddMinutes(10).ToUnixTimeMilliseconds()
} | ConvertTo-Json
$item = Invoke-RestMethod "$baseUrl/api/items" -Method Post `
  -Headers $headers -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes($body))
$item.id  # 継続更新する場合は保存する

# 同じ項目を確認待ちへ移動し、期限を解除
$patch = @{
  title = 'レビュー待ち'
  section = 'waiting'
  priority = 'normal'
  expiresAt = $null
} | ConvertTo-Json
Invoke-RestMethod "$baseUrl/api/items/$($item.id)" -Method Patch `
  -Headers $headers -ContentType 'application/json; charset=utf-8' `
  -Body ([Text.Encoding]::UTF8.GetBytes($patch))

# 実際に配信するページを確認
(Invoke-RestMethod "$baseUrl/api/display").pages

# 完了後、この例で作った項目だけを削除
Invoke-RestMethod "$baseUrl/api/items/$($item.id)" -Method Delete -Headers $headers
```

PowerShellは.envを自動で読まない。サーバーにトークンを設定した場合、呼出元にも同じ値を安全に渡す。書込トークンをG2パッケージやVITE_*へ入れない。

## Node.jsから送る

Node.js 24以上で実行する例。環境変数AGENT_SERVER_URLはこの例で使う接続先であり、サーバーのlisten設定ではない。

```javascript
const base = process.env.AGENT_SERVER_URL || 'http://127.0.0.1:3000';
const response = await fetch(new URL('/api/items', base), {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(process.env.API_TOKEN
      ? { Authorization: `Bearer ${process.env.API_TOKEN}` }
      : {}),
  },
  body: JSON.stringify({
    title: '確認をお願いします',
    description: '変更内容を確認できる状態です',
    section: 'waiting',
    priority: 'normal',
    source: 'agent',
    expiresAt: Date.now() + 10 * 60 * 1000,
  }),
});
if (!response.ok)
  throw new Error(`${response.status}: ${await response.text()}`);
const item = await response.json();
console.log(item.id);
```

POSTは再実行のたびに項目を増やす。応答を受け取れなかった場合の無条件再送は重複を生む可能性がある。継続的な進捗表示には返されたidを保持してPATCHする。

## 完成済み画面を購読する

Node.jsの組み込みWebSocketで観測する最小例。切断時の再試行は含まない。

```javascript
const socket = new WebSocket('ws://127.0.0.1:3000/ws/display');
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.type === 'display') {
    console.log(message.data.pages[0].content);
  }
});
socket.addEventListener('error', (event) => console.error(event));
// 終了する場合: socket.close();
```

接続直後と変更時、さらに15秒ごとに全ページが届く。これはPCからの配信確認であり、実機への描画完了通知ではない。既存Pluginの再接続実装は [sync.ts](../apps/even-g2/src/sync.ts) を参照。
