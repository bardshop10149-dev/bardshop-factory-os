import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { todayTaipei } from '@/lib/packaging/workdays'
import { getAiRunSummary, isSimSessionStale, loadSimWorld, updateSimSessionCas } from '@/lib/packaging/ai/db'
import { pushUndo, snapshotForUndo } from '@/lib/packaging/ai/simState'
import { applySimCapacityInputs } from '@/lib/packaging/ai/simCapacity'
import { stateOf } from '@/lib/packaging/ai/runner'
import { AI_RUN_BUDGET_MAX_MINUTES, AI_RUN_STALE_MS, SIM_CAPACITY_MAX_ROWS, type SimViewResponse } from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, buildSimView, loadOwnSession, logAi, parseVersion } from '../../_lib/aiRoute'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P3：D101 模擬區調整產線時數（只作用在模擬；採用時一起匯入正式產能表）
//
// POST SimCapacityRequest { version, rows?: CapacityInput[1..20] | clearAll?: true } → SimViewResponse
//   rows 與正式 PUT /api/packaging/capacity 同形（畫面重用 CapacityEditor／capacityForm），伺服器用同一個 validateCapacityDayInput 驗證；
//   規則與合併在純函式 simCapacity.applySimCapacityInputs（只能改模擬範圍內、今天以後的日子與模擬線；
//   可開範圍內的週末加班，正式已開的週末只能改時數不能關；與正式列相同的覆寫直接丟掉）。
//   流程：讀自己的模擬區（version 相符）→ 起始日已過 → session_stale；AI 執行中 → run_in_progress
//         → 讀正式區世界 → applySimCapacityInputs → version CAS 寫回 sim_capacity（週末開關時連 window_dates）＋推 undo（kind 'capacity'）
//         → op_log 'ai_sim'（不寫 'capacity'：正式區沒變，不該讓正式工作台重抓）。
//   為什麼 AI 執行中要擋（手動拖卡不擋）：AI 是在「建 run 當下的時數」下排的，中途改時數會讓結果與負荷條對不上；
//     時數是 AI 的前提，不是可以並行的小調整。
//   為什麼不需要正式區編輯鎖：只寫自己的模擬區（packaging_sim_sessions），正式產能表完全不動；併發由 session.version 擋。
//   migration 20260928c 未套用 → 寫 sim_capacity 時 PGRST204 → 409 migration_required（訊息指向 20260928c）；其他模擬區功能不受影響。
// ⚠ 只寫 packaging_sim_sessions／packaging_op_log。

export async function POST(request: NextRequest) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return aiFail('bad_request', '請求格式錯誤（須為 JSON 物件）')
  const version = parseVersion(body.version)
  if (version == null) return aiFail('bad_request', 'version 格式錯誤')
  const clearAll = body.clearAll === true
  if (body.clearAll !== undefined && body.clearAll !== true) return aiFail('bad_request', 'clearAll 只能是 true')
  if (clearAll === (body.rows !== undefined)) return aiFail('bad_request', 'rows 與 clearAll 要二擇一')
  if (!clearAll && (!Array.isArray(body.rows) || body.rows.length < 1 || body.rows.length > SIM_CAPACITY_MAX_ROWS)) {
    return aiFail('bad_request', `rows 必須是 1～${SIM_CAPACITY_MAX_ROWS} 天的陣列`)
  }

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
      return aiFail('session_stale', '模擬區的起始日已經過了，請先重設模擬區再調整產線時數')
    }
    if (session.runningRunId != null) {
      const cur = await getAiRunSummary(sb, session.runningRunId)
      if (cur && cur.status === 'running' && nowMs - Date.parse(cur.startedAt) <= AI_RUN_STALE_MS) {
        return aiFail('run_in_progress', `AI 正在用這組產線時數排程，排完再改（依卡片數最多約 ${AI_RUN_BUDGET_MAX_MINUTES} 分鐘，或先按「取消排程」）`)
      }
    }

    const world = await loadSimWorld(sb, { today, nowIso, actor: me })
    const r = applySimCapacityInputs({ world, session, rows: body.rows, clearAll, today, nowIso })
    if (!r.ok) {
      return aiFail(r.code, r.message, { ...(r.date ? { date: r.date } : {}), ...(r.cardCount != null ? { cardCount: r.cardCount } : {}) })
    }
    if (!r.changed) {
      // 沒有實際變更（例：填的值與正式列相同）：不寫入、不推 undo，回目前畫面
      const view = await buildSimView(sb, { me, ownerEmail: me.email, session, world, nowMs, today })
      return noStore<SimViewResponse>({ success: true, ...view })
    }

    const windowChanged = r.windowDates.length !== session.windowDates.length || r.windowDates.some((d, i) => d !== session.windowDates[i])
    const updated = await updateSimSessionCas(sb, session.id, version, {
      simCapacity: r.simCapacity,
      ...(windowChanged ? { windowDates: r.windowDates } : {}),
      undo: pushUndo(session.undo, snapshotForUndo(stateOf(session), r.label, 'capacity', nowIso)),
    }, nowIso)
    if (!updated) return aiFail('version_conflict', '模擬區剛被更新（另一個分頁操作過或 AI 剛寫回），請重新載入後再操作')

    await logAi(sb, me, 'ai_sim', r.label, [{
      action: 'capacity', sessionId: session.id, clearAll, changes: r.changes,
      weekendsAdded: r.weekendsAdded, weekendsRemoved: r.weekendsRemoved,
    }])
    const view = await buildSimView(sb, { me, ownerEmail: me.email, session: updated, world, nowMs, today })
    return noStore<SimViewResponse>({ success: true, ...view })
  } catch (e) {
    return aiServerError('session/capacity', e, '調整模擬產線時數')
  }
}
