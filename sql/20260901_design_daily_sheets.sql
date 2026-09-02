-- 美編天地「每日出單表」：美編端的試算表式出單表（取代貼 Excel 的前段流程）。
-- 銷售訂單查詢的「傳送到出單表」把訂單列寫進來（16:00 後自動寫到隔天）；
-- 每天 16:00 排程把當天的列轉進生管的 daily_order_sheets（轉為同格式 raw_text，
-- 走既有解析管線）；生管可勾選退單移回隔天的美編出單表。
create table if not exists public.design_daily_sheets (
  sheet_date text primary key,          -- YYYY-MM-DD
  rows jsonb not null default '[]',     -- 列資料（欄位同出單表貼上格式）
  transferred_at timestamptz,           -- 16:00 排程已轉入生管出單表的時間（null=尚未轉）
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.design_daily_sheets enable row level security;
-- 全部經由後端 API（service role）讀寫，不開放 anon/authenticated 直接存取
