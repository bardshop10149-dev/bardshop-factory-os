-- ============================================================================
-- 2026-09-28(c)  包裝專區 D101：模擬區可調整產線時數，採用時一起匯入正式產能表
--
-- ⚠ 套用前請先在 Supabase 後台手動備份（Dashboard → Database → Backups，
--   或匯出 packaging_sim_sessions／packaging_ai_runs／packaging_ai_adoptions）。
--   本專案 Supabase 是正式站、沒有自動備份。本檔由 Snow 備份後在 SQL Editor 手動貼上執行一次。
-- ⚠ 前提：已依序套用 20260927_packaging_schedule → 20260927b_packaging_p1_extend
--   → 20260928_packaging_sales_and_order → 20260928b_packaging_ai（本檔只在 20260928b 的三張表加欄位）。
--
-- 設計理由：需求決策紀錄 D101；實作 lib/packaging/ai/simCapacity.ts、capacityAdopt.ts 檔頭。
--
-- 內容（全部包在一個交易裡：任何一段失敗整份不生效）
--   1. packaging_sim_sessions.sim_capacity     jsonb not null default 空覆寫：模擬區的產線時數覆寫（只作用在模擬）
--   2. packaging_ai_runs.sim_capacity          jsonb null：這次 AI 執行當下的模擬覆寫（載入歷史、稽核）
--   3. packaging_ai_adoptions.capacity_changes jsonb null：這次採用寫進正式產能表的每一格採用前／後（範圍內退回用）
--   4. 三個 check（型別＋大小防線），RLS 與權限重申
--
-- 不做：不改任何既有欄位與資料；不動 packaging_line_capacity／packaging_daily_capacity 的結構
--   （採用寫進去的是一般產能列，與產能表手動儲存同形、同一套驗證與寫入順序）；
--   op_log 的 kind 不必放寬（模擬區編輯記 'ai_sim'、採用／退回寫正式產能記 'capacity'，都已允許）。
--
-- 相容性（Snow 的穩定站 wt-packaging-stable 仍是舊程式、連同一個正式站資料庫）
--   - 舊程式 select('*') 讀模擬區會多一欄、忽略；舊程式更新模擬區只寫它認得的欄 → sim_capacity 原樣保留；新建列取預設（空覆寫）。
--   - 舊程式建 run／採用列不帶新欄 → null＝「沒有模擬產能」（新程式照此解讀：載入歷史不動產能、退回只退排程）。
--   - 新程式在本檔套用前也能跑：只有「修改模擬產能」會回 migration_required（新欄只在有值／有變時才寫）。
--   - 過渡期限制：用新程式（3710）設了模擬時數，就不要在舊程式（3711）按 AI／採用／退回（舊程式不認得模擬時數）；
--     驗證通過就把 3711 切到新 commit。
--
-- 冪等：add column if not exists；constraint 先 drop if exists 再建；重跑不會壞。
--
-- 還原（整份退回）：先確認新程式已下線，再
--   alter table public.packaging_sim_sessions drop column if exists sim_capacity;
--   alter table public.packaging_ai_runs      drop column if exists sim_capacity;
--   alter table public.packaging_ai_adoptions drop column if exists capacity_changes;
--   ⚠ drop capacity_changes 之後，已採用的產能無法再從「AI 採用紀錄」退回（正式產能列本身不受影響，要改請到產能表）。
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. packaging_sim_sessions.sim_capacity：模擬區的產線時數覆寫
-- ----------------------------------------------------------------------------
-- 內容（camelCase）：{ v: 1, cells: [{ date, lineId, regularHours, overtimeHoursMax, base: {regularHours, overtimeHoursMax}, at }],
--                     weekendsOpened: [date] }
-- 語意：正式產能表「已設定列」的草稿——疊在正式各線列上再算有效值（D49 沿用照樣作用）；只作用在模擬區（負荷條、AI、驗算）。
-- 為什麼放在模擬區同一列、而不是另開一張表：它必須和擺放一起受 version CAS 保護、一起進「退回上一步」的整份快照。
-- 大小：6 個工作日約 10 個日期 × 最多 12 條線 ≈ 120 格 × 約 200 bytes，遠低於上限。

alter table public.packaging_sim_sessions
  add column if not exists sim_capacity jsonb not null
  default '{"v":1,"cells":[],"weekendsOpened":[]}'::jsonb;

alter table public.packaging_sim_sessions
  drop constraint if exists packaging_sim_sessions_sim_capacity_check;
alter table public.packaging_sim_sessions
  add constraint packaging_sim_sessions_sim_capacity_check
  check (jsonb_typeof(sim_capacity) = 'object' and octet_length(sim_capacity::text) < 200000);

comment on column public.packaging_sim_sessions.sim_capacity is
  'D101 模擬區產線時數覆寫（正式產能表已設定列的草稿，只作用在模擬；採用時一起寫進正式產能表）';


-- ----------------------------------------------------------------------------
-- 2. packaging_ai_runs.sim_capacity：這次 AI 執行當下的模擬覆寫
-- ----------------------------------------------------------------------------
-- null＝建 run 時沒有模擬覆寫，或 run 由舊程式建立。載入歷史結果時一併載回（null → 不動目前產能）。

alter table public.packaging_ai_runs
  add column if not exists sim_capacity jsonb;

alter table public.packaging_ai_runs
  drop constraint if exists packaging_ai_runs_sim_capacity_check;
alter table public.packaging_ai_runs
  add constraint packaging_ai_runs_sim_capacity_check
  check (sim_capacity is null
         or (jsonb_typeof(sim_capacity) = 'object' and octet_length(sim_capacity::text) < 200000));

comment on column public.packaging_ai_runs.sim_capacity is
  'D101 這次 AI 執行當下的模擬產線時數覆寫（null＝沒有覆寫或舊程式建立）';


-- ----------------------------------------------------------------------------
-- 3. packaging_ai_adoptions.capacity_changes：採用寫進正式產能表的每一格（採用前／後）
-- ----------------------------------------------------------------------------
-- 內容：{ v: 1, cells: [{ date, lineId, kind: 'sim'|'anchor', before: {regularHours, overtimeHoursMax, note}|null,
--                          after: {regularHours, overtimeHoursMax} }], weekends: [{ date, beforeOpen, afterOpen }] }
-- anchor＝模擬範圍後第一個工作日的「保值列」（避免範圍外沒填的日子沿用值跟著變，D87）。
-- null＝這次採用沒有改產能，或採用由舊程式執行。退回結果（產能部分）寫進既有的 revert_report，不另開欄。

alter table public.packaging_ai_adoptions
  add column if not exists capacity_changes jsonb;

alter table public.packaging_ai_adoptions
  drop constraint if exists packaging_ai_adoptions_capacity_changes_check;
alter table public.packaging_ai_adoptions
  add constraint packaging_ai_adoptions_capacity_changes_check
  check (capacity_changes is null
         or (jsonb_typeof(capacity_changes) = 'object' and octet_length(capacity_changes::text) < 500000));

comment on column public.packaging_ai_adoptions.capacity_changes is
  'D101 這次採用寫進正式產能表的每一格採用前／後（退回產能的依據；null＝沒有改產能）';


-- ----------------------------------------------------------------------------
-- 4. RLS／權限重申（比照 20260928b 第 7 段；欄位沿用表權限，這裡只是冪等地再確認一次）
-- ----------------------------------------------------------------------------

alter table public.packaging_sim_sessions enable row level security;
alter table public.packaging_ai_runs      enable row level security;
alter table public.packaging_ai_adoptions enable row level security;
revoke all on table public.packaging_sim_sessions from anon, authenticated;
revoke all on table public.packaging_ai_runs      from anon, authenticated;
revoke all on table public.packaging_ai_adoptions from anon, authenticated;

commit;


-- ----------------------------------------------------------------------------
-- 5. 套用後自我檢查（唯讀，可單獨執行）
-- ----------------------------------------------------------------------------
-- (a) 三個新欄存在、型別與預設正確：
-- select table_name, column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_schema = 'public'
--    and (table_name, column_name) in (('packaging_sim_sessions','sim_capacity'),
--                                      ('packaging_ai_runs','sim_capacity'),
--                                      ('packaging_ai_adoptions','capacity_changes'));
-- (b) 既有模擬區都拿到預設值（預期 0）：
-- select count(*) from public.packaging_sim_sessions where sim_capacity is null or jsonb_typeof(sim_capacity) <> 'object';
-- (c) check 已建立：
-- select conrelid::regclass, conname from pg_constraint
--  where conname in ('packaging_sim_sessions_sim_capacity_check','packaging_ai_runs_sim_capacity_check',
--                    'packaging_ai_adoptions_capacity_changes_check');
-- (d) RLS 仍開啟、anon／authenticated 沒有表權限（預期 relrowsecurity 全 true、第二段 0 列）：
-- select relname, relrowsecurity from pg_class
--  where relnamespace = 'public'::regnamespace
--    and relname in ('packaging_sim_sessions','packaging_ai_runs','packaging_ai_adoptions');
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_name in ('packaging_sim_sessions','packaging_ai_runs','packaging_ai_adoptions')
--    and grantee in ('anon','authenticated');
-- (e) 若套用後 API 回 PGRST204（schema cache 還沒更新），在 SQL Editor 補跑一次：notify pgrst, 'reload schema';
