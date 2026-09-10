# tsp-azure-service-bus

用於 AsyncAPI **3.1.0** 的 **TypeSpec library**，提供封閉且有版本的
`x-azure-service-bus` 契約 profile **0.1.0**。它不是 emitter、Azure SDK、
runtime、佈建工具，也不是 Azure 或 AsyncAPI 官方 binding。

[English](./README.md) ·
[參考文件](https://tsp-asyncapi.marvinhsu.dev/zh-tw/reference/service-bus) ·
[規範 JSON Schema](https://tsp-asyncapi.marvinhsu.dev/profiles/azure-service-bus/0.1.0/schema.json)

## 相容性與發佈狀態

初始 package manifest **尚未發佈**。請在此 workspace 使用 Node **24**、
pnpm **11.21.0**、TypeSpec **1.16.0** 與 `@typespec/versioning` **0.86.0**。
套件最低 Node 版本為 **22**；compiler peer range 刻意限制在已測試的 minor
`~1.16.0`，開發相依則固定精確版本。

此套件必須與新增公開 extension writer 與 binding reader 的 core minor
一同發佈。Changesets 會在打包前更新 `workspace:^` core peer/development
相依範圍；已安裝的 core **0.4.2 不含 writer**。請在協調發佈完成後選用真正
包含這些 API 的已發佈版本，不要假設目前 registry 套件已支援。套件版本、
應用程式版本與 `profileVersion` 彼此獨立。

搭配既有 emitter 匯入此 library，執行
`tsp compile main.tsp --emit tsp-asyncapi`，**不是**
`--emit tsp-azure-service-bus`。emitter 只列為此套件的開發／測試相依。

## 撰寫契約

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
  }
})
model OrderPlaced {
  orderId: string;
}

@dynamicChannel
@channelProfile(#{
  profileVersion: "0.1.0", target: "channel",
  entity: #{ kind: "topic", id: "orders.events" }
})
interface Events {
  @send
  @operationProfile(#{
    profileVersion: "0.1.0", target: "operation", action: "send",
    applicationObligations: #{
      messageIdentity: "uniquePerMessageStableOnRetry"
    }
  })
  op publish(event: OrderPlaced): void;
}
```

每個 decorator 接受**一份完整 config**。`profileVersion`、`target` 與
operation 對應的 `action` 都必填，不會注入、繼承或合併。同一 target
不可同時使用 typed profile 與相同 key 的原始 `@extension`。

應用程式屬性仍使用明確封閉的 AsyncAPI header model。原生
MessageId／CorrelationId／SessionId 不是 header，應用程式必須寫入固定的
AMQP property。content type 與 reply 關係仍使用標準 AsyncAPI 欄位。

## JavaScript 與測試

- 套件根入口：`getProfile(program, target)`、`PROFILE_VERSION`、
  `EXTENSION_KEY`、`NATIVE_PROPERTY_MAPPINGS`。
- `tsp-azure-service-bus/types`：唯讀 `InfoProfile`、`ChannelProfile`、
  `MessageProfile`、`OperationProfile`、`ServiceBusProfile` 與巢狀型別。
- `tsp-azure-service-bus/testing`：`ServiceBusTester`，匯入 core 與 companion，
  帶入兩個 namespace，不註冊 emitter。

Ajv 依套件內的規範 schema 驗證。型別本身不能保證封閉性、所有數值／字串
限制或跨物件一致性。

## 支援邊界

使用**各自獨立、未版本化、單一 service 的 entrypoint**。版本化、
dependency-mutated 與合併多 service 的 profile 用法會被拒絕，待 scoped
integration 完成才支援。`deployment-unverified` 警告表示尚未與 Azure
實際部署比對。

Composition 負責位址、TLS／身分、權限及部署證據。應用程式負責序列化、
原生中繼資料、correlation、路由、冪等、settlement、到期、重試與 dead letter。
本套件不承諾 exactly-once 業務效果或自動 workflow durability。

## 授權

MIT
