-- ============================================================
-- 2026-06-10  新增 sara_101_master — SARA_101 累計總表
-- ============================================================
-- 用途：
-- 1) 儲存 SARA_101 轉換結果（每日資料 + 舊資料累計）
-- 2) 以 manufacturing_order_number 作為唯一鍵，支援 upsert 覆蓋

create table if not exists public.sara_101_master (
  id                             bigserial primary key,
  order_number                   text,
  manufacturing_order_number     text        not null,
  product_name                   text        not null,
  product_description            text,
  lot_number                     text,
  production_quantity            numeric     not null default 0,
  due                            date,
  priority_level                 text,
  earliest_start_time            timestamptz,
  job_sequence                   text,
  workcenter                     text,
  job_name                       text,
  job_quantity                   numeric,
  out_sourcing                   text,
  est_time                       numeric,
  time_unit                      text,
  bom_components                 text,
  material_required_quantity     text,
  rule                           text,
  parameter_1                    text,
  customer_id                    text,
  assigned_machine               text,

  source_date                    date,
  source_factory                 text,
  source_order                   text,

  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),

  unique (manufacturing_order_number)
);

comment on table public.sara_101_master is 'SARA_101 累計總表（每日轉換後合併資料）';

create index if not exists idx_sara_101_master_due on public.sara_101_master (due);
create index if not exists idx_sara_101_master_customer on public.sara_101_master (customer_id);
create index if not exists idx_sara_101_master_source_date on public.sara_101_master (source_date);

-- RLS
alter table public.sara_101_master enable row level security;
drop policy if exists sara_101_master_all on public.sara_101_master;
create policy sara_101_master_all on public.sara_101_master for all using (true) with check (true);
