-- =============================================================================
-- 20260609_security_rls_hardening.sql
-- EIP / bardshop-factory-os — RLS 權限收斂（對應 SECURITY_AUDIT.md：SEC-05 / SEC-02 / SEC-13）
-- =============================================================================
-- ⚠️ 必讀前提
-- 目前「瀏覽器端」是用『公開的 anon key』直接讀寫資料庫：
--   * lib/supabaseClient.js 只有 createClient(url, ANON_KEY)
--   * 登入只在伺服器端完成（/api/auth/login），瀏覽器並未建立 Supabase session
--   => 前端所有 supabase.from(...) 都以 `anon` 身分執行。
--
-- 因此：把某張表的 anon 存取收掉，凡是「瀏覽器直接存取該表」的頁面都會壞掉，
--       除非該頁面的資料存取先改走後端 API（service_role）或前端改為真正登入(authenticated)。
--
-- 本檔分三個 TIER：
--   TIER 1（本檔預設會執行）：僅鎖定『前端完全不碰、只有後端 service_role 存取』的表。
--                              已逐表用 grep 驗證 client-hits=0 → 套用後不會破壞前端。
--   TIER 2 / TIER 3（預設為「註解」，不會執行）：會破壞現有前端，
--                              需先把對應頁面的資料存取改走後端，才可解除註解套用。
--
-- 註：Supabase 的 `service_role` 會「繞過 RLS」，故「鎖定」= 啟用 RLS 且不給 anon/authenticated
--     任何 policy；後端 service_role 仍可正常讀寫。
-- 建議：先在 staging 專案套用，或與前端重構一起上線。套用前先備份。
-- =============================================================================


-- =============================================================================
-- TIER 1 — 安全可立即套用（前端零存取，已驗證 client-hits=0）
--   鎖定下列『server-only』表，移除 anon/public 全開存取：
--     sara_*（9 張，僅 lib/saraSync.ts 以 service_role 寫入）
--     argoerp_machines / argoerp_mo_print_log / argoerp_staging（僅對應 API，service_role）
--     mo_machines（孤兒表，全專案零引用；原本連 RLS 都沒開）
-- =============================================================================
do $$
declare
  t   text;
  pol record;
  tier1 text[] := array[
    'sara_workcenters','sara_jobs','sara_orders','sara_reports','sara_resources',
    'sara_resource_jobs','sara_resource_events','sara_lot_routes','sara_sync_logs',
    'argoerp_machines','argoerp_mo_print_log','argoerp_staging','mo_machines'
  ];
begin
  foreach t in array tier1 loop
    if to_regclass(format('public.%I', t)) is null then
      raise notice 'skip %, table not found', t;
      continue;
    end if;
    -- 確保 RLS 開啟
    execute format('alter table public.%I enable row level security', t);
    -- 移除該表所有既有 policy（清掉 using(true) 的全開存取）
    for pol in
      select policyname from pg_policies where schemaname = 'public' and tablename = t
    loop
      execute format('drop policy if exists %I on public.%I', pol.policyname, t);
    end loop;
    raise notice 'locked %% to service_role-only', t;
  end loop;
end $$;

-- 套用後驗證（預期：下列表 policy 數為 0，且 RLS = true）：
--   select c.relname, c.relrowsecurity, count(p.policyname) policies
--   from pg_class c
--   left join pg_policies p on p.schemaname='public' and p.tablename=c.relname
--   where c.relname = any(array['sara_orders','argoerp_staging','mo_machines'])
--   group by c.relname, c.relrowsecurity;


-- =============================================================================
-- TIER 2 — members 機密鎖定（⚠️ 高優先，但會破壞前端，預設「不執行」）
-- -----------------------------------------------------------------------------
-- members 目前被前端 anon 直接存取，鎖定後會破壞：
--   * app/apply-account/page.tsx        （公開註冊頁，anon insert）
--   * app/admin/team/page.tsx           （anon update/delete/select，含 password）
--   * app/page.tsx / app/tasks/page.tsx / app/info-board/* / app/argo-db/page.tsx
--     / context/FavoritesContext.tsx    （anon 讀取成員角色/權限/清單）
-- 解除註解前，請先把上述讀寫改走後端 API（service_role）或改為真正 authenticated session。
--
-- 另：members 仍存「明文 password」欄位（SEC-02）。後端登入是用 Supabase Auth
--     （signInWithPassword），此欄位多餘且危險，建議於前端/後端不再讀寫後移除。
-- -----------------------------------------------------------------------------
-- alter table public.members enable row level security;
-- do $$ declare pol record; begin
--   for pol in select policyname from pg_policies where schemaname='public' and tablename='members'
--   loop execute format('drop policy if exists %I on public.members', pol.policyname); end loop;
-- end $$;
-- -- （鎖定後僅 service_role 可存取 members）
--
-- -- 移除明文密碼欄位（確認前端/後端皆不再讀寫 members.password 後才執行）：
-- -- alter table public.members drop column if exists password;


-- =============================================================================
-- TIER 3 — 其餘 using(true) 全開表（⚠️ 前端 anon 直接讀寫，預設「不執行」）
-- -----------------------------------------------------------------------------
-- 下列表目前 policy 為 using(true)/with check(true) 且未限角色 => anon 全開讀寫。
-- 前端有直接 anon 存取，需先改走後端才可收斂。目標模型：
--   * 讀：to authenticated using (true)   （需前端為真正登入身分）
--   * 寫：不給 anon/authenticated policy，一律走後端 service_role
--
-- 受影響表（前端 anon 有直接存取，需配合前端重構；非完整清單）：
--   members, system_logs, app_settings, departments, daily_orders, temp_orders,
--   station_time_summary, bom, material_inventory_list, material_substitute_rules,
--   mm_bom_part_units, mm_bom_structure, mrp_excluded_materials, qa_anomaly_option_items,
--   schedule_anomaly_reports, schedule_inquiries, schedule_inquiry_salespersons,
--   order_anomaly_records, order_anomaly_options, info_board_posts, system_announcements,
--   production_notice_groups, tasks, task_messages, erp_customers, erp_so_lines,
--   erp_mo_lines, erp_pj_sync, daily_order_sheets, argoerp_mo_summary,
--   argoerp_material_prep_log, argoerp_mo_upload_log, argoerp_mo_machine_assign,
--   erp_material_issue_status, erp_material_prep_lines, legacy_inventory_receipts, ...
--
-- 單張表收斂範本（待前端改走後端後，逐表解除註解套用）：
-- -- alter table public.<table> enable row level security;
-- -- do $$ declare pol record; begin
-- --   for pol in select policyname from pg_policies where schemaname='public' and tablename='<table>'
-- --   loop execute format('drop policy if exists %I on public.<table>', pol.policyname); end loop;
-- -- end $$;
-- -- create policy "<table>_read_authenticated" on public.<table>
-- --   for select to authenticated using (true);
-- -- 寫入不開放 anon/authenticated → 由後端 service_role 處理。
-- =============================================================================
