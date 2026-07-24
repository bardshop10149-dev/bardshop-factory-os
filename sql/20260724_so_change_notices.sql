-- 銷售訂單改單通知：記錄每次 sync_so 中被修改的 SO 明細欄位，供業務人員確認
create table if not exists public.so_change_notices (
  id             uuid primary key default gen_random_uuid(),
  project_id     text not null,
  line_no        text not null,
  changed_fields text[] not null default '{}',
  old_values     jsonb not null default '{}',
  new_values     jsonb not null default '{}',
  detected_at    timestamptz not null default now(),
  confirmed_at   timestamptz,
  confirmed_by   text
);

create index if not exists so_change_notices_project_id_idx on public.so_change_notices(project_id);
create index if not exists so_change_notices_unconfirmed_idx on public.so_change_notices(detected_at desc) where confirmed_at is null;
