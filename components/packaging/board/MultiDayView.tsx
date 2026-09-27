'use client'

// 週／兩週檢視（D56／D60）：每日一欄，欄＝droppable `day:日期`（日與日之間拖移、從待排池拖入、拖回待排區都照舊）。
// - 週（欄寬約 168px）：排定卡＝簡化卡片 sm（同左側 7 項，字小、長文字截斷），在欄內由上往下排；欄頭有已排／可用負荷條
// - 兩週（欄寬約 80px）：7 項放不下 → 迷你卡（單號＋數量＋左側色條），欄頭負荷條加粗（重點是看哪天滿了）
// 所有卡片：點卡片＝卡片詳情、點單號＝訂單詳情（D61）；右鍵選單照舊。
// 點欄頭日期 → 跳到該日的「日」檢視；欄頭右側小按鈕開產能設定。

import { useDroppable } from '@dnd-kit/core'
import { cardSizeFor, hiddenDoneText } from '@/lib/packaging/boardView'
import type { BoardCard, BoardDay, YMD } from '@/lib/packaging/scheduleTypes'
import { dropBlockedReason, type DragRule } from './boardLocal'
import { md } from './boardFormat'
import CapacityBar from './CapacityBar'
import type { CardMenuHandlers } from './cardMenu'
import { useHandlerMap } from './cardParts'
import PlacementCard from './PlacementCard'

interface ColumnProps {
  day: BoardDay
  /** 兩週檢視（迷你卡） */
  dense: boolean
  today: YMD
  dragRule: DragRule | null
  editable: boolean
  canDrag: boolean
  /** 換檢視／換段載入中：畫面上是舊資料 → 欄不接受放下（遮罩擋不住 dnd-kit） */
  stale: boolean
  hideCompleted: boolean
  handlersFor: (bc: BoardCard, siblings: BoardCard[]) => CardMenuHandlers
  onOpenOrder: (so: string) => void
  onOpenDetail: (bc: BoardCard) => void
  onPickDay: (date: YMD) => void
  onEditCapacity: (date: YMD) => void
}

function DayCol({ day, dense, today, dragRule, editable, canDrag, stale, hideCompleted, handlersFor, onOpenOrder, onOpenDetail, onPickDay, onEditCapacity }: ColumnProps) {
  const blocked = dropBlockedReason(dragRule, day.date)
  const { setNodeRef, isOver } = useDroppable({ id: `day:${day.date}`, disabled: !!blocked || stale })
  const handlerMap = useHandlerMap(day.cards, handlersFor)
  const isSat = day.kind === 'saturday_ot'
  const shown = hideCompleted ? day.cards.filter(c => !c.completed) : day.cards
  const doneCount = day.cards.length - day.cards.filter(c => !c.completed).length
  const cap = day.capacity
  const hiddenText = hiddenDoneText(day.cards.length, shown.length)
  const cardSize = cardSizeFor(dense ? 'twoWeek' : 'week')

  return (
    <section
      ref={setNodeRef}
      aria-label={`${day.label} 欄`}
      className={`relative flex h-full min-h-0 flex-1 shrink-0 flex-col rounded-lg border ${dense ? 'min-w-[80px]' : 'min-w-[168px]'} ${
        day.isToday ? 'border-sky-600/70' : isSat ? 'border-amber-700/60' : 'border-slate-700'
      } ${isOver ? 'bg-sky-950/40 ring-2 ring-sky-500/60' : 'bg-slate-950/50'}`}
    >
      <div className={`shrink-0 rounded-t-lg border-b border-slate-700 py-1.5 ${dense ? 'px-1' : 'px-2'} ${
        day.isToday ? 'bg-sky-950/70' : isSat ? 'bg-amber-950/50' : 'bg-slate-900'
      }`}>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPickDay(day.date)}
            title={`${day.label}${day.isToday ? '（今天）' : ''}${isSat ? '（週六加班）' : ''}：切到這一天的「日」檢視`}
            className={`min-w-0 truncate rounded px-0.5 text-left font-bold hover:bg-slate-800 hover:underline ${dense ? 'text-[13px]' : 'text-sm'} ${day.isToday ? 'text-sky-200' : 'text-slate-100'}`}
          >{dense ? <>{md(day.date)}<span className="ml-px text-[10px] font-normal text-slate-400">{day.label.slice(-2, -1)}</span></> : day.label}</button>
          {day.isToday && !dense && <span className="shrink-0 rounded bg-sky-600 px-1 text-[9px] font-bold text-white">今天</span>}
          {isSat && !dense && <span className="shrink-0 rounded bg-amber-600/80 px-1 text-[9px] font-bold text-white">週六加班</span>}
          <span className="flex-1" />
          {!dense && (
            <span className="shrink-0 text-[11px] text-slate-400">{cap.headcount != null ? `${cap.headcount} 人` : ''}</span>
          )}
          <button
            type="button"
            onClick={() => onEditCapacity(day.date)}
            title={editable ? '設定這天的人數與工時' : '查看這天的產能設定'}
            aria-label="產能設定"
            className={`shrink-0 rounded text-[11px] text-slate-400 hover:bg-slate-800 hover:text-white ${dense ? 'px-0.5' : 'px-1'}`}
          >⚙</button>
        </div>
        <div className="mt-1">
          <CapacityBar used={day.usedMinutes} cap={cap} load={day.load} unknownCards={dense ? 0 : day.unknownMinutesCards} saturday={isSat} size={dense ? 'lg' : 'md'} />
        </div>
        {!dense && (
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-400">
            <span>{day.cards.length} 張{doneCount > 0 ? `（完成 ${doneCount}）` : ''}</span>
            {day.rolledInCount > 0 && <span className="font-semibold text-orange-300">含順延 {day.rolledInCount}</span>}
            {cap.source === 'inherited' && cap.inheritedFrom && <span className="text-slate-500">沿用 {md(cap.inheritedFrom)}</span>}
          </div>
        )}
      </div>

      <div className={`eip-scrollbar min-h-0 flex-1 overflow-y-auto ${dense ? 'space-y-1 p-1' : 'space-y-1.5 p-1'}`}>
        {shown.length === 0 ? (
          <div
            className="m-0.5 flex h-12 items-center justify-center rounded border border-dashed border-slate-800 px-0.5 text-center text-[10px] leading-3 text-slate-600"
            title={hiddenText ?? undefined}
          >
            {hiddenText ? (dense ? `${day.cards.length} 張已完成` : hiddenText) : canDrag ? '拖到這裡' : '—'}
          </div>
        ) : shown.map(bc => (
          <PlacementCard
            key={bc.placementId}
            bc={bc}
            today={today}
            size={cardSize}
            editable={editable}
            canDrag={canDrag}
            handlers={handlerMap.get(bc.placementId)!}
            onOpenOrder={onOpenOrder}
            onOpenDetail={onOpenDetail}
          />
        ))}
      </div>

      {blocked && (
        <div
          className="pointer-events-none absolute inset-0 z-20 flex items-start justify-center rounded-lg bg-slate-950/60 pt-20"
          style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgba(148,163,184,0.12) 0 8px, transparent 8px 16px)' }}
        >
          <span className="mx-1 rounded border border-slate-600 bg-slate-900/90 px-1.5 py-1 text-[10px] text-slate-300">{blocked}</span>
        </div>
      )}
    </section>
  )
}

export default function MultiDayView({ days, dense, ...rest }: Omit<ColumnProps, 'day'> & { days: BoardDay[] }) {
  return (
    <div className="flex h-full min-h-0 gap-2 overflow-x-auto pb-1">
      {days.map(d => <DayCol key={d.date} day={d} dense={dense} {...rest} />)}
    </div>
  )
}
