# ARGO 同步改增量（第一階段：客戶 + 基礎建設）

發布日期：2026-06-27
範圍：ARGO→Supabase 同步「資料庫更新邏輯」改造，第一刀 `sync_customer`。新增檔為主，既有檔僅 `route.ts` 一處 additive 修改。

---

## 一句話

ARGO 同步從「每次砍整張表再全部重灌」改成「只更新真的有變動的列、刪掉消失的列，並逐筆留 LOG」；先從零風險的「客戶同步」開刀，按鈕與所有引用客戶資料的功能行為完全不變。

## 對外變化

無。客戶同步按鈕的操作、訊息、結果都跟以前一樣；MO 列印客戶代碼、領料客戶查詢等讀取 `erp_customers` 的功能不受影響（增量跑完的最終表內容與整批覆蓋逐列相同）。屬後台同步邏輯優化，**不需公告欄通知同事**。

## 技術重點

- 新增可重用增量引擎 `lib/erpSyncReconcile.ts`（`reconcileTable`）：全量拉回 → 逐列內容比對（canonical fingerprint）→ 只 upsert 變動列、刪除消失列；含 **ABORT-ON-EMPTY**（拉回 0 列時不刪，避免 ARGO 暫時失敗洗光活資料）；log 寫入全程 try/catch，永不阻斷主同步流程。
- `sync_customer`（`app/api/argoerp/route.ts`）改用引擎：以 `partner_id` 為自然鍵 upsert（`erp_customers` 早有 `partner_id` unique index，零去重風險）。回傳 `status/syncedCount/skippedCount` 維持原樣，僅新增 `inserted/updated/deleted/unchanged` 供觀察。
- 新增兩張 LOG 表（`sql/20260627_erp_sync_logs.sql`，純新增、不動既有表）：`erp_sync_logs`（每次同步摘要）、`erp_change_log`（逐筆 insert/update/delete 變動，含變動欄位與 before/after）。service-role 寫入、RLS 啟用、前台 anon 不開放。

## 設計與回測文件

- 設計書：`docs/design/2026-06-27-argo-incremental-sync-design.md`
- 回測計畫：`docs/design/2026-06-27-argo-sync-regression-plan.md`

## 部署/設定步驟

1. Supabase SQL Editor 執行 `sql/20260627_erp_sync_logs.sql`（建兩張 LOG 表）。未執行前同步仍可運作，只是不記 LOG。
2. 其餘 6 顆同步按鈕（SO/MO/PO/PR/批備料/庫存）沿用同一引擎，後續階段逐顆轉換；其中 SO/MO/PO/PR/批備料 轉換前需先補 unique index + 去重稽核。

## 驗證

- `tsc --noEmit`、`next build`、`eslint`（變更檔）皆綠。
- 引擎與整批覆蓋的最終資料逐列等價（同列、同值；差別僅未變動列不再重寫、`synced_at` 不跳，客戶表無依賴此欄的功能）。

## 變更檔案

新增：`lib/erpSyncReconcile.ts`、`sql/20260627_erp_sync_logs.sql`、`docs/design/2026-06-27-argo-incremental-sync-design.md`、`docs/design/2026-06-27-argo-sync-regression-plan.md`
既有微修：`app/api/argoerp/route.ts`（僅 `sync_customer` 寫入段 + 一行 import）
