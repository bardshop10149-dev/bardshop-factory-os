// 包裝專區 — D111 ARGO 採購入庫同步（I/O 層，server-side only：用到 ARGO 帳密與 Supabase service role）
//
// ARGO：只讀（S_APIKEY／S_QUERY，經 lib/argoQuery.ts argoQueryStrict），絕不呼叫任何 ARGO 寫入介面。
// Supabase：只寫 erp_po_receipts、erp_po_receipts_sync 兩張表；erp_pj_sync、erp_so_lines 唯讀（取「範圍內的採購單」）。
//
// 資料源：IV_INVENTORYIODETAIL，IO_TYPE='I'、IO_ACTION='BUY'（採購入庫）。欄位：
//   PDL_PJT_PROJECT_ID（採購單號）、PJD_LINE_NO（採購行號）、ISM_MBP_PART（品號）、ISM_MBP_LOT_NO（來源 SO）、
//   QTY、IO_DATE（'YYYY/MM/DD HH:MM:SS' 文字）、SLIP_NO（入庫單號）
//   ⚠ 已踩過的坑：CUSTOMCOLUMN 寫了不存在的欄位（例：PDL_LINE_NO）ARGO 不報錯、靜默回 0 筆。
//     「回 0 筆」會被整張重算覆蓋當成「入庫全部作廢」而清掉鏡像 → 本檔有兩道防線：
//       (1) 一批回 0 筆、但鏡像裡這批有 ≥ SILENT_EMPTY_MIN_DOCS 張採購單有資料 → 視為異常，這批不寫不刪、記錯誤
//       (2) 有回明細但彙總後 0 列（行號／日期欄全空）→ 同樣視為異常
//     改欄位清單（RECEIPT_COLUMNS）後務必先用 dry=1 對真實 ARGO 跑一次，確認 argoRows > 0。
//
// 同步單位＝「一整張採購單」：作廢的入庫單在 ARGO 會整筆消失，所以每次都把這張採購單在 ARGO 的全部入庫重新彙總，
//   upsert 新值、刪掉 ARGO 已不存在的（行, 日）列（純函式 planReceiptMirrorWrite）。
//   範圍（scope）＝待排池來源用到的採購單：erp_pj_sync 採購行（近 180 天開單、未作廢、有來源 SO／RO）中，
//                  來源單在 erp_so_lines 還查得到（＝SO 未結案）的那些採購單。與 pool.ts fetchPoLines 同條件。
//   full        ＝ 範圍內全部採購單分批重算；完整跑完再清掉「已不在範圍內」的採購單的鏡像列
//   incremental ＝（近 N 天 IO_DATE 有入庫的採購單 ∪ 鏡像裡近 N 天有入庫的採購單）∩ 範圍
//                 （近期作廢的入庫單在 ARGO 已查不到，要靠鏡像找回來重算）
// ARGO 限制：S_QUERY 動態 WHERE 是 VARCHAR2(4000) → IN 清單每批 60 張；常逾時 → 每次查詢有逾時、
//   網路／逾時／5xx 重試（最多 3 次），整體有時間預算（route maxDuration 300 秒）。
// dryRun：只查 ARGO、不寫 Supabase，而且「完全不碰新表」（新表還沒建也能跑；只讀既有的 erp_pj_sync、erp_so_lines）。

import type { SupabaseAdmin } from '@/lib/packaging/scheduleDb'
import { describeError } from '@/lib/supabaseAdmin'
import { ArgoQueryError, argoConfigured, argoQueryStrict } from '@/lib/argoQuery'
import { sourceOrderOf } from '@/lib/packaging/classify'
import {
  RECEIPT_SYNC_DEFAULT_DAYS,
  RECEIPT_SYNC_MAX_DAYS,
  aggregateReceiptDetail,
  normDoc,
  planReceiptMirrorWrite,
  type PoReceiptRow,
  type ReceiptDetailRow,
  type ReceiptKey,
  type ReceiptSyncMode,
  type ReceiptSyncStats,
} from '@/lib/packaging/receipts'
import { addDays } from '@/lib/packaging/scheduleCalendar'
import { todayTaipei } from '@/lib/packaging/workdays'

export const RECEIPTS_TABLE = 'erp_po_receipts'
export const RECEIPTS_SYNC_TABLE = 'erp_po_receipts_sync'
export const RECEIPTS_MIGRATION_FILE = 'sql/20260930_packaging_po_receipts.sql'

/** ARGO IN 清單每批幾張採購單（VARCHAR2 4000 字上限；同銷貨同步） */
export const ARGO_PO_BATCH = 60
/** 採購行只看近 180 天開單（同 pool.ts PO_WINDOW_DAYS；範圍要和待排池一致） */
const PO_WINDOW_DAYS = 180
const ARGO_CONCURRENCY = 3
const ARGO_TIMEOUT_MS = 90_000
const ARGO_ATTEMPTS = 3
const RETRY_DELAYS_MS = [2_000, 5_000]
/** 剩不到這麼多時間就不再開新批次／不再重試 */
const MIN_BATCH_BUDGET_MS = 20_000
const PAGE = 1000
const IN_CHUNK = 100
/** ⚠ 欄位名錯了 ARGO 不報錯、靜默回 0 筆（見檔頭）；改這一行後先用 dry=1 驗證 */
const RECEIPT_COLUMNS = 'PDL_PJT_PROJECT_ID,PJD_LINE_NO,ISM_MBP_PART,ISM_MBP_LOT_NO,QTY,IO_DATE,SLIP_NO'
/** 一批回 0 筆、而鏡像裡這批有這麼多張採購單有資料 → 當成「靜默回空」異常，不清鏡像 */
const SILENT_EMPTY_MIN_DOCS = 3
/**
 * 採購單號白名單：要原樣拼進 ARGO 的 Oracle WHERE（IN ('…')），只允許英數與連字號（另外仍把單引號加倍）。
 * 來源是 erp_pj_sync 與 ARGO 本身，但這是「字串拼 SQL」，一律先驗再用（不信任任何進 SQL 的字串）。
 */
const PO_ID_RE = /^[A-Z0-9][A-Z0-9-]{2,39}$/

const MISSING_TABLE_CODES = new Set(['PGRST205', '42P01'])
function pgCodeOf(e: unknown): string | null {
  const c = e && typeof e === 'object' ? (e as { code?: unknown }).code : null
  return typeof c === 'string' ? c : null
}
const isMissingTable = (e: unknown) => MISSING_TABLE_CODES.has(pgCodeOf(e) ?? '')

export class ReceiptSyncError extends Error {
  readonly code: 'migration_required' | 'db_error' | 'argo_error' | 'argo_unconfigured'
  constructor(code: ReceiptSyncError['code'], message: string) {
    super(message)
    this.name = 'ReceiptSyncError'
    this.code = code
  }
}

// ─────────────────────────────────────────────────────────────────────
// 鏡像讀取（pool.ts 用；GET 不寫入）
// ─────────────────────────────────────────────────────────────────────

export interface ReceiptSyncStatus {
  lastIncrementalAt: string | null
  lastFullAt: string | null
  lastOkAt: string | null
  lastError: string | null
  rowsUpserted: number | null
  updatedAt: string | null
}

export type ReceiptMirrorRow = Pick<PoReceiptRow, 'poDocNo' | 'poLineNo' | 'receiptDate' | 'qty'>

export type ReceiptMirror =
  | { available: true; rows: ReceiptMirrorRow[]; status: ReceiptSyncStatus | null }
  /** missing＝新表不存在（migration 未套用）；error＝讀取失敗（網路等） */
  | { available: false; reason: 'missing' | 'error'; message: string }

interface MirrorRowDb { po_doc_no: string; po_line_no: string; receipt_date: string; qty: number | string }
const rowFromDb = (r: MirrorRowDb): ReceiptMirrorRow => ({
  poDocNo: normDoc(r.po_doc_no),
  poLineNo: String(r.po_line_no ?? '').trim(),
  receiptDate: String(r.receipt_date ?? '').slice(0, 10),
  qty: Number(r.qty) || 0,
})

async function readStatus(sb: SupabaseAdmin): Promise<ReceiptSyncStatus | null> {
  const { data, error } = await sb.from(RECEIPTS_SYNC_TABLE).select('*').eq('id', 1).maybeSingle()
  if (error) throw error
  if (!data) return null
  const d = data as Record<string, unknown>
  const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : null)
  return {
    lastIncrementalAt: s('last_incremental_at'),
    lastFullAt: s('last_full_at'),
    lastOkAt: s('last_ok_at'),
    lastError: s('last_error'),
    rowsUpserted: d.rows_upserted == null ? null : Number(d.rows_upserted),
    updatedAt: s('updated_at'),
  }
}

/**
 * 待排池用：整張鏡像（分頁讀完，固定排序）＋同步狀態。絕不往外丟錯——讀不到就回 available:false，待排池照常出卡。
 * 注意：存在與否要用「一般 select」判斷——head／count 請求在表不存在時回 204、error 是 null，會誤判成存在（D73 實測）。
 */
export async function loadReceiptMirror(sb: SupabaseAdmin): Promise<ReceiptMirror> {
  try {
    const status = await readStatus(sb)
    const page = (from: number, withCount: boolean) => sb.from(RECEIPTS_TABLE)
      .select('po_doc_no, po_line_no, receipt_date, qty', withCount ? { count: 'exact' } : undefined)
      .order('po_doc_no', { ascending: true }).order('po_line_no', { ascending: true }).order('receipt_date', { ascending: true })
      .range(from, from + PAGE - 1)
    const first = await page(0, true)
    if (first.error) throw first.error
    const rows: ReceiptMirrorRow[] = ((first.data ?? []) as MirrorRowDb[]).map(rowFromDb)
    const total = first.count ?? rows.length
    const offsets: number[] = []
    for (let o = PAGE; o < total; o += PAGE) offsets.push(o)
    for (let i = 0; i < offsets.length; i += 6) {
      const got = await Promise.all(offsets.slice(i, i + 6).map((o) => page(o, false)))
      for (const g of got) {
        if (g.error) throw g.error
        for (const r of (g.data ?? []) as MirrorRowDb[]) rows.push(rowFromDb(r))
      }
    }
    return { available: true, rows, status }
  } catch (e) {
    if (isMissingTable(e)) return { available: false, reason: 'missing', message: `入庫鏡像表尚未建立（請套用 ${RECEIPTS_MIGRATION_FILE}）` }
    console.error('[packaging/receipt mirror]', describeError(e))
    return { available: false, reason: 'error', message: '入庫鏡像讀取失敗' }
  }
}

// ─────────────────────────────────────────────────────────────────────
// ARGO（唯讀）
// ─────────────────────────────────────────────────────────────────────

/** Oracle IN 清單：先過白名單，再把單引號加倍（雙保險）；超過 3800 字丟錯（上限 4000） */
export function argoPoInList(docs: readonly string[]): string {
  const safe = docs.map(normDoc).filter((s) => PO_ID_RE.test(s))
  if (safe.length === 0) throw new ReceiptSyncError('argo_error', 'IN 清單沒有合法的採購單號')
  const clause = `IN (${safe.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')})`
  if (clause.length > 3800) throw new ReceiptSyncError('argo_error', `IN 清單過長（${clause.length} 字）`)
  return clause
}

/** IO_DATE >= 某天 00:00（台北日期；ARGO 存的是當地日期） */
export function argoReceiptDateFrom(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new ReceiptSyncError('argo_error', `日期格式錯誤：${ymd}`)
  return `>=TO_DATE('${ymd.replace(/-/g, '')}','YYYYMMDD')`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 查一次採購入庫明細（IO_TYPE='I'、IO_ACTION='BUY'）：逾時＝min(90 秒, 剩餘時間)，可重試的錯誤最多 3 次 */
async function queryReceipts(cond: Record<string, string>, customColumn: string, deadline: number, label: string): Promise<Record<string, unknown>[]> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= ARGO_ATTEMPTS; attempt++) {
    const left = deadline - Date.now()
    if (left < MIN_BATCH_BUDGET_MS / 2) break
    try {
      return await argoQueryStrict('IV_INVENTORYIODETAIL', { IO_TYPE: "='I'", IO_ACTION: "='BUY'", ...cond }, {
        customColumn, showNull: 'N', timeoutMs: Math.min(ARGO_TIMEOUT_MS, left),
      })
    } catch (e) {
      lastErr = e
      const retryable = e instanceof ArgoQueryError ? e.retryable : true
      if (!retryable || attempt === ARGO_ATTEMPTS) break
      const wait = RETRY_DELAYS_MS[attempt - 1] ?? 5_000
      if (deadline - Date.now() < wait + MIN_BATCH_BUDGET_MS) break
      await sleep(wait)
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : '時間不足'
  throw new ReceiptSyncError('argo_error', `${label}：${msg}`)
}

const strOrNull = (v: unknown): string | null => (v == null ? null : String(v))
const toDetail = (r: Record<string, unknown>): ReceiptDetailRow => ({
  poDocNo: strOrNull(r.PDL_PJT_PROJECT_ID),
  poLineNo: strOrNull(r.PJD_LINE_NO),
  itemCode: strOrNull(r.ISM_MBP_PART),
  lotNo: strOrNull(r.ISM_MBP_LOT_NO),
  qty: r.QTY == null || r.QTY === '' ? null : Number(r.QTY),
  ioDate: strOrNull(r.IO_DATE),
  slipNo: strOrNull(r.SLIP_NO),
})

/** 一批採購單在 ARGO 的全部採購入庫 → 彙總（唯讀；驗證腳本也用這個） */
export async function fetchReceiptsForDocs(docs: readonly string[], deadline: number): Promise<{ detailRows: number; rows: PoReceiptRow[] }> {
  const raw = await queryReceipts({ PDL_PJT_PROJECT_ID: argoPoInList(docs) }, RECEIPT_COLUMNS, deadline, `入庫明細（${docs.length} 張採購單）`)
  return { detailRows: raw.length, rows: aggregateReceiptDetail(raw.map(toDetail)) }
}

/** 近 N 天（IO_DATE ≥ since）有採購入庫的採購單（只取採購單號欄） */
export async function fetchRecentReceiptDocs(since: string, deadline: number): Promise<string[]> {
  const raw = await queryReceipts({ IO_DATE: argoReceiptDateFrom(since) }, 'PDL_PJT_PROJECT_ID', deadline, `近期入庫（${since} 起）`)
  return [...new Set(raw.map((r) => normDoc(r.PDL_PJT_PROJECT_ID)).filter((s) => PO_ID_RE.test(s)))].sort()
}

// ─────────────────────────────────────────────────────────────────────
// Supabase：範圍、鏡像寫入、狀態
// ─────────────────────────────────────────────────────────────────────

/** erp_so_lines 的全部單號（結案 SO 會被同步刪除 → 這裡就是「未結案」；含 RO） */
async function loadOpenOrders(sb: SupabaseAdmin): Promise<Set<string>> {
  const out = new Set<string>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('erp_so_lines').select('project_id').order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw new ReceiptSyncError('db_error', `讀取 erp_so_lines 失敗：${describeError(error)}`)
    const got = (data ?? []) as { project_id: string | null }[]
    for (const r of got) { const so = normDoc(r.project_id); if (so) out.add(so) }
    if (got.length < PAGE) return out
  }
}

/**
 * 範圍內的採購單（只讀既有表，dryRun 也用這個）：
 * 採購行條件同 pool.ts fetchPoLines（近 180 天開單、未作廢、數量 > 0、有來源 SO／RO）；
 * 來源單在 erp_so_lines 查得到（SO 未結案）才算。來源是 RO 的一律算（RO→SO 橋接在待排池才判定，這裡寧可多抓）。
 */
export async function loadScopeDocs(sb: SupabaseAdmin, today: string): Promise<Set<string>> {
  const open = await loadOpenOrders(sb)
  const from = addDays(today, -PO_WINDOW_DAYS).replace(/-/g, '/')
  const out = new Set<string>()
  for (let at = 0; ; at += PAGE) {
    const { data, error } = await sb.from('erp_pj_sync')
      .select('doc_no, sub_no, so_project_id:extra->>SO_PROJECT_ID, mbp_lot_no:extra->>MBP_LOT_NO')
      .eq('doc_type', '採購單號')
      .neq('status', 'VOID')
      .gt('qty', 0)
      .gte('start_date', from)
      .or('extra->>SO_PROJECT_ID.not.is.null,extra->>MBP_LOT_NO.like.SO*,extra->>MBP_LOT_NO.like.RO*')
      .order('doc_no', { ascending: true })
      .order('sub_no', { ascending: true })
      .range(at, at + PAGE - 1)
    if (error) throw new ReceiptSyncError('db_error', `讀取 erp_pj_sync 失敗：${describeError(error)}`)
    const got = (data ?? []) as unknown as { doc_no: string | null; so_project_id: string | null; mbp_lot_no: string | null }[]
    for (const r of got) {
      const doc = normDoc(r.doc_no)
      if (!PO_ID_RE.test(doc)) continue
      const src = sourceOrderOf(r)
      if (!src) continue
      if (src.startsWith('RO') || open.has(src)) out.add(doc)
    }
    if (got.length < PAGE) return out
  }
}

/** 鏡像裡所有採購單（去重；full 清範圍外用）或近期（receipt_date ≥ since）有入庫的採購單 */
async function loadMirrorDocs(sb: SupabaseAdmin, since?: string): Promise<Set<string>> {
  const out = new Set<string>()
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(RECEIPTS_TABLE).select('po_doc_no, po_line_no, receipt_date')
    if (since) q = q.gte('receipt_date', since)
    const { data, error } = await q
      .order('po_doc_no', { ascending: true }).order('po_line_no', { ascending: true }).order('receipt_date', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new ReceiptSyncError(isMissingTable(error) ? 'migration_required' : 'db_error', `讀取 ${RECEIPTS_TABLE} 失敗：${describeError(error)}`)
    const got = (data ?? []) as { po_doc_no: string }[]
    for (const r of got) out.add(normDoc(r.po_doc_no))
    if (got.length < PAGE) return out
  }
}

async function loadMirrorKeys(sb: SupabaseAdmin, docs: readonly string[]): Promise<ReceiptKey[]> {
  const out: ReceiptKey[] = []
  for (let i = 0; i < docs.length; i += IN_CHUNK) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from(RECEIPTS_TABLE).select('po_doc_no, po_line_no, receipt_date').in('po_doc_no', docs.slice(i, i + IN_CHUNK))
        .order('po_doc_no', { ascending: true }).order('po_line_no', { ascending: true }).order('receipt_date', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new ReceiptSyncError('db_error', `讀取 ${RECEIPTS_TABLE} 失敗：${describeError(error)}`)
      const got = (data ?? []) as { po_doc_no: string; po_line_no: string; receipt_date: string }[]
      // po_line_no 原樣比對（主鍵是原樣存的）；採購單號一律大寫
      for (const r of got) out.push({ poDocNo: normDoc(r.po_doc_no), poLineNo: r.po_line_no, receiptDate: String(r.receipt_date).slice(0, 10) })
      if (got.length < PAGE) break
    }
  }
  return out
}

/**
 * 寫一批：先 upsert 新值、再刪 ARGO 已不存在的列（中途失敗時寧可多留舊列，也不要先刪出空窗讓卡片的入庫日消失）。
 * 靜默回空防線（檔頭 (1)(2)）在這裡判斷：異常時丟錯、這批不寫不刪。
 */
async function writeBatch(
  sb: SupabaseAdmin, batch: readonly string[], fresh: readonly PoReceiptRow[], detailRows: number, nowIso: string,
): Promise<{ upserted: number; deleted: number; cleared: number }> {
  const existing = await loadMirrorKeys(sb, batch)
  if (fresh.length === 0) {
    const existingDocs = new Set(existing.map((e) => e.poDocNo)).size
    if (detailRows > 0) {
      throw new ReceiptSyncError('argo_error', `ARGO 回了 ${detailRows} 筆明細但彙總後 0 列（採購行號／入庫日欄位可能是空的），這批不寫入`)
    }
    if (existingDocs >= SILENT_EMPTY_MIN_DOCS) {
      throw new ReceiptSyncError('argo_error', `ARGO 回 0 筆，但鏡像裡這批有 ${existingDocs} 張採購單有入庫紀錄（疑似欄位名錯誤的靜默回空），這批不清除`)
    }
  }
  const plan = planReceiptMirrorWrite(batch, existing, fresh)
  if (plan.upserts.length > 0) {
    const rows = plan.upserts.map((r) => ({
      po_doc_no: r.poDocNo, po_line_no: r.poLineNo, item_code: r.itemCode, source_so: r.sourceSo,
      receipt_date: r.receiptDate, qty: r.qty, slip_count: r.slipCount, synced_at: nowIso,
    }))
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from(RECEIPTS_TABLE).upsert(rows.slice(i, i + 500), { onConflict: 'po_doc_no,po_line_no,receipt_date' })
      if (error) throw new ReceiptSyncError('db_error', `寫入 ${RECEIPTS_TABLE} 失敗：${describeError(error)}`)
    }
  }
  let deleted = 0
  for (const d of plan.deletes) {
    const { data, error } = await sb.from(RECEIPTS_TABLE).delete()
      .eq('po_doc_no', d.poDocNo).eq('po_line_no', d.poLineNo).in('receipt_date', d.dates).select('po_doc_no')
    if (error) throw new ReceiptSyncError('db_error', `刪除 ${RECEIPTS_TABLE} 失敗：${describeError(error)}`)
    deleted += (data ?? []).length
  }
  let cleared = 0
  if (plan.clearDocs.length > 0) {
    const { data, error } = await sb.from(RECEIPTS_TABLE).delete().in('po_doc_no', plan.clearDocs).select('po_doc_no')
    if (error) throw new ReceiptSyncError('db_error', `刪除 ${RECEIPTS_TABLE} 失敗：${describeError(error)}`)
    deleted += (data ?? []).length
    cleared = plan.clearDocs.length
  }
  return { upserted: plan.upserts.length, deleted, cleared }
}

async function writeStatus(sb: SupabaseAdmin, patch: Record<string, unknown>): Promise<void> {
  const { error } = await sb.from(RECEIPTS_SYNC_TABLE).upsert({ id: 1, ...patch }, { onConflict: 'id' })
  if (error) console.error('[packaging/receipts-sync] 寫入同步狀態失敗:', describeError(error))
}

// ─────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────

export interface ReceiptSyncOptions {
  mode: ReceiptSyncMode
  /** incremental 回看天數（1～31，預設 3） */
  days?: number
  /** full 分片：只處理排序後 index % shards == shard 的採購單（全量一次跑不完時由排程分段呼叫） */
  shard?: number
  shards?: number
  /** 時間預算（毫秒，從呼叫起算）；route maxDuration 300 秒 → 預設 250 秒 */
  budgetMs?: number
  /** 只查 ARGO、不寫 Supabase、不碰新表（驗證用；回傳彙總結果） */
  dryRun?: boolean
  /** 驗證用：只重算這些採購單（略過範圍與近期清單） */
  onlyDocs?: readonly string[]
}

export interface ReceiptSyncResult {
  stats: ReceiptSyncStats
  partial: boolean
  errors: string[]
  /** dryRun 時的彙總結果 */
  preview?: PoReceiptRow[]
}

async function mapLimit<T>(items: readonly T[], limit: number, fn: (t: T, i: number) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

export async function runReceiptSync(sb: SupabaseAdmin, opts: ReceiptSyncOptions): Promise<ReceiptSyncResult> {
  const started = Date.now()
  const deadline = started + (opts.budgetMs ?? 250_000)
  const nowIso = new Date(started).toISOString()
  const mode = opts.mode
  const dry = !!opts.dryRun
  const days = mode === 'incremental' ? Math.min(RECEIPT_SYNC_MAX_DAYS, Math.max(1, Math.floor(opts.days ?? RECEIPT_SYNC_DEFAULT_DAYS))) : null
  const shards = Math.max(1, Math.min(12, Math.floor(opts.shards ?? 1)))
  const shard = Math.max(0, Math.min(shards - 1, Math.floor(opts.shard ?? 0)))
  if (!argoConfigured()) throw new ReceiptSyncError('argo_unconfigured', '未設定 ARGO 連線環境變數（ARGOERP_API_BASE／USERNAME／PASSWORD／SEGMENT）')

  // 新表存在嗎（dryRun 不檢查：dry 路徑不得依賴新表）
  if (!dry) {
    const { error } = await sb.from(RECEIPTS_SYNC_TABLE).select('id').eq('id', 1).maybeSingle()
    if (error) {
      if (isMissingTable(error)) throw new ReceiptSyncError('migration_required', `入庫鏡像表尚未建立，請 Snow 備份後套用 ${RECEIPTS_MIGRATION_FILE}`)
      throw new ReceiptSyncError('db_error', `讀取 ${RECEIPTS_SYNC_TABLE} 失敗：${describeError(error)}`)
    }
  }

  const errors: string[] = []
  let scope: Set<string> | null = null
  let targets: string[]
  try {
    if (opts.onlyDocs) {
      targets = [...new Set(opts.onlyDocs.map(normDoc).filter((s) => PO_ID_RE.test(s)))].sort()
    } else {
      scope = await loadScopeDocs(sb, todayTaipei(new Date(started)))
      if (mode === 'full') {
        targets = [...scope].sort().filter((_, i) => i % shards === shard)
      } else {
        const since = addDays(todayTaipei(new Date(started)), -(days as number))
        const [recent, mirrorRecent] = await Promise.all([
          fetchRecentReceiptDocs(since, deadline),
          dry ? Promise.resolve(new Set<string>()) : loadMirrorDocs(sb, since),
        ])
        targets = [...new Set([...recent, ...mirrorRecent])].filter((s) => scope!.has(s)).sort()
      }
    }
  } catch (e) {
    // 還沒開始寫鏡像就失敗（例：ARGO 查近期入庫逾時）→ 記下錯誤（畫面的「入庫資料更新於」會停在上次成功的時間）再往外丟
    if (!dry && !opts.onlyDocs) {
      const msg = e instanceof Error ? e.message : String(e)
      await writeStatus(sb, { last_error: `${mode === 'full' ? '全量' : '增量'}同步失敗：${msg}`.slice(0, 500), updated_at: new Date().toISOString() })
    }
    throw e
  }

  const batches: string[][] = []
  for (let i = 0; i < targets.length; i += ARGO_PO_BATCH) batches.push(targets.slice(i, i + ARGO_PO_BATCH))
  const stats: ReceiptSyncStats = {
    mode, days, shard, shards,
    scopeDocs: scope?.size ?? targets.length,
    poCount: targets.length, batches: batches.length, batchesDone: 0,
    argoRows: 0, mirrorRows: 0, upserted: 0, deleted: 0, clearedDocs: 0, outOfScopePurged: 0, skippedBatches: 0, elapsedMs: 0,
  }
  const preview: PoReceiptRow[] = []

  await mapLimit(batches, ARGO_CONCURRENCY, async (batch, i) => {
    if (deadline - Date.now() < MIN_BATCH_BUDGET_MS) { stats.skippedBatches++; return }
    try {
      const got = await fetchReceiptsForDocs(batch, deadline)
      if (dry) {
        if (got.detailRows > 0 && got.rows.length === 0) {
          throw new ReceiptSyncError('argo_error', `ARGO 回了 ${got.detailRows} 筆明細但彙總後 0 列（採購行號／入庫日欄位可能是空的）`)
        }
        preview.push(...got.rows)
      } else {
        const w = await writeBatch(sb, batch, got.rows, got.detailRows, nowIso)
        stats.upserted += w.upserted
        stats.deleted += w.deleted
        stats.clearedDocs += w.cleared
      }
      stats.argoRows += got.detailRows
      stats.mirrorRows += got.rows.length
      stats.batchesDone++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`第 ${i + 1} 批（${batch[0]}～${batch[batch.length - 1]}）：${msg}`)
    }
  })

  const complete = stats.batchesDone === stats.batches
  // 全量跑了很多張採購單卻一筆入庫都沒有 → 幾乎一定是欄位名錯誤的靜默回空（檔頭的坑），不算成功
  if (mode === 'full' && !opts.onlyDocs && complete && stats.poCount >= ARGO_PO_BATCH && stats.argoRows === 0) {
    errors.push(`全量同步 ${stats.poCount} 張採購單，ARGO 一筆入庫明細都沒回（疑似欄位名錯誤的靜默回空），請檢查 RECEIPT_COLUMNS`)
  }
  // full 完整跑完（且沒分片、沒錯誤）→ 清掉已不在範圍內（SO 已結案、採購單超過 180 天）的鏡像列；範圍讀到 0 張時不清（同步異常保護）
  if (!dry && !opts.onlyDocs && mode === 'full' && complete && errors.length === 0 && shards === 1 && scope && scope.size > 0) {
    try {
      const mirrorDocs = await loadMirrorDocs(sb)
      const gone = [...mirrorDocs].filter((d) => !scope!.has(d))
      for (let i = 0; i < gone.length; i += IN_CHUNK) {
        const { error } = await sb.from(RECEIPTS_TABLE).delete().in('po_doc_no', gone.slice(i, i + IN_CHUNK))
        if (error) throw new ReceiptSyncError('db_error', `清除範圍外採購單失敗：${describeError(error)}`)
      }
      stats.outOfScopePurged = gone.length
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }

  stats.elapsedMs = Date.now() - started
  const partial = !complete || errors.length > 0
  if (!dry && !opts.onlyDocs) {
    const doneIso = new Date().toISOString()
    const summary = partial
      ? `${mode === 'full' ? '全量' : '增量'}同步未完成：${stats.batchesDone}/${stats.batches} 批${stats.skippedBatches ? `（時間不足略過 ${stats.skippedBatches} 批）` : ''}；${errors[0] ?? ''}`.slice(0, 500)
      : null
    const okPatch: Record<string, string> = {}
    if (!partial) {
      okPatch.last_ok_at = doneIso
      // 分片的全量只算「這一片」做完，不更新 last_full_at（避免誤以為全部採購單都重算過）
      if (mode === 'incremental') okPatch.last_incremental_at = doneIso
      else if (shards === 1) okPatch.last_full_at = doneIso
    }
    await writeStatus(sb, {
      ...okPatch,
      last_error: summary,
      rows_upserted: stats.upserted,
      updated_at: doneIso,
    })
  }
  return { stats, partial, errors, ...(dry ? { preview } : {}) }
}
