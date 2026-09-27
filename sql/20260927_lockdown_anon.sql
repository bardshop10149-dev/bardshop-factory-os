-- ============================================================================
-- 資安修復：把公開 anon key 對生產資料表的存取全部鎖掉
-- 日期：2026-09-27
--
-- 背景：
--   NEXT_PUBLIC_SUPABASE_ANON_KEY 隨 JS bundle 送到每個瀏覽器，等於公開金鑰。
--   2026-09-27 唯讀盤點（只數筆數）證實不登入即可用它整表讀取：
--     erp_pj_sync 24,945 列（含採購價格／付款／廠商）、erp_so_lines 8,541 列（客戶
--     送貨地址＋單價）、members 32 列（email）、legacy_inventory_receipts 71,698 列
--     （成本）、sara_reports 33,976、sara_wip_records 44,918、erp_mo_lines 48,972 …
--   另有十幾張表在 sql/ 明寫 DISABLE ROW LEVEL SECURITY，代表 anon 不只能讀，
--   還能 INSERT / UPDATE / DELETE。
--
-- 做法（每張表三件事，全部 idempotent，重跑無害）：
--   1. ENABLE ROW LEVEL SECURITY
--   2. 刪掉所有套用到 anon / authenticated / public 的 policy（只留 service_role 的）
--      → RLS 開著又沒有 policy = anon / authenticated 讀寫一律拒絕
--   3. REVOKE ALL ... FROM anon, authenticated
--      → 雙保險：就算日後有人誤建寬鬆 policy，沒有 table privilege 一樣進不來
--   service_role 有 BYPASSRLS 且保有自己的 grant，後端 API 完全不受影響。
--
-- ⚠️⚠️ 部署順序（跟 20260814_members_rls_lockdown.sql 同一個坑）⚠️⚠️
--   第 2 段的表，前端已改成走 /api/db 代查（同批程式碼），但**必須先把程式部署到
--   production、確認頁面正常，再跑第 2 段**；反過來會讓舊版前端（仍用 anon 直讀）
--   在部署空窗期整站壞掉。
--   第 1 段的表本來就只有後端 API（service role）在用，任何時候跑都安全。
--
-- ⚠️ Supabase 是 production 且沒有自動備份：跑之前先手動備份（Dashboard → Database →
--    Backups，或 pg_dump），並確認回滾 SQL（本檔最下方）看得懂。
-- ============================================================================

-- 共用程序：對一張表做「開 RLS、清 anon/authenticated policy、收回 privilege」。
-- 表不存在就略過（to_regclass 回 NULL），所以同一份 SQL 在缺表的環境也能跑。
create or replace function pg_temp.lockdown_anon(tbl text) returns void
language plpgsql as $$
declare
  pol record;
begin
  if to_regclass('public.' || quote_ident(tbl)) is null then
    raise notice '略過（表不存在）: %', tbl;
    return;
  end if;

  execute format('alter table public.%I enable row level security', tbl);

  for pol in
    select policyname, roles
    from pg_policies
    where schemaname = 'public'
      and tablename = tbl
      and roles && array['public', 'anon', 'authenticated']::name[]
  loop
    execute format('drop policy if exists %I on public.%I', pol.policyname, tbl);
    raise notice '已刪 policy %.% (roles=%)', tbl, pol.policyname, pol.roles;
  end loop;

  execute format('revoke all on table public.%I from anon, authenticated', tbl);
  raise notice '已鎖定: %', tbl;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 第 1 段：只有後端 API 在用的表（前端從未直讀，或早已改走 API）
--          → 任何時候跑都安全
-- ────────────────────────────────────────────────────────────────────────────
select pg_temp.lockdown_anon(t) from unnest(array[
  -- sql/ 裡明寫 DISABLE RLS、但已全部走 API 的表
  'order_anomaly_records',
  'order_anomaly_options',
  'schedule_inquiries',
  'schedule_inquiry_salespersons',
  'schedule_inquiry_notes',
  'order_change_log',
  'argoerp_daily_machine_output_snapshots',
  'argoerp_auto_doc_runs',
  'daily_order_sheet_history',
  'engineering_maintenance_records',
  'sara_anomaly_reports',
  -- 盤點時 anon 可讀、但前端沒有任何 .from() 直讀的表
  'sara_reports',
  'sara_orders',
  'sara_jobs',
  'sara_sync_logs',
  'sara_workcenters',
  'sara_resource_events',
  'sara_resource_jobs',
  'sara_lot_routes',
  'erp_sync_logs',
  'erp_change_log',
  'erp_material_issue_status',
  'erp_vendors',
  'design_daily_sheets',
  'item_code_requests',
  'item_code_request_logs',
  'po_line_tracking',
  'po_payment',
  'po_void_shipped_alerts',
  'changping_ship_marks',
  'quote_products',
  'quote_price_items',
  'quote_settings',
  'quote_golden_cases',
  'quote_calc_logs',
  'print_asset_index',
  'sara_lot_progress',
  'sara_wip_schedule',
  'members'            -- 20260814 已開 RLS，這裡補 REVOKE
]) as t;

-- ────────────────────────────────────────────────────────────────────────────
-- 第 2 段：前端「以前」用 anon 直讀／直寫、現在改走 /api/db 代查的表
--          → ⚠️ 先部署程式碼，確認頁面正常，再跑這一段
--          （名單 = lib/dbProxyAllowlist.ts 的全部 key）
-- ────────────────────────────────────────────────────────────────────────────
select pg_temp.lockdown_anon(t) from unnest(array[
  'erp_so_lines',
  'erp_pj_sync',
  'erp_mo_lines',
  'erp_customers',
  'erp_material_prep_lines',
  'legacy_inventory_receipts',
  'argoerp_mo_summary',
  'argoerp_mo_machine_assign',
  'argoerp_material_prep_log',
  'argoerp_mo_upload_log',
  'daily_order_sheets',
  'so_change_notices',
  'app_settings',
  'mm_bom_structure',
  'mm_bom_part_units',
  'bom_manual_supplement',
  'material_inventory_list',
  'material_substitute_rules',
  'item_routes',
  'route_operations',
  'operation_times',
  'sara_wip_records',
  'sara_resources',
  'sara_exchange',
  'sara_101_master',
  'production_machines',
  'production_notice_groups',
  'station_time_summary',
  'schedule_anomaly_reports',
  'qa_anomaly_option_items',
  'tasks',
  'task_messages',
  'info_board_posts',
  'system_announcements',
  'departments',
  'system_logs'
]) as t;

-- ────────────────────────────────────────────────────────────────────────────
-- 第 3 段：members.password 欄位
--   稽核（SEC-02）時這欄存過明文密碼；2026-09-27 盤點確認 32 列全部為空，登入早已
--   改由 Supabase Auth 驗證，程式碼也不再讀寫這欄（app/api/admin/members/* 的 password
--   都是送給 Auth 的參數）。直接刪掉，永絕後患。
-- ────────────────────────────────────────────────────────────────────────────
alter table public.members drop column if exists password;

-- ────────────────────────────────────────────────────────────────────────────
-- 第 4 段（建議，但可獨立決定）：整個 public schema 對 anon 關門
--   上面兩段只鎖「已知」的表；這段把「所有」現存的表、以及未來新建的表（透過
--   default privileges）都對 anon 收回，之後新表就算忘了設 RLS，anon 也進不來。
--   authenticated 這裡不動：EIP 前端沒有 Supabase session，authenticated 對它沒意義，
--   但保留彈性給日後可能的其他用途。
--   跑這段前請先確認沒有「其他系統」拿 anon key 直連這個專案（2026-09-27 掃過本機
--   所有專案：沒有；四台電腦的其他機器與 n8n 等外部服務請 Snow 確認）。
-- ────────────────────────────────────────────────────────────────────────────
-- revoke all on all tables in schema public from anon;
-- revoke all on all sequences in schema public from anon;
-- revoke usage on schema public from anon;
-- alter default privileges for role postgres in schema public revoke all on tables from anon;
-- alter default privileges for role postgres in schema public revoke all on sequences from anon;

-- ────────────────────────────────────────────────────────────────────────────
-- 驗證（跑完後）
--   1. node scripts/security/anon-probe.mjs   → 每張表 401/403 或筆數 0，exit code 0
--   2. 下面這句應該回傳 0 列（沒有任何 anon/authenticated 可用的 policy 殘留在上述表）：
--      select tablename, policyname, roles from pg_policies
--      where schemaname='public' and roles && array['public','anon','authenticated']::name[]
--      order by 1,2;
--   3. 下面這句應該回傳 0 列（anon 對上述表沒有任何 privilege）：
--      select table_name, privilege_type from information_schema.role_table_grants
--      where grantee='anon' and table_schema='public' order by 1,2;
--
-- 回滾（緊急用；只會恢復「可存取」，刪掉的 policy 不會自動長回來）
--   alter table public.<table> disable row level security;
--   grant all on table public.<table> to anon, authenticated;
--   members.password 刪掉後無法回復（本來就全空，無資料損失）。
-- ============================================================================
