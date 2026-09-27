'use client'

// 日期欄（D21 右半邊、D51）：欄頭（日期、星期、人數、已排／可用工時條）＋當天的卡。
// droppable id = `day:YYYY-MM-DD`。拖曳中若這天不能放（D22 預排卡早於預估可包日、區塊 3／5c），
// 以 disabled 的 droppable＋斜線底紋表示；伺服器仍會再驗一次。

import { useDroppable } from '@dnd-kit/core'
import type { BoardCard, BoardDay } from '@/lib/packaging/scheduleTypes'
import CapacityBar from './CapacityBar'
import DraggableCard, { type CardMenuHandlers } from './DraggableCard'
import { md } from './boardFormat'
import type { DragRule } from './boardLocal'

export function dropBlockedReason(rule: DragRule | null, date: string | null): string | null {
  if (!rule) return null
  if (rule.blocked) return rule.reason ?? '不能排'
  if (date && rule.minDate && date < rule.minDate) return rule.reason ?? `預估 ${md(rule.minDate)} 才可包`
  return null
}

/** 同欄同 SO 行有 ≥ 2 張未完成子卡 → 可合併 */
export function mergeCandidates(cards: BoardCard[], bc: BoardCard): BoardCard[] {
  if (bc.completed) return []
  return cards.filter(c => c.placementId !== bc.placementId && c.soLineKey === bc.soLineKey && !c.completed)
}

export default function DayColumn({
  day, today, dragRule, editable, canDrag, hideCompleted, handlersFor, onOpenOrder, onEditCapacity, changpingSyncLabel,
}: {
  day: BoardDay
  today: string
  /** 目前拖曳中卡片的限制；沒在拖曳為 null */
  dragRule: DragRule | null
  editable: boolean
  canDrag: boolean
  hideCompleted: boolean
  handlersFor: (bc: BoardCard, siblings: BoardCard[]) => CardMenuHandlers
  onOpenOrder: (so: string) => void
  onEditCapacity: (day: BoardDay) => void
  changpingSyncLabel?: string
}) {
  const blocked = dropBlockedReason(dragRule, day.date)
  const { setNodeRef, isOver } = useDroppable({ id: `day:${day.date}`, disabled: !!blocked })
  const cap = day.capacity
  const isSat = day.kind === 'saturday_ot'
  const shown = hideCompleted ? day.cards.filter(c => !c.completed) : day.cards
  const doneCount = day.cards.length - day.cards.filter(c => !c.completed).length

  const capHint = cap.source === 'inherited' && cap.inheritedFrom
    ? `沿用 ${md(cap.inheritedFrom)}`
    : cap.source === 'unset' ? '尚未設定產能' : null

  return (
    <section
      ref={setNodeRef}
      aria-label={`${day.label} 欄`}
      className={`relative flex w-full shrink-0 flex-col rounded-xl border lg:h-full lg:min-h-0 lg:w-[280px] ${
        day.isToday ? 'border-sky-600/70' : isSat ? 'border-amber-700/60' : 'border-slate-800'
      } ${isOver ? 'bg-sky-950/40 ring-2 ring-sky-500/60' : 'bg-slate-950/40'}`}
    >
      {/* ── 欄頭（點擊開產能編輯） ── */}
      <button
        type="button"
        onClick={() => onEditCapacity(day)}
        title={editable ? '點擊設定這天的人數與工時' : '點擊查看這天的產能設定'}
        className={`sticky top-0 z-10 w-full rounded-t-xl border-b border-slate-800 px-2.5 py-2 text-left backdrop-blur ${
          day.isToday ? 'bg-sky-950/80' : isSat ? 'bg-amber-950/60' : 'bg-slate-900/90'
        } hover:bg-slate-800/90`}
      >
        <div className="flex items-baseline gap-1.5">
          <span className={`text-base font-bold ${day.isToday ? 'text-sky-200' : 'text-slate-100'}`}>{day.label}</span>
          {day.isToday && <span className="rounded bg-sky-600 px-1 text-[10px] font-bold text-white">今天</span>}
          {isSat && <span className="rounded bg-amber-600/80 px-1 text-[10px] font-bold text-white">週六加班</span>}
          <span className="ml-auto text-[11px] text-slate-300">
            {cap.headcount != null ? `${cap.headcount} 人` : <span className="text-slate-500">人數 —</span>}
          </span>
        </div>
        <div className="mt-1">
          <CapacityBar used={day.usedMinutes} cap={cap} load={day.load} unknownCards={day.unknownMinutesCards} />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-2 text-[10px] text-slate-400">
          <span>{day.cards.length} 張{doneCount > 0 ? `（完成 ${doneCount}）` : ''}</span>
          {day.rolledInCount > 0 && <span className="font-semibold text-orange-300">含順延 {day.rolledInCount} 張</span>}
          {capHint && <span className={cap.source === 'unset' ? 'text-slate-500' : 'text-slate-500'}>{capHint}</span>}
        </div>
      </button>

      {/* ── 卡片 ── */}
      <div className="flex-1 space-y-3 p-2 lg:min-h-0 lg:overflow-y-auto">
        {shown.length === 0 ? (
          <div className="flex h-20 items-center justify-center rounded border border-dashed border-slate-800 text-[11px] text-slate-600">
            {canDrag ? '拖卡片到這裡' : '沒有卡片'}
          </div>
        ) : shown.map(bc => (
          <DraggableCard
            key={bc.placementId}
            bc={bc}
            today={today}
            editable={editable}
            canDrag={canDrag}
            onOpenOrder={onOpenOrder}
            handlers={handlersFor(bc, day.cards)}
            changpingSyncLabel={changpingSyncLabel}
          />
        ))}
      </div>

      {/* 拖曳中不能放的欄：斜線底紋＋原因 */}
      {blocked && (
        <div
          className="pointer-events-none absolute inset-0 z-20 flex items-start justify-center rounded-xl bg-slate-950/60 pt-24"
          style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgba(148,163,184,0.12) 0 8px, transparent 8px 16px)' }}
        >
          <span className="rounded border border-slate-600 bg-slate-900/90 px-2 py-1 text-[11px] text-slate-300">{blocked}</span>
        </div>
      )}
    </section>
  )
}
