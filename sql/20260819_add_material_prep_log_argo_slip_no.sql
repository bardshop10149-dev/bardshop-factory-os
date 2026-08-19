-- 2026-08-19  argoerp_material_prep_log 補上 argo_slip_no 欄位
--
-- 背景：app/api/argoerp/material-prep-log/route.ts 的 POST/DELETE，以及
--   20260811_ng_prep_log_slip_unique.sql 的唯一索引，都假設這張表已經有
--   argo_slip_no 欄位，但資料庫從未真的新增過這個欄位，導致「瑕疵補印批備料」
--   送出時報錯：
--   Could not find the 'argo_slip_no' column of 'argoerp_material_prep_log' in the schema cache
--
-- 這裡補上欄位本身（可為空、不影響既有資料）。若 20260811 那份唯一索引遷移
-- 尚未執行過，請在這個檔案之後接著跑。全檔可重複執行（idempotent）。

ALTER TABLE public.argoerp_material_prep_log
  ADD COLUMN IF NOT EXISTS argo_slip_no text;
