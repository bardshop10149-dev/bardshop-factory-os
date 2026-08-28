-- 出單表列表效能優化：把「待處理計數」預先算好存成獨立欄位，
-- 避免每次載入出單表頁面（讀取側邊「已儲存日期」清單）都要把所有歷史日期的
-- 完整 rows JSONB（實測 86 天約 5.8MB）整包抓下來，在後端重新迴圈計算一次。
-- 之後 GET（無 date 參數，列表用）只需要選這幾個小欄位，不再選 rows。
alter table public.daily_order_sheets
  add column if not exists row_count integer not null default 0,
  add column if not exists pending_count integer not null default 0,
  add column if not exists pending_pr_count integer not null default 0,
  add column if not exists pending_c_count integer not null default 0;
