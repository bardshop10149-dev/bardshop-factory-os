import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { canEditPackaging, guardPackagingAi, noStore, requireJson } from '@/lib/packaging/guard'
import { toRunStatusInfo } from '@/lib/packaging/ai/db'
import type { AiRunCancelResponse, AiRunDetail } from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, parsePositiveId } from '../../../_lib/aiRoute'
import { cancelRunFlow } from '../../../_lib/cancelFlow'

// 幾百毫秒就回，不需 maxDuration；runtime 明寫 nodejs（與其他 AI route 一致）
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// 包裝專區 P3：取消執行中的 AI 排程（Snow：「需要一個取消排程的按鈕，在進度條後」）
//
// POST（body 可為 {}；requireJson 擋 CSRF）→ AiRunCancelResponse { run: AiRunDetail }（canLoad 恆 false）
//   - run 列直接改成 status 'failed'＋error_code 'ai_cancelled'＋「已由 ○○ 取消（已消耗的 AI 用量仍會計費）」（db.cancelAiRun，條件更新）
//   - runner 在另一個實例：它的每一步寫入都是「僅當仍 running」，callClaude 期間每 5 秒查一次狀態就 abort → 取消後不會寫模擬區
//   - 已結束 → 409 run_not_running（extra.runStatus）；前端改為顯示結果
//   - 不節流（冪等）；60 秒節流照舊擋「取消後立刻重跑」（取消不退費）
//   - 毫秒級競態（取消送出時 AI 剛好寫完模擬區）→ run 仍是已取消，error_message 補註「結果已寫入，可退回上一步」（runner noteCancelledButApplied）
// 流程本體在 _lib/cancelFlow.ts（可注入 mock 單測）。

type Ctx = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, ctx: Ctx) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const id = parsePositiveId((await ctx.params).id)
  if (id == null) return aiFail('bad_request', 'AI 執行編號錯誤')
  const me = actorOf(g.member)
  const nowMs = Date.now()
  try {
    const sb = getSupabaseAdminClient()
    const out = await cancelRunFlow(sb, { id, me, canEdit: canEditPackaging(g.member), nowMs })
    if (!out.ok) return aiFail(out.code, out.error, out.extra ?? {})
    const { baseVersion: _bv, ...rest } = out.run
    void _bv
    const st = toRunStatusInfo(out.run, nowMs)
    const detail: AiRunDetail = { ...rest, elapsedMs: st.elapsedMs, stale: st.stale, canLoad: false }
    return noStore<AiRunCancelResponse>({ success: true, run: detail })
  } catch (e) {
    return aiServerError('runs/[id]/cancel', e, '取消 AI 排程')
  }
}
