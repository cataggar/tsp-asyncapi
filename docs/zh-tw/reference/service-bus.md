---
title: "Azure Service Bus"
description: "沿用既有 AsyncAPI 語言，提供 Azure Service Bus 的具型別契約 profile。"
---

# Azure Service Bus

`tsp-azure-service-bus` 是 **TypeSpec library**，不是 emitter、runtime、
Azure SDK 或佈建 API。它在 AsyncAPI **3.1.0** 契約中，為每個支援的物件寫入
一份封閉的 `x-azure-service-bus` profile **0.1.0**；它不是 Azure 或
AsyncAPI 官方 binding。

[English](../../reference/service-bus) ·
[已核可設計](../design/azure-service-bus-profile) ·
[規範 schema](/profiles/azure-service-bus/0.1.0/schema.json)

## 相容性與發佈

使用 Node **24**、pnpm **11.21.0**、compiler **1.15.0**（peer `~1.15.0`）
及 `@typespec/versioning` **0.85.0**。versioning 相依透過公開 API 偵測不支援
的版本化／dependency-mutated 程式，不代表已支援版本化 profile。

初始 package manifest **尚未發佈**。此 library 必須與新增公開通用 extension
writer 與 binding reader 的 core minor 一同發佈；已安裝的 core
**0.4.2 不含 writer**。companion 的 core peer/development 相依使用
`workspace:^`。既有 Changesets `updateInternalDependencies: "patch"` 政策
配合 core minor 與 companion Changeset，會在發佈前更新 workspace 範圍。
請待發佈後選定真正包含這些 API 的套件版本，此處不預先指派未來的發佈版號。

在此 workspace 執行 `pnpm install` 及 `pnpm build`。同時匯入 companion 與
`tsp-asyncapi`，以 `tsp compile main.tsp --emit tsp-asyncapi` 編譯。
不可把 companion 選為 emitter。core 是 peer；emitter 僅為開發／測試相依。

## 四個 composite decorator

所有 decorator 都位於 `Azure.ServiceBus`，接受 target 與一個
`config: valueof` 對應公開 model：

| Decorator           | Target                                                           | Config             | 額外必填欄位                                     |
| ------------------- | ---------------------------------------------------------------- | ------------------ | ------------------------------------------------ |
| `@infoProfile`      | 標記 `@service` 的 `Namespace`                                   | `InfoProfile`      | `asyncapiVersion: "3.1.0"`                       |
| `@channelProfile`   | 標記 `@channel` 或 `@dynamicChannel` 的 `Interface \| Namespace` | `ChannelProfile`   | `entity`                                         |
| `@messageProfile`   | 標記 `@message` 的 `Model`                                       | `MessageProfile`   | 無                                               |
| `@operationProfile` | 標記 `@send` 或 `@receive` 的 `Operation`                        | `OperationProfile` | `action: "send" \| "receive"`，須等於標準 action |

**每份 config 都必填** `profileVersion: "0.1.0"` 與相符的
`target: "info" | "channel" | "message" | "operation"`。不會注入、強制轉型、
填入預設值、繼承或深度合併。規範 schema 會拒絕未知欄位；
TypeSpec／TypeScript 型別輔助撰寫，但不是符合規範的證明。

使用 profile 的 service 必須有 info profile。所有參與的 channel、
operation 與標記 message（包含 reply）各自需要 profile；無關的
broker-neutral 路徑不必加入。service namespace 不可同時是 profiled
channel。重複 typed config 或 typed／原始 `@extension` 的相同 key 衝突
都是錯誤。沒有細粒度 native-property／delivery decorator，也沒有
root／server／payload／property／reply／trait profile placement。

## 完整 publisher 範例

這是獨立 entrypoint，以沒有實體位址的邏輯 topic 表達需求，不代表已驗證
Azure 部署符合需求。

```typespec
import "tsp-asyncapi";
import "tsp-azure-service-bus";

using AsyncAPI;
using Azure.ServiceBus;

@service(#{ title: "Order Publisher" })
@info(#{ version: "1.0.0" })
@infoProfile(#{
  profileVersion: "0.1.0", target: "info", asyncapiVersion: "3.1.0"
})
namespace Publisher;

@jsonSchemaExtension("additionalProperties", false)
model AppProperties {
  causationId: string;
}

@message
@contentType("application/json")
@headers(AppProperties)
@messageProfile(#{
  profileVersion: "0.1.0", target: "message", messageKind: "event",
  nativeProperties: #{
    MessageId: #{ required: true },
    ContentType: #{ required: true }
  },
  ttlSeconds: 300
})
model OrderPlaced {
  orderId: string;
}

@dynamicChannel
@channelProfile(#{
  profileVersion: "0.1.0", target: "channel",
  entity: #{ kind: "topic", id: "orders.events" },
  deploymentRequirements: #{
    allowedTiers: #["standard", "premium"],
    partitioning: "disabled",
    duplicateDetection: #{
      required: true, scope: "messageId", historyWindowSeconds: 600
    },
    defaultTtlSeconds: 3600
  }
})
interface Events {
  @send
  @operationProfile(#{
    profileVersion: "0.1.0", target: "operation", action: "send",
    applicationObligations: #{
      messageIdentity: "uniquePerMessageStableOnRetry"
    },
    authorizationRequirements: #{ tls: true, authentication: "entraId" }
  })
  op publish(event: OrderPlaced): void;
}
```

應用程式為每則邏輯訊息產生新的原生 MessageId，重試時保留同一個值。
`orderId` 與 `causationId` 不會自動擷取或複製到原生欄位。
header model 明確使用
`@jsonSchemaExtension("additionalProperties", false)` 封閉。

## Channel 與部署需求

`entity` 可為 `{kind: "queue", id}`、`{kind: "topic", id}` 或
`{kind: "subscription", id, topicId}`。ID 符合
`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`，最長 **128** 字元；
它是邏輯 catalog ID，不是實體 Azure entity 名稱、resource ID 或 `$ref`。

subscription 的 parent 不可等於自己，若在同一文件內宣告則必須是 topic。
文件未宣告的 parent 是待 composition 核對的外部關係，不是失效的
AsyncAPI reference。同一 entity 的 alias 必須有相容的精確設定；
tier 清單取交集且不可為空。傳送到 subscription 或從 topic 接收都會被拒絕，
也包括反向 reply 的方向。

`deploymentRequirements` 若存在就不可為空：

| 欄位                     | 精確接受值                                                                        | 適用 entity                                                       |
| ------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `allowedTiers`           | 非空、不重複的 `basic`、`standard`、`premium` 陣列                                | 全部；各 tier 須支援已知需求                                      |
| `sessions`               | Boolean                                                                           | Queue／subscription                                               |
| `partitioning`           | `"disabled"`                                                                      | Queue／topic                                                      |
| `duplicateDetection`     | `{required: true, scope: "messageId", historyWindowSeconds?: integer 20..604800}` | Queue／topic；必須明確停用 partitioning                           |
| `lockDurationSeconds`    | 整數 **1..300**                                                                   | Queue／subscription                                               |
| `maxDeliveryCount`       | 整數 **1..2147483647**                                                            | Queue／subscription；broker delivery 上限，不是 SDK／業務重試次數 |
| `defaultTtlSeconds`      | 整數 **1..2147483647**                                                            | 全部；精確 entity 預設／上限 TTL                                  |
| `deadLetterOnExpiration` | Boolean                                                                           | Queue／subscription                                               |

時間單位都是完整秒數，包含兩端界限。Basic 不支援 topic／subscription、
啟用 session、duplicate detection 或超過 14 天的 entity TTL。省略欄位表示
未指定，不會猜測已部署的 tier 或設定。

## Message、原生屬性與 header

`MessageProfile` 可選填 `messageKind: "command" | "event" | "reply"`、
非空 `nativeProperties` 及 `ttlSeconds`（整數 **1..4294967** 秒）。
TTL 對應 AMQP `header/ttl` 的**毫秒**，不是應用程式 header；
已知較低的 entity 上限會與精確 per-message TTL 需求衝突。

| 原生 key           | 固定 AMQP 1.0 位置             | Config                   |
| ------------------ | ------------------------------ | ------------------------ |
| `MessageId`        | `properties/message-id`        | `NativeId`               |
| `CorrelationId`    | `properties/correlation-id`    | `NativeString`           |
| `SessionId`        | `properties/group-id`          | `NativeId`               |
| `ReplyTo`          | `properties/reply-to`          | 僅 `{required: boolean}` |
| `ReplyToSessionId` | `properties/reply-to-group-id` | `NativeId`               |
| `Subject`          | `properties/subject`           | `NativeString`           |
| `ContentType`      | `properties/content-type`      | 僅 `{required: true}`    |

`NativeString` 為 `{required: boolean, const?: string, maxLength?: integer}`：
字串不可為空，`maxLength` 為正整數，`const` 不可超過 `maxLength`。
`NativeId` 額外有 **128 字元**有效上限，即使省略 `maxLength` 也適用。
profile 不替 CorrelationId 與 Subject 設定額外長度上限。
`required: false` 代表可選，不是禁止。

ContentType 需要 message 上明確的標準 `@contentType`，全域預設值不夠。
profile 不接受第二份 ContentType literal 或自訂 AMQP 位置。
broker 唯讀中繼資料、DeliveryCount、PartitionKey、排程、交易與擷取
expression 都不是此 profile 的欄位。

使用標準 `@headers(Model)` 表達 **AMQP application-properties**，
並在 model 加上 `@jsonSchemaExtension("additionalProperties", false)`。
可攜子集僅接受 string、boolean、有限 number，以及明確設定 minimum／maximum、
界限介於 **-9007199254740991..9007199254740991** 的 integer。
不接受 null、array、巢狀 object、binary、union 或隱式 date／decimal 編碼。
應用程式仍須負責無損 SDK 編碼及 wire quota。

第一版來源驗證接受不使用繼承、明確封閉的 header model，以及會轉成 scalar enum
的字串 literal enum／union。目前 core 的 `@header` lifting 會產生開放 schema，
因此請改用 `@headers`。Header 的 encoding／schema override，以及 model 的
boolean `additionalProperties` 以外的 raw payload schema override，都會明確拒絕，
不會假裝已驗證。Runtime location 也必須實際存在於輸出的可見欄位。
TypeSpec object literal 的原生限制欄位須寫為 `` `const` ``，因為 `const` 是語言關鍵字。
請將 `@headers` 套用至實際的 message；不會繼承 base message 的 decorator。

名為 `CorrelationId` 的 application property 仍是獨立應用程式屬性。
純原生 correlation 沒有標準 header pointer；不要捏造
`$message.header#/CorrelationId` 或 `$message.properties`。只有應用程式
實際寫入並檢查、必填且為 scalar 的 payload／header 欄位，才能使用標準
correlation location。

## Receive policy

`deliveryRequirements` 只適用**主要 receive**，不會自動套用到 reply。
可設定 `receiveMode: "peekLock" | "receiveAndDelete"` 及可選
`order: "perSession"`。send 不可宣告 receive requirement。

| Mode／order           | 必填 `applicationObligations`                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `peekLock`            | `idempotency: "required"`、`settlement: "completeAfterSuccess"`、`lockLoss: "treatAsUnsettled"`、`failureHandling: "abandonTransientDeadLetterPermanent"`；不可有 `loss` |
| `receiveAndDelete`    | `loss: "accepted"`、`failureHandling: "applicationRecovery"`；不可有 settlement、lockLoss、order、sessionProcessing 或 deadLetter                                        |
| `order: "perSession"` | PeekLock 加上 `sessionProcessing: "serial"`、channel `sessions: true`，且每則參與的訊息都必填原生 SessionId                                                              |

非空 obligations object 另接受 receive-only
`expiry: "checkApplicationDeadline" | "processIfDelivered"` 及
`deadLetter: "inspectAndRemediate"`。只有主要 send 可使用
`messageIdentity: "uniquePerMessageStableOnRetry"`，且必須要求 MessageId。
依賴 receive mode 的欄位不可在沒有 mode 時單獨宣告。這些欄位不會選取 SDK
policy，也不證明應用程式已實作承諾。

啟用 session 的 queue／subscription，其參與訊息需要 SessionId。
topic 本身沒有 sessions 設定，但發布的訊息可以攜帶 SessionId 供 subscription
使用。發送 entity 要求 duplicate detection 時，須有 MessageId 與傳送
identity 義務，包含 reply send。
若 receive operation 的 reply 要傳送到啟用 duplicate detection 的 queue，
請在相同邏輯 queue 另宣告涵蓋 reply message 的 profiled `@send` operation，
並明確設定 `messageIdentity`。Receive operation 本身不能攜帶 send-only 義務。

### 完整、獨立的 receiver

以**另一個 entrypoint** 編譯，不要與前述 publisher 合併。parent topic
是外部邏輯關係。

```typespec
import "tsp-asyncapi";
import "tsp-azure-service-bus";

using AsyncAPI;
using Azure.ServiceBus;

@service(#{ title: "Fulfillment" })
@info(#{ version: "1.0.0" })
@infoProfile(#{
  profileVersion: "0.1.0", target: "info", asyncapiVersion: "3.1.0"
})
namespace Fulfillment;

@message
@contentType("application/json")
@messageProfile(#{
  profileVersion: "0.1.0", target: "message", messageKind: "event",
  nativeProperties: #{ SessionId: #{ required: true } }
})
model OrderPlaced {
  orderId: string;
}

@dynamicChannel
@channelProfile(#{
  profileVersion: "0.1.0", target: "channel",
  entity: #{
    kind: "subscription", id: "orders.fulfillment", topicId: "orders.events"
  },
  deploymentRequirements: #{ sessions: true }
})
interface Orders {
  @receive
  @operationProfile(#{
    profileVersion: "0.1.0", target: "operation", action: "receive",
    deliveryRequirements: #{ receiveMode: "peekLock", order: "perSession" },
    applicationObligations: #{
      idempotency: "required",
      settlement: "completeAfterSuccess",
      lockLoss: "treatAsUnsettled",
      failureHandling: "abandonTransientDeadLetterPermanent",
      sessionProcessing: "serial"
    }
  })
  op consume(): OrderPlaced;
}
```

## 標準 reply 與原生 correlation

沿用既有 `@replyChannel` 與標準 reply message。gateway 的
`@send op place(command: PlaceOrder): OrderResult` 發送 request 並接收 reply；
processor 的 `@receive op process(result: OrderResult): PlaceOrder`
接收 request 並發送 reply。這不代表同步執行。reply channel 如需自己的
receive policy，請另宣告明確的 receive operation。

`nativeReply` 需要標準 reply 明確指定 channel 與非空 messages；
profile `0.1.0` **僅支援 queue reply destination**：

- `address: "fixedChannel"`：composition 後路由到標準邏輯 reply queue。
  原生 ReplyTo 可省略；有提供時必須一致。
- `address: "requestReplyTo"`：request 必填 ReplyTo，標準 reply channel
  的位址為 null。應用程式解析並限制目的地為宣告的邏輯 queue，
  不代表任意路由授權。
- 必填 `correlation: "requestMessageId"`：request 必填 MessageId、
  reply 必填 CorrelationId，responder 複製前者至後者。
- 可選 `session: "requestReplyToSessionId"`：request 必填 ReplyToSessionId、
  reply 必填 SessionId，reply queue 啟用 session，由應用程式完成複製。

有 `nativeReply` 時不可再加標準 `reply.address`。純原生中繼資料也應省略
標準 message `correlationId`。每則 reply 自己的 MessageId 是新的邏輯訊息
identity，不是 request 的 ID。

## Transport、composition 與限制

必須使用 TLS 上的 AMQP 1.0。`amqp1` binding 應省略（建議）或為 **`{}`**，
連 `bindingVersion` 都不可加入。不支援 AMQP 0-9-1 的 `amqp` 或其他
transport binding。已知 server 須使用相容的 TLS／AMQP 1.0 欄位，
例如 `protocol: "amqps"` 及 `protocolVersion: "1.0"`。

可選的 `authorizationRequirements` 為
`{tls: true, authentication?: "entraId" | "sas"}`；省略不表示 TLS 可選。
Send／Listen 權限取決於主要與反向 reply 的方向。Composition 提供位址、
host、catalog 關係、部署能力證據、身分與角色指派。不可嵌入憑證、
為 AMQP CBS 捏造 HTTP bearer header，或把 RBAC role 當成 OAuth scope。
標準 security scheme 僅在確實描述實際流程時使用。
第一版接受 SASL `plain` 或真實的 OAuth2 `clientCredentials` flow，
拒絕不相容的 HTTP／API-key scheme，並診斷與明確 Entra／SAS requirement
的矛盾。不會取得 token，也不證明應用程式已實作所描述的 OAuth／CBS 流程。

初期支援**未版本化、單一 service entrypoint**。在 scoped snapshot
integration 能驗證各自選取的 application graph 之前，source validation
會拒絕版本化、dependency-mutated 或多 service 的 profile 用法。
schema 驗證一份 extension value；source validation 檢查已知 placement、
topology、action、native／header、reply 與部署需求矛盾。
兩者都不檢查 Azure，也不驗證應用程式執行行為。

`deployment-unverified` 警告表示宣告需求尚未與 Azure 核對，
也包含外部 topic 關係。無效 config 或已知矛盾是錯誤，不會被悄悄捨棄。
完整分類請見[設計診斷表](../../design/azure-service-bus-profile#_6-conformance-and-diagnostics)。

應用程式負責序列化、identity、correlation、路由、冪等、lock renewal、
settlement 結果、到期／deadline 與 dead letter。入口 duplicate detection
不等於 receive／業務去重；per-session order 不等於全域順序；
TTL 不會取消業務效果。本套件沒有 exactly-once 業務保證、自動 workflow
durability、retry engine 或 DLQ cleanup。

## JavaScript API 與測試

套件根入口匯出 `getProfile(program, target)`、`PROFILE_VERSION`
（`"0.1.0"`）、`EXTENSION_KEY`（`"x-azure-service-bus"`）及
`NATIVE_PROPERTY_MAPPINGS`，其位置固定如上表。

`tsp-azure-service-bus/types` 匯出唯讀 `InfoProfile`、`ChannelProfile`、
`MessageProfile`、`OperationProfile`、`ServiceBusProfile` 與巢狀型別。
TypeScript `number`／`string` 不能驗證整數界限、pattern、物件封閉性或
跨物件規則。Ajv 使用套件內完全相同的規範 schema，不強制轉型或注入預設值；
跨物件檢查仍是額外必要步驟。

`tsp-azure-service-bus/testing` 匯出 `ServiceBusTester`，預先匯入 core、
companion，帶入 `AsyncAPI` 與 `Azure.ServiceBus` namespace，
**不註冊 emitter**。文件測試請明確選用既有 `tsp-asyncapi` emitter 與測試工具。
