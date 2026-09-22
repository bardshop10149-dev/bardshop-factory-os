-- ============================================================================
-- 品項編碼申請 —— 主管審查（Phase 1）
--
-- 在「待建檔 → 已建檔」之間插入「已核准」：主管審過、編碼也定了，但 ARGO 還沒建。
--
-- 為什麼要獨立一個狀態，而不是核准完直接標 created：審查與建檔是兩件事，
-- 而且會分別失敗。Phase 1 建檔還是人工，主管核准後可能隔一天才有人去 ARGO 建；
-- Phase 2 接上自動寫入後，寫入也可能被 ARGO 檢核擋下——那時錯的是寫入不是判斷，
-- 這張單該停在「已核准但沒建成」，而不是退回重審。
-- ============================================================================

alter table public.item_code_requests
  add column if not exists approved_by         text,        -- 核准主管 email
  add column if not exists approved_by_name    text,        -- 核准當下的姓名（人員異動後仍看得出是誰）
  add column if not exists approved_by_emp_no  text,        -- 核准主管工號 → Phase 2 寫入 ARGO 的 ACCOUNT_USER
  add column if not exists approved_at         timestamptz,
  add column if not exists approved_part       text;        -- 主管定案的品項編碼（申請人填的 suggested_part 只是建議）

comment on column public.item_code_requests.approved_by_emp_no is
  'ARGO IFAF007 的 ACCOUNT_USER（審核人員工號）；取自 members.employee_no，不再共用 10011';
comment on column public.item_code_requests.approved_part is
  '主管核准時定案的編碼；Phase 2 寫入 ARGO 用這個，寫入成功後才會填 assigned_part';

-- status 既有值：pending 待建檔 / created 已建檔 / rejected 退回
-- 新增：approved 已核准待建檔。欄位是 text 沒有 check 約束，不需改型別，
-- 但仍留一筆註解說明合法值，免得日後看資料的人以為只有三種。
comment on column public.item_code_requests.status is
  'pending 待審 | approved 已核准待建檔 | created 已建檔 | rejected 退回';

create index if not exists idx_item_code_requests_status
  on public.item_code_requests (status, requested_at desc);
