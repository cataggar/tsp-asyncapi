---
title: 版本化契約
description: 依 TypeSpec 根版本及其相依套件版本，各自輸出 AsyncAPI 契約。
---

# 版本化契約

使用 **Node.js 22 以上**（以 Node.js 24 驗證）、`@typespec/compiler`
**1.16.0** 與 `@typespec/versioning` **0.86.0**。Emitter 固定使用 versioning
0.86.0；應用程式匯入此套件時也請明確安裝相同版本。整合使用 compiler 的實驗性
mutation API，並集中於 adapter；升級 compiler 或 versioning 時需要重新驗證相容性。

```bash
pnpm add --save-exact @typespec/compiler@1.16.0 @typespec/versioning@0.86.0
```

```typespec
import "tsp-asyncapi";
import "@typespec/versioning";

using AsyncAPI;
using TypeSpec.Versioning;

@service
@versioned(Versions)
namespace App {
  enum Versions { v1: "1.0", v2: "2.0" }

  @message model Event {
    @removed(Versions.v2) legacy: string;
    @added(Versions.v2) replacement: string;
  }

  @channel("events") interface Events {
    @send op publish(event: Event): void;
  }
}
```

設定 `emit: ["tsp-asyncapi"]` 後：

| 輸出                | `info.version` | Payload 屬性與 `required` |
| ------------------- | -------------- | ------------------------- |
| `asyncapi.1.0.yaml` | `1.0`          | 只有 `legacy`             |
| `asyncapi.2.0.yaml` | `2.0`          | 只有 `replacement`        |

預設輸出**所有已宣告的根版本**。每份文件各自探索有效宣告、規劃 header、配置
component key、收集 schema artifact 及建立 reference cache。原始 Program 與來源型別
保留給其他 emitter；各版本檢視使用不同的有效型別身分。

## 選取版本

```yaml
emit:
  - tsp-asyncapi
options:
  tsp-asyncapi:
    version: "2.0"
    file-type: json
    output-file: "contracts/{version}/asyncapi.{file-type}"
```

`version` 精確比對 enum 的**值**，例如 `"2.0"`，不是成員名稱 `"v2"`。
必須只選取一個有根版本的 service。未知值、未版本化的 service（包括只有相依版本
的檢視），或不明確的 service 選擇，都會回報錯誤。只選一個版本也不會移除預設檔名
中的版本後綴。

選取的根版本一定是 `info.version`。`@info(#{ version: "..." })` 只提供中繼資料，
不會選取 schema。兩者不同時會回報非致命的 `version-info-conflict` 警告，文件仍使用
選取的版本值。未版本化的文件維持原有的中繼資料及預設值。

檔名模板支援 `{service-name}`、`{service-name-if-multiple}`、`{version}` 與
`{file-type}`。自訂固定檔名只有在結果唯一時才合法，不能讓多個版本互相覆寫。
寫入任何檔案前，會先檢查整組檔名，包括跨平台正規化後的衝突。

## Service 選取與 alias

多個 service 會分別建立自己的版本檢視。可同時設定 `service: Apps.Versioned`
與 `version: "2.0"`，只選取一份文件；預設檔名仍是
`asyncapi.Apps.Versioned.2.0.yaml`。Service 身分及原始 service 數量在 mutation
前就已確定，不會因篩選而改名。未版本化及只有相依版本的 service 不使用版本檔名
token；HTTP-only service 會得到自己的空 AsyncAPI 文件。

Service 所有權在 **mutation 之後**才套用。已移除的宣告不會透過原始 decorator
registry 或 operation 來源簽章重新出現。已使用及未使用的 message、interface channel
與 action alias 執行個體，會在 mutation 前盤點，再放入複製的 namespace map，讓 TypeSpec
真正套用版本可用性及型別變更。這些執行個體的欄位、operation 簽章及移除行為都遵循
選定檢視；原始來源宣告保持不變。
同一宣告的不同執行個體即使共同改名，也會保留各自的盤點鍵值；一般的 channel 及
operation 命名衝突仍會回報診斷。

未選取 service 的 decorator 重播診斷不會使選定 service 失敗。但選定檢視實際參照的
領域型別，包括 header 及歷史欄位型別，其錯誤仍會回報。Adapter 只限定同步 mutation
期間的重播診斷範圍，不會移除原始編譯診斷。
Discriminator 的可達範圍包含所有層級的子型別，即使中間的子型別沒有自行宣告
discriminator，也不會中斷探索。

## 相依版本與支援的變更

使用 TypeSpec `@useDependency`，在根版本 enum 成員或未版本化的 service namespace
上指定相依版本。Versioning 套件負責解析直接與間接的相依選擇；emitter 不會擅自選取
最新版本，也不會列出所有相依版本的笛卡兒積。只有相依版本的 service 會產生一份
暫時檢視，保留自己的 `info.version` 及未版本化的預設檔名。

支援的型別變更包括 `@added`、`@removed`、`@renamedFrom`、`@madeOptional`、
`@madeRequired`、`@typeChangedFrom` 與 `@returnTypeChangedFrom`。它們會先套用，再探索
schema 與 message、解析 interface channel 與 operation、分離 header 及解析 channel
參數。遞迴與共用 reference 都指向同一份選定版本文件。
Avro 與 Protobuf 預覽 payload 也使用相同有效型別圖，但仍受原有功能限制。

## 限制與拒絕輸出

- TypeSpec 會驗證 decorator 的目標。例如可以版本化 channel **interface**，但
  `@added` 不支援 namespace 目標。
  若 `@headers` 在選定檢視中指向已移除的 model，會拒絕輸出，而不會重新引入該宣告。
- 版本化的訊息宣告需要選定的版本化 `@service`，或有 `@useDependency` 的 service。
  未宣告 service 的預設流程不能從任意巢狀 `@versioned` namespace 推定版本，
  因此會拒絕這種組合。
- 固定 address、明確的 `@message` 名稱、runtime expression、extension 字串及 raw
  schema 都是作者提供的值，不會自動隨型別改名。參數改名可能與固定 address 不符，
  此時會對該版本檢視回報診斷。
- 每個版本都會檢查 raw schema 的本地 reference。Raw payload 會取代 carrier 的
  型別內容，與版本化欄位混用時會拒絕輸出，而不會假裝 raw schema 也跟著變更。
  請使用個別版本可用的空 message carrier，分別提供 raw schema。靜態 raw schema
  會原樣輸出，不代表已驗證其傳輸相容性。
- 不支援的產生式 schema 組合、provider 衝突，或任一選定根版本或相依版本檢視在
  解析及轉換時出現錯誤，都會阻止**整組輸出**寫入。Schema extension 格式錯誤也會
  拒絕整組輸出，包括未版本化的 service。遭拒絕的二進位檢視不會再轉換成原生 schema，
  但仍會繼續驗證其他選定檢視。`noEmit` 不寫出任何檔案；compiler 1.16 會略過 emitter，
  因此 emitter 專屬的檢視驗證需要實際執行輸出流程。
- 原生 schema 支援 message alias 執行個體，但 Avro 與 Protobuf provider 仍不支援
  template 執行個體 payload。這種組合會明確回報診斷，不會遺漏或改用原生 schema。
- 版本正確不等於 producer/consumer 相容。保留中的 message 仍需要新舊版本的資料
  驗證及傳輸格式的 reader/writer 測試。獨立 Avro emitter 仍描述原始來源；只有
  AsyncAPI 的預覽 payload 使用這些版本化檢視。
