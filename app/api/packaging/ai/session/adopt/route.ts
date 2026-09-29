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
import { executeCapacityPlan } from '@/lib/packaging/capacityWrite'
import { rowsAfterPlan } from '@/lib/packaging/capacityPlan'
import { normalPoolLineKeys } from '@/lib/packaging/manualPool'
import { reconcileManualAfterPlacementWrite } from '@/lib/packaging/manualReconcile'
import { getSimSession, insertAdoption, isSimSessionStale, listAiRuns, loadSimWorld, updateSimSessionCas } from '@/lib/packaging/ai/db'
import { buildSimOpsContext } from '@/lib/packaging/ai/simState'
import { isEmptySimCapacity, normalizeSimCapacity, pruneAdoptedCells, sameSimCapacity, sameWorkdays, withSimCapacity } from '@/lib/packaging/ai/simCapacity'
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
  type AdoptionRun,
} from '../../_lib/adoptFlow'
import { capacityErrorText, describeCapacityBefore, logCapacity, planAdoptCapacity } from '../../_lib/capacityFlow'

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
//
// D101 模擬產線時數一起匯入正式產能表（與排程同一個請求）：
//   - 排程差異用「疊了模擬產能」的 world 算（simWorld：模擬開的週末才是可排日，否則那天的卡放不進去）；
//     產能差異用正式 world 算（capacityFlow.planAdoptCapacity：只寫有差異的格＋範圍後的保值列，D87 範圍外不動）。
//   - 寫入順序：佔用模擬區 → 存 auto_before_ai →【先產能】→【再排程】→ 採用紀錄（含 capacity_changes）→ op_log（'capacity'＋ai_adopt）。
//     為什麼先產能：排程的驗算已在記憶體用模擬產能做完，DB 寫入順序只影響失敗時留下的狀態——先排程後產能，產能失敗時正式區會有卡
//     落在「正式沒開的週末」，要補救得把排程也倒回；先產能後排程，產能寫入量小（各線列、daily 列兩批），失敗時用 capacity_changes
//     反向寫回即可，主管看到的是「兩邊都沒動」。排程寫入失敗也同樣先把產能改回採用前。
//   - 只改時數、排程沒有差異也能採用（「只匯入產線時數」）；產能這段通不過正式產能表的驗證 → 整個採用擋下、什麼都不寫。
//   - 採用成功後（盡力而為）清掉模擬區中「已與正式相同」的覆寫：否則之後組長改正式 9/30，模擬區還被舊覆寫壓著，下一次採用會蓋回去。

/**
 * 這次採用來自哪一次 AI（adoption.run_id 與版本標籤用；推定）：模擬區有 AI 排的列時，取同一個模擬區、同範圍、最近一次成功的 run；
 * 沒有 AI 列（全是複製／手動）→ null（標「手動」）。只是追溯資訊，不影響採用內容。
 */
async function inferRunId(sb: SupabaseAdmin, me: Actor, session: SimSession): Promise<number | null> {
  if (!session.placements.some((p) => p.simSource === 'ai')) return null
  const runs = await listAiRuns(sb, me.email, AI_RUN_HISTORY_LIMIT)
  // D101：模擬開的週末會改變 window，比工作日即可
  const hit = runs.find((r) => r.sessionId === session.id && r.status === 'done' && sameWorkdays(r.windowDates, session.windowDates))
  return hit?.id ?? null
}

const versionLabelOf = (runId: number | null) => `採用 AI 模擬前（${runId != null ? `#${runId}` : '手動'}）`

/**
 * 採用的差異＋鎖定線不一致檢查（GET 預覽與 POST 共用，保證畫面看到的就是會擋下的）。
 * D101：排程用 simWorld（疊了模擬產能：模擬開的週末是可排日、D69 等比換算的 ctx 也一樣）；產能段另用正式 world 算。
 */
function planAdopt(world: SimWorld, session: SimSession, me: Actor) {
  const simWorld = withSimCapacity(world, session)
  const { scope, lockedLineIds } = adoptScopeOf(session)
  const run: AdoptionRun = planAndApply(simWorld, adoptionTargetOf(session, scope, simWorld.live), scope)
  const conflicts = run.tooManyOps ? [] : lockedLineConflicts(simWorld, session, run)
  const cap = planAdoptCapacity({ world, session, scope, lockedLineIds, actor: me })
  return { simWorld, scope, lockedLineIds, run, conflicts, cap }
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
    const { scope, lockedLineIds, run, conflicts, cap } = planAdopt(world, session, me)
    if (run.tooManyOps) return aiFail('too_many_ops', '範圍內要變動的卡太多，無法一次採用；請縮小範圍或先鎖定部分線')
    const runId = await inferRunId(sb, me, session)
    return noStore<AdoptPreviewResponse>({
      success: true,
      scope: { windowDates: session.windowDates, lineIds: [...scope.lineIds], lockedLineIds },
      counts: run.counts,
      skipped: run.skipped,
      versionLabel: versionLabelOf(runId),
      lockedConflicts: conflicts,
      // D101：模擬區有調整時數才回（沒有＝null，畫面不顯示產線時數段）
      capacity: isEmptySimCapacity(normalizeSimCapacity(session.simCapacity, session)) ? null : cap.cap.preview,
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

    // 2. 差異 → 逐筆模擬套用（排程用疊了模擬產能的 world；產能段用正式 world）
    const world = await loadSimWorld(sb, { today, nowIso, actor: me, poolMaxAgeMs: POOL_WRITE_MAX_AGE_MS })
    const { simWorld, scope, run, conflicts, cap } = planAdopt(world, session, me)
    if (run.tooManyOps) return aiFail('too_many_ops', '範圍內要變動的卡太多，無法一次採用；請縮小範圍或先鎖定部分線', { lock })
    if (conflicts.length > 0) return aiFail('locked_line_diverged', lockedConflictMessage(conflicts.length), { conflicts, lock })
    // D101：產能段通不過正式產能表的驗證 → 整個採用擋下（什麼都不寫）
    if (cap.error) return aiFail(cap.error.code, capacityErrorText(cap.error), { lock, date: cap.error.date }, cap.error.status)
    const capPlan = cap.put
    const capRecord = capPlan ? cap.cap.record : null
    if (run.res.applied.length === 0 && !capPlan) {
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

    /** D101 補償：把產能改回採用前（以採用前的正式列事先算好的計畫）；回 true＝已改回 */
    const rollbackCapacity = async (why: string): Promise<boolean> => {
      if (!capPlan || !capRecord) return true
      let ok = false
      if (cap.rollback) {
        try {
          await executeCapacityPlan(sb, cap.rollback, nowIso)
          ok = true
        } catch (e2) {
          console.error(`[packaging/ai/session/adopt] 產能補償失敗 ${safeErrorTag(e2)}`)
        }
      }
      // 產能有寫就一定要記 'capacity'（正式工作台刷新的訊號），含補償
      await logCapacity(sb, me, `產能表（採用 AI 模擬失敗，${ok ? '已自動改回' : '未能自動改回'}）`, [{ via: 'ai_adopt_rollback', why, restored: ok, record: capRecord }])
      return ok
    }
    const capBeforeText = () => (capRecord ? describeCapacityBefore(capRecord, world.lines) : '')

    // 3a.【先產能】（D101）
    if (capPlan) {
      try {
        await executeCapacityPlan(sb, capPlan, nowIso)
      } catch (e) {
        console.error(`[packaging/ai/session/adopt] 產能寫入失敗 ${safeErrorTag(e)}`)
        const restored = await rollbackCapacity('capacity_write_failed')
        return aiFail('db_error', restored
          ? '匯入產線時數失敗，已自動改回；正式排程與產能都沒有被修改，請稍後再試'
          : `匯入產線時數失敗，自動改回也失敗；正式排程沒有被修改。請到產能表把下列各格手動改回：${capBeforeText()}`,
        { versionId: backup.id, lock }, 500)
      }
    }

    // 3b.【再排程】；requiresSortIndex false：sort_index 欄若尚未建立，只是線內順序回到固定排序，日期／線／數量照寫（順序只影響顯示）
    let touched: { id: string; version: number }[] = []
    if (run.res.applied.length > 0) {
      const capMsgOf = (restored: boolean) => (!capPlan ? ''
        : restored ? '產線時數已自動改回採用前。' : `產線時數未能自動改回，請到產能表把下列各格手動改回：${capBeforeText()}。`)
      let w: Awaited<ReturnType<typeof writeApplied>>
      try {
        w = await writeApplied(sb, run.res, { requiresSortIndex: false })
      } catch (e) {
        // 寫排程時丟例外（不是一般的寫入失敗回報）：一樣先把產能改回，再請主管從版本還原排程
        console.error(`[packaging/ai/session/adopt] 寫入排程時發生例外 ${safeErrorTag(e)}`)
        const restored = await rollbackCapacity('schedule_write_threw')
        return aiFail('db_error', `採用寫入正式排程時發生錯誤，可能只寫入了一部分；請到「版本歷史」從版本 #${backup.id}「${versionLabel}」還原。${capMsgOf(restored)}`, { partial: true, versionId: backup.id, lock }, 500)
      }
      if (!w.ok) {
        console.error(`[packaging/ai/session/adopt] 寫入失敗 ${w.code}${w.partial ? ' (partial)' : ''}`)
        const restored = await rollbackCapacity(`schedule_write_failed:${w.code}`)
        const capMsg = capMsgOf(restored)
        if (w.partial) {
          return aiFail(w.code, `採用寫到一半失敗，部分卡片已寫入正式區；請到「版本歷史」從版本 #${backup.id}「${versionLabel}」還原。${capMsg}`, { partial: true, versionId: backup.id, lock }, 500)
        }
        return aiFail(w.code, `${w.message}（正式排程沒有被修改，請重新載入後再試）${capMsg}`, { versionId: backup.id, lock })
      }
      touched = w.rows.map((r) => ({ id: r.id, version: r.version }))
      // D102 寫後回讀：待排池頁同時移出／改低了手動加入的品項 → 以排程為準恢復供給（同 scheduleWrite）
      await reconcileManualAfterPlacementWrite(sb, {
        meta: world.manual?.meta ?? {}, normalKeys: normalPoolLineKeys(world.pool), res: run.res, actor: me, via: '採用 AI 模擬',
      })

      // D69：工時覆寫有變的卡留學習紀錄（先改工時、後記紀錄，同 scheduleWrite；記錄失敗不擋採用，只 log）
      if (run.res.minuteEdits.length > 0) {
        const ctx = buildSimOpsContext(simWorld)
        const adj = buildMinuteAdjustments(run.res, { supplyOf: ctx.supplyOf, cards: ctx.cards, today, openWeekends: ctx.openWeekends, actor: me })
        if (!(await insertTimeAdjustments(sb, adj))) console.error('[packaging/ai/session/adopt] 工時修改紀錄寫入失敗（D69）')
      }
    }

    // 4. 採用紀錄＋op_log
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
        capacityChanges: capRecord,
      }, nowIso)
      adoptionId = adoption.id
    } catch (e) {
      console.error(`[packaging/ai/session/adopt] 採用紀錄寫入失敗 ${safeErrorTag(e)}`)
      if (capPlan && capRecord) {
        await logCapacity(sb, me, '產能表（採用 AI 模擬；採用紀錄寫入失敗）', [...capPlan.logged, { via: 'ai_adopt', adoptionId: null, record: capRecord }])
      }
      const capMsg = capRecord
        ? `；產線時數已更新 ${capRecord.cells.length} 格（原值已記在操作紀錄），無法從「AI 採用紀錄」退回產能，要改回請到產能表：${capBeforeText()}`
        : ''
      return aiFail('db_error', `已套用到正式排程，但採用紀錄寫入失敗，無法從「AI 採用紀錄」退回；如需退回請從版本 #${backup.id} 還原${capMsg}`, { partial: true, versionId: backup.id, lock }, 500)
    }
    await deleteExpiredVersions(sb, nowMs)
    // D101：產能有寫 → 'capacity'（正式工作台刷新的訊號；ops 與產能表手動儲存同格式＋這次採用的前後值）
    if (capPlan && capRecord) {
      await logCapacity(sb, me, `產能表（採用 AI 模擬 #${adoptionId}）`, [...capPlan.logged, { via: 'ai_adopt', adoptionId, record: capRecord }])
    }
    const capSummary = capRecord
      ? {
        cellsWritten: capRecord.cells.filter((c) => c.kind === 'sim').length,
        anchors: capRecord.cells.filter((c) => c.kind === 'anchor').length,
        weekendsOpened: capRecord.weekends.filter((w) => !w.beforeOpen && w.afterOpen).map((w) => w.date),
      }
      : null
    await logAi(sb, me, 'ai_adopt', `採用 AI 模擬（採用 #${adoptionId}${runId != null ? `，AI #${runId}` : ''}）`, [{
      adoptionId, sessionId: session.id, runId, versionId: backup.id,
      scope: { windowDates: session.windowDates, lineIds: scope.lineIds }, counts: run.counts, ops: run.res.applied,
      ...(capSummary ? { capacity: capSummary } : {}),
    }])

    // 5. D101（盡力而為）：清掉模擬區中「已與正式相同」的覆寫；失敗只 log（模擬值不變，只是之後組長改的正式值會被舊覆寫壓住）
    if (capPlan) {
      try {
        const after = rowsAfterPlan(capPlan, { daily: world.capacityRows, lineRows: world.lineRows }, nowIso)
        const pruned = pruneAdoptedCells({
          simCapacity: session.simCapacity, session, liveAfter: { capacityRows: after.daily, lineRows: after.lineRows },
          adoptLineIds: scope.lineIds, lines: world.lines,
        })
        if (!sameSimCapacity(pruned, session.simCapacity)) {
          // 佔用時 version 已 +1；這裡再 +1（前端採用後本來就會重新載入模擬區）
          const upd = await updateSimSessionCas(sb, session.id, version + 1, { simCapacity: pruned }, nowIso)
          if (!upd) console.error('[packaging/ai/session/adopt] 清理模擬產能覆寫時模擬區已被更新（略過）')
        }
      } catch (e) {
        console.error(`[packaging/ai/session/adopt] 清理模擬產能覆寫失敗 ${safeErrorTag(e)}`)
      }
    }
    return noStore<AdoptResponse>({ success: true, adoptionId, counts: run.counts, skipped: run.skipped, versionId: backup.id, lock, capacity: capSummary })
  } catch (e) {
    return aiServerError('session/adopt POST', e, '採用')
  }
}
