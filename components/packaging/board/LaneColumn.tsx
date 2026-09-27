'use client'

// D67／D68 日檢視的一條線（一欄）：sticky 線頭＋時間軸本體。
// - 整欄（線頭＋本體）＝droppable `lane:${date}:${lineId}`：放下＝排到／移到這條線（位置照固定排序，不看放下的 y，D5）
// - 線頭：線名、該線負荷條（CapacityBar，各線各自的正常／加班）、未設定／未排班提示、⚙ 開這條線的產能設定
//   線頭是固定高度（LANE_HEADER_PX，時間尺左上角同高才對得齊 10:00）：內容一律單行（負荷文字不換行、
//   「工時未知 N 張」放在線名列），外層 overflow-hidden 兜底，不讓線頭長高壓到 10:00 那一段
// - 本體：格線（HourGrid）、該線的加班段／超過上限區底色（依該線 LaneScale，每條線各自換算）、卡片（LaneCard 絕對定位）
// 「隱藏已完成」：已完成卡照樣佔時間（layout 由 DayLanesView 用全部卡算），只是不畫——位置才不會跳動（lines.md §3.7 解讀）。

import { useDroppable } from '@dnd-kit/core'
import {
  type BoardCard,
  type BoardLane,
  type LaneCardLayout,
  type LaneScale,
  type YMD,
} from '@/lib/packaging/scheduleTypes'
import { hoursText } from '@/lib/packaging/boardView'
import { workToClock } from '@/lib/packaging/laneTimeline'
import { dropBlockedReason, type DragRule } from './boardLocal'
import { md } from './boardFormat'
import CapacityBar from './CapacityBar'
import type { CardMenuHandlers } from './cardMenu'
import LaneCard from './LaneCard'
import { HourGrid, LANE_HEADER_PX, RULER_BASE_HEIGHT_PX, rulerPx } from './TimeRuler'

export interface LaneEntry {
  bc: BoardCard
  layout: LaneCardLayout
}

export default function LaneColumn({
  date, lane, scale, entries, bodyHeightPx, weekend, today, dragRule, stale, editable, canDrag, canResize, hideCompleted,
  handlerMap, onOpenOrder, onOpenDetail, onResize, onResizing, onEditCapacity,
}: {
  date: YMD
  lane: BoardLane
  scale: LaneScale
  /** 這條線的卡（day.cards 依 laneId 篩出的順序）與 layoutLane 結果 */
  entries: LaneEntry[]
  /** 本體高度（所有線同高＝max(24:00, 各線最後一張卡底部)） */
  bodyHeightPx: number
  weekend: boolean
  today: YMD
  dragRule: DragRule | null
  stale: boolean
  editable: boolean
  canDrag: boolean
  canResize: boolean
  hideCompleted: boolean
  handlerMap: Map<string, CardMenuHandlers>
  onOpenOrder: (so: string) => void
  onOpenDetail: (bc: BoardCard) => void
  onResize: (bc: BoardCard, newEffMinutes: number) => void
  onResizing?: (active: boolean) => void
  onEditCapacity: (date: YMD, lineId?: number) => void
}) {
  const blocked = dropBlockedReason(dragRule, date)
  const { setNodeRef, isOver } = useDroppable({ id: `lane:${date}:${lane.lineId}`, disabled: !!blocked || stale })
  const cap = lane.capacity
  const shown = hideCompleted ? entries.filter(e => !e.bc.completed) : entries
  const doneCount = entries.filter(e => e.bc.completed).length

  // 該線的區段底色：加班段（橘）與超過上限區（紅斜線）的鐘面位置，依該線自己的比例
  const otSeg = scale.segments.find(g => g.kind === 'overtime')
  const capFinite = Number.isFinite(scale.capMinutes)
  const overTop = capFinite ? rulerPx(workToClock(scale.capMinutes, scale)) : null
  const overMinutes = capFinite ? Math.max(0, lane.usedMinutes - scale.capMinutes) : 0

  const capNote = scale.reason === 'unset' ? '未設定產能'
    : scale.reason === 'zero' ? '未排班（0 h）'
      : cap.source === 'inherited' && cap.inheritedFrom ? `沿用 ${md(cap.inheritedFrom)}` : null

  return (
    <div
      ref={setNodeRef}
      aria-label={`${lane.name} ${date}`}
      className={`relative flex min-w-[220px] flex-1 basis-0 flex-col border-r border-slate-800 ${isOver ? 'bg-sky-950/40' : ''}`}
    >
      {/* ── 線頭（sticky：往下捲時仍看得到是哪條線、負荷多少） ── */}
      <div
        className={`sticky top-0 z-10 space-y-1 overflow-hidden border-b border-slate-700 px-2 py-1.5 ${isOver ? 'bg-sky-950' : 'bg-slate-900'}`}
        style={{ height: LANE_HEADER_PX }}
      >
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-bold text-slate-100" title={`${lane.name}（代碼 ${lane.code}）`}>{lane.name}</span>
          <span className="shrink-0 text-[10px] text-slate-500">
            {lane.cardCount} 張{doneCount > 0 ? `（完成 ${doneCount}）` : ''}
          </span>
          {capNote && <span className={`shrink-0 text-[10px] ${scale.reason === 'zero' ? 'text-red-300' : 'text-slate-500'}`}>{capNote}</span>}
          {lane.unknownMinutesCards > 0 && (
            <span className="min-w-0 truncate text-[10px] text-orange-300/90" title={`另有 ${lane.unknownMinutesCards} 張工時未知（未計入負荷）`}>
              未知 {lane.unknownMinutesCards} 張
            </span>
          )}
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => onEditCapacity(date, lane.lineId)}
            title={editable ? `設定 ${lane.name} 這天的正常／加班時數` : `查看 ${lane.name} 的產能設定`}
            aria-label={`${lane.name} 產能設定`}
            className="shrink-0 rounded px-1 text-[12px] text-slate-400 hover:bg-slate-800 hover:text-white"
          >⚙</button>
        </div>
        {/* 未知張數已放在線名列；負荷文字單行，線頭高度才固定 */}
        <CapacityBar used={lane.usedMinutes} cap={cap} load={lane.load} unknownCards={0} weekend={weekend} size="md" singleLine />
      </div>

      {/* ── 時間軸本體 ── */}
      <div className="relative" style={{ height: bodyHeightPx }}>
        {/* 預設的 19～24 淡橘由各線自己決定：週末（allOvertime）10～19 就是加班 */}
        <HourGrid tintOvertime={false} weekend={weekend} />
        {otSeg && (
          <div
            className="pointer-events-none absolute inset-x-0 bg-amber-500/[0.07]"
            style={{ top: rulerPx(otSeg.clockFrom), height: rulerPx(otSeg.clockTo) - rulerPx(otSeg.clockFrom) }}
            aria-hidden
          />
        )}
        {overTop != null && (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0"
            style={{
              top: overTop,
              backgroundImage: 'repeating-linear-gradient(135deg, rgba(239,68,68,0.10) 0 6px, transparent 6px 12px)',
            }}
            aria-hidden
          >
            {overMinutes > 0 && (
              <span className="absolute right-1 top-0.5 rounded bg-red-950/90 px-1 text-[10px] font-semibold text-red-200">
                超出上限 {hoursText(overMinutes)} h
              </span>
            )}
          </div>
        )}
        {bodyHeightPx > RULER_BASE_HEIGHT_PX + 1 && overTop == null && (
          // 未設定產能的線（nominal 1:1）超過 24:00 的延伸區：同樣標紅斜線，提醒這一天排不完
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0"
            style={{ top: RULER_BASE_HEIGHT_PX, backgroundImage: 'repeating-linear-gradient(135deg, rgba(239,68,68,0.10) 0 6px, transparent 6px 12px)' }}
            aria-hidden
          />
        )}

        {shown.length === 0 && (
          <div className="pointer-events-none absolute inset-x-2 top-3 rounded border border-dashed border-slate-700 px-2 py-3 text-center text-[11px] text-slate-500">
            {entries.length > 0 ? `${entries.length} 張已完成（已隱藏）` : canDrag ? `拖到這裡＝排到 ${lane.name}` : '這條線還沒有排定項目'}
          </div>
        )}
        {shown.map(({ bc, layout }) => (
          <LaneCard
            key={bc.placementId}
            bc={bc}
            layout={layout}
            scale={scale}
            today={today}
            editable={editable}
            canDrag={canDrag}
            canResize={canResize}
            handlers={handlerMap.get(bc.placementId)!}
            onOpenOrder={onOpenOrder}
            onOpenDetail={onOpenDetail}
            onResize={onResize}
            onResizing={onResizing}
          />
        ))}
      </div>

      {/* 拖曳中不能放：斜線底紋＋原因 */}
      {blocked && (
        <div
          className="pointer-events-none absolute inset-0 z-20 flex items-start justify-center bg-slate-950/60 pt-24"
          style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgba(148,163,184,0.12) 0 8px, transparent 8px 16px)' }}
        >
          <span className="mx-1 rounded border border-slate-600 bg-slate-900/90 px-1.5 py-1 text-[10px] text-slate-300">{blocked}</span>
        </div>
      )}
    </div>
  )
}
