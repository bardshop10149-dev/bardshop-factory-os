import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { todayTaipei } from '@/lib/packaging/workdays'
import { updateSimSessionCas } from '@/lib/packaging/ai/db'
import { normalizeLocks, pushUndo, snapshotForUndo } from '@/lib/packaging/ai/simState'
import { stateOf } from '@/lib/packaging/ai/runner'
import type { SimViewResponse } from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, buildSimView, loadOwnSession, logAi, parseVersion } from '../../_lib/aiRoute'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P3：模擬區鎖定（規格 §三「鎖定」；D88）
//
// POST SimLocksRequest { version, locks: { placementIds, soNumbers, lineIds } } → SimViewResponse
//   整份替換（畫面上點鎖頭＝送出新的整份），normalizeLocks 只留存在的模擬列 id、模擬範圍內的線、SO 單號大寫去重。
//   鎖定的列：原位不動、照樣佔產能、AI 看得到但不能改；鎖定訂單的剩餘量 AI 也不能新排；鎖定的線 AI 不能放新卡也不能移出，
//   採用時鎖定的線也不會覆蓋到正式區（D87）。變更鎖定也推一格 undo（kind 'locks'），可退回。
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

  const me = actorOf(g.member)
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const today = todayTaipei(new Date(nowMs))
  try {
    const sb = getSupabaseAdminClient()
    const own = await loadOwnSession(sb, me, version)
    if (!own.ok) return own.res
    const session = own.session
    const locks = normalizeLocks(body.locks, session)
    if (!locks) return aiFail('bad_request', 'locks 格式錯誤（須為 { placementIds, soNumbers, lineIds } 三個陣列）')

    const label = `變更鎖定（卡 ${locks.placementIds.length}・訂單 ${locks.soNumbers.length}・線 ${locks.lineIds.length}）`
    const updated = await updateSimSessionCas(sb, session.id, version, {
      locks,
      undo: pushUndo(session.undo, snapshotForUndo(stateOf(session), label, 'locks', nowIso)),
    }, nowIso)
    if (!updated) return aiFail('version_conflict', '模擬區剛被更新（另一個分頁操作過或 AI 剛寫回），請重新載入後再操作')

    await logAi(sb, me, 'ai_sim', label, [{ action: 'locks', sessionId: session.id, locks }])
    const view = await buildSimView(sb, { me, ownerEmail: me.email, session: updated, nowMs, today })
    return noStore<SimViewResponse>({ success: true, ...view })
  } catch (e) {
    return aiServerError('session/locks', e, '變更鎖定')
  }
}
