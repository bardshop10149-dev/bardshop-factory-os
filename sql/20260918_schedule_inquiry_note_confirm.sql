-- 2026-09-18  產期詢問單：兩段式確認鎖定
--
-- 需求（業務詢問交期表）：
--   1. 生管未確認前 → 業務可以編輯整張詢問單
--   2. 生管確認後   → 詢問單內容不可編輯，但仍可補「備註事項」
--   3. 備註事項也要確認 → 確認前可編輯，確認後不可編輯
--
-- 第 1、2 點用既有的 schedule_inquiries.planner_reply 判斷即可（null = 未確認），
-- 不需要新欄位。第 3 點需要每則備註各自的確認狀態，因此加在 notes 上。
--
-- 這同時推翻了 20260911 當初「備註只能新增、不能改寫」的設計：
--   當時是為了追溯價值而刻意不做編輯，現在改成「確認前可改、確認後鎖死」——
--   確認這個動作本身就是追溯的錨點（誰在什麼時候認可了這段文字），
--   鎖定之後的內容一樣改不了，追溯性由確認機制承擔。
--
-- 全檔可重複執行（idempotent）。

alter table public.schedule_inquiry_notes
  add column if not exists confirmed_at      timestamptz,
  add column if not exists confirmed_by      text,
  add column if not exists confirmed_by_name text,
  -- 備註被編輯過的時間，供生管判斷「我確認前它是不是又被改過」
  add column if not exists updated_at        timestamptz;

-- 生管端最常問的是「哪些備註還沒確認」，直接建部分索引
create index if not exists schedule_inquiry_notes_unconfirmed_idx
  on public.schedule_inquiry_notes (inquiry_id, created_at)
  where confirmed_at is null;
