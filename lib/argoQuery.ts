/**
 * ARGO S_QUERY 最小封裝（server-side only）
 *
 * 既有的 S_QUERY 呼叫全散在 app/api/argoerp/route.ts 內部，無法被其他路由 import
 * （route 檔只能匯出 HTTP method，否則 `next build --webpack` 會擋）。
 * 這裡抽出一份最小可用版，供需要「即時向 ARGO 求證」的路由使用。
 *
 * 用途聚焦：目前只服務製令繳庫查詢（fetchMoReceipt）。
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

async function getApiKeys(): Promise<ApiKeys> {
  if (keyCache && Date.now() - keyCache.at < KEY_TTL_MS) return keyCache.keys
  const res = await fetch(`${API_BASE}/S_APIKEY`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    cache: 'no-store',
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
