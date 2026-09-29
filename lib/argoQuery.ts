/**
 * ARGO S_QUERY 最小封裝（server-side only）
 *
 * 既有的 S_QUERY 呼叫全散在 app/api/argoerp/route.ts 內部，無法被其他路由 import
 * （route 檔只能匯出 HTTP method，否則 `next build --webpack` 會擋）。
 * 這裡抽出一份最小可用版，供需要「即時向 ARGO 求證」的路由使用。
 *
 * 用途聚焦：製令繳庫查詢（fetchMoReceipt）、包裝專區 D73 銷貨同步（argoQueryStrict，lib/packaging/salesSync.ts）。
 * 不打算取代 argoerp/route.ts 裡的同步邏輯，避免動到既有行為。
 */

const API_BASE = process.env.ARGOERP_API_BASE
const USERNAME = process.env.ARGOERP_USERNAME
const PASSWORD = process.env.ARGOERP_PASSWORD
const SEGMENT = process.env.ARGOERP_SEGMENT

/** ARGO 環境變數是否齊備（呼叫端可據此決定要不要走這條路） */
export function argoConfigured(): boolean {
  return Boolean(API_BASE && USERNAME && PASSWORD && SEGMENT)
}

interface ApiKeys {
  APIKEY1: string
  APIKEY2: string
  APIKEY3: string
}

// 金鑰有時效，但同一個熱實例短時間內重複取用沒必要每次都換一把
let keyCache: { keys: ApiKeys; at: number } | null = null
const KEY_TTL_MS = 10 * 60 * 1000

/** timeoutMs：只有 argoQueryStrict 會帶（ARGO 常逾時；既有呼叫端維持原本不設逾時的行為） */
async function getApiKeys(timeoutMs?: number): Promise<ApiKeys> {
  if (keyCache && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache.keys
  const res = await fetch(`${API_BASE}/S_APIKEY`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    cache: 'no-store',
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  })
  if (!res.ok) throw new Error(`S_APIKEY failed: ${res.status}`)
  const data = (await res.json()) as { RESULT?: ApiKeys }
  if (!data.RESULT?.APIKEY1) throw new Error('S_APIKEY returned no keys')
  keyCache = { keys: data.RESULT, at: Date.now() }
  return data.RESULT
}

/** ARGO 回應的巢狀結構不固定，往下找第一組物件陣列 */
function findObjectRows(value: unknown, seen = new Set<unknown>()): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return []
  if (seen.has(value)) return []
  seen.add(value)

  if (Array.isArray(value)) {
    const rows = value.filter(
      (i): i is Record<string, unknown> => Boolean(i) && typeof i === 'object' && !Array.isArray(i),
    )
    if (rows.length > 0) return rows
    for (const item of value) {
      const nested = findObjectRows(item, seen)
      if (nested.length > 0) return nested
    }
    return []
  }

  const record = value as Record<string, unknown>
  for (const key of ['RESULT', 'DATA', 'ROWS', 'rows', 'items', 'Table', 'TABLE']) {
    if (!(key in record)) continue
    const nested = findObjectRows(record[key], seen)
    if (nested.length > 0) return nested
  }
  for (const v of Object.values(record)) {
    const nested = findObjectRows(v, seen)
    if (nested.length > 0) return nested
  }
  return []
}

/**
 * 對 ARGO 發一次 S_QUERY。
 * conditions 的值是「運算子＋值」的字串，例如 `= 'MOT123'`、`<= 5`——與 ARGO 介面一致。
 */
export async function argoQuery(
  table: string,
  conditions: Record<string, string>,
  opts?: { showNull?: 'Y' | 'N' },
): Promise<Record<string, unknown>[]> {
  if (!argoConfigured()) throw new Error('未設定 ARGO 連線環境變數')
  const keys = await getApiKeys()
  const sparam = JSON.stringify({
    APIKEY1: keys.APIKEY1,
    APIKEY2: keys.APIKEY2,
    APIKEY3: keys.APIKEY3,
    SEGMENT,
    TABLE: table,
    SHOWNULLCOLUMN: opts?.showNull ?? 'N',
    ...conditions,
  })
  const res = await fetch(`${API_BASE}/S_QUERY`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sparam }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`S_QUERY ${table} failed: ${res.status}`)
  const text = await res.text()
  if (!text) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`S_QUERY ${table} 回應非 JSON: ${text.slice(0, 120)}`)
  }
  return findObjectRows(parsed)
}

/** ARGO 查詢失敗（逾時、HTTP 錯誤、ARGO 回報錯誤、回應格式不對）；retryable＝網路／逾時／5xx，可以重試 */
export class ArgoQueryError extends Error {
  readonly retryable: boolean
  readonly status: number | null
  constructor(message: string, opts: { retryable: boolean; status?: number | null }) {
    super(message)
    this.name = 'ArgoQueryError'
    this.retryable = opts.retryable
    this.status = opts.status ?? null
  }
}

/**
 * 嚴格版 S_QUERY（只查詢、不寫入）：與 argoQuery 送一樣的 sparam，但
 * - 金鑰與查詢都有逾時（timeoutMs，預設 60 秒；ARGO 常逾時，呼叫端自己決定要不要重試）
 * - 「ARGO 回報錯誤」與「查無資料」分得開：回應必須有 RESULT 陣列（可為空）；有 ERROR、STATUS 為失敗、
 *   或找不到 RESULT 一律丟 ArgoQueryError。
 *   為什麼要分：argoQuery 對 ORA-00904 之類的錯誤會回空陣列（argo-tool 也記過「整個查詢靜默回空」），
 *   用來做「整張 SO 重算覆蓋」的同步時，空陣列會被當成「沒有銷貨」而把鏡像清掉。
 * - customColumn：CUSTOMCOLUMN（只取需要的欄，回應小很多）
 * 失敗時清掉金鑰快取（可能是金鑰在 ARGO 端先過期），下一次重試會換一把。
 */
export async function argoQueryStrict(
  table: string,
  conditions: Record<string, string>,
  opts?: { customColumn?: string; showNull?: 'Y' | 'N'; timeoutMs?: number },
): Promise<Record<string, unknown>[]> {
  if (!argoConfigured()) throw new ArgoQueryError('未設定 ARGO 連線環境變數', { retryable: false })
  const timeoutMs = opts?.timeoutMs ?? 60_000
  const isAbort = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
  let keys: ApiKeys
  try {
    keys = await getApiKeys(timeoutMs)
  } catch (e) {
    keyCache = null
    throw new ArgoQueryError(isAbort(e) ? 'ARGO 取得金鑰逾時' : `ARGO 取得金鑰失敗：${e instanceof Error ? e.message : String(e)}`, { retryable: true })
  }
  const sparam = JSON.stringify({
    APIKEY1: keys.APIKEY1,
    APIKEY2: keys.APIKEY2,
    APIKEY3: keys.APIKEY3,
    SEGMENT,
    TABLE: table,
    SHOWNULLCOLUMN: opts?.showNull ?? 'N',
    ...(opts?.customColumn ? { CUSTOMCOLUMN: opts.customColumn } : {}),
    ...conditions,
  })
  let res: Response
  let text: string
  try {
    res = await fetch(`${API_BASE}/S_QUERY`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sparam }),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    text = await res.text()
  } catch (e) {
    throw new ArgoQueryError(isAbort(e) ? `S_QUERY ${table} 逾時（${Math.round(timeoutMs / 1000)} 秒）` : `S_QUERY ${table} 連線失敗`, { retryable: true })
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) keyCache = null
    throw new ArgoQueryError(`S_QUERY ${table} HTTP ${res.status}`, { retryable: res.status >= 500 || res.status === 401 || res.status === 403, status: res.status })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ArgoQueryError(`S_QUERY ${table} 回應不是 JSON`, { retryable: true, status: res.status })
  }
  const rec = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  const err = String(rec.ERROR ?? '').trim()
  const status = String(rec.STATUS ?? '').trim().toUpperCase()
  if (err || ['0', 'FALSE', 'N', 'ERROR'].includes(status)) {
    // 錯誤內容只取前 120 字（可能含欄位名，不含金鑰）；金鑰相關錯誤 → 清快取讓重試換新金鑰；
    // Oracle 端逾時（ORA-01013 使用者取消＝查詢逾時）也可以重試；其餘（ORA-00904 欄位錯等）重試也沒用
    const keyErr = /KEY|TOKEN|驗證|登入|EXPIRE/i.test(err)
    if (keyErr) keyCache = null
    throw new ArgoQueryError(`S_QUERY ${table} ARGO 回報錯誤：${(err || status).slice(0, 120)}`, { retryable: keyErr || /ORA-01013|TIMEOUT|逾時/i.test(err), status: res.status })
  }
  const result = rec.RESULT
  if (!Array.isArray(result)) {
    // ARGO 成功回應是 {STATUS:"1", RESULT:[…]}（argo-tool 實測；查無資料＝RESULT:[]）。
    // 只有「明確成功」的 STATUS 才把缺少／空字串的 RESULT 當成查無資料；其他一律當錯誤
    if (['1', 'Y', 'TRUE', 'OK', 'SUCCESS'].includes(status) && (result == null || result === '')) return []
    throw new ArgoQueryError(`S_QUERY ${table} 回應缺少 RESULT（無法分辨「查無資料」與錯誤）`, { retryable: true, status: res.status })
  }
  return result.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r))
}

/**
 * 對 ARGO 發一次 S_IMPORT（寫入介面）。回傳逐列結果供呼叫端判讀 CHECK_FLAG。
 * 與 app/api/argoerp/route.ts 的 import action 相同語意：RESULT 每列帶 LINE_NO/CHECK_FLAG，
 * 部分成功時呼叫端必須逐列比對，不可整批當成功或整批當失敗。
 */
export async function argoImport(
  interfaceId: string,
  data: Array<Record<string, string>>,
): Promise<{ success: boolean; partialSuccess: boolean; anySuccess: boolean; resultRows: Record<string, unknown>[]; error: string | null; rawText: string }> {
  if (!argoConfigured()) throw new Error('未設定 ARGO 連線環境變數')
  const keys = await getApiKeys()
  const sparam = JSON.stringify({
    APIKEY1: keys.APIKEY1,
    APIKEY2: keys.APIKEY2,
    APIKEY3: keys.APIKEY3,
    SEGMENT,
    IMP: 'Y',
    INTERFACE: interfaceId,
    DATA: data,
  })
  const res = await fetch(`${API_BASE}/S_IMPORT`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sparam }),
    cache: 'no-store',
  })
  const rawText = await res.text()
  let parsed: unknown = null
  try { parsed = rawText ? JSON.parse(rawText) : null } catch { /* 保留 rawText 供診斷 */ }

  const record = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  const resultRows = Array.isArray(record.RESULT) ? (record.RESULT as Record<string, unknown>[]) : []
  const hasCheckY = resultRows.some(row => String(row.CHECK_FLAG ?? '').toUpperCase() === 'Y')
  const hasCheckN = resultRows.some(row => String(row.CHECK_FLAG ?? '').toUpperCase() === 'N')
  // 與 app/api/argoerp/route.ts 的 isArgoSuccess 同語意：STATUS 只有明確為
  // 0/FALSE/N/ERROR 才算失敗（不能反過來要求必須是 '1'），且 ERROR 有值也算失敗
  const statusStr = String(record.STATUS ?? '').trim().toUpperCase()
  const statusFailed = ['0', 'FALSE', 'N', 'ERROR'].includes(statusStr)
  const error = String(record.ERROR ?? '').trim() || null
  const success = res.ok && (resultRows.length > 0 ? !hasCheckN : (!statusFailed && !error))

  return {
    success,
    partialSuccess: res.ok && hasCheckY && hasCheckN,
    anySuccess: hasCheckY,
    resultRows,
    error: success ? null : (error || `HTTP ${res.status}`),
    rawText: rawText.slice(0, 500),
  }
}

const n = (v: unknown): number => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

export interface MoReceiptLine {
  lineNo: number | null
  part: string | null
  orderQty: number
  actualQty: number
  rejectQty: number
  updateDate: string | null
}

export interface MoReceipt {
  /** completed=已足額繳庫；partial=部分；none=尚未繳庫；unknown=查不到或查詢失敗 */
  state: 'completed' | 'partial' | 'none' | 'unknown'
  orderQty: number
  actualQty: number
  rejectQty: number
  lines: MoReceiptLine[]
  lastUpdate: string | null
  error: string | null
}

const UNKNOWN: MoReceipt = {
  state: 'unknown',
  orderQty: 0,
  actualQty: 0,
  rejectQty: 0,
  lines: [],
  lastUpdate: null,
  error: null,
}

/**
 * 查製令的繳庫狀況（ARGO PJ_PROJECTDETAIL 的 ORDER_QTY / ACTUAL_QTY）。
 *
 * 為什麼一定要即時查 ARGO：
 * EIP 的 erp_mo_lines 只同步了 order_qty，沒有 actual_qty；hold_status 也不是完工旗標
 * （已完工的單照樣是 OPEN）。因此「這張製令做完了沒」在本地資料庫裡查不到，
 * 唯一可靠來源就是 ARGO 的繳庫數。
 */
export async function fetchMoReceipt(mo: string): Promise<MoReceipt> {
  const id = mo.trim()
  if (!id) return UNKNOWN
  if (!argoConfigured()) return { ...UNKNOWN, error: '未設定 ARGO 連線環境變數' }

  try {
    const rows = await argoQuery('PJ_PROJECTDETAIL', {
      PJT_PROJECT_ID: `= '${id.replace(/'/g, "''")}'`,
    })
    if (rows.length === 0) return UNKNOWN

    const lines: MoReceiptLine[] = rows.map((r) => ({
      lineNo: r.LINE_NO == null ? null : n(r.LINE_NO),
      part: (r.MBP_PART as string | null) ?? null,
      orderQty: n(r.ORDER_QTY),
      actualQty: n(r.ACTUAL_QTY),
      rejectQty: n(r.REJECT_QTY),
      updateDate: (r.UPDATE_DATE as string | null) ?? null,
    }))

    const orderQty = lines.reduce((s, l) => s + l.orderQty, 0)
    const actualQty = lines.reduce((s, l) => s + l.actualQty, 0)
    const rejectQty = lines.reduce((s, l) => s + l.rejectQty, 0)
    // 每一行都足額才算完工——單行足額不代表整張製令做完
    const allDone = lines.length > 0 && lines.every((l) => l.orderQty > 0 && l.actualQty >= l.orderQty)

    return {
      state: allDone ? 'completed' : actualQty > 0 ? 'partial' : 'none',
      orderQty,
      actualQty,
      rejectQty,
      lines,
      lastUpdate: lines.map((l) => l.updateDate).filter(Boolean).sort().pop() ?? null,
      error: null,
    }
  } catch (e) {
    return { ...UNKNOWN, error: e instanceof Error ? e.message : String(e) }
  }
}
