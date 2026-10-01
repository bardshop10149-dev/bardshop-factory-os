import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { todayTaipei } from '@/lib/packaging/workdays'
import { getAiRunSummary, updateSimSessionCas } from '@/lib/packaging/ai/db'
import { pushUndo, snapshotForUndo } from '@/lib/packaging/ai/simState'
import { planClearSim } from '@/lib/packaging/ai/simBulk'
import { stateOf } from '@/lib/packaging/ai/runner'
import { AI_RUN_BUDGET_MAX_MINUTES, AI_RUN_STALE_MS, type SimViewResponse } from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, buildSimView, loadOwnSession, logAi, parseVersion } from '../../_lib/aiRoute'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P3：D106 ① 一鍵清空模擬區排程
//
// POST SimClearRequest { version } → SimViewResponse
//   模擬列全部清掉、模式改 clear（AI 看到的就是「清空重排」）；產線時數覆寫（sim_capacity）與範圍（window_dates、line_ids）保留；
//   鎖定只丟卡片鎖（卡已不在），訂單鎖與線鎖照留。規則在純函式 simBulk.planClearSim。
//   清空前整份推 undo（kind 'reset'，label「一鍵清空模擬區排程」）—— 這就是 D106 要的「自動存快照」：模擬區既有的快照機制
//   就是 undo 堆疊（整份狀態含產能），按「退回上一步」一次回來。
//   已經是空的（沒有模擬列、模式已是 clear、沒有卡片鎖）→ 不寫入、不推 undo，回目前畫面加 notice。
//   起始日已過（stale）不擋：清空不需要正式區資料；AI 執行中擋（run_in_progress）：AI 寫回時會 version 衝突、結果白跑。
//   為什麼不需要正式區編輯鎖：只寫自己的模擬區（packaging_sim_sessions）；併發由 session.version 擋。
// ⚠ 只寫 packaging_sim_sessions／packaging_op_log（kind ai_sim）。絕不寫 packaging_placements。

export async function POST(request: NextRequest) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return aiFail('bad_request', '請求格式錯誤（須為 JSON 物件）')
  const version = parseVersion(body.version)
  if (version == null) return aiFail('bad_request', 'version 格式錯誤')

  const me = actorOf(g.member)
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const today = todayTaipei(new Date(nowMs))
  try {
    const sb = getSupabaseAdminClient()
    const own = await loadOwnSession(sb, me, version)
    if (!own.ok) return own.res
    const session = own.session
    if (session.runningRunId != null) {
      const cur = await getAiRunSummary(sb, session.runningRunId)
      if (cur && cur.status === 'running' && nowMs - Date.parse(cur.startedAt) <= AI_RUN_STALE_MS) {
        return aiFail('run_in_progress', `AI 正在排這個模擬區，排完再清空（依卡片數最多約 ${AI_RUN_BUDGET_MAX_MINUTES} 分鐘，或先按「取消排程」）`)
      }
    }

    const plan = planClearSim(session)
    if (plan.noop) {
      const view = await buildSimView(sb, { me, ownerEmail: me.email, session, nowMs, today })
      return noStore<SimViewResponse>({ success: true, ...view, notice: '模擬區已經是空的，沒有排程可以清' })
    }

    const label = `一鍵清空模擬區排程（${plan.removedCount} 張）`
    const updated = await updateSimSessionCas(sb, session.id, version, {
      placements: plan.placements,
      locks: plan.locks,
      mode: plan.mode,
      undo: pushUndo(session.undo, snapshotForUndo(stateOf(session), label, 'reset', nowIso)),
    }, nowIso)
    if (!updated) return aiFail('version_conflict', '模擬區剛被更新（另一個分頁操作過或 AI 剛寫回），請重新載入後再操作')

    await logAi(sb, me, 'ai_sim', label, [{
      action: 'clear_all', sessionId: session.id, removedCount: plan.removedCount, cardLocksDropped: plan.cardLocksDropped,
      keptCapacityCells: session.simCapacity.cells.length, keptWeekendsOpened: session.simCapacity.weekendsOpened,
    }])
    const view = await buildSimView(sb, { me, ownerEmail: me.email, session: updated, nowMs, today })
    return noStore<SimViewResponse>({ success: true, ...view })
  } catch (e) {
    return aiServerError('session/clear', e, '清空模擬區排程')
  }
}
