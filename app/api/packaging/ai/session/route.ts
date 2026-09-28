import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { POOL_WRITE_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { openWeekendDaysOf } from '@/lib/packaging/scheduleCalendar'
import { activeLinesOf } from '@/lib/packaging/scheduleLines'
import { todayTaipei } from '@/lib/packaging/workdays'
import { getSimSession, insertSimSession, loadSimWorld, updateSimSessionCas } from '@/lib/packaging/ai/db'
import { copyPlacementsFromLive, planSimWindow, pushUndo, simPlacementsTooLarge, snapshotForUndo } from '@/lib/packaging/ai/simState'
import { stateOf } from '@/lib/packaging/ai/runner'
import { planResetCapacity, sameSimCapacity } from '@/lib/packaging/ai/simCapacity'
import {
  AI_HORIZONS,
  SIM_MODES,
  type AiHorizon,
  type SimLocks,
  type SimMode,
  type SimStartOption,
  type SimViewResponse,
} from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, buildSimView, logAi, parseOwnerParam } from '../_lib/aiRoute'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P3：AI 模擬區（規格 §三；D77／D78／D83／D89）
//
// GET ?owner=<email>  → SimViewResponse：組合工作台（BoardResponse 同形）＋模擬區資訊＋執行中／最近一次 AI＋有模擬區的人。
//                       owner 省略＝自己；帶別人的 email＝唯讀檢視（其他被授權人的模擬區可看不可改，§二）。GET 不寫入。
// POST SimCreateRequest { horizon, mode, start, version? } → SimViewResponse：建立或重設自己的模擬區。
//   - 第一次建立不帶 version；已有模擬區時必須帶目前 version（CAS），否則 409 session_exists（避免兩個分頁互相覆蓋）。
//   - 範圍＝planSimWindow（起始日今天／下一個工作日 × 2/4/6 個工作日，已開加班的週末插入不佔名額）× 目前啟用中的線。
//   - copy：範圍內正式區未完成擺放複製成模擬列（新 id，原 id 記在 livePlacementId）；clear：空的（D78：清空＝全部可動）。
//   - 鎖定一律清空（copy 的模擬列換了新 id，舊的卡片鎖已對不上；要回到舊狀態按「退回上一步」）。
//   - 重設前把舊狀態整份推進 undo（可退回）。
//   - D101 模擬產線時數：建立＝空覆寫（沿用正式產能）；重設預設保留（keepCapacity，舊客戶端沒帶＝true）仍落在新範圍內的覆寫——
//     重設多半是「換模式重排」，時數設定不該跟著消失。模擬開的週末：先用正式的開加班週末算新範圍 W0，
//     再把「夾在 W0 第一天與最後一天之間」的模擬週末插回去（插入不改變起訖，所以不會循環）；其餘週末與範圍外的格丟掉。
// 權限：guardPackagingAi（packaging_ai＋packaging_admin，或 admin）。只寫 packaging_sim_sessions／packaging_op_log（kind ai_sim）。
// ⚠ 絕不寫 packaging_placements。

export async function GET(request: NextRequest) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const me = actorOf(g.member)
  const owner = parseOwnerParam(request.nextUrl.searchParams.get('owner'))
  if (owner === false) return aiFail('bad_request', 'owner 參數格式錯誤')
  const ownerEmail = owner ?? me.email
  const nowMs = Date.now()
  const today = todayTaipei(new Date(nowMs))
  try {
    const sb = getSupabaseAdminClient()
    const session = await getSimSession(sb, ownerEmail)
    const view = await buildSimView(sb, { me, ownerEmail, session, nowMs, today })
    return noStore<SimViewResponse>({ success: true, ...view })
  } catch (e) {
    return aiServerError('session GET', e, '讀取模擬區')
  }
}

const isHorizon = (v: unknown): v is AiHorizon => typeof v === 'number' && (AI_HORIZONS as readonly number[]).includes(v)
const isMode = (v: unknown): v is SimMode => typeof v === 'string' && (SIM_MODES as readonly string[]).includes(v)
const isStart = (v: unknown): v is SimStartOption => v === 'today' || v === 'next'

export async function POST(request: NextRequest) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return aiFail('bad_request', '請求格式錯誤（須為 JSON 物件）')
  const { horizon, mode, start } = body
  if (!isHorizon(horizon)) return aiFail('bad_request', `範圍須為 ${AI_HORIZONS.join('／')} 個工作日`)
  if (!isMode(mode)) return aiFail('bad_request', '模式須為 copy（複製現有排程）或 clear（清空重排）')
  if (!isStart(start)) return aiFail('bad_request', '起始日須為 today（今天）或 next（下一個工作日）')
  const version = body.version ?? null
  if (version !== null && !(typeof version === 'number' && Number.isSafeInteger(version) && version >= 1)) {
    return aiFail('bad_request', 'version 格式錯誤')
  }
  if (body.keepCapacity !== undefined && typeof body.keepCapacity !== 'boolean') return aiFail('bad_request', 'keepCapacity 須為 true / false')
  const keepCapacity = body.keepCapacity !== false

  const me = actorOf(g.member)
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const today = todayTaipei(new Date(nowMs))
  try {
    const sb = getSupabaseAdminClient()
    const existing = await getSimSession(sb, me.email)
    if (existing && version === null) {
      return aiFail('session_exists', '你已經有模擬區了；要重設請在畫面上按「重設模擬區」（會先存進退回上一步）')
    }
    if (existing && existing.version !== version) {
      return aiFail('version_conflict', '模擬區剛被更新（另一個分頁操作過或 AI 剛寫回），請重新載入後再重設')
    }

    // 寫入類（複製正式區）→ 待排池可用較舊的快取（同正式區寫入 API 的 10 分鐘）；擺放本身一律即時讀
    const world = await loadSimWorld(sb, { today, nowIso, actor: me, poolMaxAgeMs: POOL_WRITE_MAX_AGE_MS })
    const active = activeLinesOf(world.lines)
    if (active.length === 0) return aiFail('bad_request', '目前沒有啟用中的產線，無法建立模擬區（請先到產線設定啟用）')
    const lineIds = active.map((l) => l.id)
    const openWeekends = openWeekendDaysOf(world.capacityRows, world.lineRows, new Set(lineIds))
    const baseWindow = planSimWindow({ today, start, horizon, openWeekends })
    if (baseWindow.length === 0) return aiFail('bad_request', '算不出模擬日期（行事曆範圍外），請通知管理員')
    // D101：重設時保留仍在新範圍內的模擬週末與模擬時數（建立＝空覆寫）
    const { windowDates, simCapacity } = planResetCapacity({
      existing: existing?.simCapacity, baseWindow, lineIds, today, keepCapacity: !!existing && keepCapacity,
    })
    const placements = mode === 'copy'
      ? copyPlacementsFromLive(world.live, { windowDates, lineIds }, () => crypto.randomUUID())
      : []
    if (simPlacementsTooLarge(placements)) {
      return aiFail('bad_request', `範圍內的卡太多（${placements.length} 張），超過模擬區上限；請改用較短的範圍`)
    }
    const locks: SimLocks = { placementIds: [], soNumbers: [], lineIds: [] }
    const labelText = `${mode === 'copy' ? '複製現有' : '清空重排'}・${horizon} 天・${windowDates[0]} 起`

    let session
    if (existing) {
      const undo = pushUndo(existing.undo, snapshotForUndo(stateOf(existing), `重設模擬區（${labelText}）`, 'reset', nowIso))
      session = await updateSimSessionCas(sb, existing.id, existing.version, {
        horizon, mode, windowDates, lineIds, placements, locks, undo, ownerName: me.name,
        // D101：只有模擬產能有變才寫（migration 20260928c 套用前、沒調過時數的重設都不會碰到新欄）
        ...(sameSimCapacity(simCapacity, existing.simCapacity) ? {} : { simCapacity }),
      }, nowIso)
    } else {
      session = await insertSimSession(sb, {
        ownerEmail: me.email, ownerName: me.name, horizon, mode, windowDates, lineIds, placements, locks, undo: [],
      }, nowIso)
    }
    // null＝同時有另一個分頁建立／重設（owner 唯一鍵衝突或 version 已變）
    if (!session) return aiFail('version_conflict', '模擬區剛被另一個分頁建立或更新，請重新載入')

    await logAi(sb, me, 'ai_sim', existing ? `重設模擬區（${labelText}）` : `建立模擬區（${labelText}）`, [{
      action: existing ? 'reset' : 'create', sessionId: session.id, horizon, mode, start, windowDates, lineIds, placementCount: placements.length,
      ...(existing ? { keepCapacity, capacityCells: simCapacity.cells.length, weekendsOpened: simCapacity.weekendsOpened } : {}),
    }])
    const view = await buildSimView(sb, { me, ownerEmail: me.email, session, world, nowMs, today })
    return noStore<SimViewResponse>({ success: true, ...view })
  } catch (e) {
    return aiServerError('session POST', e, '建立模擬區')
  }
}
