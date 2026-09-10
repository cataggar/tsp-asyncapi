---
title: "Azure Service Bus profile 提案"
description: "以封閉、具版本的 AsyncAPI 3.1.0 擴充描述 Service Bus 契約，不提供執行階段或資源佈建 API。"
---

# Azure Service Bus 契約 profile

**狀態：已完成初期實作設計審查，2026-09-10。** 這是 [#5](https://github.com/cataggar/tsp-asyncapi/issues/5) 的設計交付項目。[#7](https://github.com/cataggar/tsp-asyncapi/pull/7) 的獨立自動化設計審查未發現阻擋實作的正確性問題，實作協調者依照要求的實作與逐一合併流程接受此設計。此紀錄不代表人工 maintainer 簽核，也不代表 companion API 已獲准發行。`profileVersion: "0.1.0"` 不是 Azure 或 AsyncAPI 官方 binding。

[English RFC](../../design/azure-service-bus-profile) |
[規範 JSON Schema](/profiles/azure-service-bus/0.1.0/schema.json) |
[審查狀態](#審查與後續實作)

本頁說明同一份契約的設計決策；精確欄位定義以共用 JSON Schema 與英文 RFC 的跨物件規則為準。JSON Schema 驗證單一擴充值，不能單獨證明拓樸、應用程式行為或 Azure 部署正確。

## 範圍與版本

| 層次                     | 基準與規劃                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| AsyncAPI                 | 固定 **3.1.0**，不是浮動的 3.x                                                                             |
| TypeSpec compiler        | **1.15.0**                                                                                                 |
| 已檢視套件               | `tsp-asyncapi-core` **0.4.2**、`tsp-asyncapi` **0.7.2**；儲存庫 `022e4bb`                                  |
| 重現環境                 | Node **24**、pnpm **11.21.0**。compiler 1.15 至少需要 Node 22，因此不能沿用舊版 README 的 Node >=20 說明。 |
| 規劃中的 versioning      | `@typespec/versioning` **0.85.0** 搭配 compiler 1.15.0；尚未宣稱 versioned profile 相容                    |
| Profile                  | 暫定 **0.1.0**；擴充 schema 使用 Draft-07                                                                  |
| Payload 與 header        | 第一階段使用 AsyncAPI 原生、以 Draft-07 為基礎的 JSON schema                                               |
| 未來 core/companion 套件 | 必須選用**確實包含核准 API 的已發行版本**。core 0.4.2 尚無公開的 extension writer，不在此虛構未來版本號。  |

`info.version`、訊息 schema 版本、compiler/套件版本、AsyncAPI 版本與 profile 版本彼此獨立。第一階段採用各應用程式各自的未版本化進入點。

本提案不包含 Azure SDK、資源佈建、認證取得、HTTP streaming、HTTP LRO、排程重試引擎、工作流程引擎、交易協調或執行階段。**不保證業務效果恰好執行一次，也不自動提供工作流程持久性。**

## 優先重用 broker-neutral core

| 契約概念        | 既有表示方式                                                                            |
| --------------- | --------------------------------------------------------------------------------------- |
| Command / event | `@message` 與 payload；`messageKind` 只是選用分類，不限制只能使用 queue 或 topic        |
| 應用程式動作    | `@send` / `@receive` 與 `operation.action`，方向一律從目前應用程式看                    |
| Channel         | 既有 channel、標準參考與 address；profile 額外描述邏輯 entity                           |
| 應用程式屬性    | `@headers` / `@header` 及標準 message `headers`，只對應 AMQP application-properties     |
| Content type    | 既有 `@contentType` 與標準 message `contentType`，不要另設第二個值                      |
| Correlation     | 真正存在的 payload/application property 才使用標準 runtime expression；原生欄位留在擴充 |
| Reply           | 既有 `@replyChannel`、`reply.channel`、`reply.messages`，另列原生路由義務               |
| Security        | 準確時重用標準 server、security scheme 與安全性參考；身分與權限配置由組合層負責         |

Gateway 的 `@send op place(command: PlaceOrder): OrderResult` 傳送 request、接收 reply。Processor 的 `@receive op process(result: OrderResult): PlaceOrder` 接收 request、傳送 reply。回傳型別不表示同步執行，也不能直接反轉一份文件產生另一個應用程式的契約。

Queue 支援 send/receive；topic 只供應用程式 send；subscription 只供 receive。Command 搭配 queue、event 搭配 topic 是建議模式，不是普遍的業務限制。

### TypeSpec 函式庫評估

| 設施                    | 第一階段決策                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@typespec/events`      | 不新增相依性。Union/variant 的 `@events`、`@data`、`@contentType` 與目前 model-based message 不同；`unsafe_getEventDefinitions` 是實驗 API。可另行設計選用的 broker-neutral adapter。 |
| `@typespec/streams`     | `@streamOf` 不代表 broker settlement、subscription、session 或持久工作流程；不混用 HTTP/SSE streaming。                                                                               |
| `@typespec/json-schema` | Draft 2020-12 不可直接當成 AsyncAPI 原生 Draft-07 schema。後續採明確的 provider/multi-format 路徑，#3 負責保真度證據。                                                                |
| `@typespec/versioning`  | 重用 snapshots 與 `@useDependency`，不另建版本圖。須先完成 #1/#4 的選定 live graph 與逐文件語意驗證，才能宣稱版本化支援。                                                             |

## 封閉的擴充介面

每個 `x-azure-service-bus` 值都必須有 `profileVersion: "0.1.0"` 與 `target` 判別欄位。所有物件都拒絕未知欄位；**未指定就是未指定**，不自動填入 false、預設設定或任何保證。每個目標只有一份完整組態，不進行深層合併。

| 位置      | 必要欄位                                           | 選用欄位                                                                                     |
| --------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `info`    | `target: info`、`asyncapiVersion: "3.1.0"`         | 無                                                                                           |
| Channel   | `target: channel`、`entity`                        | `deploymentRequirements`                                                                     |
| Message   | `target: message`                                  | `messageKind`、`nativeProperties`、`ttlSeconds`                                              |
| Operation | `target: operation`、與標準 action 一致的 `action` | `deliveryRequirements`、`applicationObligations`、`authorizationRequirements`、`nativeReply` |

套用 profile 的文件必須有 info 宣告；所有參與 Service Bus 路徑（含 reply）的 channel、operation、message 也必須有相應宣告。不從上層繼承。`target` 必須符合實際位置，包含提升到 `components` 的物件。

**僅支援 info/channel/message/operation。** 不要求 root 或 server 擴充，不支援 schema/property/reply/trait 位置。同一個 namespace 不可兼作帶 profile 的 service 與 channel，否則現有 core 會把同一值複製到兩個位置。

不得使用 AMQP 0-9-1 的 `amqp` binding。所有標準 `amqp1` binding（含 server 與參考元件）都必須省略或為 `{}`；連 `bindingVersion` 都不能放入。建議完全省略。這不是另造一個 Azure binding renderer。

### 邏輯拓樸與部署需求

`entity` 有三種形狀：`{kind: "queue", id}`、`{kind: "topic", id}`、`{kind: "subscription", id, topicId}`。ID 使用 `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`、最多 128 字元；這是專案規則，不是 Azure 實體名稱上限。

ID 在共用邏輯目錄內識別 entity，並非實體位址、Azure resource ID、operationId 或 `$ref`。同一 ID 必須維持相同 kind/parent；subscription 不可指向自己。文件內的 parent 必須是 topic；不在文件內則是組合層要解析的外部邏輯關係，不必加入未使用的 topic channel。

| 部署需求欄位             | 明確語意                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowedTiers`           | 非空且不重複的 `basic` / `standard` / `premium`；每個允許層級都要支援已知需求                                                                |
| `sessions`               | 精確要求啟用或停用；**只適用 queue/subscription，不適用 topic**                                                                              |
| `partitioning`           | 0.1.0 只接受 `disabled`；不是推測目前部署                                                                                                    |
| `duplicateDetection`     | Queue/topic ingress：`{required: true, scope: "messageId", historyWindowSeconds?}`；時間為 20..604800 秒，且須明確要求 partitioning disabled |
| `lockDurationSeconds`    | Queue/subscription 精確鎖定時間，1..300 秒                                                                                                   |
| `maxDeliveryCount`       | Queue/subscription broker delivery 次數，1..2147483647，不是 SDK/業務 retry 次數                                                             |
| `defaultTtlSeconds`      | Entity 精確預設/上限 TTL，1..2147483647 秒，不包含無限期 sentinel                                                                            |
| `deadLetterOnExpiration` | Queue/subscription 精確布林需求                                                                                                              |

Alias 的需求以交集/同時滿足處理，精確設定不可衝突。Basic 不支援 topic/subscription、session 或 duplicate detection，且 TTL 不可超過 14 天。部署未知時只能列出相容性需求，不能聲稱已啟用功能。

### 原生 metadata 固定對應

| Config key         | AMQP 1.0 位置                                      |
| ------------------ | -------------------------------------------------- |
| `MessageId`        | `properties/message-id`                            |
| `CorrelationId`    | `properties/correlation-id`                        |
| `SessionId`        | `properties/group-id`                              |
| `ReplyTo`          | `properties/reply-to`                              |
| `ReplyToSessionId` | `properties/reply-to-group-id`                     |
| `Subject`          | `properties/subject`                               |
| `ContentType`      | `properties/content-type`                          |
| 應用程式屬性       | `application-properties`，使用標準 message headers |

除了 ReplyTo/ContentType，各原生設定形狀是 `{required: boolean, const?: string, maxLength?: integer}`。值為非空字串；MessageId、SessionId、ReplyToSessionId 的有效上限為 128。CorrelationId/Subject 不虛構額外的 broker 上限。`required: false` 表示選用，並非禁止；存在時仍須符合限制。

ReplyTo 只接受 `{required: boolean}`，實際路由值由組合層/應用程式提供。ContentType 只接受 `{required: true}`，必須使用明確的標準 message `contentType`，不能在 profile 另填字面值。固定 protocol mapping 不允許重新命名或指定任意 extraction expression。

MessageId、operationId、conversation correlation、SessionId、Subject、causation 各有不同意義。相同 logical send 重試要保留 MessageId；新的 reply/event 有自己的身分。Causation 必須另外定義在 payload 或 application property。原生欄位不自動進入 payload/headers。

`ttlSeconds` 是 1..4294967 的整數，要求 producer 設定精確每則訊息 TTL；應用程式轉成 AMQP **`header/ttl` 毫秒**。Entity 上限可能截短 TTL，鎖定中的訊息也可能在到期後繼續處理。DeliveryCount 是唯讀 `header/delivery-count`；PartitionKey、排程 annotation、sequence/enqueue/lock/expiry 狀態不屬於本版 producer config。

### Application properties

Headers 必須是封閉 object（`additionalProperties: false`），屬性逐一宣告為 string、boolean、安全整數或有限 binary64 number。Integer 必須明確給定 minimum/maximum，且落在 -9007199254740991..9007199254740991。

不支援 null、陣列、物件、binary、decimal、union 或隱式 Date/UUID 物件。可明確把日期/UUID/decimal 編碼成字串，但 schema format 不會自動轉換 SDK 值。Numeric schema 約束解碼後的值，不指定某個 AMQP integer subtype；應用程式必須保留數值，不可把字串強制轉成數字。也不注入預設值或做 JSON stringify。這是跨 SDK 的可攜子集，不代表 Azure 完全不支援其他型別。

刻意定義名稱為 `CorrelationId` 的 application property 合法，但仍不同於原生 CorrelationId。鏡像的寫入、相等性檢查與序列化由應用程式負責；工具不能默默插入鏡像。

## Delivery、reply 與責任界線

`deliveryRequirements` 只描述主要 receive，不自動套用到 reply：`{receiveMode: "peekLock" | "receiveAndDelete", order?: "perSession"}`。Send 不可設定。未指定 mode 時不推論保證。

| 已宣告的模式        | 必要 application obligations                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PeekLock            | `settlement: completeAfterSuccess`、`lockLoss: treatAsUnsettled`、`failureHandling: abandonTransientDeadLetterPermanent`、`idempotency: required`          |
| ReceiveAndDelete    | `loss: accepted`、`failureHandling: applicationRecovery`；不可承諾手動 settlement、broker redelivery recovery、session order 或本次操作的 dead-letter 處理 |
| `order: perSession` | PeekLock、`sessionProcessing: serial`、queue/subscription `sessions: true`，以及必要的原生 SessionId                                                       |
| Send 身分義務       | `messageIdentity: uniquePerMessageStableOnRetry`；每則訊息必須要求 MessageId，啟用 ingress dedup 的 send 必須宣告此義務                                    |

Receive 還能明確選擇 `expiry: checkApplicationDeadline | processIfDelivered`、`deadLetter: inspectAndRemediate`。完整欄位/條件組合見共用 schema。這些是應用程式必須履行的要求，不是工具產生的實作。

Duplicate detection 只在特定 queue/topic ingress 的時間窗內比較身分，不是 receive-side dedup，更不是業務效果只執行一次。Azure 的 10 分鐘預設值不會自動寫入。Partitioned dedup 的 MessageId + PartitionKey、session key 限制屬於後續範圍，不可冒充本版單一 MessageId scope。

鎖定/complete 可能失敗，即使業務效果已發生；runtime 要處理 renewal、未知結果與重送。SDK transient retry、broker redelivery、業務 retry/replay 是不同層次。Per-session order 需要 session-lock owner 序列處理，不保證跨 session/global order。Session state 是應用程式資料，不是自動持久工作流程。

Queue/subscription 內建 DLQ，topic 沒有；DLQ 不自動依 TTL 清除。調查、補救、丟棄與 replay 由應用程式/維運負責。不能直接傳送業務訊息到 DLQ，也不能從 DLQ 再 dead-letter；本版不定義專用 DLQ operation channel。

### Correlation 與 reply

`nativeReply` 的封閉形狀：

```json
{
  "address": "fixedChannel",
  "correlation": "requestMessageId",
  "session": "requestReplyToSessionId"
}
```

`address` 也可為 `requestReplyTo`；`session` 選用。必須有標準 reply channel 與非空 reply messages，本版 reply destination 限 queue。

| 規則                      | 應用程式義務                                                                                                                     |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `requestMessageId`        | Request MessageId -> reply CorrelationId，兩邊欄位都必須 required；reply 自己的 MessageId 另行產生                               |
| `fixedChannel`            | 使用標準 reply.channel 對應的組合層位址；若 request 帶 ReplyTo，必須一致。固定邏輯 queue 在未綁定文件仍可 address null。         |
| `requestReplyTo`          | Request ReplyTo required，reply channel address null；應用程式驗證允許的目的地並解析到指定邏輯 queue，不准任意路由或自動建 queue |
| `requestReplyToSessionId` | Request ReplyToSessionId -> reply SessionId；兩欄 required，reply queue sessions true                                            |

只有原生 metadata 時，省略標準 correlationId/reply.address。**沒有 `$message.properties`**，`$message.header#/CorrelationId` 也不指向原生 AMQP property。只有真正定義的 required scalar application property/payload 才能用標準 runtime expression。`nativeReply` 不可同時宣告另一個標準 reply.address 權威來源。

讀取 orderId/commandId 以產生 native metadata、比對 correlation、處理逾時、複製 reply metadata 與路由都是應用程式義務，不是 schema extractor。

## Security、組合與演進

本 profile 的 AMQP 連線一律要求 TLS。選用的 `authorizationRequirements` 形狀是 `{tls: true, authentication?: "entraId" | "sas"}`。省略 authentication 表示未指定身分機制，不表示 TLS 可省略。主要 send 需要 Send、receive 需要 Listen；reply 需要反向權限。

Entra ID/managed identity 的認證取得與 AMQP CBS 無法完整對應成標準 security scheme。不可虛構 HTTP bearer header，也不可把 RBAC role 當 OAuth scope。只有實際使用該流程時才描述 OAuth2 client credentials；SASL PLAIN 可以準確使用標準 `type: plain`，但不是所有 SAS/CBS 情境都等於 PLAIN。

實體名稱、host、tenant-specific endpoint、身分與 role assignment 放在組合層，秘密不進文件。標準 server 可用 `protocol: amqps`、`protocolVersion: "1.0"`；不要把 amqp1 binding 名稱當 protocol version。不要對既有 dynamic channel 再套第二個 channel decorator。

Payload、application/native metadata、enum、Subject、content type 與 reply 策略改變，都可能破壞仍在 queue 或 replay 的舊訊息。Optional 欄位增加也不一定相容於 strict consumer。Versioning 不會升級已存訊息或重寫 profile 字串；#3 的有限 fixtures 不等於普遍相容性證明。

## 診斷與範例

英文 RFC 的[診斷表](../../design/azure-service-bus-profile#_6-conformance-and-diagnostics)定義**建議中的** companion 診斷，不是現有 API。未知欄位/版本、錯誤位置、重複 key、方向/拓樸矛盾、不正確 binding、native/header 混淆、settlement 衝突、已知不可能的部署要求都屬 error。Profile 不支援的功能要與 Azure 本身不可能的組態區別。

部署未知時，每份文件以 `deployment-unverified` warning 明確說明需要外部證據；不可因省略選用欄位逐一警告，也不能說已驗證 Azure。Error 不能以刪掉要求的方式降格成成功輸出。JSON Schema 不實作跨物件與執行階段檢查。

| 應用程式    | 完整 AsyncAPI 3.1.0 設計範例                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway     | [gateway.json](/profiles/azure-service-bus/0.1.0/gateway.json)：傳送 command，固定 reply queue，另有 receive reply operation            |
| Processor   | [processor.json](/profiles/azure-service-bus/0.1.0/processor.json)：接收 command、回覆結果、publish event                               |
| Fulfillment | [fulfillment.json](/profiles/azure-service-bus/0.1.0/fulfillment.json)：從 subscription receive；parent topic 不必出現在自己的 channels |

這些是設計 fixtures，不是新 companion 產生的輸出。Address null 表示尚未綁定環境。相同 native 欄位不會被放入 headers；範例 causationId 是真正的 application property。

有效變體包含明確的 native ReplyTo 動態路由、真正定義的 application-property correlation mirror。無效變體包含 topic.sessions、缺少 subscription.topicId、19 秒 dedup window、native MessageId.source expression、ReceiveAndDelete 搭配手動 settlement，以及非空 amqp1 binding。英文 RFC 有對照表與既有 raw `@extension` 語法，並以 `@jsonSchemaExtension("additionalProperties", false)` 明確關閉 application-property schema；通用 core 並不驗證 Service Bus 語意。

## 審查與後續實作

建議 companion 名稱為 **`tsp-azure-service-bus`**、namespace **`Azure.ServiceBus`**，但公開 decorator 名稱仍需實作審查。#2 應以共用 schema 的四種封閉形狀為資料介面，每個 target/view 聚合一次後，透過狹窄的**通用 extension writer**寫入一次。

Writer 需要實際 target、key、plain JSON value、來源位置，保留既有 key/序列化/衝突規則。不可 deep-import private decorator、直接改 core state symbol、改成 deep merge、新增 Azure renderer 或擴張 root/server 位置。Typed 與 raw 同 key 必須報錯，不可靜默合併。

版本化整合需要 original Program、選定 live type graph、選用 Realm、穩定 service/version identity 與範圍化宣告。單靠 source-wide `$onValidate` 不足。Replay 必須針對實際 clone 記錄，不可只以 AST/Program 當 cache key。第一階段未整合的 versioned/dependency-mutated 或 multi-service profile 使用必須明確拒絕。

| 審查項目                              | 狀態                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-10、基準 `022e4bb` 的來源分析 | Groundwork，不是 maintainer 核准                                                                                              |
| RFC、schema、範例與建議決策           | 2026-09-10 於 [#7](https://github.com/cataggar/tsp-asyncapi/pull/7) 完成審查，接受為初期實作契約；公開 decorator API 仍需審查 |
| 設計核准與 merge 紀錄                 | `7ef1a8f` 的自動化審查未發現阻擋問題，協調者已接受設計；PR 會記錄實際合併，不宣稱已有人工 maintainer 簽核                     |
| #2 companion                          | 此 PR 未實作；已審查設計合併後才開始                                                                                          |
| #6 可執行組合範例                     | 等待 #5 核准與 #2 實作                                                                                                        |

核准前可修改暫定 0.1.0；核准/發行後，接受形狀或語意變動須使用新 profile 版本與 schema 路徑。不得把未知版本默認成 0.1.0。

權威來源與固定 revision 見英文 RFC 的[來源表](../../design/azure-service-bus-profile#sources-and-revisions)：AsyncAPI v3.1.0、AMQP1 binding commit、TypeSpec `typespec-stable@1.15.0`、Azure Learn 與 Azure docs/SDK source snapshot。所有來源於 2026-09-10 檢視，未把可變動的 upstream 文件當成永遠不變的保證。
