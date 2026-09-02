-- ============================================================================
-- 示意圖索引：NAS「ro排單圖庫」→ 訂單號 對照表
--
-- 背景：示意圖放在內網 NAS（\\192.168.1.141\ro排單圖庫\RO\），EIP 部署在
--   Vercel 摸不到內網。由公司內常開機的排程掃描器（tools/print_index_scanner.py）
--   掃資料夾寫入本表；EIP 只查表顯示「這張單有幾個檔、路徑在哪」。
--   設計圖本體不出內網（Snow 2026-08-31 拍板）：雲端只有「路徑與檔名」，沒有圖。
--
-- 對應規則（實地確認）：訂單資料夾一律以訂單號開頭；示意圖檔名一律
--   【商品示意圖】訂單號[_後綴].png/jpg/pdf。品項層結構不一，只做訂單層級。
-- ============================================================================

create table if not exists public.print_asset_index (
  id          bigserial primary key,
  so_no       text not null,                 -- 訂單號（SO/SOA/SOB/RO，取自資料夾名開頭）
  rel_path    text not null,                 -- 相對 ro排單圖庫 根目錄的路徑（含檔名）
  file_name   text not null,
  ext         text,                          -- png/jpg/pdf/eps/ai…（小寫、無點）
  is_preview  boolean not null default false,-- 檔名為【商品示意圖】且 png/jpg/pdf（日後橋接預覽用）
  size_bytes  bigint,
  file_mtime  timestamptz,
  scanned_at  timestamptz not null default now(),
  unique (so_no, rel_path)
);

create index if not exists idx_print_asset_index_so on public.print_asset_index (so_no);

-- 前端唯讀；寫入走 service role（掃描器）
alter table public.print_asset_index enable row level security;

drop policy if exists print_asset_index_read on public.print_asset_index;
create policy print_asset_index_read on public.print_asset_index
  for select to authenticated using (true);
