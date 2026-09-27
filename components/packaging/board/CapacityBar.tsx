'use client'

import type { DayLoad, EffectiveCapacity } from '@/lib/packaging/scheduleTypes'
import { loadBarScale, loadBarTitle, reachText, type RowZone } from '@/lib/packaging/boardView'
import { hours } from './boardFormat'

// 負荷進度條（D51／D62）：已排／可用。換算在 lib/packaging/boardView.ts loadBarScale（有單元測試）。
// 條內三段：正常工時內（綠）、超過正常但在加班上限內（橘）、超過加班上限（紅）。
// 刻度：以「正常＋加班上限」與已排兩者較大者為滿格；細線標出 19:00（正常工時滿載；週六＝加班上限）與 24:00（加班上限）。
// size：
//   md ＝週檢視欄頭　lg ＝兩週檢視欄頭（條加粗，D56「重點是負荷條」）
//   xl ＝日檢視頂部（D62）：條再加粗，刻度下方標「09:00／19:00／24:00」字樣，並顯示「預計約做到幾點」（時間感，不排時段 D5；超過加班上限改顯示「超過 24:00，超出上限 N h」）

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

export default function CapacityBar({ used, cap, load, unknownCards, saturday = false, size = 'md' }: {
  used: number
  cap: EffectiveCapacity
  load: DayLoad
  unknownCards: number
  /** 週六加班日（D48：只有加班額度，19:00＝加班上限） */
  saturday?: boolean
  size?: 'md' | 'lg' | 'xl'
}) {
  const capIn = { regularMinutes: cap.regularMinutes, overtimeMinutes: cap.overtimeMinutes, saturday }
  const scale = loadBarScale(used, capIn)
  const R = saturday ? 0 : cap.regularMinutes ?? 0
  const ot = cap.overtimeMinutes
  const xl = size === 'xl'
  // 「週六」與「平日正常工時 0」都只有加班額度（19:00＝上限）：說法看 scale.allOvertime，不只看 saturday 旗標
  const title = loadBarTitle(used, capIn, scale)
  // 超過加班上限時不顯示 28:23 這種時刻，改「超過 24:00，超出上限 N h」
  const reach = xl ? reachText(scale) : null

  return (
    <div title={title} className="space-y-1">
      <div className={`flex flex-wrap items-baseline gap-x-1 leading-tight ${xl ? 'text-xs' : 'text-[11px]'} ${LOAD_TEXT[load]}`}>
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
        {load === 'over_regular' && <span className="ml-auto text-[10px] text-orange-300">需加班</span>}
        {load === 'over_overtime' && <span className="ml-auto text-[10px] font-semibold text-red-300">超過加班上限</span>}
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
      {/* 日檢視：刻度下方的時間字樣（19:00＝正常工時滿載；24:00＝加班上限；週六 19:00＝加班上限） */}
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
