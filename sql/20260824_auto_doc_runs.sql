-- 2026-08-24  出單表→委外請購/常平採購 自動轉單執行紀錄表
--
-- 背景：/api/cron/auto-doc-creation 每天 17:10（台北時間）自動把當天出單表的
-- 委外列轉請購單（IFAF105）、常平列轉採購單（IFAF024）。
--
-- 這張表同時是「防重複建單」的鎖：ARGO 匯入成功但出單表回寫失敗時（status 停在
-- 'imported'），該單據已真實存在於 ARGO，下一次自動執行若照常送出會建出重複單據。
-- 頁面手動操作時是靠畫面上的 pendingSync/stuckRows 記憶體狀態防呆，cron 沒有畫面，
-- 改用這張表持久化：每次執行前檢查有沒有 status='imported' 的未解決紀錄，有就直接
-- 中止並記錄，等人工確認（確認 ARGO 與出單表一致後，把該筆 status 改成 'resolved'）。
--
-- status 流轉：
--   started      → 已開始（尚未送 ARGO，中途失敗無害，不擋下次執行）
--   imported     → ARGO 已建單但出單表回寫「尚未完成」（危險狀態，擋住後續自動執行）
--   written_back → 完整成功（終態）
--   failed       → 送 ARGO 前就失敗，或 ARGO 整批拒絕（ARGO 無殘留，不擋下次執行）
--   skipped      → 當天無可轉資料
--   resolved     → 人工確認過的 imported 紀錄（解除封鎖）
--
-- 全檔可重複執行（idempotent）。

create table if not exists public.argoerp_auto_doc_runs (
  id bigserial primary key,
  run_type text not null,             -- 'pr'（委外請購）| 'po'（常平採購）
  sheet_date date not null,
  doc_no text,                        -- 取到的 MPO/POC 單號
  status text not null default 'started',
  detail jsonb,                       -- 逐列結果、錯誤、跳過清單等
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists argoerp_auto_doc_runs_type_status_idx
  on public.argoerp_auto_doc_runs (run_type, status);

alter table public.argoerp_auto_doc_runs disable row level security;
