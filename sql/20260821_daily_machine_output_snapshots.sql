-- 2026-08-21  各機台每日產出快照表
--
-- 背景：新增「生產管理入口 → 各機台日產出」頁面，資料來自即時查 ARGO 製令繳庫
-- （PJ_PROJECTDETAIL）+ 本系統機台分配（argoerp_mo_machine_assign）彙總算出來的，
-- 這個計算不便宜（要即時打 ARGO），每次開頁面都重算會很慢，而且沒辦法保證信件
-- 內容（05:30 寄出）跟頁面上顯示的完全一致。改成每天 05:00 排程算一次存成快照，
-- 頁面跟信件都讀這張表，不用各自重算。
--
-- 全檔可重複執行（idempotent）。

create table if not exists public.argoerp_daily_machine_output_snapshots (
  date date primary key,
  rows jsonb not null,
  packing_list jsonb not null,
  total_mo_count integer not null default 0,
  unassigned_mo_count integer not null default 0,
  unassigned_mo_numbers text[] not null default '{}',
  computed_at timestamptz not null default now()
);

alter table public.argoerp_daily_machine_output_snapshots disable row level security;
