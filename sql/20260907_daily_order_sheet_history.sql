-- 2026-09-07  每日出單表修改歷程（審計紀錄）
--
-- 背景：daily_order_sheets 只有一個 updated_by / updated_at，每次寫入都覆蓋，事後查不到
--   「某一列的廠區是誰、什麼時候改的」。2026-09-02 SO260828004 #1/#2 被重新貼上出單表
--   從台北改成常平，台北端已先開了製令，之後想追人卻只剩最後一次操作者（且中間又被
--   自動轉單排程蓋掉一次）。Supabase 免費方案 log 只留 1 天，也無 PITR，完全無法回溯。
--
-- 做法：每次寫入出單表（人工儲存/重貼、局部修改、改單專區、排程回寫）都在這張表留一筆：
--   誰、何時、哪種操作、新增/刪除了幾列、哪幾列的廠區/數量/交期/單據類型從什麼改成什麼。
--   出單表頁面提供「修改歷程」面板直接查。
--
-- 全檔可重複執行（idempotent）。

create table if not exists public.daily_order_sheet_history (
  id bigserial primary key,
  sheet_date text not null,                       -- YYYY-MM-DD
  action text not null,                           -- save / patch / change_order / cron:auto-doc / cron:design-transfer
  changed_by text,                                -- email 或系統識別
  changed_by_name text,
  row_count_before integer not null default 0,
  row_count_after integer not null default 0,
  added_count integer not null default 0,
  removed_count integer not null default 0,
  factory_change_count integer not null default 0,
  raw_text_changed boolean not null default false,
  -- { added: [{order_number,line,item_code,factory}], removed: [...],
  --   field_changes: [{order_number,line,item_code,field,from,to}] }
  changes jsonb not null default '{}'::jsonb,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists daily_order_sheet_history_date_idx
  on public.daily_order_sheet_history (sheet_date, created_at desc);

-- 依訂單號跨日期查「這張單的廠區何時被誰改過」（GIN 索引讓 jsonb 包含查詢可走索引）
create index if not exists daily_order_sheet_history_changes_gin
  on public.daily_order_sheet_history using gin (changes jsonb_path_ops);

-- 全部經由後端 API（service role）讀寫，與 order_change_log 相同不開放直接存取
alter table public.daily_order_sheet_history disable row level security;
