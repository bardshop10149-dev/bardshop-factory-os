// 包裝排程工作台的「畫面換算」純函式（D55／D56／D60～D62）：檢視視窗日期、工時→時間換算、負荷進度條、排定卡標記。
//
// 為什麼獨立成檔：
// - 這些換算只影響「怎麼畫」，不影響排程資料（API 契約、伺服器邏輯一律不動），但規則細、容易算錯，
//   抽成純函式才能用 node --experimental-strip-types 直接跑單元測試。
// - 不 import supabase、不讀時鐘（today 由呼叫端傳入）；只用相對路徑 import、不用 enum。
//
// ── 工時 → 時間（D55 的換算，D62 起只用在進度條上）─────────────────────────
// D62 拿掉了日檢視左側的時間尺（改卡片牆），但保留「時間感」：負荷進度條上標 19:00／24:00，並顯示「已排約做到幾點」。
// 換算方式沿用 D55（**不排時段**，D5）：
//   平日：10:00~19:00（540 尺分鐘）對應當天「正常工時 R」，19:00~24:00（300 尺分鐘）對應「加班上限 O」。
//         （D70 起點由 09:00 改 10:00；日檢視時間尺另見 laneTimeline.ts，每條線各自換算）
//         累計工時 w 的尺上位置：
//           w ≤ R        → 540 × w / R
//           R < w ≤ R+O  → 540 + 300 × (w − R) / O
//           w > R+O      → 840 + (w − R − O) × 最後一段的比例（超出 24:00，紅色區）
//   週六／週日（D63，或正常工時 0 的日子）：只有加班額度 O（D49），10:00~19:00 對應 O，其後全是「超過上限」。
//   產能未設定（平日且從沒填過，伺服器 source='unset'）或 R=O=0：不換算。

import type { YMD } from './scheduleTypes'
import { isWorkday } from './workdays'
import { addDays, dayLabel, isHolidayWeekend, isWeekend } from './scheduleCalendar'

// ─────────────────────────────────────────────────────────────────────
// 檢視模式與視窗（D56）
// ─────────────────────────────────────────────────────────────────────

export type BoardViewMode = 'day' | 'week' | 'twoWeek'

/** 各檢視向 GET /api/packaging/board 要幾個台灣工作日（開加班的週末日由伺服器插入、不佔名額） */
export const VIEW_WORKDAYS: Record<BoardViewMode, number> = { day: 1, week: 5, twoWeek: 10 }

export const VIEW_LABEL: Record<BoardViewMode, string> = { day: '日', week: '週', twoWeek: '兩週' }

/** localStorage 讀回來的字串 → 檢視模式；不認得一律「日」（D56 預設） */
export function parseViewMode(raw: unknown): BoardViewMode {
  return raw === 'week' || raw === 'twoWeek' || raw === 'day' ? raw : 'day'
}

/** 最多往前／後找幾個日曆天（最長連假約 10 天，60 天很保守） */
const NAV_SAFETY_DAYS = 60

/**
 * 是否為工作台上的一天：台灣工作日，或已開加班的週六／週日（D48／D63；國定假日的週末不算）。
 * openWeekends 由前端從產能表（GET /api/packaging/capacity）與已載入的工作台欄位彙整。
 */
export function isViewDay(d: YMD, openWeekends: ReadonlySet<YMD>): boolean {
  if (isWorkday(d)) return true
  return isWeekend(d) && openWeekends.has(d) && !isHolidayWeekend(d)
}

/**
 * 日檢視的 ◀ ▶：往前（dir = −1）或往後（+1）找下一個工作台日期。
 * 往前不可早於 min（順延目標日＝今天或下一個工作日；過去的日子不在工作台上，D50 延誤卡已順延到今天）。
 * 找不到（往前已到 min）回 null，按鈕就停用。
 */
export function stepViewDay(d: YMD, dir: 1 | -1, openWeekends: ReadonlySet<YMD>, min: YMD | null = null): YMD | null {
  let cur = d
  for (let i = 0; i < NAV_SAFETY_DAYS; i++) {
    cur = addDays(cur, dir)
    if (dir < 0 && min != null && cur < min) return null
    if (isViewDay(cur, openWeekends)) return cur
  }
  return null
}

/**
 * 日檢視實際要顯示哪一天：
 * - 沒選（null）或選到順延目標日之前 → 順延目標日（今天是工作日＝今天）
 * - 選到的那天不是工作台日期（例：週末後來被取消加班）→ 往後第一個工作台日期
 */
export function resolveViewDay(selected: YMD | null, rollTarget: YMD, openWeekends: ReadonlySet<YMD>): YMD {
  const base = selected == null || selected < rollTarget ? rollTarget : selected
  if (isViewDay(base, openWeekends)) return base
  return stepViewDay(base, 1, openWeekends) ?? base
}

/**
 * 週／兩週檢視的 ◀ ▶：以「台灣工作日」為單位平移起點（週末不佔名額，同伺服器 boardWindow）。
 * 往前不可早於 min。n 可正可負。
 *
 * 起點本身不是工作日（開加班的週末日、或今天剛好是開加班的週末日＝rollTarget）時，
 * 伺服器視窗＝「那個週末日＋其後 n 個工作日」，所以往後要多走一個工作日，新起點才會在目前視窗之後、不重疊。
 * （往前不用：從非工作日往回數 n 個工作日，本來就落在目前視窗之前。）
 */
export function shiftByWorkdays(d: YMD, n: number, min: YMD | null = null): YMD {
  if (n === 0) return d
  const dir = n > 0 ? 1 : -1
  let left = Math.abs(n) + (n > 0 && !isWorkday(d) ? 1 : 0)
  let cur = d
  for (let i = 0; i < NAV_SAFETY_DAYS * 4 && left > 0; i++) {
    cur = addDays(cur, dir)
    if (isWorkday(cur)) left--
  }
  if (min != null && cur < min) return min
  return cur
}

/**
 * 從 from 起列出 n 個台灣工作日（開加班的週末日插入、不佔名額）——與伺服器 boardWindow 同規則。
 * 給「移到日期…」「拆卡」對話框當日期選單（日檢視只載入 1 天，選單不能只剩那一天）。
 */
export function listViewDays(from: YMD, n: number, openWeekends: ReadonlySet<YMD>): { date: YMD; label: string; kind: 'workday' | 'weekend_ot' }[] {
  const out: { date: YMD; label: string; kind: 'workday' | 'weekend_ot' }[] = []
  let cur = from
  let count = 0
  for (let i = 0; i < NAV_SAFETY_DAYS * 4 && count < n; i++) {
    if (isWorkday(cur)) {
      out.push({ date: cur, label: dayLabel(cur), kind: isWeekend(cur) ? 'weekend_ot' : 'workday' })
      count++
    } else if (isViewDay(cur, openWeekends)) {
      out.push({ date: cur, label: dayLabel(cur), kind: 'weekend_ot' })
    }
    cur = addDays(cur, 1)
  }
  return out
}

/** GET /api/packaging/board 的查詢參數：from＝檢視起點（null＝今天，由伺服器決定）、workdays＝檢視天數 */
export function windowRequest(mode: BoardViewMode, anchor: YMD | null): { from: YMD | null; workdays: number } {
  return { from: anchor, workdays: VIEW_WORKDAYS[mode] }
}

// ─────────────────────────────────────────────────────────────────────
// 工時 → 時間換算（D55 時間尺的公式；D62 起給負荷進度條用）
// ─────────────────────────────────────────────────────────────────────

/** D70：一天的工作起點 10:00（原 D55 為 09:00） */
export const RULER_START_HOUR = 10
export const RULER_REGULAR_END_HOUR = 19
export const RULER_END_HOUR = 24
/** 10:00~19:00 的尺上分鐘數 */
const REGULAR_SPAN = (RULER_REGULAR_END_HOUR - RULER_START_HOUR) * 60
/** 19:00~24:00 的尺上分鐘數 */
const OVERTIME_SPAN = (RULER_END_HOUR - RULER_REGULAR_END_HOUR) * 60
/** 10:00~24:00 */
export const RULER_TOTAL_SPAN = REGULAR_SPAN + OVERTIME_SPAN

export interface RulerCapInput {
  /** 正常工時（分鐘）；null＝產能未設定（伺服器已先套 D49 平日沿用，仍 null 才是真的沒填過） */
  regularMinutes: number | null
  /** 加班上限（分鐘） */
  overtimeMinutes: number
  /** 週末加班日（D48／D63：週六、週日只有加班） */
  weekend: boolean
}

interface Segment {
  kind: 'regular' | 'overtime'
  /** 本段容量（工時分鐘） */
  minutes: number
  rulerFrom: number
  rulerTo: number
}

export type RulerMode =
  | { kind: 'scaled'; segments: Segment[]; regular: number; overtime: number; allOvertime: boolean }
  | { kind: 'uniform'; reason: 'unset' | 'zero' }

/** 依當天產能決定時間尺怎麼換算（見檔頭公式） */
export function rulerMode(cap: RulerCapInput): RulerMode {
  if (cap.regularMinutes == null && !cap.weekend) return { kind: 'uniform', reason: 'unset' }
  const R = cap.weekend ? 0 : Math.max(0, cap.regularMinutes ?? 0)
  const O = Math.max(0, cap.overtimeMinutes)
  if (R <= 0 && O <= 0) return { kind: 'uniform', reason: 'zero' }
  if (R <= 0) {
    // 週末／正常工時 0：整段 10:00~19:00 都是加班額度，19:00 之後＝超過上限
    return { kind: 'scaled', segments: [{ kind: 'overtime', minutes: O, rulerFrom: 0, rulerTo: REGULAR_SPAN }], regular: 0, overtime: O, allOvertime: true }
  }
  const segs: Segment[] = [{ kind: 'regular', minutes: R, rulerFrom: 0, rulerTo: REGULAR_SPAN }]
  if (O > 0) segs.push({ kind: 'overtime', minutes: O, rulerFrom: REGULAR_SPAN, rulerTo: REGULAR_SPAN + OVERTIME_SPAN })
  return { kind: 'scaled', segments: segs, regular: R, overtime: O, allOvertime: false }
}

/**
 * 累計工時（分鐘）→ 尺上分鐘（0 ＝ 10:00）。超出所有段 → 用最後一段的比例往後延伸。
 * uniform 模式沒有換算，回 null。
 */
export function workToRuler(w: number, mode: RulerMode): number | null {
  if (mode.kind !== 'scaled') return null
  let acc = 0
  for (const s of mode.segments) {
    if (w <= acc + s.minutes) return s.rulerFrom + ((w - acc) / s.minutes) * (s.rulerTo - s.rulerFrom)
    acc += s.minutes
  }
  const last = mode.segments[mode.segments.length - 1]
  const rate = (last.rulerTo - last.rulerFrom) / last.minutes
  return last.rulerTo + (w - acc) * rate
}

/** 尺上分鐘 → '13:30'（超過 24:00 照樣往上加，例 '25:00'） */
export function rulerClock(rulerMin: number): string {
  const total = Math.round(RULER_START_HOUR * 60 + rulerMin)
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export type RowZone = 'regular' | 'overtime' | 'over' | 'none'

/**
 * 累計工時落在哪一段（進度條旁「約做到幾點」的文字顏色）。
 * 平日：≤ R 一般、≤ R+O 加班（橘）、其餘超過上限（紅）。週末：≤ O 加班、其餘紅。
 * uniform 模式：none（不上色）。浮點容差 1e-6，避免 R 剛好排滿時被判成加班。
 */
export function zoneOf(endMin: number, mode: RulerMode): RowZone {
  if (mode.kind !== 'scaled') return 'none'
  const eps = 1e-6
  if (!mode.allOvertime && endMin <= mode.regular + eps) return 'regular'
  if (endMin <= mode.regular + mode.overtime + eps) return 'overtime'
  return 'over'
}

// ─────────────────────────────────────────────────────────────────────
// 負荷進度條（D51／D62）
// ─────────────────────────────────────────────────────────────────────

/** 刻度：10:00 起點、19:00（平日＝正常工時滿載；週末＝加班上限）、24:00（平日加班上限） */
export interface LoadBarTick {
  kind: 'start' | 'regularEnd' | 'capEnd'
  label: '10:00' | '19:00' | '24:00'
  /** 在條上的位置（0~100） */
  pct: number
  /** 標籤是否畫得下（相鄰刻度太近時只留重要的） */
  showLabel: boolean
  /** 標籤對齊：靠左端的往右長、靠右端的往左長，才不會超出條外 */
  align: 'start' | 'center' | 'end'
}

export interface LoadBarScale {
  /** 平日且產能從沒填過（伺服器 regularMinutes＝null）：整條灰、不畫刻度 */
  unset: boolean
  /** 滿格代表幾分鐘：max(已排, 正常＋加班上限, 1)——超過上限時條不會爆出去，刻度往左縮 */
  full: number
  /** 已排工時三段的寬度（0~100）：正常內（綠）、加班內（橘）、超過加班上限（紅） */
  regularPct: number
  overtimePct: number
  overPct: number
  ticks: LoadBarTick[]
  /** 已排工時換算成「大約做到幾點」（沿用時間尺換算，D55）；沒排或產能未設定為 null。
   *  超過加班上限時會算出 24 點以後的時刻（例 28:23），畫面不要直接顯示——用 reachText */
  reachClock: string | null
  /** 已排工時落在哪一段（文字顏色用） */
  zone: RowZone
  /** 超過加班上限的工時（分鐘）；沒超過為 0 */
  overMinutes: number
  /** 沒有正常工時、只有加班額度（週末，或平日正常工時設 0）：10:00~19:00 整段都是加班額度，19:00＝上限 */
  allOvertime: boolean
}

/** 刻度標籤之間至少要隔多少 %（「19:00」約 5 個字寬，條寬 ~480px 時 12% ≈ 58px） */
export const LOAD_LABEL_MIN_GAP = 12

const pctOf = (m: number, full: number): number => Math.max(0, Math.min(100, (m / full) * 100))

/**
 * D62 日檢視頂部的負荷進度條（週／兩週欄頭也用同一份換算，只是不畫標籤）。
 *   平日：綠＝正常工時內、橘＝超過正常但在加班上限內、紅＝超過加班上限；
 *         19:00 刻度在「正常工時 R」的位置（R 排滿＝做到 19:00），24:00 在 R＋O（加班上限）。
 *   週末（D48／D63 只有加班）：整段都是加班額度 O → 有排就是橘；19:00 刻度在 O（10:00~19:00 對應 O，同 D55 時間尺、D70 起點）。
 *   產能 0（R＝O＝0）：沒有刻度，有排就全紅。
 * 標籤擠在一起時依重要度保留：19:00 ＞ 24:00 ＞ 10:00。
 */
export function loadBarScale(used: number, cap: RulerCapInput, minLabelGap: number = LOAD_LABEL_MIN_GAP): LoadBarScale {
  const u = Number.isFinite(used) && used > 0 ? used : 0
  const mode = rulerMode(cap)
  if (mode.kind === 'uniform' && mode.reason === 'unset') {
    return { unset: true, full: Math.max(u, 1), regularPct: 0, overtimePct: 0, overPct: 0, ticks: [], reachClock: null, zone: 'none', overMinutes: 0, allOvertime: false }
  }
  const R = cap.weekend ? 0 : Math.max(0, cap.regularMinutes ?? 0)
  const O = Math.max(0, cap.overtimeMinutes)
  const full = Math.max(u, R + O, 1)
  const inRegular = Math.min(u, R)
  const inOt = Math.min(Math.max(u - R, 0), O)
  const over = Math.max(u - R - O, 0)

  const raw: Omit<LoadBarTick, 'showLabel' | 'align'>[] = []
  if (R + O > 0) {
    raw.push({ kind: 'start', label: '10:00', pct: 0 })
    if (R > 0) {
      raw.push({ kind: 'regularEnd', label: '19:00', pct: pctOf(R, full) })
      if (O > 0) raw.push({ kind: 'capEnd', label: '24:00', pct: pctOf(R + O, full) })
    } else {
      // 週末／正常工時 0：19:00 就是加班上限
      raw.push({ kind: 'capEnd', label: '19:00', pct: pctOf(O, full) })
    }
  }
  // 標籤取捨：依重要度逐一放，離已放的標籤太近就不放
  const priority = (k: LoadBarTick['kind'], label: string) => (label === '19:00' ? 0 : k === 'capEnd' ? 1 : 2)
  const placed: number[] = []
  const show = new Set<number>()
  raw
    .map((t, i) => ({ i, p: priority(t.kind, t.label), pct: t.pct }))
    .sort((a, b) => a.p - b.p)
    .forEach(t => {
      if (placed.every(x => Math.abs(x - t.pct) >= minLabelGap)) { placed.push(t.pct); show.add(t.i) }
    })
  const ticks: LoadBarTick[] = raw.map((t, i) => ({
    ...t,
    showLabel: show.has(i),
    align: t.pct < minLabelGap / 2 ? 'start' : t.pct > 100 - minLabelGap / 2 ? 'end' : 'center',
  }))

  const reach = u > 0 ? workToRuler(u, mode) : null
  return {
    unset: false,
    full,
    regularPct: pctOf(inRegular, full),
    overtimePct: pctOf(inOt, full),
    overPct: pctOf(over, full),
    ticks,
    reachClock: reach == null ? null : rulerClock(reach),
    zone: u > 0 ? zoneOf(u, mode) : 'none',
    overMinutes: over,
    allOvertime: R <= 0 && O > 0,
  }
}

/**
 * 進度條旁的「時間感」文字（D62 日檢視）：
 *   沒超過上限 → 「預計約做到 14:30」
 *   超過加班上限 → 「超過 24:00，超出上限 7.0 h」（週末／正常工時 0 的上限是 19:00）——
 *   不顯示 28:23 這種 24 點以後的時刻，現場看不懂。
 *   沒排、產能未設定、產能 0 → null（不顯示）
 */
export function reachText(scale: Pick<LoadBarScale, 'reachClock' | 'zone' | 'overMinutes' | 'ticks'>): string | null {
  if (scale.zone === 'over') {
    const cap = scale.ticks.find(t => t.kind === 'capEnd') ?? scale.ticks.find(t => t.kind === 'regularEnd')
    return `超過 ${cap?.label ?? '上限'}，超出上限 ${hoursText(scale.overMinutes) ?? '?'} h`
  }
  return scale.reachClock ? `預計約做到 ${scale.reachClock}` : null
}

/** 進度條的滑過說明（小時一位小數；未設定／週末／正常工時 0 各有說法） */
export function loadBarTitle(used: number, cap: { regularMinutes: number | null; overtimeMinutes: number; weekend: boolean }, scale: Pick<LoadBarScale, 'unset' | 'allOvertime'>): string {
  const h = (m: number | null) => hoursText(m ?? 0) ?? '0.0'
  if (scale.unset) return `已排 ${h(used)} 小時；這天還沒設定產能（點「設定產能」或欄頭 ⚙）`
  const O = Math.max(0, cap.overtimeMinutes)
  if (scale.allOvertime) {
    return `已排 ${h(used)} 小時／${cap.weekend ? '週末' : '正常工時 0，'}加班上限 ${h(O)} 小時（10:00~19:00）`
  }
  const R = cap.weekend ? 0 : Math.max(0, cap.regularMinutes ?? 0)
  return `已排 ${h(used)} 小時／正常 ${h(R)} 小時（至 19:00）${O > 0 ? `＋加班上限 ${h(O)} 小時（至 24:00）` : ''}`
}

// ─────────────────────────────────────────────────────────────────────
// 排定卡（D60／D61）：狀態、小標記、檢視對應的卡片大小
// ─────────────────────────────────────────────────────────────────────

/** 每種檢視的卡片大小：日＝完整簡化卡（牆，每張 ≥ 260px）、週＝同 7 項但字小（欄寬約 168px）、兩週＝迷你卡（欄寬約 80px） */
export type CardSize = 'md' | 'sm' | 'mini'

export function cardSizeFor(view: BoardViewMode): CardSize {
  return view === 'day' ? 'md' : view === 'week' ? 'sm' : 'mini'
}

/** 排定卡（BoardCard）裡這裡會用到的欄位（測試用假物件只要給這些） */
export interface PlacementLike {
  effectiveQty: number
  readiness: 'ready' | 'pre' | 'pre_unknown'
  preReadyDate: YMD | null
  delayWorkdays: number
  split: { index: number; total: number } | null
  completed: { at: string } | null
  flags: { code: string; level: 'danger' | 'warn' | 'info' }[]
}

/** 預排卡的橘色虛線（到期未就緒／排在預估可包日之前／預估可包日已過） */
const WARN_FRAME_CODES = new Set(['pre_due', 'before_est_ready', 'line_eta_passed'])

export interface PlacementState {
  done: boolean
  /** 已由待排池扣完、不需再包（有效數量 0） */
  consumed: boolean
  /** D22 預排（尚未入庫／前站未完工） */
  pre: boolean
  /** 預排但要提醒（橘色虛線） */
  warnFrame: boolean
  /** D50 延誤 */
  delayed: boolean
}

export function placementState(bc: PlacementLike): PlacementState {
  return {
    done: bc.completed != null,
    consumed: bc.effectiveQty <= 0 && bc.flags.some(f => f.code === 'pool_consumed' || f.code === 'not_placeable_now'),
    pre: bc.readiness !== 'ready',
    warnFrame: bc.flags.some(f => WARN_FRAME_CODES.has(f.code)),
    delayed: bc.flags.some(f => f.code === 'delayed'),
  }
}

/** 卡片外框：預排＝虛線（藍＝正常預排、橘＝要提醒，D22）；已完成／已扣完（不需再包）不畫虛線 */
export function placementFrame(s: PlacementState): 'solid' | 'pre' | 'preWarn' {
  if (s.done || s.consumed || !(s.pre || s.warnFrame)) return 'solid'
  return s.warnFrame ? 'preWarn' : 'pre'
}

export type CardMarkKind = 'done' | 'consumed' | 'delayed' | 'pre' | 'preWarn' | 'split'

export interface CardMark {
  kind: CardMarkKind
  /** 卡片上的短字 */
  text: string
  /** 滑過／報讀器的完整說明 */
  title: string
}

/**
 * 排定卡上的小標記（D60：不另佔一行，放在客戶名稱那一行的右側；迷你卡放在數量旁）。
 * 優先序：已完成 → 已扣完 → 延誤（D50）→ 預排（D22）→ 拆卡 i/n。
 * - 已完成：只留「✓」（和拆卡序），延誤／預排已不重要
 * - 已扣完（待排池數量已扣光、有效數量 0，不需再包）：灰色「已扣完」——卡面是灰條、內容變淡、勾選框停用，
 *   沒有標記的話看起來像「少一個勾的已完成」；延誤／預排同樣不再重要
 * - mini（兩週迷你卡，寬約 70px）：最多 1 個，且不放拆卡序（位置不夠；拆卡看卡片詳情）
 */
export function cardMarks(bc: PlacementLike, size: CardSize, fmtDate: (d: YMD) => string = d => d): CardMark[] {
  const s = placementState(bc)
  const out: CardMark[] = []
  if (s.done) out.push({ kind: 'done', text: '✓', title: '已完成（D24）' })
  const consumed = !s.done && s.consumed
  if (consumed) {
    out.push({ kind: 'consumed', text: size === 'md' ? '已扣完' : size === 'sm' ? '扣完' : '扣', title: '已由待排池扣完：有效數量 0，不需再包（可放回待排池）' })
  }
  if (!s.done && !consumed && s.delayed && bc.delayWorkdays > 0) {
    out.push({ kind: 'delayed', text: size === 'md' ? `延誤 ${bc.delayWorkdays} 天` : `延${bc.delayWorkdays}`, title: `延誤 ${bc.delayWorkdays} 個工作日（D50）` })
  }
  if (!s.done && !consumed && (s.pre || s.warnFrame)) {
    const when = bc.readiness === 'pre' && bc.preReadyDate ? fmtDate(bc.preReadyDate) : null
    out.push({
      kind: s.warnFrame ? 'preWarn' : 'pre',
      text: size === 'md' ? (when ? `預排 ${when}` : '預排') : '預',
      title: s.warnFrame
        ? `預排：到期仍未就緒或排在預估可包日之前，請挪移（D22）${when ? `；預估 ${when} 可包` : ''}`
        : `預排：尚未入庫／前站未完工（D22）${when ? `；預估 ${when} 可包` : '；可包日未知'}`,
    })
  }
  if (bc.split && size !== 'mini') {
    out.push({ kind: 'split', text: size === 'md' ? `拆 ${bc.split.index}/${bc.split.total}` : `拆${bc.split.index}/${bc.split.total}`, title: `同一訂單行拆成 ${bc.split.total} 張，這是第 ${bc.split.index} 張` })
  }
  return size === 'mini' ? out.slice(0, 1) : out
}

/**
 * 左側細色條（同待排池 D58）：灰＝已完成／已扣完、紅＝危險（逾期或紅色旗標）、其餘中性。
 * 延誤不在色條表現（用橘色「延誤 N 天」標記，D50），色條只回答「危不危險」一個問題。
 */
export function cardBarTone(s: Pick<PlacementState, 'done' | 'consumed'> | null, danger: boolean): 'done' | 'danger' | 'normal' {
  if (s && (s.done || s.consumed)) return 'done'
  return danger ? 'danger' : 'normal'
}

/**
 * 欄／卡片牆空白時的提示（勾「隱藏已完成」而當天全部完成時，不能顯示成「還沒有排」）。
 * 有卡但全被隱藏 → 「N 張已完成（已隱藏）」；真的沒卡 → null（呼叫端顯示各自的空白提示，如「拖到這裡」）。
 */
export function hiddenDoneText(total: number, shown: number): string | null {
  if (total > 0 && shown === 0) return `${total} 張已完成（已隱藏）`
  return null
}

/** 危險＝已逾期（交期早於今天）或帶紅色旗標 */
export function isCardDanger(c: { dueDate: YMD | null; flags: { level: string }[] }, today: YMD, extraFlags: readonly { level: string }[] = []): boolean {
  return (c.dueDate != null && c.dueDate < today) || c.flags.some(f => f.level === 'danger') || extraFlags.some(f => f.level === 'danger')
}
// ─────────────────────────────────────────────────────────────────────
// 卡片欄位的顯示文字（沿用 P0 卡片的判斷，但 PackagingCard.tsx 不能改，所以在這裡重寫一份純函式）
// ─────────────────────────────────────────────────────────────────────

/** 包裝欄只取「包裝方式本體」：'-||-' 之前、第一個 Tab／換行之前（同 P0 卡片 splitPacking 的 main） */
export function packingMain(raw: string | null | undefined): string | null {
  if (!raw) return null
  const head = raw.split('-||-')[0]
  const first = head.split(/[\t\r\n]+/)[0]?.trim().replace(/\s+/g, ' ')
  return first ? first : null
}

/** 訂單備註常常只是再存一次品名：和品名相同或被品名包含就不顯示（同 P0 卡片 remarkWorthShowing） */
export function remarkWorthShowing(remark: string | null | undefined, itemName: string | null | undefined): string | null {
  if (!remark) return null
  const norm = (t: string) => t.replace(/\s+/g, '')
  const r = norm(remark)
  if (!r) return null
  if (itemName && norm(itemName).includes(r)) return null
  return remark
}

/** 卡片詳情「備註」：常平出貨備註＋訂單備註（去掉只是重複品名的） */
export function noteText(c: { cpShipNote: string | null; orderRemark: string | null; itemName: string | null }): string | null {
  const parts: string[] = []
  if (c.cpShipNote) parts.push(`常平出貨：${c.cpShipNote}`)
  const r = remarkWorthShowing(c.orderRemark, c.itemName)
  if (r) parts.push(r)
  return parts.length > 0 ? parts.join('／') : null
}

/** 卡片「製令」：自製卡的製令號；常平／委外沒有製令，回傳來源單號並標 isMo=false（畫面用淡色） */
export function moText(c: {
  preStation: { moNbr: string } | null
  sources: { kind: string; docType: string; docNo: string; lineNo: string | null }[]
}): { text: string; isMo: boolean } | null {
  if (c.preStation?.moNbr) return { text: c.preStation.moNbr, isMo: true }
  const mo = c.sources.find(s => s.kind === 'inhouse')
  if (mo) return { text: mo.docNo, isMo: true }
  const s = c.sources[0]
  if (!s) return null
  return { text: `${s.docType} ${s.docNo}${s.lineNo ? `-${s.lineNo}` : ''}`, isMo: false }
}

/** 分鐘 → 小時（一位小數）字串；null → null */
export function hoursText(min: number | null | undefined): string | null {
  if (min == null || !Number.isFinite(min)) return null
  return (Math.round(min / 6) / 10).toFixed(1)
}
