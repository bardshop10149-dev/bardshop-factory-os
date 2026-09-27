// 包裝專區 P1 — 每日產能（純函式，規格 §3.2；D48／D49／D51／D63 週日比照週六／D65 總時數）
// 分線輪（lines.md §3.2）：D49 沿用改為「各線各自沿用」、D71 總時數＝啟用線加總、PUT 驗證改為分線輸入。
//
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum（node --experimental-strip-types 可直接測）。

import {
  MAX_LINES,
  type CapacityInput,
  type DailyCapacity,
  type DayLoad,
  type EffectiveCapacity,
  type EffectiveLineCapacity,
  type LineCapacity,
  type PackagingLine,
  type YMD,
} from './scheduleTypes'
import { addDays, isHolidayWeekend, isValidYmd, isWeekend, weekendName } from './scheduleCalendar'
import { activeLinesOf } from './scheduleLines'
import { dayInfo, isWorkday } from './workdays'

/** PUT 可編輯的日期範圍：today − 30 ～ today + 120（規格 §3.2） */
export const CAPACITY_PAST_DAYS = 30
export const CAPACITY_FUTURE_DAYS = 120
/** 產能備註上限（畫面只是一行小字） */
export const CAPACITY_NOTE_MAX = 200

const toMinutes = (hours: number): number => Math.round(hours * 60 * 100) / 100
const isWeekdayMonFri = (d: YMD): boolean => !isWeekend(d)

/** 在「依 date 升冪」的 rows 中找最後一個 date < d 的平日列（二分搜尋＋往前掃過週末列） */
function latestWeekdayRowBefore<T extends { date: YMD }>(d: YMD, rows: readonly T[]): T | null {
  let lo = 0, hi = rows.length // 找第一個 date >= d 的位置
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].date < d) lo = mid + 1
    else hi = mid
  }
  for (let i = lo - 1; i >= 0; i--) if (isWeekdayMonFri(rows[i].date)) return rows[i]
  return null
}

function exactRow<T extends { date: YMD }>(d: YMD, rows: readonly T[]): T | null {
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
 * - 週末（六／日，D63 週日比照週六）：有列且開加班 → 只有加班欄（regular 0、overtime＝上限，explicit）；
 *   沒列、沒開、或是國定假日的週末 → 0（weekend_default）
 * - 平日當天有列 → explicit
 * - 平日當天沒列 → 沿用「日期上最近的較早平日列」三欄（inherited；規格 §3.2 解讀，待 Snow 確認 §9.3）
 * - 平日且之前從沒填過 → unset（regular null，欄頭灰色）
 */
export function resolveCapacity(date: YMD, rows: readonly DailyCapacity[]): EffectiveCapacity {
  if (isWeekend(date)) {
    const r = exactRow(date, rows)
    if (r && r.isSaturdayOpen && !isHolidayWeekend(date)) {
      return { date, kind: 'weekend', headcount: r.headcount, regularMinutes: 0, overtimeMinutes: toMinutes(r.overtimeHoursMax), source: 'explicit', inheritedFrom: null }
    }
    return { date, kind: 'weekend', headcount: r?.headcount ?? null, regularMinutes: 0, overtimeMinutes: 0, source: 'weekend_default', inheritedFrom: null }
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

// ─────────────────────────────────────────────────────────────────────
// 分線（lines.md §3.2；D49 各線各自沿用、D71 總時數＝各線加總）
// ─────────────────────────────────────────────────────────────────────

const sumMinutes = (xs: number[]): number => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100

/**
 * 一條線一天的有效產能（rows＝「這條線」的列、依 date 升冪；weekendOpen＝當天 daily 列的週末開加班旗標）：
 * - 週末、沒開加班（或國定假日的週末）→ regular 0、overtime 0、weekend_default
 * - 週末、已開加班、該線有列 → regular 0、overtime＝該列、explicit
 * - 週末、已開加班、該線沒列 → 0、weekend_default（週末不沿用，D49）
 * - 平日、該線當天有列 → explicit
 * - 平日、該線當天沒列 → 該線「日期上最近的較早平日列」→ inherited（D49 改為各線各自沿用）
 * - 平日、該線之前從沒填過 → unset（regular null、overtime 0）
 */
export function resolveLineCapacity(date: YMD, lineId: number, rows: readonly LineCapacity[], weekendOpen: boolean): EffectiveLineCapacity {
  if (isWeekend(date)) {
    const r = weekendOpen && !isHolidayWeekend(date) ? exactRow(date, rows) : null
    if (r) return { date, lineId, kind: 'weekend', regularMinutes: 0, overtimeMinutes: toMinutes(r.overtimeHoursMax), source: 'explicit', inheritedFrom: null }
    return { date, lineId, kind: 'weekend', regularMinutes: 0, overtimeMinutes: 0, source: 'weekend_default', inheritedFrom: null }
  }
  const own = exactRow(date, rows)
  if (own) return { date, lineId, kind: 'weekday', regularMinutes: toMinutes(own.regularHours), overtimeMinutes: toMinutes(own.overtimeHoursMax), source: 'explicit', inheritedFrom: null }
  const prev = latestWeekdayRowBefore(date, rows)
  if (prev) return { date, lineId, kind: 'weekday', regularMinutes: toMinutes(prev.regularHours), overtimeMinutes: toMinutes(prev.overtimeHoursMax), source: 'inherited', inheritedFrom: prev.date }
  return { date, lineId, kind: 'weekday', regularMinutes: null, overtimeMinutes: 0, source: 'unset', inheritedFrom: null }
}

/** 各線列依 lineId 分組、各組 date 升冪（同一個陣列只分組一次：工作台 30 天 × 6 線會重複呼叫） */
const groupMemo = new WeakMap<readonly LineCapacity[], Map<number, LineCapacity[]>>()
export function groupLineRows(lineRows: readonly LineCapacity[]): Map<number, LineCapacity[]> {
  const hit = groupMemo.get(lineRows)
  if (hit) return hit
  const out = new Map<number, LineCapacity[]>()
  for (const r of lineRows) {
    let arr = out.get(r.lineId)
    if (!arr) { arr = []; out.set(r.lineId, arr) }
    arr.push(r)
  }
  for (const arr of out.values()) arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  groupMemo.set(lineRows, out)
  return out
}

/** daily 列（date 升冪）中當天是否「週末開加班」（旗標一天一個、不分線，D63；國定假日的週末不算） */
export function weekendOpenOn(date: YMD, daily: readonly DailyCapacity[]): boolean {
  if (!isWeekend(date) || isHolidayWeekend(date)) return false
  return exactRow(date, daily)?.isSaturdayOpen === true
}

/**
 * 一天的有效產能（D71：總時數＝「啟用中」各線加總；停用線不計入）：
 * - regularMinutes：全部啟用線都 unset → null；否則 Σ(regular ?? 0)。週末恆 0。overtimeMinutes＝Σ。
 * - source：週末 → 開加班且 Σ加班 > 0 為 explicit，否則 weekend_default；
 *           平日 → 任一線 explicit → explicit；否則任一線 inherited → inherited（inheritedFrom＝各線中最晚的那天）；否則 unset
 * - unsetLineCount：平日中 unset 的啟用線數（畫面提示「B 線尚未設定」）
 * - lines：各啟用線的有效產能（依 sortOrder）
 * daily 必須依 date 升冪（取週末旗標與舊 headcount）；lineRows 不必排序。
 */
export function resolveDayCapacity(date: YMD, input: {
  daily: readonly DailyCapacity[]
  lineRows: readonly LineCapacity[]
  lines: readonly PackagingLine[]
}): EffectiveCapacity {
  const grouped = groupLineRows(input.lineRows)
  const open = weekendOpenOn(date, input.daily)
  const lines = activeLinesOf(input.lines).map((l) => resolveLineCapacity(date, l.id, grouped.get(l.id) ?? [], open))
  const headcount = exactRow(date, input.daily)?.headcount ?? null
  const overtimeMinutes = sumMinutes(lines.map((l) => l.overtimeMinutes))
  if (isWeekend(date)) {
    return {
      date, kind: 'weekend', headcount, regularMinutes: 0, overtimeMinutes,
      source: open && overtimeMinutes > 0 ? 'explicit' : 'weekend_default', inheritedFrom: null,
      lines, unsetLineCount: 0,
    }
  }
  const unsetLineCount = lines.filter((l) => l.source === 'unset').length
  const regularMinutes = unsetLineCount === lines.length ? null : sumMinutes(lines.map((l) => l.regularMinutes ?? 0))
  let source: EffectiveCapacity['source'] = 'unset'
  let inheritedFrom: YMD | null = null
  if (lines.some((l) => l.source === 'explicit')) source = 'explicit'
  else if (lines.some((l) => l.source === 'inherited')) {
    source = 'inherited'
    for (const l of lines) if (l.inheritedFrom && (inheritedFrom == null || l.inheritedFrom > inheritedFrom)) inheritedFrom = l.inheritedFrom
  }
  return { date, kind: 'weekday', headcount, regularMinutes, overtimeMinutes, source, inheritedFrom, lines, unsetLineCount }
}

/**
 * D51 欄頭顏色：unset 灰；≤ 正常 ok；≤ 正常＋加班 橘（over_regular）；再多 紅（over_overtime）。
 * 週末 regular＝0，所以有排卡就是橘（本來就是加班日），超過加班上限變紅。
 * 分線輪：參數放寬為只要正常／加班兩欄，整天（EffectiveCapacity）與每條線（EffectiveLineCapacity）各算一次。
 */
export function dayLoad(usedMinutes: number, cap: Pick<EffectiveCapacity, 'regularMinutes' | 'overtimeMinutes'>): DayLoad {
  if (cap.regularMinutes == null) return 'unset'
  const eps = 1e-6
  if (usedMinutes <= cap.regularMinutes + eps) return 'ok'
  if (usedMinutes <= cap.regularMinutes + cap.overtimeMinutes + eps) return 'over_regular'
  return 'over_overtime'
}

export type CapacityValidation =
  | { ok: true }
  | { ok: false; code: 'bad_request' | 'date_not_workday' | 'weekend_has_cards' | 'line_invalid'; message: string; cardCount?: number }

const hasAtMost2Decimals = (x: number): boolean => Math.abs(Math.round(x * 100) - x * 100) < 1e-6
const validHours = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 5000 && hasAtMost2Decimals(x)

/**
 * PUT /api/packaging/capacity 每列驗證（規格 §3.2）。
 * ctx.openCardCountOn(date)：該日（plan_date）還有幾張未完成的卡——關閉週末（六／日）加班前要先移卡。
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
  const weekend = isWeekend(d)
  const wkName = weekendName(d)

  // 關閉週末加班（清除、不開、或加班 0）而該日還有未完成的卡 → 擋下，請主管先移卡（否則卡片會被 D50 規則挪到下一個工作日）
  const closesWeekend = weekend && ('clear' in input
    ? input.clear === true
    : !input.isSaturdayOpen || !(input.overtimeHoursMax > 0))
  if (closesWeekend) {
    const n = ctx.openCardCountOn(d)
    if (n > 0) return { ok: false, code: 'weekend_has_cards', message: `${d} 還有 ${n} 張未完成的卡，請先移到其他日期再關閉${wkName}加班`, cardCount: n }
  }
  if ('clear' in input) {
    if (input.clear !== true) return bad('clear 只能是 true')
    return { ok: true }
  }

  // D48：平日必須是台灣工作日（國定假日不能填）；D63 起週日比照週六可填（只有加班）
  if (!weekend && !isWorkday(d)) return { ok: false, code: 'date_not_workday', message: `${d} 是國定假日，不能填產能` }
  // 規格 §3.1／§9.1 第 7 條：國定假日落在週末（例：10/10 國慶日逢週六、10/25 光復節逢週日）也不能開加班欄
  // （假日加班待 Snow 確認，§9.3 第 1 題）
  if (weekend && input.isSaturdayOpen === true && isHolidayWeekend(d)) {
    return { ok: false, code: 'date_not_workday', message: `${d} 是${dayInfo(d).reason || '國定假日'}，不能開${wkName}加班` }
  }

  // D65：畫面不再送人數；舊客戶端送了仍檢查範圍（DB 有 check）
  if (input.headcount != null && !(Number.isInteger(input.headcount) && input.headcount >= 0 && input.headcount <= 500)) {
    return bad('人數須為 0～500 的整數')
  }
  if (!validHours(input.regularHours)) return bad('正常總時數須為 0～5000 小時、最多 2 位小數')
  if (!validHours(input.overtimeHoursMax)) return bad('加班總時數須為 0～5000 小時、最多 2 位小數')
  if (typeof input.isSaturdayOpen !== 'boolean') return bad('isSaturdayOpen 須為 true / false')
  if (input.note != null && (typeof input.note !== 'string' || input.note.length > CAPACITY_NOTE_MAX)) {
    return bad(`備註最多 ${CAPACITY_NOTE_MAX} 字`)
  }

  if (weekend) {
    // D49／D63：週六、週日只有加班欄
    if (input.regularHours !== 0) return bad(`${wkName}只有加班總時數，正常總時數須為 0`)
    if (input.isSaturdayOpen && !(input.overtimeHoursMax > 0)) return bad(`開${wkName}加班時，加班總時數須大於 0`)
  } else if (input.isSaturdayOpen) {
    return bad('只有週六、週日能開加班')
  }
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────
// 分線輪 PUT 驗證（lines.md §3.2「產能輸入驗證」；取代 validateCapacityInput，舊函式保留）
// ─────────────────────────────────────────────────────────────────────

const isLineIdLike = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 32767

/**
 * PUT /api/packaging/capacity 每天的驗證（分線輪，D67／D71）。
 * ctx.lines：全部線（含停用）；ctx.existingLineRows(date)：該日既有的各線列（週末算「合併後加班加總」）；
 * ctx.openCardCountOn(date)：該日未完成卡數（關閉週末加班前要先移卡）。
 * 規則：
 * - 日期規則同 validateCapacityInput（today−30～today+120、國定假日平日不能填、國定假日週末不能開）
 * - 非 clear 必須帶 lines（產能表已改為分線填寫；舊客戶端沒帶 → bad_request）；input.regularHours／overtimeHoursMax 忽略（伺服器自己加總）
 * - lineId 不可重複；非 clear 的線須存在且啟用（否則 line_invalid）；clear 可針對任何存在的線
 * - 各線時數 0～5000、最多 2 位小數；週末各線 regularHours 必須 0
 * - 週末開加班 →「本次輸入與既有列合併後，啟用線加班加總 > 0」
 * - 關閉週末（clear、isSaturdayOpen=false、或合併後加總 0）而該日還有未完成的卡 → weekend_has_cards
 * - 單線加班降到 0 而那條線當天有卡：允許（只是那條線超載變紅），不擋
 */
export function validateCapacityDayInput(
  input: CapacityInput,
  ctx: {
    today: YMD
    lines: readonly PackagingLine[]
    openCardCountOn: (date: YMD) => number
    existingLineRows: (date: YMD) => readonly LineCapacity[]
  },
): CapacityValidation {
  const bad = (message: string): CapacityValidation => ({ ok: false, code: 'bad_request', message })
  if (!input || typeof input !== 'object' || !isValidYmd(input.date)) return bad('日期格式錯誤（須為 YYYY-MM-DD）')
  const d = input.date
  if (d < addDays(ctx.today, -CAPACITY_PAST_DAYS) || d > addDays(ctx.today, CAPACITY_FUTURE_DAYS)) {
    return bad(`只能編輯今天前 ${CAPACITY_PAST_DAYS} 天到後 ${CAPACITY_FUTURE_DAYS} 天的產能`)
  }
  const weekend = isWeekend(d)
  const wkName = weekendName(d)
  const hasCards = (): CapacityValidation | null => {
    const n = ctx.openCardCountOn(d)
    return n > 0 ? { ok: false, code: 'weekend_has_cards', message: `${d} 還有 ${n} 張未完成的卡，請先移到其他日期再關閉${wkName}加班`, cardCount: n } : null
  }

  if ('clear' in input) {
    if (input.clear !== true) return bad('clear 只能是 true')
    return (weekend && hasCards()) || { ok: true }
  }

  if (!Array.isArray(input.lines)) return bad('產能表已改為分線填寫，請重新整理頁面')
  if (input.lines.length > MAX_LINES) return bad(`一天最多 ${MAX_LINES} 條線`)
  if (typeof input.isSaturdayOpen !== 'boolean') return bad('isSaturdayOpen 須為 true / false')
  // D48：平日必須是台灣工作日；國定假日的週末不能開加班（同 validateCapacityInput）
  if (!weekend && !isWorkday(d)) return { ok: false, code: 'date_not_workday', message: `${d} 是國定假日，不能填產能` }
  if (weekend && input.isSaturdayOpen && isHolidayWeekend(d)) {
    return { ok: false, code: 'date_not_workday', message: `${d} 是${dayInfo(d).reason || '國定假日'}，不能開${wkName}加班` }
  }
  if (!weekend && input.isSaturdayOpen) return bad('只有週六、週日能開加班')
  if (input.note != null && (typeof input.note !== 'string' || input.note.length > CAPACITY_NOTE_MAX)) return bad(`備註最多 ${CAPACITY_NOTE_MAX} 字`)
  if (input.headcount != null && !(Number.isInteger(input.headcount) && input.headcount >= 0 && input.headcount <= 500)) return bad('人數須為 0～500 的整數')

  const byId = new Map(ctx.lines.map((l) => [l.id, l]))
  const seen = new Set<number>()
  // 合併後各線加班（週末判斷用）：先放既有列，再套用本次輸入
  const merged = new Map<number, number>()
  for (const r of ctx.existingLineRows(d)) merged.set(r.lineId, r.overtimeHoursMax)
  for (const raw of input.lines as unknown[]) {
    const x = raw as Record<string, unknown> | null
    if (!x || typeof x !== 'object' || !isLineIdLike(x.lineId)) return bad('lines 格式錯誤（lineId 須為正整數）')
    const id = x.lineId
    if (seen.has(id)) return bad('同一天同一條線不可重複')
    seen.add(id)
    const line = byId.get(id)
    if ('clear' in x) {
      if (x.clear !== true) return bad('lines.clear 只能是 true')
      if (!line) return { ok: false, code: 'line_invalid', message: `找不到線 #${id}` }
      merged.delete(id)
      continue
    }
    if (!line || !line.active) return { ok: false, code: 'line_invalid', message: line ? `${line.name}已停用，不能填產能` : `找不到線 #${id}` }
    if (!validHours(x.regularHours)) return bad(`${line.name}正常總時數須為 0～5000 小時、最多 2 位小數`)
    if (!validHours(x.overtimeHoursMax)) return bad(`${line.name}加班總時數須為 0～5000 小時、最多 2 位小數`)
    if (x.note != null && (typeof x.note !== 'string' || x.note.length > CAPACITY_NOTE_MAX)) return bad(`備註最多 ${CAPACITY_NOTE_MAX} 字`)
    // D49／D63：週六、週日只有加班欄
    if (weekend && x.regularHours !== 0) return bad(`${wkName}只有加班總時數，${line.name}正常總時數須為 0`)
    merged.set(id, x.overtimeHoursMax)
  }

  if (weekend) {
    let otSum = 0
    for (const [id, h] of merged) if (byId.get(id)?.active) otSum += h
    if (!input.isSaturdayOpen || !(otSum > 0)) {
      const c = hasCards()
      if (c) return c
    }
    if (input.isSaturdayOpen && !(otSum > 0)) return bad(`開${wkName}加班時，各線加班總時數合計須大於 0`)
  }
  return { ok: true }
}
