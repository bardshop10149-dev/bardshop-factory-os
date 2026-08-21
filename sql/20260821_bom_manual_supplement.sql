-- 2026-08-21  BOM 人工補登表（獨立於 ARGO 同步的 mm_bom_structure）
--
-- 背景：mm_bom_structure 是 sync_bom_structure 排程從 ARGO 全量同步過來的（每次先
-- delete 全部再重寫），如果直接把「工序/BOM補登表」新增的 BOM 資料寫進這張表，
-- 撐不過下一次同步（最長 6 小時）就會被清空，因為那筆資料在 ARGO 裡並不存在。
--
-- 在 ARGO 那邊確認有 BOM 匯入介面、可以真正回寫之前，先用這張獨立的表記錄人工
-- 補登的 BOM，不會被 ARGO 同步覆蓋。批備料頁面查 BOM 時，這張表也會一併讀取、
-- 跟 mm_bom_structure 合併比對（ARGO 同步的資料優先，這張表只補 ARGO 沒有的部分）。
--
-- 全檔可重複執行（idempotent）。

create table if not exists public.bom_manual_supplement (
  id bigserial primary key,
  parent_part text not null,
  child_part text not null,
  child_qty numeric not null default 0,
  note text,
  created_by text,
  created_by_email text,
  created_at timestamptz not null default now()
);

create index if not exists bom_manual_supplement_parent_idx
  on public.bom_manual_supplement (parent_part);

alter table public.bom_manual_supplement disable row level security;
