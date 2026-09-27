// 包裝專區 P1 分線輪 — D68／D70 日檢視時間尺（純函式，lines.md §3.7；前端用，也可單測）
//
// 座標：鐘面一律用「從 00:00 起的分鐘」（D70：一天＝00:00～24:00 完整時間軸，畫面只顯示 10:00～24:00，可調）。
// 每條線各自換算（D68）：排滿該線正常工時＝19:00、排滿加班上限＝24:00；同一條橫線在不同線代表的累計工時不同。
// 卡片位置由固定排序決定（D5 修正後仍不排時段），不是由放下的 y 座標決定。
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum（node --experimental-strip-types 可直接測）。

import {
  DAY_RULER_PX_PER_HOUR,
  LANE_CARD_COMPACT_PX,
  LANE_CARD_MIN_PX,
  MINUTES_SNAP,
  OVERTIME_END_HOUR,
  REGULAR_END_HOUR,
  RULER_DISPLAY_START_HOUR,
  WORK_START_HOUR,
  type EffectiveLineCapacity,
  type LaneCardLayout,
  type LaneScale,
} from './scheduleTypes'
import { snapMinutes } from './scheduleMinutes'

const START = WORK_START_HOUR * 60        // 10:00
const REG_END = REGULAR_END_HOUR * 60     // 19:00
const OT_END = OVERTIME_END_HOUR * 60     // 24:00
const EPS = 1e-9

type Seg = LaneScale['segments'][number]

/**
 * 一條線的「工時 → 鐘面」比例（lines.md §3.7 表）：
 * - 平日 R > 0、O > 0：[0, R] → 10:00～19:00；(R, R+O] → 19:00～24:00；超過以加班段比例延伸（over）
 * - 平日 R > 0、O = 0：[0, R] → 10:00～19:00；超過以正常段比例延伸
 * - 超過上限的延伸比例最多 1:1（overflowRate ≤ 1）：產能很小的線（例 R＝1h 排 6h 會是 9 倍）超排時
 *   日檢視不會被撐到幾千、幾萬 px（所有線共用同一個高度）；超出段本來就標 over，位置只需大致正確
 * - 週末（或平日 R = 0）且 O > 0：allOvertime，[0, O] → 10:00～19:00（解讀：週末加班像一個白天班，待確認 §十一第 2 題）
 * - unset（從沒填）：nominal／unset，1 工時分鐘＝1 鐘面分鐘，從 10:00 起；不判超載
 * - R = O = 0：nominal／zero，同上比例，但有卡就是 over（線頭「未排班（0 h）」）
 */
export function laneScale(cap: Pick<EffectiveLineCapacity, 'kind' | 'regularMinutes' | 'overtimeMinutes'>): LaneScale {
  const O = Math.max(0, cap.overtimeMinutes || 0)
  const R = cap.kind === 'weekend' ? 0 : cap.regularMinutes
  const nominal = (reason: 'unset' | 'zero'): LaneScale => ({
    kind: 'nominal', reason,
    segments: [{ kind: 'regular', workFrom: 0, workTo: OT_END - START, clockFrom: START, clockTo: OT_END }],
    overflowRate: 1,
    capMinutes: reason === 'unset' ? Number.POSITIVE_INFINITY : 0,
    allOvertime: false,
  })
  if (R == null) return nominal('unset')
  if (R <= 0 && O <= 0) return nominal('zero')
  if (R <= 0) {
    return {
      kind: 'scaled', reason: null,
      segments: [{ kind: 'overtime', workFrom: 0, workTo: O, clockFrom: START, clockTo: REG_END }],
      overflowRate: Math.min(1, (REG_END - START) / O), capMinutes: O, allOvertime: true,
    }
  }
  const segments: Seg[] = [{ kind: 'regular', workFrom: 0, workTo: R, clockFrom: START, clockTo: REG_END }]
  if (O > 0) segments.push({ kind: 'overtime', workFrom: R, workTo: R + O, clockFrom: REG_END, clockTo: OT_END })
  const last = segments[segments.length - 1]
  return {
    kind: 'scaled', reason: null, segments,
    overflowRate: Math.min(1, (last.clockTo - last.clockFrom) / (last.workTo - last.workFrom)),
    capMinutes: R + O, allOvertime: false,
  }
}

/** 累計工時（分鐘）→ 鐘面分鐘（00:00 起）；超過最後一段以 overflowRate 延伸 */
export function workToClock(workMin: number, s: LaneScale): number {
  const w = Math.max(0, workMin)
  for (const g of s.segments) {
    if (w <= g.workTo + EPS) return g.clockFrom + ((w - g.workFrom) * (g.clockTo - g.clockFrom)) / (g.workTo - g.workFrom)
  }
  const last = s.segments[s.segments.length - 1]
  return last.clockTo + (w - last.workTo) * s.overflowRate
}

/** 鐘面分鐘 → 累計工時（workToClock 的反函數；拉卡片下緣用）；早於起點回 0 */
export function clockToWork(clockMin: number, s: LaneScale): number {
  const first = s.segments[0]
  if (clockMin <= first.clockFrom) return 0
  for (const g of s.segments) {
    if (clockMin <= g.clockTo + EPS) return g.workFrom + ((clockMin - g.clockFrom) * (g.workTo - g.workFrom)) / (g.clockTo - g.clockFrom)
  }
  const last = s.segments[s.segments.length - 1]
  return last.workTo + (clockMin - last.clockTo) / s.overflowRate
}

/** 累計工時落在哪一段（卡片「結束點」的顏色）：超過 capMinutes → over */
function zoneOf(workEnd: number, s: LaneScale): LaneCardLayout['zone'] {
  if (workEnd > s.capMinutes + EPS) return 'over'
  for (const g of s.segments) if (workEnd <= g.workTo + EPS) return g.kind
  return s.segments[s.segments.length - 1].kind
}

export interface LaneLayoutOpts {
  pxPerHour?: number
  displayStartHour?: number
  minPx?: number
  compactPx?: number
}

/**
 * D68 卡片沿時間往下疊、長度＝工時（lines.md §3.7 layoutLane）：
 * cards 的順序＝day.cards 依 laneId 篩出的順序（§3.6 固定排序）。
 * - 工時未知（minutes null）→ 只佔最小高度、累計工時不前進（zone unknown）
 * - 高度至少 minPx（28）；被前一張的最小高度往下推 → shifted（位置不再精確對應時間）
 * - 高度 < compactPx（56）→ compact（只顯示單號＋品名）
 */
export function layoutLane(
  cards: readonly { placementId: string; minutes: number | null }[],
  s: LaneScale,
  opts: LaneLayoutOpts = {},
): LaneCardLayout[] {
  const pxPerHour = opts.pxPerHour ?? DAY_RULER_PX_PER_HOUR
  const startClock = (opts.displayStartHour ?? RULER_DISPLAY_START_HOUR) * 60
  const minPx = opts.minPx ?? LANE_CARD_MIN_PX
  const compactPx = opts.compactPx ?? LANE_CARD_COMPACT_PX
  const px = (clock: number) => ((clock - startClock) * pxPerHour) / 60
  let cursor = 0
  let prevBottom = 0
  const out: LaneCardLayout[] = []
  for (const c of cards) {
    const known = c.minutes != null
    const w = known ? Math.max(0, c.minutes as number) : 0
    const clockStart = workToClock(cursor, s)
    const clockEnd = workToClock(cursor + w, s)
    const naturalTop = px(clockStart)
    const naturalBottom = px(clockEnd)
    const top = Math.max(naturalTop, prevBottom)
    const height = Math.max(naturalBottom - naturalTop, minPx)
    out.push({
      placementId: c.placementId,
      topPx: top,
      heightPx: height,
      compact: height < compactPx,
      workStart: cursor,
      workEnd: cursor + w,
      clockStart,
      clockEnd,
      zone: known ? zoneOf(cursor + w, s) : 'unknown',
      shifted: top > naturalTop + 1e-6,
    })
    cursor += w
    prevBottom = top + height
  }
  return out
}

/**
 * 拉卡片下緣放開後的新「有效工時」（分鐘）：clockToWork(新底部) − workStart，
 * 以工時分鐘吸附 MINUTES_SNAP（不是鐘面分鐘——每條線比例不同，吸附在存下來的量上才一致），下限 MINUTES_SNAP。
 * 是否「回到標準值」（|new − minutesStd| < SNAP/2 → 送 null）由呼叫端判斷。
 */
export function resizeToMinutes(
  layout: Pick<LaneCardLayout, 'workStart'>,
  newBottomPx: number,
  s: LaneScale,
  opts: Pick<LaneLayoutOpts, 'pxPerHour' | 'displayStartHour'> = {},
): number {
  const pxPerHour = opts.pxPerHour ?? DAY_RULER_PX_PER_HOUR
  const startClock = (opts.displayStartHour ?? RULER_DISPLAY_START_HOUR) * 60
  const clock = startClock + (newBottomPx * 60) / pxPerHour
  return snapMinutes(clockToWork(clock, s) - layout.workStart, MINUTES_SNAP)
}

/** 鐘面分鐘 → '13:30'；超過 24:00 顯示 '24:00+'（剛好 24:00 顯示 '24:00'） */
export function clockText(clockMin: number): string {
  if (clockMin > OT_END + 0.5) return '24:00+'
  const m = Math.max(0, Math.round(clockMin))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
