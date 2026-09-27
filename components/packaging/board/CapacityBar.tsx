'use client'

import type { DayLoad, EffectiveCapacity } from '@/lib/packaging/scheduleTypes'
import { loadBarScale, loadBarTitle, reachText, type RowZone } from '@/lib/packaging/boardView'
import { hours } from './boardFormat'

// 負荷進度條（D51／D62）：已排／可用。換算在 lib/packaging/boardView.ts loadBarScale（有單元測試）。
// 條內三段：正常工時內（綠）、超過正常但在加班上限內（橘）、超過加班上限（紅）。
// 刻度：以「正常＋加班上限」與已排兩者較大者為滿格；細線標出 19:00（正常工時滿載；週六／週日＝加班上限）與 24:00（加班上限）。
// 分線輪（D67／D71）：cap 可以是整天（EffectiveCapacity，總時數＝各線加總）或一條線（EffectiveLineCapacity），只看正常／加班兩欄。
// size：
//   xs ＝兩週檢視各線小欄頭（只有細條，數字看滑過提示）
//   md ＝週檢視欄頭、日檢視線頭　lg ＝兩週檢視欄頭（條加粗，D56「重點是負荷條」）
//   xl ＝日檢視頂部（D62）：條再加粗，刻度下方標「10:00／19:00／24:00」字樣（D70 起點 10:00），並顯示「預計約做到幾點」（時間感，不排時段 D5；超過加班上限改顯示「超過 24:00，超出上限 N h」）
//        分線後整天是各線加總，用加總換算的時刻會誤導（A 線到 21:00、B 線空著 → 整天約 15:30）→ 日檢視傳 showReach={false}，改在頂部列顯示「最晚的線」
// singleLine：文字列不換行（日檢視線頭是固定高度，換行會壓到 10:00）

const LOAD_TEXT: Record<DayLoad, string> = {
  unset: 'text-slate-400',
  ok: 'text-emerald-300',
  over_regular: 'text-orange-300',
  over_overtime: 'text-red-300',
}

const ZONE_TEXT: Record<RowZone, string> = {
  none: 'text-slate-300',
  regular: 'text-emerald-300',
  overtime: 'text-orange-300',
  over: 'text-red-300',
}

export default function CapacityBar({ used, cap, load, unknownCards, weekend = false, size = 'md', showReach = true, singleLine = false }: {
  used: number
  cap: Pick<EffectiveCapacity, 'regularMinutes' | 'overtimeMinutes'>
  load: DayLoad
  unknownCards: number
  /** 週六／週日加班日（D48／D63：只有加班額度，19:00＝加班上限） */
  weekend?: boolean
  size?: 'xs' | 'md' | 'lg' | 'xl'
  /** xl 才有作用：是否顯示「預計約做到幾點」 */
  showReach?: boolean
  singleLine?: boolean
}) {
  const capIn = { regularMinutes: cap.regularMinutes, overtimeMinutes: cap.overtimeMinutes, weekend }
  const scale = loadBarScale(used, capIn)
  const R = weekend ? 0 : cap.regularMinutes ?? 0
  const ot = cap.overtimeMinutes
  const xl = size === 'xl'
  // 「週末」與「平日正常工時 0」都只有加班額度（19:00＝上限）：說法看 scale.allOvertime，不只看 weekend 旗標
  const title = loadBarTitle(used, capIn, scale)
  // 超過加班上限時不顯示 28:23 這種時刻，改「超過 24:00，超出上限 N h」
  const reach = xl && showReach ? reachText(scale) : null

  if (size === 'xs') {
    return (
      <div title={title} className={`relative h-1.5 overflow-hidden rounded-full bg-slate-800`} aria-label={title}>
        {scale.unset ? (
          <div className="h-full bg-slate-500/60" style={{ width: used > 0 ? '100%' : '0%' }} />
        ) : (
          <>
            <div className="absolute inset-y-0 left-0 bg-emerald-500" style={{ width: `${scale.regularPct}%` }} />
            <div className="absolute inset-y-0 bg-orange-500" style={{ left: `${scale.regularPct}%`, width: `${scale.overtimePct}%` }} />
            <div className="absolute inset-y-0 bg-red-500" style={{ left: `${scale.regularPct + scale.overtimePct}%`, width: `${scale.overPct}%` }} />
          </>
        )}
      </div>
    )
  }

  return (
    <div title={title} className="space-y-1">
      <div className={`flex items-baseline gap-x-1 leading-tight ${singleLine ? 'overflow-hidden whitespace-nowrap' : 'flex-wrap'} ${xl ? 'text-xs' : 'text-[11px]'} ${LOAD_TEXT[load]}`}>
        <span>已排 <b className={xl ? 'text-base' : 'text-[13px]'}>{hours(used)}</b></span>
        {scale.unset ? (
          <span className="text-slate-500">／產能未設定</span>
        ) : (
          <span className="text-slate-400">
            ／{hours(R)}{ot > 0 ? <span className="text-slate-500">（+{hours(ot)}）</span> : null} h
          </span>
        )}
        {reach && (
          <span className={`ml-2 tabular-nums ${ZONE_TEXT[scale.zone]} ${scale.zone === 'over' ? 'font-semibold' : ''}`} title="依累計工時換算，僅供參考（不排時段，D5）">
            {reach}
          </span>
        )}
        {load === 'over_regular' && <span className="ml-auto shrink-0 text-[10px] text-orange-300">需加班</span>}
        {load === 'over_overtime' && <span className="ml-auto shrink-0 text-[10px] font-semibold text-red-300">{singleLine ? '超上限' : '超過加班上限'}</span>}
      </div>
      <div className={`relative overflow-hidden rounded-full bg-slate-800 ${xl ? 'h-4' : size === 'lg' ? 'h-3.5' : 'h-2'}`} aria-hidden>
        {scale.unset ? (
          <div className="h-full bg-slate-500/60" style={{ width: used > 0 ? '100%' : '0%' }} />
        ) : (
          <>
            <div className="absolute inset-y-0 left-0 bg-emerald-500" style={{ width: `${scale.regularPct}%` }} />
            <div className="absolute inset-y-0 bg-orange-500" style={{ left: `${scale.regularPct}%`, width: `${scale.overtimePct}%` }} />
            <div className="absolute inset-y-0 bg-red-500" style={{ left: `${scale.regularPct + scale.overtimePct}%`, width: `${scale.overPct}%` }} />
            {/* 分界細線（起點與剛好在最右端的不畫） */}
            {scale.ticks.filter(t => t.kind !== 'start' && t.pct > 0 && t.pct < 99.5).map(t => (
              <div
                key={t.kind}
                className={`absolute inset-y-0 ${xl ? 'w-0.5' : 'w-px'} ${t.kind === 'regularEnd' ? 'bg-slate-200/80' : 'bg-red-300/80'}`}
                style={{ left: `${t.pct}%` }}
              />
            ))}
          </>
        )}
      </div>
      {/* 日檢視：刻度下方的時間字樣（10:00 起點；19:00＝正常工時滿載；24:00＝加班上限；週末 19:00＝加班上限） */}
      {xl && scale.ticks.length > 0 && (
        <div className="relative h-3.5 text-[10px] font-semibold tabular-nums leading-3" aria-hidden>
          {scale.ticks.filter(t => t.showLabel).map(t => (
            <span
              key={t.kind}
              className={`absolute top-0 whitespace-nowrap ${
                t.kind === 'start' ? 'text-slate-500' : t.kind === 'regularEnd' ? 'text-slate-200' : 'text-red-300'
              }`}
              style={{
                left: `${t.pct}%`,
                transform: t.align === 'center' ? 'translateX(-50%)' : t.align === 'end' ? 'translateX(-100%)' : undefined,
              }}
            >{t.label}</span>
          ))}
        </div>
      )}
      {unknownCards > 0 && (
        <div className="text-[10px] text-orange-300/90">另有 {unknownCards} 張工時未知（未計入）</div>
      )}
    </div>
  )
}
