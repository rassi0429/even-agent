# Agent tools — Phase 2

MCP `notify` はPhase 1の実機動作確認後に実装する。共通の入力契約は
`@even-agent/protocol` の `createItemSchema` を使い、Agent Serverの
`POST /api/items` を呼ぶ。Phase 1では `pnpm hello` またはcurlで投入する。
