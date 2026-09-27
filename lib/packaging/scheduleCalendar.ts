// 包裝專區 P1 — 工作台行事曆（純函式，規格 §3.1；D48／D50／D51）
//
// 不 import supabase、不讀時鐘：today 一律由呼叫端傳入，前後端共用（前端用同一套做樂觀更新）。
// 檔內只用相對路徑 import、不用 enum，才能用 node --experimental-strip-types 跑單元測試。
//
// 「工作台日期」＝台灣行政日曆工作日（週一～五扣國定假日，與交期計算同一份 workdays.ts）
//              ＋主管已開加班的週六（D48 週六＝加班日；D51 週六僅在開加班時出現）。
// 週日與國定假日不會出現（D48 沒定義假日加班，規格 §9.3 待問）——包含「國定假日剛好落在週六」（例：2026-10-10 國慶日）。

import type { DailyCapacity, Placement, YMD } from './scheduleTypes'
import { dayInfo, isWorkday, workdaysBetween } from './workdays'

const DAY_MS = 86_400_000
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/
/** boardWindow 最多往後走幾個日曆天（30 個工作日＋春節連假也遠低於此） */
const WINDOW_SAFETY_DAYS = 90
/** rollTarget／nextBoardDay 最多往後找幾天（最長連假約 10 天） */
const NEXT_SAFETY_DAYS = 60
const WEEKDAY_ZH = ['日', '一', '二', '三', '四', '五', '六']

// ── 日期小工具（UTC 日序號，與伺服器時區無關，同 workdays.ts 慣例）──

/** 是否為真實存在的 'YYYY-MM-DD'（擋掉 2026-02-30） */
export function isValidYmd(d: unknown): d is YMD {
  if (typeof d !== 'string') return false
  const m = d.match(YMD_RE)
  if (!m) return false
  const y = +m[1], mo = +m[2], da = +m[3]
  const back = new Date(Date.UTC(y, mo - 1, da))
  return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === da
}

function toNum(d: YMD): number {
  if (!isValidYmd(d)) throw new TypeError(`[scheduleCalendar] 日期須為 YYYY-MM-DD，收到：${String(d)}`)
  return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY_MS
}

function fromNum(n: number): YMD {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}

/** 日曆天加減（跨月、跨年皆可） */
export function addDays(d: YMD, n: number): YMD {
  return fromNum(toNum(d) + n)
}

/** 0＝週日 … 6＝週六 */
export function weekdayOf(d: YMD): number {
  return new Date(toNum(d) * DAY_MS).getUTCDay()
}

/** '9/29（二）' */
export function dayLabel(d: YMD): string {
  return `${+d.slice(5, 7)}/${+d.slice(8, 10)}（${WEEKDAY_ZH[weekdayOf(d)]}）`
}

/** '9/29' */
export function shortDate(d: YMD): string {
  return `${+d.slice(5, 7)}/${+d.slice(8, 10)}`
}

// ── 規格 §3.1 ──

/**
 * 週六且是國定假日／補假／公司放假（dayInfo 的原因不是單純「週末」）。
 * 規格 §3.1、§9.1 第 7 條：國定假日不能開加班欄 → 這種週六不收產能、也不會出現在工作台。
 * （補行上班的週六 isWorkday＝true，本來就是工作日，不受影響。）
 */
export function isHolidaySaturday(d: YMD): boolean {
  if (weekdayOf(d) !== 6 || isWorkday(d)) return false
  return dayInfo(d).reason !== '週末'
}

/**
 * D48／D49：已開加班的週六＝is_saturday_open 且加班上限 > 0，且不是國定假日（isHolidaySaturday）。
 * （加班 0 小時的「開加班」沒有意義，當作沒開；API 端 validateCapacityInput 也會擋。）
 */
export function openSaturdaysOf(rows: readonly DailyCapacity[]): Set<YMD> {
  const out = new Set<YMD>()
  for (const r of rows) {
    if (r.isSaturdayOpen && r.overtimeHoursMax > 0 && isValidYmd(r.date) && weekdayOf(r.date) === 6 && !isHolidaySaturday(r.date)) out.add(r.date)
  }
  return out
}

/** 工作台日期＝台灣工作日，或已開加班的週六（D48） */
export function isBoardDay(d: YMD, openSats: ReadonlySet<YMD>): boolean {
  return isWorkday(d) || openSats.has(d)
}

/**
 * D51：從 from 起湊滿 workdays 個台灣工作日；開加班的週六插入但不佔名額。
 * 例：from＝2026-09-24（四）、3 天、無加班 → [09-24, 09-29, 09-30]（9/25 中秋、9/28 教師節）。
 */
export function boardWindow(from: YMD, workdays: number, openSats: ReadonlySet<YMD>): YMD[] {
  const out: YMD[] = []
  let n = 0
  let cur = toNum(from)
  const stop = cur + WINDOW_SAFETY_DAYS
  while (n < workdays && cur <= stop) {
    const d = fromNum(cur)
    if (isWorkday(d)) { out.push(d); n++ }
    else if (openSats.has(d)) out.push(d)
    cur++
  }
  return out
}

/** 第一個 > d 的工作台日期 */
export function nextBoardDay(d: YMD, openSats: ReadonlySet<YMD>): YMD {
  let cur = toNum(d) + 1
  for (let i = 0; i < NEXT_SAFETY_DAYS; i++, cur++) {
    const x = fromNum(cur)
    if (isBoardDay(x, openSats)) return x
  }
  return fromNum(cur) // 不會發生（60 天內一定有工作日）；保底回傳
}

/** D50 順延目標：第一個 ≥ today 的工作台日期（今天是週末／假日時＝下一個工作台日期） */
export function rollTarget(today: YMD, openSats: ReadonlySet<YMD>): YMD {
  return isBoardDay(today, openSats) ? today : nextBoardDay(today, openSats)
}

/**
 * D50 核心：一張擺放「實際顯示在哪一欄」。只讀取時推導，不寫回 DB（GET 不寫入，唯讀者也在呼叫）。
 * 1. 已完成 → plan_date 原樣（完成是事實，不順延）
 * 2. plan_date = null → null（待排區，D21）
 * 3. plan_date < today → rollTarget(today)，rolled（延誤）
 * 4. plan_date 不是工作台日期（週六取消加班、行事曆更新）→ 下一個工作台日期，offBoard
 * 5. 其餘 → plan_date
 */
export function displayDateOf(
  p: Pick<Placement, 'planDate' | 'completed'>,
  today: YMD,
  openSats: ReadonlySet<YMD>,
): { date: YMD | null; rolled: boolean; offBoard: boolean } {
  if (p.completed) return { date: p.planDate, rolled: false, offBoard: false }
  if (p.planDate == null) return { date: null, rolled: false, offBoard: false }
  if (p.planDate < today) return { date: rollTarget(today, openSats), rolled: true, offBoard: false }
  if (!isBoardDay(p.planDate, openSats)) return { date: nextBoardDay(p.planDate, openSats), rolled: false, offBoard: true }
  return { date: p.planDate, rolled: false, offBoard: false }
}

/**
 * D50「延誤 N 天」（台灣工作日、累計）：max(1, workdaysBetween(planDate, today))。
 * 只在 planDate < today 時呼叫。例：排 9/24（四）、今天 9/29（二）→ 1；排週六加班 10/3、今天週日 → 0 → 取 1。
 */
export function delayWorkdays(planDate: YMD, today: YMD): number {
  return Math.max(1, workdaysBetween(planDate, today))
}
