-- ============================================================================
-- 品項編碼申請 —— 異動軌跡（Snow 2026-09-16 要求）
--
-- 為什麼要獨立一張表，而不是在申請單上多幾個欄位：申請單只留得住「現在長什麼樣」
-- （誰處理的、現在什麼狀態），留不住「中間改過什麼」。一張單可能被退回、補件、
-- 再送出好幾輪，這些過程在申請單上會被一路覆蓋掉。真正要追責或回溯「當初是誰把
-- 會計科目改成這個」時，需要的正是被覆蓋掉的那些。
--
-- 申請單本身也不再刪除——狀態走到 created / rejected 就是終點，資料留著可查。
-- ============================================================================

create table if not exists public.item_code_request_logs (
  id            bigserial primary key,
  request_id    bigint       not null references public.item_code_requests(id) on delete cascade,
  request_no    text         not null,              -- 冗餘存一份：申請單若被刪，log 仍看得出是哪張單
  action        text         not null,              -- submitted 送出 | created 完成建檔 | rejected 退回 | reopen 救回 | updated 修改
  actor_email   text         not null,
  actor_name    text,
  changes       jsonb,                              -- { 欄位: { before, after } }；送出時記完整內容
  note          text,                               -- 退回原因、建立的編碼等，一眼看得懂的摘要
  created_at    timestamptz  not null default now()
);

create index if not exists idx_item_code_request_logs_request
  on public.item_code_request_logs (request_id, created_at desc);

-- 比照 item_code_requests：只開 service_role，一切存取走後端 API
alter table public.item_code_request_logs enable row level security;
drop policy if exists "service_role full access" on public.item_code_request_logs;
create policy "service_role full access" on public.item_code_request_logs
  for all to service_role using (true) with check (true);

comment on table public.item_code_request_logs is
  '品項編碼申請的異動軌跡；每次送出/建檔/退回/救回各留一筆，不覆蓋、不刪除';
