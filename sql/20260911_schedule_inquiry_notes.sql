-- 產期詢問單「備註事項」：送出後才能補充的追加備註（只能新增，不能改寫）
--
-- 背景（2026-09-11 需求）：業務端送出詢問單後不開放編輯既有欄位（只有訂單編號
-- 允許後補），但實務上常有後續補充——客戶改口、追加說明、臨時交代。
-- 因此開放一個「新增備註事項」的功能讓業務手動補字，生管後台也要看得到同一份紀錄。
--
-- 為什麼另開一張表，而不是在 schedule_inquiries 上加 jsonb 陣列：
--   * 新增備註是單純的 insert，天生沒有「讀出來 → append → 寫回去」的併發覆蓋問題
--   * 每則備註各自帶作者與時間，事後追溯看得出誰在什麼時候補了什麼
--   * 原本的 remark 欄位維持不動——那是送出當下填的原始備註，兩者語意不同
--
-- 刻意不做備註的編輯與刪除：比照軟刪除（20260904）的精神，補充紀錄寫下去就留著，
-- 才有追溯價值；要更正就再補一則。
--
-- inquiry_id 用 integer：schedule_inquiries.id 是 int4，型別要對齊才建得起外鍵。

create table if not exists public.schedule_inquiry_notes (
  id           bigserial primary key,
  inquiry_id   integer not null references public.schedule_inquiries(id) on delete cascade,
  note         text not null,
  author_email text,
  author_name  text,
  created_at   timestamptz not null default now()
);

create index if not exists schedule_inquiry_notes_inquiry_idx
  on public.schedule_inquiry_notes (inquiry_id, created_at);

-- RLS 比照 schedule_inquiries：不啟用，改由 API 層的 guardAuth() 保護
-- （見 sql/20260813_production_notice_api_lockdown.sql 的說明與前提）。
-- 一樣的前提：這張表只能經由 /api/production/schedule-confirm/notes 存取，
-- 不要在瀏覽器端用 anon key 直接讀寫。
alter table public.schedule_inquiry_notes disable row level security;
