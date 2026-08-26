import { NextRequest, NextResponse } from 'next/server'

import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'
import { matchMoToOrder } from '@/lib/moLineMatch'

// ─────────────────────────────────────────────────────────────────────────────
// 業務訂單修改 LOG（唯讀）
//
// 資料來源＝既有的 5 分鐘增量同步已經在寫的 `erp_change_log`（action='sync_so'），
// 裡面每筆都含 before / after / changed_fields。本端點不做任何同步、不寫任何表，
// 只把那些紀錄「翻譯成人看得懂的一句話」。
//
// change_log 本身沒有「誰改的」，所以這裡即時向 ARGO 補查兩件事：
//   1. PJ_PROJECTDETAIL / PJ_PROJECT 的 UPDATE_BY、UPDATE_DATE（行層級，精確到秒）
//      → UPDATE_BY 是「實際動手改的人」的工號，與 SALES_ID（訂單掛名業務）不一定相同。
//   2. HR_PERSONNEL 的 ID → NAME（工號對姓名，全公司名單，比 members 表完整）
//
// 已知限制（顯示時會標記，不要當成稽核級證據）：
//   * 被刪除的行在 ARGO 已不存在 → 只能退而用「表頭」的 UPDATE_BY/UPDATE_DATE，
//     代表「這張單最後是誰動的」，未必就是刪掉這一行的人 → approximate=true。
//   * ARGO 行號（LINE_NO）會被重用/位移：在中間插一行，後面所有行的行號會往後推，
//     內容比對就會看起來像「這幾行的料號被改掉」。這類位移無法從 change_log 分辨。
// ─────────────────────────────────────────────────────────────────────────────

const API_BASE = process.env.ARGOERP_API_BASE!
const USERNAME = process.env.ARGOERP_USERNAME!
const PASSWORD = process.env.ARGOERP_PASSWORD!
const SEGMENT = process.env.ARGOERP_SEGMENT!

const ARGO_ID_BATCH = 150 // 一次帶幾個單號進 IN 條件

/** 欄位代碼 → 中文欄位名（顯示用） */
const FIELD_LABEL: Record<string, string> = {
  mbp_part: '料號',
  description: '品名/規格',
  order_qty_oru: '數量',
  duedate: '交期',
  packing: 'PACKING',
  remark2: '商品備註',
  remark: '商品備註',
  partner_name: '客戶名稱',
  hold_status: '訂單狀態',
  delivery_address: '交貨地址',
  unit_of_measure_oru: '單位',
  sales_name: '業務員',
  customer_remark: '訂單備註',
  invoice_format: '發票型態',
  tpn_part_no: '客戶單號',
  grade: '等級',
  mbp_ver: '料號版本',
  begin_date: '訂單日期',
  tpn_partner_id: '客戶代號',
  sales_id: '業務代號',
  unit_price_oru: '單價',
  currency: '幣別',
  exchange_rate: '匯率',
  department: '部門',
  sales_category: '銷售類別',
}

/** 純技術欄位：本身不是業務改的內容，不列進 LOG */
const NOISE_FIELDS = new Set(['synced_at', 'create_date', 'update_date', 'pdl_seq'])

/** 只影響帳務、不影響生產的欄位 → 一律通知財務部門，與發單狀態無關 */
const FINANCE_FIELDS = new Set([
  'unit_price_oru', 'currency', 'exchange_rate', 'invoice_format', 'tpn_partner_id',
])

/** 影響出貨端（交期、地址、包裝）→ 已發單時連包裝出貨都要知道 */
const SHIPPING_FIELDS = new Set(['duedate', 'delivery_address', 'packing'])

/**
 * 這筆變動該通知誰。
 *   - 金額/發票類 → 財務部門（不影響生產）
 *   - 其餘欄位：已發單 → 全廠（交期、包裝另註明含包裝出貨）；未發單 → 美編部門
 * 未發單代表工單還沒發到現場，不影響生產，但美編可能已依舊內容作業。
 */
function notifyTarget(field: string, dispatched: boolean): { target: string; note: string } {
  if (FINANCE_FIELDS.has(field)) {
    return { target: '財務部門', note: '不影響生產，僅影響帳務' }
  }
  if (!dispatched) {
    return { target: '美編部門', note: '尚未發單，不影響生產' }
  }
  if (SHIPPING_FIELDS.has(field)) {
    return { target: '全廠', note: '已發單，含包裝出貨都需知悉' }
  }
  return { target: '全廠', note: '已發單，現場正在依舊內容作業' }
}

/** UPDATE_BY 不是工號而是系統帳號時的顯示名稱（介面檔/API 寫入，非真人操作） */
const SYSTEM_ACTORS: Record<string, string> = {
  ARGOERP: '系統／介面寫入',
}

interface ApiKeys { APIKEY1: string; APIKEY2: string; APIKEY3: string }

async function getApiKeys(): Promise<ApiKeys> {
  const res = await fetch(`${API_BASE}/S_APIKEY`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`S_APIKEY failed: ${res.status}`)
  const data = await res.json() as { RESULT?: ApiKeys }
  if (!data.RESULT?.APIKEY1) throw new Error('S_APIKEY returned no keys')
  return data.RESULT
}

async function argoQuery(
  keys: ApiKeys,
  params: Record<string, string>,
): Promise<Record<string, unknown>[]> {
  const sparam = JSON.stringify({
    APIKEY1: keys.APIKEY1, APIKEY2: keys.APIKEY2, APIKEY3: keys.APIKEY3,
    SEGMENT, ...params,
  })
  const res = await fetch(`${API_BASE}/S_QUERY`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sparam }),
  })
  if (!res.ok) return []
  const data = await res.json() as { RESULT?: unknown }
  return Array.isArray(data.RESULT) ? data.RESULT as Record<string, unknown>[] : []
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const inClause = (ids: string[]) => `IN (${ids.map((i) => `'${String(i).replace(/'/g, "''")}'`).join(',')})`

/** ARGO 日期字串 '2026/08/25 17:57:32' → 排序用的可比較字串 */
function argoTimeKey(v: string): string {
  return v.replace(/\//g, '-').replace(' ', 'T')
}

type Row = Record<string, unknown>

interface ChangeLogRow {
  id: number
  doc_no: string
  sub_no: string | null
  change_type: 'insert' | 'update' | 'delete'
  changed_fields: string[] | null
  before: Row | null
  after: Row | null
  created_at: string
}

/** 一個訂單行的下游狀態：發到哪了、影響哪些單位 */
export interface LineImpact {
  /** 未發單 / 已開製令 / 已發單上傳 / 已備料 / 生產中 */
  dispatchState: string
  /** 對應到的製令號 */
  moNumbers: string[]
  /**
   * 對應可信度：製令號末兩碼＝發單當下的訂單行號，行號位移時會對不上，
   * 故同時用料號交叉驗證，只有兩者都中才算可信。
   */
  matchConfidence: '雙重吻合' | '僅末碼' | '僅料號' | '對不到此行' | '未發單'
  /** 塔台整批進度（%），null=塔台沒有這一批 */
  progress: number | null
  /** 塔台警示，例：["skip_station"] */
  warnings: string[]
  /** 目前在跑或暫停的工序 */
  running: Array<{ station: string; job: string; status: string; qty: number | null; done: number | null; resource: string | null }>
  /** 這一行會經過的工作中心（塔台排程實際有的；沒有塔台資料時用料號的標準途程預測） */
  stations: string[]
  /** stations 是預測值而非塔台實際排程 */
  stationsPredicted: boolean
  /**
   * 這張訂單目前有幾張工單的行號已經失效（0＝沒有）。
   * 錯位常是好幾週前的改單累積造成的，所以這是「現況」而非「這次操作造成的」，
   * 點進「工單對位體檢」可看明細。
   */
  misalignedMos: number
}

export interface EditLogEntry {
  /** 唯一鍵（同一次操作的多個欄位共用 groupKey） */
  key: string
  groupKey: string
  /** ARGO 實際異動時間（'2026/08/25 17:57:32'），取不到時退回偵測時間 */
  at: string
  /** 工號（ARGO UPDATE_BY / CREATE_BY） */
  empNo: string
  /** 姓名（ARGO HR_PERSONNEL） */
  empName: string
  action: '新增' | '修改' | '刪除'
  docNo: string
  lineNo: string
  /** 該訂單掛名的業務員（≠ 動手改的人時，前端會並列顯示） */
  salesName: string
  field: string
  fieldLabel: string
  oldValue: string | null
  newValue: string | null
  /** true = 時間/人員是用「表頭最後異動」推得，非該行本身 */
  approximate: boolean
  /** 同步偵測到的時間（最晚比實際異動晚 5 分鐘） */
  detectedAt: string
  /** 這一行的下游狀態（同一訂單行的多個欄位共用同一份） */
  impact: LineImpact
  /** 這筆變動該通知哪個單位 */
  notify: { target: string; note: string }
}

function toText(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  return String(v)
}

const EMPTY_IMPACT: LineImpact = {
  dispatchState: '未發單', moNumbers: [], matchConfidence: '未發單',
  progress: null, warnings: [], running: [], stations: [], stationsPredicted: false,
  misalignedMos: 0,
}

type Supa = ReturnType<typeof getSupabaseAdminClient>

// PostgREST 單次請求最多回 1000 列（伺服器端 max-rows），.limit(5000) 也只會拿到 1000。
// 少讀到製令就會把「已發單」誤判成「未發單」，所以一律分頁讀到底。
const PAGE = 1000

/**
 * 分批 IN 查詢 + 分頁讀取。
 * 分批是因為 in() 條件太長會被拒；分頁是因為單次最多 1000 列。
 */
async function inBatches<T>(
  supabase: Supa, table: string, col: string, values: string[], select: string,
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < values.length; i += 150) {
    const slice = values.slice(i, i + 150)
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from(table).select(select).in(col, slice).range(from, from + PAGE - 1)
      if (error) throw error
      const batch = (data ?? []) as unknown as T[]
      out.push(...batch)
      if (batch.length < PAGE) break
    }
  }
  return out
}

/**
 * 算出每個訂單行的下游狀態。
 *
 * 「這一行有沒有發單」靠製令號末兩碼＝發單當下的訂單行號
 * （MOT26072800703 → SO260728007 的第 3 行），再用料號交叉驗證。
 * 訂單中間插行會讓行號整體位移、末碼對不上，此時寧可標「對不到此行」也不亂猜。
 */
async function buildImpacts(
  supabase: Supa,
  logs: ChangeLogRow[],
  docIds: string[],
): Promise<Map<string, LineImpact>> {
  const result = new Map<string, LineImpact>()
  if (docIds.length === 0) return result

  interface MoRow { project_id: string; mbp_part: string | null; source_order: string }
  interface LotRow { doc_nbr: string; so_line_no: string | null; progress_percentage: number | null; warning_state: unknown }
  interface JobRow {
    doc_nbr: string; so_line_no: string | null; workcenter_name: string | null; job_name: string | null
    job_sequence: number | null
    system_status: string | null; qty: number | null; wip_qty: number | null; report_resource_name: string | null
  }

  interface SoLineRow { project_id: string; line_no: string | number; mbp_part: string | null }

  const [mos, lots, jobs, soRows] = await Promise.all([
    inBatches<MoRow>(supabase, 'erp_mo_lines', 'source_order', docIds, 'project_id,mbp_part,source_order'),
    inBatches<LotRow>(supabase, 'sara_lot_progress', 'doc_nbr', docIds, 'doc_nbr,so_line_no,progress_percentage,warning_state'),
    inBatches<JobRow>(supabase, 'sara_wip_schedule', 'doc_nbr', docIds,
      'doc_nbr,so_line_no,workcenter_name,job_name,job_sequence,system_status,qty,wip_qty,report_resource_name'),
    // 對位判斷要看整張訂單的行，不能只看被改到的那幾行
    inBatches<SoLineRow>(supabase, 'erp_so_lines', 'project_id', docIds, 'project_id,line_no,mbp_part'),
  ])

  const orderLinesBySo = new Map<string, { lines: Map<string, string | null>; parts: Map<string, string[]> }>()
  for (const r of soRows) {
    if (!orderLinesBySo.has(r.project_id)) {
      orderLinesBySo.set(r.project_id, { lines: new Map(), parts: new Map() })
    }
    const e = orderLinesBySo.get(r.project_id)!
    const ln = String(r.line_no)
    e.lines.set(ln, r.mbp_part)
    if (r.mbp_part) e.parts.set(r.mbp_part, [...(e.parts.get(r.mbp_part) ?? []), ln])
  }

  const moNos = Array.from(new Set(mos.map((m) => m.project_id)))
  const [uploads, preps] = moNos.length
    ? await Promise.all([
      inBatches<{ mo_number: string }>(supabase, 'argoerp_mo_upload_log', 'mo_number', moNos, 'mo_number'),
      inBatches<{ mo_number: string }>(supabase, 'argoerp_material_prep_log', 'mo_number', moNos, 'mo_number'),
    ])
    : [[], []]
  const uploaded = new Set(uploads.map((u) => u.mo_number))
  const prepared = new Set(preps.map((p) => p.mo_number))

  // 塔台沒有資料時，用料號的標準途程預測會經過哪些站
  const parts = Array.from(new Set(logs.flatMap((l) =>
    [(l.after as Row | null)?.mbp_part, (l.before as Row | null)?.mbp_part]).filter(Boolean).map(String)))
  const routes = parts.length
    ? await inBatches<{ item_code: string; route_id: string }>(supabase, 'item_routes', 'item_code', parts, 'item_code,route_id')
    : []
  const routeOf = new Map(routes.map((r) => [r.item_code, r.route_id]))
  const rids = Array.from(new Set(routes.map((r) => r.route_id)))
  const opsOf = new Map<string, { sequence: number; op_name: string }[]>()
  if (rids.length) {
    const ops = await inBatches<{ route_id: string; sequence: number; op_name: string }>(
      supabase, 'route_operations', 'route_id', rids, 'route_id,sequence,op_name')
    for (const o of ops) {
      const arr = opsOf.get(o.route_id) ?? []
      arr.push(o)
      opsOf.set(o.route_id, arr)
    }
    for (const arr of opsOf.values()) arr.sort((a, b) => a.sequence - b.sequence)
  }

  const moBySo = new Map<string, MoRow[]>()
  for (const m of mos) {
    const arr = moBySo.get(m.source_order) ?? []
    arr.push(m)
    moBySo.set(m.source_order, arr)
  }
  const key = (doc: string, line: string) => `${doc}|${line}`
  const lotBy = new Map<string, LotRow[]>()
  for (const l of lots) if (l.so_line_no) {
    const k = key(l.doc_nbr, l.so_line_no)
    lotBy.set(k, [...(lotBy.get(k) ?? []), l])
  }
  const jobBy = new Map<string, JobRow[]>()
  for (const j of jobs) if (j.so_line_no) {
    const k = key(j.doc_nbr, j.so_line_no)
    jobBy.set(k, [...(jobBy.get(k) ?? []), j])
  }

  // 這些訂單目前各有幾張工單行號已失效（供 LOG 上的可點標記用）
  const misalignBySo = new Map<string, number>()
  for (const [so, list] of moBySo) {
    const soRows = orderLinesBySo.get(so)
    if (!soRows) continue
    let n = 0
    for (const m of list) {
      const r = matchMoToOrder({
        moNbr: m.project_id, moPart: m.mbp_part,
        orderLines: soRows.lines, partLines: soRows.parts,
      })
      if (r.kind === 'shifted' || r.kind === 'missing') n += 1
    }
    if (n > 0) misalignBySo.set(so, n)
  }

  for (const log of logs) {
    const doc = log.doc_no
    const line = String(log.sub_no ?? '')
    const k = key(doc, line)
    if (result.has(k)) continue

    const after = (log.after ?? {}) as Row
    const before = (log.before ?? {}) as Row
    const part = toText(after.mbp_part) ?? toText(before.mbp_part)

    const all = moBySo.get(doc) ?? []
    // 末兩碼＝發單當下的訂單行號（去掉 -1 這類補印尾碼後再取）
    const byTail = all.filter((m) => {
      const head = m.project_id.split('-')[0]
      const tail = head.slice(-2)
      return /^\d{2}$/.test(tail) && String(parseInt(tail, 10)) === line
    })
    const byPart = part ? all.filter((m) => m.mbp_part === part) : []
    const both = byTail.filter((m) => byPart.includes(m))

    let cand: MoRow[]
    let conf: LineImpact['matchConfidence']
    if (both.length) { cand = both; conf = '雙重吻合' }
    else if (byTail.length) { cand = byTail; conf = '僅末碼' }
    else if (byPart.length) { cand = byPart; conf = '僅料號' }
    else { cand = []; conf = all.length ? '對不到此行' : '未發單' }

    const lotRows = lotBy.get(k) ?? []
    const jobRows = jobBy.get(k) ?? []
    const running = jobRows
      .filter((j) => j.system_status === 'running' || j.system_status === 'pause')
      .map((j) => ({
        station: j.workcenter_name ?? '', job: j.job_name ?? '', status: j.system_status ?? '',
        qty: j.qty, done: j.wip_qty, resource: j.report_resource_name,
      }))

    let state: string
    if (running.length) state = '生產中'
    else if (cand.some((m) => prepared.has(m.project_id))) state = '已備料'
    else if (cand.some((m) => uploaded.has(m.project_id))) state = '已發單上傳'
    else if (cand.length) state = '已開製令'
    else if (all.length) state = '該單已發單'
    else state = '未發單'

    // 站別優先用塔台實際排程；塔台沒這批才用標準途程預測。
    // 一定要依 job_sequence 排序，否則會印出「包裝站 → 印刷站」這種顛倒的順序。
    let stations = Array.from(new Set(
      [...jobRows]
        .sort((a, b) => (a.job_sequence ?? 9999) - (b.job_sequence ?? 9999))
        .map((j) => j.workcenter_name)
        .filter(Boolean) as string[],
    ))
    let predicted = false
    if (stations.length === 0 && part) {
      const rid = routeOf.get(part)
      const ops = rid ? opsOf.get(rid) ?? [] : []
      stations = ops.map((o) => o.op_name)
      predicted = stations.length > 0
    }

    const warnings = lotRows.flatMap((l) => Array.isArray(l.warning_state) ? l.warning_state as string[] : [])
    const progs = lotRows.map((l) => l.progress_percentage).filter((p): p is number => p != null)

    result.set(k, {
      dispatchState: state,
      moNumbers: cand.map((m) => m.project_id),
      matchConfidence: conf,
      progress: progs.length ? Math.min(...progs) : null,
      warnings: Array.from(new Set(warnings)),
      running,
      stations,
      stationsPredicted: predicted,
      misalignedMos: misalignBySo.get(doc) ?? 0,
    })
  }

  return result
}

export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res

  try {
    const sp = new URL(request.url).searchParams
    const days = Math.min(Math.max(Number(sp.get('days') ?? 3), 1), 30)
    const limit = Math.min(Math.max(Number(sp.get('limit') ?? 400), 1), 8000)

    const since = new Date(Date.now() - days * 86400_000).toISOString()

    // 1) 讀既有 change_log（不寫入、不同步）
    // 單次請求上限 1000 列，要分頁讀滿 limit，否則「近 N 天」會靜默只給最新那 1000 筆
    const supabase = getSupabaseAdminClient()
    const logs: ChangeLogRow[] = []
    for (let from = 0; from < limit; from += PAGE) {
      const to = Math.min(from + PAGE, limit) - 1
      const { data, error } = await supabase
        .from('erp_change_log')
        .select('id, doc_no, sub_no, change_type, changed_fields, before, after, created_at')
        .eq('action', 'sync_so')
        .gte('created_at', since)
        .order('id', { ascending: false })
        .range(from, to)
      if (error) throw error
      const batch = (data ?? []) as unknown as ChangeLogRow[]
      logs.push(...batch)
      if (batch.length < to - from + 1) break
    }
    /** 達到上限＝可能還有更舊的沒讀到，要讓前端知道，不能靜默截斷 */
    const truncated = logs.length >= limit

    if (logs.length === 0) {
      return NextResponse.json({ status: 'ok', entries: [], days, scanned: 0 })
    }

    // 2) 向 ARGO 補查「誰、幾點」
    const keys = await getApiKeys()
    const docIds = Array.from(new Set(logs.map((l) => l.doc_no).filter(Boolean)))

    const detailWho = new Map<string, Row>()  // `${docNo}|${lineNo}` → row
    const headerWho = new Map<string, Row>()  // docNo → row
    for (const ids of chunk(docIds, ARGO_ID_BATCH)) {
      const [details, headers] = await Promise.all([
        argoQuery(keys, {
          TABLE: 'PJ_PROJECTDETAIL',
          SHOWCOLUMNTIME: 'Y',
          CUSTOMCOLUMN: 'PJT_PROJECT_ID,LINE_NO,UPDATE_BY,UPDATE_DATE,CREATE_BY,CREATE_DATE',
          PJT_PROJECT_ID: inClause(ids),
          LINE_NO: '>= 0',
        }),
        argoQuery(keys, {
          TABLE: 'PJ_PROJECT',
          SHOWCOLUMNTIME: 'Y',
          CUSTOMCOLUMN: 'PROJECT_ID,UPDATE_BY,UPDATE_DATE,CREATE_BY,CREATE_DATE,SALES_ID,SALES_NAME',
          PROJECT_ID: inClause(ids),
        }),
      ])
      for (const r of details) {
        detailWho.set(`${String(r.PJT_PROJECT_ID)}|${String(r.LINE_NO)}`, r)
      }
      for (const r of headers) headerWho.set(String(r.PROJECT_ID), r)
    }

    // 3) 工號 → 姓名（ARGO HR_PERSONNEL）
    // 查詢一定要帶條件，否則 ARGO 回 ORA 錯誤；公司工號全是 1 開頭（實測 77 人全中）。
    const empName = new Map<string, string>()
    const personnel = await argoQuery(keys, {
      TABLE: 'HR_PERSONNEL',
      CUSTOMCOLUMN: 'ID,NAME',
      ID: "LIKE '1%'",
      ROWNUM: '<= 2000',
    })
    for (const r of personnel) {
      const id = toText(r.ID)
      if (id) empName.set(id, String(r.NAME ?? ''))
    }

    // 3.5) 下游狀態：這一行發到哪了、影響哪些單位（全部批次查，避免逐列查表）
    const impacts = await buildImpacts(supabase, logs, docIds)

    // 4) 翻成人話
    const entries: EditLogEntry[] = []
    for (const log of logs) {
      const before = log.before ?? {}
      const after = log.after ?? {}
      const detail = detailWho.get(`${log.doc_no}|${log.sub_no ?? ''}`)
      const header = headerWho.get(log.doc_no)

      // 誰改的：新增看 CREATE_BY，修改看 UPDATE_BY；刪除的行 ARGO 已無 → 退回表頭
      let src = detail
      let approximate = false
      if (log.change_type === 'delete' || !src) {
        src = header
        approximate = true
      }
      const useCreate = log.change_type === 'insert' && !approximate
      const empNo = toText(src?.[useCreate ? 'CREATE_BY' : 'UPDATE_BY']) ?? ''
      const rawAt = toText(src?.[useCreate ? 'CREATE_DATE' : 'UPDATE_DATE'])
      const at = rawAt ?? log.created_at.slice(0, 19).replace('T', ' ')
      if (!rawAt) approximate = true

      const salesName = toText(after.sales_name) ?? toText(before.sales_name)
        ?? toText(header?.SALES_NAME) ?? ''
      const common = {
        groupKey: `${log.doc_no}|${empNo}|${at}`,
        at,
        empNo,
        empName: empName.get(empNo) ?? SYSTEM_ACTORS[empNo] ?? '',
        docNo: log.doc_no,
        lineNo: String(log.sub_no ?? ''),
        salesName,
        approximate,
        detectedAt: log.created_at,
        impact: impacts.get(`${log.doc_no}|${log.sub_no ?? ''}`) ?? EMPTY_IMPACT,
      }
      // 已發到現場（含備料、生產中）才會影響生產單位
      const dispatched = ['已發單上傳', '已備料', '生產中'].includes(common.impact.dispatchState)

      if (log.change_type === 'update') {
        const fields = (log.changed_fields ?? []).filter((f) => !NOISE_FIELDS.has(f))
        for (const f of fields) {
          entries.push({
            ...common,
            key: `${log.id}-${f}`,
            action: '修改',
            field: f,
            fieldLabel: FIELD_LABEL[f] ?? f,
            oldValue: toText(before[f]),
            newValue: toText(after[f]),
            notify: notifyTarget(f, dispatched),
          })
        }
      } else if (log.change_type === 'insert') {
        entries.push({
          ...common,
          key: `${log.id}-insert`,
          action: '新增',
          field: '_line',
          fieldLabel: '新增品項',
          oldValue: null,
          newValue: [toText(after.mbp_part), toText(after.description), `數量 ${toText(after.order_qty_oru) ?? '-'}`]
            .filter(Boolean).join(' / '),
          // 新增品項本身不動到既有製令，但會把後面的行號整批往後推
          notify: dispatched
            ? { target: '全廠', note: '該單已發單，插行會讓後面品項的工單行號失效' }
            : { target: '美編部門', note: '尚未發單，不影響生產' },
        })
      } else {
        entries.push({
          ...common,
          key: `${log.id}-delete`,
          action: '刪除',
          field: '_line',
          fieldLabel: '刪除品項',
          oldValue: [toText(before.mbp_part), toText(before.description), `數量 ${toText(before.order_qty_oru) ?? '-'}`]
            .filter(Boolean).join(' / '),
          newValue: null,
          notify: dispatched
            ? { target: '全廠', note: '該單已發單，刪行會讓後面品項的工單行號失效' }
            : { target: '美編部門', note: '尚未發單，不影響生產' },
        })
      }
    }

    // 依 ARGO 實際異動時間新→舊
    entries.sort((a, b) => argoTimeKey(b.at).localeCompare(argoTimeKey(a.at)))

    return NextResponse.json({
      status: 'ok',
      days,
      scanned: logs.length,
      truncated,
      oldestScanned: logs.length ? logs[logs.length - 1].created_at : null,
      entries,
    })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ status: 'error', error: msg }, { status: 500 })
  }
}
