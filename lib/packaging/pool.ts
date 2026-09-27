// 包裝專區 P0 — 待排池組裝（I/O 層：分頁讀表 → classifyPool → 回應形狀）
//
// 只讀 Supabase 既有鏡像（service role），不寫任何資料、不呼叫 ARGO／塔台（D4、D42 P0 唯讀）。
// 判定邏輯全部在 lib/packaging/classify.ts（純函式）；工時在 lib/packaging/stdTime.ts。
// 規格：docs/design/2026-09-27-packaging-schedule.md §7.1。
//
// 讀取分四波（後一波的查詢條件要用前一波的結果）：
//   ① 採購行（近 180 天）、採購追蹤、常平出貨標記、塔台批／排程、出單表（近 365 天）、工時三表、新鮮度、
//      D47 塔台報工紀錄的全部 MOT／MOS 製令號（只要 mo_nbr、lot_nbr，解碼出 SO＋項次）
//   ② RO→SO 橋接、SO 品項行（依①收集到的 SO 集合分塊 in()；含出單表上的 SO，D44 要判斷 ERP 是否仍未結案）
//   ③ 塔台報工紀錄（批 mo_nbr ∪ 開放中 SO 的 POC 採購行）、erp_mo_lines（製令 SO，僅顯示）
//   ④ D43/D44 補查：出單表單號在①③都對不到時，再以單號查 sara_wip_records 判斷「是否上過塔台」；
//      同時 D47 以這些列的訂單號查舊式製令號（＝SO／SOB／RO 號本身，lot＝項次）
// PostgREST 單次上限 1000 列：每個查詢都分頁讀完，且每頁固定排序（比照 lib/purchasing/data.ts）。

import type { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import {
  classifyPool,
  legacySaraCandidates,
  pocSaraMo,
  sourceOrderOf,
  type PoolRawData,
  type RawLot,
  type RawMoLine,
  type RawPoLine,
  type RawRecord,
  type RawSchedule,
  type RawSheetRow,
  type RawShipMark,
  type RawSoLine,
  type RawTracking,
  type WorkEstimator,
  unresolvedSheetMoRefs,
} from '@/lib/packaging/classify'
import { computeStdTime, loadStdTimeTables } from '@/lib/packaging/stdTime'
import type { PoolFreshness, PoolResponse } from '@/lib/packaging/types'
import { CALENDAR_COVERAGE, todayTaipei } from '@/lib/packaging/workdays'

type SupabaseAdmin = ReturnType<typeof getSupabaseAdminClient>
export type PoolOk = Extract<PoolResponse, { success: true }>

const PAGE = 1000
const IN_CHUNK = 100
const CONCURRENCY = 6
/** 採購行只看近 180 天開單（argo-tool「委外到貨待包裝」同樣用 180 天） */
const PO_WINDOW_DAYS = 180
/**
 * 出單表讀近 365 天（打樣單判定、示意圖、PO→SO 行、D44 已發單未上塔台）。
 * D44 的「發單超過 30 天仍未上塔台」清單涵蓋近 365 天出單表（2026-09 實測 5 月的單仍有 352 行），所以不能只讀 120 天；
 * 超過 365 天的出單不在清單內（POOL_NOTES 第 3 條揭露）。
 * 出單表有模組快取、只重抓變動的張數，冷啟動多讀的量有限（2026-09 共 105 張，最早 2026-04-23）。
 */
const SHEET_WINDOW_DAYS = 365

/** 頁尾註腳：P0 暫用規則與已知限制（規格 §9） */
export const POOL_NOTES: string[] = [
  '待排池範圍（D43）：只列「塔台 SARA 目前未結案的批」相連的卡（卡片任一來源的塔台批仍在塔台，或 SO 行＝某未結案批的單號＋項次），加上「出單表 30 天內已發單、但塔台尚未建立」的品項（D44）。塔台已結案＝多半已出貨，不再列入；塔台結案由 Snow 以結案檢查流程維護。取代原本的「隱藏逾期舊單」勾選。',
  '已發單・未上塔台（D44）：出單表出單日在 30 個日曆天內（含今天，台北時區）、ERP SO 行仍未結案、且製令號／採購單號／請購單號與 SO 行都對不到任何塔台批。已有採購或製令卡的留在原區塊並標「已發單、塔台尚未建立」；沒有任何來源的（例：壓克力集單沒有製令號）另出卡放「已發單・未上塔台」區，來源依出單表廠別推定（C 常平、O 委外、其餘自製），數量取 ERP 訂單量、可包量 0。',
  '出單日超過 30 天仍未上塔台、ERP 也未結案的品項不列入待排池，另列在頁尾上方「發單超過 30 天仍未上塔台」清單，請生管確認是塔台建單失敗還是該在 ERP 結案。清單只涵蓋近 365 天的出單表，超過 365 天的出單不在清單內。',
  '「是否上過塔台」：比對出單表的製令號／採購單號／請購單號、卡片來源的塔台批，以及 ERP 常平採購行（新式 POC 單號-行；舊式 POC 要批號＝SO 項次且品號相同）；同一張單的別行上過塔台不算本行。塔台已結案批的歷史只能從報工紀錄推，沒報過工就結案的批會被當成「未上塔台」。',
  '製令號解碼（D47）：塔台報工沒有來源單號，改從製令號還原 SO＋項次再比對——MOT＋SO 9 碼＋項次（MOT26082502107＝SO260825021 第 7 項）、MOS＋SOB 9 碼＋項次（壓克力集單以 MOS 上塔台）、舊式製令號＝SO 號本身（批號＝項次）；比對只看 SO 數字不分 SO／SOB／RO 前綴。MOM 集單流水號、SOA 長格式無法還原，不判斷。EIP 的塔台報工紀錄只從 2026-07 開始匯入（不是塔台全量），更早就結案的批仍可能被當成「未上塔台」。',
  '出單表「素材單／包裝單」本來就不上塔台，不列入待排池與「發單超過 30 天仍未上塔台」清單（D46）；同一行若另有正常出單列，照正常列判定。',
  'P0 暫用完成規則：常平貨在塔台包裝站的包裝工序（非 QC）人工報完工即隱藏，SO 在 ARGO 結案即隱藏；P1 改為主管勾選完成。ARGO 入庫＝品檢完成＝才要開始包，絕不當作完成（塔台系統自動結工也不算）。',
  '委外（MPO）在塔台只有 QC 工序，P0 沒有包裝完成訊號；已入庫的委外卡留到塔台批結案（D43）或 SO 結案。',
  '自製製令以塔台包裝工序完工代替 ARGO 繳庫（EIP 尚未同步繳庫量）。',
  '「SO 行已全數銷貨」目前查不到（系統不查 ARGO 銷貨），以塔台結案（D43）與 SO 結案判斷。',
  '常平出貨燈可能誤亮：同單同品號多行時黃底同步會把所有行都亮燈；數量配不到的行標「出貨燈可能誤亮」。',
  '常平黃底同步目前每晚 23:30 一次；分批寄出時只記第一次寄出。出貨日無法解析者（如「出HK」）不估可包日。',
  '預估可包日＝寄出日＋預設運輸工作天（順豐 3、空運 5、海特快 7、一般海運 13），尚未以實績校正。',
  '委外「已出貨」靠採購手動點（覆蓋率低），「委外已出貨未到」多半是空的；以「出貨待確認」補救。',
  '「出貨待確認」的採購交期由 ARGO 同步往前推 2 天，但過了推算日後同步又會改回原交期（EIP 未存原始採購交期）；為避免卡片中途消失，P0 一律以追蹤交期再往前 2 個週一～五列入，所以尚未改回的單會提早 2 天出現（標「提早列入」）。推算只跳過六日、沒看國定假日，遇連假會差 1～2 天。',
  '委外 MPO 與採購 PO 在 EIP 內沒有直接關聯，到台訊號只能套在 SO 行層級（同 SO 行多批委外無法分辨哪一批到台）；塔台批號過期（ERP 改過項次、品號不符）時不套用。',
  '舊途程沒有轉運工序的常平批，塔台「QC檢驗」人工報完工也視為已到台（D18）。',
  '原物料／耗材採購行（品號 M、W 開頭且 SO 上沒有此品項，例：空白板材、PET、燈座、PE 膜、墨水）是自製投入料，由製令卡包裝，不另出卡。',
  '採購單表頭已結案（ARGO CLOSE）但沒到齊的剩餘量不再追蹤；已入庫的部分照常列出。',
  '同 SO 行各採購單已入庫合計達訂單量時，其他採購行的未到量不另出卡（可能重複開單），在同 SO 行的卡上標「採購量超過訂單」請採購確認。',
  '製令途程經轉運站「委外/N天回」（常平代工回台）時，同 SO 行的常平採購卡併入製令卡，不重複計工時。',
  '中轉單若採購開給第三方廠商，P0 會歸在委外。',
  '塔台沒有平行鏈資料：同序號多道前站視為平行、取最落後者；不同序號的平行鏈可能判斷錯。塔台報工紀錄約每 3 小時、排程每 30 分同步。',
  '「只有包裝站、沒有前站」的製令可能是塔台工序設定錯誤，請確認（D35）。',
  '工時：常平換箱 0.2 分/件暫以「每人」解讀；牛皮盒、鋁箔袋、條碼、五金組裝、氣泡袋、放數尚無附加工時；多個附加元素直接相加；每卡最少 10 分鐘。',
  '工作天用台灣行政日曆（內建 2026–2027，含國定假日與補班）；包裝部週六是否上班未定。',
  '採購行只看近 180 天開單；打樣單判定只看近 365 天出單表，更早的訂單只能靠品名含「打樣」（「無打樣」「比照打樣」「打樣偏黃」這類否定／引述寫法不算）。',
  '出單表記的 SO 項次與採購品號不符時（ERP 改過項次），改依品號對應並標「品號不符」；採購行不會被對到運費等費用行。',
  '品檢中數量＝塔台轉運站報到台量 − 已入庫量；轉運站沒有報工量時，整個未入庫量都算品檢中。',
  '常平出貨備註只有寫「未包裝」才改算廠內完整包裝工時（D28）；「回台包装」「台灣包裝」等寫法只標旗標請主管確認。',
  '資料更新頻率：ERP 訂單／採購每 5 分～1 小時；塔台排程每 30 分；出單表即時。',
]

// ─────────────────────────────────────────────────────────────────────
// 分頁工具
// ─────────────────────────────────────────────────────────────────────

type PageResult = { data: unknown[] | null; error: { message: string } | null; count?: number | null }
type RangeBuilder = { range(from: number, to: number): PromiseLike<PageResult> }

/** 第一頁帶 exact count，其餘頁並行抓；build 必須自帶固定排序（否則 range 分頁會漏列／重複） */
async function fetchAllPages<T>(label: string, build: (withCount: boolean) => RangeBuilder): Promise<T[]> {
  const first = await build(true).range(0, PAGE - 1)
  if (first.error) throw new Error(`讀取 ${label} 失敗：${first.error.message}`)
  const rows = [...((first.data ?? []) as T[])]
  const total = first.count ?? rows.length
  if (total > PAGE) {
    const offsets: number[] = []
    for (let o = PAGE; o < total; o += PAGE) offsets.push(o)
    const pages = await mapLimit(offsets, CONCURRENCY, async (o) => {
      const { data, error } = await build(false).range(o, o + PAGE - 1)
      if (error) throw new Error(`讀取 ${label} 失敗：${error.message}`)
      return (data ?? []) as T[]
    })
    for (const p of pages) rows.push(...p)
  }
  return rows
}

/** 大量 in() 條件分塊查詢（每塊仍分頁），限制同時請求數 */
async function fetchIn<T>(
  label: string,
  values: string[],
  build: (chunk: string[], withCount: boolean) => RangeBuilder,
): Promise<T[]> {
  const uniq = [...new Set(values.filter(Boolean))]
  const chunks: string[][] = []
  for (let i = 0; i < uniq.length; i += IN_CHUNK) chunks.push(uniq.slice(i, i + IN_CHUNK))
  const parts = await mapLimit(chunks, CONCURRENCY, (c) => fetchAllPages<T>(label, (wc) => build(c, wc)))
  return parts.flat()
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

// ─────────────────────────────────────────────────────────────────────
// 各表讀取
// ─────────────────────────────────────────────────────────────────────

// extra JSONB 只展開需要的鍵（整包數十欄，幾千列全抓很慢；比照 PO_SELECT）
const PO_SELECT = 'doc_no, sub_no, item_code, description, qty, status, start_date, end_date, customer_vendor, '
  + 'so_project_id:extra->>SO_PROJECT_ID, mbp_lot_no:extra->>MBP_LOT_NO, tpn_part_no:extra->>TPN_PART_NO, '
  + 'received_qty:extra->>RECEIVED_QTY, reject_qty:extra->>REJECT_QTY, close_flag:extra->>CLOSE_FLAG'

const SO_SELECT = 'id, project_id, line_no, mbp_part, description, packing, remark2, duedate, order_qty_oru, '
  + 'unit_of_measure_oru, partner_name, tpn_part_no, begin_date'

function fetchPoLines(supabase: SupabaseAdmin, today: string) {
  // start_date 存 'YYYY/MM/DD' 文字，字典序即日期序
  const from = addDays(today, -PO_WINDOW_DAYS).replace(/-/g, '/')
  return fetchAllPages<RawPoLine>('erp_pj_sync', (wc) => supabase
    .from('erp_pj_sync')
    .select(PO_SELECT, wc ? { count: 'exact' } : undefined)
    .eq('doc_type', '採購單號')
    .neq('status', 'VOID') // VOID 在表頭 status（extra 沒有 VOID 鍵）
    .gt('qty', 0) // 數量 0＝取消行
    .gte('start_date', from)
    // 只取有來源 SO/RO 的行（備料/庫存單不進池）
    .or('extra->>SO_PROJECT_ID.not.is.null,extra->>MBP_LOT_NO.like.SO*,extra->>MBP_LOT_NO.like.RO*')
    .order('doc_no', { ascending: true })
    .order('sub_no', { ascending: true }))
}

function fetchTracking(supabase: SupabaseAdmin) {
  return fetchAllPages<RawTracking>('po_line_tracking', (wc) => supabase
    .from('po_line_tracking')
    .select('doc_no, sub_no, shipped_at, ship_method, note', wc ? { count: 'exact' } : undefined)
    .order('doc_no', { ascending: true })
    .order('sub_no', { ascending: true }))
}

function fetchShipMarks(supabase: SupabaseAdmin) {
  // 本表限 Snow（lib/changpingShipOwner.ts）：只在伺服器端推導旗標，只 select 需要的欄位，任何欄位都不原樣回傳
  // （transport 只拿來補判寄送方式）
  return fetchAllPages<RawShipMark>('changping_ship_marks', (wc) => supabase
    .from('changping_ship_marks')
    .select('po_no, item_code, qty, ship_date, transport, match_status, matched_lines', wc ? { count: 'exact' } : undefined)
    .eq('still_marked', true)
    .order('mark_key', { ascending: true }))
}

function fetchLots(supabase: SupabaseAdmin) {
  return fetchAllPages<RawLot>('sara_lot_progress', (wc) => supabase
    .from('sara_lot_progress')
    .select('lot_id, mo_nbr, doc_nbr, so_line_no, product_name, lot_nbr, qty', wc ? { count: 'exact' } : undefined)
    .order('lot_id', { ascending: true }))
}

type DecodedMoRow = { mo_nbr: string; lot_nbr: string | null }

/** 報工紀錄一個製令同批會有多道工序、多筆報工 → 只留不重複的 (mo_nbr, lot_nbr) */
function uniqMoLot(rows: DecodedMoRow[]): DecodedMoRow[] {
  const seen = new Map<string, DecodedMoRow>()
  for (const r of rows) {
    const k = `${r.mo_nbr}|${r.lot_nbr ?? ''}`
    if (!seen.has(k)) seen.set(k, { mo_nbr: r.mo_nbr, lot_nbr: r.lot_nbr ?? null })
  }
  return [...seen.values()]
}

/**
 * D47：塔台報工紀錄的全部 MOT／MOS（2026-09-27 約 7,500 列＝8 頁，並行）。
 * 已結案批只剩 records 看得到；不能只抓 lots 的 mo_nbr（那只有未結案批）。
 * 舊式製令號（SO／RO 號本身）約 3.5 萬列，不全抓，改在第 ④ 波以候選單號精確查。
 */
async function fetchDecodableRecords(supabase: SupabaseAdmin): Promise<DecodedMoRow[]> {
  const rows = await fetchAllPages<DecodedMoRow>('sara_wip_records(MOT/MOS)', (wc) => supabase
    .from('sara_wip_records')
    .select('mo_nbr, lot_nbr', wc ? { count: 'exact' } : undefined)
    .or('mo_nbr.like.MOT*,mo_nbr.like.MOS*')
    .order('id', { ascending: true }))
  return uniqMoLot(rows)
}

function fetchSchedule(supabase: SupabaseAdmin) {
  return fetchAllPages<RawSchedule>('sara_wip_schedule', (wc) => supabase
    .from('sara_wip_schedule')
    .select('lot_id, mo_nbr, product_name, lot_nbr, workcenter_name, job_name, job_sequence, qty, wip_qty, system_status, plan_end_time',
      wc ? { count: 'exact' } : undefined)
    .order('jid', { ascending: true }))
}

// ── 出單表：模組快取，只重抓 updated_at 變動或新增的張數（冷啟動約 6MB）──

const sheetCache = new Map<string, { updatedAt: string | null; rows: RawSheetRow[] }>()

const str = (v: unknown): string | null => {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''
  return s === '' ? null : s
}

/** rows[] 只留判定要用的欄位（打樣單 D10、示意圖、PO/MPO 對應、D44 塔台比對與異常清單） */
function trimSheetRows(sheetDate: string, rows: unknown): RawSheetRow[] {
  if (!Array.isArray(rows)) return []
  const out: RawSheetRow[] = []
  for (const r of rows as Record<string, unknown>[]) {
    const so = str(r?.order_number)?.toUpperCase()
    if (!so) continue
    const urls = Array.isArray(r.sketch_urls) ? (r.sketch_urls as unknown[]) : []
    out.push({
      sheet_date: sheetDate,
      order_number: so,
      line_no: str(r.match_line_no) ?? str(r.line_no_input),
      doc_type: str(r.doc_type),
      po_number: str(r.po_number),
      po_sub_no: str(r.po_sub_no),
      pr_number: str(r.pr_number),
      pr_sub_no: str(r.pr_sub_no),
      has_sketch: urls.some((u) => typeof u === 'string' && u.trim() !== '') || !!str(r.sketch_url),
      factory: str(r.factory),
      mo_number: str(r.mo_number),
      item_name: str(r.item_name)?.slice(0, 40) ?? null,
    })
  }
  return out
}

async function loadSheetRows(supabase: SupabaseAdmin, today: string): Promise<{ rows: RawSheetRow[]; latest: string | null }> {
  const from = addDays(today, -SHEET_WINDOW_DAYS)
  const index = await fetchAllPages<{ sheet_date: string; updated_at: string | null }>('daily_order_sheets', (wc) => supabase
    .from('daily_order_sheets')
    .select('sheet_date, updated_at', wc ? { count: 'exact' } : undefined)
    .gte('sheet_date', from)
    .order('sheet_date', { ascending: true }))
  const want = new Set(index.map((x) => x.sheet_date))
  for (const k of [...sheetCache.keys()]) if (!want.has(k)) sheetCache.delete(k)
  const stale = index.filter((x) => sheetCache.get(x.sheet_date)?.updatedAt !== (x.updated_at ?? null)).map((x) => x.sheet_date)
  const groups: string[][] = []
  for (let i = 0; i < stale.length; i += 10) groups.push(stale.slice(i, i + 10)) // rows 很肥，一次 10 張
  await mapLimit(groups, CONCURRENCY, async (g) => {
    const { data, error } = await supabase
      .from('daily_order_sheets')
      .select('sheet_date, updated_at, rows')
      .in('sheet_date', g)
      .order('sheet_date', { ascending: true })
    if (error) throw new Error(`讀取 daily_order_sheets 失敗：${error.message}`)
    for (const s of (data ?? []) as { sheet_date: string; updated_at: string | null; rows: unknown }[]) {
      sheetCache.set(s.sheet_date, { updatedAt: s.updated_at ?? null, rows: trimSheetRows(s.sheet_date, s.rows) })
    }
  })
  const rows = index.flatMap((x) => sheetCache.get(x.sheet_date)?.rows ?? [])
  const latest = index.map((x) => x.updated_at).filter((v): v is string => !!v).sort().pop() ?? null
  return { rows, latest }
}

// ── 新鮮度：各表最新同步時間（PostgREST 停用聚合，用 order desc limit 1）──

async function latestOf(supabase: SupabaseAdmin, table: string, col: string, eq?: [string, string]): Promise<string | null> {
  let q = supabase.from(table).select(col).not(col, 'is', null)
  if (eq) q = q.eq(eq[0], eq[1])
  const { data, error } = await q.order(col, { ascending: false }).limit(1)
  if (error || !data?.[0]) return null
  const v = (data[0] as unknown as Record<string, unknown>)[col]
  return typeof v === 'string' ? v : null
}

/**
 * ERP 最後一次「成功同步」時間：讀 erp_sync_logs（每次同步一列，含 0 變動的執行）。
 * 不能用表內 max(synced_at)：對帳模式只有資料列變動才更新 synced_at，連假沒新單時會被誤判成同步停擺。
 * 讀不到 log（migration 未跑等）才退回 max(synced_at)（比照 /api/purchasing/sync-status）。
 */
async function lastErpSync(supabase: SupabaseAdmin, action: 'sync_so' | 'sync_po', fallback: () => Promise<string | null>): Promise<string | null> {
  const { data, error } = await supabase
    .from('erp_sync_logs')
    .select('created_at')
    .eq('action', action)
    .eq('ok', true)
    .order('created_at', { ascending: false })
    .limit(1)
  const v = !error ? (data?.[0] as { created_at?: unknown } | undefined)?.created_at : null
  return typeof v === 'string' ? v : fallback()
}

async function loadFreshness(supabase: SupabaseAdmin): Promise<Omit<PoolFreshness, 'orderSheet'>> {
  const [erpSo, erpPo, saraSchedule, saraRecords, changping] = await Promise.all([
    lastErpSync(supabase, 'sync_so', () => latestOf(supabase, 'erp_so_lines', 'synced_at')),
    lastErpSync(supabase, 'sync_po', () => latestOf(supabase, 'erp_pj_sync', 'synced_at', ['doc_type', '採購單號'])),
    latestOf(supabase, 'sara_wip_schedule', 'synced_at'),
    latestOf(supabase, 'sara_wip_records', 'imported_at'),
    latestOf(supabase, 'po_line_tracking', 'updated_at', ['updated_by', '常平出貨同步']),
  ])
  return { erpSo, erpPo, saraSchedule, saraRecords, changping }
}

// ─────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────

/** 讀完所有原始列（供 classifyPool 與驗證腳本共用） */
export async function loadPoolRawData(supabase: SupabaseAdmin, today: string) {
  // ① 彼此獨立的讀取
  const [poLines, tracking, shipMarks, lots, schedule, sheets, tables, fresh, decodableRecords] = await Promise.all([
    fetchPoLines(supabase, today),
    fetchTracking(supabase),
    fetchShipMarks(supabase),
    fetchLots(supabase),
    fetchSchedule(supabase),
    loadSheetRows(supabase, today),
    loadStdTimeTables(supabase),
    loadFreshness(supabase),
    fetchDecodableRecords(supabase),
  ])

  // ② SO 集合：採購行來源單（SO/SOB/RO 直接查；RO 另抓前單號＝RO 的 SO 當橋接候選，
  //    是否採用由 classify 以開單日相差 30 天內判定）、出單表對到的 SO、塔台批的 doc_nbr
  const soSet = new Set<string>()
  const roSet = new Set<string>()
  const addOrder = (v: string | null | undefined) => {
    const s = (v ?? '').trim().toUpperCase()
    if (!s) return
    if (s.startsWith('RO')) { roSet.add(s); soSet.add(s) } // RO 本身也是 erp_so_lines 的單號；另查前單號橋接
    else if (/^SO/.test(s)) soSet.add(s)
  }
  for (const po of poLines) addOrder(sourceOrderOf(po))
  const poKeys = new Set(poLines.map((p) => `${p.doc_no.toUpperCase()}|${p.sub_no}`))
  for (const r of sheets.rows) {
    if (r.po_number && r.po_sub_no && poKeys.has(`${r.po_number.toUpperCase()}|${r.po_sub_no}`)) addOrder(r.order_number)
  }
  // D44：出單表上的每一張訂單都要知道 ERP 是否仍未結案（erp_so_lines 查得到＝未結案）
  for (const r of sheets.rows) addOrder(r.order_number)
  for (const l of lots) addOrder(l.doc_nbr)

  if (roSet.size > 0) {
    const bridged = await fetchIn<{ id: number; project_id: string; tpn_part_no: string | null }>('erp_so_lines(RO)', [...roSet], (c, wc) => supabase
      .from('erp_so_lines')
      .select('id, project_id, tpn_part_no', wc ? { count: 'exact' } : undefined)
      .in('tpn_part_no', c)
      .order('id', { ascending: true }))
    for (const b of bridged) soSet.add(b.project_id.toUpperCase())
  }
  const soLines = await fetchIn<RawSoLine & { id: number }>('erp_so_lines', [...soSet], (c, wc) => supabase
    .from('erp_so_lines')
    .select(SO_SELECT, wc ? { count: 'exact' } : undefined)
    .in('project_id', c)
    .order('id', { ascending: true }))
  const openSo = new Set(soLines.map((l) => l.project_id.toUpperCase()))

  // ③ 塔台報工紀錄（records 永不刪除，4 萬多列 → 只抓需要的 mo_nbr）與製令對照
  const moSet = new Set<string>(lots.map((l) => l.mo_nbr))
  for (const po of poLines) {
    if (!/^POC/i.test(po.doc_no)) continue
    const so = sourceOrderOf(po)
    if (so && !so.startsWith('RO') && !openSo.has(so)) continue // SO 已結案的不必查
    moSet.add(pocSaraMo(po))
    moSet.add(po.doc_no) // 舊單 mo_nbr 無 -n 後綴
  }
  const moSo = [...new Set(lots.filter((l) => /^(MOT|MOS)/i.test(l.mo_nbr)).map((l) => (l.doc_nbr ?? '').toUpperCase()).filter((s) => openSo.has(s)))]
  const [records, moLines] = await Promise.all([
    fetchIn<RawRecord>('sara_wip_records', [...moSet], (c, wc) => supabase
      .from('sara_wip_records')
      .select('mo_nbr, product_name, lot_nbr, workcenter_name, job_name, job_sequence, status, source_type, wip_qty',
        wc ? { count: 'exact' } : undefined)
      .in('mo_nbr', c)
      .order('id', { ascending: true })),
    fetchIn<RawMoLine>('erp_mo_lines', moSo, (c, wc) => supabase
      .from('erp_mo_lines')
      .select('project_id, source_order, mbp_part', wc ? { count: 'exact' } : undefined)
      .in('source_order', c)
      .order('id', { ascending: true })),
  ])

  // ④ D43/D44：出單表單號在批／排程／已抓報工紀錄都對不到 → 以「原樣＋（有 -n 時）舊式無後綴單號」精確補查 records（只要 mo_nbr）。
  //    不用前綴 like：40 個 or 條件一次約 0.5~1 秒、全部要 8 秒以上，併發時還會撞 statement timeout（2026-09-27 實測）
  //    D47：同一批仍對不到的出單列，另以訂單號本身查舊式製令號（mo_nbr＝SO／SOB／RO 號、lot＝項次），兩個查詢並行
  const sheetInput = { sheetRows: sheets.rows, soLines, lots, schedule, records, saraDecodedMos: decodableRecords }
  const refMos = unresolvedSheetMoRefs(sheetInput)
  const legacyMos = legacySaraCandidates(sheetInput)
  const [refRows, legacyRows] = await Promise.all([
    fetchIn<{ mo_nbr: string }>('sara_wip_records(出單表比對)', refMos, (c, wc) => supabase
      .from('sara_wip_records')
      .select('mo_nbr', wc ? { count: 'exact' } : undefined)
      .in('mo_nbr', c)
      .order('id', { ascending: true })),
    fetchIn<DecodedMoRow>('sara_wip_records(舊式製令號)', legacyMos, (c, wc) => supabase
      .from('sara_wip_records')
      .select('mo_nbr, lot_nbr', wc ? { count: 'exact' } : undefined)
      .in('mo_nbr', c)
      .order('id', { ascending: true })),
  ])
  const saraRefMos = [...new Set(refRows.map((r) => r.mo_nbr))]
  const saraDecodedMos = uniqMoLot([...decodableRecords, ...legacyRows])

  const raw: PoolRawData = {
    today,
    poLines,
    tracking,
    shipMarks,
    soLines,
    lots,
    schedule,
    records,
    sheetRows: sheets.rows,
    moLines,
    saraRefMos,
    saraDecodedMos,
  }
  const freshness: PoolFreshness = { ...fresh, orderSheet: sheets.latest }
  return { raw, tables, freshness }
}

/** 組出 GET /api/packaging/pool 的成功回應（快取由 route 處理） */
export async function buildPackagingPool(supabase: SupabaseAdmin, now: Date = new Date()): Promise<PoolOk> {
  const today = todayTaipei(now)
  const { raw, tables, freshness } = await loadPoolRawData(supabase, today)
  // 工時：stdTime 回傳完整拆解（WorkEstimate），直接放進卡片
  const estimate: WorkEstimator = (input) => computeStdTime(input, tables).work
  const result = classifyPool(raw, estimate)
  const fromYear = Number(CALENDAR_COVERAGE.from.slice(0, 4))
  const toYear = Number(CALENDAR_COVERAGE.to.slice(0, 4))
  return {
    success: true,
    generatedAt: now.toISOString(),
    today,
    blocks: result.blocks,
    freshness,
    excluded: result.excluded,
    calendar: {
      source: result.calendarFallback ? 'fallback' : 'static',
      coveredYears: Array.from({ length: toYear - fromYear + 1 }, (_, i) => fromYear + i),
    },
    notes: POOL_NOTES,
    cached: false,
    staleUnsynced: result.staleUnsynced,
  }
}
