// 包裝專區 — D73 ARGO 銷貨同步（I/O 層，server-side only：用到 ARGO 帳密與 Supabase service role）
//
// ARGO：只讀（S_APIKEY／S_QUERY，經 lib/argoQuery.ts argoQueryStrict），絕不呼叫任何 ARGO 寫入介面。
// Supabase：只寫 erp_so_sales、erp_so_sales_sync 兩張表；erp_so_lines 唯讀（取「未結案 SO」清單）。
//
// 同步單位＝「一整張 SO」：ARGO 作廢銷貨單會連明細一起刪除，所以每次都把這張 SO 在 ARGO 的全部銷貨重新彙總，
//   upsert 新值、刪掉 ARGO 已不存在的（SO, 品號）列（純函式 planMirrorWrite）。
//   full        ＝ erp_so_lines 裡全部 SO（約 2,400 張）分批重算；完整跑完再清掉已結案 SO 的鏡像列
//   incremental ＝ 近 N 天（IO_DATE）有銷貨的 SO ∪ 鏡像裡近 N 天有銷貨的 SO（近期作廢的單在 ARGO 已查不到，要靠鏡像找回來）
// ARGO 限制：S_QUERY 動態 WHERE 是 VARCHAR2(4000) → IN 清單每批 60 張（同 argo-tool sales_data._BATCH）；
//   常逾時 → 每次查詢有逾時、網路／逾時／5xx 重試（最多 3 次），整體有時間預算（route maxDuration 300 秒）。
// 「查無資料」與「ARGO 回錯誤」一定要分開（argoQueryStrict）：把錯誤當成空結果會把鏡像整張清掉。

import type { SupabaseAdmin } from '@/lib/packaging/scheduleDb'
import { describeError } from '@/lib/supabaseAdmin'
import { ArgoQueryError, argoConfigured, argoQueryStrict } from '@/lib/argoQuery'
import {
  SALES_SYNC_DEFAULT_DAYS,
  SALES_SYNC_MAX_DAYS,
  type SalesSyncMode,
  type SalesSyncStats,
} from '@/lib/packaging/scheduleTypes'
import { aggregateSalesDetail, normItem, normSo, planMirrorWrite, type SalesDetailRow, type SoSalesRow } from '@/lib/packaging/salesAlloc'
import { addDays } from '@/lib/packaging/scheduleCalendar'
import { todayTaipei } from '@/lib/packaging/workdays'

export const SALES_TABLE = 'erp_so_sales'
export const SALES_SYNC_TABLE = 'erp_so_sales_sync'
export const SALES_MIGRATION_FILE = 'sql/20260928_packaging_sales_and_order.sql'

/** ARGO IN 清單每批幾張 SO（VARCHAR2 4000 字上限；同 argo-tool _BATCH） */
export const ARGO_SO_BATCH = 60
/** 同時幾個 ARGO 查詢（ARGO 伺服器慢，不要一次灌太多） */
const ARGO_CONCURRENCY = 3
/** 單次 S_QUERY 逾時上限（實際取 min(這個, 剩餘時間)） */
const ARGO_TIMEOUT_MS = 90_000
const ARGO_ATTEMPTS = 3
const RETRY_DELAYS_MS = [2_000, 5_000]
/** 剩不到這麼多時間就不再開新批次／不再重試 */
const MIN_BATCH_BUDGET_MS = 20_000
const PAGE = 1000
const IN_CHUNK = 100
const SALES_COLUMNS = 'SLIP_NO,IO_DATE,PDL_PJT_PROJECT_ID,ISM_MBP_PART,QTY,PRICE_QTY'
/**
 * SO 號白名單：要原樣拼進 ARGO 的 Oracle WHERE（IN ('…')），只允許英數與連字號（另外仍把單引號加倍）。
 * 來源是 erp_so_lines 與 ARGO 本身，但這是「字串拼 SQL」，一律先驗再用（白帽習慣：不信任任何進 SQL 的字串）。
 */
const SO_ID_RE = /^[A-Z0-9][A-Z0-9-]{2,39}$/

const MISSING_TABLE_CODES = new Set(['PGRST205', '42P01'])
function pgCodeOf(e: unknown): string | null {
  const c = e && typeof e === 'object' ? (e as { code?: unknown }).code : null
  return typeof c === 'string' ? c : null
}
const isMissingTable = (e: unknown) => MISSING_TABLE_CODES.has(pgCodeOf(e) ?? '')

export class SalesSyncError extends Error {
  readonly code: 'migration_required' | 'db_error' | 'argo_error' | 'argo_unconfigured'
  constructor(code: SalesSyncError['code'], message: string) {
    super(message)
    this.name = 'SalesSyncError'
    this.code = code
  }
}

// ─────────────────────────────────────────────────────────────────────
// 鏡像讀取（pool.ts、manualCache.ts 用；GET 不寫入）
// ─────────────────────────────────────────────────────────────────────

export interface SalesSyncStatus {
  lastIncrementalAt: string | null
  lastFullAt: string | null
  lastOkAt: string | null
  lastError: string | null
  rowsUpserted: number | null
  updatedAt: string | null
}

export type SalesMirror =
  | { available: true; rows: SoSalesRow[]; status: SalesSyncStatus | null }
  /** missing＝新表不存在（migration 未套用）；error＝讀取失敗（網路等） */
  | { available: false; reason: 'missing' | 'error'; message: string }

interface SalesRowDb { so: string; item_code: string; sold_qty: number | string; last_sale_date: string | null; slip_count: number | string | null }
const rowFromDb = (r: SalesRowDb): SoSalesRow => ({
  so: normSo(r.so),
  itemCode: normItem(r.item_code),
  soldQty: Number(r.sold_qty) || 0,
  lastSaleDate: r.last_sale_date ? String(r.last_sale_date).slice(0, 10) : null,
  slipCount: Number(r.slip_count) || 0,
})

async function readStatus(sb: SupabaseAdmin): Promise<SalesSyncStatus | null> {
  const { data, error } = await sb.from(SALES_SYNC_TABLE).select('*').eq('id', 1).maybeSingle()
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
 * 待排池用：整張鏡像（分頁讀完，固定排序）＋同步狀態。
 * 注意：存在與否要用「一般 select」判斷——head／count 請求在表不存在時回 204、error 是 null（2026-09-28 實測），會誤判成存在。
 */
export async function loadSalesMirror(sb: SupabaseAdmin): Promise<SalesMirror> {
  try {
    const status = await readStatus(sb)
    // 第一頁帶 exact count，其餘頁並行（同 pool.ts fetchAllPages；鏡像約數千列，待排池每 120 秒重算一次）
    const page = (from: number, withCount: boolean) => sb.from(SALES_TABLE)
      .select('so, item_code, sold_qty, last_sale_date, slip_count', withCount ? { count: 'exact' } : undefined)
      .order('so', { ascending: true }).order('item_code', { ascending: true })
      .range(from, from + PAGE - 1)
    const first = await page(0, true)
    if (first.error) throw first.error
    const rows: SoSalesRow[] = ((first.data ?? []) as SalesRowDb[]).map(rowFromDb)
    const total = first.count ?? rows.length
    const offsets: number[] = []
    for (let o = PAGE; o < total; o += PAGE) offsets.push(o)
    for (let i = 0; i < offsets.length; i += 6) {
      const got = await Promise.all(offsets.slice(i, i + 6).map((o) => page(o, false)))
      for (const g of got) {
        if (g.error) throw g.error
        for (const r of (g.data ?? []) as SalesRowDb[]) rows.push(rowFromDb(r))
      }
    }
    return { available: true, rows, status }
  } catch (e) {
    if (isMissingTable(e)) return { available: false, reason: 'missing', message: `銷貨鏡像表尚未建立（請套用 ${SALES_MIGRATION_FILE}）` }
    console.error('[packaging/sales mirror]', describeError(e))
    return { available: false, reason: 'error', message: '銷貨鏡像讀取失敗' }
  }
}

/** D66 手動區塊用：指定 SO 的鏡像列；表不存在或讀取失敗回 null（呼叫端當「不排除」） */
export async function loadSalesForSos(sb: SupabaseAdmin, sos: readonly string[]): Promise<SoSalesRow[] | null> {
  const list = [...new Set(sos.map(normSo).filter(Boolean))]
  if (list.length === 0) return []
  try {
    const out: SoSalesRow[] = []
    for (let i = 0; i < list.length; i += IN_CHUNK) {
      const { data, error } = await sb.from(SALES_TABLE)
        .select('so, item_code, sold_qty, last_sale_date, slip_count')
        .in('so', list.slice(i, i + IN_CHUNK))
        .order('so', { ascending: true }).order('item_code', { ascending: true })
        .limit(PAGE)
      if (error) throw error
      for (const r of (data ?? []) as SalesRowDb[]) out.push(rowFromDb(r))
    }
    return out
  } catch (e) {
    if (!isMissingTable(e)) console.error('[packaging/sales mirror sos]', describeError(e))
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────
// ARGO（唯讀）
// ─────────────────────────────────────────────────────────────────────

/** Oracle IN 清單：先過白名單，再把單引號加倍（雙保險） */
export function argoInList(sos: readonly string[]): string {
  const safe = sos.map(normSo).filter((s) => SO_ID_RE.test(s))
  if (safe.length === 0) throw new SalesSyncError('argo_error', 'IN 清單沒有合法的 SO 號')
  const clause = `IN (${safe.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')})`
  if (clause.length > 3800) throw new SalesSyncError('argo_error', `IN 清單過長（${clause.length} 字）`)
  return clause
}

/** IO_DATE >= 某天 00:00（台北日期；ARGO 存的是當地日期） */
export function argoDateFrom(ymd: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new SalesSyncError('argo_error', `日期格式錯誤：${ymd}`)
  return `>=TO_DATE('${ymd.replace(/-/g, '')}','YYYYMMDD')`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 查一次銷貨明細（IO_TYPE='O'、IO_ACTION='SELL'）：逾時＝min(90 秒, 剩餘時間)，可重試的錯誤最多 3 次 */
async function querySales(cond: Record<string, string>, customColumn: string, deadline: number, label: string): Promise<Record<string, unknown>[]> {
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= ARGO_ATTEMPTS; attempt++) {
    const left = deadline - Date.now()
    if (left < MIN_BATCH_BUDGET_MS / 2) break
    try {
      return await argoQueryStrict('IV_INVENTORYIODETAIL', { IO_TYPE: "='O'", IO_ACTION: "='SELL'", ...cond }, {
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
  throw new SalesSyncError('argo_error', `${label}：${msg}`)
}

const toDetail = (r: Record<string, unknown>): SalesDetailRow => ({
  so: r.PDL_PJT_PROJECT_ID == null ? null : String(r.PDL_PJT_PROJECT_ID),
  itemCode: r.ISM_MBP_PART == null ? null : String(r.ISM_MBP_PART),
  qty: r.QTY == null || r.QTY === '' ? null : Number(r.QTY),
  priceQty: r.PRICE_QTY == null || r.PRICE_QTY === '' ? null : Number(r.PRICE_QTY),
  ioDate: r.IO_DATE == null ? null : String(r.IO_DATE),
  slipNo: r.SLIP_NO == null ? null : String(r.SLIP_NO),
})

/** 一批 SO 在 ARGO 的全部銷貨 → 彙總（唯讀；驗證腳本也用這個） */
export async function fetchSalesForSos(sos: readonly string[], deadline: number): Promise<{ detailRows: number; rows: SoSalesRow[] }> {
  const raw = await querySales({ PDL_PJT_PROJECT_ID: argoInList(sos) }, SALES_COLUMNS, deadline, `銷貨明細（${sos.length} 張 SO）`)
  return { detailRows: raw.length, rows: aggregateSalesDetail(raw.map(toDetail)) }
}

/** 近 N 天（IO_DATE ≥ since）有銷貨的 SO（只取來源單號欄） */
export async function fetchRecentSaleSos(since: string, deadline: number): Promise<string[]> {
  const raw = await querySales({ IO_DATE: argoDateFrom(since) }, 'PDL_PJT_PROJECT_ID', deadline, `近期銷貨（${since} 起）`)
  return [...new Set(raw.map((r) => normSo(r.PDL_PJT_PROJECT_ID)).filter((s) => SO_ID_RE.test(s)))].sort()
}

// ─────────────────────────────────────────────────────────────────────
// Supabase：未結案 SO、鏡像寫入、狀態
// ─────────────────────────────────────────────────────────────────────

/** erp_so_lines 的全部 SO（結案 SO 會被同步刪除 → 這裡就是「未結案」；約 8,500 列、2,400 張） */
async function loadOpenSos(sb: SupabaseAdmin): Promise<Set<string>> {
  const out = new Set<string>()
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('erp_so_lines').select('project_id').order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw new SalesSyncError('db_error', `讀取 erp_so_lines 失敗：${describeError(error)}`)
    const got = (data ?? []) as { project_id: string | null }[]
    for (const r of got) { const so = normSo(r.project_id); if (SO_ID_RE.test(so)) out.add(so) }
    if (got.length < PAGE) return out
  }
}

/** 鏡像裡所有 SO（去重；full 清結案 SO 用）或近期（last_sale_date ≥ since）有銷貨的 SO */
async function loadMirrorSos(sb: SupabaseAdmin, since?: string): Promise<Set<string>> {
  const out = new Set<string>()
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(SALES_TABLE).select('so, item_code')
    if (since) q = q.gte('last_sale_date', since)
    const { data, error } = await q.order('so', { ascending: true }).order('item_code', { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw new SalesSyncError(isMissingTable(error) ? 'migration_required' : 'db_error', `讀取 ${SALES_TABLE} 失敗：${describeError(error)}`)
    const got = (data ?? []) as { so: string }[]
    for (const r of got) out.add(normSo(r.so))
    if (got.length < PAGE) return out
  }
}

async function loadMirrorKeys(sb: SupabaseAdmin, sos: readonly string[]): Promise<{ so: string; itemCode: string }[]> {
  const out: { so: string; itemCode: string }[] = []
  for (let i = 0; i < sos.length; i += IN_CHUNK) {
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from(SALES_TABLE).select('so, item_code').in('so', sos.slice(i, i + IN_CHUNK))
        .order('so', { ascending: true }).order('item_code', { ascending: true }).range(from, from + PAGE - 1)
      if (error) throw new SalesSyncError('db_error', `讀取 ${SALES_TABLE} 失敗：${describeError(error)}`)
      const got = (data ?? []) as { so: string; item_code: string }[]
      // item_code 原樣比對（主鍵是原樣存的）；so 一律大寫
      for (const r of got) out.push({ so: normSo(r.so), itemCode: r.item_code })
      if (got.length < PAGE) break
    }
  }
  return out
}

/** 寫一批：先 upsert 新值、再刪 ARGO 已不存在的列（中途失敗時寧可多留舊列，也不要先刪出空窗讓已銷貨的卡跑回待排池） */
async function writeBatch(sb: SupabaseAdmin, batch: readonly string[], fresh: readonly SoSalesRow[], nowIso: string): Promise<{ upserted: number; deleted: number; cleared: number }> {
  const existing = await loadMirrorKeys(sb, batch)
  const plan = planMirrorWrite(batch, existing, fresh)
  if (plan.upserts.length > 0) {
    const rows = plan.upserts.map((r) => ({
      so: r.so, item_code: r.itemCode, sold_qty: r.soldQty, last_sale_date: r.lastSaleDate, slip_count: r.slipCount, synced_at: nowIso,
    }))
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from(SALES_TABLE).upsert(rows.slice(i, i + 500), { onConflict: 'so,item_code' })
      if (error) throw new SalesSyncError('db_error', `寫入 ${SALES_TABLE} 失敗：${describeError(error)}`)
    }
  }
  let deleted = 0
  for (const d of plan.deletePairs) {
    const { data, error } = await sb.from(SALES_TABLE).delete().eq('so', d.so).in('item_code', d.itemCodes).select('so')
    if (error) throw new SalesSyncError('db_error', `刪除 ${SALES_TABLE} 失敗：${describeError(error)}`)
    deleted += (data ?? []).length
  }
  let cleared = 0
  if (plan.clearSos.length > 0) {
    const { data, error } = await sb.from(SALES_TABLE).delete().in('so', plan.clearSos).select('so')
    if (error) throw new SalesSyncError('db_error', `刪除 ${SALES_TABLE} 失敗：${describeError(error)}`)
    deleted += (data ?? []).length
    cleared = plan.clearSos.length
  }
  return { upserted: plan.upserts.length, deleted, cleared }
}

async function writeStatus(sb: SupabaseAdmin, patch: Record<string, unknown>): Promise<void> {
  const { error } = await sb.from(SALES_SYNC_TABLE).upsert({ id: 1, ...patch }, { onConflict: 'id' })
  if (error) console.error('[packaging/sales-sync] 寫入同步狀態失敗:', describeError(error))
}

// ─────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────

export interface SalesSyncOptions {
  mode: SalesSyncMode
  /** incremental 回看天數（1～31，預設 3） */
  days?: number
  /** full 分片：只處理排序後 index % shards == shard 的 SO（全量一次跑不完時由排程分段呼叫） */
  shard?: number
  shards?: number
  /** 時間預算（毫秒，從呼叫起算）；route maxDuration 300 秒 → 預設 250 秒 */
  budgetMs?: number
  /** 只查 ARGO、不寫 Supabase（驗證用；回傳彙總結果） */
  dryRun?: boolean
  /** 驗證用：只重算這些 SO（略過 erp_so_lines 與近期清單） */
  onlySos?: readonly string[]
}

export interface SalesSyncResult {
  stats: SalesSyncStats
  partial: boolean
  errors: string[]
  /** dryRun 時的彙總結果 */
  preview?: SoSalesRow[]
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

export async function runSalesSync(sb: SupabaseAdmin, opts: SalesSyncOptions): Promise<SalesSyncResult> {
  const started = Date.now()
  const deadline = started + (opts.budgetMs ?? 250_000)
  const nowIso = new Date(started).toISOString()
  const mode = opts.mode
  const days = mode === 'incremental' ? Math.min(SALES_SYNC_MAX_DAYS, Math.max(1, Math.floor(opts.days ?? SALES_SYNC_DEFAULT_DAYS))) : null
  const shards = Math.max(1, Math.min(12, Math.floor(opts.shards ?? 1)))
  const shard = Math.max(0, Math.min(shards - 1, Math.floor(opts.shard ?? 0)))
  if (!argoConfigured()) throw new SalesSyncError('argo_unconfigured', '未設定 ARGO 連線環境變數（ARGOERP_API_BASE／USERNAME／PASSWORD／SEGMENT）')

  // 新表存在嗎（dryRun 也檢查：預覽要拿鏡像比對時才有意義；表不存在時 dryRun 仍可跑 ARGO）
  if (!opts.dryRun) {
    const { error } = await sb.from(SALES_SYNC_TABLE).select('id').eq('id', 1).maybeSingle()
    if (error) {
      if (isMissingTable(error)) throw new SalesSyncError('migration_required', `銷貨鏡像表尚未建立，請 Snow 備份後套用 ${SALES_MIGRATION_FILE}`)
      throw new SalesSyncError('db_error', `讀取 ${SALES_SYNC_TABLE} 失敗：${describeError(error)}`)
    }
  }

  const errors: string[] = []
  let openSos: Set<string> | null = null
  let targets: string[]
  try {
    if (opts.onlySos) {
      targets = [...new Set(opts.onlySos.map(normSo).filter((s) => SO_ID_RE.test(s)))].sort()
    } else {
      openSos = await loadOpenSos(sb)
      if (mode === 'full') {
        targets = [...openSos].sort().filter((_, i) => i % shards === shard)
      } else {
        const since = addDays(todayTaipei(new Date(started)), -(days as number))
        const [recent, mirrorRecent] = await Promise.all([
          fetchRecentSaleSos(since, deadline),
          opts.dryRun ? Promise.resolve(new Set<string>()) : loadMirrorSos(sb, since),
        ])
        targets = [...new Set([...recent, ...mirrorRecent])].filter((s) => openSos!.has(s)).sort()
      }
    }
  } catch (e) {
    // 還沒開始寫鏡像就失敗（例：ARGO 查近期銷貨逾時）→ 記下錯誤（畫面的「銷貨資料更新於」會停在上次成功的時間）再往外丟
    if (!opts.dryRun && !opts.onlySos) {
      const msg = e instanceof Error ? e.message : String(e)
      await writeStatus(sb, { last_error: `${mode === 'full' ? '全量' : '增量'}同步失敗：${msg}`.slice(0, 500), updated_at: new Date().toISOString() })
    }
    throw e
  }

  const batches: string[][] = []
  for (let i = 0; i < targets.length; i += ARGO_SO_BATCH) batches.push(targets.slice(i, i + ARGO_SO_BATCH))
  const stats: SalesSyncStats = {
    mode, days, shard, shards,
    soCount: targets.length, batches: batches.length, batchesDone: 0,
    argoRows: 0, upserted: 0, deleted: 0, clearedSos: 0, closedSosPurged: 0, skippedBatches: 0, elapsedMs: 0,
  }
  const preview: SoSalesRow[] = []

  await mapLimit(batches, ARGO_CONCURRENCY, async (batch, i) => {
    if (deadline - Date.now() < MIN_BATCH_BUDGET_MS) { stats.skippedBatches++; return }
    try {
      const got = await fetchSalesForSos(batch, deadline)
      stats.argoRows += got.detailRows
      if (opts.dryRun) {
        preview.push(...got.rows)
      } else {
        const w = await writeBatch(sb, batch, got.rows, nowIso)
        stats.upserted += w.upserted
        stats.deleted += w.deleted
        stats.clearedSos += w.cleared
      }
      stats.batchesDone++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`第 ${i + 1} 批（${batch[0]}～${batch[batch.length - 1]}）：${msg}`)
    }
  })

  const complete = stats.batchesDone === stats.batches
  // full 完整跑完（且沒分片）→ 清掉已結案（不在 erp_so_lines）的 SO 的鏡像列；erp_so_lines 讀到 0 列時不清（同步異常保護）
  if (!opts.dryRun && !opts.onlySos && mode === 'full' && complete && shards === 1 && openSos && openSos.size > 0) {
    try {
      const mirrorSos = await loadMirrorSos(sb)
      const closed = [...mirrorSos].filter((s) => !openSos!.has(s))
      for (let i = 0; i < closed.length; i += IN_CHUNK) {
        const { error } = await sb.from(SALES_TABLE).delete().in('so', closed.slice(i, i + IN_CHUNK))
        if (error) throw new SalesSyncError('db_error', `清除結案 SO 失敗：${describeError(error)}`)
      }
      stats.closedSosPurged = closed.length
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }

  stats.elapsedMs = Date.now() - started
  const partial = !complete || errors.length > 0
  if (!opts.dryRun && !opts.onlySos) {
    const doneIso = new Date().toISOString()
    const summary = partial
      ? `${mode === 'full' ? '全量' : '增量'}同步未完成：${stats.batchesDone}/${stats.batches} 批${stats.skippedBatches ? `（時間不足略過 ${stats.skippedBatches} 批）` : ''}；${errors[0] ?? ''}`.slice(0, 500)
      : null
    const okPatch: Record<string, string> = {}
    if (!partial) {
      okPatch.last_ok_at = doneIso
      // 分片的全量只算「這一片」做完，不更新 last_full_at（避免誤以為全部 SO 都重算過）
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
  return { stats, partial, errors, ...(opts.dryRun ? { preview } : {}) }
}
