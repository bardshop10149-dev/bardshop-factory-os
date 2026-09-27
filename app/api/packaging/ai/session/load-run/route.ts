import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { todayTaipei } from '@/lib/packaging/workdays'
import { getAiRun, updateSimSessionCas } from '@/lib/packaging/ai/db'
import { isInSimScope, normalizeLocks, pushUndo, snapshotForUndo } from '@/lib/packaging/ai/simState'
import { stateOf } from '@/lib/packaging/ai/runner'
import type { SimViewResponse } from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, buildSimView, loadOwnSession, logAi, parsePositiveId, parseVersion, sameEmail } from '../../_lib/aiRoute'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P3：從 AI 執行歷史載入（規格 §三「歷史切換」、§九 預設第 1 點）
//
// POST SimLoadRunRequest { version, runId, which: 'result' | 'base' } → SimViewResponse
//   which 'result'＝該次 AI 驗算後的結果、'base'＝該次 AI 前的模擬區（「回到 AI 前」）；載入前先推 undo（可退回）。
//   只能載入自己的 run，且 horizon／window 與目前模擬區相同（不同 → window_mismatch：日期對不上，擺放沒有意義）。
//   result 要 done 才有；base 在 run 結束後（done 或 failed）都可載入。
//   鎖定一併換成該次 run 當時的鎖定（卡片鎖指的是那一份擺放的 id），只留目前模擬範圍內仍有效的。
//   用途之一：AI 執行期間主管動過模擬區 → 結果沒寫回（validation.applied = false），可從這裡載入。
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
  const runId = typeof body.runId === 'number' ? parsePositiveId(String(body.runId)) : null
  if (runId == null) return aiFail('bad_request', 'runId 格式錯誤')
  const which = body.which
  if (which !== 'result' && which !== 'base') return aiFail('bad_request', "which 須為 'result'（AI 結果）或 'base'（AI 前）")

  const me = actorOf(g.member)
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const today = todayTaipei(new Date(nowMs))
  try {
    const sb = getSupabaseAdminClient()
    const own = await loadOwnSession(sb, me, version)
    if (!own.ok) return own.res
    const session = own.session

    const run = await getAiRun(sb, runId)
    if (!run) return aiFail('not_found', `找不到 AI 執行 #${runId}`)
    if (!sameEmail(run.ownerEmail, me.email)) return aiFail('not_owner', '只能載入自己的 AI 執行結果')
    if (run.status === 'running') return aiFail('run_not_ready', '這次 AI 還在執行中，請等它完成')
    const placements = which === 'result' ? run.resultPlacements : run.basePlacements
    if (which === 'result' && (run.status !== 'done' || placements == null)) {
      return aiFail('run_not_ready', '這次 AI 沒有成功完成，沒有結果可以載入（可改載入「AI 前」）')
    }
    const sameWindow = run.horizon === session.horizon
      && run.windowDates.length === session.windowDates.length
      && run.windowDates.every((d, i) => d === session.windowDates[i])
    if (!sameWindow) {
      return aiFail('window_mismatch', `這次 AI 的範圍（${run.windowDates[0] ?? '?'} 起 ${run.horizon} 天）與目前模擬區不同，無法載入；請先把模擬區重設成相同範圍`)
    }

    // 只收目前範圍內的列（同範圍但線別在重設時變過的極端情況），鎖定依這份擺放重新整理
    const scope = { windowDates: session.windowDates, lineIds: session.lineIds }
    const rows = (placements ?? []).filter((p) => isInSimScope(p, scope))
    const locks = normalizeLocks(run.locks, { placements: rows, lineIds: session.lineIds }) ?? { placementIds: [], soNumbers: [], lineIds: [] }
    const label = `載入 AI #${runId} 的${which === 'result' ? '結果' : '執行前狀態'}`
    const updated = await updateSimSessionCas(sb, session.id, version, {
      placements: rows,
      locks,
      undo: pushUndo(session.undo, snapshotForUndo(stateOf(session), label, 'load_run', nowIso)),
    }, nowIso)
    if (!updated) return aiFail('version_conflict', '模擬區剛被更新（另一個分頁操作過或 AI 剛寫回），請重新載入後再操作')

    await logAi(sb, me, 'ai_sim', label, [{ action: 'load_run', sessionId: session.id, runId, which, placementCount: rows.length }])
    const view = await buildSimView(sb, { me, ownerEmail: me.email, session: updated, nowMs, today })
    return noStore<SimViewResponse>({ success: true, ...view })
  } catch (e) {
    return aiServerError('session/load-run', e, '載入 AI 結果')
  }
}
