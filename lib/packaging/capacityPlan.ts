// 包裝專區 — 產能寫入計畫（純函式；D101 自 PUT /api/packaging/capacity 抽出，行為與抽出前逐字相同）
//
// 為什麼抽出來：D101 的「採用 AI 模擬」與「退回採用」也要寫正式產能表。如果另寫一套，就會長出第二套產能規則
//   （驗證、週末安全寫入順序、daily 相容總時數、op_log 格式）——哪天改了一邊忘了另一邊，兩條路寫出來的資料就不一樣。
//   所以把 PUT 的第 1～3 步（逐日驗證 → 在記憶體算寫入後的列與總時數 → 決定寫入順序）搬到這裡，
//   PUT、採用、退回三個呼叫端共用同一個函式；真正的寫入在 capacityWrite.executeCapacityPlan（I/O）。
// 回歸保證：抽出前後對同一組輸入的輸出逐欄相同（scratchpad d101-d102/tests/capacityPlan.test.mjs 以抽出前的程式當參照做隨機比對）。
//
// 不 import supabase、不讀時鐘（today／nowIso 由呼叫端傳入）；相對路徑 import、不用 enum（node --experimental-strip-types 可直接測）。

import type {
  CapacityInput,
  DailyCapacity,
  DailyCapacityRow,
  LineCapacity,
  LineCapacityRow,
  PackagingLine,
  YMD,
} from './scheduleTypes'
import { isWeekend } from './scheduleCalendar'
import { resolveDayCapacity, validateCapacityDayInput, type CapacityValidation } from './scheduleCapacity'

/** packaging_daily_capacity 的 regular_hours／overtime_hours_max check 上限（sql/20260927_packaging_schedule.sql） */
export const DAILY_TOTAL_HOURS_MAX = 5000

export type LineUpsert = Omit<LineCapacityRow, 'updated_at'>
export type DailyUpsert = Omit<DailyCapacityRow, 'updated_at'>

/** 產能驗證不過的錯誤碼（validateCapacityDayInput 的碼） */
export type CapacityValidationCode = Extract<CapacityValidation, { ok: false }>['code']

/**
 * 一次產能寫入要做的事（依這個順序執行，見 capacityWrite.executeCapacityPlan）：
 *   a. closesFirst：關閉週末的 daily（旗標 false）先寫；clearDates 的 daily 先刪
 *   b. 各線列（upsert、delete；clearDates 的整天線列）
 *   c. rest：其餘 daily（含開週末：線列已在，最後才打開旗標）
 * 沒有交易：任何中途失敗都偏向「週末沒開」，不會出現沒有產能卻開著的週末。
 */
export interface CapacityWritePlan {
  closesFirst: DailyUpsert[]
  clearDates: YMD[]
  lineUpserts: LineUpsert[]
  lineDeletes: { date: YMD; lineId: number }[]
  rest: DailyUpsert[]
  /** op_log kind 'capacity' 的內容（只記正規化後的欄位，不寫原始 body；與抽出前的 PUT 記的完全一樣） */
  logged: unknown[]
}

export type CapacityPlanResult =
  | { ok: true; plan: CapacityWritePlan }
  | { ok: false; status: 409 | 422; code: CapacityValidationCode; message: string; date: YMD; cardCount?: number }

const byDate = <T extends { date: YMD }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
const toHours = (min: number | null): number => (min == null ? 0 : Math.round((min / 60) * 100) / 100)

/**
 * PUT /api/packaging/capacity 的第 1～3 步（rows 的外形——陣列、1～60 筆、日期合法且不重複——由呼叫端先檢查）。
 * ctx.dailyAll／lineAll：要涵蓋 rows 最早日期往前 400 天到最晚日期（沿用與總時數要看較早的平日列）；
 * ctx.openCardCountOn(date)：該日未完成卡數（關閉週末加班前要先移卡）。
 */
export function planCapacityPut(
  rows: readonly CapacityInput[],
  ctx: {
    today: YMD
    nowIso: string
    actor: { email: string; name: string | null }
    lines: readonly PackagingLine[]
    dailyAll: readonly DailyCapacity[]
    lineAll: readonly LineCapacity[]
    openCardCountOn: (date: YMD) => number
  },
): CapacityPlanResult {
  const { today, nowIso, actor, lines, dailyAll, lineAll } = ctx
  const lineRowsOn = (d: YMD) => lineAll.filter((r) => r.date === d)

  // 1. 逐日驗證（任何一天不過 → 整批不寫）
  for (const r of rows) {
    const v = validateCapacityDayInput(r, { today, lines, openCardCountOn: ctx.openCardCountOn, existingLineRows: lineRowsOn })
    if (!v.ok) {
      const status = v.code === 'weekend_has_cards' ? 409 : 422
      return { ok: false, status, code: v.code, message: v.message, date: r.date, ...(v.cardCount != null ? { cardCount: v.cardCount } : {}) }
    }
  }

  // 2. 以「寫入後」的資料在記憶體算好每天的總時數（D71：啟用線有效值加總，含沿用值），再決定寫入順序
  const lineUpserts: LineUpsert[] = []
  const lineDeletes: { date: YMD; lineId: number }[] = []
  const clearDates: YMD[] = []
  const after = new Map<string, LineCapacity>()
  for (const r of lineAll) after.set(`${r.date}|${r.lineId}`, r)
  const dailyAfter = new Map<YMD, DailyCapacity>(dailyAll.map((d) => [d.date, d]))
  for (const r of rows) {
    if ('clear' in r) {
      clearDates.push(r.date)
      for (const k of [...after.keys()]) if (k.startsWith(`${r.date}|`)) after.delete(k)
      dailyAfter.delete(r.date)
      continue
    }
    for (const x of r.lines ?? []) {
      if ('clear' in x) {
        lineDeletes.push({ date: r.date, lineId: x.lineId })
        after.delete(`${r.date}|${x.lineId}`)
        continue
      }
      const note = typeof x.note === 'string' ? x.note.trim() || null : null
      lineUpserts.push({
        date: r.date, line_id: x.lineId, regular_hours: x.regularHours, overtime_hours_max: x.overtimeHoursMax,
        note, updated_by: actor.email, updated_by_name: actor.name,
      })
      after.set(`${r.date}|${x.lineId}`, {
        date: r.date, lineId: x.lineId, regularHours: x.regularHours, overtimeHoursMax: x.overtimeHoursMax,
        note, updatedBy: actor.email, updatedByName: actor.name, updatedAt: nowIso,
      })
    }
    // 週末旗標與備註先放進 daily（總時數下面再填）
    dailyAfter.set(r.date, {
      date: r.date, headcount: null, regularHours: 0, overtimeHoursMax: 0, isSaturdayOpen: isWeekend(r.date) && r.isSaturdayOpen,
      note: r.note?.trim() || null, updatedBy: actor.email, updatedByName: actor.name, updatedAt: nowIso,
    })
  }
  const lineRowsAfter = [...after.values()]
  const dailySorted = [...dailyAfter.values()].sort(byDate)
  const dailyUpserts: DailyUpsert[] = []
  for (const r of rows) {
    if ('clear' in r) continue
    const eff = resolveDayCapacity(r.date, { daily: dailySorted, lineRows: lineRowsAfter, lines })
    // 各線各自 ≤ 5000 已在第 1 步驗過，但加總（含沿用值）寫回 daily 相容欄時也受 daily 表的 ≤ 5000 check 約束；
    // 在任何寫入之前擋下，避免「各線已寫、daily 失敗」的半套狀態（本 API 沒有交易）
    if (toHours(eff.regularMinutes) > DAILY_TOTAL_HOURS_MAX || toHours(eff.overtimeMinutes) > DAILY_TOTAL_HOURS_MAX) {
      return { ok: false, status: 422, code: 'bad_request', message: `${r.date} 各線合計不可超過 ${DAILY_TOTAL_HOURS_MAX} 小時（正常、加班分開計）`, date: r.date }
    }
    const d = dailyAfter.get(r.date)!
    dailyUpserts.push({
      date: r.date,
      headcount: null, // D65：不再使用（欄位保留）
      regular_hours: isWeekend(r.date) ? 0 : toHours(eff.regularMinutes),
      overtime_hours_max: toHours(eff.overtimeMinutes),
      is_saturday_open: d.isSaturdayOpen,
      note: d.note,
      updated_by: actor.email,
      updated_by_name: actor.name,
    })
  }

  // 3. 寫入順序（無交易，偏向「週末沒開」）
  const closesFirst = dailyUpserts.filter((u) => isWeekend(u.date) && !u.is_saturday_open)
  const rest = dailyUpserts.filter((u) => !(isWeekend(u.date) && !u.is_saturday_open))

  // op_log 只記正規化後的欄位（不寫原始 body：客戶端夾帶的多餘鍵或大字串會永久留在正式站）
  const logged = [
    ...dailyUpserts.map((u) => ({
      date: u.date, regularHours: u.regular_hours, overtimeHoursMax: u.overtime_hours_max, isSaturdayOpen: u.is_saturday_open, note: u.note,
      lines: [
        ...lineUpserts.filter((l) => l.date === u.date).map((l) => ({ lineId: l.line_id, regularHours: l.regular_hours, overtimeHoursMax: l.overtime_hours_max })),
        ...lineDeletes.filter((l) => l.date === u.date).map((l) => ({ lineId: l.lineId, clear: true as const })),
      ],
    })),
    ...clearDates.map((d) => ({ date: d, clear: true as const })),
  ]
  return { ok: true, plan: { closesFirst, clearDates, lineUpserts, lineDeletes, rest, logged } }
}

/**
 * 計畫寫完之後的產能列（純記憶體；D101 採用後清掉「已與正式相同」的模擬覆寫、退回預覽等用）。
 * 與 executeCapacityPlan 的效果相同：clearDates 刪整天 daily＋線列、線列 upsert／delete、daily upsert（旗標、備註、相容總時數）。
 * updated_* 欄以 nowIso／計畫上的值填（只影響顯示，不影響有效產能）。
 */
export function rowsAfterPlan(
  plan: CapacityWritePlan,
  rows: { daily: readonly DailyCapacity[]; lineRows: readonly LineCapacity[] },
  nowIso: string,
): { daily: DailyCapacity[]; lineRows: LineCapacity[] } {
  const clear = new Set(plan.clearDates)
  const daily = new Map<YMD, DailyCapacity>()
  for (const d of rows.daily) if (!clear.has(d.date)) daily.set(d.date, d)
  for (const u of [...plan.closesFirst, ...plan.rest]) {
    daily.set(u.date, {
      date: u.date, headcount: u.headcount, regularHours: u.regular_hours, overtimeHoursMax: u.overtime_hours_max,
      isSaturdayOpen: u.is_saturday_open, note: u.note, updatedBy: u.updated_by, updatedByName: u.updated_by_name, updatedAt: nowIso,
    })
  }
  const lines = new Map<string, LineCapacity>()
  for (const r of rows.lineRows) if (!clear.has(r.date)) lines.set(`${r.date}|${r.lineId}`, r)
  for (const u of plan.lineUpserts) {
    lines.set(`${u.date}|${u.line_id}`, {
      date: u.date, lineId: u.line_id, regularHours: u.regular_hours, overtimeHoursMax: u.overtime_hours_max,
      note: u.note, updatedBy: u.updated_by, updatedByName: u.updated_by_name, updatedAt: nowIso,
    })
  }
  for (const x of plan.lineDeletes) lines.delete(`${x.date}|${x.lineId}`)
  const byDateLine = (a: LineCapacity, b: LineCapacity) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.lineId - b.lineId)
  return { daily: [...daily.values()].sort(byDate), lineRows: [...lines.values()].sort(byDateLine) }
}
