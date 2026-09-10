# HTTP 與 Service Bus：共用 Order，保留不同封裝

[English](./README.md) · [完整指南](../../docs/zh-tw/guide/http-service-bus.md)

這是契約範例，不是 HTTP server、broker client、部署工具，也沒有實作
exactly-once 業務效果。範例不需要憑證、Azure 資源或可連線的端點。

| 應用程式         | 進入點                 | 已 commit 的文件                                         |
| ---------------- | ---------------------- | -------------------------------------------------------- |
| Gateway 訊息介面 | `main.tsp`             | `asyncapi.yaml`、`asyncapi.json`                         |
| Gateway HTTP     | `http/main.tsp`        | `http/openapi.yaml`、`http/openapi.json`                 |
| Processor        | `processor/main.tsp`   | `processor/asyncapi.yaml`、`processor/asyncapi.json`     |
| Fulfillment      | `fulfillment/main.tsp` | `fulfillment/asyncapi.yaml`、`fulfillment/asyncapi.json` |

每次編譯只有一個 service，逐一匯入需要的 message 模組，不匯入其他應用的
operation。`domain/order.tsp` 不含傳輸相關 annotation；HTTP 直接使用 Order，
command/event 則把 Order 放在各自的封裝內。`environments/public.tsp` 只有
組合用的占位值與外部驗證需求，不會部署或查詢資源。

## 重現

使用 Node **24**、pnpm **11.21.0**，從 repository 根目錄執行：

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm examples:interop
pnpm examples:interop:check
pnpm exec vitest run test/integration/http-service-bus-example.test.ts test/integration/http-service-bus-payloads.test.ts
git --no-pager diff -- examples/19-http-service-bus
```

核准的最終工具鏈為 compiler/HTTP/OpenAPI/OpenAPI3 **1.16.0**，workspace
使用的 Protobuf/versioning 為 **0.86.0**。請用 lockfile 與含 companion API 的
workspace package，不要猜測尚未發布的版本。輸出格式為 OpenAPI **3.1.0**、
AsyncAPI **3.1.0**、Service Bus profile **0.1.0**；這些都不是應用程式版本。

**草稿整合注意事項：** 此堆疊分支目前仍以 1.15.0/0.85.0 產生輸出。
合併前必須 rebase 到核准的工具鏈與 companion、重新產生文件並接受獨立審查。
完成驗證後才能移除這段說明；上述命令使用目前 checkout 的 frozen lockfile。

只編譯一個應用時，可執行 `pnpm exec tsp compile examples/19-http-service-bus`，
或加上 `/http`、`/processor`、`/fulfillment`。訊息設定預設輸出 YAML；
generator 則產生所有八份文件。

Generator 在記憶體接收編譯輸出，檢查檔案集合及原始位元組；check 模式不會改寫
baseline。現有 CI 的 Vitest 會執行此檢查。每次訊息編譯必須只有已知的
`deployment-unverified` 警告，其他診斷會失敗；警告不會被隱藏，也不代表部署成功。

`fixtures/flow.json` 分開呈現 HTTP、payload、native property 與 application
header；`fixtures/invalid-orders.json` 每筆只有一種錯誤。測試分別使用 Draft-07
與 OpenAPI/2020-12 validator，僅驗證此範例的 native JSON 子集，不宣稱通用相容性。
