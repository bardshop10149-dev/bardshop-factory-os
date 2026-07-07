# ARGO 同步改增量（第二階段：SO/MO/PO/PR/委外/庫存 全面轉換）

發布日期：2026-07-03
範圍：延續 6/27 第一階段（客戶）。`app/api/argoerp/route.ts` 六個同步 action 的「資料庫更新邏輯」＋共用引擎加固＋唯一索引 migration。按鈕操作、查詢、回傳欄位、頁面全部不變。

---

## 一句話

其餘同步按鈕（銷售訂單、製令、採購、請購、委外製令、倉庫庫存）全部改成「只更新有變動的資料列、刪掉消失的列、逐筆留 LOG」；批備料因 ARGO 資料本身沒有可靠唯一鍵，刻意維持原本整批覆蓋。

## 對外變化

無。所有按鈕訊息與行為照舊；各表最終內容與整批覆蓋逐列相同。差異只有兩點（皆為預期）：
1. `synced_at`（各列同步時間）只在該列真的有變動時才更新——「上次同步」時間戳顯示的是「最近一次資料有變」的時間；排程是否有跑請看 `erp_sync_logs`。
2. `erp_sync_logs` / `erp_change_log` 開始記錄這六顆按鈕的每次執行與逐筆變動。

## 本次轉換對照

| action | 目標表 | 自然鍵 | 備註 |
|---|---|---|---|
| sync_so | erp_so_lines | (project_id, line_no) | |
| sync_mo | erp_mo_lines | (project_id, line_no) | 保留原 last-write-wins 去重 |
| sync_po | erp_pj_sync | (doc_type, doc_no, sub_no) | scope=採購單號，絕不動其他單別 |
| sync_pr | erp_pj_sync | 同上 | scope=請購單號；joined/兩段式共用同一 persist |
| sync_pj | erp_pj_sync | 同上 | scope=呼叫端 docType（委外製令等） |
| sync_inventory | material_inventory_list | (item_code) | sequence_no 納入比對，維持「照 ARGO 順序重編號」原行為 |
| sync_material_prep | erp_material_prep_lines | — | **維持整批覆蓋**：實測同 (slip_no,line_no) 可有多筆不同料號＋完全重複列，無可靠自然鍵，硬上 upsert 會丟資料 |

## 引擎加固（lib/erpSyncReconcile.ts，回應 2026-07-03 事後稽核 31 項發現）

- 複合鍵以控制字元分隔（修 ('A1','2') 與 ('A','12') 相撞）；null 鍵值與空字串區分。
- 讀既有列的分頁加 `ORDER BY 鍵欄+id`（頁界穩定，不漏讀/重讀）。
- 刪除改以 `.select()` 回傳實際被刪列計數（不再以「嘗試數」充當）；複合鍵 null 值用 `IS NULL` 比對（修 `eq.null` 靜默不中）。
- **失敗也留 log**：任何錯誤都會寫一筆 `erp_sync_logs(ok=false, message=錯誤)` 再拋出。
- **刪除比例護欄**：單次要刪超過現有列 30% 且 >50 列 → 跳過刪除並記 `deletes_skipped`（防 ARGO 回傳不完整時誤刪一大片）。搭配既有 ABORT-ON-EMPTY。
- change_log 超過單次 2000 筆上限時：先記 delete（稽核最關鍵）再 update 再 insert，並在 payload 記 `change_log_dropped`。

## 部署步驟（順序不可顛倒）

1. **先**在 Supabase SQL Editor 執行 `sql/20260703_erp_sync_unique_indexes.sql`（建 4 個唯一索引；對舊程式無影響）。
2. **後**合併本 PR → Vercel 自動部署。
3. 部署後看 `erp_sync_logs`：每個 action 應出現 `ok=true`、`unchanged` 接近總數的紀錄（首輪可能有少量 update/insert，屬正常收斂）。

## 驗證

- 2026-07-03 實機唯讀稽核：四張表自然鍵零重複（migration 內附數據）；日期欄皆為 text、數量欄皆為 numeric——比對指紋無型別誤判風險。
- 批備料重複鍵實例查證（8 組，含同行不同料）→ 判定不可上唯一鍵。
- `tsc --noEmit`、`next build`、`eslint` 皆綠。
- 中途失敗安全性：新寫法失敗=部分列已更新、下輪自動收斂（優於舊整批覆蓋的「刪光後插一半」）。

## 變更檔案

- `lib/erpSyncReconcile.ts`（引擎加固）
- `app/api/argoerp/route.ts`（六個 persist 區塊換引擎；批備料加「勿改增量」註記）
- `sql/20260703_erp_sync_unique_indexes.sql`（新增）
- 本更新說明
