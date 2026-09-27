// 排程工作台的 API 呼叫層（瀏覽器端）。
//
// 為什麼集中在這裡：
// - 瀏覽器端的 Supabase 是 anon key，受保護表一律查不到也不該查 → 所有讀寫都走 /api/packaging/*（型別照 scheduleTypes.ts 契約）。
// - 寫入 API 只收 Content-Type: application/json（伺服器用它擋跨站表單 CSRF），這裡統一帶上。
// - migration 還沒套用前 packaging_* 表不存在，API 會回 500；這裡把「找不到資料表」「路由還沒部署」
//   翻成看得懂的中文，畫面上才不會只看到一串 PostgREST 錯誤碼。

import type {
  ApplyResponse,
  BoardResponse,
  CapacityInput,
  CapacityResponse,
  CompleteRequest,
  LockRequest,
  LockResponse,
  PlacementsRequest,
  RestorePreviewResponse,
  RestoreResponse,
  VersionCreateResponse,
  VersionsListResponse,
} from '@/lib/packaging/scheduleTypes'

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

export const MIGRATION_HINT = '資料表尚未建立，請 Snow 備份後套用 migration（sql/20260927_packaging_schedule.sql）'

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

export function fetchBoard(opts: { workdays: number; rev?: string | null; fresh?: boolean; lockToken?: string | null }) {
  const q = new URLSearchParams({ workdays: String(opts.workdays) })
  if (opts.rev) q.set('rev', opts.rev)
  if (opts.fresh) q.set('fresh', '1')
  return call<BoardResponse>(`/api/packaging/board?${q.toString()}`, {
    headers: opts.lockToken ? { 'x-packaging-lock': opts.lockToken } : undefined,
  })
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
