-- ============================================================================
-- 2026-09-28  包裝專區：待排池排除已銷貨（D73）＋線內上下排序（D74）
--
-- ⚠ 套用前請先在 Supabase 後台手動備份（Dashboard → Database → Backups，或匯出 packaging_placements）。
--   本專案 Supabase 是正式站、沒有自動備份。本檔由 Snow 備份後在 SQL Editor 手動貼上執行一次。
-- ⚠ 前提：已依序套用 sql/20260927_packaging_schedule.sql → sql/20260927b_packaging_p1_extend.sql
--   （本檔替 packaging_placements 加欄；新表 erp_so_sales／erp_so_sales_sync 不依賴其他表）。
--
-- 設計理由與規則：docs/design/2026-09-27-packaging-lines.md 第十三章（D73／D74）。
--
-- 內容（全部包在一個交易裡：任何一段失敗整份不生效）
--   1. erp_so_sales       新表：ARGO 銷貨明細（IV_INVENTORYIODETAIL，IO_TYPE='O'、IO_ACTION='SELL'）
--                          依「來源 SO＋品號」彙總的鏡像（D73）。由 /api/packaging/sales-sync 以「整張 SO 重算覆蓋」寫入。
--   2. erp_so_sales_sync  新表（單列 id = 1）：銷貨同步的狀態（最後增量／全量／成功時間、錯誤、寫入筆數）
--   3. packaging_placements 加欄：sort_index（D74 同一天同一條線內的上下順序；null＝沿用固定排序）
--   4. RLS：2 張新表只給 service_role（revoke anon / authenticated）
--
-- 不做：不改任何既有欄位與資料（sort_index 新欄一律 null，不回填）；不建函式、觸發器；不刪任何資料。
--
-- 相容性
--   - 新程式在本檔套用「前」也能跑：讀不到 erp_so_sales 時待排池照舊（不排除已銷貨、註腳標「銷貨同步尚未啟用」）；
--     placements 沒有 sort_index 時寫入自動略過該欄（新卡沿用固定排序），只有「調整線內順序」會提示先套用本檔。
--   - Snow 的穩定測試站（wt-packaging-stable，舊程式）不認得 sort_index：它新增的卡 sort_index＝null（排在該線最上面、
--     依固定排序），它移動卡片不會改 sort_index。不影響數量守恆。
--
-- 冪等：create ... if not exists、add column if not exists、drop policy if exists 後再建、種子列 on conflict do nothing；
--       重跑不會壞也不會改資料。
--
-- 還原（若要整份退回）：先確認新程式已下線（或接受「排序回到固定排序、不再排除已銷貨」），再
--   drop table public.erp_so_sales, public.erp_so_sales_sync;
--   alter table public.packaging_placements drop column sort_index;
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. erp_so_sales：ARGO 銷貨依「來源 SO＋品號」彙總（D73）
-- ----------------------------------------------------------------------------
-- 為什麼是「SO＋品號」不是「SO＋項次」：ARGO 銷貨明細（IV_INVENTORYIODETAIL）帶來源訂單（PDL_PJT_PROJECT_ID）與品號
--   （ISM_MBP_PART），同步以這兩欄彙總；同一張 SO 同品號多行時，待排池讀取時再「依項次由小到大」分配（lib/packaging/salesAlloc.ts）。
-- 為什麼整張 SO 重算覆蓋：ARGO 作廢銷貨單會連明細一起刪除，增量累加會永遠多算；每次同步把「這張 SO 在 ARGO 的全部銷貨」
--   重新彙總後覆蓋，並刪掉 ARGO 已不存在的（SO, 品號）列，作廢後數字才會對。
-- sold_qty：Σ QTY（QTY 為空時用 PRICE_QTY）；只存 > 0 的列。slip_count：不重複銷貨單號數。

create table if not exists public.erp_so_sales (
  so text not null
    check (char_length(so) between 1 and 40),
  item_code text not null
    check (char_length(item_code) between 1 and 80),
  sold_qty numeric(14,3) not null default 0
    check (sold_qty >= 0),
  last_sale_date date,
  slip_count integer not null default 0
    check (slip_count >= 0),
  synced_at timestamptz not null default now(),
  primary key (so, item_code)
);

comment on table public.erp_so_sales is
  'D73：ARGO 銷貨（IV_INVENTORYIODETAIL IO_TYPE=O、IO_ACTION=SELL）依來源 SO＋品號彙總的鏡像；以整張 SO 重算覆蓋（作廢後數字才正確）';

-- 增量同步「近 N 天有銷貨的鏡像 SO」也要重算（抓近期作廢）：依 last_sale_date 找
create index if not exists erp_so_sales_last_sale_idx
  on public.erp_so_sales (last_sale_date);


-- ----------------------------------------------------------------------------
-- 2. erp_so_sales_sync：銷貨同步狀態（單列 id = 1）
-- ----------------------------------------------------------------------------
-- 工作台與待排池頁顯示「銷貨資料更新於 xx:xx」（last_ok_at）；last_error 只存中文摘要（不含金鑰與 ARGO 原始回應）。

create table if not exists public.erp_so_sales_sync (
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

insert into public.erp_so_sales_sync (id) values (1)
on conflict (id) do nothing;


-- ----------------------------------------------------------------------------
-- 3. packaging_placements.sort_index：線內上下順序（D74）
-- ----------------------------------------------------------------------------
-- 同一天同一條線內：sort_index 為 null 的卡排在最上面、依固定排序（延誤→預排到期→打樣→交期→建立時間），
-- 其後是有 sort_index 的卡、由小到大（規則與理由見規格第十三章）。待排區（plan_date null）的卡沒有順序（程式寫 null）。
-- numeric(12,4)：主管上下拖曳時取前後兩張的中間值（最多 4 位小數，間距不夠時整條線重新編號 1、2、3…）；
-- 新排入（排進某條線、移到別條線或別天）的卡＝「2026-01-01 起的分鐘數」，一定比既有的大 → 放在該線最後。

alter table public.packaging_placements
  add column if not exists sort_index numeric(12,4);

comment on column public.packaging_placements.sort_index is
  'D74 線內上下順序（小的在上）；null＝排在該線最上面、依固定排序。只影響顯示順序，不影響數量守恆';


-- ----------------------------------------------------------------------------
-- 4. RLS：service_role only（比照 20260927b_packaging_p1_extend.sql 第 8 段）
--    anon / authenticated 沒有任何 policy → 全部拒絕；另外收回表權限，雙重保險。
-- ----------------------------------------------------------------------------

alter table public.erp_so_sales enable row level security;
drop policy if exists "service_role full access" on public.erp_so_sales;
create policy "service_role full access" on public.erp_so_sales
  for all to service_role using (true) with check (true);
revoke all on table public.erp_so_sales from anon, authenticated;

alter table public.erp_so_sales_sync enable row level security;
drop policy if exists "service_role full access" on public.erp_so_sales_sync;
create policy "service_role full access" on public.erp_so_sales_sync
  for all to service_role using (true) with check (true);
revoke all on table public.erp_so_sales_sync from anon, authenticated;

commit;


-- ----------------------------------------------------------------------------
-- 5. 套用後自我檢查（唯讀，可單獨執行）
-- ----------------------------------------------------------------------------
-- (a) 兩張新表都開了 RLS（relrowsecurity = true）：
-- select relname, relrowsecurity from pg_class
--  where relkind = 'r' and relnamespace = 'public'::regnamespace and relname in ('erp_so_sales', 'erp_so_sales_sync');
-- (b) 狀態列：預期 1 列、id = 1、其他欄 null：
-- select * from public.erp_so_sales_sync;
-- (c) anon / authenticated 沒有表權限（預期 0 列）：
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_name in ('erp_so_sales', 'erp_so_sales_sync') and grantee in ('anon', 'authenticated');
-- (d) sort_index 欄存在且全部是 null（套用當下；之後主管調整順序才會有值）：
-- select count(*) as total, count(sort_index) as with_sort from public.packaging_placements;
-- (e) 第一次同步後（手動觸發 /api/packaging/sales-sync?mode=full）：
-- select count(*) as rows, count(distinct so) as sos, max(synced_at) from public.erp_so_sales;
