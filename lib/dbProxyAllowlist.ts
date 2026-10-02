/**
 * 瀏覽器端資料表代查（/api/db/rest/v1/<table>）的白名單。
 *
 * 背景（2026-09-27 資安修復）：
 *   前端 `lib/supabaseClient` 原本用公開的 anon key 直連 Supabase，任何拿到 EIP 登入頁
 *   JS bundle 的人都能不登入就 dump erp_so_lines（客戶地址＋單價）、erp_pj_sync（採購
 *   價格／付款）、members（email）…等生產資料表。
 *   修復後前端的 `.from()` 一律改打同源的 /api/db，由伺服器端驗過登入 cookie、對照這份
 *   白名單後，再以 service role 代查；Supabase 端則以 RLS + REVOKE 把 anon 完全擋掉
 *   （見 sql/20260927_lockdown_anon.sql）。
 *
 * 規則：
 *   - 不在名單上的表一律 404（含 rpc）。
 *   - read：'auth' = 任何登入者；或指定一個權限鍵（admin 自動通過，規則與 proxy.ts 一致）。
 *   - write：列出前端「目前實際會做」的操作；沒列的操作一律 405。
 *     操作名對應 HTTP 動詞：insert/upsert → POST、update → PATCH、delete → DELETE。
 *   - **members 刻意不在名單上**：個人收藏／個人資料走 /api/profile*，名冊走 /api/members/roster，
 *     通用代查會讓任何登入者 update 別人的 is_admin / permissions。
 *
 * ⚠️ 往後新增表若要給前端讀，先加到這裡；若不想給前端直讀（多數新表都是），就走專屬 API route。
 */

export type WriteOp = 'insert' | 'update' | 'delete'

/** 權限鍵；'auth' 表示只要登入即可 */
export type Requirement = 'auth' | 'production_admin' | 'system_settings'

export type TableRule = {
  read: Requirement
  write?: Partial<Record<WriteOp, Requirement>>
}

export const DB_PROXY_ALLOWLIST: Readonly<Record<string, TableRule>> = {
  // ── ERP 同步表（唯讀；寫入全在後端 sync route）────────────────────────────
  erp_so_lines: { read: 'auth' },
  erp_pj_sync: { read: 'auth' },
  erp_mo_lines: { read: 'auth' },
  erp_customers: { read: 'auth' },
  erp_material_prep_lines: { read: 'auth' },
  // 舊系統入庫單含成本／單價，只有每日出單表（/admin）會讀
  legacy_inventory_receipts: { read: 'production_admin' },

  // ── ARGO 派工／備料 ───────────────────────────────────────────────────────
  argoerp_mo_summary: { read: 'auth' },
  argoerp_mo_machine_assign: { read: 'auth' },
  argoerp_material_prep_log: { read: 'auth' },
  argoerp_mo_upload_log: { read: 'auth' },
  daily_order_sheets: { read: 'auth' },
  so_change_notices: { read: 'auth', write: { update: 'production_admin' } },
  app_settings: { read: 'auth', write: { insert: 'production_admin' } }, // upsert → POST

  // ── BOM／物料 ─────────────────────────────────────────────────────────────
  mm_bom_structure: { read: 'auth' },
  mm_bom_part_units: { read: 'auth' },
  bom_manual_supplement: { read: 'auth' },
  material_inventory_list: {
    read: 'auth',
    write: { insert: 'production_admin', delete: 'production_admin' },
  },
  material_substitute_rules: {
    read: 'auth',
    write: { insert: 'production_admin', update: 'production_admin', delete: 'production_admin' },
  },

  // ── 製程／工時（估算、製程產生器、admin/upload、admin/database）───────────
  item_routes: {
    read: 'auth',
    write: { insert: 'production_admin', update: 'production_admin', delete: 'production_admin' },
  },
  route_operations: {
    read: 'auth',
    write: { insert: 'production_admin', update: 'production_admin', delete: 'production_admin' },
  },
  operation_times: {
    read: 'auth',
    write: { insert: 'production_admin', update: 'production_admin', delete: 'production_admin' },
  },

  // ── SARA ──────────────────────────────────────────────────────────────────
  sara_wip_records: { read: 'auth' },
  sara_resources: { read: 'auth' },
  sara_exchange: { read: 'auth' },
  sara_101_master: {
    read: 'auth',
    write: { insert: 'production_admin', delete: 'production_admin' },
  },

  // ── 生產現場／品保 ────────────────────────────────────────────────────────
  production_machines: { read: 'auth' },
  production_notice_groups: { read: 'auth' },
  station_time_summary: { read: 'auth', write: { update: 'auth' } },
  schedule_anomaly_reports: {
    read: 'auth',
    write: { insert: 'auth', update: 'auth', delete: 'auth' },
  },
  qa_anomaly_option_items: {
    read: 'auth',
    write: { insert: 'auth', update: 'auth', delete: 'auth' },
  },

  // ── 協作／公告 ────────────────────────────────────────────────────────────
  tasks: { read: 'auth', write: { insert: 'auth', update: 'auth' } },
  task_messages: { read: 'auth', write: { insert: 'auth' } },
  info_board_posts: {
    read: 'auth',
    write: { insert: 'auth', update: 'auth', delete: 'auth' },
  },
  system_announcements: {
    read: 'auth',
    write: { insert: 'system_settings', update: 'system_settings', delete: 'system_settings' },
  },
  departments: {
    read: 'auth',
    write: { insert: 'system_settings', delete: 'system_settings' },
  },
  // 系統日誌：只有 /admin/system-logs 會讀；寫入一律走 /api/system-logs（操作者由伺服器認定）
  system_logs: { read: 'system_settings' },
}

const HTTP_METHOD_TO_OP: Record<string, WriteOp | 'read'> = {
  GET: 'read',
  HEAD: 'read',
  POST: 'insert',
  PATCH: 'update',
  DELETE: 'delete',
}

export type AccessDecision =
  | { ok: true; requirement: Requirement }
  | { ok: false; status: 404 | 405; reason: string }

/** 依表名 + HTTP 動詞判斷是否允許，以及需要什麼權限 */
export function decideAccess(table: string, method: string): AccessDecision {
  const rule = DB_PROXY_ALLOWLIST[table]
  if (!rule) return { ok: false, status: 404, reason: `資料表 ${table} 不開放前端直接存取` }

  const op = HTTP_METHOD_TO_OP[method.toUpperCase()]
  if (!op) return { ok: false, status: 405, reason: `不支援的方法 ${method}` }
  if (op === 'read') return { ok: true, requirement: rule.read }

  const req = rule.write?.[op]
  if (!req) return { ok: false, status: 405, reason: `資料表 ${table} 不開放前端 ${op}` }
  return { ok: true, requirement: req }
}

/**
 * 權限判斷，與 proxy.ts 的 hasPermission 同一套規則：
 *   - admin 全通過
 *   - system_settings 可由 production_admin 代替（沿用 proxy.ts 既有行為）
 */
export function memberSatisfies(
  member: { isAdmin: boolean; permissions: string[] },
  requirement: Requirement,
): boolean {
  if (requirement === 'auth') return true
  if (member.isAdmin) return true
  if (requirement === 'system_settings') {
    return member.permissions.includes('system_settings') || member.permissions.includes('production_admin')
  }
  return member.permissions.includes(requirement)
}

/**
 * PostgREST 的 select 可以「嵌入」關聯表（例如 `*, members(*)`），service role 又會繞過 RLS，
 * 所以要把 select 裡每一個「識別字後面直接接 (」的名稱都抓出來，逐一比對白名單。
 * 涵蓋語法：`rel(cols)`、`alias:rel(cols)`、`rel!hint(cols)`、`rel!inner(cols)`、`...rel(cols)`。
 * 聚合函數（`col.sum()`）也會被抓成 `sum` → 不在名單 → 拒絕，前端目前沒用到，可接受。
 */
export function findDisallowedEmbeds(select: string | null): string[] {
  if (!select) return []
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:!\s*[A-Za-z_][A-Za-z0-9_]*\s*)*\(/g
  const bad: string[] = []
  for (const m of select.matchAll(re)) {
    const rel = m[1]
    if (!DB_PROXY_ALLOWLIST[rel]) bad.push(rel)
  }
  return bad
}

/** PostgREST 查詢字串裡「不是篩選條件」的保留參數 */
const NON_FILTER_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

/** update / delete 至少要帶一個篩選條件，避免整表被改掉或清空 */
export function hasRowFilter(searchParams: URLSearchParams): boolean {
  for (const key of searchParams.keys()) {
    if (!NON_FILTER_PARAMS.has(key)) return true
  }
  return false
}
