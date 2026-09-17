// 報價系統 SQL migration 產生器：讀 lib/quote/seed 四個 JSON → 寫 sql/20260913_quote_system.sql。
//
// 跑法（Node ≥ 22.6，不需要 tsx；golden.ts 只 import type，strip-types 直接載得動）：
//   node --experimental-strip-types scripts/quote-seed-sql.mjs
//   或 npm run quote:seed-sql
//
// 為什麼用腳本產 SQL 而不是手寫：
//   * 價格表 121 筆、golden 6 筆各自帶完整 input + settings_snapshot，手打必錯。
//   * seed JSON 是唯一真相（前台 devSeed、golden 測試、SQL 三邊共用同一份），
//     改 JSON 重跑腳本即可，不會出現「SQL 與 JSON 對不上」。
//   * 所有字串用 dollar-quoting（$q$...$q$），品名含單引號、【】、Φ 都不用轉義。
//
// 產出的 SQL 冪等：可以重複執行；seed 用 on conflict do nothing（settings 例外，do update）。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolveGoldenCase } from '../lib/quote/golden.ts'

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'))
const priceItems = read('../lib/quote/seed/priceItems.json')
const products = read('../lib/quote/seed/products.json')
const settings = read('../lib/quote/seed/settings.json')
const golden = read('../lib/quote/seed/golden.json')

const OUT = new URL('../sql/20260913_quote_system.sql', import.meta.url)
const SEED_BY = 'seed:20260913'
const TAG = '$q$'

/* ---------------------------------------------------------------- 字面值 */

/** 文字 → $q$...$q$；null/undefined → null */
function q(v) {
  if (v == null) return 'null'
  const s = String(v)
  if (s.includes(TAG)) throw new Error(`字串含 ${TAG}，無法 dollar-quote：${s.slice(0, 60)}`)
  return `${TAG}${s}${TAG}`
}
/** 任意 JSON 值 → $q$...$q$::jsonb（JSON null 也存成 'null'::jsonb，不是 SQL null） */
function j(v) {
  if (v === undefined) return 'null'
  return `${q(JSON.stringify(v))}::jsonb`
}
/** 數字 → 原樣；null → null；非有限數丟錯（避免 NaN 進 numeric） */
function n(v) {
  if (v == null) return 'null'
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`不是有限數字：${JSON.stringify(v)}`)
  return String(v)
}
const row = (cols) => `  (${cols.join(', ')})`

/* ---------------------------------------------------------------- 檔頭 */

const header = `-- ============================================================================
-- EIP 報價計算機（報價系統）資料表 + 初始資料
-- 日期：2026-09-13
-- 產生方式：node --experimental-strip-types scripts/quote-seed-sql.mjs（請勿手改本檔，改 seed JSON 重跑）
--
-- 用途
--   業務資訊看板「報價計算機」（前台 /info-board/quote）與後台「報價系統」維護區
--   （/admin/quote/*）共用的五張表。價格由確定性引擎 lib/quote/engines/acrylic.ts 算出，
--   引擎的常數全部來自這裡（設計書 §5.0 鐵則 2：常數不寫死）。
--
-- 五張表
--   quote_products      品項設定（config jsonb：板材選項、印刷方式、配件、包裝、預設值）。
--                       狀態 draft → testing → published；前台只讀 published。
--   quote_price_items   材料價格表（板材／PET／印刷／工序／五金／包材／其他）。
--                       name 保留 Excel 簡體原名當自然鍵（unique (plant, name)），display_name 才是繁中顯示名。
--                       五金列帶 argo_part_code，之後後台「抓 ERP 建議價」用。
--   quote_settings      全域參數（key/value jsonb）：機台折舊、人工、刀費、旗標、匯率、費率版本。
--   quote_golden_cases  驗證案例。每筆帶 input（引擎輸入）與 settings_snapshot（那張 Excel 當時的常數），
--                       匯入後 status = proposed，Snow 核可（approved）才成為「發布」閘門。
--   quote_calc_logs     前台每次「產生報價」的紀錄（quote_no、規則版本、價格快照、匯率），供追溯。
--
-- 安全策略
--   五張表全部啟用 RLS，只給 service_role 一條 policy；anon / authenticated 沒有任何 policy，
--   等於前端用 anon key 直接讀寫一律被拒。所有存取都走 /api/quote/*（guardPermission 把關，
--   後端用 service_role client）。沿用 sql/20260814_members_rls_lockdown.sql 的做法。
--
-- 執行方式
--   只在「一台機器」到 Supabase Dashboard → SQL Editor 貼上本檔跑一次。
--   本檔冪等（create ... if not exists / drop policy if exists / on conflict），重跑不會壞，
--   但 seed 的 price items / products / golden 是 on conflict do nothing：
--   線上已被後台改過的值不會被覆蓋；只有 quote_settings 會 do update 回 seed 值。
--   動 schema 前請先在 Dashboard 手動備份。
-- ============================================================================
`

/* ---------------------------------------------------------------- schema */

const schema = `
-- ----------------------------------------------------------------------------
-- 1. 資料表
-- ----------------------------------------------------------------------------

-- 品項設定。id 是 text：seed 用可讀 slug（'keyring'），前台 URL、log、golden 都直接引用；
-- 後台新建品項不帶 id，由 default 產 uuid 字串（text 欄不會有 22P02 問題）。
create table if not exists public.quote_products (
  id            text primary key default gen_random_uuid()::text,
  family        text not null default 'acrylic',
  category      text not null,
  name          text not null,
  plant         text not null default 'changping',
  status        text not null default 'draft' check (status in ('draft', 'testing', 'published')),
  version       integer not null default 1,
  config        jsonb not null default '{}'::jsonb,
  sort_order    integer not null default 0,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  published_at  timestamptz
);

-- 表已存在（早於本版建的）也補上 default，重跑冪等
alter table public.quote_products alter column id set default gen_random_uuid()::text;

create index if not exists quote_products_status_idx
  on public.quote_products (status, sort_order);

-- 材料價格表。"group" 是保留字，欄名要加雙引號（查詢時也要）。
create table if not exists public.quote_price_items (
  id                      uuid primary key default gen_random_uuid(),
  "group"                 text not null,
  name                    text not null,
  display_name            text,
  unit                    text not null default '個',
  price                   numeric not null,
  currency                text not null default 'RMB',
  plant                   text not null default 'changping',
  attrs                   jsonb,
  effective_from          date,
  source_file             text,
  argo_part_code          text,
  erp_suggested_price     numeric,
  erp_suggested_currency  text,
  erp_suggested_at        timestamptz,
  updated_by              text,
  updated_at              timestamptz not null default now(),
  note                    text,
  unique (plant, name)
);

create index if not exists quote_price_items_plant_group_idx
  on public.quote_price_items (plant, "group");

-- 全域參數：一個 key 一列，value 一律 jsonb（數字、物件、null 都存得下）。
create table if not exists public.quote_settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

-- 驗證案例。settings_snapshot 是「那張 Excel 當時的常數」，驗證時覆蓋現價，驗邏輯不驗現價。
create table if not exists public.quote_golden_cases (
  id                 uuid primary key default gen_random_uuid(),
  product_id         text not null references public.quote_products(id) on delete cascade,
  name               text not null,
  status             text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  template_version   text,
  source_file        text,
  source_sheet       text,
  audit_note         text,
  input              jsonb not null,
  settings_snapshot  jsonb,
  expected_cost      numeric not null,
  expected_price     numeric not null,
  tolerance          numeric not null default 0.01,
  last_result        text,
  last_diff          jsonb,
  last_run_at        timestamptz,
  approved_by        text,
  approved_at        timestamptz,
  created_at         timestamptz not null default now(),
  unique (product_id, name)
);

create index if not exists quote_golden_cases_product_idx
  on public.quote_golden_cases (product_id, status);

-- 試算紀錄。product_id 刻意不設外鍵：品項之後被刪，歷史報價仍要留得住。
create table if not exists public.quote_calc_logs (
  id               uuid primary key default gen_random_uuid(),
  quote_no         text not null unique,
  product_id       text,
  product_version  integer,
  rate_version     text,
  customer         text,
  request          jsonb not null,
  response         jsonb not null,
  price_snapshot   jsonb,
  fx               jsonb,
  quote_unit       numeric,
  summary          text,
  user_email       text,
  created_at       timestamptz not null default now()
);

create index if not exists quote_calc_logs_user_idx
  on public.quote_calc_logs (user_email, created_at desc);
create index if not exists quote_calc_logs_created_idx
  on public.quote_calc_logs (created_at desc);

-- ----------------------------------------------------------------------------
-- 2. RLS：service_role only
--    service_role 本來就繞過 RLS，這條 policy 是「明示意圖」；重點是 anon / authenticated
--    沒有任何 policy → 全部拒絕。
-- ----------------------------------------------------------------------------
`

const TABLES = ['quote_products', 'quote_price_items', 'quote_settings', 'quote_golden_cases', 'quote_calc_logs']
const rls = TABLES.map(
  (t) => `alter table public.${t} enable row level security;
drop policy if exists "service_role full access" on public.${t};
create policy "service_role full access" on public.${t}
  for all to service_role using (true) with check (true);`,
).join('\n\n')

/* ---------------------------------------------------------------- seed：價格表 */

const priceRows = priceItems.map((p) =>
  row([
    q(p.group), q(p.name), q(p.display_name), q(p.unit), n(p.price), q(p.currency), q(p.plant),
    p.attrs == null ? 'null' : j(p.attrs), q(p.effective_from), q(p.source_file), q(p.argo_part_code),
    q(SEED_BY), q(p.note),
  ]),
)
const priceSql = `
-- ----------------------------------------------------------------------------
-- 3. seed：材料價格表（${priceItems.length} 筆；來源 _报价模板_v1.5.6.xlsx / 价格表 + 品項會用到的後備常數）
--    已存在的 (plant, name) 不覆蓋——線上被後台改過的價不會被 seed 洗掉。
-- ----------------------------------------------------------------------------
insert into public.quote_price_items
  ("group", name, display_name, unit, price, currency, plant, attrs, effective_from, source_file, argo_part_code, updated_by, note)
values
${priceRows.join(',\n')}
on conflict (plant, name) do nothing;
`

/* ---------------------------------------------------------------- seed：全域參數 */

const settingKeys = Object.keys(settings).filter((k) => !k.startsWith('_'))
const settingRows = settingKeys.map((k) => row([q(k), j(settings[k]), q(SEED_BY)]))
const settingsSql = `
-- ----------------------------------------------------------------------------
-- 4. seed：全域參數（${settingKeys.length} 個 key）。重跑會覆蓋回 seed 值（do update）。
-- ----------------------------------------------------------------------------
insert into public.quote_settings (key, value, updated_by)
values
${settingRows.join(',\n')}
on conflict (key) do update
  set value = excluded.value, updated_by = excluded.updated_by, updated_at = now();
`

/* ---------------------------------------------------------------- seed：品項 */

const productRows = products.map((p) =>
  row([q(p.id), q(p.family), q(p.category), q(p.name), q(p.plant), q(p.status), n(p.sort_order), j(p.config), q(SEED_BY)]),
)
const productsSql = `
-- ----------------------------------------------------------------------------
-- 5. seed：品項（${products.length} 筆，狀態 draft；要跑過 approved golden 才能在後台發布）
-- ----------------------------------------------------------------------------
insert into public.quote_products (id, family, category, name, plant, status, sort_order, config, updated_by)
values
${productRows.join(',\n')}
on conflict (id) do nothing;
`

/* ---------------------------------------------------------------- seed：golden */

const productIds = new Set(products.map((p) => p.id))
const FALLBACK_PRODUCT = 'keyring'
const goldenRows = []
const goldenNotes = []
for (const c of golden.cases) {
  const { input, settings: snap } = resolveGoldenCase(golden, c)
  let productId = c.product
  let name = c.name
  if (!productIds.has(productId)) {
    // 例如 hotstamp-board：品項還沒建，先掛在 keyring 底下當「畫板參考」，
    // 名稱前綴讓後台一眼看出它不是鑰匙圈的閘門；之後建了畫板品項再搬過去。
    goldenNotes.push(`${c.key}: 品項 '${productId}' 不存在，暫掛 '${FALLBACK_PRODUCT}' 並加「[畫板參考] 」前綴`)
    productId = FALLBACK_PRODUCT
    name = `[畫板參考] ${name}`
  }
  goldenRows.push(
    row([
      q(productId), q(name), q('proposed'), q(c.template_version), q(c.source_file), q(c.source_sheet), q(c.audit_note ?? null),
      j(input), j(snap), n(c.expected.cost), n(c.expected.price), n(0.01),
    ]),
  )
}
const goldenSql = `
-- ----------------------------------------------------------------------------
-- 6. seed：驗證案例（${golden.cases.length} 筆，全部 proposed；Snow 在後台核可才成閘門）
--    input 已由 same_as / input_override 展開成完整引擎輸入；settings_snapshot 是該檔當時常數
--    （例如 C款三筆的外形刀 9360，不是現價 21060）。
${goldenNotes.map((s) => `--    ※ ${s}`).join('\n')}
-- ----------------------------------------------------------------------------
insert into public.quote_golden_cases
  (product_id, name, status, template_version, source_file, source_sheet, audit_note, input, settings_snapshot, expected_cost, expected_price, tolerance)
values
${goldenRows.join(',\n')}
on conflict (product_id, name) do nothing;
`

/* ---------------------------------------------------------------- 組裝 */

const sql = [header, schema, rls, priceSql, settingsSql, productsSql, goldenSql, ''].join('\n')
writeFileSync(OUT, sql, 'utf8')

console.log(`已寫入 ${OUT.pathname}`)
console.log(`  資料表 ${TABLES.length} 張；price items ${priceItems.length}、settings ${settingKeys.length}、products ${products.length}、golden ${golden.cases.length}`)
for (const s of goldenNotes) console.log(`  ※ ${s}`)
