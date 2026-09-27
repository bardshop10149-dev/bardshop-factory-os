'use client'

import type { DayLoad, EffectiveCapacity } from '@/lib/packaging/scheduleTypes'
import { hours } from './boardFormat'

// 欄頭工時條（D51）：已排／可用。
// 條內三段：正常工時內（綠）、超過正常但在加班上限內（橘）、超過加班上限（紅）。
// 刻度：以「正常＋加班上限」與已排兩者較大者為滿格，灰色細線標出正常工時的位置。

const LOAD_TEXT: Record<DayLoad, string> = {
  unset: 'text-slate-400',
  ok: 'text-emerald-300',
  over_regular: 'text-orange-300',
  over_overtime: 'text-red-300',
}

export default function CapacityBar({ used, cap, load, unknownCards }: {
  used: number
  cap: EffectiveCapacity
  load: DayLoad
  unknownCards: number
}) {
  const regular = cap.regularMinutes
  const ot = cap.overtimeMinutes
  const unset = regular == null

  const R = regular ?? 0
  const full = Math.max(used, R + ot, 1)
  const pct = (m: number) => `${Math.max(0, Math.min(100, (m / full) * 100))}%`
  const inRegular = Math.min(used, R)
  const inOt = Math.min(Math.max(used - R, 0), ot)
  const over = Math.max(used - R - ot, 0)

  const title = unset
    ? `已排 ${hours(used)} 小時；這天還沒設定產能（點欄頭設定）`
    : `已排 ${hours(used)} 小時／正常 ${hours(R)} 小時（至 19:00）${ot > 0 ? `＋加班上限 ${hours(ot)} 小時` : ''}`

  return (
    <div title={title} className="space-y-1">
      <div className={`flex flex-wrap items-baseline gap-x-1 text-[11px] leading-tight ${LOAD_TEXT[load]}`}>
        <span>已排 <b className="text-[13px]">{hours(used)}</b></span>
        {unset ? (
          <span className="text-slate-500">／產能未設定</span>
        ) : (
          <span className="text-slate-400">
            ／{hours(R)}{ot > 0 ? <span className="text-slate-500">（+{hours(ot)}）</span> : null} h
          </span>
        )}
        {load === 'over_regular' && <span className="ml-auto text-[10px] text-orange-300">需加班</span>}
        {load === 'over_overtime' && <span className="ml-auto text-[10px] font-semibold text-red-300">超過加班上限</span>}
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-slate-800" aria-hidden>
        {unset ? (
          <div className="h-full bg-slate-500/60" style={{ width: used > 0 ? '100%' : '0%' }} />
        ) : (
          <>
            <div className="absolute inset-y-0 left-0 bg-emerald-500" style={{ width: pct(inRegular) }} />
            <div className="absolute inset-y-0 bg-orange-500" style={{ left: pct(inRegular), width: pct(inOt) }} />
            <div className="absolute inset-y-0 bg-red-500" style={{ left: pct(inRegular + inOt), width: pct(over) }} />
            {R > 0 && ot > 0 && <div className="absolute inset-y-0 w-px bg-slate-300/70" style={{ left: pct(R) }} />}
          </>
        )}
      </div>
      {unknownCards > 0 && (
        <div className="text-[10px] text-orange-300/90">另有 {unknownCards} 張工時未知（未計入）</div>
      )}
    </div>
  )
}
