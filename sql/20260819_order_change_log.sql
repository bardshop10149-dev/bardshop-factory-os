-- 2026-08-19  改單專區審計紀錄表
--
-- 背景：發單作業區新增「改單專區」引導式改單精靈（輸入銷售單號 → 選序號 →
--   顯示所有相關單據 → 多選改單類型：日期/數量/品項編碼/生產廠區 → 套用更正）。
--   既有的 so_change_notices 是 ARGO 端自動偵測改單用的（沒有「誰改的」欄位，
--   只有誰確認），這裡的改單是人工發動，所以另建一張表、沿用同樣的
--   old_values/new_values jsonb 快照形狀，但補上 changed_by 相關欄位。
--
-- 全檔可重複執行（idempotent）。

create table if not exists public.order_change_log (
  id bigserial primary key,
  order_number text not null,
  line_no text not null,
  changed_fields text[] not null,
  old_values jsonb not null,
  new_values jsonb not null,
  affected_sheet_dates text[] not null,
  factory_changed boolean not null default false,
  redocumented boolean not null default false,
  sara_synced boolean not null default false,
  changed_by text,
  changed_by_email text,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists order_change_log_order_idx
  on public.order_change_log (order_number, line_no);

alter table public.order_change_log disable row level security;
