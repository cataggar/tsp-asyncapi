---
title: "Emitter 選項"
description: '在 `tspconfig.yaml` 設定，或在 CLI 以 `--option "tsp-asyncapi.<name>=<value>"` 傳入。'
---

# Emitter 選項

在 `tspconfig.yaml` 設定，或在 CLI 以 `--option "tsp-asyncapi.<name>=<value>"` 傳入。

| 選項                   | 型別               | 預設值                                                      | 效果                                                                          |
| ---------------------- | ------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `file-type`            | `"yaml" \| "json"` | `yaml`                                                      | 文件的序列化格式。                                                            |
| `output-file`          | `string`           | `asyncapi.{service-name-if-multiple}.{version}.{file-type}` | 輸出檔名或範本，寫在 `tsp-output/tsp-asyncapi/` 底下。                        |
| `service`              | `string`           | （所有已宣告的 service）                                    | 以完整 namespace 名稱精確選取一個 service，例如 `Company.Orders`。            |
| `asyncapi-id`          | `string`           | （省略）                                                    | 輸出為文件頂層的 `id` 欄位，即應用程式的全域識別碼，慣例上用 URN。            |
| `default-content-type` | `string`           | （省略）                                                    | 輸出為 `defaultContentType`。message 沒宣告 content type 時，payload 用這個。 |
| `preview-features`     | `string[]`         | `[]`                                                        | 開啟預覽功能。保留的名稱是 `protobuf` 與 `avro`。                             |

沒設定的選項會整個從文件省略，不會輸出空值。

## 用 `tspconfig.yaml`

```yaml
emit:
  - "tsp-asyncapi"
options:
  "tsp-asyncapi":
    output-file: "orders.yaml"
    file-type: "yaml"
    asyncapi-id: "urn:com:example:orders"
    default-content-type: "application/json"
```

## 用 CLI

```bash
tsp compile . --emit tsp-asyncapi \
  --option "tsp-asyncapi.file-type=json" \
  --option "tsp-asyncapi.asyncapi-id=urn:com:example:orders"
```

未知的選項名稱會在編譯時驗證失敗（`additionalProperties: false`）。打錯字會被抓到，不會被靜默忽略。`preview-features` 裡不是保留名稱的值也一樣會失敗，訊息會列出保留的名稱。

## Service 文件與檔名

預設每個標記 `@service` 的 namespace 都會產生一份 AsyncAPI 文件，包含只有 HTTP 操作的 service。沒有 messaging 宣告時會產生空的 AsyncAPI 文件，而不是依 HTTP decorator 猜測要不要輸出；不需要 HTTP 函式庫。

`service` 精確比對區分大小寫的完整 namespace 名稱，不比對 title 或簡稱。找不到或無法唯一識別的名稱都是錯誤。從多個 service 中選取 `Company.Orders`，檔名仍然是 `asyncapi.Company.Orders.yaml`；篩選不會改變用來命名的原始 service 數量。

| Token                        | 值                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `{service-name}`             | 原始完整 service namespace 名稱；沒有 service 的後備文件會省略。                                       |
| `{service-name-if-multiple}` | 原始程式有多個 service 時才填入上述名稱。                                                              |
| `{version}`                  | 由版本 adapter 提供的選用版本識別碼；未版本化文件會省略。這個 token 本身不會啟用 TypeSpec versioning。 |
| `{file-type}`                | `yaml` 或 `json`。                                                                                     |

省略的 token 也會移除緊接其後的 `.` 或 `/`。因此零個或一個未版本化 service 的預設檔名仍是 `asyncapi.yaml` 或 `asyncapi.json`。例如 `{service-name}/asyncapi.{file-type}` 會建立 service 子目錄。Service 與版本值會使用 UTF-8 百分比編碼，保留標點與 Unicode 的識別性，避免路徑分隔符、保留裝置名稱或結尾句點改變目的地。

只有一份選定文件時，仍可使用固定檔名 `output-file: orders.yaml`。多份文件需要能區分彼此的 token。emitter 會先解析並一起檢查所有路徑，包括不區分大小寫的碰撞。未知 token、無效檔名及碰撞都是錯誤；不會覆寫另一份文件，也不會自動加流水號。

## 歸屬與共用合約

每個宣告屬於最近一層包含它的 `@service`。巢狀 service 是獨立邊界，重新開啟 namespace 也不例外。Channel、action、message、reply、server、security scheme、binding、tag、extension 與文件診斷，都會先依邊界選取，再分配 component key。

Service 自有的 `@message` 即使未使用也會保留。Messaging signature 可明確引用沒有 service 歸屬的共用 `@message`；有多個 service 時，未引用的無歸屬 message 不會輸出。Payload 與 header 可共用一般 domain model，即使 model 宣告在另一個 service 裡，也不會因此匯入該 service 的應用程式 metadata。引用其他 service 的 `@message` envelope 或 reply channel 則是錯誤；請改用本地 envelope 包裝共用資料。

原始程式只有一個 service 時，無歸屬宣告保留舊有的隱含歸屬。沒有 service 時，仍產生舊有的全域後備文件。原始程式有多個 service 時，無歸屬的 channel 與 action 都有歧義，即使 `service` 只選一個也一樣；請把它們放到所屬 service 底下。在自有 channel 上具體套用的無歸屬繼承／template operation signature 是共用來源，不算額外的應用程式根節點。

emitter 會先解析所有選定文件，再開始寫檔。新增的選取／歸屬錯誤、輸出碰撞、可見 security 定義歧義與 provider 拒絕，都會阻止整組輸出。既有 resolve/lower 層回報診斷後捨棄問題項目的行為不變。`noEmit` 只停用寫檔，不停用診斷。原始碼驗證仍涵蓋整份 TypeSpec 程式；選取 service 不會隱藏其他 service 的原始碼錯誤。

## 預覽功能

預覽功能會改變輸出的文件。保留的名稱有兩個：`protobuf` 與 `avro`。本版兩個都可以使用。背後沒有實作的名稱會回報 `preview-feature-unavailable`，而且不寫出檔案。請求同時指名可用與不可用的功能時，整份一樣會被拒絕。

`protobuf` 讓帶有官方 `TypeSpec.Protobuf` decorator 的 model 拿到 proto3 payload。[Protobuf payload 指南](../guide/protobuf-payloads)說明它寫出什麼。

`avro` 讓帶有 `tsp-avro` `@Avro.avroRecord` decorator 的 model 拿到 Avro payload。payload 是以物件寫出的，因為 Avro 就是 JSON。`tsp-avro` 是這個 emitter 的選用 peer dependency。開啟這個功能的專案要自行安裝它。

兩個功能可以同時開啟。同一個 model 只能帶其中一組 decorator。兩組都帶的 model 會回報 `conflicting-generated-schema-source`，而且不寫出檔案。

::: warning
預覽功能被拒絕時不會輸出任何東西。在錯誤旁邊寫出一份文件，等於忽略了請求卻不說明。
:::
