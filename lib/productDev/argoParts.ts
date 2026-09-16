/**
 * 商品開發專區 —— ARGO 料件主檔（MM_BOM_PART）唯讀查詢。
 *
 * 為什麼直接查 ARGO 而不是查 Supabase 的同步表？
 *   「引用既有品項」要複製的是會計科目、庫存類型、預設倉這種一改就出事的欄位，
 *   EIP 目前只同步了 mm_bom_part_units（料號→單位）。與其為此新增一條同步排程、
 *   多一個會過期的資料源，不如查詢當下直接向 ARGO 取真值 —— 引用來源永遠是最新的。
 *
 * 本檔只讀不寫：新品項一律由建檔人員在 ARGO（IFAF007 / BOMF027）手動建立。
 */

const API_BASE = process.env.ARGOERP_API_BASE
const USERNAME = process.env.ARGOERP_USERNAME
const PASSWORD = process.env.ARGOERP_PASSWORD
const SEGMENT = process.env.ARGOERP_SEGMENT

/** 引用範本要複製的 ERP 設定欄位（對應 item_code_requests 的同名欄位） */
export const PART_TEMPLATE_COLUMNS = [
  'PART', 'VER', 'PART_NAME', 'PART_DESC', 'UNIT_OF_MEASURE',
  'PRODUCT_CATEGORY', 'PRODUCT_CATEGORY_2',
  'SOURCE_TYPE', 'INVENTORY_TYPE', 'COST_CATEGORY', 'LEADTIME_FLAG',
  'BOM_WAREHOUSE_ID', 'LOT_NO_FLAG', 'EXPENSE_FLAG',
  'LEVEL_CODE_INV', 'ACCOUNT_NO_INV', 'SAFETY_QTY', 'VALIDDATE',
  'INVALID_FLAG',
].join(',')

/** 搜尋清單只要少數欄位，回應才不會肥 */
const PART_LIST_COLUMNS =
  'PART,VER,PART_NAME,PART_DESC,UNIT_OF_MEASURE,PRODUCT_CATEGORY,PRODUCT_CATEGORY_2,INVALID_FLAG'

export interface PartRow { [key: string]: string | number | null }

/**
 * 淨化進到 ARGO filter 的字串。
 *
 * ⚠️ ARGO S_QUERY 的 filter 值會被原樣拼進 Oracle 的 WHERE 子句
 *    （例：{"PART": "LIKE 'M%'"}），等同 SQL 片段注入點。
 *    這裡移除單引號與 LIKE 萬用字元，讓使用者輸入只能是「值」，跳不出字串。
 */
function sanitize(input: string): string {
  return input
    .replace(/['"\\]/g, '')          // 引號 / 跳脫字元：跳出字串的唯一途徑
    .replace(/[%_]/g, '')            // LIKE 萬用字元：避免使用者打出全表掃描
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
}

/** 料號另外限制字集：ARGO 料號只會是英數與 - _ . */
function sanitizePart(input: string): string {
  return sanitize(input).toUpperCase().replace(/[^A-Z0-9\-_.]/g, '')
}

async function getApiKeys(): Promise<{ APIKEY1: string; APIKEY2: string; APIKEY3: string }> {
  if (!API_BASE || !USERNAME || !PASSWORD || !SEGMENT) {
    throw new Error('ARGO 連線設定不完整（缺 ARGOERP_* 環境變數）')
  }
  const res = await fetch(`${API_BASE}/S_APIKEY`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`ARGO 取金鑰失敗（HTTP ${res.status}）`)
  const data = await res.json()
  const keys = data?.RESULT
  if (!keys?.APIKEY1) throw new Error('ARGO 取金鑰失敗（回應無金鑰）')
  return keys
}

async function queryParts(filter: Record<string, string>, columns: string): Promise<PartRow[]> {
  const keys = await getApiKeys()
  const sparam = JSON.stringify({
    APIKEY1: keys.APIKEY1, APIKEY2: keys.APIKEY2, APIKEY3: keys.APIKEY3,
    SEGMENT,
    TABLE: 'MM_BOM_PART',
    SHOWNULLCOLUMN: 'Y',
    CUSTOMCOLUMN: columns,
    ...filter,
  })
  const res = await fetch(`${API_BASE}/S_QUERY`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sparam }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ARGO 查詢失敗（HTTP ${res.status}）`)
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('ARGO 回應不是合法 JSON') }
  const record = parsed as Record<string, unknown>
  if (typeof record?.ERROR === 'string' && record.ERROR.trim()) throw new Error(record.ERROR)
  const rows = record?.RESULT ?? parsed
  if (Array.isArray(rows)) return rows as PartRow[]
  const nested = Object.values(rows as Record<string, unknown>).find(Array.isArray)
  return (nested as PartRow[]) ?? []
}

/** 同一料號可能有多版本（VER），引用時取最新版 */
function pickLatestVer(rows: PartRow[]): PartRow[] {
  const best = new Map<string, PartRow>()
  for (const r of rows) {
    const part = String(r.PART ?? '').trim()
    if (!part) continue
    const ver = Number(r.VER ?? 0)
    const prev = best.get(part)
    if (!prev || ver > Number(prev.VER ?? 0)) best.set(part, r)
  }
  return [...best.values()]
}

/**
 * 依料號或品名關鍵字搜尋既有品項（供「引用類似品項」挑範本用）。
 * 預設排除停用料號 —— 停用品的設定通常也已作廢，拿來當範本會複製到錯的科目。
 */
export async function searchParts(keyword: string, limit = 40): Promise<PartRow[]> {
  const kw = sanitize(keyword)
  if (kw.length < 2) return []
  const partKw = sanitizePart(keyword)
  const cap = Math.min(Math.max(limit, 1), 100)

  const jobs: Promise<PartRow[]>[] = []
  // 料號比對：使用者多半打前幾碼，前綴比對能吃到索引，也讓結果排序直覺
  if (partKw) {
    jobs.push(queryParts({ PART: `LIKE '${partKw}%'`, ROWNUM: `<=${cap}` }, PART_LIST_COLUMNS))
  }
  // 品名比對：中文品名只能全文包含
  jobs.push(queryParts({ PART_NAME: `LIKE '%${kw}%'`, ROWNUM: `<=${cap}` }, PART_LIST_COLUMNS))

  const settled = await Promise.allSettled(jobs)
  const rows = settled.flatMap(s => (s.status === 'fulfilled' ? s.value : []))
  if (!rows.length && settled.every(s => s.status === 'rejected')) {
    const first = settled[0]
    throw new Error(first.status === 'rejected' ? String(first.reason?.message ?? first.reason) : 'ARGO 查詢失敗')
  }
  return pickLatestVer(rows)
    .filter(r => String(r.INVALID_FLAG ?? '').toUpperCase() !== 'Y')
    .sort((a, b) => String(a.PART).localeCompare(String(b.PART)))
    .slice(0, cap)
}

/** 取單一料號的完整設定（引用帶入用） */
export async function getPartTemplate(part: string): Promise<PartRow | null> {
  const p = sanitizePart(part)
  if (!p) return null
  const rows = await queryParts({ PART: `='${p}'` }, PART_TEMPLATE_COLUMNS)
  const latest = pickLatestVer(rows)
  return latest[0] ?? null
}
