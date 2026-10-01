// 包裝專區 P3：取消執行中的 AI 排程（POST runs/[id]/cancel 的純邏輯；route 只負責守門、解析與包回應）
//
// 為什麼 route「直接寫終態」而不是「設旗標等 runner 收尾」：runner 所在的 serverless 實例可能早已被回收（ai_stale 存在的原因），
//   旗標會沒人收；route 直接把列改成 failed＋ai_cancelled，前端 3 秒內看到解除封鎖、其他被 running 擋住的 route（clear／capacity／
//   pull-live）自動放行、stale 判定也不會再碰它。runner 端所有寫入都是「僅當仍 running」的條件更新（db.updateAiRunIfRunning），
//   所以取消之後它寫不進任何東西；callClaude 期間每 5 秒查一次狀態就 abort（已消耗的 AI 用量仍計費）。
// 權限：本人，或能編輯包裝排程（canEditPackaging）。能通過 guardPackagingAi 的人必有 packaging_admin（guard.ts canUseAi），
//   所以實務上所有 AI 使用者都能取消任何人的 run；非本人取消時 error_message 寫出取消者姓名、op_log 留 ownerEmail。
//   若之後要收緊成「只有本人或 isAdmin」，只改 decideCancel 這一個條件。
// deps 可注入：單元測試用 mock 驗證「已結束 → run_not_running」「競態（cancelAiRun 回 false）→ 重讀後 run_not_running」
//   「本人／非本人 → op_log ops.byOwner」，不連 DB。

import type { SupabaseAdmin } from '@/lib/packaging/scheduleDb'
import { cancelAiRun, clearRunningRun, getAiRunSummary } from '@/lib/packaging/ai/db'
import type { AiApiErrorCode, AiErrorCode, AiRunSummary, RunStatus } from '@/lib/packaging/ai/types'
import { type Actor, logAi, sameEmail } from './aiRoute'

export const CANCEL_DEPS = { getAiRunSummary, cancelAiRun, clearRunningRun, logAi }
export type CancelDeps = typeof CANCEL_DEPS

export type CancelDecision =
  | { ok: true; byOwner: boolean }
  | {
      ok: false
      code: Extract<AiApiErrorCode, 'not_found' | 'not_owner' | 'run_not_running'>
      error: string
      extra?: { runStatus: RunStatus; runErrorCode: AiErrorCode | null }
    }

/** 純函式：這個人現在能不能取消這個 run（不存在 → not_found；沒權限 → not_owner；已結束 → run_not_running） */
export function decideCancel(
  run: Pick<AiRunSummary, 'id' | 'status' | 'errorCode' | 'ownerEmail'> | null,
  me: Actor,
  canEdit: boolean,
  id: number,
): CancelDecision {
  if (!run) return { ok: false, code: 'not_found', error: `找不到 AI 執行 #${id}` }
  const byOwner = sameEmail(run.ownerEmail, me.email)
  if (!byOwner && !canEdit) return { ok: false, code: 'not_owner', error: '只有本人或包裝主管能取消這次 AI 排程' }
  if (run.status !== 'running') {
    return {
      ok: false,
      code: 'run_not_running',
      error: `AI 排程 #${id} 已經結束，無法取消`,
      extra: { runStatus: run.status, runErrorCode: run.errorCode },
    }
  }
  return { ok: true, byOwner }
}

export type CancelOutcome =
  | { ok: true; run: AiRunSummary; byOwner: boolean }
  | Extract<CancelDecision, { ok: false }>

/**
 * 流程：讀 run → decideCancel → cancelAiRun（條件更新，只改仍 running 的列；回 false＝剛好在讀與寫之間結束 → 重讀一次回 run_not_running）
 * → clearRunningRun（既有，條件 eq running_run_id，重複無害）→ op_log（kind 'ai_run'，ops[0].action 'cancel'；不新增 kind，DB check 沒有 ai_cancel）
 * → 重讀 summary 回給 route。冪等：重按只會拿到 run_not_running。
 */
export async function cancelRunFlow(
  sb: SupabaseAdmin,
  p: { id: number; me: Actor; canEdit: boolean; nowMs: number },
  deps: Partial<CancelDeps> = {},
): Promise<CancelOutcome> {
  const d: CancelDeps = { ...CANCEL_DEPS, ...deps }
  const run = await d.getAiRunSummary(sb, p.id)
  const decision = decideCancel(run, p.me, p.canEdit, p.id)
  if (!decision.ok) return decision
  if (!run) return { ok: false, code: 'not_found', error: `找不到 AI 執行 #${p.id}` }
  const cancelled = await d.cancelAiRun(sb, p.id, { name: p.me.name, email: p.me.email }, p.nowMs, run.startedAt)
  if (!cancelled) {
    // 競態：送出取消的瞬間 runner 剛好寫了 done／failed → 拿最終狀態回去，前端改為顯示結果
    const final = await d.getAiRunSummary(sb, p.id)
    return {
      ok: false,
      code: 'run_not_running',
      error: `AI 排程 #${p.id} 剛好已經結束，無法取消`,
      extra: { runStatus: final?.status ?? 'failed', runErrorCode: final?.errorCode ?? null },
    }
  }
  await d.clearRunningRun(sb, run.sessionId, p.id)
  const started = Date.parse(run.startedAt)
  const elapsedMs = Number.isFinite(started) ? Math.max(0, p.nowMs - started) : 0
  await d.logAi(sb, p.me, 'ai_run', `取消 AI 排程 #${p.id}`, [{
    action: 'cancel', runId: p.id, sessionId: run.sessionId, ownerEmail: run.ownerEmail, phase: run.phase, elapsedMs, byOwner: decision.byOwner,
  }])
  const after = await d.getAiRunSummary(sb, p.id)
  return { ok: true, run: after ?? { ...run, status: 'failed', phase: 'failed', errorCode: 'ai_cancelled' }, byOwner: decision.byOwner }
}
