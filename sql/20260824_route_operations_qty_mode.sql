-- 2026-08-24  route_operations 新增數量模式欄位（個數/盤數）
--
-- 背景：計算工時時，部分工序要用「盤數 × 生產時間」、部分要用「個數 × 生產時間」。
-- 在途程表（工序母資料庫 → 途程表分頁）為每一道工序加上可單鍵切換的數量模式欄位，
-- 預設「個數」。之後（生管填完全部設定後）工序資料產生會改讀這個欄位來決定工時
-- 計算基準；目前僅先建立欄位與維護介面，尚未套用到產生邏輯。
--
-- 全檔可重複執行（idempotent）。

ALTER TABLE public.route_operations
  ADD COLUMN IF NOT EXISTS qty_mode text NOT NULL DEFAULT '個數';
