'use client'

// D21 待排區：主管「刻意擱置、先不排日期」的卡（plan_date = null）。
// droppable id = 'holding'。待排池卡拖進來＝place(toDate:null)；日期欄的卡拖進來＝move(toDate:null)。

import { useDroppable } from '@dnd-kit/core'
import type { BoardCard } from '@/lib/packaging/scheduleTypes'
import DraggableCard, { type CardMenuHandlers } from './DraggableCard'
import type { DragRule } from './boardLocal'

export default function ParkingArea({ cards, today, dragRule, editable, canDrag, hideCompleted, handlersFor, onOpenOrder, changpingSyncLabel }: {
  cards: BoardCard[]
  today: string
  dragRule: DragRule | null
  editable: boolean
  canDrag: boolean
  hideCompleted: boolean
  handlersFor: (bc: BoardCard, siblings: BoardCard[]) => CardMenuHandlers
  onOpenOrder: (so: string) => void
  changpingSyncLabel?: string
}) {
  const blocked = dragRule?.blocked ? (dragRule.reason ?? '不能排') : null
  const { setNodeRef, isOver } = useDroppable({ id: 'holding', disabled: !!blocked })
  const shown = hideCompleted ? cards.filter(c => !c.completed) : cards

  return (
    <section
      ref={setNodeRef}
      className={`rounded-xl border ${isOver ? 'border-sky-500 bg-sky-950/40' : 'border-slate-700 bg-slate-900/60'} ${blocked ? 'opacity-50' : ''}`}
    >
      <div className="flex items-baseline gap-2 border-b border-slate-800 px-3 py-2">
        <h3 className="text-sm font-bold text-slate-100">待排區</h3>
        <span className="text-[11px] text-slate-400">主管擱置、先不排日期（{cards.length}）</span>
      </div>
      <div className="space-y-3 p-2">
        {shown.length === 0 ? (
          <p className="rounded border border-dashed border-slate-800 px-2 py-4 text-center text-[11px] text-slate-500">
            {canDrag ? '拖到這裡＝先擱置，不排日期' : '目前沒有擱置的卡'}
          </p>
        ) : shown.map(bc => (
          <DraggableCard
            key={bc.placementId}
            bc={bc}
            today={today}
            editable={editable}
            canDrag={canDrag}
            onOpenOrder={onOpenOrder}
            handlers={handlersFor(bc, cards)}
            changpingSyncLabel={changpingSyncLabel}
          />
        ))}
      </div>
    </section>
  )
}
