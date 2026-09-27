import type { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore, readJson, requireJson } from '@/lib/packaging/guard'
import { POOL_WRITE_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { buildSnapshot, parseSnapshot, snapshotTooLarge } from '@/lib/packaging/scheduleSnapshot'
import { MAX_OPEN_PLACEMENTS } from '@/lib/packaging/scheduleWrite'
import {
  countOpenPlacements,
  deleteExpiredVersions,
  getVersionRow,
  insertVersion,
  verifyAndTouchLock,
  writeApplied,
  type SupabaseAdmin,
} from '@/lib/packaging/scheduleDb'
import type { LockState, Placement, YMD } from '@/lib/packaging/scheduleTypes'
import { todayTaipei } from '@/lib/packaging/workdays'
import {
  claimAdoptionRevert,
  getAdoption,
  getLatestOpenAdoptionId,
  loadSimWorld,
  markAdoptionReverted,
  releaseAdoptionRevert,
} from '@/lib/packaging/ai/db'
import { isInSimScope } from '@/lib/packaging/ai/simState'
import { safeErrorTag } from '@/lib/packaging/ai/runner'
import type {
  AdoptionMeta,
  AdoptionTargetRow,
  AiAdoption,
  LockedLineConflict,
  RevertCard,
  RevertPreviewResponse,
  RevertReport,
  RevertResponse,
  SimScope,
  SimWorld,
} from '@/lib/packaging/ai/types'
import { actorOf, aiFail, aiServerError, logAi, parsePositiveId, type Actor } from '../../../_lib/aiRoute'
import { openDeltaOf, outsideScopeConflicts, planAndApply, type AdoptionRun } from '../../../_lib/adoptFlow'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// 包裝專區 P3：退回 AI 採用（規格 §6.2；D82／D86「返回上一個版本」）——範圍內版本還原
//
// 做法：重用採用的差異計算（adopt.planAdoption），把目標換成「該次採用前 auto_before_ai 快照中、落在同一範圍
//   （window_dates × line_ids）的列」→ 對正式區範圍內算差異 → 逐筆套用。範圍外、待排區、已完成、當時鎖定的線一律不動（與採用對稱）。
//   為什麼不直接重跑 inverse：applyOps 全有或全無、反向 ops 的版本號是串連的，採用後任何一張被改過就整批失敗（盤點驗證發現）；
//   inverse 仍存在 adoption 列供除錯。
// GET  → RevertPreviewResponse：預覽（不寫入、不需鎖）——會退回／移回待排池／新增幾張；採用後又被改過的卡（changedAfter）、
//        採用後才新增在範圍內的卡（addedAfter，會移回待排池）、無法還原的（unrestorable：已完成／已銷貨／不在待排池）。
// POST RevertRequest { lockToken } → RevertResponse：需正式區編輯鎖；只允許最近一筆未退回的採用；寫入前先存 auto_before_restore；
//        寫入 → reverted_at／revert_report、op_log ai_revert。
// 擋下的情況（都不寫入）：
//   - 同一筆採用被兩個請求同時退回：寫入前先佔位（db.claimAdoptionRevert，CAS＋3 分鐘時效）；沒佔到 → 409 revert_in_progress。
//     為什麼需要：原本「標記已退回」的 CAS 在寫入之後才做，只有 restore 的退回計畫（新 uuid，主鍵擋不下）會被寫兩份。
//   - 範圍外的線在採用後被改過、而且同一品項在範圍內也要還原（跨範圍搬過卡）→ 只倒回範圍內會讓卡片消失或重複（與採用的鎖定線檢查對稱）
//     → 409 locked_line_diverged＋conflicts；預覽列出來、canRevert false。這種情況請改用「版本歷史」整張還原，或先把卡搬回原線。
// 完整還原（整張排程）仍可從既有「版本歷史」做——那是最後手段，會連範圍外一起倒回。

type Ctx = { params: Promise<{ id: string }> }

const EMPTY_COUNTS = { moved: 0, added: 0, returned: 0, qtyChanged: 0, reordered: 0, minutesChanged: 0, unchanged: 0, skipped: 0 }

const toCard = (p: Placement): RevertCard => ({ placementId: p.id, soLineKey: p.soLineKey, planDate: p.planDate, lineId: p.lineId ?? null, qty: p.qty })

function metaOf(a: AiAdoption, canRevert: boolean): AdoptionMeta {
  return {
    id: a.id, sessionId: a.sessionId, runId: a.runId, versionId: a.versionId, windowDates: a.windowDates, lineIds: a.lineIds,
    counts: a.counts, skippedCount: a.skipped.length, actorEmail: a.actorEmail, actorName: a.actorName, createdAt: a.createdAt,
    revertedAt: a.revertedAt, revertedByName: a.revertedByName, canRevert,
  }
}

type RevertBase = {
  adoption: AiAdoption
  scope: SimScope
  target: AdoptionTargetRow[]
  snapIds: Set<string>
  /** 同一個窗內、採用範圍以外的線上的快照列（範圍外不一致檢查用） */
  outsideTarget: AdoptionTargetRow[]
}

const toTarget = (r: { soLineKey: string; qty: number; planDate: string; lineId: number; sortIndex?: number | null; estMinutesOverride?: number | null; source: AdoptionTargetRow['source']; id: string; originCardId?: string | null }): AdoptionTargetRow => ({
  soLineKey: r.soLineKey, qty: r.qty, planDate: r.planDate, lineId: r.lineId,
  sortIndex: r.sortIndex ?? null, estMinutesOverride: r.estMinutesOverride ?? null, source: r.source,
  // 快照保留原 id；採用時配到的列是用 move 保留 id 的 → 退回時能對回同一張卡
  pairId: r.id, originCardId: r.originCardId ?? null,
})

/** 讀採用前快照，算出退回的目標列。失敗回 NextResponse */
async function loadRevertBase(sb: SupabaseAdmin, adoption: AiAdoption): Promise<{ ok: true; base: RevertBase } | { ok: false; res: NextResponse }> {
  const row = await getVersionRow(sb, adoption.versionId)
  if (!row) {
    return { ok: false, res: aiFail('version_expired', `採用前的版本 #${adoption.versionId} 已超過保存期限被清除，無法範圍內退回；如仍需還原請改用「版本歷史」`) }
  }
  const snap = parseSnapshot(row.snapshot)
  if (!snap) return { ok: false, res: aiFail('bad_request', `採用前的版本 #${adoption.versionId} 快照格式不符，無法退回`, {}, 422) }
  const scope: SimScope = { windowDates: adoption.windowDates, lineIds: adoption.lineIds }
  const windowSet = new Set(adoption.windowDates)
  const target: AdoptionTargetRow[] = []
  const outsideTarget: AdoptionTargetRow[] = []
  for (const r of snap.placements) {
    if (r.planDate == null || r.lineId == null || !windowSet.has(r.planDate)) continue
    const row = toTarget({ ...r, planDate: r.planDate, lineId: r.lineId })
    if (isInSimScope({ planDate: r.planDate, lineId: r.lineId }, scope)) target.push(row)
    else outsideTarget.push(row)
  }
  return { ok: true, base: { adoption, scope, target, snapIds: new Set(snap.placements.map((p) => p.id)), outsideTarget } }
}

/**
 * 範圍外（同一個窗 × 採用範圍以外的線）與採用前快照的不一致中，會讓「只倒回範圍內」出錯的項目（adoptFlow.outsideScopeConflicts 規則 (1)）：
 * 採用只動了範圍內，範圍外與快照不同＝採用後在正式區被改過；只有同一品項在範圍內也要還原時才擋（跨範圍搬過卡），其餘照 D87 不動。
 */
function revertOutsideConflicts(world: SimWorld, base: RevertBase, run: AdoptionRun): LockedLineConflict[] {
  const inScope = new Set(base.scope.lineIds)
  const lineIds = [...new Set([...world.lines.map((l) => l.id), ...base.outsideTarget.map((t) => t.lineId)])].filter((id) => !inScope.has(id))
  return outsideScopeConflicts({
    world, scope: { windowDates: base.scope.windowDates, lineIds }, target: base.outsideTarget, inScopeRun: run, targetLabel: '採用前',
  })
}

const outsideConflictMessage = (n: number): string =>
  `採用範圍外的線上有 ${n} 項在採用後被改過，而且同一品項在範圍內也要還原（跨線搬過卡）；只倒回範圍內會讓卡片消失或重複。`
  + '請先在正式區把這些卡搬回原本的線，或改用「版本歷史」整張還原'

/** 採用後的變化：touched 版本不同＝採用後又被改過（會一併倒回）；範圍內、不是採用寫的、快照也沒有＝採用後才新增（會移回待排池） */
function afterAdoption(world: SimWorld, base: RevertBase): { changedAfter: RevertCard[]; addedAfter: RevertCard[] } {
  const touched = new Map(base.adoption.touched.map((t) => [t.id, t.version]))
  const changedAfter: RevertCard[] = []
  const addedAfter: RevertCard[] = []
  for (const p of world.live) {
    const v = touched.get(p.id)
    if (v != null) {
      if (v !== p.version) changedAfter.push(toCard(p))
    } else if (!p.completed && p.planDate != null && isInSimScope(p, base.scope) && !base.snapIds.has(p.id)) {
      addedAfter.push(toCard(p))
    }
  }
  return { changedAfter, addedAfter }
}

export async function GET(_request: NextRequest, ctx: Ctx) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const id = parsePositiveId((await ctx.params).id)
  if (id == null) return aiFail('bad_request', '採用紀錄編號錯誤')
  const me = actorOf(g.member)
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const today = todayTaipei(new Date(nowMs))
  try {
    const sb = getSupabaseAdminClient()
    const [adoption, latestOpenId] = await Promise.all([getAdoption(sb, id), getLatestOpenAdoptionId(sb)])
    if (!adoption) return aiFail('not_found', `找不到採用紀錄 #${id}`)
    const canRevert = adoption.revertedAt == null && latestOpenId === adoption.id
    const reason = adoption.revertedAt != null
      ? `這筆採用已在 ${adoption.revertedAt.slice(0, 16).replace('T', ' ')} 由 ${adoption.revertedByName ?? adoption.revertedBy ?? '有人'} 退回`
      : canRevert ? null : '只能退回最近一筆未退回的採用；請先退回較新的採用'
    // 已退回：不必再算差異（採用前版本也可能已過期）
    if (adoption.revertedAt != null) {
      return noStore<RevertPreviewResponse>({
        success: true, adoption: metaOf(adoption, false), counts: { ...EMPTY_COUNTS }, changedAfter: [], addedAfter: [], unrestorable: [], outsideConflicts: [], canRevert: false, reason,
      })
    }
    const loaded = await loadRevertBase(sb, adoption)
    if (!loaded.ok) return loaded.res
    const world = await loadSimWorld(sb, { today, nowIso, actor: me, poolMaxAgeMs: POOL_WRITE_MAX_AGE_MS })
    const run = planAndApply(world, loaded.base.target, loaded.base.scope)
    if (run.tooManyOps) return aiFail('too_many_ops', '範圍內要還原的卡太多，無法一次退回；請改用「版本歷史」還原')
    const { changedAfter, addedAfter } = afterAdoption(world, loaded.base)
    const outsideConflicts = revertOutsideConflicts(world, loaded.base, run)
    const blocked = canRevert && outsideConflicts.length > 0
    return noStore<RevertPreviewResponse>({
      success: true,
      adoption: metaOf(adoption, canRevert && !blocked),
      counts: run.counts,
      changedAfter,
      addedAfter,
      unrestorable: run.skipped,
      outsideConflicts,
      canRevert: canRevert && !blocked,
      reason: blocked ? outsideConflictMessage(outsideConflicts.length) : reason,
    })
  } catch (e) {
    return aiServerError('adoptions/revert GET', e, '退回預覽')
  }
}

/**
 * 佔位之後的退回本體：讀採用前快照 → 對正式區範圍內算差異 → 範圍外不一致檢查 → 存「退回前備份」→ 寫入 → 標記已退回＋op_log。
 * marked＝已標記成「已退回」（呼叫端據此決定要不要釋放佔位）。例外往外丟（呼叫端 finally 釋放佔位、catch 回 500）。
 */
async function revertClaimed(
  sb: SupabaseAdmin,
  c: { id: number; adoption: AiAdoption; me: Actor; lock: LockState; nowMs: number; nowIso: string; today: YMD },
): Promise<{ res: NextResponse; marked: boolean }> {
  const { id, adoption, me, lock, nowMs, nowIso, today } = c
  const fail = (...args: Parameters<typeof aiFail>) => ({ res: aiFail(...args), marked: false })
  const loaded = await loadRevertBase(sb, adoption)
  if (!loaded.ok) return { res: loaded.res, marked: false }
  const base = loaded.base

  const world = await loadSimWorld(sb, { today, nowIso, actor: me, poolMaxAgeMs: POOL_WRITE_MAX_AGE_MS })
  const run: AdoptionRun = planAndApply(world, base.target, base.scope)
  if (run.tooManyOps) return fail('too_many_ops', '範圍內要還原的卡太多，無法一次退回；請改用「版本歷史」還原', { lock })
  const conflicts = revertOutsideConflicts(world, base, run)
  if (conflicts.length > 0) return fail('locked_line_diverged', outsideConflictMessage(conflicts.length), { conflicts, lock })
  if (run.res.applied.length === 0 && run.plan.ops.length > 0) {
    return fail('nothing_to_adopt', `範圍內的 ${run.skipped.length} 項都無法還原（已完成、已銷貨或已不在待排池），正式排程沒有被修改`, { lock })
  }
  const delta = openDeltaOf(run.res)
  if (delta > 0 && (await countOpenPlacements(sb)) + delta > MAX_OPEN_PLACEMENTS) {
    return fail('bad_request', `未完成的卡會超過上限 ${MAX_OPEN_PLACEMENTS} 張，請先在正式區合併或移除`, { lock })
  }
  const { changedAfter, addedAfter } = afterAdoption(world, base)

  // 寫入前再存一版（讓「退回」本身也能反悔）
  const snapshot = buildSnapshot(world.live, today, nowIso)
  const big = snapshotTooLarge(snapshot)
  if (big) return fail('bad_request', big, { lock })
  const backup = await insertVersion(sb, {
    label: `退回 AI 採用 #${id} 前備份`, source: 'auto_before_restore', snapshot, actorEmail: me.email, actorName: me.name,
  })

  if (run.res.applied.length > 0) {
    const w = await writeApplied(sb, run.res, { requiresSortIndex: false })
    if (!w.ok) {
      console.error(`[packaging/ai/adoptions/revert] 寫入失敗 ${w.code}${w.partial ? ' (partial)' : ''}`)
      if (w.partial) {
        return fail(w.code, `退回寫到一半失敗，部分卡片已寫入正式區；請到「版本歷史」從版本 #${backup.id}「退回 AI 採用 #${id} 前備份」還原`, { partial: true, versionId: backup.id, lock }, 500)
      }
      return fail(w.code, `${w.message}（正式排程沒有被修改，請重新載入後再試）`, { versionId: backup.id, lock })
    }
  }

  const report: RevertReport = {
    counts: run.counts, skipped: run.skipped, backupVersionId: backup.id,
    changedAfterCount: changedAfter.length, addedAfterCount: addedAfter.length,
  }
  try {
    const ok = await markAdoptionReverted(sb, id, { actorEmail: me.email, actorName: me.name, at: nowIso, report })
    if (!ok) console.error(`[packaging/ai/adoptions/revert] #${id} 標記退回時發現已被標記（併發）`)
  } catch (e) {
    console.error(`[packaging/ai/adoptions/revert] #${id} 標記退回失敗 ${safeErrorTag(e)}`)
    return fail('db_error', `正式排程已退回，但採用紀錄沒有標記成「已退回」；再按一次退回即可補記（不會重複修改）`, { versionId: backup.id, lock }, 500)
  }
  await deleteExpiredVersions(sb, nowMs)
  await logAi(sb, me, 'ai_revert', `退回 AI 採用 #${id}`, [{
    adoptionId: id, backupVersionId: backup.id, scope: base.scope, counts: run.counts, ops: run.res.applied,
  }])
  return { res: noStore<RevertResponse>({ success: true, report, lock }), marked: true }
}

export async function POST(request: NextRequest, ctx: Ctx) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const notJson = requireJson(request)
  if (notJson) return notJson
  const id = parsePositiveId((await ctx.params).id)
  if (id == null) return aiFail('bad_request', '採用紀錄編號錯誤')
  const body = await readJson(request)
  if (!body) return aiFail('bad_request', '請求格式錯誤（須為 JSON 物件）')
  const lockToken = typeof body.lockToken === 'string' ? body.lockToken : null

  const me = actorOf(g.member)
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const today = todayTaipei(new Date(nowMs))
  try {
    const sb = getSupabaseAdminClient()
    const lk = await verifyAndTouchLock(sb, { email: me.email, token: lockToken }, nowMs)
    if (!lk.ok) {
      return aiFail(lk.code, lk.code === 'lock_lost'
        ? `編輯權已由 ${lk.lock.holderName ?? lk.lock.holderEmail ?? '其他人'} 接手，請接手後再退回`
        : '退回會修改正式排程，需要編輯權：請先取得（或接手）編輯權', { lock: lk.lock })
    }
    const lock = lk.lock

    const [adoption, latestOpenId] = await Promise.all([getAdoption(sb, id), getLatestOpenAdoptionId(sb)])
    if (!adoption) return aiFail('not_found', `找不到採用紀錄 #${id}`, { lock })
    if (adoption.revertedAt != null) return aiFail('already_reverted', '這筆採用已經退回過了', { lock })
    if (latestOpenId !== adoption.id) return aiFail('not_latest_adoption', '只能退回最近一筆未退回的採用；請先退回較新的採用', { lock })

    // 佔位（第一個寫入動作）：同一筆採用同時只有一個退回請求能往下走（見檔頭）
    const claim = await claimAdoptionRevert(sb, id, { actorEmail: me.email, nowMs })
    if (claim.status !== 'claimed') {
      if (claim.status === 'not_found') return aiFail('not_found', `找不到採用紀錄 #${id}`, { lock })
      if (claim.status === 'reverted') return aiFail('already_reverted', '這筆採用已經退回過了', { lock })
      return aiFail('revert_in_progress', '這筆採用正在被退回（另一個分頁或另一位主管剛按了退回），請稍候重新整理確認結果', { lock })
    }
    const claimedAt = claim.claimedAt
    let marked = false
    try {
      const out = await revertClaimed(sb, { id, adoption, me, lock, nowMs, nowIso, today })
      marked = out.marked
      return out.res
    } finally {
      // 沒有走到「標記已退回」（任何失敗、擋下或例外）→ 放掉佔位，之後可以再退回；標記成功後佔位已無作用
      if (!marked) await releaseAdoptionRevert(sb, id, claimedAt)
    }
  } catch (e) {
    return aiServerError('adoptions/revert POST', e, '退回採用')
  }
}
