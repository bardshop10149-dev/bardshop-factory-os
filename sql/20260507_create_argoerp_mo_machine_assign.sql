-- 建立製令機台分配獨立表
-- 統一管理 mo_number → machine 的對應關係
-- 每日出單表與生產機台分配/列印頁面均可讀寫
-- 執行時間：2026-05-07

create table if not exists public.argoerp_mo_machine_assign (
  mo_number   text primary key,
  machine     text not null default '',
  updated_at  timestamptz not null default now()
);

-- 允許應用程式讀寫（openapi / anon key 需要 RLS 設定）
alter table public.argoerp_mo_machine_assign enable row level security;

-- 開放 service_role 完整存取（API 透過 service key 存取）
create policy if not exists "service_role full access"
  on public.argoerp_mo_machine_assign
  for all
  to service_role
  using (true)
  with check (true);

create index if not exists argoerp_mo_machine_assign_machine_idx
  on public.argoerp_mo_machine_assign (machine)
  where machine <> '';
