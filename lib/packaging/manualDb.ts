// 包裝專區 P1 分線輪 — D66 手動加入的讀寫（I/O 層，lines.md §六）
//
// ⚠ 只寫 packaging_manual_inclusions；其餘（erp_so_lines、erp_pj_sync、erp_mo_lines、sara_*、daily_order_sheets）一律唯讀，
//   不查 ARGO（資料一律用 EIP 既有鏡像）。廠商代碼（customer_vendor）只在伺服器端推測途程類型，絕不回傳前端。
// 判定邏輯在純函式 manualLookup.ts／manualPool.ts；這裡只負責讀寫。

import { describeError } from '@/lib/supabaseAdmin'
import {
  type ManualInclusion,
  type ManualInclusionRow,
  type ManualRouteType,
} from '@/lib/packaging/scheduleTypes'
import { rowToManualInclusion } from '@/lib/packaging/scheduleMap'
import { ScheduleDbError, TBL, chunks, fetchAll, type SupabaseAdmin } from '@/lib/packaging/scheduleDb'
import { SO_SELECT, trimSheetRows } from '@/lib/packaging/pool'
import type { RawLot, RawRecord, RawSchedule, RawSheetRow, RawSoLine } from '@/lib/packaging/classify'
import type { ManualLookupPurchase } from '@/lib/packaging/manualLookup'

const IN_CHUNK = 100
/** 出單表往前看幾天（同 pool.ts SHEET_WINDOW_DAYS） */
const SHEET_WINDOW_DAYS = 365

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

// ─────────────────────────────────────────────────────────────────────
// packaging_manual_inclusions
// ─────────────────────────────────────────────────────────────────────

/** 有效（未移出）的手動加入（≤ MAX_ACTIVE_MANUAL，保險起見仍分頁） */
export async function loadActiveInclusions(sb: SupabaseAdmin): Promise<ManualInclusion[]> {
  const rows = await fetchAll<ManualInclusionRow>('讀取手動加入', (a, b) => sb
    .from(TBL.manual).select('*').is('removed_at', null).order('id', { ascending: true }).range(a, b))
  return rows.map(rowToManualInclusion)
}

export async function loadActiveInclusionsBySo(sb: SupabaseAdmin, so: string): Promise<ManualInclusion[]> {
  const { data, error } = await sb.from(TBL.manual).select('*').eq('so', so).is('removed_at', null).order('id', { ascending: true })
  if (error) throw new ScheduleDbError('讀取手動加入', error)
  return ((data ?? []) as ManualInclusionRow[]).map(rowToManualInclusion)
}

export async function loadActiveInclusionByKey(sb: SupabaseAdmin, soLineKey: string): Promise<ManualInclusion | null> {
  const { data, error } = await sb.from(TBL.manual).select('*').eq('so_line_key', soLineKey).is('removed_at', null).limit(1)
  if (error) throw new ScheduleDbError('讀取手動加入', error)
  const r = ((data ?? []) as ManualInclusionRow[])[0]
  return r ? rowToManualInclusion(r) : null
}

/**
 * 手動區塊快取的指紋（lines.md §六.4）：有效筆數＋最大 updated_at（一個請求）。
 * 加入／改量／移出都會改 updated_at 或筆數；寫入 API 另外直接清同一實例的快取。
 */
export async function manualFingerprint(sb: SupabaseAdmin): Promise<string> {
  const { data, count, error } = await sb.from(TBL.manual).select('updated_at', { count: 'exact' })
    .is('removed_at', null).order('updated_at', { ascending: false }).order('id', { ascending: false }).limit(1)
  if (error) throw new ScheduleDbError('讀取手動加入指紋', error)
  const r = ((data ?? []) as { updated_at: string }[])[0]
  // 移出會讓筆數變少；「移出 A 再加入 B」筆數相同但最大 updated_at 會變
  return `${count ?? 0}|${r ? String(r.updated_at) : ''}`
}

export async function countActiveInclusions(sb: SupabaseAdmin): Promise<number> {
  const { count, error } = await sb.from(TBL.manual).select('id', { count: 'exact', head: true }).is('removed_at', null)
  if (error) throw new ScheduleDbError('計算手動加入', error)
  return count ?? 0
}

export interface ManualInsert {
  soLineKey: string
  so: string
  lineNo: string
  qty: number
  routeType: ManualRouteType
  reason: string | null
}

/** 逐筆插入（部分唯一索引撞到＝同一行已有有效紀錄 → 該筆回 'duplicate'，其他照常） */
export async function insertInclusion(
  sb: SupabaseAdmin,
  v: ManualInsert,
  actor: { email: string; name: string | null },
  nowIso: string,
): Promise<ManualInclusion | 'duplicate'> {
  const { data, error } = await sb.from(TBL.manual).insert({
    so_line_key: v.soLineKey, so: v.so, line_no: v.lineNo, qty: v.qty, route_type: v.routeType, reason: v.reason,
    added_by: actor.email, added_by_name: actor.name, added_at: nowIso,
    updated_by: actor.email, updated_by_name: actor.name, updated_at: nowIso,
  }).select('*').single()
  if (error) {
    if ((error as { code?: string }).code === '23505') return 'duplicate'
    throw new ScheduleDbError('手動加入', error)
  }
  return rowToManualInclusion(data as ManualInclusionRow)
}

/** 改數量／途程類型／原因（只改有效紀錄） */
export async function updateInclusion(
  sb: SupabaseAdmin,
  id: number,
  patch: { qty?: number; route_type?: ManualRouteType; reason?: string | null },
  actor: { email: string; name: string | null },
  nowIso: string,
): Promise<ManualInclusion | null> {
  const { data, error } = await sb.from(TBL.manual)
    .update({ ...patch, updated_by: actor.email, updated_by_name: actor.name, updated_at: nowIso })
    .eq('id', id).is('removed_at', null).select('*')
  if (error) throw new ScheduleDbError('更新手動加入', error)
  const r = ((data ?? []) as ManualInclusionRow[])[0]
  return r ? rowToManualInclusion(r) : null
}

/** 多個 SO 行的有效紀錄（D102 寫後回讀用；每 100 行一次查詢） */
export async function loadActiveInclusionsByKeys(sb: SupabaseAdmin, keys: readonly string[]): Promise<ManualInclusion[]> {
  const out: ManualInclusion[] = []
  for (const part of chunks([...new Set(keys)], IN_CHUNK)) {
    const { data, error } = await sb.from(TBL.manual).select('*').in('so_line_key', part).is('removed_at', null)
    if (error) throw new ScheduleDbError('讀取手動加入', error)
    out.push(...((data ?? []) as ManualInclusionRow[]).map(rowToManualInclusion))
  }
  return out
}

/**
 * D102 寫後回讀：把一筆已移出的紀錄恢復成有效（排程工作台同一時間在這一行排了卡 → 那些卡需要這份供給）。
 * expect.removedAt 有給＝只撤回「這次」的移出（CAS：removed_at 仍是這次寫的值）；沒給＝只要還是已移出就恢復。
 * 23505（同一行剛被重新加入，部分唯一索引只允許一筆有效紀錄）→ 'duplicate'：新紀錄已提供供給，不必恢復。
 * 回 null＝CAS 沒對上（已被別人恢復或改動），不動。
 */
export async function unremoveInclusion(
  sb: SupabaseAdmin,
  id: number,
  expect: { removedAt?: string | null },
  actor: { email: string; name: string | null },
  nowIso: string,
): Promise<ManualInclusion | 'duplicate' | null> {
  const base = sb.from(TBL.manual)
    .update({ removed_at: null, removed_by: null, removed_by_name: null, removed_reason: null, updated_by: actor.email, updated_by_name: actor.name, updated_at: nowIso })
    .eq('id', id)
  const q = expect.removedAt ? base.eq('removed_at', expect.removedAt) : base.not('removed_at', 'is', null)
  const { data, error } = await q.select('*')
  if (error) {
    if ((error as { code?: string }).code === '23505') return 'duplicate'
    throw new ScheduleDbError('恢復手動加入', error)
  }
  const r = ((data ?? []) as ManualInclusionRow[])[0]
  return r ? rowToManualInclusion(r) : null
}

/**
 * D102 寫後回讀：把有效紀錄的欄位改回（CAS：只在 expect 的欄位值都還對得上時才改，免得蓋掉別人剛做的修改）。
 * 用途：PATCH 改量後回讀發現已排量超過新數量 → 改回這次之前的值；排程寫入後回讀發現數量剛被改低 → 恢復成排程驗證時的數量。
 */
export async function restoreInclusionFields(
  sb: SupabaseAdmin,
  id: number,
  expect: { updatedAt?: string; qty?: number },
  set: { qty?: number; route_type?: ManualRouteType; reason?: string | null },
  actor: { email: string; name: string | null },
  nowIso: string,
): Promise<ManualInclusion | null> {
  let q = sb.from(TBL.manual)
    .update({ ...set, updated_by: actor.email, updated_by_name: actor.name, updated_at: nowIso })
    .eq('id', id).is('removed_at', null)
  if (expect.updatedAt !== undefined) q = q.eq('updated_at', expect.updatedAt)
  if (expect.qty !== undefined) q = q.eq('qty', expect.qty)
  const { data, error } = await q.select('*')
  if (error) throw new ScheduleDbError('更新手動加入', error)
  const r = ((data ?? []) as ManualInclusionRow[])[0]
  return r ? rowToManualInclusion(r) : null
}

/** 移出待排池＝軟刪除（紀錄保留；移出後可再加入新列） */
export async function removeInclusion(
  sb: SupabaseAdmin,
  id: number,
  actor: { email: string; name: string | null },
  reason: string | null,
  nowIso: string,
): Promise<ManualInclusion | null> {
  const { data, error } = await sb.from(TBL.manual)
    .update({
      removed_at: nowIso, removed_by: actor.email, removed_by_name: actor.name, removed_reason: reason,
      updated_by: actor.email, updated_by_name: actor.name, updated_at: nowIso,
    })
    .eq('id', id).is('removed_at', null).select('*')
  if (error) throw new ScheduleDbError('移出手動加入', error)
  const r = ((data ?? []) as ManualInclusionRow[])[0]
  return r ? rowToManualInclusion(r) : null
}

// ─────────────────────────────────────────────────────────────────────
// EIP 鏡像（唯讀）
// ─────────────────────────────────────────────────────────────────────

/** 多張 SO 的 erp_so_lines（每 100 張一塊；手動區塊組裝用） */
export async function loadSoLinesForSos(sb: SupabaseAdmin, sos: readonly string[]): Promise<RawSoLine[]> {
  const uniq = [...new Set(sos.map((s) => s.trim().toUpperCase()).filter(Boolean))]
  const out: RawSoLine[] = []
  for (const part of chunks(uniq, IN_CHUNK)) {
    // SO_SELECT 是組合字串，supabase-js 推不出欄位型別 → 明確轉型
    const rows = await fetchAll<RawSoLine & { id: number }>('讀取 erp_so_lines', (a, b) => sb
      .from('erp_so_lines').select(SO_SELECT).in('project_id', part).order('id', { ascending: true })
      .range(a, b) as unknown as PromiseLike<{ data: (RawSoLine & { id: number })[] | null; error: unknown }>)
    out.push(...rows)
  }
  return out
}

/** GET /api/packaging/manual?so= 需要的鏡像資料（單張 SO 的小查詢並行，lines.md §六.1） */
export interface ManualLookupData {
  soLines: RawSoLine[]
  sheetRows: RawSheetRow[]
  lots: RawLot[]
  schedule: RawSchedule[]
  records: RawRecord[]
  purchases: ManualLookupPurchase[]
  moItemCodes: string[]
}

const RECORD_COLS = 'mo_nbr, product_name, lot_nbr, workcenter_name, job_name, job_sequence, status, source_type, wip_qty'

export async function loadManualLookupData(sb: SupabaseAdmin, so: string, today: string): Promise<ManualLookupData> {
  const digits = so.replace(/^[A-Z]+/, '')
  const safeDigits = /^\d{6,12}$/.test(digits) ? digits : null
  const q = <T>(label: string, p: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> =>
    Promise.resolve(p).then(({ data, error }) => {
      if (error) throw new ScheduleDbError(label, error)
      return (data ?? []) as T[]
    })

  const [soLines, sheetsRaw, lots, poRows, moRows, decodedRecords] = await Promise.all([
    q<RawSoLine>('讀取 erp_so_lines', sb.from('erp_so_lines').select(SO_SELECT).eq('project_id', so).order('id', { ascending: true }).limit(1000)),
    // 出單表：jsonb rows 含這張 SO 的列（近 365 天）
    q<{ sheet_date: string; rows: unknown }>('讀取出單表', sb.from('daily_order_sheets').select('sheet_date, rows')
      .gte('sheet_date', addDays(today, -SHEET_WINDOW_DAYS))
      // jsonb 包含查詢要傳 JSON 字串；.contains() 傳陣列會被組成 Postgres 陣列字面值 → 22P02（同 sketches.ts）
      .filter('rows', 'cs', JSON.stringify([{ order_number: so }]))
      .order('sheet_date', { ascending: true }).limit(60)),
    q<RawLot>('讀取塔台批', sb.from('sara_lot_progress').select('lot_id, mo_nbr, doc_nbr, so_line_no, product_name, lot_nbr, qty')
      .eq('doc_nbr', so).order('lot_id', { ascending: true }).limit(1000)),
    // 採購：來源單＝這張 SO（customer_vendor 只在伺服器端推測途程類型）
    q<{ doc_no: string; sub_no: string; item_code: string | null; customer_vendor: string | null; tpn_part_no: string | null }>('讀取採購',
      sb.from('erp_pj_sync').select('doc_no, sub_no, item_code, customer_vendor, tpn_part_no:extra->>TPN_PART_NO')
        .eq('doc_type', '採購單號').neq('status', 'VOID').gt('qty', 0)
        .or(`extra->>SO_PROJECT_ID.eq.${so},extra->>MBP_LOT_NO.eq.${so}`)
        .order('doc_no', { ascending: true }).order('sub_no', { ascending: true }).limit(1000)),
    q<{ mbp_part: string | null }>('讀取製令', sb.from('erp_mo_lines').select('mbp_part').eq('source_order', so).order('id', { ascending: true }).limit(1000)),
    // D47：MOT／MOS 製令號內含 SO 數字＋項次；舊式製令號＝SO 號本身
    safeDigits
      ? q<RawRecord>('讀取塔台報工', sb.from('sara_wip_records').select(RECORD_COLS)
        .or(`mo_nbr.like.MOT${safeDigits}*,mo_nbr.like.MOS${safeDigits}*,mo_nbr.eq.${so}`)
        .order('id', { ascending: true }).limit(3000))
      : Promise.resolve([] as RawRecord[]),
  ])

  const lotIds = lots.map((l) => l.lot_id).filter((x) => Number.isFinite(Number(x)))
  const lotMos = [...new Set(lots.map((l) => l.mo_nbr).filter(Boolean))]
  const [schedule, lotRecords] = await Promise.all([
    lotIds.length > 0
      ? q<RawSchedule>('讀取塔台排程', sb.from('sara_wip_schedule')
        .select('lot_id, mo_nbr, product_name, lot_nbr, workcenter_name, job_name, job_sequence, qty, wip_qty, system_status, plan_end_time')
        .in('lot_id', lotIds.slice(0, 200)).order('jid', { ascending: true }).limit(3000))
      : Promise.resolve([] as RawSchedule[]),
    lotMos.length > 0
      ? q<RawRecord>('讀取塔台報工', sb.from('sara_wip_records').select(RECORD_COLS).in('mo_nbr', lotMos.slice(0, 200)).order('id', { ascending: true }).limit(3000))
      : Promise.resolve([] as RawRecord[]),
  ])

  const seen = new Set<string>()
  const records: RawRecord[] = []
  for (const r of [...decodedRecords, ...lotRecords]) {
    const k = JSON.stringify([r.mo_nbr, r.product_name, r.lot_nbr, r.workcenter_name, r.job_name, r.job_sequence, r.status, r.source_type, r.wip_qty])
    if (seen.has(k)) continue
    seen.add(k)
    records.push(r)
  }
  const sheetRows = sheetsRaw.flatMap((s) => trimSheetRows(s.sheet_date, s.rows)).filter((r) => r.order_number === so)

  return {
    soLines,
    sheetRows,
    lots,
    schedule,
    records,
    purchases: poRows.map((p) => ({ docNo: p.doc_no, subNo: String(p.sub_no), itemCode: p.item_code, vendor: p.customer_vendor, soLineHint: p.tpn_part_no })),
    moItemCodes: moRows.map((m) => m.mbp_part ?? '').filter(Boolean),
  }
}

/** 寫入失敗時的 log（完整錯誤只進伺服器 log） */
export function logManualError(where: string, e: unknown): void {
  console.error(`[packaging/manual ${where}]`, describeError(e))
}
