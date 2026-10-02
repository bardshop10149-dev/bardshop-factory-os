-- 2026-10-02  工時基準改為依途程設定（app_settings.sara_est_basis_mode）
--
-- 背景：2026-08-24 加了 route_operations.qty_mode（個數/盤數）與維護介面，計畫是
-- 「生管填完設定後，工序產生邏輯改讀這個欄位」，但第三步一直沒做，開關等於唯寫——
-- 生管在頁面上切換，對送給塔台的工時毫無影響（四處產生邏輯都硬寫「盤數有填就用
-- 盤數，沒填退回個數」）。本次補上讀取邏輯（lib/sara/estTime.ts）。
--
-- ── 為什麼一開始先設 legacy，後來才切 route-qty-mode ──
-- 先用全部出單表資料模擬過：照「當時的」設定算，印刷工時會從 6,332 小時暴增成
-- 108,144 小時（17 倍），全部來自 1,981 道「設定寫個數、實際有盤數」的工序。
-- 所以先上 legacy-pan-first（＝維持原行為），沒有直接啟用。
--
-- 之後生管確認了正確規則：**所有壓克力的印刷與雷切都用盤數，4mm 以上也一樣**。
-- 原本那些「個數」停在欄位預設值，是漏設而不是刻意（同品類的 2mm 全是盤數，
-- 只有 3mm 與 4mm 以上停在預設）。依此批次更新 191 筆後重新模擬，結果合理：
--   工時總量 330,223 → 329,669 小時（減少 554 小時）
--   因缺盤數被擋下的列 90 列 / 3,478 列（2.6%）
-- 於是把開關切到 route-qty-mode。
--
-- 切換（在 Supabase SQL Editor 執行其中一行）：
--   依設定計算（現行）： update public.app_settings set value = '"route-qty-mode"'   where key = 'sara_est_basis_mode';
--   回復舊行為：         update public.app_settings set value = '"legacy-pan-first"' where key = 'sara_est_basis_mode';
--
-- 註：切到 route-qty-mode 後，「設定要用盤數但出單表沒填盤數」的列不再默默退回個數，
-- 而是整列擋下進待處理。退回個數會把工時放大一個量級（實測個數約為盤數的 18.4 倍），
-- 2026-09-30 稽核時就有一道 UV 印刷被排成 95 小時，而塔台只會看到一個大數字照排。
-- 缺資料就停下來，比帶著錯誤資料繼續跑安全。
--
-- 全檔可重複執行（idempotent）。

insert into public.app_settings (key, value, updated_at)
values ('sara_est_basis_mode', '"route-qty-mode"'::jsonb, now())
on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at;
