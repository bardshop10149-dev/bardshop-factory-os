-- =====================================================================
-- 20260714_po_line_note.sql
-- 採購專區：追蹤列表每行手打備註（po_line_tracking 加 note 欄）
-- 可重複執行；RLS 沿用 po_line_tracking 既有設定（service_role-only，
-- 讀寫皆經 /api/purchasing/* 後端）。
-- =====================================================================

alter table public.po_line_tracking
  add column if not exists note text;

comment on column public.po_line_tracking.note is '採購手打備註（追蹤列表逐行，上限 500 字由 API 端控管）';
