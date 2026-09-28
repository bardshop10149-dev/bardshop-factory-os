// 包裝專區 P3 AI 模擬排程 — D101 採用／退回時的產能段（採用 route 與退回 route 共用；GET 預覽與 POST 用同一組計算）
//
// 只做「算」：要寫哪些格（capacityAdopt）→ 用正式產能表同一套驗證與寫入計畫（capacityPlan.planCapacityPut）。
// 真正的寫入由 route 在正確的時點呼叫 capacityWrite.executeCapacityPlan（採用：先產能、後排程；退回：先排程、後產能）。
// 為什麼不另寫一套產能寫入：驗證、週末安全順序、daily 相容總時數、op_log 格式必須與產能表手動儲存完全一致，
//   否則同一張產能表會有兩種寫法、兩種結果（D101 設計 §6.3）。

import { insertOpLog, type SupabaseAdmin } from '@/lib/packaging/scheduleDb'
import { planCapacityPut, type CapacityValidationCode, type CapacityWritePlan } from '@/lib/packaging/capacityPlan'
import { shortDate, weekendName, isWeekend } from '@/lib/packaging/scheduleCalendar'
import { lineNameOf } from '@/lib/packaging/scheduleLines'
import type { PackagingLine, Placement, YMD } from '@/lib/packaging/scheduleTypes'
import { normalizeSimCapacity } from '@/lib/packaging/ai/simCapacity'
import {
  capacityRollbackInputs,
  openCountByDate,
  planCapacityAdoption,
  planCapacityRevert,
  type CapacityAdoptionPlan,
  type CapacityRevertPlan,
} from '@/lib/packaging/ai/capacityAdopt'
import type { CapacityChangeRecord, SimScope, SimSession, SimWorld } from '@/lib/packaging/ai/types'
import type { Actor } from './aiRoute'

export interface CapacityPlanError {
  code: CapacityValidationCode
  status: 409 | 422
  message: string
  date: YMD
}

const hoursText = (h: { regularHours: number; overtimeHoursMax: number } | null, weekend: boolean): string => {
  if (!h) return weekend ? '沒有加班' : '沒有設定（沿用前一個平日）'
  return weekend ? `加班 ${h.overtimeHoursMax}h` : `${h.regularHours}h${h.overtimeHoursMax > 0 ? `＋加班 ${h.overtimeHoursMax}h` : ''}`
}

/** 補償失敗時列出每格原值，請主管到產能表手動改回（D101 §6.4 第 10 步） */
export function describeCapacityBefore(record: CapacityChangeRecord, lines: readonly PackagingLine[]): string {
  const cells = record.cells.map((c) => `${shortDate(c.date)} ${lineNameOf(lines, c.lineId)} 原本 ${hoursText(c.before, isWeekend(c.date))}`)
  const weekends = record.weekends.filter((w) => !w.beforeOpen && w.afterOpen).map((w) => `${shortDate(w.date)}（${weekendName(w.date)}）原本沒開加班`)
  return [...cells, ...weekends].join('；')
}

/** 產能驗證不過 → 給主管看的一句話（採用前擋下） */
export function capacityErrorText(e: CapacityPlanError): string {
  const d = shortDate(e.date)
  return `產線時數無法匯入：${e.message.startsWith(d) ? '' : `${d} `}${e.message}`
}

/**
 * 採用的產能段（GET 預覽與 POST 共用）：模擬覆寫 → 要寫的格（record）→ 正式產能表同一套驗證與寫入計畫（put）。
 * 另外先算好「補償計畫」（rollback）：之後寫排程失敗時用它把產能改回採用前（以採用前的正式列為準、關回模擬開的週末不必移卡）。
 * world＝正式（未疊加）。
 */
export function planAdoptCapacity(p: {
  world: SimWorld
  session: Pick<SimSession, 'windowDates' | 'lineIds' | 'simCapacity'>
  scope: SimScope
  lockedLineIds: readonly number[]
  actor: Actor
}): { cap: CapacityAdoptionPlan; put: CapacityWritePlan | null; rollback: CapacityWritePlan | null; error: CapacityPlanError | null } {
  const { world, session, actor } = p
  const cap = planCapacityAdoption({
    today: world.today,
    windowDates: session.windowDates,
    adoptLineIds: p.scope.lineIds,
    lockedLineIds: p.lockedLineIds,
    lines: world.lines,
    liveDaily: world.capacityRows,
    liveLineRows: world.lineRows,
    simCapacity: normalizeSimCapacity(session.simCapacity, session),
  })
  if (cap.inputs.length === 0 || !cap.record) return { cap, put: null, rollback: null, error: null }
  if (cap.blocker) {
    // 例：模擬開的週末只在鎖定線上有加班 → 採用後那天開不了加班（preview.error 已是同一句）
    return { cap, put: null, rollback: null, error: { code: 'bad_request', status: 422, message: cap.blocker.message, date: cap.blocker.date } }
  }
  const openLive = openCountByDate(world.live)
  const ctx = { today: world.today, nowIso: world.nowIso, actor, lines: world.lines, dailyAll: world.capacityRows, lineAll: world.lineRows }
  const put = planCapacityPut(cap.inputs, { ...ctx, openCardCountOn: openLive })
  if (!put.ok) {
    const error: CapacityPlanError = { code: put.code, status: put.status, message: put.message, date: put.date }
    cap.preview.error = capacityErrorText(error)
    return { cap, put: null, rollback: null, error }
  }
  const rb = planCapacityPut(capacityRollbackInputs(cap.record, world.capacityRows), { ...ctx, openCardCountOn: () => 0 })
  return { cap, put: put.plan, rollback: rb.ok ? rb.plan : null, error: null }
}

/**
 * 退回的產能段（GET 預覽與 POST 共用）：採用紀錄的 capacity_changes → 三態判斷（planCapacityRevert）→ 同一套驗證與寫入計畫。
 * nextPlacements＝排程退回「之後」的正式擺放（planAndApply 的 run.res.next）：關閉週末前要確認那天沒有卡。
 * 逐日驗證（D101 驗證修正）：planCapacityPut 一天不過就整批不寫；原本因此「一天不過 → 整份產能都不退」，排程卻照退並標記已退回，
 *   之後無法再從 UI 補退（例：組長在採用後把同一天另一條線的週末加班改 0，還原後那天會變成「開著但加總 0」）。
 *   改成：把驗證不過的那天加進 keepDays（整天保留、預覽列出原因）再算一次，直到整份通過；其他日子照退。
 *   每輪至少多保留一天、日子有限，一定會停；上限只是防呆。
 * 仍然不過（理論上不會；防競態）→ 產能這次不退、寫進報告，不擋排程退回。
 */
export function planRevertCapacity(p: {
  world: SimWorld
  record: CapacityChangeRecord | null
  nextPlacements: Iterable<Placement>
  actor: Actor
}): { rev: CapacityRevertPlan | null; put: CapacityWritePlan | null; error: string | null } {
  const { world, record, actor } = p
  if (!record) return { rev: null, put: null, error: null }
  const openAfter = openCountByDate(p.nextPlacements)
  const ctx = {
    today: world.today, nowIso: world.nowIso, actor, lines: world.lines, dailyAll: world.capacityRows, lineAll: world.lineRows, openCardCountOn: openAfter,
  }
  const keepDays = new Map<YMD, string>()
  const maxRounds = record.cells.length + record.weekends.length + 2
  let rev: CapacityRevertPlan | null = null
  let lastErr: { date: YMD; message: string } | null = null
  for (let round = 0; round < maxRounds; round++) {
    rev = planCapacityRevert({
      today: world.today, record, lines: world.lines, liveDaily: world.capacityRows, liveLineRows: world.lineRows, openCardCountAfter: openAfter,
      keepDays,
    })
    if (rev.inputs.length === 0) return { rev, put: null, error: null }
    const put = planCapacityPut(rev.inputs, ctx)
    if (put.ok) return { rev, put: put.plan, error: null }
    lastErr = { date: put.date, message: put.message }
    if (keepDays.has(put.date)) break // 已保留的日子不會再送；真的發生就是程式錯，照舊整份不退
    keepDays.set(put.date, put.message)
  }
  const plan = rev ?? planCapacityRevert({
    today: world.today, record, lines: world.lines, liveDaily: world.capacityRows, liveLineRows: world.lineRows, openCardCountAfter: openAfter,
  })
  const error = lastErr
    ? `產線時數這次沒有退回：${shortDate(lastErr.date)} ${lastErr.message}（排程照樣退回；產能請到產能表確認）`
    : '產線時數這次沒有退回（排程照樣退回；產能請到產能表確認）'
  plan.preview.error = error
  return { rev: plan, put: null, error }
}

/**
 * 產能寫入一定要記一筆 op_log kind 'capacity'：正式工作台的輪詢指紋排除 'ai_%'、產能列也不在指紋裡，
 * 只改產能、排程沒變的採用／退回若不記這筆，別人的正式工作台不會刷新（D101 設計 §1.3-3）。含失敗補償的情況。
 */
export async function logCapacity(sb: SupabaseAdmin, me: Actor, label: string, ops: unknown[]): Promise<void> {
  await insertOpLog(sb, { actorEmail: me.email, actorName: me.name, kind: 'capacity', label, ops })
}
