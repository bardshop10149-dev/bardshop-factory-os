# ARGO 增量同步：回歸測試計畫 + 影響範圍

> 產出日期：2026-06-27。配套文件：[2026-06-27-argo-incremental-sync-design.md](./2026-06-27-argo-incremental-sync-design.md)。
> 回答的問題：把同步從「整批覆蓋」改成「增量 upsert」後，原本的按鈕/功能會不會壞？怎麼用程式回測證明它沒壞？
> 狀態：**計畫，未實作。** 不含程式碼。

---

## 直接回答

**沒辦法保證「零壞掉」。** 任何人說改同步邏輯保證不壞都是唬人。但能給比「保證」更實在的東西——**用資料證明**。

核心邏輯：**按鈕讀的是「資料」，不是同步方式。** 只要能證明「新增量同步寫進每張表的每一列，跟舊整批覆蓋一模一樣」（資料等價 golden test），那純讀取那些表的按鈕，**構造上就不會壞**。

**但這句話有重要但書（QA 打臉打對了）：「資料等價」只對「純讀取、不落地、不依賴整表完整性」的按鈕成立。** 有三類東西它證明不了：

1. **會把衍生資料「落地」的消費者** — `batch-mo-match` 寫回 `daily_order_sheets`、`runInspection` 寫 `order_inspection_runs.source_freshness`、`daily_order_sheets.rows` JSONB 是 SO/MO 的凍結副本。這些不在等價測試比對的 `erp_` 表裡。
2. **吃「整表完整」這個整批覆蓋副作用的消費者** — `batch-mo-match` 把「某列沒同步到」當成「ARGO 已刪除」，直接洗掉活的 mo_number；訂單檢核 check② 的 `poByItem.size===0` 降級假設同步是 all-or-nothing。增量做不到原子性。
3. **被當 volatile 剝掉的欄位本身** — `synced_at`（新鮮度）、`sequence_no`（庫存序號，被 order by / `.eq()` 搜尋）——它們的語意正是這次改動會變的，等價測試卻把它們剝掉所以看不到。

所以下面不是「一個測試保平安」，而是**五道測試 + SHADOW 模式（上線前先比再切）**，層層收網。

---

## 哪些按鈕/功能吃這些同步表（只列 high/critical）

| 同步表 | 下游功能/按鈕 | 壞掉會怎樣 |
|---|---|---|
| `erp_so_lines` | 出單表序號比對（daily-order-sheet / order-batch-export） | 缺列→正常 SO 變 `no_order`；重複 (project_id,line_no)→排序錯亂 |
| `erp_so_lines` | 訂單檢核 context（lib/inspection/context.ts） | 缺列→OrderUnit 組不全；duedate 過時→交期算錯；重複→污染所有檢核 |
| `erp_so_lines` | 製令總表列印回填（mo-summary/print） | partner_name/delivery_address/invoice_format 過時→印錯客戶/地址/發票別 |
| `erp_so_lines` | MRP 測試物料化 / 單獨開 PR / NG 備料 | 數量過時→需求算錯、PR 開錯量 |
| `erp_mo_lines` | **batch-mo-match cron（寫回 daily_order_sheets）** | **缺列（非刪除）被誤判成「ARGO 已刪」→把活的 mo_number/prep 狀態洗成 null**（盲點 #2） |
| `erp_mo_lines` | 出單表 MO 比對 / requiredQty() | 缺列→孤兒 mo_number；重複（first-write-wins）→靜默用錯 MO/數量，不報錯 |
| `erp_pj_sync` | **訂單檢核 check②缺料採購覆蓋（check2_material.ts）** | 部分掉列→size>0 不降級→**噴假的「缺料未採購」→誤觸 LINE 紅色警報**（盲點 #1/#4） |
| `erp_pj_sync` | 出單表 O 廠 PO 匹配 / PO·PR 列印 Modal | doc_type 過濾失效或 PR/PO 撞 doc_no→供應商/成本配錯、Modal 結果未定義 |
| `erp_pj_sync` | 自動產生 PR 號（standalone-pr-create / batch-export-pr） | reconcile 刪舊 PR→MAX(seq) 掉→**產生重複 PR 號→ERP 推送衝突** |
| `erp_material_prep_lines` | 領料單頁（material-issue）/ 備料狀態回填 | 缺列→領料計算壞、已備變未備；重複→已領旗標重複 |
| `material_inventory_list` | 備料頁庫存/單位 + BOM 可用量 | 庫存過時→缺料判斷錯；**sequence_no 凍結/變 null→序號搜尋查無、排序錯位**（盲點 #2） |
| `erp_customers` | MO 列印客戶代碼 / 領料客戶查詢 | 過時→顯示舊客戶名（影響小） |

> **被漏掉的最大一條鏈（QA 抓到）：** `app/api/inspection/cron/route.ts` 每 30–60 分跑，先 `sync_*` 再 `runInspection`，**新的 critical findings 會直接 push 到 LINE 群**（alerts.ts）。所以上面的 STALE/MISSING 不只是畫面變色——**會誤發或漏發 LINE 紅色警報**。這是自動告警管線，當一級風險處理（對應記憶 eip-line-bot）。

---

## 回測怎麼設計（5 道 + SHADOW）

**1. 資料等價 golden test（主測，`scripts/sync-equivalence.mjs`）**
證明新增量逐列等同舊整批覆蓋。每張表：分頁抓全表（1000/頁）→剝易變欄 `{id,synced_at,content_hash,updated_at}`→**按自然鍵排序**消除順序雜訊。
- snapshotA=舊整批覆蓋（oracle）；snapshotB=新「全 reconcile」；snapshotC=新「純增量(watermark)→再 reconcile」。三者深比對：列數、自然鍵集合、每個共有鍵的非易變欄值。
- **重複守衛（獨立關鍵）：** 斷言 `COUNT(*) === COUNT(DISTINCT 自然鍵)`——onConflict 選錯時，增量會產生整批覆蓋永遠不會有的重複。

**2. 按鈕煙霧測試（`scripts/sync-smoke.mjs`）**
6+1 個同步 action 各 POST 一次，斷言 200 + `status:success` + `syncedCount>0` + 列數在舊量容差內（不是 0、不是腰斬）。**每個連跑兩次斷言冪等**（增量特有，整批覆蓋從不用證）。

**3. 下游一致性（訂單檢核前後比對，`scripts/inspection-parity.mjs`）**
打非破壞性 `GET /api/inspection/preview`（只算不寫），切換前後深比對 `{kpi, findings(按 finding_key 排序), freshness}`。
- **補洞（QA 要求）：** 另外比對**真正會丟 LINE 的 `newCriticalFindings` 差集**（stub 掉 LINE 通道）——preview 只看落地結果，看不到告警差集。
- **補洞：** 另跑一條**純增量(不 reconcile)** 的 check② 判定比對——snapshotC 一定 reconcile，會把「部分 PO 缺列→size>0→不降級→誤觸警報」蓋掉。

**4. 頁面煙霧（`scripts/page-smoke.mjs`）**
high/critical 頁面在 eip-dev:3700 用 proxy 假 cookie 驅動，斷言 200 + 無錯誤標記（查無 / no_order / no detail data）。

**5. SHADOW 模式（上線策略，非測試腳本）**
每 domain 加第三旗標值：`full`(現況) | `shadow` | `incremental`。`shadow` 下**照舊做權威的 delete+insert 整批覆蓋（下游零風險）**，但**額外**算 hash、跑增量決策的乾跑路徑，把「增量本來會 MISS/DUP/STALE 哪些自然鍵」記進 `sync_shadow_log`。在正式環境真實 ARGO 資料上跑幾天，補 dev 庫沒有的邊界（ARGO 靜默刪除、doc_no 撞號、UPDATE_DATE 沒 bump）。
- **切換條件：** 某 domain 連續 N 個週期 shadow log 全 0 才從 `shadow` 切 `incremental`。
- **順序：** 從低風險 `erp_customers` 開始，最後才碰 `erp_so_lines` / `erp_pj_sync`。
- **回滾：** 翻旗標回 `full`，shadow 期間從沒停過權威覆蓋，**零資料遷移**。

---

## 怎麼跑（沒有 in-repo CI）

全部 standalone ESM Node 腳本放 `scripts/`，照既有 `scripts/migrate-auth-users.mjs` 模式本機手動跑。
- **DB 快照/比對**：service-role REST 直連，`node --env-file=.env.local scripts/sync-equivalence.mjs --table=erp_so_lines`。**另加一條 anon-key snapshot leg**（盲點 #4：頁面多走 anon client，service-role 看不到 RLS 漂移）。
- **打 endpoint**：先用 launch.json `eip-dev:3700` 起 dev。同步走內部 webhook 繞道（header `X-Internal-Secret: $WEBHOOK_SECRET`；proxy.ts 對 `/api` 一律放行、假 cookie 不驗 API，所以只能靠 secret）。頁面用 proxy 假 cookie。
- **編譯閘**：`npx tsc --noEmit` 與 `npx next build` 都要綠（build 綠是 Vercel 部署閘）。
- **建議每次合併前序列**：tsc --noEmit → next build → 快照舊狀態當 oracle → 跑增量+reconcile → equivalence 比對 → smoke 冪等 → inspection-parity（含 LINE 差集 + 純增量 check②）→ page-smoke → Supabase REST 抽樣人工 sanity。

---

## 抓不到的盲點（老實講 + 必補的額外防線）

「三快照一致就構造上不會壞」**對下面這些不成立**：

1. **新鮮度語意（殘留風險，刻意看不到）** — 等價測試剝掉 `synced_at`，但那正是會變語意的欄。所有 lastSynced 顯示在增量下對未變動列顯示「過時」時間戳；更狠的是 `runInspection.ts:75` 把 `ctx.freshness` 寫進 `order_inspection_runs.source_freshness`（落地歷史），增量會讓整條歷史系統性偏舊、不可逆。→ **backfill 前先定 synced_at 政策**（每次 reconcile 仍 bump，或加 `sync_runs` 表）。
2. **`sequence_no` 不穩（被當 volatile 剝掉而隱形）** — `route.ts:206/219` 用 `index+1` 位置式編號；`app/page.tsx:195` order by、`:79` 用 `sequence_no.eq` 搜尋。增量停止重編→凍結或 null→搜尋查無、排序錯，**測試照樣綠**。→ **額外防線：** 斷言每列 sequence_no 非 null/連續/確定，或改掉 UI 不再靠它。
3. **batch-mo-match 寫回污染（落地壞，非顯示壞）** — 依賴「整表完整」不變量，把「缺列」當「ARGO 已刪」洗掉活 mo_number 寫回 `daily_order_sheets`。等價測試只比 erp_ 表看不到。→ **額外防線：** 給「缺列但非刪除」fixture，斷言**零列被洗掉** vs 整批覆蓋基準。
4. **時間窗競態 / ARGO 靜默刪除** — watermark 漏「改了沒 bump UPDATE_DATE」「刪了沒 tombstone」的列；永遠 reconcile 的測試蓋住純增量壞路徑。→ 靠 SHADOW 真實資料補。
5. **dev 庫沒有的資料狀態（PR/PO 撞 doc_no）** — PoOrderModal/order-records 缺 doc_type 過濾，只有撞號資料存在時才爆。→ **額外防線：** 注入合成 fixture（PR+PO 同 doc_no），斷言過濾與未過濾讀取前後一致。別賭「真實資料自己會跑出來」。
6. **重複守衛循環論證** — 只在測試庫已有撞鍵列時才觸發；`erp_so_lines` 今天沒去重、實機很可能有重複。加 unique index 時 migration 去重會靜默丟列。→ **額外防線：** 加 index **之前**先對六張表跑硬閘 `COUNT(*) === COUNT(DISTINCT 鍵)` pre-migration 稽核。
7. **PR 號序列缺口（寫側完整性，零覆蓋）** — reconcile 刪舊 PR→MAX(seq) 掉→重複 PR 號→ERP 衝突。→ **額外防線：** 斷言 `請購單號` MAX(seq) 在轉換間單調不減，或歷史 PR 永不實體刪除。
8. **first-write-wins map 掩蓋重複** — context.ts:157、batch-mo-match:120、ng fallbackMoMap 都「第一筆贏」。增量若引入重複鍵，這些消費者**用錯 MO/數量且不報錯**，page-smoke 照樣綠。→ **額外防線：** 消費者層的重複行為斷言，不只比表。

---

## 我會交付什麼（greenlit 後）

- `scripts/lib/snapshot.mjs` — 共用：分頁 fetchAll、各表 NATURAL_KEYS、stripVolatile、sortByKey、deepDiff、assertNoDuplicateKeys。
- `scripts/sync-equivalence.mjs` — golden 資料等價（A/B/C 三快照，`--table` scope，非零退出附逐欄 diff）。
- `scripts/sync-smoke.mjs` — 6+1 action POST，200/success/count 容差 + 冪等。
- `scripts/inspection-parity.mjs` — preview 前後比對 + LINE `newCriticalFindings` 差集 + 純增量 check②。
- `scripts/page-smoke.mjs` — high/critical 頁面 200 + 無錯誤標記。
- `scripts/predupe-audit.mjs` — **加 unique index 前**的硬閘去重稽核（六張表）。
- 頂部說明區塊（仿 migrate-auth-users.mjs）：`--env-file=.env.local`、WEBHOOK_SECRET 需求、合併前序列。

**結論：** 「資料一致 → 按鈕不壞」只對「純讀非易變欄的無狀態消費者」成立——那是真實消費者的少數。會落地衍生資料的、吃整表完整性的、以及 synced_at/sequence_no 這兩欄，必須個別補防線。回測抓得到大部分，剩下靠 SHADOW 在真實資料上先比再切。
