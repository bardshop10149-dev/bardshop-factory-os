// AI 模擬排程（P3）的 API 呼叫層（瀏覽器端）。型別一律照 lib/packaging/ai/types.ts 的契約（規格 §三～§七）。
//
// 為什麼不直接重用 components/packaging/board/boardApi.ts 的 call()：
// - 它把「找不到資料表」一律翻成 P1 的 migration 提示（20260927…）；AI 的新表是 sql/20260928b_packaging_ai.sql，
//   提示要指向正確的檔案，否則 Snow 會去套錯的 migration。
// - AI 的錯誤碼（not_owner、session_stale、throttled…）要原樣交給畫面判斷，這裡把 code 一併帶出來。
// 其餘慣例相同：寫入一律 Content-Type: application/json（伺服器 requireJson 擋 CSRF）、cache: no-store、同源帶 cookie。
//
// ⚠ 本檔不 console.log 任何回應內容（AI 輸出、摘要可能含客戶名稱；規格 §4.1）。

import type {
  AdoptPreviewResponse,
  AdoptRequest,
  AdoptResponse,
  AdoptionsListResponse,
  AiRulesResponse,
  AiRulesSaveRequest,
  AiRulesSaveResponse,
  AiRulesVersionResponse,
  AiRunDetailResponse,
  AiRunsListResponse,
  RevertPreviewResponse,
  RevertRequest,
  RevertResponse,
  SimCapacityRequest,
  SimCreateRequest,
  SimLoadRunRequest,
  SimLocksRequest,
  SimOpsRequest,
  SimRunRequest,
  SimRunResponse,
  SimUndoRequest,
  SimViewResponse,
  ThresholdsPutRequest,
  ThresholdsResponse,
} from '@/lib/packaging/ai/types'

/** 新表還沒套用時畫面上的說明（API 回 migration_required，或 PostgREST 說找不到表） */
export const AI_MIGRATION_HINT =
  'AI 模擬排程資料表尚未建立：請 Snow 先備份資料庫，再手動套用 migration「sql/20260928b_packaging_ai.sql」。套用前這一頁無法使用（正式排程工作台不受影響）。'

/**
 * D101 模擬產線時數的欄位還沒套用（只有「改模擬產線時數」會碰到；模擬區其他功能照常可用）。
 * 要和上面的提示分開：否則 Snow 會以為要重套 20260928b。
 */
export const AI_CAPACITY_MIGRATION_HINT =
  '模擬產線時數的資料表欄位尚未建立：請 Snow 先備份資料庫，再手動套用 migration「sql/20260928c_packaging_sim_capacity.sql」。套用前模擬區其他功能照常可用，只是不能調整產線時數。'

/** PostgREST／Postgres 找不到表或欄位的各種說法（db.ts aiMigrationMessage 的中文也算） */
const MISSING_TABLE_RE = /PGRST205|PGRST204|42P01|42703|schema cache|找不到資料表|relation .*packaging_ai|20260928b/i
/** D101：訊息指向 20260928c（db.aiMigrationMessage 依缺的欄位名判斷） */
const CAPACITY_MIGRATION_RE = /20260928c|sim_capacity|capacity_changes/i

export interface AiApiResult<T> {
  /** HTTP 狀態；網路錯誤 0 */
  status: number
  /** 解析後的 JSON（路由不存在回 HTML 時 null） */
  json: T | null
  /** 已翻成中文的錯誤說明；成功 null */
  error: string | null
  /** 伺服器回的錯誤碼（AiApiErrorCode；舊路由沒有 code 時 null） */
  code: string | null
  /** 新表尚未套用（migration_required） */
  missingTable: boolean
  /** 網路層失敗（fetch 丟錯） */
  network: boolean
}

async function call<T extends { success: boolean }>(
  url: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<AiApiResult<T>> {
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
      status: 0, json: null, code: null, missingTable: false, network: true,
      error: `網路連線失敗：${e instanceof Error ? e.message : String(e)}`,
    }
  }
  const parsed = await res.json().catch(() => null) as T | null
  if (res.ok && parsed?.success) {
    return { status: res.status, json: parsed, error: null, code: null, missingTable: false, network: false }
  }
  const path = url.split('?')[0]
  const fail = parsed && !parsed.success ? (parsed as unknown as { error?: unknown; code?: unknown }) : null
  const raw = typeof fail?.error === 'string' ? fail.error : null
  const code = typeof fail?.code === 'string' ? fail.code : null
  if (!parsed && res.status === 404) {
    return {
      status: 404, json: null, code: null, missingTable: false, network: false,
      error: `AI 模擬排程 API 尚未部署（${path} 回 404）`,
    }
  }
  if (code === 'migration_required' || (raw != null && MISSING_TABLE_RE.test(raw))) {
    const capacityOnly = raw != null && CAPACITY_MIGRATION_RE.test(raw)
    return {
      status: res.status, json: parsed, error: capacityOnly ? AI_CAPACITY_MIGRATION_HINT : AI_MIGRATION_HINT,
      code: code ?? 'migration_required', missingTable: true, network: false,
    }
  }
  return {
    status: res.status,
    json: parsed,
    code,
    missingTable: false,
    network: false,
    error: raw || (parsed ? `HTTP ${res.status}` : `伺服器回應無法解析（HTTP ${res.status}）`),
  }
}

const BASE = '/api/packaging/ai'
const idPath = (id: number) => encodeURIComponent(String(id))

// ── 模擬區（§三） ────────────────────────────────────────────────────────

/** owner：看別人的模擬區（唯讀）；null＝自己的 */
export function fetchSim(owner: string | null) {
  const q = owner ? `?${new URLSearchParams({ owner }).toString()}` : ''
  return call<SimViewResponse>(`${BASE}/session${q}`)
}

/** 建立或重設（重設帶 version；舊狀態會先推進 undo） */
export function createSim(req: SimCreateRequest) {
  return call<SimViewResponse>(`${BASE}/session`, { method: 'POST', json: req })
}

export function postSimOps(req: SimOpsRequest) {
  return call<SimViewResponse>(`${BASE}/session/ops`, { method: 'POST', json: req })
}

export function postSimLocks(req: SimLocksRequest) {
  return call<SimViewResponse>(`${BASE}/session/locks`, { method: 'POST', json: req })
}

export function postSimUndo(req: SimUndoRequest) {
  return call<SimViewResponse>(`${BASE}/session/undo`, { method: 'POST', json: req })
}

export function postSimRun(req: SimRunRequest) {
  return call<SimRunResponse>(`${BASE}/session/run`, { method: 'POST', json: req })
}

export function postLoadRun(req: SimLoadRunRequest) {
  return call<SimViewResponse>(`${BASE}/session/load-run`, { method: 'POST', json: req })
}

/** D101 模擬區調整產線時數（rows 與正式產能表 PUT 同形；或 clearAll 全部回到正式值） */
export function postSimCapacity(req: SimCapacityRequest) {
  return call<SimViewResponse>(`${BASE}/session/capacity`, { method: 'POST', json: req })
}

// ── 採用（§6.1） ────────────────────────────────────────────────────────

export function fetchAdoptPreview() {
  return call<AdoptPreviewResponse>(`${BASE}/session/adopt`)
}

export function postAdopt(req: AdoptRequest) {
  return call<AdoptResponse>(`${BASE}/session/adopt`, { method: 'POST', json: req })
}

// ── AI 執行 LOG（§4.1） ─────────────────────────────────────────────────

export function fetchRuns(owner: string | null) {
  const q = owner ? `?${new URLSearchParams({ owner }).toString()}` : ''
  return call<AiRunsListResponse>(`${BASE}/runs${q}`)
}

export function fetchRun(id: number) {
  return call<AiRunDetailResponse>(`${BASE}/runs/${idPath(id)}`)
}

// ── 採用紀錄與退回（§6.2） ───────────────────────────────────────────────

export function fetchAdoptions() {
  return call<AdoptionsListResponse>(`${BASE}/adoptions`)
}

export function fetchRevertPreview(id: number) {
  return call<RevertPreviewResponse>(`${BASE}/adoptions/${idPath(id)}/revert`)
}

export function postRevert(id: number, req: RevertRequest) {
  return call<RevertResponse>(`${BASE}/adoptions/${idPath(id)}/revert`, { method: 'POST', json: req })
}

// ── 規則區與門檻表（§七） ────────────────────────────────────────────────

export function fetchRules() {
  return call<AiRulesResponse>(`${BASE}/rules`)
}

export function fetchRulesVersion(id: number) {
  return call<AiRulesVersionResponse>(`${BASE}/rules?${new URLSearchParams({ id: String(id) }).toString()}`)
}

export function saveRules(req: AiRulesSaveRequest) {
  return call<AiRulesSaveResponse>(`${BASE}/rules`, { method: 'POST', json: req })
}

export function fetchThresholds() {
  return call<ThresholdsResponse>(`${BASE}/thresholds`)
}

export function putThresholds(req: ThresholdsPutRequest) {
  return call<ThresholdsResponse>(`${BASE}/thresholds`, { method: 'PUT', json: req })
}
