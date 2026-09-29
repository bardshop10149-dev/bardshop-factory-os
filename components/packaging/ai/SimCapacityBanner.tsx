'use client'

// D101 模擬區「用了調整過的產線時數」橫幅（掛在模擬工作台上方）。
//
// 為什麼要有：模擬區的負荷條、AI 排程都改用模擬時數，主管很容易忘了「這個模擬的時數跟正式不一樣」；
//   採用時這些時數會一起寫進正式產能表（D101），所以要一直看得到、並提醒兩件事：
//   ① 正式在你調整之後又被改過的格（組長改了）——採用仍以模擬值為準（D86），先講清楚；
//   ② 鎖定的線（D88）上調整的時數——採用時不會匯入（鎖定＝那條線不動）。
// 只顯示，不寫入；「調整產線時數」打開模擬區的產能表（CapacityEditor＋模擬來源）。

import type { PackagingLine, YMD } from '@/lib/packaging/scheduleTypes'
import type { SimCapacityCell, SimCapacityView, SimLocks } from '@/lib/packaging/ai/types'
import { isWeekend } from '@/lib/packaging/scheduleCalendar'
import { lineNameOf } from '@/lib/packaging/scheduleLines'
import { mdw } from '@/components/packaging/board/boardFormat'
import { capHoursText, capMinutesText } from './simText'

/** 一格覆寫對應的正式有效值（沒有＝null） */
export function liveLineOf(cap: SimCapacityView, date: YMD, lineId: number) {
  return cap.live.effective.find(e => e.date === date)?.lines?.find(l => l.lineId === lineId) ?? null
}

/** 覆寫當時記下的正式值（base）與正式現值不同＝「正式在你調整之後被改過」（與伺服器 simCapacity.baseDiffers 同規則） */
export function liveChangedSince(cell: SimCapacityCell, live: { regularMinutes: number | null; overtimeMinutes: number } | null): boolean {
  if (!live) return false
  const toMin = (h: number) => Math.round(h * 60 * 100) / 100
  const reg = cell.base.regularHours == null ? null : toMin(cell.base.regularHours)
  const regSame = reg == null || live.regularMinutes == null ? reg === live.regularMinutes : Math.abs(reg - live.regularMinutes) < 1e-6
  return !regSame || Math.abs(toMin(cell.base.overtimeHoursMax) - live.overtimeMinutes) >= 1e-6
}

const MAX_ITEMS = 5

export default function SimCapacityBanner({ capacity, lines, locks, editable, onOpen }: {
  capacity: SimCapacityView | null
  lines: PackagingLine[]
  locks: SimLocks
  editable: boolean
  onOpen: () => void
}) {
  if (!capacity || (capacity.cells.length === 0 && capacity.weekendsOpened.length === 0)) return null
  const lineName = (id: number) => lineNameOf(lines, id)
  const items: string[] = []
  for (const w of capacity.weekendsOpened) items.push(`${mdw(w)} 開加班`)
  for (const c of capacity.cells) {
    const wk = isWeekend(c.date)
    const live = liveLineOf(capacity, c.date, c.lineId)
    const liveText = live ? capMinutesText(live, wk) : '—'
    const simText = capHoursText(c, wk)
    items.push(`${mdw(c.date)} ${lineName(c.lineId)} ${liveText === simText ? `${simText}（固定）` : `${liveText}→${simText}`}`)
  }
  const changed = capacity.cells.filter(c => liveChangedSince(c, liveLineOf(capacity, c.date, c.lineId)))
  const lockedCells = capacity.cells.filter(c => locks.lineIds.includes(c.lineId))
  const lockedNames = [...new Set(lockedCells.map(c => lineName(c.lineId)))]
  const inherited = capacity.diffs.filter(d => !capacity.cells.some(c => c.date === d.date && c.lineId === d.lineId)).length
  return (
    <div className="flex flex-wrap items-start gap-2 rounded-lg border border-violet-700/60 bg-violet-950/30 px-3 py-2 text-xs text-violet-100">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div>
          <b>這個模擬用了調整過的產線時數</b>（{items.length} 項）：
          {items.slice(0, MAX_ITEMS).join('、')}{items.length > MAX_ITEMS ? ` 等 ${items.length} 項` : ''}
          {inherited > 0 && <span className="text-violet-300/80">（之後沒填的 {inherited} 格跟著沿用）</span>}
        </div>
        <div className="text-[11px] text-violet-200/70">只作用在模擬區（負荷條、AI 排程都用它）；按「採用此版排程」時會一起寫進正式產能表。</div>
        {changed.length > 0 && (
          <div className="text-[11px] text-orange-300">
            其中 {changed.length} 格正式產能在你調整後被改過（{changed.slice(0, 3).map(c => `${mdw(c.date)} ${lineName(c.lineId)}`).join('、')}{changed.length > 3 ? '…' : ''}），採用會以模擬值為準。
          </div>
        )}
        {lockedCells.length > 0 && (
          <div className="text-[11px] text-slate-300">{lockedNames.join('、')} 已鎖定：這條線調整的 {lockedCells.length} 格採用時不會匯入。</div>
        )}
      </div>
      <button type="button" onClick={onOpen}
        className="shrink-0 rounded border border-violet-600 px-2 py-0.5 text-violet-100 hover:bg-violet-900/50">{editable ? '調整產線時數' : '查看產線時數'}</button>
    </div>
  )
}
