-- ============================================================================
-- 2026-09-27  包裝專區 P1：拖曳排程工作台
--
-- ⚠ 套用前請先在 Supabase 後台手動備份（Dashboard → Database → Backups，或匯出）。
--   本專案 Supabase 是正式站、沒有自動備份。本檔由 Snow 備份後在 SQL Editor 手動貼上執行一次。
--
-- 背景
--   包裝部排程（需求決策紀錄 D1~D54）P0 只有唯讀待排池，不建表。P1 要讓包裝主管把待排池的卡
--   拖到日期欄排定（D21）、拆卡（D7）、勾完成（D24）、填每日產能（D49）、自動儲存＋Undo＋版本快照（D33），
--   並以編輯鎖確保同時只有一人編輯（D53）。這些狀態第一版只存在 EIP，不回寫塔台（D4／D24）。
--
-- 本檔只做一件事：新增 5 張 packaging_* 表與索引（外加 packaging_edit_lock 的初始列）。
--   - 不修改、不刪除任何既有表／欄位／資料；不建函式、不建觸發器、不動 extension。
--   - 新表對既有程式完全無影響，所以可以「先套用 migration、再部署 P1 程式」；
--     反過來（程式先上）P1 API 會因找不到表而回 500，待排池 P0 頁面不受影響。
--
-- 五張表（設計理由見 docs/design/2026-09-27-packaging-schedule-p1.md §一）
--   packaging_placements        一列＝一張排定（子）卡：SO 行鍵、數量、排定日（null＝待排區）、完成勾選
--   packaging_daily_capacity    一天一列：人數、正常工時、加班上限、週六是否開加班（D48／D49）
--   packaging_schedule_versions 版本快照（jsonb），保留 90 天（D33）
--   packaging_edit_lock         單列編輯鎖（D53）
--   packaging_op_log            操作紀錄（誰在何時做了什麼；除錯與 P2 學習素材）
--   （packaging_placements 的完成欄位取代原先構想的 packaging_card_state，理由見規格 §1.3）
--
-- 安全策略（比照 sql/20260913_quote_system.sql、20260814_members_rls_lockdown.sql）
--   全部啟用 RLS，只給 service_role 一條 policy；anon / authenticated 沒有 policy → 一律拒絕，
--   並額外 revoke 表權限。瀏覽器端不可直接讀寫，一律走 /api/packaging/*（guardAuth + 權限 +
--   service role client）。
--
-- 冪等：create ... if not exists / drop policy if exists / on conflict do nothing，重跑不會壞。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. packaging_placements：排定（子）卡
-- ----------------------------------------------------------------------------
-- 為什麼一張卡一列、不是整份排程存成一個 JSON 草稿：
--   每次拖曳只改一列（自動儲存粒度小、失敗只影響那張卡）、每列有 version 做樂觀檢查、
--   完成勾選是「事實」要能跨版本還原保留、依 SO 行彙總（拆卡守恆）要能直接查。
-- 卡片身分：so_line_key（＝ `${SO}-${項次}`，D6）。待排池卡的 cardId 會隨區塊變動（#2、#1b…），
--   所以不拿 cardId 當鍵；origin_card_id 只記「從哪張卡拖出來」供顯示。
-- 剩餘量不存：待排池剩餘＝該行可排供給 − Σ 擺放，讀取時推導（規格 §3.3），
--   所以任何寫入中途失敗都只會讓數量「回到待排池」，不會憑空消失。

create table if not exists public.packaging_placements (
  -- 前端 crypto.randomUUID() 產生：Undo 要能以原 id 重建被刪掉的卡
  id uuid primary key,

  so_line_key text not null
    check (char_length(so_line_key) between 3 and 80),
  -- 數量用 numeric：ERP 訂單量偶有小數單位；API 另檢查 > 0
  qty numeric(14,3) not null
    check (qty > 0),

  -- 排定日；null＝待排區（D21 主管刻意擱置）
  plan_date date,
  -- 第一次從待排池排上日期的那天，之後移動不變（D50 延誤、P2 排 vs 改）
  original_date date,

  -- manual＝主管手動（含挪過 AI 排的卡）；ai＝P2 AI 排入且未被手動挪過（D50「主管挪過的以主管為準」）
  source text not null default 'manual'
    check (source in ('manual', 'ai')),
  -- 從哪張待排池卡拖出（PackagingCard.cardId），只供顯示；實測最長 16 字，上限 64 擋灌大字串（同 API 檢查）
  origin_card_id text
    check (origin_card_id is null or char_length(origin_card_id) <= 64),

  -- D24 手動完成勾選（第一版不寫塔台）
  completed_at timestamptz,
  completed_by text,
  completed_by_name text,
  -- 勾完成當下該 SO 行的可排供給量；用來判斷完成量是否已被待排池反映（規格 §3.4）
  completed_pool_qty numeric(14,3),

  -- 樂觀檢查：每次更新 +1
  version integer not null default 1
    check (version >= 1),

  created_by text not null,
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_by text not null,
  updated_by_name text,
  updated_at timestamptz not null default now(),

  -- 已完成的卡一定落在某一天（待排區的卡勾完成時由 API 帶入今天）
  constraint packaging_placements_completed_has_date
    check (completed_at is null or plan_date is not null),
  constraint packaging_placements_completed_by
    check ((completed_at is null) = (completed_by is null))
);

-- 依 SO 行彙總（拆卡守恆、待排池剩餘量）是每次讀取都要做的
create index if not exists packaging_placements_line_idx
  on public.packaging_placements (so_line_key);
-- 工作台只讀未完成的卡＋視窗內已完成的卡
create index if not exists packaging_placements_open_date_idx
  on public.packaging_placements (plan_date)
  where completed_at is null;
create index if not exists packaging_placements_completed_idx
  on public.packaging_placements (plan_date, completed_at)
  where completed_at is not null;
-- 輪詢指紋（revision）取最新 updated_at
create index if not exists packaging_placements_updated_idx
  on public.packaging_placements (updated_at desc);


-- ----------------------------------------------------------------------------
-- 2. packaging_daily_capacity：每日產能（D48／D49）
-- ----------------------------------------------------------------------------
-- 主管每天填 3 欄：人數、正常工時合計（至 19:00，已扣請假／支援品檢）、可加班工時上限。
-- 沒填的日子不存列，由程式推導：平日沿用最近一次（較早日期）填的平日值；週六預設 0（不加班）。
-- 週六＝加班日：只有加班欄（regular_hours 必須 0），is_saturday_open＝true 才出現在工作台。
-- 週日不收（D48 未定義週日加班）；平日國定假日由 API 擋（行事曆在程式裡，不在 DB）。

create table if not exists public.packaging_daily_capacity (
  date date primary key,

  headcount smallint
    check (headcount is null or headcount between 0 and 500),
  regular_hours numeric(6,2) not null default 0
    check (regular_hours >= 0 and regular_hours <= 5000),
  overtime_hours_max numeric(6,2) not null default 0
    check (overtime_hours_max >= 0 and overtime_hours_max <= 5000),
  is_saturday_open boolean not null default false,
  note text,

  updated_by text not null,
  updated_by_name text,
  updated_at timestamptz not null default now(),

  -- isodow：1＝週一 … 6＝週六、7＝週日
  constraint packaging_daily_capacity_no_sunday
    check (extract(isodow from "date") <> 7),
  constraint packaging_daily_capacity_saturday_overtime_only
    check (extract(isodow from "date") <> 6 or regular_hours = 0),
  constraint packaging_daily_capacity_open_only_saturday
    check (is_saturday_open = false or extract(isodow from "date") = 6)
);

-- 主鍵已是 date，「某日之前最近一次填的平日值」用主鍵倒序即可，不另建索引


-- ----------------------------------------------------------------------------
-- 3. packaging_schedule_versions：版本快照（D33）
-- ----------------------------------------------------------------------------
-- 快照是「不可變」的歷史，所以這裡才用整份 jsonb：
--   { schemaVersion: 1, takenAt, today, placements: [{ id, soLineKey, qty, planDate, originalDate, source, originCardId }] }
-- 只存未完成的擺放；還原時只換掉未完成的卡，已完成紀錄保留。
-- source：manual＝主管具名存；auto_before_ai／auto_after_ai＝P2 AI 排程前後自動存；
--         auto_before_restore＝還原前自動備份（讓「還原」本身也能反悔）。
-- 保留 90 天：由 POST /api/packaging/versions 順手刪除 created_at 超過 90 天的列（不建排程工作）。

create table if not exists public.packaging_schedule_versions (
  id bigserial primary key,
  label text not null
    check (char_length(label) between 1 and 80),
  source text not null
    check (source in ('manual', 'auto_before_ai', 'auto_after_ai', 'auto_before_restore')),
  -- 大小上限 5MB 當最後防線（API 另擋 5000 列／2MB；正常數百張約 60KB），避免正式站儲存被灌爆
  snapshot jsonb not null
    check (octet_length(snapshot::text) < 5000000),
  placement_count integer not null default 0
    check (placement_count >= 0),
  created_by text not null,
  created_by_name text,
  created_at timestamptz not null default now()
);

create index if not exists packaging_schedule_versions_created_idx
  on public.packaging_schedule_versions (created_at desc);


-- ----------------------------------------------------------------------------
-- 4. packaging_edit_lock：編輯鎖（D53），固定只有 id = 1 這一列
-- ----------------------------------------------------------------------------
-- 同時只有一人可編輯；5 分鐘無動作（last_action_at）自動視為釋放——不需要排程工作清鎖，
-- 「逾時」是讀取時判斷的。token 在每次取得／接手時換新，所有更新都以
-- 「where id = 1 and token = 舊 token」做 compare-and-set（單一 UPDATE 敘述即原子），
-- 被接手的人下一次心跳或寫入就會失敗並轉唯讀。

create table if not exists public.packaging_edit_lock (
  id smallint primary key default 1
    check (id = 1),
  holder_email text,
  holder_name text,
  token uuid,
  acquired_at timestamptz,
  heartbeat_at timestamptz,
  last_action_at timestamptz,
  -- 被接手時記錄前一位持有者，讓他的頁面能顯示「已被 XXX 接手」
  prev_holder_email text,
  prev_holder_name text,
  taken_over_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.packaging_edit_lock (id)
values (1)
on conflict (id) do nothing;


-- ----------------------------------------------------------------------------
-- 5. packaging_op_log：操作紀錄（只增不改）
-- ----------------------------------------------------------------------------
-- 每次成功寫入記一列：誰、什麼時候、做了什麼（原始操作 jsonb）。
-- 用途：現場爭議「誰把我的卡移走了」、除錯、P2 比對「AI 原排 vs 主管改」的素材（D33／D34）。
-- 量很小（一天數百列），第一版不設自動清除。

create table if not exists public.packaging_op_log (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  actor_email text not null,
  actor_name text,
  kind text not null
    check (kind in ('placements', 'complete', 'capacity', 'version_create', 'version_restore', 'lock')),
  label text,
  ops jsonb not null default '[]'::jsonb
);

create index if not exists packaging_op_log_created_idx
  on public.packaging_op_log (created_at desc);


-- ----------------------------------------------------------------------------
-- 6. RLS：service_role only
--    service_role 本來就繞過 RLS，這條 policy 是「明示意圖」；重點是 anon / authenticated
--    沒有任何 policy → 全部拒絕。另外把表權限也收回，雙重保險。
-- ----------------------------------------------------------------------------

alter table public.packaging_placements enable row level security;
drop policy if exists "service_role full access" on public.packaging_placements;
create policy "service_role full access" on public.packaging_placements
  for all to service_role using (true) with check (true);
revoke all on table public.packaging_placements from anon, authenticated;

alter table public.packaging_daily_capacity enable row level security;
drop policy if exists "service_role full access" on public.packaging_daily_capacity;
create policy "service_role full access" on public.packaging_daily_capacity
  for all to service_role using (true) with check (true);
revoke all on table public.packaging_daily_capacity from anon, authenticated;

alter table public.packaging_schedule_versions enable row level security;
drop policy if exists "service_role full access" on public.packaging_schedule_versions;
create policy "service_role full access" on public.packaging_schedule_versions
  for all to service_role using (true) with check (true);
revoke all on table public.packaging_schedule_versions from anon, authenticated;

alter table public.packaging_edit_lock enable row level security;
drop policy if exists "service_role full access" on public.packaging_edit_lock;
create policy "service_role full access" on public.packaging_edit_lock
  for all to service_role using (true) with check (true);
revoke all on table public.packaging_edit_lock from anon, authenticated;

alter table public.packaging_op_log enable row level security;
drop policy if exists "service_role full access" on public.packaging_op_log;
create policy "service_role full access" on public.packaging_op_log
  for all to service_role using (true) with check (true);
revoke all on table public.packaging_op_log from anon, authenticated;


-- ----------------------------------------------------------------------------
-- 7. 套用後自我檢查（唯讀，可單獨執行）
-- ----------------------------------------------------------------------------
-- select relname, relrowsecurity from pg_class
--  where relkind = 'r' and relnamespace = 'public'::regnamespace and relname like 'packaging\_%';
-- 預期：5 張表 row_security = true；packaging_edit_lock 有 1 列（id = 1）。
