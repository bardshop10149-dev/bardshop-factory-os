'use client'

// D68／D70 日檢視左側的時間尺：顯示 10:00～24:00（一天的模型是 00:00～24:00，畫面只顯示這一段，可調）。
// - 每小時一條細線；19:00（正常／加班分界）粗線；10～19 底色一般、19～24 淡橘（D48／D70）
// - 週六／週日加班日（weekend，D48／D63）：只有加班額度，10～19 就是加班（淡橘）、19:00＝加班上限（紅），
//   19 以後不塗橘（線欄在那裡畫「超過上限」紅斜線）——時間尺與線欄的說法要一致
// - 時間尺只有一把：每條線的「工時 → 鐘面」比例各自換算（laneTimeline.laneScale），
//   所以同一條橫線在 A 線、B 線代表的「累計工時」不同，但代表的「鐘面時刻」相同（D68 本意：每條線都是排滿＝19:00）
// 座標換算與 laneTimeline.layoutLane 相同：px＝(鐘面分鐘 − 顯示起點×60) × 每小時 px ÷ 60。

import {
  DAY_RULER_PX_PER_HOUR,
  REGULAR_END_HOUR,
  RULER_DISPLAY_END_HOUR,
  RULER_DISPLAY_START_HOUR,
} from '@/lib/packaging/scheduleTypes'

/** 時間尺欄寬 */
export const RULER_WIDTH_PX = 52
/** 線頭（LaneColumn 的 sticky 標頭）高度；時間尺上方的空白角落要同高，兩邊的 10:00 才會對齊 */
export const LANE_HEADER_PX = 76
/** 顯示區（10:00～24:00）的高度 */
export const RULER_BASE_HEIGHT_PX = (RULER_DISPLAY_END_HOUR - RULER_DISPLAY_START_HOUR) * DAY_RULER_PX_PER_HOUR

/** 鐘面分鐘（00:00 起）→ 從顯示起點算的 px */
export function rulerPx(clockMin: number): number {
  return ((clockMin - RULER_DISPLAY_START_HOUR * 60) * DAY_RULER_PX_PER_HOUR) / 60
}

/** 要畫格線的整點（顯示區內，含兩端） */
export const RULER_HOURS: readonly number[] = Array.from(
  { length: RULER_DISPLAY_END_HOUR - RULER_DISPLAY_START_HOUR + 1 },
  (_, i) => RULER_DISPLAY_START_HOUR + i,
)

/**
 * 每條線欄底下的格線與底色（時間尺與各線欄共用，線才會對齊）。
 * 只畫顯示區（10:00～24:00）；超過 24:00 的延伸區由 LaneColumn 畫紅色斜線。
 */
export function HourGrid({ tintOvertime = true, weekend = false }: { tintOvertime?: boolean; weekend?: boolean }) {
  const otTop = rulerPx(REGULAR_END_HOUR * 60)
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: RULER_BASE_HEIGHT_PX }} aria-hidden>
      {tintOvertime && (weekend
        ? <div className="absolute inset-x-0 top-0 bg-amber-500/[0.06]" style={{ height: otTop }} />
        : <div className="absolute inset-x-0 bg-amber-500/[0.06]" style={{ top: otTop, bottom: 0 }} />)}
      {RULER_HOURS.map(h => (
        <div
          key={h}
          className={`absolute inset-x-0 ${h === REGULAR_END_HOUR ? `h-0.5 ${weekend ? 'bg-red-400/70' : 'bg-slate-400/70'}` : 'h-px bg-slate-800'}`}
          style={{ top: rulerPx(h * 60) - (h === REGULAR_END_HOUR ? 1 : 0) }}
        />
      ))}
    </div>
  )
}

export default function TimeRuler({ bodyHeightPx, weekend = false }: { bodyHeightPx: number; weekend?: boolean }) {
  return (
    <div
      className="sticky left-0 z-20 shrink-0 border-r border-slate-700 bg-slate-950"
      style={{ width: RULER_WIDTH_PX }}
      aria-hidden
    >
      {/* 左上角（與線頭同高、同樣 sticky），滾動時蓋住線頭 */}
      <div className="sticky top-0 z-30 flex items-end justify-center border-b border-slate-700 bg-slate-900 pb-1 text-[10px] text-slate-500" style={{ height: LANE_HEADER_PX }}>
        時間
      </div>
      <div className="relative" style={{ height: bodyHeightPx }}>
        <HourGrid weekend={weekend} />
        {RULER_HOURS.map((h, i) => (
          <span
            key={h}
            className={`absolute right-1.5 text-[10px] tabular-nums leading-3 ${
              h === REGULAR_END_HOUR ? (weekend ? 'font-bold text-red-300' : 'font-bold text-slate-100')
                : weekend ? (h > REGULAR_END_HOUR ? 'text-slate-600' : 'text-amber-300/80')
                  : h > REGULAR_END_HOUR ? 'text-amber-300/80' : 'text-slate-400'
            }`}
            // 第一個標籤往下長（不被線頭蓋住）；其餘置中在格線上
            style={{ top: rulerPx(h * 60), transform: i === 0 ? 'translateY(2px)' : 'translateY(-50%)' }}
          >{String(h).padStart(2, '0')}:00</span>
        ))}
        {weekend && (
          // 週末 19:00＝加班上限（不是正常／加班分界）
          <span className="absolute right-1 text-[9px] font-semibold leading-3 text-red-300" style={{ top: rulerPx(REGULAR_END_HOUR * 60) + 7 }}>加班上限</span>
        )}
        {bodyHeightPx > RULER_BASE_HEIGHT_PX + 4 && (
          <span className="absolute right-1 text-[10px] font-semibold text-red-300" style={{ top: RULER_BASE_HEIGHT_PX + 4 }}>超出</span>
        )}
      </div>
    </div>
  )
}
