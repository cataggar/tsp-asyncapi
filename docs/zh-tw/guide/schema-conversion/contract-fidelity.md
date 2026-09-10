---
title: "契約忠實度與演進"
description: "實際 payload 驗證與獨立 producer/consumer fixture 能證明什麼，以及不能證明什麼。"
---

# 契約忠實度與演進

AsyncAPI 文件能成功解析，不代表訊息內容符合來源契約。測試分開記錄四層證據：
TypeSpec 診斷、文件與 schema 解析、實際 payload **與應用程式 headers** 的接受結果，
以及舊 writer／新 reader 的序列化結果。Snapshot 或二進位解碼成功都不等於保留來源語意。

## 驗證的 dialect

| Lane                               | 產生的契約            | 手寫契約                              | 執行個體證據                                     |
| ---------------------------------- | --------------------- | ------------------------------------- | ------------------------------------------------ |
| AsyncAPI 3.1／JSON Schema draft-07 | 下表支援的子集        | AsyncAPI 與 draft-07 JSON/YAML 識別碼 | 獨立 Ajv + ajv-formats，保留遞迴參照             |
| Avro 1.9.0                         | Preview record 轉換   | Avro 物件 schema                      | avsc writer 編碼與獨立 reader resolver           |
| Protobuf 3                         | Preview 自包含 proto3 | 手寫 proto3 文字                      | protobufjs 分別解析 writer/reader，明確指定 root |
| Protobuf 2                         | 不產生 proto2         | 聚焦的手寫 proto2                     | required 與 default 行為，不宣稱支援產生 proto2  |
| OpenAPI 3.0、RAML 1.0、其他識別碼  | 不宣稱轉換            | 識別碼與表示法透傳                    | 不當成 draft-07 驗證；執行個體 helper 明確拒絕   |

接受十四種 `schemaFormat` 識別碼，不等於實作十四種 payload 驗證器。
外層媒體型別與內部 schema 語法分別驗證。Native、產生的 Avro 與 proto3 都涵蓋
JSON 與 YAML 文件序列化。

## 支援功能矩陣

| IDs | Native JSON 見證值                                                                                | 二進位證據或明確限制                                                              |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| F01 | 字串長度邊界、pattern、UUID、日期時間與 format profile                                            | 不支援的來源 constraints/formats 拒絕產生 artifact                                |
| F02 | 包含／排除邊界、小數、整數寬度、安全數值                                                          | 支援的精確整數／bytes；更大值使用 codec 專用表示法                                |
| F03 | 陣列數量、元素、具名陣列、Record                                                                  | 支援陣列／map；不支援的限制或 indexed record 明確拒絕                             |
| F04 | 必填／選填、nullable、default 不注入                                                              | Avro null/default resolver；proto3 presence 不等於來源必填；明確來源 default 拒絕 |
| F05 | Epoch、duration、bytes 字母表、字串編碼、nullable 分支、default/example、scalar-chain constraints | 不默默忽略來源 `@encode`，而是拒絕                                                |
| F06 | Literal/enum、anyOf/oneOf 重疊、空集合、discriminated envelope                                    | Avro 分支限制、enum/default；protobuf 數字 enum 與不支援的 union                  |
| F07 | 多層繼承、繼承的必填欄位、遞迴／共用參照                                                          | 遞迴 record/message；不支援的繼承拒絕；明確 protobuf root 與 descriptor parity    |
| F08 | 自有、spread、lifting message 繼承的 header、獨立 headers model、編碼名稱                         | 二進位 payload 旁保留 native headers；拒絕從 generated payload 提升欄位           |
| F09 | Dialect 編譯、錯誤 schema、跳脫／缺漏／循環參照、獨立 registry                                    | 手寫與產生的對照；不支援的 dialect 不計為已驗證                                   |
| F10 | Opaque scalar、visibility、數值／時間限制、extension 與 encoding 診斷                             | Metadata 拒絕的來源位置／數量；logical metadata 另行驗證                          |

從**未標記**的 base 繼承 `@header` 不會提升，既有 `inherited-header-ignored`
警告會讓欄位留在 payload。Base 本身是會提升 header 的 `@message` 時可以傳遞；
spread 則把欄位變成 message 自有欄位。矩陣沒有改變這些規則。

新的 native 警告為 `unmapped-schema-scalar`、`unsupported-encoded-constraint`、
`unsupported-schema-keyword`、`schema-extension-overrides-contract`。
已知 extension 關鍵字值不合法時回報 `invalid-schema-extension` error。
Encoding 會改寫 scalar 的各層 `allOf`；不適用新 wire type 的 constraint 省略並警告，
不留下無意義的範圍或互相矛盾的型別，也不猜測數字轉字串範圍的 regex。
Nullable union 會依分支型別檢查，包含已知 scalar 參照與繼承的 encoding，
不修改共用 component。仍適用其他分支的限制會保留；真正未知的參照型別則保守處理。
作者新增的 `$ref` 若讓產生的同層驗證關鍵字失效，也會警告。
Enum 相等性不受物件鍵順序影響；schema 形式的 `dependencies` 也會檢查較新 draft 關鍵字。

## Consumer profile 與演進

主要 JSON profile 為 **open、assert formats**：允許未知物件欄位、驗證已知 format、
拒絕未知 enum 值，並明確關閉 `coerceTypes`、`useDefaults`、`removeAdditional`。
驗證成功或失敗都不修改輸入。**Closed** profile 在明確物件路徑指定已知欄位，
不直接在 `allOf` 加上 `additionalProperties: false` 而誤判繼承欄位。
**Format-annotation** profile 則刻意不執行 format 限制。

Native／draft-07 oracle 忽略 `$ref` 同層的驗證關鍵字；要附加有效限制，請使用
`allOf` wrapper。Schema 位置的 OpenAPI `nullable` 會明確拒絕，不擴充 dialect。
Opaque annotation 只從不修改原始資料的編譯表示中移除，避免其中的 `$id` 註冊 schema
或解析真正的參照。真正的 schema 識別碼、遞迴參照與 `const`／`enum` 字面資料仍保留。
未提供的選填 headers 以空物件驗證；明確的 `null` 不會轉成空物件，會違反 object header schema。

未知驗證 keyword 或 format 會讓 helper 編譯失敗，除非明確標示 annotation-only。
`http-date` 的字面格式就是一項限制。數字／布林轉字串只證明 wire 表示為字串，
不證明標準字面文法。整數寬度是此 profile 的 assertion，不保證每個 JSON consumer
都會驗證。JSON 數值見證限於 JavaScript 安全精度，不宣稱證明完整 int64、uint64
或 decimal128。

每項獨立版本變更執行 P1→C1、P1→C2、P2→C1、P2→C2。Writer 必須先接受見證值
才序列化。E01–E10 涵蓋選填／必填新增、default、optional 變更、刪除、名稱／alias、
enum、constraint 縮緊／放寬、型別／encoding／tag 變更，以及 payload/header/envelope。
拒絕、保留原值、成功但有資料遺失或 default，分開判定。

**新增選填欄位也不是普遍安全。** 舊 open 契約只有 `id: string` 時接受
`{ id: "a", note: 42 }`；加入 `note?: string` 後就拒絕這個原本合法的訊息。
反向的新字串 `note` 可被舊 open consumer 接受，卻被 closed consumer 拒絕。
JSON 必填欄位的 default 不會自動補救舊訊息。

Avro 使用穩定 full name、`reader.createResolver(writer)`、`wrapUnions: false`。
未知 writer 欄位會略過；alias 有方向性；reader default 與 enum fallback 比對精確值，
不稱作原值保留。拒絕可能出現在建立 resolver，或讀取某個 union/enum 分支時。
產生的預設值會依完成的 Avro schema 圖遞迴檢查，包含具名 record、陣列、map，
以及每個巢狀 union 的第一個分支。外層預設值不會改排共用巢狀 union 的順序。
不合法或無限展開的預設值會回報 `tsp-avro/invalid-default` 並拒絕輸出。

Protobuf 分別建立 `keepCase: true` 的 root，明確選擇訊息。欄位值、自有欄位 presence、
未知數字 enum 與 tag 遺失各自 assertion。缺少 singular 欄位可能解碼成功卻違反來源
必填語意。舊 reader 解碼再編碼會遺失未知 tag；closed-enum 應用政策另外拒絕未知數字。
二進位名稱／tag 相容不等於 ProtoJSON 相容。
Protobuf scalar 的明確來源中繼資料會沿完整繼承鏈檢查，不在找到最近的 wire mapping
時停止；隱含的 wire mapping 仍受支援。

Avro logical type 名稱、單位、decimal precision/scale 與 fixed size 直接比對 emitted
schema；沒有 custom logical adapter 的 avsc 不證明它們的語意。`local-timestamp-*`
不屬於宣告的 Avro 1.9.0，因此拒絕。

## 保留訊息的版本化驗證

Retention suite 透過[版本化 adapter](../versioning.md) 使用真正的 TypeSpec
`@versioned` v1/v2/v3 檢視，不修改 JSON schema 來假裝版本變更。
接受結果判定之前，會先比對完整輸出集合 `asyncapi.1.0.json`、`asyncapi.2.0.json`、
`asyncapi.3.0.json`、各自的 `info.version`、AsyncAPI **3.1.0** 目標，
以及有效的 payload/header 欄位、必填集合、enum 成員、型別與限制邊界。

每個 JSON 見證值先通過自己的 **producer snapshot**，再由 `readJson` 序列化一次。
後續所有 consumer 重複使用保留下來的同一份值與序列化文字，不依 consumer 形狀重建、
改名、強制轉型、注入預設值或移除未知欄位。十個可個別歸因的 fixture 包含 34 筆
producer 訊息、204 個 consumer 結果（三個版本、兩種政策），其中 70 個預期拒絕。

| 案例        | 真正的版本變更                          | 保留訊息的證據                                                                     |
| ----------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| R01         | v2 新增選填欄位                         | 只含已宣告欄位的 v1 訊息可繼續使用；舊契約合法的 `note: 42` 會與新的選填字串衝突。 |
| R02         | v2 新增有預設值的必填欄位               | v1 省略欄位的訊息在 v2/v3 被拒絕，JSON 預設值不會補救。                            |
| R03a / R03b | 選填變必填／必填變選填                  | 分開的 fixture 呈現兩個方向，避免不同變更互相掩蓋。                                |
| R04         | v2 移除必填欄位                         | 寬容 reader 接受舊的額外欄位但不改寫資料；舊 reader 拒絕缺少該欄位的新訊息。       |
| R05         | v2 與 v3 分別改名                       | 舊名、中間名稱與現名保持分離，佇列中的值不會自動遷移。                             |
| R06         | v2 新增 enum 成員，v3 移除另一成員      | v1 舊值可通過 v2 卻被 v3 拒絕；新成員也不被舊 consumer 接受。                      |
| R07         | v2 縮緊整數範圍，v3 放寬                | 保留的端點值被中間版本拒絕；新放寬的值被舊 consumer 拒絕。                         |
| R08         | 字串改成整數，再改成整數或 null         | 不強制轉換數字文字，null 只被真正允許它的 snapshot 接受。                          |
| R09         | v2 新增選填應用程式 header，v3 改成必填 | Header 省略與未知名稱衝突會獨立失敗，不被未變的 payload 掩蓋。                     |

**寬容（tolerant）**只表示接受未知的 payload/header 欄位，不表示接受錯誤型別、
缺少必填欄位、未知 enum、無效 format 或違反邊界的值。
**嚴格（strict）**使用相同 schema 檢查，再加上明確的 consumer 已知欄位集合；
未宣告 headers 的版本不認得任何 header 名稱。所有 fixture producer 都使用 open
profile，所以 open producer 的額外欄位見證值，即使交給同版本 strict consumer 也可能失敗。

另有部署控制分別輸出明確選取的 `"1.0"`、`"2.0"`、`"3.0"`。同一份保留中的
v1 `amount: 0` 被 v2 的下限 10 拒絕，再被 v3 的下限 0 接受。
這是假設原始訊息仍可取得，不宣稱 broker 在較早 consumer 嘗試交付後仍保留它。

有限的版本化 **Avro 1.9** 與 **proto3** 控制也只編碼 writer 位元組一次，
再以獨立建立的 v1/v2/v3 codec 讀取同一份位元組。Avro 比對精確的 reader 預設值
（`note: null`、`generation: 0`）、被略過的欄位，以及 v3 必填欄位沒有預設值時的
兩次 resolver 拒絕。v1 relay 會遺失 v3 內容，後來的預設值不會還原原值。
Protobuf 分別判定未知 tag 遺失與自有欄位缺席。v3 可成功解碼 v1 位元組，但
**同一份 TypeSpec 來源**的 native v3 檢視會拒絕缺少來源必填 `generation` 的訊息。
這些語意內容判定與保留位元組未改變是不同證據，不保證解碼再編碼後位元組相同。

較完整的[獨立二進位 writer/reader 矩陣](https://github.com/cataggar/tsp-asyncapi/blob/main/test/integration/contract-binary-evolution.test.ts)
仍涵蓋 alias、enum、型別/tag 變更及 reader/writer 限制；retention 控制不重複或
擴大那份能力宣告。測試把 producer schema 與 codec 身分和訊息一起保留
（Avro resolver 需要 writer schema），不模擬 schema registry 可用性、應用程式遷移、
broker 儲存或交付操作。

## 範圍與執行

既有 Vitest runner 自動探索 `contract-fidelity`、`contract-native-diagnostics`、
`contract-encoded-union-references`、`contract-validator-draft07`、`contract-evolution`、
`contract-binary-fidelity`、`contract-binary-evolution`、
`contract-versioned-retention`、`contract-versioned-binary-retention`。
資料列在 `test/fixtures/contract-fidelity`，二進位 pair 的預期值在各 suite。
預期拒絕是一般 assertion，不是 skip。產生的有限整數見證使用 seed `3107`。

使用 Node 24 與 workspace 指定的 pnpm；鎖定的 TypeSpec compiler 需要 Node 22 以上。
先 build 再跑選定的 contract suite。驗證器僅為 test utility，不加入 emitter runtime。

有限見證是指定 profile 的反例或證據，**不是** schema 語言包含關係、所有 client
或所有歷史 producer 的相容性證明。獨立編譯的新舊來源與真正版本化的 retention
矩陣提供不同證據，都不保證每份佇列訊息或每種保留視窗的相容性。

AsyncAPI 使用 draft-07、nullable union 與自己的 discriminator，不是 OpenAPI 3.0
`nullable` 或 HTTP request/response visibility 投影。部分 lifecycle visibility 不會
選擇 send/receive shape。JSON encoded name 依媒體型別區分，不是二進位 alias。
應用程式 headers 不是 broker-native metadata；測試不證明交付、排序、TTL、
settlement、retry、exactly-once processing、deduplication、idempotency 或業務語意。
