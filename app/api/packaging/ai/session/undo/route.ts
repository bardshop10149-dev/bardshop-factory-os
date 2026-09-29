import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { todayTaipei } from '@/lib/packaging/workdays'
import { updateSimSessionCas } from '@/lib/packaging/ai/db'
import { popUndo } from '@/lib/packaging/ai/simState'
import { undoCapacityPatch } from '@/lib/packaging/ai/simCapacity'
import type { SimViewResponse } from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, buildSimView, loadOwnSession, logAi, parseVersion } from '../../_lib/aiRoute'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P3：模擬區「退回上一步」（規格 §三；D77）
//
// POST SimUndoRequest { version } → SimViewResponse
//   彈出 undo 堆疊最上面一格，整份還原（範圍、模式、線、擺放、鎖定）。涵蓋：手動操作、AI 排程、重設、載入歷史結果、鎖定變更。
//   為什麼用整份快照而不是反向 ops：模擬區是純 JSON、不牽涉正式區，整份換回去最簡單也最不會錯（正式區的 Undo 才需要反向 ops）。
//   退回本身不再推 undo（沒有「重做」）。
// D101：模擬產線時數也在快照裡（kind 'capacity' 是改時數推的格；週末開關時 windowDates 一起在快照裡）。
//   只有快照有這欄、且與目前不同時才寫 sim_capacity——快照沒有這欄（穩定站舊程式推的，或舊程式寫 undo 時把整個堆疊
//   重寫、洗掉了新程式格裡的產能快照）→ 保留目前產能，目前有模擬時數時回 notice 提示「時數無法還原」（不默默保留）；
//   migration 20260928c 套用前也不會碰到新欄。
//   堆疊是後進先出：退回某一步時，它之後的產能修改一定已先被退掉，所以「還原到當時的產能」永遠等於「當時看到的畫面」。
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
    const { entry, rest } = popUndo(session.undo)
    if (!entry) return aiFail('bad_request', '沒有可以退回的步驟')

    const s = entry.state
    const cap = undoCapacityPatch(s, session.simCapacity)
    const updated = await updateSimSessionCas(sb, session.id, version, {
      horizon: s.horizon, mode: s.mode, windowDates: s.windowDates, lineIds: s.lineIds, placements: s.placements, locks: s.locks,
      ...(cap.simCapacity ? { simCapacity: cap.simCapacity } : {}),
      undo: rest,
    }, nowIso)
    if (!updated) return aiFail('version_conflict', '模擬區剛被更新（另一個分頁操作過或 AI 剛寫回），請重新載入後再操作')

    const label = `退回上一步（${entry.label}）`
    await logAi(sb, me, 'ai_sim', label, [{ action: 'undo', sessionId: session.id, kind: entry.kind, undoneAt: entry.at, ...(cap.capacityUnknown ? { capacityUnknown: true } : {}) }])
    const view = await buildSimView(sb, { me, ownerEmail: me.email, session: updated, nowMs, today })
    // D101 驗證修正：這一格沒有產能快照（舊程式 3711 推的，或舊程式寫 undo 時洗掉了）、目前又有模擬時數 → 講清楚時數沒退
    const notice = cap.capacityUnknown
      ? `已退回「${entry.label}」，但這一步是舊版程式記錄的，無法得知當時的模擬產線時數：目前的時數維持不變，需要的話請到「產線時數」調整`
      : undefined
    return noStore<SimViewResponse>({ success: true, ...view, ...(notice ? { notice } : {}) })
  } catch (e) {
    return aiServerError('session/undo', e, '退回上一步')
  }
}
