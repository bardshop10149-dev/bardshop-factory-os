// 包裝專區 P1 — 每日產能（純函式，規格 §3.2；D48／D49／D51）
//
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum（node --experimental-strip-types 可直接測）。

import type { CapacityInput, DailyCapacity, DayLoad, EffectiveCapacity, YMD } from './scheduleTypes'
import { addDays, isHolidaySaturday, isValidYmd, weekdayOf } from './scheduleCalendar'
import { dayInfo, isWorkday } from './workdays'

/** PUT 可編輯的日期範圍：today − 30 ～ today + 120（規格 §3.2） */
export const CAPACITY_PAST_DAYS = 30
export const CAPACITY_FUTURE_DAYS = 120
/** 產能備註上限（畫面只是一行小字） */
export const CAPACITY_NOTE_MAX = 200

const toMinutes = (hours: number): number => Math.round(hours * 60 * 100) / 100
const isWeekdayMonFri = (d: YMD): boolean => { const w = weekdayOf(d); return w >= 1 && w <= 5 }

/** 在「依 date 升冪」的 rows 中找最後一個 date < d 的平日列（二分搜尋＋往前掃過週六列） */
function latestWeekdayRowBefore(d: YMD, rows: readonly DailyCapacity[]): DailyCapacity | null {
  let lo = 0, hi = rows.length // 找第一個 date >= d 的位置
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].date < d) lo = mid + 1
    else hi = mid
  }
  for (let i = lo - 1; i >= 0; i--) if (isWeekdayMonFri(rows[i].date)) return rows[i]
  return null
}

function exactRow(d: YMD, rows: readonly DailyCapacity[]): DailyCapacity | null {
  let lo = 0, hi = rows.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const x = rows[mid].date
    if (x === d) return rows[mid]
    if (x < d) lo = mid + 1
    else hi = mid - 1
  }
  return null
}

/**
 * D49 有效產能（rows 必須依 date 升冪）：
 * - 週六：有列且開加班 → 只有加班欄（regular 0、overtime＝上限，explicit）；沒列、沒開、或是國定假日的週六 → 0（saturday_default）
 * - 平日當天有列 → explicit
 * - 平日當天沒列 → 沿用「日期上最近的較早平日列」三欄（inherited；規格 §3.2 解讀，待 Snow 確認 §9.3）
 * - 平日且之前從沒填過 → unset（regular null，欄頭灰色）
 */
export function resolveCapacity(date: YMD, rows: readonly DailyCapacity[]): EffectiveCapacity {
  if (weekdayOf(date) === 6) {
    const r = exactRow(date, rows)
    if (r && r.isSaturdayOpen && !isHolidaySaturday(date)) {
      return { date, kind: 'saturday', headcount: r.headcount, regularMinutes: 0, overtimeMinutes: toMinutes(r.overtimeHoursMax), source: 'explicit', inheritedFrom: null }
    }
    return { date, kind: 'saturday', headcount: r?.headcount ?? null, regularMinutes: 0, overtimeMinutes: 0, source: 'saturday_default', inheritedFrom: null }
  }
  const own = exactRow(date, rows)
  if (own) {
    return { date, kind: 'weekday', headcount: own.headcount, regularMinutes: toMinutes(own.regularHours), overtimeMinutes: toMinutes(own.overtimeHoursMax), source: 'explicit', inheritedFrom: null }
  }
  const prev = latestWeekdayRowBefore(date, rows)
  if (prev) {
    return { date, kind: 'weekday', headcount: prev.headcount, regularMinutes: toMinutes(prev.regularHours), overtimeMinutes: toMinutes(prev.overtimeHoursMax), source: 'inherited', inheritedFrom: prev.date }
  }
  return { date, kind: 'weekday', headcount: null, regularMinutes: null, overtimeMinutes: 0, source: 'unset', inheritedFrom: null }
}

export function resolveCapacityRange(dates: readonly YMD[], rows: readonly DailyCapacity[]): EffectiveCapacity[] {
  return dates.map((d) => resolveCapacity(d, rows))
}

/**
 * D51 欄頭顏色：unset 灰；≤ 正常 ok；≤ 正常＋加班 橘（over_regular）；再多 紅（over_overtime）。
 * 週六 regular＝0，所以有排卡就是橘（本來就是加班日），超過加班上限變紅。
 */
export function dayLoad(usedMinutes: number, cap: EffectiveCapacity): DayLoad {
  if (cap.regularMinutes == null) return 'unset'
  const eps = 1e-6
  if (usedMinutes <= cap.regularMinutes + eps) return 'ok'
  if (usedMinutes <= cap.regularMinutes + cap.overtimeMinutes + eps) return 'over_regular'
  return 'over_overtime'
}

export type CapacityValidation =
  | { ok: true }
  | { ok: false; code: 'bad_request' | 'date_not_workday' | 'saturday_has_cards'; message: string; cardCount?: number }

const hasAtMost2Decimals = (x: number): boolean => Math.abs(Math.round(x * 100) - x * 100) < 1e-6
const validHours = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 5000 && hasAtMost2Decimals(x)

/**
 * PUT /api/packaging/capacity 每列驗證（規格 §3.2）。
 * ctx.openCardCountOn(date)：該日（plan_date）還有幾張未完成的卡——關閉週六加班前要先移卡。
 */
export function validateCapacityInput(
  input: CapacityInput,
  ctx: { today: YMD; openCardCountOn: (date: YMD) => number },
): CapacityValidation {
  const bad = (message: string): CapacityValidation => ({ ok: false, code: 'bad_request', message })
  if (!input || typeof input !== 'object' || !isValidYmd(input.date)) return bad('日期格式錯誤（須為 YYYY-MM-DD）')
  const d = input.date
  if (d < addDays(ctx.today, -CAPACITY_PAST_DAYS) || d > addDays(ctx.today, CAPACITY_FUTURE_DAYS)) {
    return bad(`只能編輯今天前 ${CAPACITY_PAST_DAYS} 天到後 ${CAPACITY_FUTURE_DAYS} 天的產能`)
  }
  const wd = weekdayOf(d)
  const isSat = wd === 6

  // 關閉週六加班（清除、不開、或加班 0）而該日還有未完成的卡 → 擋下，請主管先移卡（否則卡片會被 D50 規則挪到下一個工作日）
  const closesSaturday = isSat && ('clear' in input
    ? input.clear === true
    : !input.isSaturdayOpen || !(input.overtimeHoursMax > 0))
  if (closesSaturday) {
    const n = ctx.openCardCountOn(d)
    if (n > 0) return { ok: false, code: 'saturday_has_cards', message: `${d} 還有 ${n} 張未完成的卡，請先移到其他日期再關閉週六加班`, cardCount: n }
  }
  if ('clear' in input) {
    if (input.clear !== true) return bad('clear 只能是 true')
    return { ok: true }
  }

  // D48：週日不收；平日必須是台灣工作日（國定假日不能填）
  if (wd === 0) return { ok: false, code: 'date_not_workday', message: `${d} 是週日，不能填產能` }
  if (!isSat && !isWorkday(d)) return { ok: false, code: 'date_not_workday', message: `${d} 是國定假日，不能填產能` }
  // 規格 §3.1／§9.1 第 7 條：國定假日落在週六（例：10/10 國慶日）也不能開加班欄（假日加班待 Snow 確認，§9.3 第 1 題）
  if (isSat && input.isSaturdayOpen === true && isHolidaySaturday(d)) {
    return { ok: false, code: 'date_not_workday', message: `${d} 是${dayInfo(d).reason || '國定假日'}，不能開週六加班` }
  }

  if (input.headcount != null && !(Number.isInteger(input.headcount) && input.headcount >= 0 && input.headcount <= 500)) {
    return bad('人數須為 0～500 的整數')
  }
  if (!validHours(input.regularHours)) return bad('正常工時須為 0～5000 小時、最多 2 位小數')
  if (!validHours(input.overtimeHoursMax)) return bad('加班工時上限須為 0～5000 小時、最多 2 位小數')
  if (typeof input.isSaturdayOpen !== 'boolean') return bad('isSaturdayOpen 須為 true / false')
  if (input.note != null && (typeof input.note !== 'string' || input.note.length > CAPACITY_NOTE_MAX)) {
    return bad(`備註最多 ${CAPACITY_NOTE_MAX} 字`)
  }

  if (isSat) {
    // D49：週六只有加班欄
    if (input.regularHours !== 0) return bad('週六只有加班工時，正常工時須為 0')
    if (input.isSaturdayOpen && !(input.overtimeHoursMax > 0)) return bad('開週六加班時，加班工時上限須大於 0')
  } else if (input.isSaturdayOpen) {
    return bad('只有週六能開加班欄')
  }
  return { ok: true }
}
