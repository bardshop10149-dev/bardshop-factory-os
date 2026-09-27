-- ============================================================================
-- 2026-09-28(b)  包裝專區 P3：AI 模擬排程（D76～D97）
--
-- ⚠ 套用前請先在 Supabase 後台手動備份（Dashboard → Database → Backups，或匯出 packaging_* 各表）。
--   本專案 Supabase 是正式站、沒有自動備份。本檔由 Snow 備份後在 SQL Editor 手動貼上執行一次。
-- ⚠ 前提：已依序套用 sql/20260927_packaging_schedule.sql → sql/20260927b_packaging_p1_extend.sql
--   → sql/20260928_packaging_sales_and_order.sql（本檔放寬 packaging_op_log 的 kind，其餘都是新表）。
--
-- 設計理由與規則：docs/design/2026-09-28-packaging-ai.md §一（資料表）、§三（模擬區狀態）、§四（AI 執行）、§六（採用與退回）。
--
-- 內容（全部包在一個交易裡：任何一段失敗整份不生效）
--   1. packaging_sim_sessions     新表：每位被授權人一份模擬區（D68 預設 / D89）；模擬擺放整份存 jsonb
--   2. packaging_ai_runs          新表：每次 AI 執行一列，不刪除（D91 LOG）
--   3. packaging_ai_adoptions     新表：每次「採用此版排程」一列（D82／D86／D87），供範圍內退回
--   4. packaging_ai_rules         新表：主管建議規則文字，append-only（最新一列＝目前規則；D91），種子＝預設規則（D81／D93／D94／D79）
--   5. packaging_bulk_thresholds  新表：大量門檻（D92），種子＝拼板立牌 500、透卡 1000
--   6. packaging_op_log.kind 放寬：保留既有 8 種，加 ai_sim／ai_run／ai_adopt／ai_revert／ai_rules／ai_threshold
--   7. RLS：5 張新表只給 service_role（revoke anon / authenticated，序列也收回）
--   （版本快照 source 直接用既有 'auto_before_ai'／'auto_before_restore'，20260927 建表時已允許，免改）
--
-- 不做：不修改、不刪除任何既有表的資料或欄位；不建函式、觸發器、外鍵；不動 extension。
--   ** 模擬卡絕不寫進 packaging_placements **：模擬資料只存在本檔的新表（規格 §〇）。
--   不設外鍵的理由：AI 執行／採用紀錄是 LOG，要能獨立保留；版本快照 90 天後會被刪除（D33），
--   採用紀錄的 version_id 屆時指向不存在的列是預期行為（退回時程式會提示「採用前版本已過期」）。
--
-- 相容性（Snow 的穩定測試站 wt-packaging-stable 仍是舊程式、連同一個正式站資料庫）
--   - 5 張新表舊程式完全不認得 → 無影響。
--   - op_log 的 kind check 是「舊規則的超集合」（原 8 種全部保留）→ 舊程式寫入照常。
--   - 採用（D86）寫進 packaging_placements 的列與人工拖曳完全同形（走既有 applyOps／writeApplied），舊程式讀得懂。
--
-- 冪等：create table / index if not exists、drop constraint / policy if exists 後再建、
--       種子 where not exists / on conflict do nothing；重跑不會壞，也不會重複寫種子。
--
-- 還原（若要整份退回）：先確認新程式已下線，再
--   drop table public.packaging_ai_adoptions, public.packaging_ai_runs, public.packaging_sim_sessions,
--              public.packaging_ai_rules, public.packaging_bulk_thresholds;
--   op_log 的 constraint 可保留（是舊規則的放寬版，對舊程式無害）。
--   注意：採用（D86）已寫進正式排程的卡不會因 drop 這些表而消失——那是正式資料，要退回請先在畫面按「退回採用」或用版本歷史。
-- ============================================================================

begin;


-- ----------------------------------------------------------------------------
-- 1. packaging_sim_sessions：模擬區（每位被授權人一份）
-- ----------------------------------------------------------------------------
-- 為什麼整份存 jsonb、不是一列一張卡（與 packaging_placements 相反）：
--   模擬區是「一人編輯、短命、要整份採用」的草稿；每次操作讀整份 → 對組合狀態跑既有純函式 applyOps／assembleBoard
--   → 整份寫回（version 樂觀檢查）。正式區當初否決 JSON 的理由（多人共用、逐張自動儲存）在這裡不成立，
--   而且「模擬卡不可能混進正式表」本身就是安全性（9/28 誤刪事故的教訓）。
-- placements：只放「模擬範圍內（window_dates × line_ids）、未完成」的模擬擺放，格式＝PlacementSnapshotRow
--   （lib/packaging/scheduleTypes.ts）＋模擬專用欄 aiReason／simSource（copy／ai／manual）／livePlacementId。
--   範圍外、已完成、待排區（plan_date null）的卡一律讀正式區、在模擬區唯讀（規格 §三「組合檢視」）。
-- locks：D88 鎖定（單張卡、整張訂單＝SO 單號大寫、整條線）。
-- undo：模擬區「退回上一步」堆疊（最多 30 步，每步＝整份狀態快照＋標籤），純 JSON、不牽涉正式區。
-- version：每次寫入 +1，所有更新以「where id = … and version = 舊值」做 compare-and-set（單一 UPDATE 敘述即原子）。
-- running_run_id：同一個模擬區同時只允許一個執行中的 AI（連按兩次＝雙倍費用、結果互蓋）。

create table if not exists public.packaging_sim_sessions (
  id bigserial primary key,
  -- 一人一份（D68 預設 / 規格 §九 第 1 點）；email 與 members.email 同值（guardAuth 驗過的身分）
  owner_email text not null unique
    check (char_length(owner_email) between 3 and 200),
  owner_name text,

  -- D83：2／4／6 個工作日（預設 4）
  horizon smallint not null default 4
    check (horizon in (2, 4, 6)),
  -- D78①：copy＝複製現有排程、clear＝清空全部重排
  mode text not null default 'copy'
    check (mode in ('copy', 'clear')),
  -- 建立時用 boardWindow 算好的模擬日（含已開加班的週末，週末不佔名額 → 6 天最多約 10 個日期）
  window_dates date[] not null
    check (cardinality(window_dates) between 1 and 20),
  -- 建立時啟用中的線（MAX_ACTIVE_LINES = 6；含停用最多 12）
  line_ids smallint[] not null
    check (cardinality(line_ids) between 1 and 12),

  -- 大小防線（正常數百張約 60KB；API 另有上限，這裡是最後防線，避免正式站儲存被灌爆）
  placements jsonb not null default '[]'::jsonb
    check (jsonb_typeof(placements) = 'array' and octet_length(placements::text) < 2000000),
  locks jsonb not null default '{"placementIds":[],"soNumbers":[],"lineIds":[]}'::jsonb
    check (jsonb_typeof(locks) = 'object' and octet_length(locks::text) < 200000),
  undo jsonb not null default '[]'::jsonb
    check (jsonb_typeof(undo) = 'array' and octet_length(undo::text) < 8000000),

  version integer not null default 1
    check (version >= 1),
  running_run_id bigint,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.packaging_sim_sessions is
  '包裝 AI 模擬區（D77／D78／D89）：每位被授權人一份；模擬擺放整份存 jsonb，絕不寫進 packaging_placements';


-- ----------------------------------------------------------------------------
-- 2. packaging_ai_runs：AI 執行 LOG（每次一列，不刪除；D91）
-- ----------------------------------------------------------------------------
-- 流程：POST /api/packaging/ai/session/run 建列（status running）→ after() 背景執行（lib/packaging/ai/runner.ts）
--   → 前端每 3 秒輪詢 phase（preparing → thinking → validating）→ done／failed。
-- payload：送出的「去識別化」資料本體（D84 白名單）；客戶／卡片代號對照表只在記憶體、不存。
-- base_placements：AI 執行前的模擬區（供「回到 AI 前」）；result_placements：驗算修正後的結果（供歷史切換比較）。
-- base_version：建列當下模擬區的 version；寫回時以它做 CAS——AI 執行期間主管在模擬區動過 → 不覆蓋，只存在 run 裡。
-- 一般 run 約 100～300KB（payload ＋兩份擺放＋輸出），每人一天數次，量很小，第一版不設自動清除。

create table if not exists public.packaging_ai_runs (
  id bigserial primary key,
  session_id bigint not null,
  owner_email text not null,
  owner_name text,

  status text not null default 'running'
    check (status in ('running', 'done', 'failed')),
  phase text not null default 'preparing'
    check (phase in ('preparing', 'thinking', 'validating', 'done', 'failed')),
  error_code text
    check (error_code is null or char_length(error_code) <= 40),
  -- D95：給主管看得懂的繁中原因（API 掛、逾時、額度用完…）；不含 payload 內容
  error_message text
    check (error_message is null or char_length(error_message) <= 500),

  horizon smallint not null
    check (horizon in (2, 4, 6)),
  mode text not null
    check (mode in ('copy', 'clear')),
  window_dates date[] not null
    check (cardinality(window_dates) between 1 and 20),
  locks jsonb not null default '{"placementIds":[],"soNumbers":[],"lineIds":[]}'::jsonb
    check (jsonb_typeof(locks) = 'object' and octet_length(locks::text) < 200000),
  base_version integer not null
    check (base_version >= 1),

  -- 用的是哪一版規則（packaging_ai_rules.id）與當時的門檻表快照（D91／D92）
  rules_id bigint,
  thresholds jsonb not null default '[]'::jsonb
    check (jsonb_typeof(thresholds) = 'array' and octet_length(thresholds::text) < 200000),

  payload jsonb
    check (payload is null or octet_length(payload::text) < 3000000),
  base_placements jsonb not null default '[]'::jsonb
    check (jsonb_typeof(base_placements) = 'array' and octet_length(base_placements::text) < 2000000),
  result_placements jsonb
    check (result_placements is null or (jsonb_typeof(result_placements) = 'array' and octet_length(result_placements::text) < 2000000)),
  -- Claude 結構化輸出原文（卡片／客戶是代號）與程式驗算報告（已翻回 SO 行鍵，供畫面顯示）
  ai_output jsonb
    check (ai_output is null or octet_length(ai_output::text) < 2000000),
  validation jsonb
    check (validation is null or octet_length(validation::text) < 1000000),
  -- 給主管看的摘要（代號已由程式換回）
  summary text
    check (summary is null or char_length(summary) <= 8000),

  model text
    check (model is null or char_length(model) <= 100),
  -- { inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens }
  usage jsonb,
  duration_ms integer
    check (duration_ms is null or duration_ms >= 0),

  started_at timestamptz not null default now(),
  finished_at timestamptz,
  -- 執行中＝沒有結束時間；結束（done／failed）一定有
  constraint packaging_ai_runs_finished
    check ((status = 'running') = (finished_at is null))
);

-- 「我的最近 10 次」與 60 秒節流都依 owner_email＋時間倒序
create index if not exists packaging_ai_runs_owner_idx
  on public.packaging_ai_runs (owner_email, started_at desc);

comment on table public.packaging_ai_runs is
  '包裝 AI 執行 LOG（D91）：payload 為去識別化資料（D84），代號對照表不存；不刪除';


-- ----------------------------------------------------------------------------
-- 3. packaging_ai_adoptions：採用紀錄（D82／D86／D87）
-- ----------------------------------------------------------------------------
-- 採用＝以模擬版為準，只覆蓋 window_dates × line_ids（未鎖定的線），範圍外、待排區、已完成完全不動。
-- 寫入前一律先存 packaging_schedule_versions（source = 'auto_before_ai'）→ version_id。
-- 退回（§6.2）＝把該版本快照中「同一範圍」的列當目標，對正式區範圍內重算差異逐筆套用（不整張還原）；
--   inverse（applyOps 回傳的反向操作）只存著供除錯，不直接重跑（applyOps 全有或全無、版本號串連，任一張被改過就整批失敗）。
-- touched：採用後每張被寫的卡 {id, version}——之後 version 變了＝主管在採用後又改過（退回預覽要列出來）。
-- revert_claimed_at／revert_claimed_by：退回「處理中」的佔位（CAS）。同一筆採用被兩個請求同時退回時，只有佔到的那個會寫；
--   佔位 3 分鐘後失效（退回 API 最長 120 秒，逾時＝那個請求已中斷，可以重新退回）。退回完成後以 reverted_at 為準。

create table if not exists public.packaging_ai_adoptions (
  id bigserial primary key,
  session_id bigint not null,
  -- 模擬區最後一次 AI 執行（主管只手動調整、沒跑 AI 時為 null）
  run_id bigint,
  -- 採用前自動存的版本（source = 'auto_before_ai'）
  version_id bigint not null,
  window_dates date[] not null
    check (cardinality(window_dates) between 1 and 20),
  -- 實際覆蓋的線＝模擬區的線扣掉鎖定的線
  line_ids smallint[] not null
    check (cardinality(line_ids) between 1 and 12),

  inverse jsonb not null default '[]'::jsonb
    check (jsonb_typeof(inverse) = 'array' and octet_length(inverse::text) < 4000000),
  touched jsonb not null default '[]'::jsonb
    check (jsonb_typeof(touched) = 'array' and octet_length(touched::text) < 1000000),
  counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(counts) = 'object'),
  -- 採用時因已完成／已銷貨／已不在待排池等系統事實而略過的項目（D86）
  skipped jsonb not null default '[]'::jsonb
    check (jsonb_typeof(skipped) = 'array' and octet_length(skipped::text) < 1000000),

  actor_email text not null,
  actor_name text,
  created_at timestamptz not null default now(),

  reverted_at timestamptz,
  reverted_by text,
  reverted_by_name text,
  revert_report jsonb
    check (revert_report is null or octet_length(revert_report::text) < 1000000),
  revert_claimed_at timestamptz,
  revert_claimed_by text,
  constraint packaging_ai_adoptions_reverted_by
    check ((reverted_at is null) = (reverted_by is null))
);

-- 冪等補欄（本檔若曾以舊版套用過、表已存在，create table if not exists 不會加新欄）
alter table public.packaging_ai_adoptions add column if not exists revert_claimed_at timestamptz;
alter table public.packaging_ai_adoptions add column if not exists revert_claimed_by text;

create index if not exists packaging_ai_adoptions_created_idx
  on public.packaging_ai_adoptions (created_at desc);

comment on table public.packaging_ai_adoptions is
  '包裝 AI 採用紀錄（D82／D86／D87）：採用前版本 version_id、範圍、被寫的卡；退回只在同一範圍內還原';


-- ----------------------------------------------------------------------------
-- 4. packaging_ai_rules：主管建議規則文字（append-only；D91）
-- ----------------------------------------------------------------------------
-- 一份文字、統一一個輸入入口；每次儲存新增一列（誰、何時、全文）＝LOG；最新一列（id 最大）＝目前規則，AI 每次讀最新版。
-- 儲存時帶 baseId（編輯時看到的版本），不是最新就回 rules_conflict（有人剛改過），不會默默蓋掉別人的修改。

create table if not exists public.packaging_ai_rules (
  id bigserial primary key,
  body text not null
    check (char_length(body) between 1 and 8000),
  created_by text not null,
  created_by_name text,
  created_at timestamptz not null default now()
);

-- 種子：預設規則（D81 分線偏好＋D93 打樣→A＋預設衝突順序＋D79 交期＋D94 加班；主管可改，規格 §七）
-- 只在表是空的時候寫（重跑不會再寫一份）
insert into public.packaging_ai_rules (body, created_by, created_by_name)
select $rules$【分線偏好】(偏好,不是硬分割;某線排不完或沒事做時可以借線,寫理由)
A 線:優先排「大量」(看卡片 bulk 標記,門檻在門檻表)+ 打樣。
B 線:SOB 開頭的散單,以及 500 件以下的單。
C 線:以壓克力及委外回來的貨為主。
【衝突時】一張卡同時符合多條線:打樣 → A 線;其餘依序:委外回來/壓克力 → C;SOB 或 500 以下 → B;大量 → A;都不符合 → 放有空的線。
【交期】逾期與快到期的先排(依 ERP 交期)。
【加班】以不加班為主;只有不加班就會逾期或危險時才用加班,並說明。$rules$,
       'system', '系統預設(D81)'
where not exists (select 1 from public.packaging_ai_rules);


-- ----------------------------------------------------------------------------
-- 5. packaging_bulk_thresholds：大量門檻（D92）
-- ----------------------------------------------------------------------------
-- key＝品類名（與卡片品類完全相同）或品名關鍵字（品名包含它，取最長的 key）；數量 ≥ threshold 算「大量」。
-- 大量由程式先算好（bulk 標記），AI 不自己判（規格 §4.4）；沒有門檻的品類不判大量、摘要提醒主管補。
-- 主管可編輯（整表替換），變更寫 packaging_op_log（kind 'ai_threshold'，記前後值）。

create table if not exists public.packaging_bulk_thresholds (
  key text primary key
    check (char_length(btrim(key)) between 1 and 30 and key = btrim(key)),
  threshold integer not null
    check (threshold between 1 and 1000000),
  note text
    check (note is null or char_length(note) <= 200),
  updated_by text not null,
  updated_by_name text,
  updated_at timestamptz not null default now()
);

-- 種子：Snow 給的兩個例子（D81／D92）
insert into public.packaging_bulk_thresholds (key, threshold, note, updated_by, updated_by_name)
values
  ('拼板立牌', 500, 'D81／D92 Snow 範例', 'system', '系統預設(D92)'),
  ('透卡', 1000, 'D81／D92 Snow 範例（簡單品）', 'system', '系統預設(D92)')
on conflict (key) do nothing;


-- ----------------------------------------------------------------------------
-- 6. packaging_op_log.kind：加 AI 模擬排程的 6 種
-- ----------------------------------------------------------------------------
-- 20260927 建表時是欄位上的匿名 check（Postgres 自動命名 packaging_op_log_kind_check），20260927b 已放寬過一次（加 lines、manual）。
-- 不放寬的話 insertOpLog 會「默默失敗」（失敗只 console.error、不擋回應），AI 的操作就沒有紀錄。
--   ai_sim       建立／重設模擬區、鎖定、模擬區手動操作、退回上一步、載入歷史結果
--   ai_run       按下 AI 排程
--   ai_adopt     採用此版排程（寫正式區）
--   ai_revert    退回採用（寫正式區）
--   ai_rules     儲存主管建議規則
--   ai_threshold 修改大量門檻表（ops＝前後值）

alter table public.packaging_op_log
  drop constraint if exists packaging_op_log_kind_check;
alter table public.packaging_op_log
  add constraint packaging_op_log_kind_check
  check (kind in (
    'placements', 'complete', 'capacity', 'version_create', 'version_restore', 'lock', 'lines', 'manual',
    'ai_sim', 'ai_run', 'ai_adopt', 'ai_revert', 'ai_rules', 'ai_threshold'
  ));


-- ----------------------------------------------------------------------------
-- 7. RLS：service_role only（比照 20260927_packaging_schedule.sql 第 6 段、20260927b 第 8 段）
--    service_role 本來就繞過 RLS，這條 policy 是「明示意圖」；anon / authenticated 沒有任何 policy → 全部拒絕。
--    另外收回表權限與序列權限，雙重保險（Supabase 預設會給 anon/authenticated 序列權限）。
-- ----------------------------------------------------------------------------

alter table public.packaging_sim_sessions enable row level security;
drop policy if exists "service_role full access" on public.packaging_sim_sessions;
create policy "service_role full access" on public.packaging_sim_sessions
  for all to service_role using (true) with check (true);
revoke all on table public.packaging_sim_sessions from anon, authenticated;

alter table public.packaging_ai_runs enable row level security;
drop policy if exists "service_role full access" on public.packaging_ai_runs;
create policy "service_role full access" on public.packaging_ai_runs
  for all to service_role using (true) with check (true);
revoke all on table public.packaging_ai_runs from anon, authenticated;

alter table public.packaging_ai_adoptions enable row level security;
drop policy if exists "service_role full access" on public.packaging_ai_adoptions;
create policy "service_role full access" on public.packaging_ai_adoptions
  for all to service_role using (true) with check (true);
revoke all on table public.packaging_ai_adoptions from anon, authenticated;

alter table public.packaging_ai_rules enable row level security;
drop policy if exists "service_role full access" on public.packaging_ai_rules;
create policy "service_role full access" on public.packaging_ai_rules
  for all to service_role using (true) with check (true);
revoke all on table public.packaging_ai_rules from anon, authenticated;

alter table public.packaging_bulk_thresholds enable row level security;
drop policy if exists "service_role full access" on public.packaging_bulk_thresholds;
create policy "service_role full access" on public.packaging_bulk_thresholds
  for all to service_role using (true) with check (true);
revoke all on table public.packaging_bulk_thresholds from anon, authenticated;

revoke all on sequence public.packaging_sim_sessions_id_seq from anon, authenticated;
revoke all on sequence public.packaging_ai_runs_id_seq from anon, authenticated;
revoke all on sequence public.packaging_ai_adoptions_id_seq from anon, authenticated;
revoke all on sequence public.packaging_ai_rules_id_seq from anon, authenticated;

commit;


-- ----------------------------------------------------------------------------
-- 8. 套用後自我檢查（唯讀，可單獨執行）
-- ----------------------------------------------------------------------------
-- (a) 5 張新表都開了 RLS（relrowsecurity = true）：
-- select relname, relrowsecurity from pg_class
--  where relkind = 'r' and relnamespace = 'public'::regnamespace
--    and relname in ('packaging_sim_sessions', 'packaging_ai_runs', 'packaging_ai_adoptions', 'packaging_ai_rules', 'packaging_bulk_thresholds');
-- (b) 種子：規則 1 列、門檻 2 列：
-- select id, created_by, char_length(body) as len from public.packaging_ai_rules order by id;
-- select key, threshold from public.packaging_bulk_thresholds order by key;
-- (c) anon / authenticated 沒有表權限（預期 0 列）：
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--  where table_name in ('packaging_sim_sessions', 'packaging_ai_runs', 'packaging_ai_adoptions', 'packaging_ai_rules', 'packaging_bulk_thresholds')
--    and grantee in ('anon', 'authenticated');
-- (d) op_log kind 已放寬（應看到 ai_sim … ai_threshold）：
-- select pg_get_constraintdef(oid) from pg_constraint
--  where conrelid = 'public.packaging_op_log'::regclass and conname = 'packaging_op_log_kind_check';
-- (e) 模擬卡沒有混進正式表（任何時候都應該是 0；採用寫入的卡是正式卡，source 為 ai 或 manual）：
-- select count(*) from public.packaging_placements where id in (
--   select (e->>'id')::uuid from public.packaging_sim_sessions s, jsonb_array_elements(s.placements) e);
