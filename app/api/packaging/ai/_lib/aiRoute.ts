// 包裝專區 P3 AI 模擬排程 — /api/packaging/ai/** 共用的小工具（規格 §二～§七）
//
// 放在 _lib（底線開頭的資料夾＝App Router 的 private folder，不會變成路由）。只給本資料夾底下的 route 用。
// 慣例比照既有 /api/packaging/*：守門 guardPackagingAi、寫入 requireJson（擋 CSRF）、回應 noStore、錯誤訊息不外露 PostgREST 細節。
// 與既有 route 的差別：伺服器 log 只記錯誤類別（safeErrorTag），不記 describeError 全文——
//   模擬區／run 列的 jsonb 含 AI 理由與 payload，check 失敗時 PostgREST 的 details 會把整列帶出來（規格 §4.1 不得 log）。

import type { NextResponse } from 'next/server'
import { noStore } from '@/lib/packaging/guard'
import { applyErrorStatus } from '@/lib/packaging/scheduleWrite'
import type { AuthedMember } from '@/lib/requireAuth'
import type { SupabaseAdmin } from '@/lib/packaging/scheduleDb'
import type { ApplyErrorCode, YMD } from '@/lib/packaging/scheduleTypes'
import {
  PoolUnavailableError,
  getAiRunSummary,
  getSimSession,
  insertAiOpLog,
  isAiMissingSchema,
  listAiRuns,
  listSimOwners,
  loadSimWorld,
  publicAiDbError,
  toRunStatusInfo,
  toSimSessionInfo,
} from '@/lib/packaging/ai/db'
import { assembleSimBoard, simCardMetaOf } from '@/lib/packaging/ai/simState'
import { simCapacityViewOf, withSimCapacity } from '@/lib/packaging/ai/simCapacity'
import { safeErrorTag } from '@/lib/packaging/ai/runner'
import type { AiApiErrorCode, AiFail, AiOpLogKind, SimSession, SimView, SimWorld } from '@/lib/packaging/ai/types'

export type Actor = { email: string; name: string | null }

export const actorOf = (m: AuthedMember): Actor => ({ email: m.email, name: m.realName })

/** email 比對不分大小寫（同 scheduleLock.sameEmail） */
export const sameEmail = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

const AI_ONLY_STATUS: Partial<Record<AiApiErrorCode, number>> = {
  not_owner: 403,
  no_session: 404,
  session_exists: 409,
  session_stale: 409,
  window_mismatch: 409,
  run_in_progress: 409,
  run_not_ready: 409,
  throttled: 429,
  ai_not_configured: 400,
  rules_conflict: 409,
  not_latest_adoption: 409,
  already_reverted: 409,
  version_expired: 410,
  nothing_to_adopt: 422,
  // 鎖定線（退回：採用範圍外的線）與正式排程不一致 → 衝突（主管要先解除鎖定／重設或把卡搬回原線）
  locked_line_diverged: 409,
  // D101 模擬產能：與正式產能表同一套狀態碼（關週末有卡 409、其餘驗證 422）
  sim_weekend_live_open: 422,
  weekend_has_cards: 409,
  date_not_workday: 422,
  revert_in_progress: 409,
  migration_required: 409,
  // cancel：該次執行已經結束（done／failed），沒有東西可取消
  run_not_running: 409,
  locked: 422,
  out_of_window: 422,
  not_sim_row: 422,
  op_not_allowed: 400,
  // AI 區的 not_found 是「找不到 run／採用紀錄」→ 404（正式區 applyErrorStatus 把它當衝突 409，這裡不沿用）
  not_found: 404,
  // 規格 §6.1：採用／退回自組 op 超過上限 → 400（正式區 parseOps 的 too_many_ops 是 422，AI 區一律 400）
  too_many_ops: 400,
}

/** 錯誤碼 → HTTP 狀態：AI 專屬碼查上表，其餘沿用正式區 applyErrorStatus（lock_required 409、version_conflict 409…） */
export function aiErrorStatus(code: AiApiErrorCode): number {
  return AI_ONLY_STATUS[code] ?? applyErrorStatus(code as ApplyErrorCode)
}

/** 失敗回應（AiFail＋no-store） */
export function aiFail(code: AiApiErrorCode, error: string, extra: Omit<Partial<AiFail>, 'success' | 'code' | 'error'> = {}, status?: number): NextResponse {
  return noStore<AiFail>({ success: false, error, code, ...extra }, status ?? aiErrorStatus(code))
}

/**
 * 例外 → 回應：新表未套用 → 409 migration_required（訊息指向 sql/20260928b）；待排池失敗 → 500 pool_unavailable；
 * 其他 → 500 db_error（publicAiDbError：固定中文＋錯誤碼）。log 只記類別。
 */
export function aiServerError(tag: string, e: unknown, what?: string): NextResponse {
  console.error(`[packaging/ai/${tag}] ${safeErrorTag(e)}`)
  if (e instanceof PoolUnavailableError) return aiFail('pool_unavailable', e.message)
  if (isAiMissingSchema(e)) return aiFail('migration_required', publicAiDbError(e))
  return aiFail('db_error', publicAiDbError(e, what))
}

/** 路徑參數 id（正整數） */
export function parsePositiveId(raw: string | null | undefined): number | null {
  const n = Number(raw)
  return /^\d{1,15}$/.test(raw ?? '') && Number.isSafeInteger(n) && n > 0 ? n : null
}

/** 模擬區 version（正整數） */
export function parseVersion(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : null
}

/** ?owner=<email>（唯讀檢視別人的模擬區）；沒帶回 null（＝自己）、格式不對回 false */
export function parseOwnerParam(raw: string | null): string | null | false {
  if (raw == null || raw.trim() === '') return null
  const s = raw.trim()
  return s.length <= 200 && /^[^\s@]+@[^\s@]+$/.test(s) ? s : false
}

/**
 * 讀「自己的」模擬區並比對 version（所有模擬區寫入的第一步）。
 * 只有本人能改：寫入 API 一律只讀 owner_email = 登入者的那一份，不接受 owner 參數，所以不會改到別人的。
 */
export async function loadOwnSession(
  sb: SupabaseAdmin,
  me: Actor,
  version: number,
): Promise<{ ok: true; session: SimSession } | { ok: false; res: NextResponse }> {
  const s = await getSimSession(sb, me.email)
  if (!s) return { ok: false, res: aiFail('no_session', '還沒有建立模擬區，請先建立') }
  if (s.version !== version) {
    return { ok: false, res: aiFail('version_conflict', '模擬區剛被更新（另一個分頁操作過或 AI 剛寫回），請重新載入後再操作') }
  }
  return { ok: true, session: s }
}

/**
 * GET session 與所有模擬區寫入共用的回應本體（SimView）：組合工作台（assembleSimBoard；BoardResponse 同形）＋模擬列附加資訊
 * ＋執行中 AI（輪詢用）＋最近一次 AI＋有模擬區的人（切換唯讀檢視）。
 * world 已讀過（寫入 route）就傳進來重用；沒有且有 session 時在這裡讀（與其他查詢並行）。
 * D101：world 一律傳「正式」的；模擬產線時數在這裡疊（withSimCapacity）→ 負荷條、lanes capacity 都是模擬值；
 *   另組 capacity（模擬產能表、正式值、覆寫格、差異）給產能表與橫幅用。
 */
export async function buildSimView(
  sb: SupabaseAdmin,
  p: { me: Actor; ownerEmail: string; session: SimSession | null; world?: SimWorld | null; nowMs: number; today: YMD },
): Promise<SimView> {
  const nowIso = new Date(p.nowMs).toISOString()
  const worldP: Promise<SimWorld | null> = p.session
    ? (p.world ? Promise.resolve(p.world) : loadSimWorld(sb, { today: p.today, nowIso, actor: p.me }))
    : Promise.resolve(null)
  const runningId = p.session?.runningRunId ?? null
  const [world, owners, runs, running] = await Promise.all([
    worldP,
    listSimOwners(sb),
    listAiRuns(sb, p.ownerEmail, 1),
    runningId != null ? getAiRunSummary(sb, runningId) : Promise.resolve(null),
  ])
  const isOwner = sameEmail(p.ownerEmail, p.me.email)
  const ownerRow = owners.find((o) => sameEmail(o.email, p.ownerEmail))
  return {
    serverTime: nowIso,
    today: p.today,
    me: p.me,
    owner: {
      email: p.session?.ownerEmail ?? ownerRow?.email ?? p.ownerEmail,
      name: p.session?.ownerName ?? ownerRow?.name ?? (isOwner ? p.me.name : null),
    },
    isOwner,
    session: p.session ? toSimSessionInfo(p.session, p.today) : null,
    board: p.session && world ? assembleSimBoard(withSimCapacity(world, p.session), p.session) : null,
    simCards: p.session ? simCardMetaOf(p.session) : {},
    // running_run_id 指到已結束的 run（runner 釋放執行位失敗）→ 不算執行中；
    // 仍是 running 但超過 AI_RUN_STALE_MS → 照回但 stale: true（畫面不再封鎖 AI／採用／重設，提示可重新執行；GET 不寫入）
    runningRun: running && running.status === 'running' ? toRunStatusInfo(running, p.nowMs) : null,
    latestRun: runs[0] ?? null,
    owners,
    capacity: p.session && world ? simCapacityViewOf(world, p.session) : null,
  }
}

/** 寫 op_log（失敗只 log，不擋回應——同既有 insertOpLog）。ops 只放結構，不放 payload／AI 輸出 */
export async function logAi(sb: SupabaseAdmin, me: Actor, kind: AiOpLogKind, label: string, ops: unknown): Promise<number | null> {
  return insertAiOpLog(sb, { actorEmail: me.email, actorName: me.name, kind, label, ops })
}
