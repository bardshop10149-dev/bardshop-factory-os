'use client'

// 日檢視（D62：拿掉時間尺，改成卡片牆）：一天的排定卡排成多欄格狀（auto-fill，每張至少約 260px），
// 順序＝伺服器固定排序（§3.6：延誤 → 預排到期 → 打樣 → 交期 → 建立時間），由左到右、由上到下。
// 頂部：日期、人數、正常／加班上限，以及負荷進度條（CapacityBar xl：超過正常變橘、超過加班上限變紅，
// 條上標出 19:00＝正常工時滿載、24:00＝加班上限，並顯示「預計約做到幾點」保留時間感）。
//
// 拖放：
//   整面卡片牆＝droppable `day:日期`（從待排池拖進來＝排到這天；拖回待排池／待排區照舊）。
//   「移到前一個／後一個工作日」是卡片牆上方的兩個 droppable——
//   它們和卡片牆是兄弟而不是巢狀：兩個 droppable 巢狀時 pointerWithin 會同時命中、目標不確定。
//   這一條平常就佔著位置（沒拖曳時是淡色的「◀ 前一天／後一天 ▶」按鈕），拖曳開始時才不會插進一列把卡片往下推。
//   換日載入中（stale）所有 droppable 都關掉：遮罩只擋畫面、擋不住 dnd-kit。
// API 沒有「排序」欄位，所以日內不能拖曳調整順序（要做需新增欄位）。

import type { ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'
import type { BoardCard, BoardDay, YMD } from '@/lib/packaging/scheduleTypes'
import { cardSizeFor, hiddenDoneText, hoursText } from '@/lib/packaging/boardView'
import { dropBlockedReason, type DragRule } from './boardLocal'
import { md, mdw } from './boardFormat'
import CapacityBar from './CapacityBar'
import type { CardMenuHandlers } from './cardMenu'
import { useHandlerMap } from './cardParts'
import PlacementCard from './PlacementCard'

/**
 * 卡片牆上方的「前／後一個工作日」：拖曳中＝放置區（放下＝移到那天）；平常＝淡色的換日按鈕。
 * 高度固定（h-7），兩種狀態切換時版面不跳。
 */
function NavDrop({ date, dir, dragRule, dragging, stale, onGo }: {
  date: YMD
  dir: 'prev' | 'next'
  dragRule: DragRule | null
  dragging: boolean
  stale: boolean
  onGo: (date: YMD) => void
}) {
  const blocked = dropBlockedReason(dragRule, date)
  const { setNodeRef, isOver } = useDroppable({ id: `day:${date}`, disabled: !!blocked || stale })
  const arrowL = dir === 'prev' ? '◀ ' : ''
  const arrowR = dir === 'next' ? ' ▶' : ''
  return (
    <div
      ref={setNodeRef}
      className={`flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border border-dashed px-3 text-xs ${
        !dragging ? 'border-transparent'
          : blocked || stale ? 'border-slate-700 text-slate-600'
            : isOver ? 'border-sky-400 bg-sky-950/60 text-sky-100' : 'border-sky-700 text-sky-300'
      }`}
    >
      {dragging ? (
        <>
          {`${arrowL}放到${dir === 'prev' ? '前' : '後'}一個工作日 ${mdw(date)}${arrowR}`}
          {blocked && <span className="text-[10px]">（{blocked}）</span>}
        </>
      ) : (
        <button
          type="button"
          onClick={() => onGo(date)}
          className="truncate rounded px-2 text-[11px] text-slate-500 hover:bg-slate-800 hover:text-slate-200"
          title="換到這一天（拖曳時這裡是放置區：放下＝移到這一天）"
        >{`${arrowL}${mdw(date)}${arrowR}`}</button>
      )}
    </div>
  )
}

export default function DayCardWall({
  day, today, prevDate, nextDate, dragRule, dragging, editable, canDrag, stale, hideCompleted, handlersFor, onOpenOrder, onOpenDetail, onEditCapacity, onGoDate, loadingOverlay,
}: {
  day: BoardDay
  today: YMD
  /** 前／後一個工作台日期（拖曳中出現放置區）；前一天早於今天為 null */
  prevDate: YMD | null
  nextDate: YMD | null
  dragRule: DragRule | null
  dragging: boolean
  editable: boolean
  canDrag: boolean
  /** 換日載入中：畫面上是舊的那一天 → 所有放置區關閉 */
  stale: boolean
  hideCompleted: boolean
  handlersFor: (bc: BoardCard, siblings: BoardCard[]) => CardMenuHandlers
  onOpenOrder: (so: string) => void
  onOpenDetail: (bc: BoardCard) => void
  onEditCapacity: (date: YMD) => void
  /** 點「◀ 前一天／後一天 ▶」換日 */
  onGoDate: (date: YMD) => void
  /** 換日載入中（資料還是舊的那一天）時蓋在卡片牆上的提示 */
  loadingOverlay?: ReactNode
}) {
  const blocked = dropBlockedReason(dragRule, day.date)
  const { setNodeRef, isOver } = useDroppable({ id: `day:${day.date}`, disabled: !!blocked || stale })
  const handlerMap = useHandlerMap(day.cards, handlersFor)
  const cap = day.capacity
  const isSat = day.kind === 'saturday_ot'
  const shown = hideCompleted ? day.cards.filter(c => !c.completed) : day.cards
  const doneCount = day.cards.length - day.cards.filter(c => !c.completed).length
  const capHint = cap.source === 'inherited' && cap.inheritedFrom ? `產能沿用 ${md(cap.inheritedFrom)}` : null
  const regularText = isSat ? '0' : hoursText(cap.regularMinutes)
  const overtimeText = hoursText(cap.overtimeMinutes)
  const hiddenText = hiddenDoneText(day.cards.length, shown.length)
  const cardSize = cardSizeFor('day')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* ── 前／後一個工作日（平常＝換日按鈕，拖曳中＝放置區；一直佔位，拖曳開始時卡片牆不會跳） ── */}
      {(prevDate || nextDate) && (
        <div className="flex shrink-0 gap-2">
          {prevDate
            ? <NavDrop date={prevDate} dir="prev" dragRule={dragRule} dragging={dragging} stale={stale} onGo={onGoDate} />
            : <div className="h-7 flex-1" />}
          {nextDate
            ? <NavDrop date={nextDate} dir="next" dragRule={dragRule} dragging={dragging} stale={stale} onGo={onGoDate} />
            : <div className="h-7 flex-1" />}
        </div>
      )}

      <section
        ref={setNodeRef}
        aria-label={`${day.label} 排程`}
        className={`relative flex min-h-[16rem] flex-1 flex-col overflow-hidden rounded-xl border lg:min-h-0 ${
          day.isToday ? 'border-sky-600/70' : isSat ? 'border-amber-700/60' : 'border-slate-700'
        } ${isOver ? 'ring-2 ring-sky-500/70' : ''}`}
      >
        {/* ── 頂部：日期、人數、正常／加班上限、負荷進度條（D62） ── */}
        <div className={`shrink-0 space-y-2 border-b border-slate-700 px-3 py-2 ${
          day.isToday ? 'bg-sky-950/60' : isSat ? 'bg-amber-950/50' : 'bg-slate-900'
        }`}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <div className="flex items-baseline gap-1.5">
              <span className={`text-lg font-bold ${day.isToday ? 'text-sky-200' : 'text-slate-100'}`}>{day.label}</span>
              {day.isToday && <span className="rounded bg-sky-600 px-1 text-[10px] font-bold text-white">今天</span>}
              {isSat && <span className="rounded bg-amber-600/80 px-1 text-[10px] font-bold text-white">週六加班</span>}
            </div>
            <dl className="flex flex-wrap items-baseline gap-x-3 text-xs tabular-nums text-slate-300">
              <div><dt className="inline text-slate-500">人數 </dt><dd className="inline font-semibold">{cap.headcount ?? '—'}</dd></div>
              <div><dt className="inline text-slate-500">正常 </dt><dd className="inline font-semibold">{regularText != null ? `${regularText}h` : '—'}</dd></div>
              <div><dt className="inline text-slate-500">加班上限 </dt><dd className="inline font-semibold">{overtimeText != null ? `${overtimeText}h` : '—'}</dd></div>
              {capHint && <div className="text-[11px] text-slate-500">{capHint}</div>}
            </dl>
            <div className="flex flex-wrap gap-x-2 text-[11px] text-slate-400">
              <span>{day.cards.length} 張{doneCount > 0 ? `（完成 ${doneCount}）` : ''}</span>
              {day.rolledInCount > 0 && <span className="font-semibold text-orange-300">含順延 {day.rolledInCount} 張</span>}
            </div>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => onEditCapacity(day.date)}
              className="rounded border border-slate-600 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-800"
            >{editable ? '設定產能' : '查看產能'}</button>
          </div>
          <div className="max-w-3xl">
            <CapacityBar used={day.usedMinutes} cap={cap} load={day.load} unknownCards={day.unknownMinutesCards} saturday={isSat} size="xl" />
          </div>
        </div>

        {/* ── 卡片牆（多欄格狀，依伺服器排序由左到右、由上到下） ── */}
        <div className="eip-scrollbar min-h-0 flex-1 overflow-y-auto bg-slate-950 p-2">
          {shown.length === 0 ? (
            <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-slate-700 text-xs text-slate-500">
              {hiddenText ?? (canDrag ? '從左側待排池拖到這裡＝排到這一天' : '這一天還沒有排定項目')}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] content-start gap-2">
              {shown.map(bc => (
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
          )}
        </div>

        {/* 拖曳中不能放：斜線底紋＋原因 */}
        {blocked && (
          <div
            className="pointer-events-none absolute inset-0 z-30 flex items-start justify-center bg-slate-950/60 pt-24"
            style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgba(148,163,184,0.12) 0 8px, transparent 8px 16px)' }}
          >
            <span className="rounded border border-slate-600 bg-slate-900/90 px-2 py-1 text-[11px] text-slate-300">{blocked}</span>
          </div>
        )}
        {loadingOverlay}
      </section>
    </div>
  )
}
