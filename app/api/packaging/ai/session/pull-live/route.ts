import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { POOL_WRITE_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { openWeekendDaysOf } from '@/lib/packaging/scheduleCalendar'
import { activeLinesOf } from '@/lib/packaging/scheduleLines'
import { todayTaipei } from '@/lib/packaging/workdays'
import { getAiRunSummary, isSimSessionStale, loadSimWorld, updateSimSessionCas } from '@/lib/packaging/ai/db'
import { pushUndo, simPlacementsTooLarge, snapshotForUndo } from '@/lib/packaging/ai/simState'
import { planPullLive } from '@/lib/packaging/ai/simBulk'
import { stateOf } from '@/lib/packaging/ai/runner'
import { AI_RUN_STALE_MS, type SimViewResponse } from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, buildSimView, loadOwnSession, logAi, parseVersion } from '../../_lib/aiRoute'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P3：D106 ② 拉正式區 1:1
//
// POST SimPullLiveRequest { version } → SimViewResponse
//   範圍不變（同 horizon、同起始日），線換成目前啟用中的線，正式區「範圍內、未完成」的擺放整份複製成模擬列
//   （日期、線、線內順序、覆寫工時；已完成不複製）；產能覆寫清空（＝各線各日用正式產能表的值，見 simBulk 檔頭），
//   模擬才開的週末關掉並從 window_dates 移除；鎖定：訂單鎖／線鎖照留，卡片鎖經 livePlacementId 搬到新列。
//   範圍外的正式卡與待排區的卡本來就以正式區唯讀列顯示在模擬區，畫面上自然是 1:1。
//   執行前整份推 undo（kind 'reset'，label「拉正式區 1:1」）＝ D106 的自動快照；「已有內容先確認覆蓋」由畫面做，
//   伺服器以 version CAS 保證覆蓋的是主管確認時看到的那一版。
//   起始日已過 → session_stale（正式區在過去日期的卡拉進來沒有意義，請先重設）；AI 執行中 → run_in_progress。
//   待排池用寫入 API 的快取容忍（POOL_WRITE_MAX_AGE_MS，同建立／重設）；擺放本身一律即時讀。
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
    if (isSimSessionStale(session, today)) {
      return aiFail('session_stale', '模擬區的起始日已經過了，請先重設模擬區（重設時選「複製現有排程」效果相同）')
    }
    if (session.runningRunId != null) {
      const cur = await getAiRunSummary(sb, session.runningRunId)
      if (cur && cur.status === 'running' && nowMs - Date.parse(cur.startedAt) <= AI_RUN_STALE_MS) {
        return aiFail('run_in_progress', 'AI 正在排這個模擬區，排完再拉正式區（約 1～3 分鐘）')
      }
    }

    const world = await loadSimWorld(sb, { today, nowIso, actor: me, poolMaxAgeMs: POOL_WRITE_MAX_AGE_MS })
    const active = activeLinesOf(world.lines)
    if (active.length === 0) return aiFail('bad_request', '目前沒有啟用中的產線，無法拉正式區（請先到產線設定啟用）')
    const activeLineIds = active.map((l) => l.id)
    const liveOpenWeekends = openWeekendDaysOf(world.capacityRows, world.lineRows, new Set(activeLineIds))
    const plan = planPullLive({ live: world.live, session, activeLineIds, liveOpenWeekends, newId: () => crypto.randomUUID() })
    if (simPlacementsTooLarge(plan.placements)) {
      return aiFail('bad_request', `範圍內的正式卡太多（${plan.placements.length} 張），超過模擬區上限；請改用較短的範圍`)
    }

    const label = `拉正式區 1:1（${plan.placements.length} 張）`
    const updated = await updateSimSessionCas(sb, session.id, version, {
      placements: plan.placements,
      locks: plan.locks,
      mode: plan.mode,
      ...(plan.lineIdsChanged ? { lineIds: plan.lineIds } : {}),
      ...(plan.windowChanged ? { windowDates: plan.windowDates } : {}),
      // D101：只有覆寫真的有東西要清才寫 sim_capacity（migration 20260928c 套用前、沒調過時數的都不會碰到新欄）
      ...(plan.capChanged ? { simCapacity: plan.simCapacity } : {}),
      undo: pushUndo(session.undo, snapshotForUndo(stateOf(session), label, 'reset', nowIso)),
    }, nowIso)
    if (!updated) return aiFail('version_conflict', '模擬區剛被更新（另一個分頁操作過或 AI 剛寫回），請重新載入後再操作')

    await logAi(sb, me, 'ai_sim', label, [{
      action: 'pull_live', sessionId: session.id, placementCount: plan.placements.length, replacedCount: session.placements.length,
      lineIds: plan.lineIds, windowDates: plan.windowDates,
      capacityCellsDropped: plan.cellsDropped, weekendsClosed: plan.weekendsClosed,
      cardLocksKept: plan.cardLocksKept, cardLocksDropped: plan.cardLocksDropped,
    }])
    const view = await buildSimView(sb, { me, ownerEmail: me.email, session: updated, world, nowMs, today })
    return noStore<SimViewResponse>({ success: true, ...view })
  } catch (e) {
    return aiServerError('session/pull-live', e, '拉正式區 1:1')
  }
}
