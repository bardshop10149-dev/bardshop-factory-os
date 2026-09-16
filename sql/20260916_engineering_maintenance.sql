-- 2026-09-16  工程專區：工程維護/維修表
--
-- 背景：廠內設備維修與工程維護目前沒有系統紀錄，誰報的、排到哪、修好了沒，
--   事後都查不到。這張表把每一件維護/維修集中起來：開單 → 填進度 → 結案。
--
-- 欄位依生管實際需求定義：
--   類型分「機台維修」與「其他類型」，其他類型由現場手填種類/原因
--   （廠務、環境、治具、系統等狀況太雜，列成固定選項反而卡住現場）。
--   機台名稱存純文字不做外鍵，理由同上——報修對象不限 argoerp_machines 裡的生產機台。
--   進度是手填文字而非百分比：現場描述「零件已到，等排休停機」比一個數字有用。
--
-- 全檔可重複執行（idempotent）。

create table if not exists public.engineering_maintenance_records (
  id bigserial primary key,
  -- 單號：EM + YYYYMMDD + 三碼流水（由 API 產生，同日遞增）
  record_no text not null unique,

  -- 類型：機台維修 / 其他類型
  type text not null default '機台維修',
  type_other text,                             -- 類型為「其他類型」時手填的種類/原因
  machine text,                                -- 類型為「機台維修」時的機台名稱

  title text not null,                         -- 維護/維修項目（一行摘要）
  description text,                            -- 詳細說明

  -- 期程
  start_date date,                             -- 開始日
  expected_end_date date,                      -- 預計完成日

  -- 請購
  needs_purchase boolean not null default false,
  pr_number text,                              -- 須請購時填寫的請購單號

  -- 進度（手填文字）
  progress text,

  -- 結案
  status text not null default '進行中',        -- 進行中 / 已結案
  closed_at timestamptz,
  closed_by text,

  -- 稽核
  created_by text,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text
);

-- 列表預設依建立時間新到舊；「未結案的有哪些」是最常用的篩選
create index if not exists engineering_maintenance_created_idx
  on public.engineering_maintenance_records (created_at desc);
create index if not exists engineering_maintenance_status_idx
  on public.engineering_maintenance_records (status, created_at desc);
-- 「這台機器過去修過什麼」是這張表主要的回頭查詢
create index if not exists engineering_maintenance_machine_idx
  on public.engineering_maintenance_records (machine, created_at desc);

-- 全部經由後端 API（service role）讀寫，與 daily_order_sheet_history 相同不開放直接存取
alter table public.engineering_maintenance_records disable row level security;
