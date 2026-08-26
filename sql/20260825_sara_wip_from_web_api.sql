-- ============================================================================
-- 塔台 SARA 現場進度：改用「網頁版 API」直接同步（取代停擺的 CSV 匯入）
--
-- 背景：sara_wip_records 是人工從 SARA 匯出 CSV 再匯入的，資料停在 2026-07-31。
--       網頁版 API（/api/project/management/table、/api/wip/schedule）可直接拉到
--       每批的生產進度與每道工序的即時狀態，改為排程自動同步。
--
-- 本檔只「新增」兩張表，不動 sara_wip_records（歷史資料保留）。
--
-- 兩張表的分工：
--   sara_lot_progress  每批(lot)一列 —— 這張單的這一行整體做到幾成、有無跳站警示
--   sara_wip_schedule  每道「已排程」工序一列 —— 現在在哪一站、是否正在跑
--   （已完成的工序會從 SARA 排程消失，所以「做到哪」要看 sara_lot_progress 的進度）
--
-- so_line_no：由製令號末兩碼推導（MOT26072800703 → SO260728007 的第 3 行）。
--   只有 MOT/MOS 開頭適用；POC(常平採購)、MPO 等無法對應，留 NULL。
-- 時間欄一律存原樣文字（SARA 回 "2026-08-26 20:55" 台灣時間），
--   避免當成 UTC 解析而整批偏 8 小時；只有 synced_at 是真正的 timestamptz。
-- ============================================================================

-- ── 每批進度 ────────────────────────────────────────────────────────────────
create table if not exists public.sara_lot_progress (
  lot_id              bigint primary key,          -- SARA 的批 id（跨表比對一律用它）
  mo_nbr              text,                        -- 製令號
  doc_nbr             text,                        -- 來源訂單號（SO/SOB）
  so_line_no          text,                        -- 由 mo_nbr 末兩碼推導的訂單行號
  product_name        text,
  product_description text,
  lot_nbr             text,
  qty                 numeric,
  due                 text,
  health_state        text,                        -- scheduled / finished / init
  action_state        text,
  progress_percentage numeric,                     -- 整批完成百分比
  warning_state       jsonb,                       -- 例：["skip_station"]
  ach_state           text,
  customer_name       text,
  plan_start_time     text,
  plan_end_time       text,
  synced_at           timestamptz not null default now()
);

create index if not exists idx_sara_lot_progress_doc  on public.sara_lot_progress (doc_nbr);
create index if not exists idx_sara_lot_progress_line on public.sara_lot_progress (doc_nbr, so_line_no);
create index if not exists idx_sara_lot_progress_mo   on public.sara_lot_progress (mo_nbr);

-- ── 每道已排程工序 ──────────────────────────────────────────────────────────
create table if not exists public.sara_wip_schedule (
  jid                  bigint primary key,         -- SARA 的工序 id
  lot_id               bigint,                     -- ＝ sara_lot_progress.lot_id
  mo_nbr               text,
  doc_nbr              text,
  so_line_no           text,
  product_name         text,
  lot_nbr              text,
  workcenter_name      text,                       -- 印刷站2F/包裝站/雷切站/常平廠…
  job_name             text,
  job_sequence         integer,
  qty                  numeric,
  wip_qty              numeric,
  system_status        text,                       -- running / pause / finished / null(未開始)
  is_running           boolean,
  real_start_time      text,
  real_end_time        text,
  plan_start_time      text,
  plan_end_time        text,
  report_resource_name text,
  resource_names       text,
  sourcing             text,
  factory_name         text,
  synced_at            timestamptz not null default now()
);

create index if not exists idx_sara_wip_schedule_doc    on public.sara_wip_schedule (doc_nbr);
create index if not exists idx_sara_wip_schedule_line   on public.sara_wip_schedule (doc_nbr, so_line_no);
create index if not exists idx_sara_wip_schedule_lot    on public.sara_wip_schedule (lot_id);
create index if not exists idx_sara_wip_schedule_status on public.sara_wip_schedule (system_status);

-- ── 權限：與其他 erp_/sara_ 表一致（前端唯讀，寫入走 service role）──────────
alter table public.sara_lot_progress enable row level security;
alter table public.sara_wip_schedule enable row level security;

drop policy if exists sara_lot_progress_read on public.sara_lot_progress;
create policy sara_lot_progress_read on public.sara_lot_progress
  for select to authenticated using (true);

drop policy if exists sara_wip_schedule_read on public.sara_wip_schedule;
create policy sara_wip_schedule_read on public.sara_wip_schedule
  for select to authenticated using (true);
