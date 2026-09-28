-- ============================================================================
-- 2026-09-28  包裝專區：主管對 SO 品項行「結案」（D104；不再拉回待排池）
--
-- ⚠ 套用前請先在 Supabase 後台手動備份（Dashboard → Database → Backups，或匯出 packaging_placements／packaging_op_log）。
--   本專案 Supabase 是正式站、沒有自動備份。本檔由 Snow 備份後在 SQL Editor 手動貼上執行一次。
-- ⚠ 前提（依序已套用）：sql/20260927_packaging_schedule.sql → sql/20260927b_packaging_p1_extend.sql
--   → sql/20260928_packaging_sales_and_order.sql → sql/20260928b_packaging_ai.sql（→ 20260928c 可有可無）。
--   本檔新表不依賴其他表；只有第 2 段放寬 packaging_op_log.kind 需要 20260928b 已建好的 constraint 名稱。
--
-- 設計理由與規則：docs/design/2026-09-27-packaging-lines.md 第十四章（D104）。
--
-- 內容（全部包在一個交易裡：任何一段失敗整份不生效）
--   1. packaging_closures   新表：主管對「SO-項次」按結案的紀錄（誰、何時、單號-項次、備註、結案當下的卡片快照）。
--                            復原＝寫 restored_*（紀錄保留）；同一行同時只能有一筆「未復原」的紀錄（部分唯一索引）。
--   2. packaging_op_log.kind 放寬：保留既有 14 種，加 'closure'（結案／復原）
--   3. RLS：新表只給 service_role（revoke anon / authenticated，序列也收回）
--
-- 不做：不修改、不刪除任何既有表的資料或欄位；不建函式、觸發器、外鍵。
--   結案不寫 packaging_placements 的新欄：該行未完成的排定卡由 API 以「id＋version」條件刪除（同放回待排池），
--   模擬區（packaging_sim_sessions.placements jsonb）該行的卡由 API 以 version CAS 移除。
--
-- 相容性
--   - 新程式在本檔套用「前」也能跑：讀不到 packaging_closures 時待排池照舊（不排除任何結案行）；
--     只有「結案」「復原」「已結案清單」API 會明確回 migration_required、提示套用本檔。
--   - Snow 的穩定測試站（wt-packaging-stable，舊程式）不認得這張表 → 無影響（它的待排池不會排除結案行）。
--   - op_log 的 kind check 是「舊規則的超集合」→ 舊程式寫入照常。
--
-- 冪等：create table / index if not exists、drop constraint / policy if exists 後再建；重跑不會壞也不會改資料。
--
-- 還原（若要整份退回）：先確認新程式已下線（或接受「結案行會回到待排池」），再
--   drop table public.packaging_closures;
--   op_log 的 constraint 可保留（是舊規則的放寬版，對舊程式無害）。
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. packaging_closures：主管結案（D104；顆粒度＝SO 品項行，與 D66 手動加入相同）
-- ----------------------------------------------------------------------------
-- 為什麼是新表、不是在 erp_so_lines 加旗標：erp_so_lines 是 ARGO 鏡像（同步會整批覆蓋／刪除），包裝專區只寫 packaging_* 表（D4）。
-- 為什麼記「結案當下的快照」（品名、數量、交期、原區塊、已銷貨量）：結案後該行不再進待排池，之後畫面／通知信（D105，延後）
--   要顯示「當時結掉的是什麼」只能看這裡；ERP 資料之後可能改交期、結案、刪行。
-- 「永久不再拉回」（D104）：讀取時只看 restored_at is null 的列；不做自動回復，只有主管在「已結案清單」按復原。

create table if not exists public.packaging_closures (
  id bigserial primary key,
  -- `${SO}-${項次}`，一律大寫（同 packaging_placements.so_line_key／packaging_manual_inclusions.so_line_key）
  so_line_key text not null
    check (char_length(so_line_key) between 3 and 80),
  so text not null
    check (char_length(so) between 2 and 40),
  so_line text not null
    check (char_length(so_line) between 1 and 20),

  -- 結案當下的快照（來源：待排池卡片；不在池內時取 erp_so_lines）
  item_code text
    check (item_code is null or char_length(item_code) <= 80),
  item_name text
    check (item_name is null or char_length(item_name) <= 200),
  customer text
    check (customer is null or char_length(customer) <= 200),
  -- 結案當下待排池裡這一行的剩餘量（各卡 qtyCard 合計；不在池內＝ERP 訂單量）
  qty_at_close numeric(14,3) not null default 0
    check (qty_at_close >= 0),
  due_date date,
  -- 結案當下卡片所在區塊（PoolBlockId：'1'、'1b'、'2'、'3'、'4'、'4x'、'5a'、'5b'、'5c'、'ns'、'mn'）；不在池內＝null
  block_at_close text
    check (block_at_close is null or char_length(block_at_close) <= 8),
  -- D73 銷貨鏡像在結案當下分配到這一行的已銷貨量（D105 通知信「結案後 ARGO 仍未銷貨」對照用；鏡像未啟用＝null）
  sold_qty_at_close numeric(14,3)
    check (sold_qty_at_close is null or sold_qty_at_close >= 0),

  note text
    check (note is null or char_length(note) <= 200),
  closed_by text not null,
  closed_by_name text,
  closed_at timestamptz not null default now(),

  restored_at timestamptz,
  restored_by text,
  restored_by_name text,
  constraint packaging_closures_restored_by
    check ((restored_at is null) = (restored_by is null)),

  created_at timestamptz not null default now()
);

comment on table public.packaging_closures is
  'D104：主管對 SO 品項行「結案」的紀錄（結案後永久不進待排池，除非主管在已結案清單復原）。復原＝寫 restored_*，紀錄保留';
comment on column public.packaging_closures.qty_at_close is
  '結案當下待排池裡這一行的剩餘量（各卡合計）；不在池內時＝ERP 訂單量';
comment on column public.packaging_closures.sold_qty_at_close is
  'D73 銷貨鏡像在結案當下分配到本行的已銷貨量；null＝鏡像未啟用。D105 通知信對照「結案後仍未銷貨」用';

-- 同一個 SO 行同時只能有一筆「未復原」的結案（復原後可再結案）
create unique index if not exists packaging_closures_active_key
  on public.packaging_closures (so_line_key)
  where restored_at is null;
-- 已結案清單依結案時間倒序、日期區間查詢
create index if not exists packaging_closures_closed_at_idx
  on public.packaging_closures (closed_at desc);


-- ----------------------------------------------------------------------------
-- 2. packaging_op_log.kind：加 'closure'（結案／復原）
-- ----------------------------------------------------------------------------
-- 20260927 建表時是欄位上的匿名 check（Postgres 自動命名 packaging_op_log_kind_check），20260927b、20260928b 各放寬過一次。
-- 不放寬的話 insertOpLog 會「默默失敗」（失敗只 console.error、不擋回應），結案就沒有操作紀錄。

alter table public.packaging_op_log
  drop constraint if exists packaging_op_log_kind_check;
alter table public.packaging_op_log
  add constraint packaging_op_log_kind_check
  check (kind in (
    'placements', 'complete', 'capacity', 'version_create', 'version_restore', 'lock', 'lines', 'manual',
    'ai_sim', 'ai_run', 'ai_adopt', 'ai_revert', 'ai_rules', 'ai_threshold',
    'closure'
  ));


-- ----------------------------------------------------------------------------
-- 3. RLS：service_role only（比照 20260927b 第 8 段、20260928 第 4 段）
--    anon / authenticated 沒有任何 policy → 全部拒絕；另外收回表與序列權限，雙重保險。
-- ----------------------------------------------------------------------------

alter table public.packaging_closures enable row level security;
drop policy if exists "service_role full access" on public.packaging_closures;
create policy "service_role full access" on public.packaging_closures
  for all to service_role using (true) with check (true);
revoke all on table public.packaging_closures from anon, authenticated;
revoke all on sequence public.packaging_closures_id_seq from anon, authenticated;

commit;


-- ----------------------------------------------------------------------------
-- 4. 套用後自我檢查（唯讀，可單獨執行）
-- ----------------------------------------------------------------------------
-- (a) 新表開了 RLS（relrowsecurity = true）：
-- select relname, relrowsecurity from pg_class
--  where relkind = 'r' and relnamespace = 'public'::regnamespace and relname = 'packaging_closures';
-- (b) anon / authenticated 沒有表權限（預期 0 列）：
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_name = 'packaging_closures' and grantee in ('anon', 'authenticated');
-- (c) op_log 的 kind check 已含 'closure'：
-- select pg_get_constraintdef(oid) from pg_constraint
--  where conrelid = 'public.packaging_op_log'::regclass and conname = 'packaging_op_log_kind_check';
-- (d) 部分唯一索引存在：
-- select indexname, indexdef from pg_indexes where tablename = 'packaging_closures';
