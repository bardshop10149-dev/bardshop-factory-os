/**
 * 台灣工作日工具（包裝排程 D9 / D11 / D13 / D20 共用）
 *
 * ── 日曆資料 ──────────────────────────────────────────────────────────
 * 來源：行政院人事行政總處「中華民國政府行政機關辦公日曆表」115 年（2026）、116 年（2027）。
 *   實際取自 TaiwanCalendar（github.com/ruyut/TaiwanCalendar，依人事總處公告整理，
 *   與 argo-tool backend/tw_calendar.py 同一資料源），2026-09-27 抓取後逐日比對、寫死在下方常數。
 *   這裡刻意「不做執行期網路請求」：API route、瀏覽器、Node 腳本都能直接 import，
 *   也不會因為 CDN 連不上而默默算錯。
 *
 * ── 涵蓋範圍 ──────────────────────────────────────────────────────────
 * CALENDAR_COVERAGE：2026-01-01 ~ 2027-12-31。
 * 超出範圍的日期 → 退回「週一 ~ 週五上班」（國定假日會被當成上班日），
 *   並且：dayInfo(d).source === 'fallback'、isCovered(d) === false、
 *   console.warn 一次（同一年只警告一次，避免洗版）。
 * 每年 6~7 月人事總處公告次年日曆後，要把次年資料補進 TW_HOLIDAYS / TW_MAKEUP_WORKDAYS，
 *   並延長 CALENDAR_COVERAGE.to。
 *
 * ── 不含 ─────────────────────────────────────────────────────────────
 * 颱風假等臨時停班（各縣市臨時公告，無法預知）。
 * 包裝部自己的例外日（盤點日、週六加班…）請用 createWorkdayCalendar({ extraHolidays, extraWorkdays }) 疊加。
 *
 * ── 日期慣例 ─────────────────────────────────────────────────────────
 * 一律 'YYYY-MM-DD' 字串，代表「台北當地的日曆日」。內部換成 UTC 日序號計算，
 * 與伺服器時區（Vercel = UTC、本機 = UTC+8）無關；格式錯誤或不存在的日期（如 2026-02-30）直接丟錯。
 */

export const CALENDAR_COVERAGE = { from: '2026-01-01', to: '2027-12-31' } as const

/**
 * 國定假日與補假（含落在週末的節日，方便 dayInfo 顯示原因）。
 * 判斷規則：出現在這裡 → 放假；週末本來就放假，列進來只是為了標名稱。
 */
const TW_HOLIDAYS: Readonly<Record<string, string>> = {
  // ── 115 年（2026）──
  '2026-01-01': '開國紀念日',
  '2026-02-15': '小年夜',
  '2026-02-16': '農曆除夕',
  '2026-02-17': '春節',
  '2026-02-18': '春節',
  '2026-02-19': '春節',
  '2026-02-20': '補假（小年夜逢週日）',
  '2026-02-27': '補假（和平紀念日逢週六）',
  '2026-02-28': '和平紀念日',
  '2026-04-03': '補假（兒童節逢週六）',
  '2026-04-04': '兒童節',
  '2026-04-05': '清明節',
  '2026-04-06': '補假（清明節逢週日）',
  '2026-05-01': '勞動節',
  '2026-06-19': '端午節',
  '2026-09-25': '中秋節',
  '2026-09-28': '孔子誕辰紀念日/教師節',
  '2026-10-09': '補假（國慶日逢週六）',
  '2026-10-10': '國慶日',
  '2026-10-25': '臺灣光復暨金門古寧頭大捷紀念日',
  '2026-10-26': '補假（光復節逢週日）',
  '2026-12-25': '行憲紀念日',
  // ── 116 年（2027）──
  '2027-01-01': '開國紀念日',
  '2027-02-04': '小年夜',
  '2027-02-05': '農曆除夕',
  '2027-02-06': '春節',
  '2027-02-07': '春節',
  '2027-02-08': '春節',
  '2027-02-09': '補假（春節逢週末）',
  '2027-02-10': '補假（春節逢週末）',
  '2027-02-28': '和平紀念日',
  '2027-03-01': '補假（和平紀念日逢週日）',
  '2027-04-04': '兒童節',
  '2027-04-05': '清明節',
  '2027-04-06': '補假（兒童節逢週日）',
  '2027-04-30': '補假（勞動節逢週六）',
  '2027-05-01': '勞動節',
  '2027-06-09': '端午節',
  '2027-09-15': '中秋節',
  '2027-09-28': '孔子誕辰紀念日/教師節',
  '2027-10-10': '國慶日',
  '2027-10-11': '補假（國慶日逢週日）',
  '2027-10-25': '臺灣光復暨金門古寧頭大捷紀念日',
  '2027-12-24': '補假（行憲紀念日逢週六）',
  '2027-12-25': '行憲紀念日',
  '2027-12-31': '補假（117 年開國紀念日逢週六）',
}

/**
 * 補行上班日（落在週六日、但要上班的日子）。
 * 115、116 年日曆都沒有補行上班日（上一次是 114 年的 2025-02-08）。
 * 之後年度若有，照 'YYYY-MM-DD': '補行上班' 加進來即可。
 */
const TW_MAKEUP_WORKDAYS: Readonly<Record<string, string>> = {}

// ────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000
const TAIPEI_OFFSET_MS = 8 * 3600 * 1000 // 台灣 1979 年後無日光節約時間，固定 UTC+8
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MAX_STEP = 3650 // addWorkdays 的 |n| 上限（約 14 年），防呆用

/** 'YYYY-MM-DD' → UTC 日序號（1970-01-01 = 0）；格式錯或不存在的日期直接丟錯 */
function toDayNum(d: string): number {
  const m = typeof d === 'string' ? d.match(YMD_RE) : null
  if (m) {
    const y = +m[1], mo = +m[2], da = +m[3]
    const ms = Date.UTC(y, mo - 1, da)
    const back = new Date(ms)
    // 反查一次：擋掉 2026-02-30 這種會被 Date 自動進位的日期
    if (back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === da) {
      return ms / DAY_MS
    }
  }
  throw new TypeError(`[workdays] 日期須為 YYYY-MM-DD 且為真實日期，收到：${String(d)}`)
}

function fromDayNum(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10)
}

function isWeekendNum(n: number): boolean {
  const dow = new Date(n * DAY_MS).getUTCDay()
  return dow === 0 || dow === 6
}

function toDayMap(rec: Readonly<Record<string, string>> | undefined): Map<number, string> {
  const out = new Map<number, string>()
  if (rec) for (const [k, v] of Object.entries(rec)) out.set(toDayNum(k), v)
  return out
}

const COVER_FROM = toDayNum(CALENDAR_COVERAGE.from)
const COVER_TO = toDayNum(CALENDAR_COVERAGE.to)
const HOLIDAY_MAP = toDayMap(TW_HOLIDAYS)
const MAKEUP_MAP = toDayMap(TW_MAKEUP_WORKDAYS)

function isCoveredNum(n: number): boolean {
  return n >= COVER_FROM && n <= COVER_TO
}

// 同一年只警告一次（整個 process / 分頁共用）
const warnedYears = new Set<string>()
function warnFallback(n: number): void {
  const date = fromDayNum(n)
  const year = date.slice(0, 4)
  if (warnedYears.has(year)) return
  warnedYears.add(year)
  console.warn(
    `[workdays] ${date} 超出台灣辦公日曆涵蓋範圍 ${CALENDAR_COVERAGE.from} ~ ${CALENDAR_COVERAGE.to}，` +
    `${year} 年暫以「週一~週五」判斷工作日（國定假日會被當成上班）。請補上該年人事總處辦公日曆。`,
  )
}

// ────────────────────────────────────────────────────────────────────

export type DayInfo = {
  date: string
  isWorkday: boolean
  /**
   * calendar = 查台灣辦公日曆；company = 命中公司例外日；
   * fallback = 超出日曆涵蓋範圍，只看週一~五（結果可能不準）
   */
  source: 'calendar' | 'company' | 'fallback'
  /** 原因：節日/補假名稱、'週末'、'補行上班'、公司例外日說明；一般平日為 '' */
  reason: string
}

export type WorkdayCalendarOptions = {
  /** 公司額外放假日，例：{ '2026-11-02': '包裝部盤點' } */
  extraHolidays?: Readonly<Record<string, string>>
  /** 公司額外上班日（優先於國定假日與週末），例：{ '2026-10-17': '包裝部週六加班' } */
  extraWorkdays?: Readonly<Record<string, string>>
}

export type WorkdayCalendar = {
  isWorkday(d: string): boolean
  dayInfo(d: string): DayInfo
  addWorkdays(d: string, n: number): string
  workdaysBetween(from: string, to: string): number
}

/**
 * 建立一份工作日曆。預設（不帶參數）= 純台灣行政機關辦公日曆；
 * 之後包裝部若有自己的例外日（需求紀錄待議：包裝部週六常態上班？），在這裡疊加即可。
 */
export function createWorkdayCalendar(opts: WorkdayCalendarOptions = {}): WorkdayCalendar {
  const extraOff = toDayMap(opts.extraHolidays)
  const extraOn = toDayMap(opts.extraWorkdays)

  function infoNum(n: number): Omit<DayInfo, 'date'> {
    // 優先序：公司上班 > 公司放假 > 台灣補班 > 台灣假日 > 週末 > 一般平日
    const on = extraOn.get(n)
    if (on !== undefined) return { isWorkday: true, source: 'company', reason: on }
    const off = extraOff.get(n)
    if (off !== undefined) return { isWorkday: false, source: 'company', reason: off }

    const weekend = isWeekendNum(n)
    if (!isCoveredNum(n)) {
      warnFallback(n)
      return { isWorkday: !weekend, source: 'fallback', reason: weekend ? '週末' : '' }
    }
    const makeup = MAKEUP_MAP.get(n)
    if (makeup !== undefined) return { isWorkday: true, source: 'calendar', reason: makeup }
    const holiday = HOLIDAY_MAP.get(n)
    if (holiday !== undefined) return { isWorkday: false, source: 'calendar', reason: holiday }
    return { isWorkday: !weekend, source: 'calendar', reason: weekend ? '週末' : '' }
  }

  const isWorkdayNum = (n: number): boolean => infoNum(n).isWorkday

  return {
    isWorkday(d) {
      return isWorkdayNum(toDayNum(d))
    },

    dayInfo(d) {
      const n = toDayNum(d)
      return { date: fromDayNum(n), ...infoNum(n) }
    },

    addWorkdays(d, n) {
      const start = toDayNum(d)
      if (!Number.isInteger(n)) throw new TypeError(`[workdays] n 必須是整數，收到：${n}`)
      if (Math.abs(n) > MAX_STEP) throw new RangeError(`[workdays] |n| 不可超過 ${MAX_STEP}，收到：${n}`)
      if (n === 0) return d
      const step = n > 0 ? 1 : -1
      let cur = start
      let left = Math.abs(n)
      while (left > 0) {
        cur += step
        if (isWorkdayNum(cur)) left--
      }
      return fromDayNum(cur)
    },

    workdaysBetween(from, to) {
      const a = toDayNum(from)
      const b = toDayNum(to)
      let count = 0
      if (b >= a) {
        // 往後：數 (from, to] 之間的工作日
        for (let n = a + 1; n <= b; n++) if (isWorkdayNum(n)) count++
        return count
      }
      // 往前：數 [to, from) 之間的工作日，回負值（同樣「不含起日、含迄日」）
      for (let n = b; n < a; n++) if (isWorkdayNum(n)) count++
      return -count
    },
  }
}

const TW = createWorkdayCalendar()

/** 該日是否為台灣行政機關上班日（補班日 = true、國定假日/補假/週末 = false） */
export function isWorkday(d: string): boolean {
  return TW.isWorkday(d)
}

/** 該日的詳細判定（含原因與資料來源，UI 要顯示「因 X 順延」或偵測 fallback 時用） */
export function dayInfo(d: string): DayInfo {
  return TW.dayInfo(d)
}

/**
 * 從 d 往後（n > 0）或往前（n < 0）數 n 個工作日，回傳落點。
 * - 起日本身不算：2026-09-24（四）+1 → 2026-09-29（二），跳過中秋、週末、教師節。
 * - n ≠ 0 時落點一定是工作日；n = 0 原樣回傳 d（即使 d 是假日）。
 * - 與 workdaysBetween 互逆：workdaysBetween(d, addWorkdays(d, n)) === n（任何 d、n 皆成立）。
 */
export function addWorkdays(d: string, n: number): string {
  return TW.addWorkdays(d, n)
}

/**
 * from → to 之間有幾個工作日，「不含起日、含迄日」。
 * - to 在 from 之後：數 (from, to]，回正值。例：交期剩幾個工作日 = workdaysBetween(今天, 交期)。
 * - to 在 from 之前：數 [to, from)，回負值（例：已逾期幾個工作日）。
 * - 注意：起訖日落在假日時不對稱，workdaysBetween(週五, 週六) = 0，但 workdaysBetween(週六, 週五) = -1。
 */
export function workdaysBetween(from: string, to: string): number {
  return TW.workdaysBetween(from, to)
}

/** 日期是否在台灣日曆涵蓋範圍內；false 代表該日只用週一~五判斷（結果可能不準） */
export function isCovered(d: string): boolean {
  return isCoveredNum(toDayNum(d))
}

/** 台北時區的今天（'YYYY-MM-DD'）。可傳入 now 方便測試。 */
export function todayTaipei(now: Date = new Date()): string {
  return new Date(now.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10)
}
