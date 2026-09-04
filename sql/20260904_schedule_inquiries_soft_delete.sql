-- 產期詢問單改為「軟刪除」：業務端刪除後從自己的清單消失，但資料保留，
-- 生管端仍看得到（以紅色背景標示），避免業務刪掉後生管完全不知道曾經有這筆需求。
--
-- 2026-09-04 需求：開放業務端刪除權限，但生管端要留下紀錄可追溯。
alter table public.schedule_inquiries
  add column if not exists deleted_at      timestamptz,
  add column if not exists deleted_by      text,
  add column if not exists deleted_by_name text;

-- 生管端查詢會同時撈已刪除與未刪除，依 deleted_at 是否為 null 區分顯示
create index if not exists schedule_inquiries_deleted_at_idx
  on public.schedule_inquiries (deleted_at);
