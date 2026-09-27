// 包裝專區 P1 — packaging_* 表的讀寫（I/O 層，規格 §3.7、§3.8、§3.9、§四）
//
// ⚠ 硬限制（規格 §〇）：本檔「只」讀寫 5 張 packaging_* 新表，絕不寫任何既有表、不回寫塔台（D4／D24）。
//   所有規則判斷在純函式（schedule*.ts），這裡只負責「照結果寫進去」。
//
// 沒有交易（PostgREST 一個請求一個敘述，本期 migration 也刻意不建 DB 函式，理由見規格 §3.8）：
//   - 多列寫入以「刪除 → 減量更新 → 新增／增量」順序執行，每列都帶 version 條件；
//     中途失敗的結果只會是「數量回到待排池」，永遠不會超排。
//   - 編輯鎖用「where token = 舊 token」的單一 UPDATE 做 compare-and-set（單一敘述即原子）。
// PostgREST 單次上限 1000 列：列表查詢一律分頁＋固定排序；in() 每 100 個一塊。

import type { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { describeError } from '@/lib/supabaseAdmin'
import {
  LOCK_IDLE_MS,
  VERSION_RETENTION_DAYS,
  type DailyCapacity,
  type DailyCapacityRow,
  type EditLockRow,
  type LockPlan,
  type LockState,
  type Placement,
  type PlacementRow,
  type ScheduleSnapshot,
  type ScheduleVersionRow,
  type VersionMeta,
  type VersionSource,
} from '@/lib/packaging/scheduleTypes'
import { placementToRow, rowToCapacity, rowToPlacement, versionRowToMeta } from '@/lib/packaging/scheduleMap'
import { evaluateLock } from '@/lib/packaging/scheduleLock'
import { openContribution, isUuid, type ApplyOk } from '@/lib/packaging/scheduleOps'

export type SupabaseAdmin = ReturnType<typeof getSupabaseAdminClient>

export const TBL = {
  placements: 'packaging_placements',
  capacity: 'packaging_daily_capacity',
  versions: 'packaging_schedule_versions',
  lock: 'packaging_edit_lock',
  opLog: 'packaging_op_log',
} as const

const PAGE = 1000
const IN_CHUNK = 100
const INSERT_CHUNK = 500

/** 取出 PostgREST／Postgres 錯誤碼（PGRST205、42P01、23505…）；只給碼，不含 message／details（可能帶列內容） */
function pgCodeOf(e: unknown): string | null {
  if (e && typeof e === 'object') {
    const c = (e as { code?: unknown; pgCode?: unknown }).pgCode ?? (e as { code?: unknown }).code
    if (typeof c === 'string' && /^[A-Z0-9]{3,10}$/.test(c)) return c
  }
  return null
}

export class ScheduleDbError extends Error {
  /** 原始錯誤碼（回給前端只給這個，完整訊息只寫伺服器 log） */
  readonly pgCode: string | null
  constructor(label: string, e: unknown) {
    super(`${label}：${describeError(e)}`)
    this.name = 'ScheduleDbError'
    this.pgCode = pgCodeOf(e)
  }
}

/** 資料表不存在（migration 未套用）的錯誤碼 */
const MISSING_TABLE_CODES = new Set(['PGRST205', '42P01'])

/**
 * 回給前端的錯誤訊息：固定中文＋錯誤碼，不帶 PostgREST 的 message／details／hint
 * （details 可能是 'Failing row contains (...)'，會帶出 email 等列內容；表名、constraint 名也不外露）。
 * 完整錯誤由呼叫端 console.error 到伺服器 log。
 * 「資料表尚未建立」保留 PGRST205／42P01 字樣——前端 boardApi 的 isMissingTableMessage 靠它提示套用 migration。
 */
export function publicDbError(e: unknown, what = '資料庫存取'): string {
  const code = pgCodeOf(e)
  if (code && MISSING_TABLE_CODES.has(code)) return `找不到資料表（${code}），請先套用 migration`
  return `${what}失敗${code ? `（${code}）` : ''}，請稍後再試`
}

type PgResult<T> = { data: T[] | null; error: unknown }

async function fetchAll<T>(label: string, page: (from: number, to: number) => PromiseLike<PgResult<T>>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new ScheduleDbError(label, error)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

function chunks<T>(arr: readonly T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

// ─────────────────────────────────────────────────────────────────────
// 擺放：讀
// ─────────────────────────────────────────────────────────────────────

export async function loadOpenPlacements(sb: SupabaseAdmin): Promise<Placement[]> {
  const rows = await fetchAll<PlacementRow>('讀取未完成擺放', (a, b) => sb
    .from(TBL.placements).select('*').is('completed_at', null).order('id', { ascending: true }).range(a, b))
  return rows.map(rowToPlacement)
}

/** 已完成且 plan_date ≥ from（視窗內要變灰顯示的完成卡） */
export async function loadCompletedSince(sb: SupabaseAdmin, from: string): Promise<Placement[]> {
  const rows = await fetchAll<PlacementRow>('讀取已完成擺放', (a, b) => sb
    .from(TBL.placements).select('*').not('completed_at', 'is', null).gte('plan_date', from)
    .order('id', { ascending: true }).range(a, b))
  return rows.map(rowToPlacement)
}

/** 指定 SO 行的擺放（completedOnly：只要已完成的——board 算「未反映完成量 U」用） */
export async function loadPlacementsByLines(sb: SupabaseAdmin, lineKeys: readonly string[], opts: { completedOnly?: boolean } = {}): Promise<Placement[]> {
  // 待排池約上千行＝十幾塊；每 6 塊並行一輪（比照 P0 pool.ts 的 CONCURRENCY），避免逐塊串行拖慢 board
  const parts = chunks([...new Set(lineKeys)], IN_CHUNK)
  const out: Placement[] = []
  for (let i = 0; i < parts.length; i += 6) {
    const got = await Promise.all(parts.slice(i, i + 6).map((part) => fetchAll<PlacementRow>('讀取 SO 行擺放', (a, b) => {
      let q = sb.from(TBL.placements).select('*').in('so_line_key', part)
      if (opts.completedOnly) q = q.not('completed_at', 'is', null)
      return q.order('id', { ascending: true }).range(a, b)
    })))
    for (const rows of got) out.push(...rows.map(rowToPlacement))
  }
  return out
}

export async function loadPlacementsByIds(sb: SupabaseAdmin, ids: readonly string[]): Promise<Placement[]> {
  const valid = [...new Set(ids)].filter(isUuid) // 非 uuid 字串丟進 uuid 欄位的 in() 會讓整個查詢報錯
  const out: Placement[] = []
  for (const part of chunks(valid, IN_CHUNK)) {
    const { data, error } = await sb.from(TBL.placements).select('*').in('id', part)
    if (error) throw new ScheduleDbError('讀取擺放', error)
    out.push(...((data ?? []) as PlacementRow[]).map(rowToPlacement))
  }
  return out
}

async function loadPlacementById(sb: SupabaseAdmin, id: string): Promise<Placement | null> {
  const { data, error } = await sb.from(TBL.placements).select('*').eq('id', id).maybeSingle()
  if (error) return null
  return data ? rowToPlacement(data as PlacementRow) : null
}

/**
 * GET board 的便宜指紋（D52 輪詢）：整張擺放表的列數＋最大 updated_at，一個請求（count=exact＋limit 1）。
 * 先用它與 op_log 最大 id、待排池內容摘要算 revision，沒變就不必讀全部擺放。
 */
export async function getPlacementsFingerprint(sb: SupabaseAdmin): Promise<{ count: number; maxUpdatedAt: string | null }> {
  const { data, count, error } = await sb.from(TBL.placements).select('updated_at', { count: 'exact' })
    .order('updated_at', { ascending: false }).order('id', { ascending: false }).limit(1)
  if (error) throw new ScheduleDbError('讀取擺放指紋', error)
  const r = ((data ?? []) as { updated_at: string }[])[0]
  return { count: count ?? 0, maxUpdatedAt: r ? String(r.updated_at) : null }
}

/** 全表未完成擺放張數（寫入前的總量上限檢查用） */
export async function countOpenPlacements(sb: SupabaseAdmin): Promise<number> {
  const { count, error } = await sb.from(TBL.placements).select('id', { count: 'exact', head: true }).is('completed_at', null)
  if (error) throw new ScheduleDbError('計算未完成擺放', error)
  return count ?? 0
}

/** 各日期（plan_date）的未完成卡數（關閉週六加班前檢查用，D48） */
export async function countOpenByDates(sb: SupabaseAdmin, dates: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (dates.length === 0) return out
  const rows = await fetchAll<{ id: string; plan_date: string }>('讀取週六卡數', (a, b) => sb
    .from(TBL.placements).select('id, plan_date').is('completed_at', null).in('plan_date', [...new Set(dates)])
    .order('id', { ascending: true }).range(a, b))
  for (const r of rows) { const d = String(r.plan_date).slice(0, 10); out.set(d, (out.get(d) ?? 0) + 1) }
  return out
}

// ─────────────────────────────────────────────────────────────────────
// 擺放：寫（規格 §3.8「先減後增」）
// ─────────────────────────────────────────────────────────────────────

export type WriteFail = {
  ok: false
  code: 'version_conflict' | 'id_exists' | 'db_error'
  message: string
  /** 前面已有步驟寫入（無交易；前端收到一律重新載入並清空 Undo／Redo） */
  partial: boolean
  current?: Placement | null
}

/** 寫入失敗：完整錯誤只進伺服器 log，回應用 publicDbError */
function dbFail(error: unknown, partial: boolean): WriteFail {
  console.error('[packaging/writeApplied]', describeError(error))
  return { ok: false, code: 'db_error', message: publicDbError(error, '寫入擺放'), partial }
}

const mutablePatch = (p: Placement) => {
  const r = placementToRow(p)
  return {
    qty: r.qty, plan_date: r.plan_date, original_date: r.original_date, source: r.source, origin_card_id: r.origin_card_id,
    completed_at: r.completed_at, completed_by: r.completed_by, completed_by_name: r.completed_by_name,
    completed_pool_qty: r.completed_pool_qty, version: r.version,
    updated_by: r.updated_by, updated_by_name: r.updated_by_name, updated_at: r.updated_at,
  }
}

/**
 * 依 applyOps 的結果寫入：
 * 1. 刪除：or(and(id,version),…) 一個請求一塊，回傳筆數不符 → version_conflict
 * 2. 減量／不變量的更新（對「未完成總量」的貢獻沒有增加：move、split 原卡、complete、setQty 減少…）：逐列 eq(id).eq(version)
 * 3. 新增（bulk insert；主鍵衝突 → id_exists）與增量更新（merge 目標、setQty 增加、uncomplete）
 */
export async function writeApplied(sb: SupabaseAdmin, applied: ApplyOk): Promise<{ ok: true; rows: Placement[]; deletedIds: string[] } | WriteFail> {
  let wrote = false
  const rows: Placement[] = []
  const deletedIds: string[] = []
  const conflict = async (id: string, message: string): Promise<WriteFail> =>
    ({ ok: false, code: 'version_conflict', message, partial: wrote, current: await loadPlacementById(sb, id) })

  // 1. 刪除
  for (const part of chunks(applied.deletes, 50)) {
    const filter = part.map((p) => `and(id.eq.${p.id},version.eq.${p.version})`).join(',')
    const { data, error } = await sb.from(TBL.placements).delete().or(filter).select('id')
    if (error) return dbFail(error, wrote)
    const got = new Set(((data ?? []) as { id: string }[]).map((r) => r.id))
    if (got.size > 0) wrote = true
    deletedIds.push(...got)
    const missing = part.find((p) => !got.has(p.id))
    if (missing) return conflict(missing.id, '要移除的卡已被其他操作更新或刪除')
  }

  const decreasing = applied.updates.filter((u) => openContribution(u.after) <= openContribution(u.before))
  const increasing = applied.updates.filter((u) => openContribution(u.after) > openContribution(u.before))

  const updateOne = async (u: { before: Placement; after: Placement }): Promise<WriteFail | null> => {
    const { data, error } = await sb.from(TBL.placements).update(mutablePatch(u.after))
      .eq('id', u.before.id).eq('version', u.before.version).select('*')
    if (error) return dbFail(error, wrote)
    const got = (data ?? []) as PlacementRow[]
    if (got.length === 0) return conflict(u.before.id, '這張卡已被其他操作更新，請重新整理')
    wrote = true
    rows.push(rowToPlacement(got[0]))
    return null
  }

  // 2. 減量／不變量
  for (const u of decreasing) { const f = await updateOne(u); if (f) return f }

  // 3a. 新增
  for (const part of chunks(applied.inserts, INSERT_CHUNK)) {
    const { data, error } = await sb.from(TBL.placements).insert(part.map(placementToRow)).select('*')
    if (error) {
      const code = (error as { code?: string }).code
      if (code === '23505') return { ok: false, code: 'id_exists', message: '卡片 id 重複，請重新整理', partial: wrote }
      return dbFail(error, wrote)
    }
    wrote = true
    rows.push(...((data ?? []) as PlacementRow[]).map(rowToPlacement))
  }
  // 3b. 增量
  for (const u of increasing) { const f = await updateOne(u); if (f) return f }

  return { ok: true, rows, deletedIds }
}

/** 快照還原：刪除指定的未完成擺放（completed_at is null 再保險一次，已完成列絕不刪） */
export async function deleteOpenPlacements(sb: SupabaseAdmin, ids: readonly string[]): Promise<number> {
  let n = 0
  for (const part of chunks(ids, IN_CHUNK)) {
    const { data, error } = await sb.from(TBL.placements).delete().in('id', part).is('completed_at', null).select('id')
    if (error) throw new ScheduleDbError('刪除未完成擺放', error)
    n += (data ?? []).length
  }
  return n
}

export async function insertPlacements(sb: SupabaseAdmin, list: readonly Placement[]): Promise<Placement[]> {
  const out: Placement[] = []
  for (const part of chunks(list, INSERT_CHUNK)) {
    const { data, error } = await sb.from(TBL.placements).insert(part.map(placementToRow)).select('*')
    if (error) throw new ScheduleDbError('寫入擺放', error)
    out.push(...((data ?? []) as PlacementRow[]).map(rowToPlacement))
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────
// 產能（D49）
// ─────────────────────────────────────────────────────────────────────

export async function loadCapacityRows(sb: SupabaseAdmin, from: string, to?: string): Promise<DailyCapacity[]> {
  const rows = await fetchAll<DailyCapacityRow>('讀取產能', (a, b) => {
    let q = sb.from(TBL.capacity).select('*').gte('date', from)
    if (to) q = q.lte('date', to)
    return q.order('date', { ascending: true }).range(a, b)
  })
  return rows.map(rowToCapacity)
}

export async function upsertCapacity(sb: SupabaseAdmin, rows: readonly Omit<DailyCapacityRow, 'updated_at'>[], nowIso: string): Promise<void> {
  if (rows.length === 0) return
  const { error } = await sb.from(TBL.capacity).upsert(rows.map((r) => ({ ...r, updated_at: nowIso })), { onConflict: 'date' })
  if (error) throw new ScheduleDbError('儲存產能', error)
}

export async function deleteCapacity(sb: SupabaseAdmin, dates: readonly string[]): Promise<void> {
  if (dates.length === 0) return
  const { error } = await sb.from(TBL.capacity).delete().in('date', [...dates])
  if (error) throw new ScheduleDbError('清除產能', error)
}

// ─────────────────────────────────────────────────────────────────────
// 編輯鎖（D53）
// ─────────────────────────────────────────────────────────────────────

export async function readLockRow(sb: SupabaseAdmin): Promise<EditLockRow | null> {
  const { data, error } = await sb.from(TBL.lock).select('*').eq('id', 1).maybeSingle()
  if (error) throw new ScheduleDbError('讀取編輯鎖', error)
  return (data as EditLockRow | null) ?? null
}

/** migration 已插入 id=1；萬一被刪掉，補一列空鎖（只動 packaging_edit_lock） */
export async function ensureLockRow(sb: SupabaseAdmin): Promise<EditLockRow> {
  const row = await readLockRow(sb)
  if (row) return row
  const { error } = await sb.from(TBL.lock).upsert({ id: 1 }, { onConflict: 'id', ignoreDuplicates: true })
  if (error) throw new ScheduleDbError('建立編輯鎖列', error)
  const again = await readLockRow(sb)
  if (!again) throw new ScheduleDbError('建立編輯鎖列', '寫入後仍讀不到')
  return again
}

/** planLockAction 的 update 計畫 → compare-and-set（token 為條件）。0 列＝期間有人搶先，回 null */
export async function casLock(sb: SupabaseAdmin, plan: Extract<LockPlan, { kind: 'update' }>): Promise<EditLockRow | null> {
  let q = sb.from(TBL.lock).update(plan.patch).eq('id', 1)
  q = plan.expectToken == null ? q.is('token', null) : q.eq('token', plan.expectToken)
  const { data, error } = await q.select('*')
  if (error) throw new ScheduleDbError('更新編輯鎖', error)
  const rows = (data ?? []) as EditLockRow[]
  return rows[0] ?? null
}

/**
 * 寫入 API 第一步：驗鎖＋續命（規格 §3.7），一條條件 UPDATE：
 *   where id = 1 and token = :t and holder_email = :email and last_action_at >= now − 5 分
 * 0 列 → 重讀 → 別人有效持有回 lock_lost，否則 lock_required。
 * 已知限制：驗鎖與寫入之間仍有毫秒級空窗（無交易，規格 §9.1 第 2 條）。
 */
export async function verifyAndTouchLock(
  sb: SupabaseAdmin,
  caller: { email: string; token: string | null | undefined },
  nowMs: number,
): Promise<{ ok: true; row: EditLockRow; lock: LockState } | { ok: false; code: 'lock_required' | 'lock_lost'; lock: LockState }> {
  const token = typeof caller.token === 'string' ? caller.token : null
  const who = { email: caller.email, token }
  if (token && isUuid(token)) {
    const now = new Date(nowMs).toISOString()
    const { data, error } = await sb.from(TBL.lock)
      .update({ last_action_at: now, heartbeat_at: now, updated_at: now })
      .eq('id', 1).eq('token', token).eq('holder_email', caller.email)
      .gte('last_action_at', new Date(nowMs - LOCK_IDLE_MS).toISOString())
      .select('*')
    if (error) throw new ScheduleDbError('驗證編輯鎖', error)
    const row = ((data ?? []) as EditLockRow[])[0]
    if (row) return { ok: true, row, lock: evaluateLock(row, nowMs, who) }
  }
  const cur = await readLockRow(sb)
  const lock = evaluateLock(cur, nowMs, who)
  return { ok: false, code: lock.held && !lock.isMine ? 'lock_lost' : 'lock_required', lock }
}

// ─────────────────────────────────────────────────────────────────────
// 操作紀錄、指紋
// ─────────────────────────────────────────────────────────────────────

export type OpLogKind = 'placements' | 'complete' | 'capacity' | 'version_create' | 'version_restore' | 'lock'

/** 寫入成功後記一列；失敗只 console.error，不影響回應（規格 §3.8） */
export async function insertOpLog(
  sb: SupabaseAdmin,
  e: { actorEmail: string; actorName: string | null; kind: OpLogKind; label?: string | null; ops: unknown },
): Promise<number | null> {
  try {
    const { data, error } = await sb.from(TBL.opLog)
      .insert({ actor_email: e.actorEmail, actor_name: e.actorName, kind: e.kind, label: e.label ?? null, ops: e.ops ?? [] })
      .select('id').single()
    if (error) { console.error('[packaging/op_log]', describeError(error)); return null }
    return Number((data as { id: number | string }).id)
  } catch (err) {
    console.error('[packaging/op_log]', describeError(err))
    return null
  }
}

export async function getOpLogMaxId(sb: SupabaseAdmin): Promise<number> {
  const { data, error } = await sb.from(TBL.opLog).select('id').order('id', { ascending: false }).limit(1)
  if (error) throw new ScheduleDbError('讀取操作紀錄', error)
  const r = (data ?? [])[0] as { id: number | string } | undefined
  return r ? Number(r.id) : 0
}

// ─────────────────────────────────────────────────────────────────────
// 版本快照（D33）
// ─────────────────────────────────────────────────────────────────────

const VERSION_META_COLS = 'id, label, source, placement_count, created_by, created_by_name, created_at'

export async function listVersions(sb: SupabaseAdmin, nowMs: number, limit = 200): Promise<VersionMeta[]> {
  const since = new Date(nowMs - VERSION_RETENTION_DAYS * 86_400_000).toISOString()
  const { data, error } = await sb.from(TBL.versions).select(VERSION_META_COLS)
    .gte('created_at', since).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit)
  if (error) throw new ScheduleDbError('讀取版本', error)
  return ((data ?? []) as Omit<ScheduleVersionRow, 'snapshot'>[]).map(versionRowToMeta)
}

export async function getVersionRow(sb: SupabaseAdmin, id: number): Promise<ScheduleVersionRow | null> {
  const { data, error } = await sb.from(TBL.versions).select('*').eq('id', id).maybeSingle()
  if (error) throw new ScheduleDbError('讀取版本', error)
  return (data as ScheduleVersionRow | null) ?? null
}

export async function insertVersion(
  sb: SupabaseAdmin,
  v: { label: string; source: VersionSource; snapshot: ScheduleSnapshot; actorEmail: string; actorName: string | null },
): Promise<VersionMeta> {
  const { data, error } = await sb.from(TBL.versions).insert({
    label: v.label.slice(0, 80), source: v.source, snapshot: v.snapshot,
    placement_count: v.snapshot.placements.length, created_by: v.actorEmail, created_by_name: v.actorName,
  }).select(VERSION_META_COLS).single()
  if (error) throw new ScheduleDbError('儲存版本', error)
  return versionRowToMeta(data as Omit<ScheduleVersionRow, 'snapshot'>)
}

/** 某人最近一次建立某來源版本的時間（手動建立版本的節流用） */
export async function latestVersionAt(sb: SupabaseAdmin, email: string, source: VersionSource): Promise<string | null> {
  const { data, error } = await sb.from(TBL.versions).select('created_at')
    .eq('created_by', email).eq('source', source).order('created_at', { ascending: false }).limit(1)
  if (error) throw new ScheduleDbError('讀取版本', error)
  const r = ((data ?? []) as { created_at: string }[])[0]
  return r ? String(r.created_at) : null
}

/** D33 保留 90 天：建立／還原版本時順手刪（不建排程工作）；失敗只記 log */
export async function deleteExpiredVersions(sb: SupabaseAdmin, nowMs: number): Promise<void> {
  const cutoff = new Date(nowMs - VERSION_RETENTION_DAYS * 86_400_000).toISOString()
  const { error } = await sb.from(TBL.versions).delete().lt('created_at', cutoff)
  if (error) console.error('[packaging/versions] 清除過期版本失敗:', describeError(error))
}
