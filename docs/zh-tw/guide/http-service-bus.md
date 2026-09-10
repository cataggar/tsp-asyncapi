---
title: "HTTP 與 Service Bus 互通"
description: "讓 HTTP API、Service Bus command、event 與 reply 共用 Order 領域 model，同時保留不同封裝。"
---

# HTTP 與 Service Bus 互通

公開[範例](https://github.com/cataggar/tsp-asyncapi/tree/main/examples/19-http-service-bus)
描述三個應用程式及 gateway 獨立的 HTTP 進入點，使用
[Service Bus companion](../reference/service-bus) 與
[已審查的 profile](../design/azure-service-bus-profile)，不是 AMQP 0-9-1 binding。
範例沒有 HTTP server、Azure SDK、佈建或憑證取得程式。

[English](../../guide/http-service-bus)

## 共用領域，不強迫共用封裝

`domain/order.tsp` 只宣告一次 Order，不含 HTTP、AsyncAPI 或 Service Bus
annotation。兩種 emitter 共用下列內建限制：

```typespec
model Order {
  @format("uuid")
  orderId: string;

  @minLength(1)
  customerId: string;

  @minItems(1)
  items: OrderLine[];
}
```

OrderLine 的 SKU 不可為空，quantity 必須是 **1 到 1000** 的整數。本範例刻意
不涵蓋金額精度、版本投影、二進位格式或讀寫 visibility 轉換。

| 契約                                                | Body                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| HTTP `POST /orders`、成功的 `GET /orders/{orderId}` | 共用的 Order                                                        |
| PlaceOrder command                                  | `commandId`、`expiresAt`、`order: Order`                            |
| OrderPlaced event                                   | `eventId`、`occurredAt`、`expiresAt`、`order: Order`                |
| OrderCommandResult reply                            | `commandId`、`orderId`、accepted/rejected、選用 reason、`expiresAt` |
| HTTP 202 回條                                       | `commandId`、`orderId`、`state: pending`                            |

共用原始 model 不代表 HTTP/message 封裝相同、schema 方言相同，或演進後自動
相容。Native metadata 不是 Order 領域的屬性。

## 流程與應用程式視角

1. Caller 提交 Order 與 UUID `Idempotency-Key`；gateway 用它當 commandId。
   實作必須先持久記錄提交意圖，才回傳 **202** 與
   `Location: /order-submissions/{commandId}`。相同 key 的衝突內容回傳 409。
   本範例沒有實作這些持久化或冪等性機制。
2. Gateway 把 PlaceOrder 送到 command queue。Processor 在 orderId session
   收取 command、記錄業務結果，再送結果到固定的 gateway reply queue。
3. 接受訂單時，processor 另外發佈 OrderPlaced 到 topic。持久化 outbox/inbox
   或同等設計是應用責任，不是這份契約提供的交易或工作流程引擎。
4. Gateway 收到 reply 後更新提交與查詢狀態。
   `GET /order-submissions/{commandId}` 回傳 pending/accepted/rejected，未知紀錄
   回傳 404。**202 不代表訂單已被業務接受，更不代表已完成履約。**
5. Fulfillment 從自己的 subscription 收 event，不直接從 publisher 的 topic
   端點接收；任何應用都不會把 subscription 當成 send 目的地。Reply 與 event
   的到達順序不受保證。

| 文件        | Operation            | 主要動作與端點        | 關聯 reply     |
| ----------- | -------------------- | --------------------- | -------------- |
| Gateway     | `submitOrder`        | send 到 command queue | receive result |
| Gateway     | `receiveResult`      | receive reply queue   | 無             |
| Processor   | `processOrder`       | receive command queue | send result    |
| Processor   | `sendResult`         | send 到 reply queue   | 無             |
| Processor   | `publishOrderPlaced` | send 到 topic         | 無             |
| Fulfillment | `onOrderPlaced`      | receive subscription  | 無             |

Gateway 的 `@send op submitOrder(command: PlaceOrder): OrderCommandResult`，
與 processor 的 `@receive op processOrder(result: OrderCommandResult): PlaceOrder`
簽章方向相反。Receive 的回傳型別是收到的 request，參數是送出的 reply。
回傳型別**不表示同步呼叫，也不表示 HTTP 必須等待 broker reply**。

明確列出的 result operation 是**同一條 reply 路徑**，不是第二次傳送。Gateway
需要自己的 receive/settlement 需求，不能從 send 繼承；processor 的
duplicate-detecting reply queue 需要明確的 send identity 義務。既有
`@replyChannel` 關聯交換，沒有標準 `reply.address` 或虛構的 native-header 表達式。

## Native property 與 application header

`fixtures/flow.json` 提供固定且有效的值。這些是邏輯 fixture 視圖，不是封包擷取
或會自動抽取屬性的程式：

| Native property  | Command                      | Result                   | Event              |
| ---------------- | ---------------------------- | ------------------------ | ------------------ |
| MessageId        | commandId                    | 獨立 result ID           | eventId            |
| CorrelationId    | 明確約定為 commandId         | request MessageId        | 起因 commandId     |
| SessionId        | orderId                      | request ReplyToSessionId | orderId            |
| ReplyTo          | 組合後的 gateway reply queue | 無                       | 無                 |
| ReplyToSessionId | commandId                    | 無                       | 無                 |
| Subject          | `order.place`                | `order.result`           | `order.placed`     |
| ContentType      | `application/json`           | `application/json`       | `application/json` |

每一個邏輯 message 都有不同 ID，重試**同一個 message** 時才保留它。MessageId
不是 operation ID。Correlation 不等於 causation：application header 另外宣告
`traceId`、`contractVersion` 與選用的 `causationId`；event/result fixture 的
causationId 是觸發它的 command ID。Native property 不會被複製到 header。

Profile 固定 MessageId 對應 AMQP `properties/message-id`，CorrelationId 對應
`properties/correlation-id`，SessionId 對應 `properties/group-id`，ReplyTo 對應
`properties/reply-to`，ReplyToSessionId 對應 `properties/reply-to-group-id`。
Content type 保留在標準 message 欄位。`ttlSeconds: 3600` 要求應用把 AMQP
**header/ttl 設為 3,600,000 毫秒**，不是 application property。

固定 ReplyTo 必須符合組合後的 reply channel。Responder 必須主動路由 reply；
Service Bus 不會自動執行 request/reply。這不授權任意 caller 指定目的地，也
不是 extraction DSL。跨 message 的 correlation/session 相等關係是應用義務；
測試只檢查 fixture，JSON Schema 不能跨實際 delivery 強制這些關係。

## 部署、安全與傳送責任

`environments/public.tsp` 把 `.invalid` host 與示意 physical path 和 logical ID
分開。Subscription 的 `topicId: orders.events` 是跨文件 catalog 關係，不是懸空
AsyncAPI `$ref`。Consumer 不必加入不使用的 topic channel 來掩蓋這個關係。

連線要求 TLS、`amqps` 與 protocol version `1.0`。Broker Entra ID 驗證、身分選擇
與角色指派是外部設定。HTTP bearer 需求不代表同一 token 可用於 AMQP CBS；
不要虛構 broker bearer scheme，也不要把 Azure RBAC role 當成 OAuth scope。

| 應用程式    | 在最小可支援範圍內的 data-plane 權限     |
| ----------- | ---------------------------------------- |
| Gateway     | command 的 Send；gateway reply 的 Listen |
| Processor   | command 的 Listen；reply/topic 的 Send   |
| Fulfillment | 自己 subscription 的 Listen              |

編譯及驗證不需要 control-plane 權限、client secret、connection string、私人端點
或真實資源。

- 需求為 Standard/Premium、queue/subscription session、30 秒 lock、最多 10 次
  broker delivery，以及 24 小時 entity TTL 上限。**Topic 沒有 sessions 設定**；
  publisher 為下游 consumer 提供 SessionId。
- Command、reply 與 topic ingress 要求非分割的 duplicate detection，window 明確
  設為 **600 秒**。這是有限時間的 broker 過濾，不是持久的業務冪等性；send 結果
  不確定時，重試仍要保留同一 message ID。
- 主要 receive 明確要求 PeekLock、session 內循序處理、持久冪等性、效果成功後
  complete，以及 lock loss 當成未 settlement。Lock renewal 與 settlement
  結果處理仍由執行中的應用負責。
- 暫時失敗用 abandon；永久錯誤或耗盡 delivery 要處理 dead letter。
  Queue/subscription 另外設定過期 dead-lettering。DLQ 需要調查與補救，不會自動
  依 TTL 清除，也沒有本範例提供的安全重播程式。
- `expiresAt` 是獨立於 broker TTL 的應用 deadline。TTL 不會取消已鎖定 message
  的業務效果。
- 不保證跨 session/目的地的全域順序、無條件最終傳送、自動工作流程持久性或
  exactly-once 業務效果。Redelivery 與重複處理嘗試仍可能發生。

## 產生與驗證

使用 Node **24**、pnpm **11.21.0**、根目錄 frozen lockfile 與 workspace package。
已驗證的 TypeSpec 工具鏈為 compiler/HTTP/OpenAPI/OpenAPI3 **1.16.0**，
workspace 使用的 Protobuf/versioning 為 **0.86.0**。輸出版本另為
OpenAPI **3.1.0**、AsyncAPI **3.1.0**、profile **0.1.0**。

Companion **尚未發布**，目前請使用 workspace checkout。它必須與含必要
extension API 的 core 版本協調發布，再固定真正發布的版本；package manifest
不代表該版本已可安裝。

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm examples:interop
pnpm examples:interop:check
pnpm exec vitest run test/integration/http-service-bus-example.test.ts test/integration/http-service-bus-payloads.test.ts
pnpm run docs:build
```

四個進入點各有設定。根目錄預設是 gateway messaging；`/http`、`/processor`、
`/fulfillment` 各自獨立。Generator 讀取真正的設定，先在記憶體收集八份輸出才
寫入。Check 模式比對原始位元組與檔案集合，缺少或多出文件會失敗，不改寫 baseline，
也不產生隨機 ID 或現在時間。

既有 CI 的 Vitest 會跑生成檢查、官方 AsyncAPI parser、離線 OpenAPI validator、
本機 reference/profile 檢查，以及真正的有效/無效 payload、header 與 native
fixture。HTTP 用 OpenAPI/2020-12，訊息用共用 `createPayloadValidator` 與
`createMessageValidator` 的 **Draft-07** 驗證路徑，明確註冊 format，不轉型、
不加 default、不移除欄位。這些 helper 回傳接受結果與字串診斷；HTTP 仍用自己的
已審查 validator，不拿它取代訊息方言。Native property 另做 fixture 檢查；
其他 schema 語言或演進情境需要額外證據。來自 HTTP/command/event 的 Order
會交叉驗證，也會驗證整個封裝，避免取錯 payload 層級卻仍通過。

`deployment-unverified` 是預期且保留的警告。靜態 profile/schema 驗證不等於
Azure 部署、安全、settlement、deduplication 或通用 producer/consumer 相容性證明。
