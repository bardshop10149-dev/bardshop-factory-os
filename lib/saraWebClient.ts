/**
 * 塔台 SARA 網頁版 API 客戶端（server-side only）
 *
 * 與 lib/saraClient.ts（官方 data_export 唯讀匯出 API）不同：
 * 這支走「網頁版 session API」，拿得到即時現場狀態——尤其是
 * 每道工序的「應做 / 已報工 / 剩餘」數量，那是匯出 API 沒有的。
 *
 * 認證：兩步驟 CSRF
 *   1. GET  /r/auth/sign-in                （取得初始 cookie）
 *   2. POST /api/auth/sign-in              （預期 403，目的是換到 xsrf-token cookie）
 *   3. POST /api/auth/sign-in + x-xsrf-token  → 取得 session cookie
 *
 * 必要環境變數（擇一組即可，SARA_* 優先）：
 *   SARA_LOGIN_EMAIL / SARA_LOGIN_PASSWORD
 *   TOWER_LOGIN_EMAIL / TOWER_LOGIN_PASSWORD   （與 sara-daily-report 工具同名，方便沿用）
 *
 * 實作註記：Node 的 fetch 沒有 cookie jar，這裡自行維護一份最小可用的
 * cookie 表，並在模組層快取 session（Vercel 熱實例可重複使用，避免每次都重登）。
 */

const BASE = 'https://sara-factory.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const SESSION_TTL_MS = 20 * 60 * 1000 // 20 分鐘後重登（保守值）

interface Session {
  cookies: Map<string, string>
  xsrf: string | null
  createdAt: number
}

let cached: Session | null = null

function creds(): { email: string; password: string } {
  const email = process.env.SARA_LOGIN_EMAIL || process.env.TOWER_LOGIN_EMAIL || ''
  const password = process.env.SARA_LOGIN_PASSWORD || process.env.TOWER_LOGIN_PASSWORD || ''
  return { email, password }
}

/** 是否已設定塔台網頁版帳密（供呼叫端決定要不要走這條路） */
export function saraWebConfigured(): boolean {
  const { email, password } = creds()
  return !!email && !!password
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function absorbCookies(res: Response, jar: Map<string, string>): void {
  // Node 18+ 提供 getSetCookie()；退而求其次讀單一 set-cookie
  const raw: string[] =
    typeof (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
      ? (res.headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
      : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : [])
  for (const line of raw) {
    const first = line.split(';')[0]
    const idx = first.indexOf('=')
    if (idx <= 0) continue
    jar.set(first.slice(0, idx).trim(), first.slice(idx + 1).trim())
  }
}

async function login(): Promise<Session> {
  const { email, password } = creds()
  if (!email || !password) {
    throw new Error('未設定塔台帳密（SARA_LOGIN_EMAIL / SARA_LOGIN_PASSWORD）')
  }

  const jar = new Map<string, string>()
  const baseHeaders = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    Origin: BASE,
    Referer: `${BASE}/r/auth/sign-in`,
  }

  // 1) 取初始 cookie
  const r1 = await fetch(`${BASE}/r/auth/sign-in`, { headers: baseHeaders, cache: 'no-store' })
  absorbCookies(r1, jar)

  // 2) 第一次 POST：預期 403，目的是換到 xsrf-token cookie
  const body = JSON.stringify({ email, password })
  const r2 = await fetch(`${BASE}/api/auth/sign-in`, {
    method: 'POST',
    headers: { ...baseHeaders, 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body,
    cache: 'no-store',
  })
  absorbCookies(r2, jar)

  // 3) 帶 x-xsrf-token 正式登入
  const xsrf = jar.get('xsrf-token') ?? null
  const r3 = await fetch(`${BASE}/api/auth/sign-in`, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/json',
      Cookie: cookieHeader(jar),
      ...(xsrf ? { 'x-xsrf-token': decodeURIComponent(xsrf) } : {}),
    },
    body,
    cache: 'no-store',
  })
  absorbCookies(r3, jar)
  if (r3.status !== 200 && r3.status !== 201) {
    const text = await r3.text().catch(() => '')
    throw new Error(`塔台登入失敗 HTTP ${r3.status}: ${text.slice(0, 160)}`)
  }

  return { cookies: jar, xsrf: jar.get('xsrf-token') ?? xsrf, createdAt: Date.now() }
}

async function session(force = false): Promise<Session> {
  if (!force && cached && Date.now() - cached.createdAt < SESSION_TTL_MS) return cached
  cached = await login()
  return cached
}

/** 對塔台網頁 API 發 POST（session 過期會自動重登一次） */
async function post<T>(path: string, payload: unknown, query?: Record<string, string>): Promise<T> {
  const run = async (s: Session): Promise<Response> => {
    const url = new URL(`${BASE}${path}`)
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
    return fetch(url.toString(), {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Origin: BASE,
        Referer: `${BASE}/r/auth/sign-in`,
        Cookie: cookieHeader(s.cookies),
        ...(s.xsrf ? { 'x-xsrf-token': decodeURIComponent(s.xsrf) } : {}),
      },
      body: JSON.stringify(payload ?? {}),
      cache: 'no-store',
    })
  }

  let s = await session()
  let res = await run(s)
  if (res.status === 401 || res.status === 403) {
    s = await session(true)
    res = await run(s)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`塔台 ${path} 失敗 HTTP ${res.status}: ${text.slice(0, 160)}`)
  }
  const json = (await res.json()) as { data?: T }
  return (json.data ?? ([] as unknown)) as T
}

/** 專案管理表：每列＝一個批(lot)。id 即 lot_id。 */
export interface SaraProject {
  id: number
  mo_nbr: string | null
  doc_nbr: string | null
  lot_nbr: string | null
  product_name: string | null
  product_description: string | null
  customer_name: string | null
  qty: number | null
  progress_percentage: number | null
  health_state: string | null
  action_state: string | null
  warning_state: unknown
  ach_state: string | null
  factory_name: string | null
  is_internal: boolean | null
}

/** 單一批的完整工序（含未排程者），含應做／已報工／剩餘 */
export interface SaraJob {
  id: number
  job_sequence: number | null
  workcenter_name: string | null
  job_name: string | null
  sourcing: string | null
  required_qty: number | null
  reported_qty: number | null
  remaining_qty: number | null
  designated_resources: unknown
  job_note: string | null
  material_ready_date: string | null
  prime: unknown
}

/**
 * 依關鍵字（製令號/訂單號/品號/批號）查批。
 * 用 globalFilter 精準查單一單號，避免每次撈全部 500+ 批。
 */
export async function saraFindProjects(keyword: string): Promise<SaraProject[]> {
  return post<SaraProject[]>('/api/project/management/table', {
    pagination: { pageIndex: 0, pageSize: 100 },
    sorting: [],
    globalFilter: keyword,
    globalFilterColumns: ['mo_nbr', 'doc_nbr', 'product_name', 'lot_nbr'],
    exactFilter: {},
    exactFilterColumns: null,
    exactFilterJsonColumns: ['assigned_resources'],
    extra: { filter: {} },
    include_unscheduled: true,
    localFilter: {},
  })
}

/** 取單一批的完整工序（站點排程只列已排入版次者，這支才是全部途程） */
export async function saraJobsOfLot(lotId: number): Promise<SaraJob[]> {
  return post<SaraJob[]>(
    '/api/project/job/table',
    {
      pagination: { pageIndex: 0, pageSize: 200 },
      sorting: [],
      globalFilter: '',
      globalFilterColumns: [],
      exactFilter: {},
      exactFilterColumns: null,
      exactFilterJsonColumns: [],
      extra: { filter: {} },
      localFilter: {},
    },
    { lot_id: String(lotId) },
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 全廠現況同步用（/api/sara/wip-sync）
//
// 上面的 saraFindProjects / saraJobsOfLot 是「查單一製令」用的；
// 下面這兩支是「一次撈全廠」用的，供定期同步寫進 sara_lot_progress / sara_wip_schedule。
// ─────────────────────────────────────────────────────────────────────────────

/** 排程時間等欄位，查單一批時用不到，但全廠同步要存下來 */
export interface SaraProjectFull extends SaraProject {
  due: string | null
  plan_start_time: string | null
  plan_end_time: string | null
}

/** 站點排程：每列＝一道「已排程」的工序，含現在是否正在跑 */
export interface SaraWipRow {
  jid: number
  lid: number
  mo_nbr: string | null
  doc_nbr: string | null
  product_name: string | null
  lot_nbr: string | null
  workcenter_name: string | null
  job_name: string | null
  job_sequence: number | null
  qty: number | null
  wip_qty: number | null
  system_status: string | null   // running / pause / finished / null(未開始)
  user_status: string | null
  is_running: boolean | null
  real_start_time: string | null
  real_end_time: string | null
  plan_start_time: string | null
  plan_end_time: string | null
  report_resource_name: string | null
  resource_names: string | null
  sourcing: string | null
  factory_name: string | null
}

const TABLE_PAYLOAD = (columns: string[], size: number) => ({
  pagination: { pageIndex: 0, pageSize: size },
  sorting: [],
  globalFilter: '',
  globalFilterColumns: columns,
  exactFilter: {},
  exactFilterColumns: null,
  exactFilterJsonColumns: ['assigned_resources'],
  extra: { filter: {} },
  include_unscheduled: true,
  localFilter: {},
})

/** 全廠所有批(lot)，含整批進度與跳站警示 */
export async function saraProjects(size = 5000): Promise<SaraProjectFull[]> {
  return post<SaraProjectFull[]>(
    '/api/project/management/table',
    TABLE_PAYLOAD(['mo_nbr', 'doc_nbr', 'product_name', 'lot_nbr'], size),
  )
}

/**
 * 全廠站點排程。注意這裡只列「已排程」的工序——
 * 做完的工序會從排程消失，所以「做到哪一站」要看批的 progress_percentage
 * 或 saraJobsOfLot 的 reported_qty，不能只看這支。
 */
export async function saraWip(size = 5000): Promise<SaraWipRow[]> {
  return post<SaraWipRow[]>(
    '/api/wip/schedule',
    TABLE_PAYLOAD(['work_order', 'jid', 'mo_nbr', 'doc_nbr', 'product_name', 'lot_nbr'], size),
    { delay_on_top: 'false' },
  )
}

// 製令號 → 來源訂單行號。解析規則見 lib/moLineMatch.ts
// （SOA 訂單的編號格式是特例，「取第一段末兩碼」的寫法會誤判）。
export { moToSoLine } from './moLineMatch'
