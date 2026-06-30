# ARGO → Supabase 增量同步偵測設計（最終版）

> 產出日期：2026-06-27。目標：把 ARGO ERP 七個單別的變動「偵測到、同步進 Supabase、並逐筆記錄 LOG」。需求白話講就是「ARGO 任何一個小欄位被改，我們都要抓到」。本文已把四份對抗驗證（adversarial）的攻擊全部折進設計，每個 critical/high 缺口都在正文處理，不留在註腳。
>
> 狀態：**設計草案，尚未實作。需先做「待現場確認」章節的 read-only 驗證才能定案。** 本文不含程式碼。

---

## 結論先講

**老實說：能不能保證「任何一丁點變動都抓得到」？要分兩個層次講。**

- **常見情況（30 分鐘內）** — 表頭欄位被改、整張單被新增/作廢、單號層級的異動，靠 **dual-watermark（表頭+表身雙水印）** 在每 30 分鐘的平日 cron 內抓到。**但這建立在一個尚未現場驗證的前提上**：`PJ_PROJECTDETAIL` 真的有 `UPDATE_DATE`、或表身的編輯會連動 bump 表頭的 `UPDATE_DATE`。recon 現況是「unknown」，而且程式碼從來沒 select 過表身的 `UPDATE_DATE`，2026-06-05 的 orders_cache 改造還刻意只用表頭水印。**這個前提不能用猜的當成過關。**

- **硬保證（catches everything + 抓刪除）** — 真正能「保證任何小變動被抓到、而且能抓到刪除」的是 **content-hash 全量對帳**。它不依賴 ARGO 的 `UPDATE_DATE` 老不老實，直接把每一列現值算 hash 跟 Supabase 存的 hash 比對，順便用 key 差集抓出被刪掉的列。**這是唯一能抓刪除的機制，也是唯一不靠未驗證前提的機制。**

**因為對抗驗證打出兩個關鍵漏洞，對原設計做了一個結構性調整：**

1. **把 hash 對帳從「只跑夜間」升級成「對 OPEN/UNSIGNED 活躍單也跑在 30 分鐘 cadence」。** 活躍工作集很小（只有未結案的單需要重新 hash），塞得進 12s/sync 預算。這樣一來，「靜默編輯（沒 bump UPDATE_DATE）」與「表身編輯」的 30 分鐘保證**不再依賴未驗證的 detail-UPDATE_DATE 前提**——hash 直接變成 30 分鐘的主力機制，而不是 24 小時的備胎。
2. **把 30 分鐘 watermark 路徑改成「per-document scoped delete-aware」**：重抓某張單的全部表身後，對「該單」做小範圍 key 差集刪除，補回舊的 full-wipe 才有的「刪除清理」效果，避免 upsert 留下幽靈列。

**仍需現場實機確認的兩三件事（決定上線範圍）：**
- `PJ_PROJECTDETAIL` / `PJ_APPLYPROJECTDETAIL` / `IV_NOTICE*` 到底有沒有可用的 `UPDATE_DATE`，以及「改表身 / 刪表身」會不會 bump 表頭。
- 那四張 repo 內無 CREATE TABLE 定義的目標表（`erp_so_lines`、`erp_mo_lines`、`erp_pj_sync`、`material_inventory_list`）的實際 PK 與既有 unique constraint。
- 各表的實機重複資料稽核（unique index 會被舊 dupe 卡住）。

**一句話結論：常見異動 30 分鐘內可達標；靜默/表身異動經本設計調整後也能在 30 分鐘內被 hash 抓到（不靠未驗證前提）；刪除與結案靠夜間全量對帳補強。唯一還需現場驗證的是 detail 表的 `UPDATE_DATE` 行為——它只影響「30 分鐘 watermark 快路徑」要不要為某個單別開啟，不影響正確性下限。**

---

## 偵測策略（三層防禦）

### Layer 1 — DUAL WATERMARK（每 30 分鐘，平日）
低延遲快路徑。對每個單別跑兩支獨立的 ARGO `S_QUERY`，都用 `UPDATE_DATE >= watermark` 過濾——一支打 **表頭表**、一支打 **表身表**，把兩邊回來的單號 **UNION**。表身改了但沒 bump 表頭 → 表身 leg 抓到；表頭改了 → 表頭 leg 抓到。對 union 內每張單，重抓**整張表頭+表身**（沿用現有 JS join 程式碼）後 `upsert(onConflict=自然鍵)`。表頭-only 單別（inventory、customer）跳過表身 leg。

**刪除強化（補對抗驗證的 DELETION 攻擊）：** 重抓某張單的表身後，做 per-document scoped reconcile——`SELECT` 該單在 Supabase 的現有自然鍵（`erp_pj_sync` 要加 `doc_type` 範圍），把不在這次重抓結果裡的鍵 `DELETE` 掉，並寫 `erp_change_log` change_type='delete'。把「被刪掉的表身列」的延遲從 24h 拉回 30 分鐘。

### Layer 2 — CONTENT-HASH 保險網（雙 cadence：活躍單 30 分鐘 + 全量夜間）
ARGO 的 `UPDATE_DATE` 不可全信（表身 `UPDATE_DATE` 存在性未確認、可能有不 bump 的編輯、日期粒度只到 YYYYMMDD），而 watermark 在結構上**看不到刪除**。本層對每列算一個穩定的 content hash，逐列跟 Supabase 存的 hash 比，改了就 upsert、ARGO 沒有了就 delete。

- **靜默欄位編輯（critical）**：改了某欄但 ARGO 沒 bump `UPDATE_DATE`。watermark 結構上瞎掉，**只有 hash 能抓**。hash_fields 必須是「每個 user-或-batch-可改欄位的完整列舉」。
- **表身-only 編輯（high）**：若 detail 表沒有可用 `UPDATE_DATE`，Layer 1 表身 leg 形同虛設。把 hash 對帳對 OPEN/UNSIGNED 活躍單也跑在 30 分鐘 cadence，使「表身編輯被 30 分鐘抓到」**不依賴 detail-UPDATE_DATE 前提**。
- **夜間全量是正確性下限**：對每張現存列做全欄 hash 比對，抓到任何 ARGO 沒在 `UPDATE_DATE` 反映的小編輯（24h 內），也抓刪除（24h 內），完全獨立於 detail 表有沒有 `UPDATE_DATE`。

### Layer 3 — CHANGE LOG（每次跑，兩層都寫）
每次跑寫一列 run-summary（比照 `sara_sync_logs`），外加每一筆變動/新增/刪除列寫一列 detail。所有 change_log 寫入包 try/catch-空，logging 失敗永不阻斷主流程（沿用 `saraSync.ts` 鐵則）。

### 水印推進規則
水印推進到「表頭與表身結果中觀察到的 `MAX(UPDATE_DATE)`」，**只在 upsert+log 成功後**才推進。查詢下限要 **減一天 overlap lap**（因為 ARGO `UPDATE_DATE` 是 YYYYMMDD 日粒度，同日晚於水印的編輯否則會漏）。upsert 冪等，overlap 重跑無害。此 overlap 為**不可移除的不變量**，須有單元測試綁住。

---

## 各單別對應表

| 單別 | 表頭表（ARGO） | 表身表（ARGO） | 浮水印欄 | Supabase 目標表 | 自然鍵 |
|---|---|---|---|---|---|
| **SO** 銷售訂單 | `PJ_PROJECT` (PJT_TYPE='SO', HOLD_STATUS IN ('OPEN','UNSIGNED')) | `PJ_PROJECTDETAIL` (LINE_NO>=0) | `PJ_PROJECT.UPDATE_DATE`（確認有用）；detail **待確認** | `erp_so_lines` | (project_id, line_no) |
| **MO** 製令 | `PJ_PROJECT` (PJT_TYPE='MO') | `PJ_PROJECTDETAIL` (LINE_NO>=0；未授權則降級表頭-only) | `PJ_PROJECT.UPDATE_DATE`；detail 待確認 | `erp_mo_lines` | (project_id, line_no) |
| **PO** 採購單 | `PJ_PROJECT` (PJT_TYPE='PO') | `PJ_PROJECTDETAIL` (PJT_TYPE='PO', LINE_NO>=1) | `PJ_PROJECT.UPDATE_DATE`；detail 待確認 | `erp_pj_sync` (doc_type='採購單號') | (doc_type, doc_no, sub_no) |
| **PR** 請購單 | `PJ_APPLYPROJECT` | `PJ_APPLYPROJECTDETAIL` (LINE_NO>=1) | **UNKNOWN**（須分表非 join 查詢 + table-qualified 過濾避開 ORA-00918，見 argo_client.py:1046） | `erp_pj_sync` (doc_type='請購單號') | (doc_type, doc_no, sub_no) |
| **material_prep** 備料 | `IV_NOTICE` | `IV_NOTICEDETAIL` | **UNKNOWN**（程式碼零參照）→ 暫 hash-reconcile-only | `erp_material_prep_lines` | (slip_no, coalesce(line_no,-1)) |
| **inventory** 庫存（表頭-only） | `MM_BOM_BOH_V` 等 view | N/A | **NONE**（view 無日期欄）→ HASH-RECONCILE-ONLY，只跑夜間 | `material_inventory_list` | item_code |
| **customer** 客戶（表頭-only） | `GL_TRADINGPARTNER` (CUSTOMER='Y') | N/A | **NONE**（lookup 表）→ HASH-RECONCILE-ONLY | `erp_customers` | partner_id |

**重點註記：**
- `erp_so_lines` 今日**沒有** JS 去重（不像 MO），實機很可能有重複 (project_id,line_no) 會卡 unique index → 上線前先 dedup。今日 `update_date` 寫 null（route.ts:858），需改成寫入 `PJ_PROJECT.UPDATE_DATE`。
- `erp_mo_lines` 的 `source_order` (`PJT_PROJECT_ID_MO_SO`) 是 SARA 塔台 ↔ ARGO 製令的 join key，**必須進 hash**。
- `erp_pj_sync` 是 PO/PR 共用表，`doc_type` **必進**自然鍵與 onConflict；刪除須 per-doc_type 範圍。`extra` jsonb，hash 前**必須 canonical（key 排序）**。
- PR `doc_no` 推導必須 deterministic 且增量與夜間一致，否則幻影 insert+delete churn。
- `material_inventory_list` 正常模式不去重 item_code 且 `sequence_no` 是位置性 index（不穩）→ 強制 group-by-item_code、`sequence_no` 不進 hash/onConflict。

---

## 變更 LOG 設計

兩張新表，沿用 repo house style（`sara_sync_logs` run-summary + `order_inspection_runs` service_role-only RLS）。

### TABLE 1 — `public.erp_sync_logs`（每單別每次跑一列 run summary）
欄位：id bigserial PK、action、mode(`watermark`|`hash_reconcile`|`hash_active`)、ok、count、inserted/updated/deleted、affected_docs、elapsed_ms、watermark_before/after、message、payload jsonb、created_at。
INDEX (action, created_at desc)。RLS service_role-only。

### TABLE 2 — `public.erp_change_log`（每筆變動列 — 硬需求）
欄位：id bigserial PK、run_id→erp_sync_logs(id)、action、target_table、doc_no、sub_no、change_type(`insert`|`update`|`delete`)、detected_via(`watermark`|`hash`)、source(`user`|`argo_postprocess`)、changed_fields text[]、before/after jsonb、content_hash、created_at。
INDEX (target_table,doc_no,sub_no)、(created_at desc)、(run_id)。RLS service_role-only。

**寫入時機：** upsert loop 內，寫每列前先 batch-SELECT 既有列的 content_hash。無既存 → insert。hash 不同 → update + changed_fields diff。hash 相同 → 不寫（log 只記真變動）。夜間對帳對「存在於 Supabase 但不在 ARGO pull」的鍵發 delete。
**保留：** erp_change_log 留 90 天、erp_sync_logs 留 1 年，夜間 prune。

---

## 要先補的 Schema

新 migration：`sql/20260627_erp_sync_incremental.sql`

1. **三張新表**：`erp_sync_logs`、`erp_change_log`、`erp_sync_state`（水印+hash 狀態；**不用 app_settings**，因 app_settings anon-readable 且單 jsonb bag 會 lost-update race）。`erp_sync_state` 欄位：source PK、header_watermark、detail_watermark、detail_watermark_supported bool、last_reconcile_at、last_active_hash_at、last_run_at、last_count、last_ok、message、updated_at。
2. **各目標表加 hash 欄**：`content_hash text`、`hash_synced_at timestamptz`；並讓 `erp_so_lines`/`erp_mo_lines` 真正寫入 `update_date`（今日寫 null）。
3. **先查實機 schema**（四張表 repo 無定義）：information_schema + pg_indexes + pg_constraint 確認 PK 與既有 unique constraint。
4. **上 unique index 前先 dedup 實機資料**：erp_so_lines (project_id,line_no)、material_inventory_list item_code、erp_material_prep_lines (slip_no,line_no)、erp_pj_sync (doc_type,doc_no,sub_no)。每組 keep-newest-by-id。
5. **material_prep nullable key 正規化**：expression unique index on (slip_no, coalesce(line_no,-1))。
6. **建 unique index（盡量 CONCURRENTLY）** 供 upsert onConflict。erp_customers 已有（partner_id）→ no-op。
7. **inventory sequence_no**：從 upsert payload 拿掉或 deterministic 重算；絕不進 onConflict/hash。
8. **content_hash 一次性 backfill**：用 runtime 同套正規化回填，期間抑制 change_log。

---

## CRON 與排程

兩條 cadence，沿用單一 `WEBHOOK_SECRET`，無新祕密。

- **A) 30 分鐘平日 WATERMARK + 活躍單 HASH**（cron-job.org `*/30 * * * 1-5`）：把現有打 `/api/inspection/cron` 的排程從每小時改 30 分鐘平日。各 ARGO action 內部切 `mode='watermark'`，並對該單別 OPEN/UNSIGNED 活躍單跑 `mode='hash_active'`。維持每 sync 12s timeout，靠 overBudget skip 確保 runInspection 永遠能跑。
- **B) 夜間全量 HASH RECONCILE**（cron-job.org `0 4 * * *`，每日 04:00）：打新 endpoint（或 webhook 帶 `mode='hash_reconcile'`，需把該 action 加進 `webhook/sync` 的 ALLOWED_ACTIONS）。必須跑在 inspection cron 60s maxDuration 之外（拉高 maxDuration 或一單別一呼叫錯開）。排在 04:00 完成於 orders_cache 週日 05:00 全量之前。inventory + customer 只在此跑。

**刪除安全護欄（buggy/partial pull 絕不能洗掉活資料）：**
- **ABORT-ON-EMPTY**：pull 回 0 列 → 跳過刪除、log ok=false、告警。
- **SCOPE**：per-domain，erp_pj_sync 再 per-doc_type。
- **THRESHOLD**：單次要刪 > ~20% → abort + 告警。
- **SOFT-DELETE for 結案**：SO/MO 有 HOLD_STATUS 過濾，消失可能是 CLOSED 不是 deleted → 預設 soft-delete 保住 order-inspection 歷史；連兩次缺才 physical delete。**結案語意待確認**。

---

## 對抗驗證發現（四攻擊，逐一處理）

1. **DETAIL-ONLY EDIT（high）** — 改一條表身欄位、ARGO 沒 bump 表頭、且 detail 表可能沒 `UPDATE_DATE` → 兩支 watermark leg 全瞎。**處理：** verify-or-fall-back gate（存 `detail_watermark_supported`）+ 把 hash 對帳對活躍單跑 30 分鐘，使表身編輯偵測不依賴 detail-UPDATE_DATE。
2. **SILENT FIELD EDIT（critical）** — 改欄但不 bump UPDATE_DATE，且原 MO hash 漏掉幾乎所有可編輯表身欄、`ACTUAL_QTY`/`DATECODE` 全單別漏 → 這些欄位永遠抓不到。**處理：** hash_fields 改成完整、審核過的可改欄位列舉；不排除噪音欄位，改用 `source='argo_postprocess'` 標記壓公告噪音；欄位清單程式化從實機欄位推導 + runtime assert，覆蓋率永不悄悄退化。
3. **DELETION / VOID（high）** — watermark 看不到刪除；per-document upsert 後被刪表身列變幽靈。**處理：** Layer 1 per-document scoped delete-aware + 每 cycle 跑 header-key delta 消歧（CLOSED→soft-delete、查無→hard-delete），不必等夜間。
4. **WATERMARK BOUNDARY & CLOCK（high）** — clock/boundary 機制本身穩（水印取資料 MAX 非 server now、1 天 overlap lap 中和日粒度、失敗不推進安全）；缺口同 #1。**處理：** gate + 30 分鐘活躍 hash；夜間 backstop 硬化（ok=false/skip 發告警 + 追蹤 last_reconcile_at staleness）；1 天 overlap lap 綁單元測試。

---

## 待現場確認（read-only，定案前必做）

1. **`PJ_PROJECTDETAIL` 有沒有 `UPDATE_DATE`？改/刪一條表身會 bump 它或表頭嗎？** ← 最關鍵。探針：`SELECT UPDATE_DATE FROM PJ_PROJECTDETAIL`，再改一條表身觀察。結果寫進 `erp_sync_state.detail_watermark_supported`，gate 住 SO/MO/PO/PR。
2. `PJ_PROJECT.UPDATE_DATE` 是日粒度還是 timestamp？`>=` 邊界含不含？決定 overlap lap。
3. `UPDATE_DATE` 在 ARGO 有沒有索引？決定每 30 分鐘雙查詢滿量下守不守得住 12s。
4. PR 表 `PJ_APPLYPROJECT*` 有沒有 `UPDATE_DATE`？table-qualified 過濾能否避開 ORA-00918？
5. `IV_NOTICE*`（material_prep）讀取是否授權？欄位/鍵為何？有 `UPDATE_DATE` 嗎？
6. 實機 Supabase schema：四張無定義表的 PK 與既有 unique constraint。
7. 實機重複稽核：四張表 per 自然鍵 group-by-having-count>1。
8. SO/MO 刪除/結案語意：OPEN→CLOSED 該 hard/soft-delete/保留？
9. `material_inventory_list` item_code 來源是否真唯一。
10. PR `doc_no` 推導在「全量 vs 增量」是否每列 deterministic。
11. 哪些表身欄是 user-editable、哪些是 ARGO post-process。

---

## 建議落地順序

全程：舊 delete+insert 路徑放在 per-domain feature flag/mode 後面，任何單別出包可瞬間 revert。每單別翻 upsert 前先跑一輪 **SHADOW**（算 hash + 寫 change_log，但仍 delete+insert）驗證再切換。

- **PHASE 0（零 migration 驗證機制）— `sync_customer`**：已有 partner_id unique index、表頭-only、表小。加 upsert + 兩張 log 表 + content_hash + 夜間 hash 對帳。**零 dedup/migration 風險、無表身 leg**，純驗證 logging/hash/upsert 整套機器。
- **PHASE 1 — `sync_mo`**：已 JS 去重，dedup 風險低。演練 dual-watermark 表頭+表身 UNION 與 source_order hashing。
- **PHASE 2 — `sync_so`**：鍵同 MO 但今日未去重 → 小心實機 dedup + unique index。
- **PHASE 3 — `sync_po` 再 `sync_pr`（共用 erp_pj_sync）**：onConflict 必含 doc_type、刪除 per-doc_type。PO 先、PR 後。extra jsonb 需 canonical-JSON hash。
- **PHASE 4 — `sync_material_prep`**：解決 nullable line_no、確認 IV_NOTICE* 授權與唯一性。watermark 確認前以 hash-reconcile 為主。
- **PHASE 5 — `sync_inventory`**：hash-reconcile-only、強制 group-by-item_code、丟位置性 sequence_no。最後轉，對 30 分鐘 cron 風險最低。

---

相關檔案：
- `bardshop-factory-os/app/api/argoerp/route.ts`（同步寫入器，七個 action）
- `bardshop-factory-os/lib/saraSync.ts`（logSync/sara_sync_logs house style）
- `bardshop-factory-os/app/api/inspection/cron/route.ts`、`app/api/webhook/sync/route.ts`（orchestration、ALLOWED_ACTIONS、時間預算）
- 增量藍圖：`bardshop-argo-tool/backend/orders_cache.py`（表頭-only 浮水印，平日 30 分 + 週日全量）
- 新增：`bardshop-factory-os/sql/20260627_erp_sync_incremental.sql`
