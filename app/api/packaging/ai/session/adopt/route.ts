import type { NextRequest } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { POOL_WRITE_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { buildSnapshot, snapshotTooLarge } from '@/lib/packaging/scheduleSnapshot'
import { MAX_OPEN_PLACEMENTS, buildMinuteAdjustments } from '@/lib/packaging/scheduleWrite'
import {
  countOpenPlacements,
  deleteExpiredVersions,
  insertTimeAdjustments,
  insertVersion,
  verifyAndTouchLock,
  writeApplied,
  type SupabaseAdmin,
} from '@/lib/packaging/scheduleDb'
import { todayTaipei } from '@/lib/packaging/workdays'
import { getSimSession, insertAdoption, isSimSessionStale, listAiRuns, loadSimWorld, updateSimSessionCas } from '@/lib/packaging/ai/db'
import { buildSimOpsContext } from '@/lib/packaging/ai/simState'
import { safeErrorTag } from '@/lib/packaging/ai/runner'
import {
  AI_RUN_HISTORY_LIMIT,
  type AdoptPreviewResponse,
  type AdoptResponse,
  type SimSession,
  type SimWorld,
} from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, logAi, parseVersion, type Actor } from '../../_lib/aiRoute'
import {
  adoptScopeOf,
  adoptionTargetOf,
  lockedConflictMessage,
  lockedLineConflicts,
  openDeltaOf,
  planAndApply,
  sameDates,
  type AdoptionRun,
} from '../../_lib/adoptFlow'

export const dynamic = 'force-dynamic'
// 採用可能上百張 move／restore：writeApplied 的更新是一列一個請求（數秒～十餘秒），比一般寫入 API 的 60 秒多留餘裕
export const maxDuration = 120

// 包裝專區 P3：採用模擬版（規格 §6.1；D82／D86／D87／D90）
//
// GET  → AdoptPreviewResponse：預覽（不寫入、不需鎖）——範圍、會移動／新增／移回待排池幾張、會略過哪些、備份版本名稱
// POST AdoptRequest { lockToken, version } → AdoptResponse
//   1. 正式區編輯鎖（D53，verifyAndTouchLock；沒鎖 → lock_required，前端引導取得／接手）＋自己的模擬區 version 相符＋起始日未過
//   2. 範圍＝window_dates × 未鎖定的線（D87）；以模擬版為準（D86）算差異（adopt.planAdoption）→ 逐筆模擬套用（applyOpsLenient，
//      已完成／已銷貨／不在待排池的自動略過並列入報告）
//   3. 先存完整快照版本 auto_before_ai（最後備援）→ writeApplied（先減後增）；寫到一半失敗 → 回 partial＋「從版本 #M 還原」
//   4. 寫 packaging_ai_adoptions（inverse、touched＝寫入後每列 {id, version}、counts、skipped）＋op_log ai_adopt（ops 原文）
//   模擬區保留（主管可繼續調整或重排）。
// 擋下的情況（都不寫入）：
//   - 鎖定線上的模擬內容與正式區不一致、會讓同一品項一半照模擬版一半照正式區（卡片消失或重複；adoptFlow.lockedLineConflicts）
//     → 409 locked_line_diverged＋conflicts；預覽也列出來、採用鈕停用。
//   - 同一份模擬版被採用兩次：寫入前先以 version CAS 佔用模擬區（version + 1）。為什麼需要：採用本身原本不改 version，
//     新卡用 restore（伺服器每次產生新 uuid，主鍵擋不下），同一位持鎖者重新整理後再按一次、或另一個分頁接手鎖後再按，
//     兩個請求都會通過鎖與 version 檢查、各自插入一份 → 正式區超過待排池可排量（審查驗證 adopt-race-probe）。
//     佔用成功的那個才寫；另一個回 version_conflict。前端採用後本來就會重新載入模擬區（拿到新 version）。
// D69：寫進正式區的工時覆寫（setMinutes）一律留學習紀錄（packaging_time_adjustments），reason 固定「採用 AI 模擬」
//   （adopt.ADOPT_MINUTES_REASON），學習端可據此與主管在正式區親手改的分開（其中也含驗算等比換算的值）。
// ⚠ 正式區只經由既有 writeApplied 寫入；模擬列本身絕不寫進 packaging_placements（寫進去的是 applyOps 產生的正式列）。

/**
 * 這次採用來自哪一次 AI（adoption.run_id 與版本標籤用；推定）：模擬區有 AI 排的列時，取同一個模擬區、同範圍、最近一次成功的 run；
 * 沒有 AI 列（全是複製／手動）→ null（標「手動」）。只是追溯資訊，不影響採用內容。
 */
async function inferRunId(sb: SupabaseAdmin, me: Actor, session: SimSession): Promise<number | null> {
  if (!session.placements.some((p) => p.simSource === 'ai')) return null
  const runs = await listAiRuns(sb, me.email, AI_RUN_HISTORY_LIMIT)
  const hit = runs.find((r) => r.sessionId === session.id && r.status === 'done' && sameDates(r.windowDates, session.windowDates))
  return hit?.id ?? null
}

const versionLabelOf = (runId: number | null) => `採用 AI 模擬前（${runId != null ? `#${runId}` : '手動'}）`

/** 採用的差異＋鎖定線不一致檢查（GET 預覽與 POST 共用，保證畫面看到的就是會擋下的） */
function planAdopt(world: SimWorld, session: SimSession) {
  const { scope, lockedLineIds } = adoptScopeOf(session)
  const run: AdoptionRun = planAndApply(world, adoptionTargetOf(session, scope, world.live), scope)
  const conflicts = run.tooManyOps ? [] : lockedLineConflicts(world, session, run)
  return { scope, lockedLineIds, run, conflicts }
}

export async function GET() {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const me = actorOf(g.member)
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const today = todayTaipei(new Date(nowMs))
  try {
    const sb = getSupabaseAdminClient()
    const session = await getSimSession(sb, me.email)
    if (!session) return aiFail('no_session', '還沒有建立模擬區')
    if (isSimSessionStale(session, today)) return aiFail('session_stale', '模擬區的起始日已經過了，請先重設模擬區再採用')
    const world = await loadSimWorld(sb, { today, nowIso, actor: me, poolMaxAgeMs: POOL_WRITE_MAX_AGE_MS })
    const { scope, lockedLineIds, run, conflicts } = planAdopt(world, session)
    if (run.tooManyOps) return aiFail('too_many_ops', '範圍內要變動的卡太多，無法一次採用；請縮小範圍或先鎖定部分線')
    const runId = await inferRunId(sb, me, session)
    return noStore<AdoptPreviewResponse>({
      success: true,
      scope: { windowDates: session.windowDates, lineIds: [...scope.lineIds], lockedLineIds },
      counts: run.counts,
      skipped: run.skipped,
      versionLabel: versionLabelOf(runId),
      lockedConflicts: conflicts,
    })
  } catch (e) {
    return aiServerError('session/adopt GET', e, '採用預覽')
  }
}

export async function POST(request: NextRequest) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const body = await readJson(request)
  if (!body) return aiFail('bad_request', '請求格式錯誤（須為 JSON 物件）')
  const version = parseVersion(body.version)
  if (version == null) return aiFail('bad_request', 'version 格式錯誤')
  const lockToken = typeof body.lockToken === 'string' ? body.lockToken : null

  const me = actorOf(g.member)
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const today = todayTaipei(new Date(nowMs))
  try {
    const sb = getSupabaseAdminClient()
    // 1. 正式區編輯鎖（D53）：驗鎖同時續命
    const lk = await verifyAndTouchLock(sb, { email: me.email, token: lockToken }, nowMs)
    if (!lk.ok) {
      return aiFail(lk.code, lk.code === 'lock_lost'
        ? `編輯權已由 ${lk.lock.holderName ?? lk.lock.holderEmail ?? '其他人'} 接手，請接手後再採用`
        : '採用會修改正式排程，需要編輯權：請先取得（或接手）編輯權', { lock: lk.lock })
    }
    const lock = lk.lock
    const session = await getSimSession(sb, me.email)
    if (!session) return aiFail('no_session', '還沒有建立模擬區', { lock })
    if (session.version !== version) return aiFail('version_conflict', '模擬區剛被更新，請重新載入、確認後再採用', { lock })
    if (isSimSessionStale(session, today)) return aiFail('session_stale', '模擬區的起始日已經過了，請先重設模擬區再採用', { lock })

    // 2. 差異 → 逐筆模擬套用
    const world = await loadSimWorld(sb, { today, nowIso, actor: me, poolMaxAgeMs: POOL_WRITE_MAX_AGE_MS })
    const { scope, run, conflicts } = planAdopt(world, session)
    if (run.tooManyOps) return aiFail('too_many_ops', '範圍內要變動的卡太多，無法一次採用；請縮小範圍或先鎖定部分線', { lock })
    if (conflicts.length > 0) return aiFail('locked_line_diverged', lockedConflictMessage(conflicts.length), { conflicts, lock })
    if (run.res.applied.length === 0) {
      return aiFail('nothing_to_adopt', run.plan.ops.length === 0 && run.skipped.length === 0
        ? '範圍內模擬版與正式排程相同，沒有需要採用的變更'
        : `範圍內的 ${run.skipped.length} 項變更都無法套用（已完成、已銷貨或已不在待排池），正式排程沒有被修改`, { lock })
    }
    const delta = openDeltaOf(run.res)
    if (delta > 0 && (await countOpenPlacements(sb)) + delta > MAX_OPEN_PLACEMENTS) {
      return aiFail('bad_request', `未完成的卡會超過上限 ${MAX_OPEN_PLACEMENTS} 張，請先在正式區合併或移除`, { lock })
    }

    // 3. 採用前完整快照（auto_before_ai）→ 佔用模擬區 → 寫入
    const snapshot = buildSnapshot(world.live, today, nowIso)
    const big = snapshotTooLarge(snapshot)
    if (big) return aiFail('bad_request', big, { lock })
    const runId = await inferRunId(sb, me, session)
    const versionLabel = versionLabelOf(runId)

    // 佔用（第一個寫入動作）：version CAS 成功才往下寫；同一份模擬版的第二個採用請求在這裡回 version_conflict（見檔頭）
    const claimed = await updateSimSessionCas(sb, session.id, version, {}, nowIso)
    if (!claimed) return aiFail('version_conflict', '模擬區剛被更新（或這一版剛被另一個請求採用），這次沒有寫入；請重新載入、確認後再採用', { lock })

    const backup = await insertVersion(sb, { label: versionLabel, source: 'auto_before_ai', snapshot, actorEmail: me.email, actorName: me.name })

    // requiresSortIndex false：sort_index 欄若尚未建立，只是線內順序回到固定排序，日期／線／數量照寫（順序只影響顯示）
    const w = await writeApplied(sb, run.res, { requiresSortIndex: false })
    if (!w.ok) {
      console.error(`[packaging/ai/session/adopt] 寫入失敗 ${w.code}${w.partial ? ' (partial)' : ''}`)
      if (w.partial) {
        return aiFail(w.code, `採用寫到一半失敗，部分卡片已寫入正式區；請到「版本歷史」從版本 #${backup.id}「${versionLabel}」還原`, { partial: true, versionId: backup.id, lock }, 500)
      }
      return aiFail(w.code, `${w.message}（正式排程沒有被修改，請重新載入後再試）`, { versionId: backup.id, lock })
    }

    // D69：工時覆寫有變的卡留學習紀錄（先改工時、後記紀錄，同 scheduleWrite；記錄失敗不擋採用，只 log）
    if (run.res.minuteEdits.length > 0) {
      const ctx = buildSimOpsContext(world)
      const adj = buildMinuteAdjustments(run.res, { supplyOf: ctx.supplyOf, cards: ctx.cards, today, openWeekends: ctx.openWeekends, actor: me })
      if (!(await insertTimeAdjustments(sb, adj))) console.error('[packaging/ai/session/adopt] 工時修改紀錄寫入失敗（D69）')
    }

    // 4. 採用紀錄＋op_log
    const touched = w.rows.map((r) => ({ id: r.id, version: r.version }))
    let adoptionId: number
    try {
      const adoption = await insertAdoption(sb, {
        sessionId: session.id,
        runId,
        versionId: backup.id,
        windowDates: session.windowDates,
        lineIds: [...scope.lineIds],
        inverse: run.res.inverse,
        touched,
        counts: run.counts,
        skipped: run.skipped,
        actorEmail: me.email,
        actorName: me.name,
      }, nowIso)
      adoptionId = adoption.id
    } catch (e) {
      console.error(`[packaging/ai/session/adopt] 採用紀錄寫入失敗 ${safeErrorTag(e)}`)
      return aiFail('db_error', `已套用到正式排程，但採用紀錄寫入失敗，無法從「AI 採用紀錄」退回；如需退回請從版本 #${backup.id} 還原`, { partial: true, versionId: backup.id, lock }, 500)
    }
    await deleteExpiredVersions(sb, nowMs)
    await logAi(sb, me, 'ai_adopt', `採用 AI 模擬（採用 #${adoptionId}${runId != null ? `，AI #${runId}` : ''}）`, [{
      adoptionId, sessionId: session.id, runId, versionId: backup.id,
      scope: { windowDates: session.windowDates, lineIds: scope.lineIds }, counts: run.counts, ops: run.res.applied,
    }])
    return noStore<AdoptResponse>({ success: true, adoptionId, counts: run.counts, skipped: run.skipped, versionId: backup.id, lock })
  } catch (e) {
    return aiServerError('session/adopt POST', e, '採用')
  }
}
