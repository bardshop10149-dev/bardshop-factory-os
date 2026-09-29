// 包裝專區 — D104 結案的讀寫（I/O 層，lines.md 第十四章）
//
// ⚠ 只寫 packaging_closures、packaging_placements（刪該行未完成排定卡，id＋version 條件）、packaging_sim_sessions（version CAS
//   移除該行模擬卡）、packaging_op_log；其餘一律唯讀。不查 ARGO。
// 判定邏輯在純函式 closures.ts；這裡只負責讀寫。
// 結案表未建（migration sql/20260928d 未套用）：讀取回 available=false（待排池照舊、不排除），寫入丟 ScheduleDbError
// （pgCode PGRST205／42P01）由路由轉成 migration_required。

import { describeError } from '@/lib/supabaseAdmin'
import type { Closure, ClosureRow, PlacementSnapshotRow, YMD } from '@/lib/packaging/scheduleTypes'
import { rowToClosure, stripSimPlacementsForLine, taipeiDayRange } from '@/lib/packaging/closures'
import { ScheduleDbError, TBL, chunks, fetchAll, isMissingSchema, type SupabaseAdmin } from '@/lib/packaging/scheduleDb'
import type { Placement } from '@/lib/packaging/scheduleTypes'

export const CLOSURES_TABLE = 'packaging_closures'
/** AI 模擬區的表（只在這裡做「移除該行模擬卡」；表結構見 sql/20260928b_packaging_ai.sql 第 1 段） */
const SIM_SESSIONS_TABLE = 'packaging_sim_sessions'
export const CLOSURES_MIGRATION_FILE = 'sql/20260928d_packaging_closures.sql'

/** 未復原的結案讀取結果：available=false＝表不存在（migration 未套用），呼叫端當作沒有結案 */
export type ActiveClosures =
  | { available: true; closures: Closure[]; fingerprint: string }
  | { available: false; closures: Closure[]; fingerprint: string }

/**
 * 全部未復原的結案（同時是快取指紋：筆數＋最新 closed_at；結案讓筆數＋1 且 closed_at 最新、復原讓筆數 −1）。
 * 表不存在 → available=false（不丟錯：待排池／工作台不能因為結案表沒建就整頁 500）。
 * 其他錯誤照丟（讀取失敗不能默默當成「沒有結案」——那會讓已結案的卡跑回待排池）。
 */
export async function loadActiveClosures(sb: SupabaseAdmin): Promise<ActiveClosures> {
  try {
    const rows = await fetchAll<ClosureRow>('讀取結案', (a, b) => sb
      .from(CLOSURES_TABLE).select('*').is('restored_at', null).order('id', { ascending: true }).range(a, b))
    const closures = rows.map(rowToClosure)
    const latest = closures.reduce((m, c) => (c.closedAt > m ? c.closedAt : m), '')
    return { available: true, closures, fingerprint: `${closures.length}|${latest}` }
  } catch (e) {
    if (isMissingSchema(e)) return { available: false, closures: [], fingerprint: 'missing' }
    throw e
  }
}

export async function loadActiveClosureByKey(sb: SupabaseAdmin, soLineKey: string): Promise<Closure | null> {
  const { data, error } = await sb.from(CLOSURES_TABLE).select('*').eq('so_line_key', soLineKey).is('restored_at', null).limit(1)
  if (error) throw new ScheduleDbError('讀取結案', error)
  const r = ((data ?? []) as ClosureRow[])[0]
  return r ? rowToClosure(r) : null
}

/** 某張 SO 的未復原結案（D66 手動加入查詢標示「已結案」用）；表不存在 → 空陣列 */
export async function loadActiveClosuresBySo(sb: SupabaseAdmin, so: string): Promise<Closure[]> {
  const { data, error } = await sb.from(CLOSURES_TABLE).select('*').eq('so', so).is('restored_at', null).order('id', { ascending: true })
  if (error) {
    if (isMissingSchema(error)) return []
    throw new ScheduleDbError('讀取結案', error)
  }
  return ((data ?? []) as ClosureRow[]).map(rowToClosure)
}

export interface ClosureInsert {
  soLineKey: string
  so: string
  soLine: string
  itemCode: string | null
  itemName: string | null
  customer: string | null
  qtyAtClose: number
  dueDate: YMD | null
  blockAtClose: string | null
  soldQtyAtClose: number | null
  note: string | null
}

/** 新增結案；部分唯一索引撞到（同一行已有未復原的結案）→ 'duplicate' */
export async function insertClosure(
  sb: SupabaseAdmin,
  v: ClosureInsert,
  actor: { email: string; name: string | null },
  nowIso: string,
): Promise<Closure | 'duplicate'> {
  const { data, error } = await sb.from(CLOSURES_TABLE).insert({
    so_line_key: v.soLineKey, so: v.so, so_line: v.soLine,
    item_code: v.itemCode, item_name: v.itemName?.slice(0, 200) ?? null, customer: v.customer?.slice(0, 200) ?? null,
    qty_at_close: v.qtyAtClose, due_date: v.dueDate, block_at_close: v.blockAtClose, sold_qty_at_close: v.soldQtyAtClose,
    note: v.note,
    closed_by: actor.email, closed_by_name: actor.name, closed_at: nowIso,
  }).select('*').single()
  if (error) {
    if ((error as { code?: string }).code === '23505') return 'duplicate'
    throw new ScheduleDbError('結案', error)
  }
  return rowToClosure(data as ClosureRow)
}

/** 復原（只改未復原的那一列；已被別人復原 → null） */
export async function restoreClosure(
  sb: SupabaseAdmin,
  id: number,
  actor: { email: string; name: string | null },
  nowIso: string,
): Promise<Closure | null> {
  const { data, error } = await sb.from(CLOSURES_TABLE)
    .update({ restored_at: nowIso, restored_by: actor.email, restored_by_name: actor.name })
    .eq('id', id).is('restored_at', null).select('*')
  if (error) throw new ScheduleDbError('復原結案', error)
  const r = ((data ?? []) as ClosureRow[])[0]
  return r ? rowToClosure(r) : null
}

/** 已結案清單：closed_at 落在台北日 [from, to]（含首尾），含已復原的；最新在前，最多 limit 筆 */
export async function listClosures(sb: SupabaseAdmin, from: YMD, to: YMD, limit = 500): Promise<Closure[]> {
  const { startIso, endIso } = taipeiDayRange(from, to)
  const { data, error } = await sb.from(CLOSURES_TABLE).select('*')
    .gte('closed_at', startIso).lt('closed_at', endIso)
    .order('closed_at', { ascending: false }).order('id', { ascending: false }).limit(limit)
  if (error) throw new ScheduleDbError('讀取已結案清單', error)
  return ((data ?? []) as ClosureRow[]).map(rowToClosure)
}

// ─────────────────────────────────────────────────────────────────────
// 結案時：正式區該行未完成的排定卡「放回待排池」（＝刪除，同 unplace）
// ─────────────────────────────────────────────────────────────────────

/**
 * 以 id＋version 條件刪除（同 scheduleDb.writeApplied 第 1 段）；completed_at is null 再保險一次，已完成列絕不刪。
 * 沒刪到（version 已變＝工作台剛好動過那張卡）→ 重讀一次再刪，最多兩輪；仍沒刪到的留下（工作台會把它當
 * 「行已不在待排池」略過顯示，不影響數量守恆）。回傳實際刪除的列（op_log 用）。
 */
export async function unplaceOpenPlacements(sb: SupabaseAdmin, open: readonly Placement[]): Promise<Placement[]> {
  const deleted: Placement[] = []
  let pending = open.filter((p) => !p.completed)
  for (let round = 0; round < 2 && pending.length > 0; round++) {
    const gotIds = new Set<string>()
    for (const part of chunks(pending, 50)) {
      const filter = part.map((p) => `and(id.eq.${p.id},version.eq.${p.version})`).join(',')
      const { data, error } = await sb.from(TBL.placements).delete().or(filter).is('completed_at', null).select('id')
      if (error) throw new ScheduleDbError('結案時放回排定卡', error)
      for (const r of (data ?? []) as { id: string }[]) gotIds.add(r.id)
    }
    deleted.push(...pending.filter((p) => gotIds.has(p.id)))
    const missed = pending.filter((p) => !gotIds.has(p.id))
    if (missed.length === 0) break
    // 重讀：可能已被刪／已完成（不再處理）或 version 變了（下一輪用新 version 再刪一次）
    const { data, error } = await sb.from(TBL.placements).select('id, version, completed_at').in('id', missed.map((p) => p.id))
    if (error) throw new ScheduleDbError('結案時重讀排定卡', error)
    const cur = new Map(((data ?? []) as { id: string; version: number; completed_at: string | null }[]).map((r) => [r.id, r]))
    pending = missed.flatMap((p) => {
      const r = cur.get(p.id)
      return r && r.completed_at == null ? [{ ...p, version: Number(r.version) }] : []
    })
  }
  if (pending.length > 0) console.warn(`[packaging/closures] ${pending.length} 張排定卡兩輪都沒刪到（version 一直在變），留給工作台略過顯示`)
  return deleted
}

// ─────────────────────────────────────────────────────────────────────
// 結案時：從各人模擬區移除該行的模擬卡（packaging_sim_sessions.placements jsonb）
// ─────────────────────────────────────────────────────────────────────

type SimSessionSlice = { id: number | string; version: number | string; placements: unknown; locks: unknown }

/**
 * 每位主管一份模擬區（一列）；逐列：解析 placements（陣列）→ 拿掉 soLineKey＝該行的列、locks.placementIds 同步清掉
 * → update … where id = ? and version = 舊值（同 lib/packaging/ai/db.ts updateSimSessionCas：version + 1、updated_at）。
 * 0 列＝那份模擬區剛被主管或 AI 寫回改過 → 重讀一次再試，最多兩輪。undo 堆疊不動（退回上一步可能把該卡帶回模擬區，
 * 但採用時走正式寫入驗證：該行已不在待排池 → 擋下，不會寫進正式區）。
 * AI 表未建（migration 20260928b 未套用）→ 0（不丟錯）。回傳移除的模擬卡張數。
 */
export async function removeLineFromSimSessions(sb: SupabaseAdmin, soLineKey: string, nowIso: string): Promise<number> {
  const { data, error } = await sb.from(SIM_SESSIONS_TABLE).select('id, version, placements, locks')
  if (error) {
    if (isMissingSchema(error)) return 0
    throw new ScheduleDbError('讀取模擬區', error)
  }
  let removed = 0
  for (const row of (data ?? []) as SimSessionSlice[]) {
    let cur: SimSessionSlice | null = row
    for (let round = 0; round < 2 && cur; round++) {
      const placements = Array.isArray(cur.placements) ? (cur.placements as PlacementSnapshotRow[]) : []
      const locks = cur.locks && typeof cur.locks === 'object' && !Array.isArray(cur.locks)
        ? (cur.locks as { placementIds?: unknown })
        : { placementIds: [], soNumbers: [], lineIds: [] }
      const stripped = stripSimPlacementsForLine(placements, locks, soLineKey)
      if (stripped.removed === 0) break
      const expect = Number(cur.version)
      const { data: upd, error: uerr } = await sb.from(SIM_SESSIONS_TABLE)
        .update({ placements: stripped.placements, locks: stripped.locks, version: expect + 1, updated_at: nowIso })
        .eq('id', cur.id).eq('version', expect).select('id')
      if (uerr) throw new ScheduleDbError('模擬區移除結案行', uerr)
      if ((upd ?? []).length > 0) { removed += stripped.removed; break }
      // CAS 未命中：重讀這一份再試
      const reread: { data: unknown; error: { message: string } | null } = await sb.from(SIM_SESSIONS_TABLE)
        .select('id, version, placements, locks').eq('id', cur.id).maybeSingle()
      if (reread.error) throw new ScheduleDbError('重讀模擬區', reread.error)
      cur = (reread.data as SimSessionSlice | null) ?? null
      if (round === 1) console.warn(`[packaging/closures] 模擬區 #${row.id} 兩輪 CAS 都沒命中，${soLineKey} 的模擬卡未移除（採用時會被正式驗證擋下）`)
    }
  }
  return removed
}

/** 供路由 log 用（統一格式） */
export const closuresLog = (where: string, e: unknown) => console.error(`[packaging/closures ${where}]`, describeError(e))
