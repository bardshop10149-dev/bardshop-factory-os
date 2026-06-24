-- 為 daily_order_sheets 加入操作稽核欄位
-- updated_by: 最後執行儲存（POST）的帳號 email
-- updated_by_name: 顯示姓名（real_name）
-- last_action: 最後操作類型（'save' | 'patch'）

ALTER TABLE public.daily_order_sheets
  ADD COLUMN IF NOT EXISTS updated_by      text,
  ADD COLUMN IF NOT EXISTS updated_by_name text,
  ADD COLUMN IF NOT EXISTS last_action     text;

COMMENT ON COLUMN public.daily_order_sheets.updated_by      IS '最後執行儲存的帳號 email';
COMMENT ON COLUMN public.daily_order_sheets.updated_by_name IS '最後執行儲存的帳號姓名';
COMMENT ON COLUMN public.daily_order_sheets.last_action     IS '最後操作類型：save（整表覆寫）/ patch（局部更新）';
