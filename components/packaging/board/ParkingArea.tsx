'use client'

// D21 待排區：主管「刻意擱置、先不排日期」的卡（plan_date = null）。
// droppable id = 'holding'。待排池卡拖進來＝place(toDate:null)；日期欄的卡拖進來＝move(toDate:null)。
// D60：用排定卡（PlacementCard md，外觀＝待排池的簡化卡片），網格同待排池——左欄拉寬後自動變兩欄以上。
// 點卡片＝卡片詳情、點單號＝訂單詳情（D61）；右鍵選單、拖曳照舊。

import { useDroppable } from '@dnd-kit/core'
import { hiddenDoneText } from '@/lib/packaging/boardView'
import type { BoardCard } from '@/lib/packaging/scheduleTypes'
import type { DragRule } from './boardLocal'
import type { CardMenuHandlers } from './cardMenu'
import { useHandlerMap } from './cardParts'
import PlacementCard from './PlacementCard'

export default function ParkingArea({ cards, today, dragRule, editable, canDrag, hideCompleted, handlersFor, onOpenOrder, onOpenDetail }: {
  cards: BoardCard[]
  today: string
  dragRule: DragRule | null
  editable: boolean
  canDrag: boolean
  hideCompleted: boolean
  handlersFor: (bc: BoardCard, siblings: BoardCard[]) => CardMenuHandlers
  onOpenOrder: (so: string) => void
  onOpenDetail: (bc: BoardCard) => void
}) {
  const blocked = dragRule?.blocked ? (dragRule.reason ?? '不能排') : null
  const { setNodeRef, isOver } = useDroppable({ id: 'holding', disabled: !!blocked })
  const shown = hideCompleted ? cards.filter(c => !c.completed) : cards
  const handlerMap = useHandlerMap(cards, handlersFor)

  return (
    <section
      ref={setNodeRef}
      className={`rounded-xl border ${isOver ? 'border-sky-500 bg-sky-950/40' : 'border-slate-700 bg-slate-900/60'} ${blocked ? 'opacity-50' : ''}`}
    >
      <div className="flex items-baseline gap-2 border-b border-slate-800 px-3 py-2">
        <h3 className="text-sm font-bold text-slate-100">待排區</h3>
        <span className="text-[11px] text-slate-400">主管擱置、先不排日期（{cards.length}）</span>
      </div>
      <div className="p-1.5">
        {shown.length === 0 ? (
          <p className="rounded border border-dashed border-slate-800 px-2 py-4 text-center text-[11px] text-slate-500">
            {hiddenDoneText(cards.length, shown.length) ?? (canDrag ? '拖到這裡＝先擱置，不排日期' : '目前沒有擱置的卡')}
          </p>
        ) : (
          // 同待排池：min(260px,100%)——左欄拉到最窄時一欄縮成可用寬度，不裁切卡片
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-1.5">
            {shown.map(bc => (
              <PlacementCard
                key={bc.placementId}
                bc={bc}
                today={today}
                // 待排區不是檢視（沒有 cardSizeFor 對應）：固定用完整簡化卡，和左側待排池同寬同樣
                size="md"
                editable={editable}
                canDrag={canDrag}
                handlers={handlerMap.get(bc.placementId)!}
                onOpenOrder={onOpenOrder}
                onOpenDetail={onOpenDetail}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
