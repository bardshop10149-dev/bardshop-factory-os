// 排程工作台的 API 呼叫層（瀏覽器端）。
//
// 為什麼集中在這裡：
// - 瀏覽器端的 Supabase 是 anon key，受保護表一律查不到也不該查 → 所有讀寫都走 /api/packaging/*（型別照 scheduleTypes.ts 契約）。
// - 寫入 API 只收 Content-Type: application/json（伺服器用它擋跨站表單 CSRF），這裡統一帶上。
// - migration 還沒套用前 packaging_* 表不存在，API 會回 500；這裡把「找不到資料表」「路由還沒部署」
//   翻成看得懂的中文，畫面上才不會只看到一串 PostgREST 錯誤碼。

import type {
  AdjustmentsResponse,
  ApplyResponse,
  BoardResponse,
  CapacityInput,
  CapacityResponse,
  ClosureRequest,
  ClosureResponse,
  ClosuresListResponse,
  CompleteRequest,
  LineCreateRequest,
  LineMutationResponse,
  LinePatchRequest,
  LinesResponse,
  LockRequest,
  LockResponse,
  ManualAddItem,
  ManualLookupResponse,
  ManualMutationResponse,
  ManualRemoveRequest,
  ManualUpdateRequest,
  PlacementsRequest,
  RestorePreviewResponse,
  RestoreResponse,
  VersionCreateResponse,
  VersionsListResponse,
} from '@/lib/packaging/scheduleTypes'
import type { BoardSearchResponse } from '@/lib/packaging/boardSearch'

/** 呼叫結果：HTTP 狀態＋解析後的 JSON；網路錯誤時 status = 0 */
export interface ApiResult<T> {
  status: number
  /** JSON 解析失敗（例如路由不存在回 HTML 404）時為 null */
  json: T | null
  /** 已翻成中文的錯誤說明；成功時為 null */
  error: string | null
  /** 是否為「資料表尚未建立」（migration 未套用） */
  missingTable: boolean
  /** 網路層失敗（fetch 丟錯） */
  network: boolean
}

/**
 * 分線輪起多了新表／新欄位（packaging_lines、line_id…）：migration 依序套用（先 P1 本體、再分線擴充、再 D73／D74）。
 * 伺服器的 migration_required 訊息會寫「找不到資料表或欄位…」，一樣會被 MISSING_TABLE_RE 認出來、換成這段提示。
 * （sql/20260928 沒套用時工作台照常可用：待排池不排除已銷貨、新卡沿用固定排序，只有「調整線內順序」會出這段提示）
 */
export const MIGRATION_HINT = '資料表或欄位尚未建立，請 Snow 備份後依序套用 migration：sql/20260927_packaging_schedule.sql → sql/20260927b_packaging_p1_extend.sql → sql/20260928_packaging_sales_and_order.sql'

/** PostgREST／Postgres 找不到表的各種說法：PGRST205（schema cache）、42P01（relation does not exist） */
const MISSING_TABLE_RE = /PGRST205|42P01|schema cache|does not exist|找不到資料表|relation .*packaging_/i

export function isMissingTableMessage(msg: string | null | undefined): boolean {
  return !!msg && MISSING_TABLE_RE.test(msg)
}

async function call<T extends { success: boolean }>(
  url: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<ApiResult<T>> {
  const { json: body, headers, ...rest } = init
  let res: Response
  try {
    res = await fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...rest,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(headers ?? {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (e) {
    return {
      status: 0, json: null, missingTable: false, network: true,
      error: `網路連線失敗：${e instanceof Error ? e.message : String(e)}`,
    }
  }
  const parsed = await res.json().catch(() => null) as T | null
  if (res.ok && parsed?.success) {
    return { status: res.status, json: parsed, error: null, missingTable: false, network: false }
  }
  const path = url.split('?')[0]
  const raw = parsed && !parsed.success ? (parsed as unknown as { error?: string }).error ?? null : null
  if (!parsed && res.status === 404) {
    return {
      status: 404, json: null, missingTable: false, network: false,
      error: `工作台 API 尚未部署（${path} 回 404）`,
    }
  }
  if (isMissingTableMessage(raw)) {
    return { status: res.status, json: parsed, error: MIGRATION_HINT, missingTable: true, network: false }
  }
  return {
    status: res.status,
    json: parsed,
    missingTable: false,
    network: false,
    error: raw || (parsed ? `HTTP ${res.status}` : `伺服器回應無法解析（HTTP ${res.status}）`),
  }
}

// ── 工作台 ──────────────────────────────────────────────────────────────

/** from：檢視起點（null＝今天，由伺服器決定）；workdays：日 1／週 5／兩週 10（D56） */
export function fetchBoard(opts: { from?: string | null; workdays: number; rev?: string | null; fresh?: boolean; lockToken?: string | null }) {
  const q = new URLSearchParams({ workdays: String(opts.workdays) })
  if (opts.from) q.set('from', opts.from)
  if (opts.rev) q.set('rev', opts.rev)
  if (opts.fresh) q.set('fresh', '1')
  return call<BoardResponse>(`/api/packaging/board?${q.toString()}`, {
    headers: opts.lockToken ? { 'x-packaging-lock': opts.lockToken } : undefined,
  })
}

/**
 * D113 排程區單號搜尋（唯讀）：全部已排的卡（不限畫面日期）＋待排區＋待排池＋隱藏／結案原因。
 * q 由呼叫端先過 parseSearchQuery（伺服器會再驗一次）；signal：使用者繼續打字時取消舊請求（此時回 network 錯誤，呼叫端看 signal.aborted 略過）。
 */
export function fetchSearch(q: string, signal?: AbortSignal) {
  return call<BoardSearchResponse>(`/api/packaging/search?q=${encodeURIComponent(q)}`, { signal })
}

// ── 擺放／完成（寫入＋鎖） ────────────────────────────────────────────────

export function postPlacements(req: PlacementsRequest) {
  return call<ApplyResponse>('/api/packaging/placements', { method: 'POST', json: req })
}

export function postComplete(req: CompleteRequest) {
  return call<ApplyResponse>('/api/packaging/cards/complete', { method: 'POST', json: req })
}

// ── 編輯鎖 ──────────────────────────────────────────────────────────────

export function postLock(req: LockRequest) {
  return call<LockResponse>('/api/packaging/lock', { method: 'POST', json: req })
}

/**
 * 關分頁／離開工作台時釋放鎖：pagehide 時一般 fetch 會被瀏覽器中斷，要用「關頁後仍會送完」的請求。
 * - 支援 keepalive 的瀏覽器用 fetch({ keepalive: true })：可以明確帶 Content-Type: application/json（伺服器的 CSRF 檢查要求）。
 * - 不支援的（例如舊版 Firefox）改用 sendBeacon＋application/json 的 Blob（規格 §4.6 的做法）。
 *   注意：fetch 的失敗是「非同步 reject」，try/catch 接不到，所以要事先判斷支援與否，不能靠丟錯再退回。
 * 同源、帶 cookie。送不到也無妨：5 分鐘後鎖自然逾時。
 */
function supportsKeepalive(): boolean {
  try {
    return typeof fetch === 'function' && typeof Request !== 'undefined' && 'keepalive' in Request.prototype
  } catch {
    return false
  }
}

export function beaconRelease(token: string): boolean {
  const json = JSON.stringify({ action: 'release', token } satisfies LockRequest)
  if (supportsKeepalive()) {
    try {
      void fetch('/api/packaging/lock', {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      }).catch(() => { /* 關頁中，失敗就等自然逾時 */ })
      return true
    } catch {
      /* 同步丟錯（極少見）：往下改用 sendBeacon */
    }
  }
  try {
    return typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
      && navigator.sendBeacon('/api/packaging/lock', new Blob([json], { type: 'application/json' }))
  } catch {
    return false
  }
}

// ── 產能 ────────────────────────────────────────────────────────────────

export function fetchCapacity(from: string, to: string) {
  const q = new URLSearchParams({ from, to })
  return call<CapacityResponse>(`/api/packaging/capacity?${q.toString()}`)
}

export function putCapacity(lockToken: string, rows: CapacityInput[]) {
  return call<CapacityResponse>('/api/packaging/capacity', { method: 'PUT', json: { lockToken, rows } })
}

// ── 版本 ────────────────────────────────────────────────────────────────

export function fetchVersions() {
  return call<VersionsListResponse>('/api/packaging/versions')
}

export function createVersion(lockToken: string, label: string) {
  return call<VersionCreateResponse>('/api/packaging/versions', { method: 'POST', json: { lockToken, label } })
}

export function previewRestore(id: number) {
  return call<RestorePreviewResponse>(`/api/packaging/versions/${encodeURIComponent(String(id))}/restore`)
}

export function postRestore(id: number, lockToken: string) {
  return call<RestoreResponse>(`/api/packaging/versions/${encodeURIComponent(String(id))}/restore`, {
    method: 'POST',
    json: { lockToken },
  })
}

// ── 分線：線別管理（D67／D71；寫入要 packaging_admin＋編輯鎖） ─────────────────

export function fetchLines() {
  return call<LinesResponse>('/api/packaging/lines')
}

export function createLine(req: LineCreateRequest) {
  return call<LineMutationResponse>('/api/packaging/lines', { method: 'POST', json: req })
}

export function patchLine(req: LinePatchRequest) {
  return call<LineMutationResponse>('/api/packaging/lines', { method: 'PATCH', json: req })
}

// ── D66 手動加入（寫入要 packaging_admin；D102 起不需編輯鎖；不進 Undo） ─────────

/** 查詢某張 SO 的全部品項行與「不在待排池的原因」 */
export function lookupManual(so: string) {
  return call<ManualLookupResponse>(`/api/packaging/manual?${new URLSearchParams({ so }).toString()}`)
}

/** D102：手動加入不需編輯鎖（伺服器已不檢查 lockToken），所以不再帶 */
export function addManual(items: ManualAddItem[]) {
  return call<ManualMutationResponse>('/api/packaging/manual', { method: 'POST', json: { items } })
}

export function updateManual(req: ManualUpdateRequest) {
  return call<ManualMutationResponse>('/api/packaging/manual', { method: 'PATCH', json: req })
}

/** 移出待排池＝軟刪除（紀錄保留）；用 POST 子路徑而不是 DELETE：寫入 API 一律只收 JSON body */
export function removeManual(req: ManualRemoveRequest) {
  return call<ManualMutationResponse>('/api/packaging/manual/remove', { method: 'POST', json: req })
}

// ── D104 結案（寫入要 packaging_admin；不需編輯鎖；不進 Undo） ─────────────────

/** 結案／復原一個 SO 品項行；結案時伺服器一併放回該行未完成的排定卡、清掉各人模擬區裡該行的卡 */
export function postClosure(req: ClosureRequest) {
  return call<ClosureResponse>('/api/packaging/closures', { method: 'POST', json: req })
}

/** 已結案清單（台北日區間，含已復原的） */
export function fetchClosures(opts: { from?: string | null; to?: string | null } = {}) {
  const q = new URLSearchParams()
  if (opts.from) q.set('from', opts.from)
  if (opts.to) q.set('to', opts.to)
  const qs = q.toString()
  return call<ClosuresListResponse>(`/api/packaging/closures${qs ? `?${qs}` : ''}`)
}

// ── D69 工時修改紀錄（唯讀） ─────────────────────────────────────────────

export function fetchAdjustments(opts: { placementId?: string | null; itemCode?: string | null }) {
  const q = new URLSearchParams()
  if (opts.placementId) q.set('placementId', opts.placementId)
  if (opts.itemCode) q.set('itemCode', opts.itemCode)
  return call<AdjustmentsResponse>(`/api/packaging/adjustments?${q.toString()}`)
}
