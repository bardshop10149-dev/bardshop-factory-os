# 包裝專區 P0：唯讀待排池（技術規格）

規格書 · 2026-09-27 · 分支 `feat/packaging-schedule` · 依據 `包裝排程計畫/需求決策紀錄.md` D1~D42

> 這份是 **P0 實作規格**（D42：唯讀待排池＋工時估算＋訂單詳情＋示意圖縮放）。
> P0 **不建表、不寫任何資料、不呼叫 ARGO／塔台**，只讀 Supabase 既有鏡像。
> 需求以決策紀錄為唯一權威；本文件的「查證結果」是 2026-09-27 以唯讀查詢（每次 limit ≤ 5 或只取筆數）實測。
> **第 1~2 輪驗證後的規則修正集中在 §十一**；§三、§七、§九 與 §十一 衝突時，以 §十一（＝目前程式實作）為準。

---

## 一、範圍與不做的事

| 做（P0） | 不做（P1 以後） |
| --- | --- |
| 首頁「包裝專區」卡（order-17）＋ `/packaging` 專區頁 | 拖曳排程、日期欄、拆卡操作（P1） |
| `/packaging/pool` 唯讀待排池：9 個區塊、卡片、區塊合計 | 完成勾選框、任何寫入（P1） |
| 工時估算（含來源說明） | 每日產能、版本、Undo（P1） |
| 點 SO 開訂單詳情、逐行「示意圖」→ 可縮放檢視器 | AI 排程、規則區（P2） |
| 權限鍵 `packaging`／`packaging_admin`；舊選單改名 | ARGO 入庫日／繳庫量／MPO→PO 唯讀查詢（D40，P3） |

---

## 二、查證過的資料表與欄位（2026-09-27 唯讀實測）

> PostgREST 單次回傳上限**實測為 1000 列**（`po_line_tracking` 不帶 range 查詢只回 1000，Content-Range `0-999/3450`）。所有列表查詢都必須分頁。

### 2.1 `erp_so_lines`（SO 品項行；**沒有獨立 SO 表頭表**，表頭欄位攤在每一行）

8,541 列。anon 也讀得到（`SoOrderModal` 直接用瀏覽器 client 查，實測 anon count=8541）。

| 欄位 | 型別／格式（實測值） | 用途 |
| --- | --- | --- |
| `project_id` | text，`SO260924020`／`SOB260916502`／`RO…` | SO 單號（卡片主鍵之一） |
| `line_no` | **text**（`"1"`、`"2"`） | SO 項次＝ARGO LINE_NO（卡片單位 D6） |
| `mbp_part` | text | 品號；= `item_routes.item_code` |
| `description` | text | 品名規格（ARGO REMARK） |
| `packing` | text，可 null；1,600 列是佔位 `"."` | 包裝方式（附加工時解析來源） |
| `remark2` | text | 訂單備註（商品/出貨備註；`remark` 與它同源，勿重複顯示） |
| `customer_remark` | text | 表頭備註（例 `《打樣單》預估大貨1000張`） |
| `duedate` | **text `'YYYY/MM/DD'`**（`2026/10/13`） | ERP 品項行交期（D9） |
| `order_qty_oru` | number | **SO 行數量**（`order_qty` 實測恆為 0，不可用） |
| `unit_of_measure_oru` | text | 單位 |
| `partner_name` | text | 客戶名稱（表頭） |
| `hold_status` | text：OPEN／UNSIGNED | 表頭狀態；同步只抓這兩種，**結案 SO 會被全量對帳刪除** |
| `tpn_part_no` | text，可 null | 前置單號 RO（RO→SO 橋接用） |
| `pdl_seq` | 全表 0 列有值 | **不可用** |

品號前綴分布（實測）：P 4,642、S 2,003、C 1,062、A 513、W 151、其他 170。
- `S*`＝服務/費用（`SSE*` 運費 1,288 列、`SSC*` 各種費用 699 列，其中 `SSCDFE`＝**打樣費** 195 列、`SSCDFG-` 設計費、`SSCUFA-` 急件費、`SSCDFD` 排版費、`SSCBFB` 包邊費、`SSCOUTB` 加工費；`SAFA-` 附加費、`SPR*` 加購/加印）。
- `A*`＝附加費/折扣（`ADCMBA` 折扣、`ASCDFK` 燙金費、`ACLOUTPF` 開版費）。
- 非 S/A 前綴仍有少數費用品名：`版費` 2 列、`運費` 1、`設計費` 1。

### 2.2 `erp_pj_sync`（採購行 `doc_type='採購單號'`，9,561 列）

| 欄位 | 型別／格式 | 備註 |
| --- | --- | --- |
| `doc_no`／`sub_no` | text（`POC2026092101`／`"10"`） | 採購單號＋行號；與 `po_line_tracking` 自然鍵 |
| `item_code` | text | 品號（常平 POC 可能是暫代碼如 `C1-1`） |
| `qty` | number | 採購量（`ORDER_QTY_ORU`）；39 列為 0＝取消行 |
| `status` | text：OPEN 3,836／CLOSE 5,378／**VOID 344**／UNSIGNED 3 | **表頭** HOLD_STATUS。VOID 在這裡，**不在 extra**（extra 沒有 VOID 鍵，實測 0 列） |
| `start_date` | text `'YYYY/MM/DD'` | 開單日 |
| `end_date` | text `'YYYY/MM/DD'` | **已往前推 2 工作日**的追蹤交期（`shiftDueDateBackTwoWorkdays`，只跳六日＋常平例假；太趕或推完早於今天則不推） |
| `customer_vendor` | text | 廠商代碼；常平＝`C01510` |
| `extra->>RECEIVED_QTY` | 數字字串 | 已入庫量（ARGO ACTUAL_QTY_ORU） |
| `extra->>REJECT_QTY` | 數字 | 驗退量 |
| `extra->>CLOSE_FLAG` | `'Y'`／null | 單身結案；3,667 列為 Y（入庫後幾乎都會 Y，**不能當包裝完成**） |
| `extra->>SO_PROJECT_ID` | text／null | 來源 SO（POC 有值；委外 PO 實測多為 null） |
| `extra->>MBP_LOT_NO` | text／null | 批號＝來源 SO（委外 PO 靠它） |
| `extra->>TPN_PART_NO` | text | **POC：＝SO 項次**（實測 1,609/1,609 POC 行有值，例 POC2026092402-3 → `"1"` ＝ SO260923012 line 1 同品號同量；來源 `auto-doc-creation` 寫 `TPN_PART_NO: seq`） |
| `extra->>SO_LINE_NO` | text | **陷阱**：實為 ARGO `PDL_SEQ_SO` 內部流水號（例 `224432`），**不是 SO 項次，不可用** |
| `extra->>PACKING` | text | 採購行包裝方式（常平 POC 自 SO 帶入） |

C01510 行：POC 1,609 行（全部 C01510）；PO2… 開給常平的手動單有些 `MBP_LOT_NO` 為 null（備料/庫存，無 SO，不進池）。
**沒有 `APL_APJ_APPLY_ID`** → Supabase 內無法由 MPO 找到轉出的 PO（見 §3.3 限制）。

### 2.3 `po_line_tracking`（採購專區覆蓋層，3,450 列）

欄位：`doc_no, sub_no, sent_at, shipped_at (timestamptz), ship_method (順豐/空運/海特快/一般海運/null), expected_ship_date (date), note (text), updated_by, updated_at`。
- 常平黃底匯入時 `updated_by='常平出貨同步'`，`note` 多一行 `【常平出貨】9/12 出A-B款各出3个 顺丰SF…/观光街`（`CP_SHIP_NOTE_TAG`）。
- 卡片只取 `【常平出貨】` 開頭的行並去前綴（比照 `/api/purchasing/po-public` 的擷取法），**採購手打備註不外流**。

### 2.4 `changping_ship_marks`（4,452 列，service_role 專用）

欄位：`mark_key, sheet, row_no, detail_id, po_no, pr_no, so_no(原文), vendor, item_code, item_name, qty, order_date, hope_date, transport(原文，如「货代空运」), expected_ship, ship_date_text, ship_date(date|null), fill_color, still_marked, first_seen_at, last_seen_at, matched_lines(jsonb [{doc_no,sub_no}]), match_status(matched/multi_line/no_line), applied_at, apply_note`。
- 8/1 後有出貨日的：matched 308、**multi_line 312**。multi_line 例：`POC2026091701` 品號 `PACRTSPQ-8-2` 兩筆標記（qty 110、qty 2）都對到 sub 26、27 → 兩行都亮燈。
- **P0 只在伺服器端用它推導旗標**，不把本表任何欄位原樣回傳（本表權限只限 Snow，見 `lib/changpingShipOwner.ts`）。

### 2.5 `daily_order_sheets`（105 張，一日一列；最新 2026-09-24）

欄位：`sheet_date, rows(jsonb 陣列), row_count, updated_at, …`。`rows[]` 實測鍵（節錄）：
`order_number, line_no_input, match_line_no, doc_type, factory(T/C/O), item_code, item_name, packing, quantity(文字), delivery_date('YYYY/M/D' 不補零), mo_number, po_number, po_sub_no, pr_number, pr_sub_no, is_sample(=前單號 RO，不能用), sketch_urls(string[]), sketch_url(舊)`。

- `doc_type` 實測值（近 10 張 607 列）：`急件單`、`一般大貨/散單`、`壓克力集單`、**`打樣單`（22 列，全為 factory T）**、`急件/常平`、`委外常平廠`、`急件/委外`、`委外生產`。
- **委外列也常有 `po_number/po_sub_no`**（例 SO260916018 → PO260921005，同列 `pr_number=MPO2026091701`）：出單表是目前唯一同時帶 MPO 與 PO 的地方。
- 示意圖覆蓋：T 308/374、C 114/148、O 56/85；URL 全為圖片（593/593，無 PDF），格式 `…/storage/v1/object/public/order-sketch-images/{SO}_{項次}_{時戳}.png`。
- **jsonb 包含查詢可用**：`rows=cs.[{"order_number":"SO260922010"}]` 實測 0.5 秒回傳命中的出單表。

### 2.6 塔台鏡像

| 表 | 列數 | 關鍵欄位（實測） |
| --- | --- | --- |
| `sara_lot_progress` | 541（MOT 214／MOS 7／POC 187／MPO 133） | `lot_id, mo_nbr, doc_nbr(全為 SO/SOB), so_line_no(僅 MOT/MOS), product_name, lot_nbr(**＝SO 項次**), qty, due('YYYY-MM-DD HH:mm' 台北文字), health_state, progress_percentage, synced_at` |
| `sara_wip_schedule` | 1,217 | `jid, lot_id, mo_nbr, doc_nbr, so_line_no, product_name, lot_nbr, workcenter_name, job_name, job_sequence(int), qty(應做), wip_qty(累計已報，只有 21 列非 null), system_status(null=未開始/running/pause/finished), plan_*(台北文字), synced_at` |
| `sara_wip_records` | 44,890（永不刪除） | `work_order(唯一), mo_nbr, product_name, lot_nbr, doc_nbr(自動同步一律 null), workcenter_name, job_name, job_sequence, status(running/pause/finished), wip_qty, real_end_time(timestamptz 但存台北鐘面值), source_type(sara/auto_sara), imported_at` |

- 塔台批 ↔ SO 行：**`(doc_nbr, lot_nbr)` ＝ (SO, SO 項次)**。實測 `POC2026092402-3` lot_nbr `"1"` ＝ SO260923012 line 1；`MOT26092201007` lot_nbr `"7"` ＝ so_line_no `"7"`；`MPO2026090801-2` doc_nbr SO260907013 lot_nbr `"1"`。來源：`autoProcessGen` 以 `lot_number: p.line_seq`（出單表 match_line_no）產生工序。
- `mo_nbr` 規則：常平＝`{採購單號}-{採購行}`（舊單可能無 `-n`）；委外＝`{MPO}-{請購行}`；自製＝製令號。塔台**沒有** PO2 前綴的批（實測 0 列）。
- 同一 `schedule.wip_qty`（累計）比 `records.wip_qty`（依 work_order 去重，只留一筆）可靠：`MOT26072702203` UV 印刷 schedule wip 2,760，records 只剩 204。
- 轉運站 records 4,257 列，其中 `source_type='auto_sara'`（username「系統」）958 列，為系統自動結工，**不當到台訊號**。人工報工例：`POC2026090801-13 委外/7天回 finished`。

### 2.7 工時三表

| 表 | 列數 | 欄位 |
| --- | --- | --- |
| `item_routes` | 4,715 | `id, item_code, item_name, route_id` |
| `route_operations` | 631 | `id, route_id, sequence, op_name, qty_mode(個數/盤數)` |
| `operation_times` | 包裝站 570 | `id, op_name, station, std_time_min(分/件/1人，小數 2 位)` |

- 包裝站非「常規包裝」工序只有：`QC檢驗` 0.1、`標籤貼紙` 0.02、`QC檢驗/入庫` 1。
- 附加變體已存在於工序名（444 個 `常規包裝+…/…`，例 `常規包裝+貼紙/一般壓克力` 0.65），但途程只有 `成品素材UV印刷` 用到。
- 委外 C 品號途程＝`委外/11天回`（轉運站 → `QC檢驗/入庫`），**沒有非 QC 包裝工序**；常平品號途程＝`常平一般壓克力製程`（→ `常規包裝/一般壓克力片`）。所以委外與「常平未包裝」都必須靠品名關鍵字找品類（§5）。

### 2.8 `erp_mo_lines`（48,972 列）

欄位：`id, project_id(製令號), begin_date, end_date, hold_status, mo_begin_date, line_no, mbp_part, mbp_lot_no, order_qty, source_order(來源 SO), synced_at`。
- **沒有繳庫量欄位**（同步只抓 `ORDER_QTY`；`lib/argoQuery.ts` 註解亦明言）。`hold_status` 分布 OPEN 4,842／CLOSE 11／VOID 35／null 44,084，**不是完工旗標**。
- 結論：D25/D26「MO 繳庫即消失」在 P0 **無資料可判**（需 ARGO 即時查，屬 D40/P3）。P0 以塔台包裝工序完工代替（§3.6）。

### 2.9 權限

`members.permissions` 為 text[]（例 `["dashboard","production_admin",…]`）；`guardPermission(p)` 只收單一鍵、admin 自動通過；`/api/auth/me` 回 `{is_admin, permissions}`。`proxy.ts` 對 `/packaging/*` 只檢查 token 格式；`/admin/*` 需要 `production_admin`。

---

## 三、對應鍵與區塊判定

### 3.1 對應鍵總表

```
SO 品項行 (erp_so_lines.project_id, line_no)                    ← 卡片單位 D6
  ├─ 塔台批    sara_*.(doc_nbr, lot_nbr)                         （MOT/MOS 另有 so_line_no 可交叉驗證）
  ├─ 出單表列  rows[].(order_number, match_line_no || line_no_input)
  │            └→ mo_number / po_number+po_sub_no / pr_number+pr_sub_no / doc_type / sketch_urls
  ├─ 採購行    erp_pj_sync.(doc_no, sub_no)   —— 解析順序見 3.2
  │            └→ po_line_tracking.(doc_no, sub_no)
  │            └→ changping_ship_marks.matched_lines[] 含 {doc_no, sub_no}
  └─ 製令      erp_mo_lines.source_order = SO（P0 僅顯示用，不判定）；
               moToSoLine(mo) 可由 MOT/MOS 號推發單當下項次（lib/moLineMatch.ts，99.6%）
```

### 3.2 採購行 → SO 行解析（`lib/packaging/resolveSoLine.ts`）

依序嘗試，命中即停；每一步都要求 SO 存在於 `erp_so_lines`（不存在＝SO 已結案 → 整行不進池）：

1. **出單表鍵**：`rows[].po_number/po_sub_no` = 此採購行 → 取該列 `(order_number, match_line_no)`。多張出單表出現同一 PO 行時取 `sheet_date` 最新者。
2. **POC 項次**：`doc_no LIKE 'POC%'` → `(SO_PROJECT_ID, TPN_PART_NO)`；且該 SO 行 `mbp_part = item_code`，不符則視為行位移，落到第 3 步。
3. **SO＋品號（＋數量）**：SO = `SO_PROJECT_ID ?? MBP_LOT_NO`（`MBP_LOT_NO` 須符合 `/^(SO|SOB|RO)[A-Z0-9-]{4,}$/`；RO 開頭再經 `erp_so_lines.tpn_part_no = RO` 換成 SO）。在該 SO 找 `mbp_part = item_code` 的行：
   - 只有 1 行 → 直接配（**委外拆批**：多張 PO 行對同一 SO 行，數量加總）。
   - 多行 → 先做**數量一對一**（`qty = order_qty_oru`）；剩下的若只剩 1 行就配它；否則配給「未配量最多」的行並加旗標 `so_line_ambiguous`。
4. 都失敗但 SO 存在 → 仍出卡，`soLine=null`、`cardId=${SO}-?${doc_no}-${sub_no}`，旗標 `so_line_unresolved`。

### 3.3 常平／委外判定（D41）

- `customer_vendor = 'C01510'` → **常平**（含 POC 與手動請購→採購的 PO2）；其餘 → **委外**。
- 中轉單（第三方→常平→台灣）：若 ARGO 採購廠商是 C01510 則自然歸常平；若採購開給第三方廠商，P0 **無法辨識**（黃底同步只掃「NNN年生產訂單」分頁，不含「中轉訂單」分頁）→ 列入已知限制，待確認中轉單在 ARGO 的開單方式。
- **MPO→PO 限制**：`erp_pj_sync.extra` 沒有 `APL_APJ_APPLY_ID`。P0 不直接連 MPO↔PO，而是兩邊各自對到 SO 行再合併：PO 行走 3.2；MPO 塔台批走 `(doc_nbr, lot_nbr)`；出單表 `pr_number-pr_sub_no` 可補 MPO 號顯示。因此同一 SO 行若有多張委外 PO 行，塔台「轉運站完工」訊號只能套在 **SO 行層級**（整行未入庫量一起進 1b），無法分辨是哪一批到台。

### 3.4 每一採購行的「數量切片」

對每個已解析的採購行 L（排除 `status='VOID'`、`qty ≤ 0`）：

```
rcv   = Number(extra.RECEIVED_QTY) || 0
rej   = Number(extra.REJECT_QTY)   || 0
rem   = max(0, qty − rcv − rej)                      // 尚未到的量
closedShort = extra.CLOSE_FLAG === 'Y' && rem > 0    // 單身結案但沒到齊 → 剩餘量不再追
pkgDone = 塔台包裝已報量（§3.6）                       // 只有常平 POC 有
readyQty = max(0, rcv − pkgDone)
```

切出最多兩片：**已入庫片**（readyQty > 0）與**未到片**（rem > 0 且非 closedShort）。兩片落在不同區塊時，同一 SO 行出兩張卡（D7 拆卡：同單同品項、數量分開、合計等於原量），卡片標 `split {index,total}`，旗標 `partial_received`。
同一 SO 行的多個採購行，**同區塊的切片合併成一張卡**（數量相加、來源單號並列）。

### 3.5 區塊判定（常平與委外）

「到台訊號」`transitDone(SO行)`＝該 SO 行對應的塔台 POC/MPO 批，轉運站 `job_name LIKE '委外/%天回'` 為 finished（`schedule.system_status='finished'` 或 `records.status='finished' AND source_type='sara'`；`auto_sara` 不算）。

| 區塊 | 條件（對「切片」判定） | 可包量／顯示 |
| --- | --- | --- |
| **2 常平已入庫可包** | 常平、已入庫片 | 可包＝readyQty；入庫＝品檢完（D17） |
| **5b 委外已入庫可包** | 委外、已入庫片 | 可包＝rcv（MPO 塔台無非 QC 包裝工序，無法扣已包量）；一律列出、預設計工時（D16） |
| **1b 品檢中** | 常平或委外、未到片、`transitDone` 為真（**不論有無 shipped_at**，D18/D20） | 預計量＝rem；標「已到台待入庫」 |
| **1 常平已寄出運送中** | 常平、未到片、非 1b、`po_line_tracking.shipped_at` 有值 | 預估可包日＝寄出日（shipped_at 的台北日期）＋運輸工作天（順豐 3／空運 5／海特快 7／一般海運 13，D13）。`ship_method` 為 null 時從 `ship_date_text`/`transport` 關鍵字補判（顺丰/順豐、空运、海特、海运）；仍無 → `estReadyDate=null`＋旗標 `transit_unknown` |
| **5a 委外已出貨未到** | 委外、未到片、非 1b、shipped_at 有值 | 同上估算（委外多為順豐） |
| **3 常平未寄出且緊張** | 常平、未到片、非 1b、shipped_at 為 null、`rcv = 0`，且 **SO 行交期剩餘台灣工作天 ≤ 5（打樣類 ≤ 3）**，含已逾期 | 不預排、僅提醒（D22）；逾期置頂標紅 |
| **5c 委外出貨待確認** | 委外、未到片、非 1b、shipped_at 為 null、`今天 ≥ erp_pj_sync.end_date` | end_date 同步時已倒推 2 工作日，正常情況即等於「採購交期往前 2 個工作天」（D20）；例外見限制 |

未命中任何區塊的切片（常平未寄且不緊張、委外未寄且未到 end_date）不進池。

**multi_line 誤亮處理（區塊 1/2 驗證重點）**：
以 `(po_no, item_code)` 分組 multi_line 標記，組內候選行＝各標記 `matched_lines` 聯集。用「標記 qty = 採購行 qty」做一對一配對；配不到標記的候選行＝**出貨燈可能誤亮**：卡片仍依 shipped_at 放區塊 1，但加危險旗標 `ship_mark_ambiguous`（「常平同單同品號多行，出貨燈可能誤亮，請向常平確認」）；若它同時符合區塊 3 的緊張條件，再加 `maybe_unshipped_urgent` 並在區塊 3 頂端的提示列計數。
**出貨日未解析**：該行對到的標記 `ship_date IS NULL`（原文如「出HK…」「台湾处理」）→ shipped_at 其實是匯入當下時間，加旗標 `ship_date_unparsed` 並附原文前 30 字，估算可包日不計算。

### 3.6 P0 暫用的「隱藏已完成」規則（**絕不用 ARGO 入庫當完成**，D17/D26）

> **已由 §十二（D43）補充**：下表之外，另以「塔台未結案批」界定待排池範圍（塔台已結案批的卡計入 `excluded.saraClosedOrAbsent`）；委外 MPO 因此不必只等 SO 結案。下表的「包裝站報完工即隱藏」目前仍保留，是否一併取消見 §12.6。

| 對象 | 隱藏條件 |
| --- | --- |
| 全部 | SO 已不在 `erp_so_lines`（ARGO 已結案） |
| 常平 POC | 塔台該批（`mo_nbr = {doc_no}-{sub_no}`，舊單無後綴則 `mo_nbr = doc_no AND product_name = item_code AND lot_nbr = SO項次`）包裝站**非 QC** 工序全部 finished → 整片隱藏；部分報工 → 可包量扣掉已報量（取 schedule.wip_qty，無則 records 同工序 wip_qty 加總） |
| 委外 MPO | 塔台途程只有 `QC檢驗/入庫`，**P0 無完成訊號**，只能等 SO 結案 → 頁尾註明 |
| 自製 MOT/MOS | 包裝站非 QC 工序全部 finished 或批已不在 `sara_lot_progress` → 隱藏（**代替 D25 的 ARGO 繳庫**，P3 改讀繳庫量） |

「SO 行已全數銷貨」在 Supabase 查不到（沒有銷貨明細鏡像），P0 不實作，列入限制。

### 3.7 製令區塊（4 / 4x）與前站推導

母體：`sara_lot_progress` 中 `mo_nbr` 以 `MOT`/`MOS` 開頭的批。對每批：

```
key   = (mo_nbr, product_name, lot_nbr)          // records 沒有 lot_id，必須三段自然鍵
ops   = schedule(key) ∪ records(key)，以 job_sequence 為格：
          - 先鋪 schedule（含未開工），status = system_status ?? 'pending'
          - 再以 records 覆蓋：任一筆 finished 即 finished；running 優先於 pause
          - 報工量 X：schedule.wip_qty 有值用它（累計），否則 records 同格 wip_qty 加總
          - 應做量 Y：schedule.qty，無則 lot.qty
pkgOps = ops 中 workcenter_name='包裝站' 且 job_name NOT IN ('QC檢驗/入庫','QC檢驗')
若 pkgOps 為空                 → 不是包裝卡（略過）
若 pkgOps 全部 finished         → 隱藏（3.6）
pkgSeq = min(pkgOps.job_sequence)
preOps = ops 中 job_sequence < pkgSeq 且 workcenter_name ≠ '包裝站'，取 job_sequence 最大的那一組
```

- **preOps 為空 → 區塊 4x「需確認：只有包裝站、沒有前站」**（D35，可能是工序錯誤；用現行 schedule ∪ records 計算，不用 8/2 舊快照）。區塊標題列提供「複製清單」（TSV：製令、SO、項次、品號、品名、包裝工序、數量）給 Snow 查。
- preOps 有任一 `running/pause/finished` 或 X > 0 → **區塊 4**；全部 pending → 不進池（P0 只列前站已開工/已完工）。
- 前站狀態：全部 finished → 已完工；有 running → 進行中；否則 pause → 暫停。
- **可包量（D23）**：已完工 → Y（若 X < Y 顯示「已完工（報工 X/Y，紀錄可能不全）」）；進行中/暫停 → min(X, Y)，再扣包裝工序已報量。卡片顯示「前站：雷切站 已報 450 / 應做 450 · 已完工」。
- **平行鏈限制**：DB 沒有 `prime`/`job_dep`。若 preOps 同一 job_sequence 有多道不同 workcenter 的工序，視為平行鏈：狀態取最落後者、可包量取最小值，加旗標 `parallel_pre_station`。若平行鏈序號不同（無法從序號看出），P0 會只看序號最大者 → 已知限制。
- SO 行：`(doc_nbr, lot_nbr)`；若 SO 行 `mbp_part ≠ product_name` 仍出卡，以塔台品名補，旗標 `so_line_mismatch`。
- 製令資訊欄：`mo_nbr`＋前站名稱／狀態；另列 `erp_mo_lines.source_order = SO AND mbp_part = 品號` 的其他製令號（補印 -1/-L1、MOS 後綴），P0 只顯示不判定。

同一 SO 行若同時有 MO 批與採購行（少見），各自成卡、共用 `soLineKey`。

### 3.8 排除規則

1. **非實體行（D12）**：`mbp_part` 以 `S` 或 `A` 開頭，**但** `SSCDFE` 或品名以「打樣費」開頭者保留（D10：打樣費行視為實體少量品）；另外任何品名以 `運費|設計費|急件費|服務費|版費|開版費|刀模費|排版費|加工費|附加費|折扣|會員優惠` 開頭者排除。這些行仍會出現在訂單詳情彈窗。
2. SO 行 `order_qty_oru ≤ 0`。
3. SO 已結案（不在 `erp_so_lines`）。
4. 3.6 的完成隱藏。
API 回傳 `excluded` 各類計數，頁尾顯示。

### 3.9 打樣類（D10/D11）

`sample.isSample = true` 當：
- **訂單層**：出單表任一列 `order_number = SO` 且 `doc_type = '打樣單'`（讀近 120 天出單表，§7），`reason='sheet_doc_type'`；或
- **行層**：該行 `description` 含「打樣」（含「打樣費」行，D11），`reason='line_name'`。

`is_sample` 欄存的是前單號，**不可用**。觀察到 `customer_remark` 有 `《打樣單》` 字樣，可作為出單表查不到時的補充訊號——**決策紀錄未定案，P0 不採用**，列入待問。
已知誤判：品名備註文字提到打樣（例「打樣伏黑款偏綠」的 250 件大貨）會被行層規則抓到 → 卡片顯示 reason 讓人判斷。

### 3.10 危險旗標（`flags[]`）

| code | 條件 |
| --- | --- |
| `overdue` | SO 行交期 < 今天 |
| `due_soon` | 剩餘台灣工作天 ≤ 5（打樣類 ≤ 3） |
| `eta_passed` | 區塊 1/5a 的預估可包日 ≤ 今天仍未入庫（D22 橘燈） |
| `ship_mark_ambiguous` / `maybe_unshipped_urgent` / `ship_date_unparsed` / `transit_unknown` | 3.5 |
| `partial_received` | 同一採購行已入庫片與未到片並存 |
| `so_line_ambiguous` / `so_line_unresolved` / `so_line_mismatch` | 3.2、3.7 |
| `qc_report_mismatch` | 常平批：ARGO 已入庫但塔台 `QC檢驗/入庫` 未 finished（或反之），D18 漏報提示 |
| `parallel_pre_station` / `routing_suspect`（4x） | 3.7 |
| `hours_unknown` | 工時對不到 |
| `calendar_fallback` | 日期超出內建行事曆年份，改用週一~五 |

---

## 四、工作日工具

EIP 既有的只有**常平**工作日（`lib/argoerp/moExportShared.ts` 的 `addWorkingDays/isNonWorkingDay`：六日＋`app_settings.changping_holidays`，無補班），以及 `app/api/argoerp/route.ts` 內部私有的 `shiftDueDateBackTwoWorkdays`（只跳六日）。**沒有台灣行政日曆** → 使用 `lib/packaging/workdays.ts`（2026-09-27 已由平行工作建立，本規格以它為準，不另建 twCalendar.ts）。

- 資料：與 argo-tool `backend/tw_calendar.py` 同源（ruyut/TaiwanCalendar，行政機關辦公日曆，含補班），**寫死成常數**，不在 Vercel 執行期連 CDN。本規格另行唯讀核對：
  - 2026 平日放假：01-01、02-16~02-20、02-27、04-03、04-06、05-01、06-19、**09-25（中秋）**、**09-28（教師節）**、10-09、10-26、12-25；補班日：無。
  - 2027 平日放假：01-01、02-04、02-05、02-08、02-09、02-10、03-01、04-05、04-06、04-30、06-09、09-15、09-28、10-11、10-25、12-24、12-31；補班日：無。
  - 涵蓋 `CALENDAR_COVERAGE` 2026-01-01 ~ 2027-12-31，超出退回週一~五（`isCovered()=false` → 卡片旗標 `calendar_fallback`）。
- 使用的 API（`YYYY-MM-DD` 字串、UTC 日序號計算）：
  ```ts
  isWorkday(ymd): boolean
  addWorkdays(ymd, n): string            // 起日不算；n≠0 時落點必為工作日
  workdaysBetween(from, to): number      // (from, to] 正值；to 在前則 −[to, from)
  isCovered(ymd): boolean
  todayTaipei(): string
  createWorkdayCalendar({ extraHolidays, extraWorkdays })   // P1 疊加包裝部例外日
  ```
- 剩餘工作天＝`workdaysBetween(today, due)`；預估可包日＝`addWorkdays(寄出日, 運輸工作天)`。
- 「交期往前數 N 個工作日內」⇔ `workdaysBetween(today, due) ≤ N`（含逾期為負）。
- 今天：`workdays.ts` 的 `todayTaipei()`（與 `lib/purchasing/types.ts` 同義）；日期文字一律經 `normalizeDateText()`（支援 `YYYY/MM/DD`）。出單表 `delivery_date` 不補零（`2026/10/2`）需另寫寬鬆解析。
- 維護：每年 6 月政府公布次年日曆後補一年（檔頭註解寫明）。包裝部是否週六上班仍待問（延後細節），P0 用行政日曆。

---

## 五、工時估算（分鐘，1 人；`lib/packaging/workTime.ts`）

共同規則：QC 工序（`QC檢驗`、`QC檢驗/入庫`）**一律不計**（D14）；計算數量＝本卡數量（可包量或預計量）；每張卡**最少 10 分鐘**（沿用 `lib/sara/autoProcessGen.ts` 的 `calcEst = max(10, std×qty)`），`minApplied` 標示。

| 來源 | 公式 | 來源說明範例 |
| --- | --- | --- |
| **自製 MOT/MOS** | `item_routes(item_code=mbp_part)` → `route_operations`（包裝站、非 QC）→ Σ `operation_times.std_time_min`；對不到途程時改用塔台該批包裝站非 QC 工序的 `job_name`（= op_name）。再加包裝方式附加工時 | 「途程：常規包裝/鑰匙圈 0.4 + 紙卡 0.2 = 0.6 分/件 × 300」 |
| **常平（預設）** | `0.2 × 數量`（300 個/小時，只做檢驗＋換箱，D27；「每人」為暫定解讀） | 「常平換箱 0.2 分/件 × 460」 |
| **常平「未包裝」** | 【常平出貨】備註含「未包裝」→ 品名關鍵字找品類的 `常規包裝/…` std ＋附加工時；對不到退回 `常規包裝/一般壓克力片` 0.5（D28） | 「常平未包裝→廠內：常規包裝/立牌(單件) 1.0 + 貼紙 0.12」 |
| **委外** | 先試 `item_routes` 包裝站非 QC 工序（委外 C 品號多半沒有）→ 品名關鍵字品類 → 附加工時；都對不到 → `minutes=null`、`hours_unknown` | 「品名『杯墊』→ 常規包裝/杯墊類 0.6」／「工時未知」 |

- 若途程工序名本身已是 `常規包裝+貼紙/…` 這類附加變體，同名附加項不再重複加。
- **品名 → 品類關鍵字表**（由上而下第一個命中；常數放 `lib/packaging/categoryMap.ts`，op_name 取自線上 `operation_times`，實測存在）：

| 關鍵字（品名 `description`） | op_name | std |
| --- | --- | --- |
| 鑰匙圈 且含「串3」/「3個/串」 | 常規包裝/鑰匙圈(串3) | 0.86 |
| 鑰匙圈 且含「串2」/「2個/串」 | 常規包裝/鑰匙圈(串2) | 0.6 |
| 鑰匙圈、吊飾 | 常規包裝/鑰匙圈 | 0.4 |
| 拼板立牌 | 常規包裝/拼板立牌 | 2 |
| 立牌 且含「組合」 | 常規包裝/立牌(組合) | 1.71 |
| 立牌 | 常規包裝/立牌(單件) | 1 |
| 御守 | 常規包裝/壓克力貼合御守 | 1.2 |
| 色紙 | 常規包裝/壓克力色紙 | 1.2 |
| 畫板 | 常規包裝/壓克力畫板(支架) | 1 |
| 晶磚 且含「大」 / 晶磚 | 常規包裝/壓克力晶磚(大) / (小) | 1.2 / 0.86 |
| 磁鐵 | 常規包裝/壓克力磁鐵 | 0.67 |
| 氣囊 | 常規包裝/氣囊手機支架 | 0.6 |
| 金屬手機支架 | 常規包裝/金屬手機支架 | 0.75 |
| 手機支架、手機立架 | 常規包裝/手機支架 | 0.86 |
| 夜燈、燈箱 | 常規包裝/夜燈燈箱類 | 1.33 |
| 滑蓋卡套 | 常規包裝/滑蓋卡套 | 0.75 |
| 證件套 | 常規包裝/證件套 | 0.6 |
| 杯墊 | 常規包裝/杯墊類 | 0.6 |
| 提袋 | 常規包裝/飲料提袋 | 0.86 |
| 帆布袋 | 常規包裝/帆布袋 | 0.75 |
| 拼板貼紙 | 常規包裝/拼板貼紙(單張) | 0.3 |
| 貼紙 | 常規包裝/一般貼紙(單入) | 0.2 |
| 馬克杯 | 常規包裝/馬克杯 | 0.75 |
| 保溫瓶、保溫杯 | 常規包裝/保溫瓶類 | 0.75 |
| 滑鼠墊 | 常規包裝/滑鼠墊 | 1 |
| 造型抱枕 | 常規包裝/造型抱枕 | 1.2 |
| 抱枕 | 常規包裝/抱枕(小) | 1.2 |
| 胸章 | 常規包裝/胸章 | 0.38 |
| 掛軸 | 常規包裝/掛軸 | 2.4 |
| 無框畫 | 常規包裝/無框畫 | 1.2 |
| 圓鏡 | 常規包裝/小圓鏡 | 1 |
| 毛巾 | 常規包裝/毛巾(小)30*30以內 | 0.4 |
| 野餐墊 | 常規包裝/野餐墊 | 0.8 |
| 卡片 | 常規包裝/卡片 | 0.75 |
| T恤、衣、帽T、服飾 | 常規包裝/服飾類 | 0.75 |
| （退回，僅「常平未包裝」） | 常規包裝/一般壓克力片 | 0.5 |

std 以執行期查 `operation_times` 的值為準（上表為 2026-09-27 值），找不到該 op_name 時視同對不到。

- **附加工時關鍵字**（解析 `erp_so_lines.packing`；空值或佔位 `.` 忽略；每種元素每件最多加一次；依工序總表2 右側附加表 E56:K97）：

| 元素 | 關鍵字 | 每件 + 分 |
| --- | --- | --- |
| 貼紙 | `貼紙`（不含前綴「標籤」） | +0.15；品類為 立牌(單件)/立牌(組合) 時 +0.12 |
| 標籤貼紙 | `標籤`、`代印代貼` | +0.02（線上工序「標籤貼紙」） |
| 雷標 | `雷標`、`鐳標`、`雷射標` | +0.2 |
| 紙卡 | `紙卡`、`背卡`、`卡頭`、`空白卡`、`白卡` | +0.12；品類為單件 `鑰匙圈` 時 +0.2 |
| 盲抽／混裝 | `盲抽`、`混裝`、`扭蛋`（排除 `不要混裝`、`不混裝`） | +0.2 |
| 未定義（缺口） | `牛皮`、`飛機盒`、`鋁箔袋`、`氣泡袋`、`夾鏈袋`、`條碼`、`證紙`、D字扣/龍蝦扣/珠鍊/門扣/掛繩（五金組裝）、`放數` | +0，列入 `work.gaps` 顯示「附加工時未定義：牛皮盒」 |

- 常平預設（換箱）不加附加工時（貨已包好）；常平「未包裝」、自製、委外都加。
- 卡片顯示 `work.explain`（一行）；滑過顯示完整拆解。

---

## 六、TypeScript 型別契約（實作者照抄到 `lib/packaging/types.ts`）

> **已由 §十二（D43/D44）更新，以 `lib/packaging/types.ts` 為準**：`PoolBlockId` 新增 `'ns'`（已發單・未上塔台，group `shared`）；
> `POOL_BLOCK_ORDER = ['3', 'ns', '1', '1b', '2', '4', '4x', '5c', '5a', '5b'] as const satisfies readonly PoolBlockId[]`（另有編譯期防呆，漏放區塊會編譯失敗）；
> `CardStatus` 新增 `not_on_sara`；`DangerFlagCode` 新增 `not_on_sara`；`PoolExcluded` 新增 `saraClosedOrAbsent`；`PoolResponse` 新增 `staleUnsynced`，移除 `hiddenStale`。

```ts
// 包裝專區 P0（唯讀待排池）共用型別 —— 資料層（lib/packaging/*、/api/packaging/*）與畫面共用。
// 規格與判定邏輯見 docs/design/2026-09-27-packaging-schedule.md。
// 注意：本檔是跨區可見的形狀，絕不可加入廠商代碼/名稱、付款欄位、changping_ship_marks 原始欄位。

/** 待排池區塊（順序＝畫面順序） */
export type PoolBlockId = '1' | '1b' | '2' | '3' | '4' | '4x' | '5a' | '5b' | '5c'

export const POOL_BLOCK_META: Record<PoolBlockId, { title: string; group: 'changping' | 'inhouse' | 'outsource' | 'shared'; hint: string }> = {
  '1':  { title: '常平 — 已寄出運送中', group: 'changping', hint: '已亮出貨燈、未到台、未入庫；顯示預估可包日' },
  '1b': { title: '品檢中（已到台待入庫）', group: 'shared', hint: '塔台轉運站已完工、ARGO 未入庫（常平＋委外）' },
  '2':  { title: '常平 — 已入庫可包', group: 'changping', hint: '入庫＝品檢完成，可開始包' },
  '3':  { title: '常平 — 未寄出且交期緊張', group: 'changping', hint: '交期 5 個工作天內（打樣類 3 天），不預排、僅提醒' },
  '4':  { title: '製令 — 前站已開工／已完工', group: 'inhouse', hint: '可包量＝前站已完成量' },
  '4x': { title: '需確認 — 只有包裝站、沒有前站', group: 'inhouse', hint: '可能是塔台工序設定錯誤，請確認' },
  '5a': { title: '委外 — 已出貨未到', group: 'outsource', hint: '採購已點出貨、未入庫' },
  '5b': { title: '委外 — 已入庫可包', group: 'outsource', hint: '一律列出，預設計入包裝工時' },
  '5c': { title: '委外 — 出貨待確認', group: 'outsource', hint: '採購交期前 2 個工作天仍未點出貨' },
}

export const POOL_BLOCK_ORDER: PoolBlockId[] = ['3', '1', '1b', '2', '4', '4x', '5c', '5a', '5b']

export type SourceKind = 'changping' | 'outsource' | 'inhouse'

/** 卡片來源單據（一張卡可有多個，例：委外拆批的多個採購行） */
export interface SourceDoc {
  kind: SourceKind
  /** 單型標籤：POC / PO（常平手動或委外採購）/ MPO / MOT / MOS */
  docType: 'POC' | 'PO' | 'MPO' | 'MOT' | 'MOS'
  docNo: string
  /** 採購行號；製令為 null */
  lineNo: string | null
  /** 塔台 mo_nbr（POC…-n / MPO…-n / MOT…）；對不到為 null */
  saraMo: string | null
  /** 本來源貢獻到這張卡的數量 */
  qty: number
}

export type CardStatus =
  | 'in_transit'              // 1 / 5a
  | 'qc_pending'              // 1b
  | 'ready'                   // 2 / 5b
  | 'not_shipped_urgent'      // 3
  | 'pre_station_running'     // 4
  | 'pre_station_paused'      // 4
  | 'pre_station_finished'    // 4
  | 'no_pre_station'          // 4x
  | 'ship_unconfirmed'        // 5c

export type DangerFlagCode =
  | 'overdue' | 'due_soon' | 'eta_passed'
  | 'ship_mark_ambiguous' | 'maybe_unshipped_urgent' | 'ship_date_unparsed' | 'transit_unknown'
  | 'partial_received'
  | 'so_line_ambiguous' | 'so_line_unresolved' | 'so_line_mismatch'
  | 'qc_report_mismatch'
  | 'parallel_pre_station' | 'routing_suspect'
  | 'hours_unknown' | 'calendar_fallback'

export interface DangerFlag {
  code: DangerFlagCode
  /** 繁中說明（直接顯示） */
  label: string
  /** 'danger' 紅、'warn' 橘、'info' 灰 */
  level: 'danger' | 'warn' | 'info'
}

export type AddonKey = 'sticker' | 'label' | 'laser_label' | 'paper_card' | 'blind_mix'

export interface WorkEstimate {
  /** 估計工時（分鐘，1 人）；null＝工時未知 */
  minutes: number | null
  /** 每件分鐘（含附加）；null＝未知 */
  perUnit: number | null
  /** 計算用數量 */
  qtyBasis: number
  source: 'changping_rebox' | 'changping_unpacked' | 'route' | 'sara_job' | 'category_keyword' | 'unknown'
  /** 一行來源說明，例「常平換箱 0.2 分/件」「途程：常規包裝/鑰匙圈 0.4 + 紙卡 0.2」 */
  explain: string
  /** 基本工序（op_name 與每件分鐘） */
  baseOps: { opName: string; perUnit: number }[]
  addons: { key: AddonKey; label: string; perUnit: number }[]
  /** 包裝方式中偵測到、但沒有定義附加工時的元素（牛皮盒、鋁箔袋…） */
  gaps: string[]
  /** 是否套用「每卡最少 10 分鐘」 */
  minApplied: boolean
}

/** 製令前站資訊（區塊 4 / 4x） */
export interface PreStationInfo {
  moNbr: string
  lotNbr: string | null
  /** 前站工作站名稱；4x 為 null */
  station: string | null
  jobName: string | null
  status: 'finished' | 'running' | 'pause' | 'pending' | null
  /** 已報 X */
  reportedQty: number | null
  /** 應做 Y */
  requiredQty: number | null
  parallel: boolean
  /** 包裝站（非 QC）工序現況 */
  packagingJobs: { jobName: string; status: 'finished' | 'running' | 'pause' | 'pending'; reportedQty: number | null }[]
  /** 同 SO 行的其他製令號（erp_mo_lines，僅顯示） */
  otherMos: string[]
}

export interface ShipInfo {
  /** 寄出／出貨日（台北 YYYY-MM-DD） */
  shippedAt: string | null
  method: '順豐' | '空運' | '海特快' | '一般海運' | null
  transitWorkdays: number | null
}

export interface PackagingCard {
  /** `${so}-${line}`；同一 SO 行拆成多卡時加 `#${block}` */
  cardId: string
  /** `${so}-${line}`（D6 卡片單位；拆卡共用） */
  soLineKey: string
  block: PoolBlockId
  status: CardStatus
  statusLabel: string
  so: string
  soLine: string | null
  customer: string | null
  itemCode: string | null
  itemName: string | null
  packing: string | null
  unit: string | null
  /** SO 行總量（order_qty_oru） */
  qtyTotal: number
  /** 本卡數量（可包量或預計量） */
  qtyCard: number
  /** 可包量：已入庫/前站已完成的部分；運送中/未寄出為 0 */
  qtyReady: number
  split: { index: number; total: number } | null
  /** ERP 品項行交期 YYYY-MM-DD */
  dueDate: string | null
  /** 剩餘台灣工作天（負＝已逾期幾個工作天） */
  workdaysLeft: number | null
  /** 預估可包日（區塊 1 / 1b / 5a / 4 前站進行中）；未知 null */
  estReadyDate: string | null
  work: WorkEstimate
  sourceKind: SourceKind
  sources: SourceDoc[]
  ship: ShipInfo | null
  /** 已入庫量（採購來源才有） */
  receivedQty: number | null
  /** 常平出貨備註：只取 po_line_tracking.note 的【常平出貨】行（去前綴） */
  cpShipNote: string | null
  /** 訂單備註（erp_so_lines.remark2） */
  orderRemark: string | null
  preStation: PreStationInfo | null
  sample: { isSample: boolean; reason: 'sheet_doc_type' | 'line_name' | null }
  flags: DangerFlag[]
  /** 出單表是否有這一行的示意圖（詳情彈窗再呼叫 sketches API 取網址） */
  hasSketch: boolean
}

export interface PoolBlock {
  id: PoolBlockId
  title: string
  hint: string
  cards: PackagingCard[]
  cardCount: number
  /** 已知工時合計（分鐘） */
  totalMinutes: number
  /** 工時未知的卡數 */
  unknownMinutesCards: number
  overdueCount: number
  sampleCount: number
}

export interface PoolFreshness {
  /** 各來源最後同步時間（ISO）；取不到為 null */
  erpSo: string | null
  erpPo: string | null
  saraSchedule: string | null
  saraRecords: string | null
  /** 常平黃底同步（po_line_tracking updated_by='常平出貨同步' 的最新 updated_at） */
  changping: string | null
  orderSheet: string | null
}

export type PoolResponse =
  | {
      success: true
      generatedAt: string
      /** 台北今天 YYYY-MM-DD */
      today: string
      blocks: PoolBlock[]
      freshness: PoolFreshness
      excluded: { nonPhysical: number; closedSo: number; packagedDone: number; notInPool: number }
      calendar: { source: 'static' | 'fallback'; coveredYears: number[] }
      /** 頁尾註腳（P0 暫用規則與已知限制） */
      notes: string[]
      /** 是否來自伺服器快取 */
      cached: boolean
    }
  | { success: false; error: string }

export interface SketchImage {
  /** 可直接顯示的網址（由 API 決定；P0 為 public URL，之後改短期簽名網址） */
  url: string
  kind: 'image' | 'pdf'
  fileName: string
  /** 簽名網址到期時間（ISO）；public 為 null */
  expiresAt: string | null
  /** 來自哪一天的出單表 */
  sheetDate: string
}

export interface SketchLine {
  lineNo: string | null
  itemCode: string | null
  itemName: string | null
  images: SketchImage[]
}

export type SketchResponse =
  | { success: true; so: string; lines: SketchLine[] }
  | { success: false; error: string }
```

---

## 七、API 與效能

### 7.1 `GET /api/packaging/pool`（`app/api/packaging/pool/route.ts`）

- `export const dynamic = 'force-dynamic'`、`export const maxDuration = 60`；守門 `guardPackaging('read')`（§8，`packaging` 或 `packaging_admin`，admin 通過）。
- 參數：`?fresh=1` 略過快取。回傳 `PoolResponse`，`Cache-Control: no-store`。
- 組裝在 `lib/packaging/pool.ts` 的 `buildPackagingPool(supabase)`；route 只做守門、快取、錯誤包裝（`formatSupabaseAdminError`）。

**讀取量估計（一次冷啟動）**

| 步驟 | 查詢 | 估計列數／頁 |
| --- | --- | --- |
| 並行① | `erp_pj_sync` 採購行：`doc_type=採購單號, status≠VOID, qty>0, start_date ≥ 今天−180 天, or=(MBP_LOT_NO like SO*/SOB*/RO*, SO_PROJECT_ID not null)`，只 select 需要的 extra 鍵（比照 `PO_SELECT`） | 實測 3,731 列 → 4 頁 |
| 並行① | `po_line_tracking` 全表 | 3,450 → 4 頁 |
| 並行① | `changping_ship_marks`：`still_marked=true, last_seen_at ≥ 今天−180 天, or=(match_status.eq.multi_line, ship_date.is.null)`，只取 po_no/item_code/qty/ship_date/ship_date_text/matched_lines | 約 600 → 1 頁 |
| 並行① | `sara_lot_progress` 全表 | 541 → 1 頁 |
| 並行① | `sara_wip_schedule` 全表 | 1,217 → 2 頁 |
| 並行① | `operation_times station=包裝站`、`route_operations` 全表 | 570、631 → 各 1 頁 |
| 並行① | 出單表索引（7.3） | 約 85 張 |
| 並行① | 新鮮度：各表 `order=…desc&limit=1`（不可用 max()，PostgREST 已停用聚合） | 6 次 |
| ② | `erp_so_lines` `in(project_id)`：SO 集合（約 500~800）每 100 個一塊、每塊分頁 | 約 2,000~3,000 列 |
| ② | RO→SO：`erp_so_lines in(tpn_part_no)` | 少量 |
| ② | `sara_wip_records in(mo_nbr)`：批的 mo_nbr ∪ 已入庫 POC 行的 `{doc_no}-{sub_no}`，每 100 個一塊、分頁 | 約 3,000 列 |
| ② | `item_routes in(item_code)` 每 200 個一塊 | 約 800 列 |
| ② | `erp_mo_lines in(source_order)` 每 100 個一塊（只取 project_id/source_order/mbp_part） | 約 1,500 列 |

合計約 2 萬列、25~35 個請求，分兩波並行；預估冷啟動 3~6 秒（出單表占最大宗）。
**分頁一律**：第一頁帶 `count: 'exact'`，其餘頁 `Promise.all` 並行，每頁都要 `.order()` 固定排序（沿用 `lib/purchasing/data.ts` 的 `fetchAllOpenPoRows` 寫法，抽成 `lib/packaging/fetchAll.ts` 的 `fetchAllPages(buildQuery)`）。

**快取**：模組層記憶體快取 `{ at, data }`，TTL 120 秒（塔台 30 分、ERP 5 分~1 小時才同步，2 分鐘內重算沒有意義）；同一實例同時多個請求共用同一個進行中的 Promise（避免雪崩）。前端每 5 分鐘輪詢一次＋手動「重新整理」（帶 `fresh=1`）。**不用 realtime**（瀏覽器是 anon）。

**180 天窗口**：開單超過 180 天、SO 仍未結案的採購行不會進池 → 註腳揭露（argo-tool「委外到貨待包裝」同樣用 180 天）。

### 7.2 `GET /api/packaging/sketches?so=SO…`（`app/api/packaging/sketches/route.ts`）

- 守門同上；`so` 驗證 `/^(SO|SOB|RO)[A-Z0-9-]{4,}$/i`。
- 查詢：`daily_order_sheets?select=sheet_date,rows&rows=cs.[{"order_number":"<SO>"}]&order=sheet_date.desc`（實測 0.5 秒），伺服器端篩出該 SO 的列，依 `match_line_no || line_no_input` 分組，`sketch_urls`（舊資料退用 `sketch_url`）去重；同一行多張出單表都有圖時合併、較新的在前。
- 回傳 `SketchResponse`；每個網址都經 `lib/packaging/sketchUrl.ts` 的 `resolveSketchUrl(raw)`：
  ```ts
  // P0：public bucket，原樣回傳 { url: raw, expiresAt: null }
  // 之後 bucket 改 private（另一個 session 處理，D39）：在這裡解析出 object path，
  // 用 service role 的 storage.from('order-sketch-images').createSignedUrl(path, 600) 換短期網址。
  // 前端永遠只用 API 回傳的 url，不自行拼接 —— 這是唯一要改的地方。
  export async function resolveSketchUrl(raw: string, supabase): Promise<{ url: string; expiresAt: string | null }>
  ```
- 無圖的行也回傳（`images: []`），讓彈窗顯示「無示意圖」。

### 7.3 出單表索引（`lib/packaging/orderSheetIndex.ts`）

一次抓近 120 天出單表 `select=sheet_date,updated_at,rows`（每頁 10 張、並行），建三個 Map：
`SO|項次 → {doc_type, mo_number, po_number/po_sub_no, pr_number/pr_sub_no, hasSketch}`、`採購單號|行 → SO|項次`、`SO → isSampleSheet`。
模組快取：先查 `select=sheet_date,updated_at`（105 列很小），只重抓 `updated_at` 變動或新增的張數；冷啟動才全抓（約 6MB）。

---

## 八、檔案清單與分工（三組互不改同一檔）

### (A) 資料層
| 檔案 | 內容 |
| --- | --- |
| `lib/packaging/types.ts` | §6 原樣（A 建立；B、C 只 import） |
| `lib/packaging/workdays.ts` | §4（已存在，沿用） |
| `lib/packaging/categoryMap.ts` | §5 品類關鍵字表、附加工時關鍵字、非實體行規則、運輸天數常數 |
| `lib/packaging/workTime.ts` | §5 工時計算（純函式，可單元測試） |
| `lib/packaging/fetchAll.ts` | 分頁與分塊 `in()` 查詢工具 |
| `lib/packaging/orderSheetIndex.ts` | §7.3 |
| `lib/packaging/resolveSoLine.ts` | §3.2 |
| `lib/packaging/saraRoute.ts` | §3.7 schedule ∪ records 聯集、前站推導、包裝已報量 |
| `lib/packaging/pool.ts` | `buildPackagingPool()`：切片、區塊判定、旗標、排序、合計、notes |
| `lib/packaging/sketchUrl.ts` | §7.2 擴充點 |
| `lib/packaging/guard.ts` | `guardPackaging(level: 'read' \| 'admin')`：`guardAuth()` 後 admin 或權限含 `packaging`/`packaging_admin`（read）、`packaging_admin`（admin）；回傳型別同 `guardPermission` |
| `app/api/packaging/pool/route.ts` | §7.1 |
| `app/api/packaging/sketches/route.ts` | §7.2 |

卡片內排序（pool.ts 產出即排好）：逾期 → 打樣類 → 剩餘工作天升冪 → 預估可包日升冪 → SO 號。

### (B) 畫面
| 檔案 | 內容 |
| --- | --- |
| `app/packaging/page.tsx` | 專區頁，比照 `app/engineering/page.tsx`：`/api/auth/me` 自查（admin 或 `packaging`/`packaging_admin`）；子功能格：**待排池**（可用）、排程工作台／每日產能／版本歷史（P1，灰掉＋「即將推出」）、AI 規則（P2，灰掉）、**包裝站塔台看板**（連 `/admin/production/packaging`，註明「需生產管理權限」）。主題色琥珀（`config/productionSections.ts` packaging 同色系） |
| `app/packaging/pool/page.tsx` | 待排池頁：頂部摘要（各區塊卡數＋工時合計、資料更新時間各來源、重新整理）、依 `POOL_BLOCK_ORDER` 分區；桌機三欄（常平／自製／委外，1b 放常平欄頂）、手機單欄可折疊；16px 邊距、不橫向捲動；頁尾顯示 `notes` 與 `excluded` |
| `components/packaging/PoolBlockSection.tsx` | 區塊標題（卡數、工時合計、逾期數）、折疊、4x 的「複製清單」 |
| `components/packaging/PackagingCardView.tsx` | 卡片：SO（可點）、客戶、品名、包裝方式、數量（可包/總量）、交期＋剩餘工作天、工時＋來源、狀態徽章、來源標籤（常平/委外/自製＋單號）、常平出貨備註、訂單備註、製令＋前站、打樣徽章、危險旗標、預估可包日；高密度、長文字 `line-clamp` 點開展開 |
| `components/packaging/ZoomableViewer.tsx` | 見下 |
| `components/packaging/PackagingOrderModal.tsx` | 包 `SoOrderModal`：開啟時呼叫 sketches API；以 `renderLineExtra` 在每行放「示意圖 (n)」按鈕 → 開 ZoomableViewer；`extraContent` 放本卡的包裝資訊摘要 |
| `components/SoOrderModal.tsx`（小改） | 新增選用 prop `renderLineExtra?: (line: { line_no: number \| string \| null; mbp_part: string \| null; description: string \| null }) => React.ReactNode`，渲染在每行 Row 1 右側；不傳時畫面完全不變（其他 12 個使用頁不受影響） |

**ZoomableViewer 規格**：全螢幕遮罩；圖片以 `transform: translate(x,y) scale(s)` 呈現，`touch-action: none`；滾輪以游標為中心縮放；Pointer Events 單指/滑鼠拖曳平移、雙指捏合縮放；雙擊在「符合視窗」與「原始像素 1:1」間切換；縮放範圍 fit ~ 原圖 2 倍；工具列：− / + / 重設 / 全螢幕（Fullscreen API，不支援時退回 fixed inset-0）/ 下載原圖（新分頁開 url）；多張時左右鍵與按鈕切換、顯示 `2 / 3`；載入中顯示轉圈（原檔 2~5MB）。原圖直接用 API 給的 url（4961×7017，放大才清楚，**不可**走 NAS 800px 縮圖）。`kind='pdf'` P0 以新分頁開啟（實測近期 0 張 PDF；pdfjs 渲染留 P1）。

### (C) 入口
| 檔案 | 改動 |
| --- | --- |
| `app/page.tsx` | 新卡 `order-17`「包裝專區 Packaging」連 `/packaging`；`canPackaging = hasFeaturePermission('packaging') \|\| hasFeaturePermission('packaging_admin')`，無權限 `opacity-50 grayscale` 並以 `guardFeatureAccess('packaging','包裝專區')` 擋；樣式比照工程專區卡（琥珀色） |
| `lib/authShared.ts` | `ADMIN_PERMISSIONS` 加 `'packaging', 'packaging_admin'` |
| `app/admin/team/page.tsx` | 「功能專區」加 `{ key: 'packaging', label: '包裝專區・唯讀 (Packaging)' }`、`{ key: 'packaging_admin', label: '包裝專區・主管編輯 (P1 起)' }` |
| `config/menuItems.ts` | 「產線排程看板」群組的 `包裝排程`（`/admin/production/packaging`）改名 `包裝站塔台看板`（D36），路徑不變 |

---

## 九、已知限制與 P0 暫用規則（`notes`，顯示於頁尾）

1. **P0 暫用完成規則**：常平／委外沒有完成勾選框可存。常平批在塔台包裝站的包裝工序（非 QC）報完工即隱藏；SO 在 ARGO 結案即隱藏。**P1 改為主管勾選完成**。ARGO 入庫＝品檢完成＝才要開始包，絕不當完成。
2. **委外（MPO）在塔台只有 QC 工序**，P0 沒有包裝完成訊號，已入庫的委外卡會一直留到 SO 結案。
3. **自製製令以塔台包裝工序完工代替 ARGO 繳庫**（EIP 未同步繳庫量，D40/P3 補）。
4. 「SO 行已全數銷貨」查不到（無銷貨明細鏡像），只能以 SO 結案判斷。
5. **常平出貨燈可能誤亮**：同單同品號多行時（multi_line）黃底同步會把所有行都亮燈；配不到數量的行標「出貨燈可能誤亮」。
6. 常平黃底同步**每晚 23:30 一次**（D37 改一天 4 次待 Snow 到工廠電腦設定）；分批寄出時 shipped_at 只記第一次。出貨日未解析（出HK、台湾处理）者以匯入時間代替，不估可包日。
7. 預估可包日＝寄出日＋預設運輸工作天（順豐 3、空運 5、海特快 7、一般海運 13），尚未以實績校正（D13 上線後每月校正）。
8. 委外「已出貨」靠採購手動點（實際只約 296 行有燈），5a 多半是空的；5c 補救。5c 以採購追蹤交期（已倒推 2 工作日）判斷，太趕沒倒推的單會晚 2 天才出現。
9. MPO↔PO 在 Supabase 無直接關聯（缺 APL_APJ_APPLY_ID），委外到台訊號只能套在 SO 行層級。
10. 中轉單若採購開給第三方廠商，P0 會歸在委外。
11. 前站平行鏈（prime/job_dep）DB 沒有；同序號多道視為平行鏈取最落後者，不同序號的平行鏈可能判斷錯。塔台報工紀錄每 3 小時同步、排程每 30 分同步。
12. 「只有包裝站、沒有前站」（4x）可能是塔台工序錯誤，清單給 Snow 確認（D35）。
13. 工時：常平換箱 0.2 分/件暫以「每人」解讀；牛皮盒、鋁箔袋、條碼、五金組裝、氣泡袋、放數尚無附加工時；多個附加元素直接相加。
14. 工作天用台灣行政日曆（內建 2026–2027）；包裝部週六是否上班未定。
15. 採購行只看近 180 天開單；打樣單判定只看近 120 天出單表，更早的訂單只能靠品名含「打樣」。
16. 資料更新時間：ERP 訂單/採購平日每 5 分~1 小時；塔台排程每 30 分；出單表即時。

---

## 十、驗收重點（給實作者自測）

- 以 `POC2026091701` sub 26/27（multi_line，標記 qty 110 與 2）驗證兩行都判定為真的寄出、無誤亮旗標。
- 以 `SO260827004` 驗證委外 PO260901016 行 1（17000，入庫 11146）→ 5b 11146 張＋未到片 5854 依轉運站狀態進 1b/5a/5c，行 2（600）配到 SO 行 2。
- 以 `MOT26072702203`（UV 印刷 pause、轉運站 finished）驗證前站取序號最大者。
- 9/25、9/28 不算工作天：`workdaysBetween('2026-09-24','2026-09-29') = 1`（只有 9/29）。
- 手機寬度 375px 無橫向捲動；ZoomableViewer 雙指縮放、拖曳在平板可用。
- 回傳 JSON 中不得出現 `customer_vendor`、廠商名稱、`changping_ship_marks` 的 transport/match_status 原文、採購手打備註。

---

## 十一、P0 暫用規則與第 1~2 輪驗證後的修正

> P0 已做兩輪「驗證 → 修正」（2026-09-27）。本節記錄**目前程式實際採用**的規則，覆蓋前文 §3.4～§3.10、§九 的對應描述。
> 判定邏輯在 `lib/packaging/classify.ts`（純函式），I/O 在 `lib/packaging/pool.ts`，型別在 `lib/packaging/types.ts`；頁尾註腳以 `POOL_NOTES`（pool.ts）為準。

### 11.1 第 2 輪資料層修正（fix2-data）

| # | 規則 | 取代／補充 | 畫面上看得到的痕跡 |
| --- | --- | --- | --- |
| 1 | **原物料／耗材採購行不出卡**：品號 `M*`／`W*` 且對不到 SO 行（SO 上沒有這個品項，例：空白板材、PET、空白 T 恤、燈座、PE 膜、鋁箔袋、墨水）＝自製投入料，最後由製令卡包裝；出卡會讓工時重複計算。客戶直接買的 M/W 品項（SO 上有同品號行）照常出卡（D6） | §3.8 新增一類排除 | 頁尾「原物料／耗材採購」＝`excluded.materialPurchase` |
| 2 | **採購單結案不再追剩餘量**：單身 `CLOSE_FLAG=Y` **或表頭 `status=CLOSE`** 且沒到齊 → 未到量不再出卡；已入庫片照常進 2／5b | §3.4 `closedShort` 只看單身 | —（統計 `po_closed_short`） |
| 3 | **同 SO 行多開採購行的未到量封頂**：同 SO 行所有採購行的「未到量」合計上限＝`訂單量 − 各採購行已入庫合計`；已點出貨的採購行優先拿額度。超出部分不出卡，每個被砍的採購行計 1 次 `excluded.poExceedsSo`，同 SO 行的卡加 `po_exceeds_so`（橘）列出被砍的採購行與未到量，請採購確認是否重複開單 | §3.4 新增 | 頁尾「採購量超過訂單」＋卡片橘色旗標 |
| 4 | **舊式 POC 兄弟行以數量分辨**：舊式塔台鍵（`mo_nbr`＝單號、無 `-n`）只有「單號＋品號＋批號（SO 項次）」，不含 SO；同一張 POC 兩個不同 SO 都是項次 1、同品號時會共用同一條途程。改為：途程應做量／報工量等於本採購行數量、且沒有兄弟行同數量才採用；分不出來就不採用塔台狀態並標 `so_line_ambiguous` | §3.6 舊單鍵 | 卡片「無法分辨」旗標 |
| 5 | **塔台批要比品號**：SO 行層級的 POC／MPO 批，批的 `product_name` 必須等於 SO 行品號（ERP 改過項次時依品號找回正確項次；同品號多行以批量＝訂單量消歧，仍不唯一就不採用）；舊式 POC 批同樣比品號 | §3.3、§3.5 到台訊號 | 批號過期時不再套錯到台／完工訊號 |
| 6 | **常平 POC 卡併入製令卡**：製令途程在包裝站之前有轉運站「委外/N天回」（常平代工回台）→ 同 SO 行的常平採購片與製令卡是同一批實物，只留製令卡（製令已包完被隱藏時，採購片一起隱藏）；製令前站還沒開工時不併，讓採購卡照常顯示運送狀態 | §3.7「各自成卡」 | 區塊 4 卡片 `merged_into_mo`（灰）列出被併的採購行 |
| 7 | **ERP 新鮮度改讀 `erp_sync_logs`**：取 `action=sync_so／sync_po`、`ok=true` 的最新 `created_at`。不能用表內 `max(synced_at)`：對帳模式只有資料列變動才更新，連假沒新單會被誤判成同步停擺；讀不到 log 才退回 `max(synced_at)` | §7.1 新鮮度 | 摘要列「資料更新：ERP 訂單／ERP 採購」 |
| 8 | **「非打樣」等否定／引述寫法不算打樣**：品名先剔除「無／不／免／非／沒有打樣」「對／依／照／同／參考／核可的打樣」「比照…打樣」「打樣效果／圖層／單號／後」「打樣…偏／降」再判斷是否含「打樣」。誤標打樣會把區塊 3 門檻從 5 天縮成 3 天（反而少警示），所以寧可窄 | §3.9 行層規則 | 打樣標籤減少誤判 |
| 9 | **舊途程 QC 人工完工算到台**：途程沒有轉運工序（QC 是第一道）時，包裝站「QC檢驗／入庫」人工報完工也視為貨已在台灣（D18） | §3.5 `transitDone` | 1b 品檢中 |
| 10 | **5c 改以「今天 ≥ end_date 往前 2 個週一～五」列入**，並在「今天 < end_date」時加 `ship_confirm_early`（灰）。原因：ARGO 同步把原交期 D 往前推 2 個週一～五成 S，但「推完已早於今天」就回原交期 → 過了 S 後 end_date 會被改回 D（`erp_change_log` 實測 2,038 筆 end_date 變動有 1,951 筆是這種）；直接比 `today ≥ end_date` 會在 S 當天出現、D−1 消失、D 再出現 | §3.5 區塊 5c | 卡片「提早列入」旗標 |
| 11 | **包裝完工只認人工報完工（`manualFinished`）**：包裝站非 QC 工序必須由人報完工（`source_type ≠ auto_sara`）才算完成／才扣已包量；塔台系統自動結工可能是入庫時連帶結掉，算數就等於拿入庫當完成（D17／D26 禁止）。常平 POC 與自製製令同一規則；到台訊號（轉運站、舊途程 QC）也只認人工完工 | §3.6、§3.7 | 頁尾「包裝站已報完工」＝`excluded.packagedDone` |
| 12 | **區塊 4 前站逾期亮 `eta_passed`**：製令前站過了計畫完工日（`estReadyDate < 今天`）仍未完工 → 橘燈；原本只有區塊 1／5a 的預估可包日到期未入庫才亮 | §3.10 `eta_passed` | 區塊 4 卡片橘色旗標 |
| 13 | **區塊 3 允許部分入庫**：常平採購行已入庫一部分、其餘未寄且交期緊張，也要進區塊 3 提醒（已入庫部分另列區塊 2），此卡帶 `partial_received`（灰）；原本條件是 `rcv = 0` | §3.5 區塊 3 | 區塊 3 卡片「已入庫 X／採購 Y」 |

> 任務單把第 2 輪記為「11 處修正」；上表把「不出卡＋計數」「封頂＋旗標」等同一處改動的效果拆開寫，所以是 13 列，範圍相同。

`PoolExcluded`（頁尾「未列入待排池」）第 2 輪時 6 個欄位（**D43 後新增 `saraClosedOrAbsent`「塔台已結案或不在塔台」，共 7 個，見 §十二**）：`packagedDone`（包裝站已人工報完工）、`closedSo`（SO／RO 已結案）、`notInPool`（還沒到進池時機：常平未寄不緊張、委外未到交期、製令前站未開工、已無剩餘量）、`materialPurchase`、`poExceedsSo`、`nonPhysical`（費用行，以 SO 行計；其餘以採購行或製令計）。畫面用 `Record<keyof PoolExcluded, …>` 列出，**資料層新增欄位時畫面沒補會編譯失敗**。注意：第 6 條被併入製令的常平採購片**不**計入 `excluded`（只在製令卡上標 `merged_into_mo`）。

### 11.2 第 2 輪畫面修正（fix2-ui）與「舊單隱藏」預設關閉的理由

> **已被 §十二（D43/D44）取代**：「隱藏逾期 >20 工作天的已入庫舊單」勾選、`?hideStale=N`、`hiddenStale`、localStorage 偏好都已移除。以下保留作為當時的決策脈絡。

- **「隱藏逾期 >20 工作天的已入庫舊單」預設關閉**，由使用者自行勾選（偏好存瀏覽器 localStorage）。理由：
  - **D26：入庫不能當完成**。區塊 2／5b 的卡已入庫＝品檢完＝才要開始包；常平／委外入庫後沒有包完訊號，舊單只能等 P1 主管勾選或 SO 結案。
  - EIP 沒有入庫日（D40 的 `IV_INVENTORYIODETAIL` 要到 P3），「逾期很久＋已入庫」分不出「早已出貨、只是 ARGO 沒結案」與「很晚才到貨、正急著包」；預設藏掉可能把急單藏起來。
  - 是否改預設收合、或採「基準日」方案，仍列在決策紀錄待問（舊單積壓），待 Snow 定案。
- **伺服器端收合 `?hideStale=20`**：勾選時改由 API 收掉區塊 2／5b 逾期超過 N 個台灣工作天的卡，重算區塊合計並回傳 `hiddenStale { days, count, minutes, byBlock }`；伺服器快取存完整結果，不同 N 共用同一份。前端門檻 `STALE_WORKDAYS=20` 與伺服器條件一致，勾選前顯示的張數＝實際隱藏張數。
- **`SoOrderModal` set-state-in-effect 修正**（eslint `react-hooks` 規則：effect 內同步 setState 造成多一次渲染），行為不變。

### 11.3 回應大小上限（4.5MB）

- Vercel 函式回應本文上限 **4.5MB**。2026-09-27 完整待排池 JSON 約 **2.2MB**（約 2,000 張卡，區塊 2／5b 1,594 張中有 1,229 張逾期超過 20 工作天），勾「隱藏舊單」後約 **0.8MB**。
- 舊單隱藏預設關閉＝預設回傳完整版，餘裕約一倍。**RO 舊單再累積約一倍之前**，要改成分頁／依區塊延遲載入，或瘦身卡片欄位（例：`work.baseOps`、`sources` 明細改在詳情彈窗再取）。

### 11.4 已知限制（第 2 輪後仍存在）

1. **製令繳庫量要到 P3**：自製製令仍以塔台包裝工序人工報完工代替 D25／D26 的 ARGO 繳庫；EIP 未同步繳庫量（D40）。
2. **委外沒有完成訊號，要到 P1 主管勾選**：MPO 在塔台只有 QC 工序，已入庫的委外卡（5b）會留到 SO 結案，是舊單積壓的主要來源。
3. **5c 以 end_date 推算的偏差**（第 10 條的暫解）：
   - 尚未被改回原交期的單會**提早 2 個週一～五**出現（標「提早列入」）；太趕、同步時沒倒推的單則準時在「原交期往前 2 天」列入。
   - 推算只跳過六日、**不看國定假日**（為了還原同步端 `shiftDueDateBackTwoWorkdays` 的算法），遇連假會差 1～2 天。
   - 根本解：同步端把原始 `DUEDATE` 存進 `extra`，這裡改用台灣行政日曆算「原交期往前 2 個工作天」。
4. **`SoOrderModal` 仍以瀏覽器 anon 讀 `erp_so_lines`**：訂單詳情彈窗（全站 12 頁共用）直接在瀏覽器用 anon key 查同步表，與待排池「一律走伺服器 API＋權限守門」的做法不一致；是否應改走伺服器 API／收緊 RLS **已另開資安任務處理**，P0 不在本分支改動。

---

## 十二、D43/D44 範圍規則（2026-09-27）

> 決策依據：`包裝排程計畫/需求決策紀錄.md` D43（待排池範圍＝塔台未結案 ∪ 已發單未上塔台）、D44（已發單未上塔台的 30 天時間窗）。
> 取代 §11.2 的「隱藏舊單」勾選，以及委外／已入庫舊單「只能等 SO 結案」的積壓處理。系統**不查 ARGO**（含銷貨）。
> 注意：D43 原文是「取代 D25/D26 的 P0 暫用規則與「隱藏舊單」勾選」，字面上連 §3.6「包裝站人工報完工即隱藏」（`excluded.packagedDone`）也在內；
> 實作**目前仍保留**這條（已包完、塔台尚未結案的批不該再排包裝），是否保留待 Snow 確認（§12.6）。

### 12.1 規則

1. **待排池範圍** ＝ (A) ∪ (B)，其餘卡片不列入，計入 `excluded.saraClosedOrAbsent`（**以卡計**，範圍判定在出卡之後）。
   - **(A) 與塔台 SARA 目前未結案批相連的卡**：卡片任一 `sources[].saraMo` 在 `sara_lot_progress.mo_nbr`，或卡片 SO 行（`so-soLine`）＝某未結案批的 `(doc_nbr, lot_nbr)`（製令另認 `so_line_no`；POC／MPO 批**只用依品號校正後的 SO 行**（`purchaseLotsBySoLine`）：ERP 改過項次後 `lot_nbr` 會指到隔壁品項或費用行，過期又對不到的原始批號不算，否則隔壁已結案的卡會因別人的過期批號被留在池裡）。自製 MOT／MOS 卡本來就來自未結案批。
   - **(B) 出單表已發單、未上塔台**：出單表出單日在 **30 個日曆天內（含今天，台北時區）**、ERP SO 行仍在 `erp_so_lines`（未結案）、且比對不到任何塔台批的 SO 行。
2. (B) 的 SO 行**已經有卡**（例：常平 POC 採購卡但塔台沒建批）→ 留在原本區塊，加旗標 `not_on_sara`（橘，「已發單、塔台尚未建立」）。
   (B) 的 SO 行**沒有任何採購行或製令對到**（例：壓克力集單）→ 產生新卡放新區塊 **`ns`「已發單・未上塔台」**（group `shared`、status `not_on_sara`、`POOL_BLOCK_ORDER` 在 `'3'` 之後；桌機畫在三欄上方整列寬）：
   - 來源依出單表 `factory` **推定**：`C`＝常平、`O`＝委外、`T` 與其他＝自製（出單表的廠別本身是由「單據種類」字串推得，見 `lib/argoerp/dailyOrderSheetShared.ts detectFactory`，不是 ARGO 實際開出的單）；`sources` 列出出單表記的製令／採購／請購單號（`saraMo=null`），都沒有時為空陣列。
   - `qtyTotal`＝`qtyCard`＝ERP SO 行數量；`qtyReady=0`；`estReadyDate=null`；工時用 `stdTime`（`routeType` 依上述推定）；打樣、交期旗標照既有規則；費用行（D12）排除並計入 `nonPhysical`。
   - 有來源但依既有規則沒出卡的 SO 行（例：常平未寄且交期不緊張、委外未到交期、已包完）**不**另出 ns 卡，仍由原規則決定；
     這類行出單在 30 天內時**既不出 ns 卡、也沒有卡可加旗標、也不進異常清單**（異常清單只收 30 天以上），「塔台尚未建立」的提醒不會出現。是否要補提醒待 Snow 決定（§12.6）。
3. **出單日超過 30 天、ERP 未結案、未上塔台** → 不列入待排池，放 `PoolResponse.staleUnsynced { windowDays, count, rows[] }`（`so, soLine, sheetDate, docType, factory, moNumber, poNumber, prNumber, itemName(前 40 字)`，依出單日由新到舊；不含客戶）。畫面在頁尾上方有可收合區「發單超過 30 天仍未上塔台（N）」與「下載 CSV」（前端產生，開頭 UTF-8 BOM 讓 Excel 正確顯示中文）。
4. 移除「隱藏逾期 >20 工作天的已入庫舊單」：伺服器 `?hideStale`、`hideStaleReady()`、`hiddenStale`、畫面勾選框與 localStorage 偏好（載入時會清掉舊鍵 `packaging.pool.hideStale.v1`）。

### 12.2 「上過塔台」的判定與資料源

| 項目 | 規則 |
| --- | --- |
| 出單表列鍵 | `(order_number, match_line_no ‖ line_no_input)`；同一 SO 行出現在多張出單表時，出單日取**最新**一張、單號取所有列的**聯集** |
| 出單表單號 | `mo_number`、`po_number-po_sub_no`、`pr_number-pr_sub_no`（正規化：去空白、大寫） |
| 塔台單號 | `sara_lot_progress ∪ sara_wip_schedule ∪ sara_wip_records` 的 `mo_nbr`。只有三種算命中：① 原樣相同；② 出單表有 `-n`、塔台是舊式無後綴單號（去掉出單表的 `-n` 後相同）；③ 出單表沒記項次、塔台有 `-n`（去掉塔台的 `-n` 後相同）。**兩邊都有 `-n` 但數字不同（同一張單的別行）不算**——常平 POC 常見同張單 -1～-12 都有批、唯獨 -13 沒建 |
| ERP 採購行 | 出單表常只記 MOT 號或沒記單號，實際走 POC → 也看該 SO 行的 ERP 常平採購行：新式 `{POC 單號}-{行}` 原樣在塔台；或舊式（`mo_nbr`＝單號本身）且**批號＝SO 項次、品號相同**。舊式批常開在同 SO 的另一張 POC 底下，所以舊式比對用「同 SO 所有 POC 單號」 |
| 卡片來源 | 卡片 `sources[].saraMo` 在塔台（含只剩 records 的已結案批）→ 這一行上過塔台，照 D43 排除，不標 `not_on_sara`、也不進異常清單 |
| 已上塔台 | SO 行＝未結案批的 SO 行鍵，或任一出單表單號命中，或 ERP 採購行命中，或同 SO 行有任一張 (A) 卡，或同 SO 行有卡片來源命中 |
| ERP 未結案 | `erp_so_lines` 查得到該 SO 行（結案單會被同步刪除） |
| 讀取範圍 | 出單表改讀近 **365 天**（原 120 天）；異常清單**涵蓋近 365 天出單表**，超過 365 天的出單不在清單內（頁尾註腳第 3 條揭露；實測最早 2026-05-04）；出單表上所有 SO 都併入 `erp_so_lines` 查詢 |
| records 補查 | `sara_wip_records` 4 萬多列不全抓（第 ③ 波已整批抓進近 180 天常平 POC 採購行的 `{單}-{行}` 與舊式單號）：仍對不到的出單表單號，以「原樣＋（有 `-n` 時）去 `-n` 的舊式單號」用 `in()` 精確補查（`unresolvedSheetMoRefs()`）——正好涵蓋命中規則 ①②，結果不受「前幾波剛好抓進哪些報工紀錄」影響。規則 ③（出單表沒記項次、塔台只有 `{單號}-n`）要前綴 `like` 才查得完整，實測 40 個 or 條件一次 0.5～1 秒、全部多 8 秒且併發會撞 statement timeout，所以**不補查**，只靠已載入的批／排程／報工紀錄 |

判定邏輯在 `lib/packaging/classify.ts`（`classifyPool` 尾段；`sheetMoRefs`、`unresolvedSheetMoRefs`、`NOT_ON_SARA_WINDOW_DAYS=30`），I/O 在 `lib/packaging/pool.ts` 第 ④ 波。

### 12.3 2026-09-27 實測（唯讀，含 §12.5 驗證修正後）

| 區塊 | 卡數 | 工時（小時） |
| --- | ---: | ---: |
| 3 常平未寄緊張 | 18 | 17.3 |
| **ns 已發單・未上塔台** | **16** | **15.1** |
| 1 常平運送中 | 52 | 43.3 |
| 1b 品檢中 | 29 | 54.6 |
| 2 常平已入庫 | 58（其中 13 張帶 `not_on_sara`） | 145.8 |
| 4 製令前站 | 91 | 297.2 |
| 4x 無前站 | 0 | 0 |
| 5c 委外出貨待確認 | 22 | 59.5 |
| 5a 委外已出貨 | 3 | 63.6 |
| 5b 委外已入庫 | 34 | 182.3 |
| **合計** | **323** | **878.9** |

- 原本（無範圍規則）約 1,900 張／4,100 小時；`saraClosedOrAbsent` 1,577 張。ns 16 張中 15 張沒有任何單號（壓克力集單等），1 張推定委外；既有卡被加 `not_on_sara` 的 13 張（全是區塊 2 常平已入庫：同張 POC 別行在塔台、本行沒建批）。
- `staleUnsynced.count` 955（5 月 352、6 月 440、7 月 95、8 月 68）。
- 回應約 549KB（原約 2.2MB）。
- 修正前（第一版 §十二）為 311 張／877.2 小時、`saraClosedOrAbsent` 1,589、stale 955、旗標 0：差異見 §12.5。

### 12.4 已知限制

1. **塔台已結案批的歷史只能從 `sara_wip_records` 推**：批結案後就從 `sara_lot_progress`／`sara_wip_schedule` 消失，**沒報過工就結案的批**會被當成「未上塔台」，出現在 ns 區塊或異常清單。
2. **壓克力集單（SOB）常沒有製令號**，只能靠 SO 行＝未結案批的 `(doc_nbr, lot_nbr)` 比對；集單的塔台批若批號不是 SO 項次，會被誤判為未上塔台。
3. ns 卡的來源／工時途程是依出單表廠別**推定**，不是 ARGO 實際開出的採購／製令；塔台建批後卡片會自動改由正常區塊判定。
4. 範圍依賴 Snow 以結案檢查流程維護塔台結案：塔台忘了結案的舊批仍會留在池內；塔台提早結案（實際未包）的品項會消失。
5. 30 天窗口以出單表「最新一張」的出單日計：同一 SO 行重新發單會重新起算。
6. **ERP 採購行沒載入就推不到**：「ERP 採購行」比對只看近 180 天、SO 未結案的採購行（`fetchPoLines`）。採購行不在範圍內、出單表又只記 MOT 號時，已結案的舊式 POC 批仍會被當成未上塔台（2026-09-27 實測 1 行進了異常清單）。
7. **命中規則 ③ 不補查**：出單表沒記項次、塔台只有 `{單號}-n` 且那張單不在已載入的報工紀錄裡時，會被當成未上塔台（見 §12.2 records 補查）。
8. **MOS 補印的日期後綴**（例 `-8MM-0914` 對 `-8MM-0924`）兩邊都有 `-n` 且數字不同，不算同一張；要當成同一張需另寫 MOS 專用規則（§12.6）。

### 12.5 驗證後修正（2026-09-27）

| # | 問題 | 處理 | 實測影響 |
| --- | --- | --- | --- |
| 1 | 同一張 POC／MPO 的別行被當成本行上過塔台（索引同時收「去 -n」寫法，兩邊都有 -n 也會命中） | 索引拆 `exact`／`stripped`，只留 §12.2 的三種命中；`unresolvedSheetMoRefs` 只補查原樣＋舊式無後綴單號 | 區塊 2 多 13 張帶 `not_on_sara`；異常清單多 4 行 |
| 2 | 只看出單表單號，沒看 ERP 常平採購行（出單表記 MOT 或沒記單號，實際走 POC）→ 已結案批誤判為未上塔台 | 加「ERP 採購行」比對（新式原樣；舊式同 SO 所有 POC 單號＋批號＝項次＋品號） | 異常清單少 4 行（驗證抽查的 5 行誤報修掉 4 行，剩 1 行見 §12.4 第 6 條） |
| 3 | 只看出單表，沒看卡片自己的 `sources[].saraMo`（塔台已結案批只剩 records） | 卡片來源在塔台 → 該行算上過塔台，排除、不標旗標、不進異常清單 | 實測 0 張（邊界） |
| 4 | (A) 範圍用 POC／MPO 原始 `(doc_nbr, lot_nbr)`，過期批號把隔壁已結案品項留在池裡 | POC／MPO 批只用品號校正後的 SO 行 | 區塊 5b 少 1 張（批號 5 的批其實是第 7 行的品號） |
| 5 | `POOL_BLOCK_ORDER` 漏放區塊不會編譯失敗 | 改 `as const satisfies`＋`Record<Exclude<…>, never>` 防呆 | — |
| 6 | CSV 沒防公式注入；BOM 是貼在原始碼裡的隱形字元 | `csvCell` 開頭 `= + - @ Tab CR` 前加 `'`；BOM 改寫成跳脫的 `\uFEFF` | — |
| 7 | 異常清單「沒有下限」與 365 天讀取範圍不符；備用註腳委外隱藏條件與 D43 矛盾 | 註解、規格、`POOL_NOTES` 第 3 條改為「涵蓋近 365 天」；備用註腳補「塔台批結案（D43）」 | — |

### 12.6 待 Snow 確認

1. **包裝站人工報完工即隱藏（`packagedDone`）要不要保留**：D43 原文字面上連這條也取代。目前保留（已包完、塔台尚未結案的批不該再排包裝）。選項：(a) 保留並在 D43 補一行附註；(b) 取消，塔台結案前一律留在池內（2026-09-27 `packagedDone`＝398 個採購行／製令，其中塔台批仍未結案的才會回到池內）。
2. **有採購／製令來源、但依既有規則尚未進池的 30 天內未上塔台 SO 行**（常平未寄且不緊張、委外未到交期等）：選項：(a) 維持現狀，不提醒（本節已寫明）；(b) 仍出 ns 卡；(c) 不出卡，改列在異常清單另一分頁。
3. **MOS 補印日期後綴要不要當同一張**（§12.4 第 8 條）。
4. 決策紀錄「P0 驗證後需 Snow 拍板・舊單積壓」那一條仍描述已移除的「隱藏舊單」勾選，確認後標註「已由 D43 解決」。
