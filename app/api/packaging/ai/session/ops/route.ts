import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { POOL_WRITE_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { parseOps } from '@/lib/packaging/scheduleOps'
import { todayTaipei } from '@/lib/packaging/workdays'
import { loadSimWorld, updateSimSessionCas } from '@/lib/packaging/ai/db'
import { SIM_ALLOWED_OPS, applySimOps, pushUndo, simPlacementsTooLarge, snapshotForUndo } from '@/lib/packaging/ai/simState'
import { withSimCapacity } from '@/lib/packaging/ai/simCapacity'
import { stateOf } from '@/lib/packaging/ai/runner'
import { SIM_LABEL_MAX, SIM_MAX_PLACEMENTS, type SimViewResponse } from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, buildSimView, loadOwnSession, logAi, parseVersion } from '../../_lib/aiRoute'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P3：模擬區手動操作（規格 §三「模擬區手動操作」；D77 主管可在模擬區調整）
//
// POST SimOpsRequest { version, ops: PlacementOp[1..50], label? } → SimViewResponse
//   op 只收 place／move／split／merge／unplace／reorder／setMinutes（SIM_ALLOWED_OPS；complete／setQty／restore 屬正式區或 Undo）。
//   流程：讀自己的模擬區（version 相符）→ 讀正式區世界 → simState.applySimOps（只准動模擬列、目標在範圍內、鎖定不可動，
//         再對「組合狀態」跑既有 applyOps——守恆／日期／線／D22 與正式區同一套規則）→ version CAS 寫回 placements → 推 undo。
//   為什麼不需要正式區編輯鎖：只寫自己的模擬區（packaging_sim_sessions），正式排程完全不動；併發由 session.version 擋。
// ⚠ 絕不寫 packaging_placements。

export async function POST(request: NextRequest) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return aiFail('bad_request', '請求格式錯誤（須為 JSON 物件）')
  const version = parseVersion(body.version)
  if (version == null) return aiFail('bad_request', 'version 格式錯誤')
  // 形狀檢查與正式區同一個 parseOps（1..50 個、欄位型別），再限定模擬區允許的 op 種類
  const parsed = parseOps(body.ops, SIM_ALLOWED_OPS)
  if (!parsed.ok) return aiFail(parsed.code, parsed.message, parsed.opIndex != null ? { opIndex: parsed.opIndex } : {})
  const rawLabel = typeof body.label === 'string' ? body.label.trim() : ''
  const label = (rawLabel || '模擬區調整').slice(0, SIM_LABEL_MAX)

  const me = actorOf(g.member)
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const today = todayTaipei(new Date(nowMs))
  try {
    const sb = getSupabaseAdminClient()
    const own = await loadOwnSession(sb, me, version)
    if (!own.ok) return own.res
    const session = own.session

    const world = await loadSimWorld(sb, { today, nowIso, actor: me, poolMaxAgeMs: POOL_WRITE_MAX_AGE_MS })
    // D101：驗證用「疊了模擬產能」的 world（模擬開的週末才是可排日）；buildSimView 仍傳正式 world（它自己疊）
    const r = applySimOps({ world: withSimCapacity(world, session), session, ops: parsed.ops })
    if (!r.ok) return aiFail(r.code, r.message, { opIndex: r.opIndex })
    // 張數與 jsonb 位元組（DB check 量的是 UTF-8 位元組，不是字元數）都要在上限內
    if (simPlacementsTooLarge(r.placements)) {
      return aiFail('bad_request', `模擬區的卡超過上限 ${SIM_MAX_PLACEMENTS} 張，請先合併`)
    }

    const updated = await updateSimSessionCas(sb, session.id, version, {
      placements: r.placements,
      undo: pushUndo(session.undo, snapshotForUndo(stateOf(session), label, 'ops', nowIso)),
    }, nowIso)
    if (!updated) return aiFail('version_conflict', '模擬區剛被更新（另一個分頁操作過或 AI 剛寫回），請重新載入後再操作')

    await logAi(sb, me, 'ai_sim', label, [{ action: 'ops', sessionId: session.id, ops: parsed.ops }])
    const view = await buildSimView(sb, { me, ownerEmail: me.email, session: updated, world, nowMs, today })
    return noStore<SimViewResponse>({ success: true, ...view })
  } catch (e) {
    return aiServerError('session/ops', e, '模擬區操作')
  }
}
