-- =====================================================================
-- SARA Factory API - Supabase schema
-- 建立日期：2026-05-13
-- 來源：SARA API 介接文件 (2024-10-23)
-- 所有 *_time / due / started_on / ended_on 為 UTC+0
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 站點 (workcenter)
--    端點：POST /data/workcenter
-- ---------------------------------------------------------------------
create table if not exists public.sara_workcenters (
  id              integer       primary key,
  workcenter_name text          not null,
  raw             jsonb,
  synced_at       timestamptz   not null default now()
);

create index if not exists sara_workcenters_name_idx
  on public.sara_workcenters (workcenter_name);

alter table public.sara_workcenters enable row level security;
drop policy if exists sara_workcenters_all on public.sara_workcenters;
create policy sara_workcenters_all on public.sara_workcenters for all using (true) with check (true);


-- ---------------------------------------------------------------------
-- 2. 製程 (jlb)
--    端點：POST /data/jlb
--    sourcing       : in-house | out-sourcing
--    est_time_mode  : data-pipeline | fixed-time | mpu | uph | ai_prediction
-- ---------------------------------------------------------------------
create table if not exists public.sara_jobs (
  id               integer      primary key,
  job_name         text         not null,
  sourcing         text         not null,
  est_time_mode    text         not null,
  workcenter_id    integer,
  workcenter_name  text,
  raw              jsonb,
  synced_at        timestamptz  not null default now()
);

create index if not exists sara_jobs_name_idx       on public.sara_jobs (job_name);
create index if not exists sara_jobs_workcenter_idx on public.sara_jobs (workcenter_id);

alter table public.sara_jobs enable row level security;
drop policy if exists sara_jobs_all on public.sara_jobs;
create policy sara_jobs_all on public.sara_jobs for all using (true) with check (true);


-- ---------------------------------------------------------------------
-- 3. 工單 (order)
--    端點：POST /data/order
--    mo_nbr 製令單號為唯一鍵
-- ---------------------------------------------------------------------
create table if not exists public.sara_orders (
  mo_nbr           text         primary key,
  doc_nbr          text,
  plan_start_time  timestamptz,
  plan_end_time    timestamptz,
  product_name     text         not null,
  description      text,
  required_qty     numeric,
  lot_nbr          text         not null,
  is_internal      boolean      not null default false,
  item_no          text,
  due              timestamptz,
  raw              jsonb,
  synced_at        timestamptz  not null default now()
);

create index if not exists sara_orders_due_idx          on public.sara_orders (due);
create index if not exists sara_orders_product_idx      on public.sara_orders (product_name);
create index if not exists sara_orders_doc_idx          on public.sara_orders (doc_nbr);
create index if not exists sara_orders_plan_start_idx   on public.sara_orders (plan_start_time);

alter table public.sara_orders enable row level security;
drop policy if exists sara_orders_all on public.sara_orders;
create policy sara_orders_all on public.sara_orders for all using (true) with check (true);


-- ---------------------------------------------------------------------
-- 4. 資源 (resource) + 子表
--    端點：POST /data/resource
--    resource_type  : Machine | Tooling | Operator | Vendor | Virtual
--    capacity_type  : M (零工) | U (無限產能, standard_capacity = -1)
-- ---------------------------------------------------------------------
create table if not exists public.sara_resources (
  id                 integer      primary key,
  resource_name      text         not null,
  resource_type      text         not null,
  capacity_type      text         not null,
  standard_capacity  integer      not null,
  is_extra           boolean      not null default false,
  changeover_time    integer,
  disabled           boolean      not null default false,
  raw                jsonb,
  synced_at          timestamptz  not null default now()
);

create index if not exists sara_resources_type_idx on public.sara_resources (resource_type);
create index if not exists sara_resources_name_idx on public.sara_resources (resource_name);

alter table public.sara_resources enable row level security;
drop policy if exists sara_resources_all on public.sara_resources;
create policy sara_resources_all on public.sara_resources for all using (true) with check (true);


-- 4a. 資源製程能力（多對多）
create table if not exists public.sara_resource_jobs (
  resource_id  integer not null references public.sara_resources(id) on delete cascade,
  job_id       integer not null,
  job_name     text    not null,
  type         text    not null,                                 -- primary | secondary
  line         text,
  primary key (resource_id, job_id)
);

create index if not exists sara_resource_jobs_job_idx on public.sara_resource_jobs (job_id);

alter table public.sara_resource_jobs enable row level security;
drop policy if exists sara_resource_jobs_all on public.sara_resource_jobs;
create policy sara_resource_jobs_all on public.sara_resource_jobs for all using (true) with check (true);


-- 4b. 資源事件（外工時/故障/保養/維修/訓練/借出/加班/請假…）
create table if not exists public.sara_resource_events (
  id            bigserial    primary key,
  resource_id   integer      not null references public.sara_resources(id) on delete cascade,
  started_on    timestamptz  not null,
  ended_on      timestamptz  not null,
  event_name    text         not null,
  available     boolean      not null,
  unique (resource_id, started_on, ended_on, event_name)
);

create index if not exists sara_resource_events_resource_idx
  on public.sara_resource_events (resource_id);
create index if not exists sara_resource_events_time_idx
  on public.sara_resource_events (started_on, ended_on);

alter table public.sara_resource_events enable row level security;
drop policy if exists sara_resource_events_all on public.sara_resource_events;
create policy sara_resource_events_all on public.sara_resource_events for all using (true) with check (true);


-- ---------------------------------------------------------------------
-- 5. 途程 (lot_detail)
--    端點：POST /data/lot_detail（請求 body: { items: [{mo_nbr, product_name, lot_nbr}] }）
--    主鍵 = (mo_nbr, lot_nbr, job_sequence)
--    primary_resources / secondary_resources / assigned_resources 為 jsonb
-- ---------------------------------------------------------------------
create table if not exists public.sara_lot_routes (
  mo_nbr               text         not null,
  product_name         text         not null,
  lot_nbr              text         not null,
  job_sequence         integer      not null,
  job_name             text         not null,
  jlb_id               integer      not null,
  required_qty         numeric      not null,
  status               text,                                       -- init | scheduled | pause | finished
  primary_resources    jsonb        not null default '{}'::jsonb,
  secondary_resources  jsonb        not null default '{}'::jsonb,
  assigned_resources   jsonb,
  plan_start_time      timestamptz,
  plan_end_time        timestamptz,
  raw                  jsonb,
  synced_at            timestamptz  not null default now(),
  primary key (mo_nbr, lot_nbr, job_sequence)
);

create index if not exists sara_lot_routes_mo_idx     on public.sara_lot_routes (mo_nbr);
create index if not exists sara_lot_routes_jlb_idx    on public.sara_lot_routes (jlb_id);
create index if not exists sara_lot_routes_status_idx on public.sara_lot_routes (status);

alter table public.sara_lot_routes enable row level security;
drop policy if exists sara_lot_routes_all on public.sara_lot_routes;
create policy sara_lot_routes_all on public.sara_lot_routes for all using (true) with check (true);


-- ---------------------------------------------------------------------
-- 6. 同步歷程紀錄（每次抓取的成功/失敗/筆數）
-- ---------------------------------------------------------------------
create table if not exists public.sara_sync_logs (
  id           bigserial    primary key,
  action       text         not null,                              -- order | workcenter | jlb | resource | lot_detail
  ok           boolean      not null,
  count        integer,
  elapsed_ms   integer,
  message      text,
  payload      jsonb,                                              -- 請求 body（如 lot_detail 的 items）
  created_at   timestamptz  not null default now()
);

create index if not exists sara_sync_logs_action_idx  on public.sara_sync_logs (action, created_at desc);

alter table public.sara_sync_logs enable row level security;
drop policy if exists sara_sync_logs_all on public.sara_sync_logs;
create policy sara_sync_logs_all on public.sara_sync_logs for all using (true) with check (true);

-- =====================================================================
-- 完
-- =====================================================================
