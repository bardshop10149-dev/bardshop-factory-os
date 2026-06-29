-- 2026-06-27  增量同步 LOG 表（erp_sync_logs / erp_change_log）
-- 配合 ARGO→Supabase 同步從「整批覆蓋(delete+insert)」改為「增量比對更新(upsert 變動列 + 刪除消失列)」。
-- 純新增兩張表，不更動任何既有資料表；未執行此 migration 前，同步仍可正常運作（記 log 會被 try/catch 略過）。

-- ── 1. 每次同步一列：摘要 ────────────────────────────────
create table if not exists public.erp_sync_logs (
  id          bigserial   primary key,
  action      text        not null,                 -- sync_customer | sync_so | sync_mo | ...
  mode        text        not null default 'incremental',
  ok          boolean     not null,
  count       integer,                              -- 本次處理列數（失敗為 null，比照 sara_sync_logs）
  inserted    integer     not null default 0,
  updated     integer     not null default 0,
  deleted     integer     not null default 0,
  unchanged   integer     not null default 0,
  elapsed_ms  integer,
  message     text,
  payload     jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists erp_sync_logs_action_idx
  on public.erp_sync_logs (action, created_at desc);

comment on table public.erp_sync_logs is 'ARGO→Supabase 增量同步每次執行的摘要（每單別每次一列）';

-- ── 2. 每筆變動一列：明細（insert/update/delete） ─────────
create table if not exists public.erp_change_log (
  id             bigserial   primary key,
  run_id         bigint      references public.erp_sync_logs(id) on delete set null,
  action         text        not null,
  target_table   text        not null,              -- erp_customers | erp_so_lines | ...
  doc_no         text        not null,              -- 自然鍵主欄（partner_id / project_id / doc_no / slip_no / item_code）
  sub_no         text,                              -- 自然鍵次欄（line_no / sub_no），表頭級為 null
  change_type    text        not null,              -- insert | update | delete
  detected_via   text        not null default 'content',
  changed_fields text[],                            -- update 時實際變動的欄位名
  before         jsonb,                             -- insert 時為 null
  after          jsonb,                             -- delete 時為 null
  created_at     timestamptz not null default now()
);

create index if not exists erp_change_log_doc_idx     on public.erp_change_log (target_table, doc_no, sub_no);
create index if not exists erp_change_log_created_idx on public.erp_change_log (created_at desc);
create index if not exists erp_change_log_run_idx     on public.erp_change_log (run_id);

comment on table public.erp_change_log is 'ARGO→Supabase 增量同步的逐筆變動紀錄（新增/更新/刪除）';

-- ── 3. RLS：service-role（後端 admin client）繞過；前台 anon 不開放讀取（與 order_inspection 同模式） ──
alter table public.erp_sync_logs  enable row level security;
alter table public.erp_change_log enable row level security;
