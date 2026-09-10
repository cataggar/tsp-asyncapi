---
title: "Protobuf payload"
description: "帶有官方 TypeSpec.Protobuf decorator 的 model，可以用 proto3 文字當作 AsyncAPI payload。本頁說明如何開啟，以及會寫出什麼。"
---

# Protobuf payload

tsp-asyncapi 原生支援 [`@typespec/protobuf`](https://www.npmjs.com/package/@typespec/protobuf) 提供的 decorator。

::: warning
這是預覽功能，預設關閉。開啟它的選項、寫出的 schema，以及回報的診斷，都可能在次版本變更。
:::

## 使用方式

先在本 emitter 旁邊安裝官方套件。

```bash
pnpm add "@typespec/protobuf@0.86.x"
```

目前支援的版本是 `0.86.x`，搭配 TypeSpec compiler `^1.16.0`。`@typespec/protobuf` 尚未進入 1.0，decorator 仍可能變動，支援範圍會隨官方發佈更新。

再於 `tspconfig.yaml` 啟用 `protobuf` 預覽功能。

```yaml
emit:
  - "tsp-asyncapi"

options:
  "tsp-asyncapi":
    preview-features: ["protobuf"]
```

## 範例

以下範例來自 [`examples/16-protobuf-payloads`](https://github.com/marvin-hsu/tsp-asyncapi/tree/main/examples/16-protobuf-payloads)。它有兩個 Protobuf package、三個帶範例的 message，以及一個掛 AMQP binding 的 RabbitMQ broker。以下只節錄 orders package 與一個 channel。

```typespec
/** What every message of this application carries beside its payload. */
model EventHeaders {
  /** Ties every message of one request together. */
  `x-correlation-id`: string;

  /** The application that published the message. */
  `x-source`: string;
}
```

```typespec
@Protobuf.package({ name: "com.example.orders" })
namespace Orders {
  /**
   * An amount of money, as the smallest unit of one currency.
   */
  // No `@AsyncAPI.message` here: this model is not a message of the
  // document. It still reaches the emitted payloads, because `OrderPlaced`
  // names it in a field, and a payload carries every declaration its
  // message reaches.
  @Protobuf.message
  model Money {
    @Protobuf.field(1)
    currency: string;

    @Protobuf.field(2)
    amount: int64;
  }

  /**
   * One order a customer placed.
   */
  // Two decorators named `message` are in scope. The AsyncAPI one marks a
  // model as a message of the document. The Protobuf one marks it as a
  // message of the `.proto` file. The Protobuf one is written qualified.
  @message
  @headers(EventHeaders)
  @Protobuf.message
  // An example carries the headers as well as the payload. The headers are
  // JSON Schema and the payload is proto3, so an example shows a reader what
  // each half looks like on its own terms.
  @messageExample(
    #{
      headers: #{ `x-correlation-id`: "req-8f21", `x-source`: "checkout" },
      payload: #{ orderId: "ord-1001", total: #{ currency: "TWD", amount: 249000 } },
    },
    #{ name: "typical-order", summary: "One order, paid in TWD." }
  )
  model OrderPlaced {
    @Protobuf.field(1)
    orderId: string;

    @Protobuf.field(2)
    total: Money;
  }
}

// The channel is a topic exchange, said with an AMQP channel binding.
@amqpChannel(#{
  `is`: "routingKey",
  exchange: #{ name: "orders", type: "topic", durable: true, vhost: "/orders" },
})
@channel("order.placed")
interface Placed {
  // Persistent delivery, said with an AMQP operation binding. `deliveryMode`
  // is 1 for transient and 2 for persistent.
  @amqpOperation(#{ deliveryMode: 2, mandatory: true, timestamp: true })
  @send
  op placed(event: Orders.OrderPlaced): void;
}
```

## 結果

payload 是 [Multi Format Schema Object](https://www.asyncapi.com/docs/reference/specification/v3.0.0#multiFormatSchemaObject)。`schemaFormat` 指名 proto3，`schema` 放文字內容。

下面是範例裡的 `OrderPlaced`，內容取自 `asyncapi.yaml`。

```yaml
components:
  schemas:
    EventHeaders:
      type: object
      properties:
        x-correlation-id:
          type: string
          description: Ties every message of one request together.
        x-source:
          type: string
          description: The application that published the message.
      required:
        - x-correlation-id
        - x-source
      description: What every message of this application carries beside its payload.
  messages:
    OrderPlaced:
      name: OrderPlaced
      description: One order a customer placed.
      headers:
        $ref: "#/components/schemas/EventHeaders"
      payload:
        schemaFormat: application/vnd.google.protobuf;version=3
        schema: |
          syntax = "proto3";

          package com.example.orders;

          // One order a customer placed.
          message OrderPlaced {
            string orderId = 1;
            Money total = 2;
          }

          // An amount of money, as the smallest unit of one currency.
          message Money {
            string currency = 1;
            int64 amount = 2;
          }
      examples:
        - name: typical-order
          summary: One order, paid in TWD.
          headers:
            x-correlation-id: req-8f21
            x-source: checkout
          payload:
            orderId: ord-1001
            total:
              currency: TWD
              amount: 249000
```

每份 payload 是一段能獨立成立的 proto3 文字。它帶著 `syntax` 那一行、`package` 那一行、自己的 message，以及該 message 經由欄位所及的每一個宣告。message 所不及的宣告不會進入 payload。所以一份 payload 只描述一個 message。

`OrderPlaced` 的欄位引用 `Money`，所以它的 payload 帶著兩個宣告。`OrderShipped` 什麼都沒引用，payload 只有自己。`Money` 不是文件的 message，所以它自己沒有 payload。

## `.proto` 檔案

如果希望同時輸出 `.proto` 定義檔，在 `tspconfig.yaml` 的 `emit` 加上官方 emitter。

```yaml
emit:
  - "tsp-asyncapi"
  - "@typespec/protobuf"

options:
  "tsp-asyncapi":
    preview-features: ["protobuf"]
  "@typespec/protobuf":
    emitter-output-dir: "{project-root}/proto"
```

官方 emitter 每個 package 寫一個檔案：`proto/com/example/orders.proto` 與 `proto/com/example/billing.proto`。orders 那份如下。

```proto
// Generated by Microsoft TypeSpec

syntax = "proto3";

package com.example.orders;

// An amount of money, as the smallest unit of one currency.
message Money {
  string currency = 1;
  int64 amount = 2;
}

// One order a customer placed.
message OrderPlaced {
  string orderId = 1;
  Money total = 2;
}

// One order that left the warehouse.
message OrderShipped {
  string orderId = 1;
  string carrier = 2;
}
```

## header

帶 `@Protobuf.message` 的 model，不可以在自己的屬性上標 `@header`。標了會回報 [`header-on-generated-payload`](../reference/diagnostics#header-on-generated-payload)，而且不會寫出任何檔案。

要描述 header，改用 [`@headers`](../reference/decorators/messages#headers) 指向另一個 model。

## `@rawPayload`

[`@rawPayload`](../reference/decorators/messages#rawpayload) 用來手寫其他語言的 schema，優先於產生的 schema。

同時帶兩者的 model 會回報 [`conflicting-message-schema-source`](../reference/diagnostics#conflicting-message-schema-source)。文件保留作者手寫的 schema。要改用產生的 schema，就從該 model 移除 `@rawPayload`。

## 取不到文字的情況

產生的 payload 有可能不存在，原因有三種。model 上方可能沒有 `@Protobuf.package`。走訪可能碰到本 emitter 寫不成 proto3 的構造。欄位可能用到對應不到 proto3 型別的 scalar。

以上每一種都會回報 [`protobuf-artifact-unavailable`](../reference/diagnostics#protobuf-artifact-unavailable)，訊息會說明是哪一種。參考頁列出走訪拒絕的每一種構造。

相同錯誤也會拒絕具有繼承欄位或索引簽章的 model，不再悄悄只輸出自身欄位或空 message。可到達宣告上的明確 TypeSpec 預設值、編譯器驗證限制（長度、pattern、format、數值與集合上下限）、`@encode`、受限 lifecycle 可見性、`@discriminator` 與 `@discriminated` 也會被拒絕，包含自訂 scalar 繼承鏈上的限制與編碼。診斷會指向不支援的宣告。請另行宣告二進位傳輸型別，並分開執行應用程式驗證；不會輸出部分產物或退回 JSON schema。

沒有額外限制且已有對應的 scalar、文件、完整 lifecycle 可見性，以及 `@encodedName("application/json", ...)` 仍可使用。僅針對 JSON 的名稱不會重新命名二進位欄位；proto3 欄位保留 TypeSpec 拼法，tag 來自 `@Protobuf.field`。

## 二進位 reader／writer 證據

基準測試獨立編譯新舊 TypeSpec 原始碼，明確指定根型別 `contract.Event`。測試以 `protobufjs` 和 `keepCase: true` 分別解析實際輸出的文字，驗證 writer 輸入，由該 writer 編碼，再以選定的 reader 解碼，同時核對值與自身欄位是否存在。官方 emitter 的 descriptor 對照仍獨立保留。

| 變更                     | 解碼成功**不代表**什麼                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增／移除選用或必要欄位 | 未知 tag 會遺失；缺少的欄位可能解碼成功但沒有自身屬性。TypeSpec 必要性是應用程式檢查，不是 proto3 傳輸上的 required 標記。                                                                                                                                |
| 明確來源預設值           | 會拒絕產生，包含明確寫出的純量零值預設。系統不會安裝遷移 adapter 或任意 TypeSpec 預設值；proto3 隱含預設值是另一回事。                                                                                                                                    |
| 選用性                   | 明確提供的選用純量零值，在 writer 與 reader 都是選用欄位時會保留存在性。安裝的 `protobufjs` 對隱含存在性的欄位會丟棄純量零值的自身欄位存在性，讀取時也是如此。缺值與 `null` 輸入不代表二進位允許 null；repeated 與 map 欄位沒有單一選用欄位的存在性語意。 |
| 重新命名或更改 tag       | 相同 tag／型別可在不同來源欄位名稱下保留值；更改 tag 卻可能解碼成功但完全遺失值。停用的 tag／名稱應加以保留。                                                                                                                                             |
| Enum 變更                | 舊 reader 可保留未知 enum 數值，但封閉 enum 的 consumer 檢查仍會拒絕；這不是符號或 ProtoJSON 相容性。                                                                                                                                                     |
| 純量型別變更             | `int32`／`sint32` 可讀取對方的資料但得到不同的值；較寬的 `int64` 可能在 `int32` reader 中截斷。解碼成功不代表值被保留。                                                                                                                                   |

每種支援的變更都執行舊→舊、舊→新、新→舊、新→新。拒絕及帶有遺失／預設值的接受結果都會被斷言，不會跳過或一概標成安全。解碼時丟棄的未知欄位無法靠重新編碼還原。writer 驗證不是來源契約驗證器，也不能證明所有數值範圍或必要性；寬整數須使用函式庫的精確表示，而非會失去精度的 JavaScript 數值。

官方 AsyncAPI parser 驗證結構與 schema 語法，不驗證執行個體。獨立的 `@headers` 仍為原生 JSON schema；產生 payload 時不允許用 `@header` 提取欄位。手寫 proto2 對照有不同的傳輸必要性／預設值語意。即使互相遞迴的 message 讓官方 AsyncAPI parser 無法推斷根型別，明確指定根型別仍可解碼。

這是特定 codec、數值與 consumer 檢查的有限基準證據，不是通用相容性證明、版本裝飾器投影測試、registry 政策、HTTP／ProtoJSON 契約或 broker 傳遞保證。
