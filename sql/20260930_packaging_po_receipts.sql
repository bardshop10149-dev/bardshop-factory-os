-- ============================================================================
-- 2026-09-30  包裝專區：回廠卡片顯示入庫日期（D111）
--
-- ⚠ 套用前請先在 Supabase 後台手動備份（Dashboard → Database → Backups，或匯出重要資料表）。
--   本專案 Supabase 是正式站、沒有自動備份。本檔由 Snow 備份後在 SQL Editor 手動貼上執行一次。
-- ⚠ 前提與順序：
--   1. 已依序套用 sql/20260927_packaging_schedule.sql → sql/20260927b_packaging_p1_extend.sql
--      → sql/20260928_packaging_sales_and_order.sql（本檔不依賴它們的表，只是維持同一條套用順序）。
--   2. 上線順序：**先套用本檔 → 部署新程式 → 手動觸發一次全量同步**
--      （登入 packaging_admin 後開 /api/packaging/receipts-sync?mode=full，或帶 Bearer CRON_SECRET 呼叫）。
--      全量同步跑完前，卡片不顯示入庫日期、頁尾註腳會寫「入庫日期同步尚未完整成功跑過一次」。
--
-- 設計理由與規則：docs/design/2026-09-27-packaging-lines.md「D111 入庫日期」一節。
--
-- 內容（全部包在一個交易裡：任何一段失敗整份不生效）
--   1. erp_po_receipts       新表：ARGO 採購入庫明細（IV_INVENTORYIODETAIL，IO_TYPE='I'、IO_ACTION='BUY'）
--                             依「採購單號＋採購行號＋入庫日」彙總的鏡像（D111）。
--                             由 /api/packaging/receipts-sync 以「整張採購單重算覆蓋」寫入。
--   2. erp_po_receipts_sync  新表（單列 id = 1）：入庫同步的狀態（最後增量／全量／成功時間、錯誤、寫入筆數）
--   3. RLS：2 張新表只給 service_role（revoke anon / authenticated）
--
-- 不做：**不修改任何既有表、既有欄位與既有資料**；不建函式、觸發器；不刪任何資料。
--
-- 相容性
--   - 新程式在本檔套用「前」也能跑：讀不到 erp_po_receipts 時待排池照舊出卡（卡片沒有入庫日期、
--     頁尾註腳標「入庫日期同步尚未啟用」）；/api/packaging/receipts-sync 非 dry 模式回 409 migration_required。
--   - 舊程式（含 Snow 的穩定測試站）不認得這兩張表，完全不受影響。
--
-- 冪等：create ... if not exists、drop policy if exists 後再建、種子列 on conflict do nothing；
--       重跑不會壞也不會改資料。
--
-- 還原（若要整份退回）：先確認新程式已下線（或接受「卡片不再顯示入庫日期」），再
--   drop table public.erp_po_receipts, public.erp_po_receipts_sync;
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. erp_po_receipts：ARGO 採購入庫依「採購單號＋採購行號＋入庫日」彙總（D111）
-- ----------------------------------------------------------------------------
-- 為什麼鍵是「採購單＋行＋日」：待排池卡片的來源本來就記了（採購單號, 行號），用它對最精準；
--   同一採購行可能分好幾天回廠（分批入庫），Snow 要在卡片上逐批看到「幾號入多少」→ 一天一列。
--   同一採購行同一天有多張入庫單 → 同日數量加總成一列（slip_count 記張數）。
-- 為什麼整張採購單重算覆蓋：作廢的入庫單在 ARGO 會整筆消失，增量累加會永遠多算；每次同步把「這張採購單在 ARGO
--   的全部入庫」重新彙總後覆蓋，並刪掉 ARGO 已不存在的（行, 日）列，作廢後數字才會對。
-- po_doc_no：ARGO PDL_PJT_PROJECT_ID（一律大寫）。po_line_no：ARGO PJD_LINE_NO（文字，'3.0' 會存成 '3'）。
-- source_so：ARGO ISM_MBP_LOT_NO（來源 SO／RO；可空，備查用，卡片比對不靠它）。
-- qty：Σ QTY；只存 > 0 的列。receipt_date：ARGO IO_DATE 的日期部分（當地日期）。

create table if not exists public.erp_po_receipts (
  po_doc_no text not null
    check (char_length(po_doc_no) between 1 and 40),
  po_line_no text not null
    check (char_length(po_line_no) between 1 and 20),
  item_code text
    check (item_code is null or char_length(item_code) <= 80),
  source_so text
    check (source_so is null or char_length(source_so) <= 40),
  receipt_date date not null,
  qty numeric(14,3) not null default 0
    check (qty >= 0),
  slip_count integer not null default 0
    check (slip_count >= 0),
  synced_at timestamptz not null default now(),
  primary key (po_doc_no, po_line_no, receipt_date)
);

comment on table public.erp_po_receipts is
  'D111：ARGO 採購入庫（IV_INVENTORYIODETAIL IO_TYPE=I、IO_ACTION=BUY）依採購單號＋行號＋入庫日彙總的鏡像；以整張採購單重算覆蓋（作廢後數字才正確）';

-- 依採購單號查（同步時讀這批採購單的既有列；主鍵的前綴也能用，另建單欄索引讓 in (...) 查詢計畫更穩定）
create index if not exists erp_po_receipts_doc_idx
  on public.erp_po_receipts (po_doc_no);

-- 增量同步「近 N 天有入庫的鏡像採購單」也要重算（抓近期作廢）：依 receipt_date 找
create index if not exists erp_po_receipts_date_idx
  on public.erp_po_receipts (receipt_date);


-- ----------------------------------------------------------------------------
-- 2. erp_po_receipts_sync：入庫同步狀態（單列 id = 1；比照 erp_so_sales_sync）
-- ----------------------------------------------------------------------------
-- 工作台與待排池頁顯示「入庫資料更新於 xx:xx」（last_ok_at）；last_error 只存中文摘要（不含金鑰與 ARGO 原始回應）。

create table if not exists public.erp_po_receipts_sync (
  id smallint primary key default 1
    check (id = 1),
  last_incremental_at timestamptz,
  last_full_at timestamptz,
  last_ok_at timestamptz,
  last_error text
    check (last_error is null or char_length(last_error) <= 500),
  rows_upserted integer
    check (rows_upserted is null or rows_upserted >= 0),
  updated_at timestamptz not null default now()
);

insert into public.erp_po_receipts_sync (id) values (1)
on conflict (id) do nothing;


-- ----------------------------------------------------------------------------
-- 3. RLS：service_role only（比照 20260928_packaging_sales_and_order.sql 第 4 段）
--    anon / authenticated 沒有任何 policy → 全部拒絕；另外收回表權限，雙重保險。
-- ----------------------------------------------------------------------------

alter table public.erp_po_receipts enable row level security;
drop policy if exists "service_role full access" on public.erp_po_receipts;
create policy "service_role full access" on public.erp_po_receipts
  for all to service_role using (true) with check (true);
revoke all on table public.erp_po_receipts from anon, authenticated;

alter table public.erp_po_receipts_sync enable row level security;
drop policy if exists "service_role full access" on public.erp_po_receipts_sync;
create policy "service_role full access" on public.erp_po_receipts_sync
  for all to service_role using (true) with check (true);
revoke all on table public.erp_po_receipts_sync from anon, authenticated;

commit;


-- ----------------------------------------------------------------------------
-- 4. 套用後自我檢查（唯讀，可單獨執行）
-- ----------------------------------------------------------------------------
-- (a) 兩張新表都開了 RLS（relrowsecurity = true）：
-- select relname, relrowsecurity from pg_class
--  where relkind = 'r' and relnamespace = 'public'::regnamespace and relname in ('erp_po_receipts', 'erp_po_receipts_sync');
-- (b) 狀態列：預期 1 列、id = 1、其他欄 null：
-- select * from public.erp_po_receipts_sync;
-- (c) anon / authenticated 沒有表權限（預期 0 列）：
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_name in ('erp_po_receipts', 'erp_po_receipts_sync') and grantee in ('anon', 'authenticated');
-- (d) 第一次全量同步後（手動觸發 /api/packaging/receipts-sync?mode=full）：
--     2026-09-30 dry-run 實測約 2,900 列、780 張採購單；已知基準 PO260824013 第 2 行於 2026-09-09 入庫 5。
-- select count(*) as rows, count(distinct po_doc_no) as docs, max(synced_at) from public.erp_po_receipts;
-- select * from public.erp_po_receipts where po_doc_no = 'PO260824013' and po_line_no = '2';
