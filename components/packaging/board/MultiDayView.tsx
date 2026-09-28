'use client'

// 週／兩週檢視（D56／D60；分線輪 D67／D72）：每天一欄，欄內再分「各線小欄」。
// - 週：每線 min 150px（3 線＝450px／天），排定卡＝簡化卡片 sm
// - 兩週：每線 min 64px，排定卡＝迷你卡（單號＋數量＋左側色條），欄頭負荷條加粗（重點是看哪天、哪條線滿了）
// 整個區域橫向捲動（D67「縮成週／兩週時單日的線顯示範圍要加寬」）。
//
// 拖放（兩種 droppable 是兄弟、不巢狀：巢狀時 pointerWithin 會同時命中、目標不確定）：
//   欄頭 `day:${date}`       → 自動選線（D72：當天正常工時剩餘最多的線；pickAutoLane），拖曳中提示「放開＝自動放到 B 線（剩 3.5h）」
//   各線小欄 `lane:${date}:${lineId}` → 指定線
// 所有卡片：點卡片＝卡片詳情、點單號＝訂單詳情（D61）；右鍵選單照舊。點欄頭日期 → 跳到該日的「日」檢視。
//
// D100 線內拖曳插隊（原本只有日檢視 D74 能插隊，這裡拖回自己那格會被當成「移到同日同線」而沒反應）：
//   - 各線小欄的卡片清單加 data-lane-list＝`${date}:${lineId}`、每張卡外包一層 data-lane-item＝placementId：
//     BoardLayout／SimLayout 拖曳中量這些元素的位置（laneDrag.measureLaneItems）換算插入點，不必把每張卡做成 droppable。
//   - reorderHint：插入線（beforeId＝畫在那張卡上方；null＝最後一張下方；append＝從別處拖進來、放在最後）。
//   - ownLaneKey：被拖的卡自己那格不套 D22 的日期限制（同線重排不改日期，同日檢視 LaneColumn 的 ownLane）。
//   以上都是選填：不傳時畫面與原本相同（data-* 屬性不影響外觀；外包的 div 沒有樣式，只是 relative 定位）。
// D100 產能入口：欄頭原本只有一個 ⚙（Snow：「縮成小圖示看不懂」）→ 改文字按鈕「設定產能／查看產能」（兩週：「產能」）；
//   兩週的小欄頭也顯示已排時數。capacityReadOnly（模擬區沿用正式產能、只能看）→ 一律「查看產能」。

import { useDroppable } from '@dnd-kit/core'
import { cardSizeFor, hiddenDoneText, hoursText } from '@/lib/packaging/boardView'
import type { BoardCard, BoardDay, BoardLane, YMD } from '@/lib/packaging/scheduleTypes'
import { weekendName } from '@/lib/packaging/scheduleCalendar'
import { autoLaneFor, dropBlockedReason, type DragRule } from './boardLocal'
import { dropLineLabel, type LaneReorderHint } from './laneDrag'
import { md } from './boardFormat'
import CapacityBar from './CapacityBar'
import type { CardMenuHandlers } from './cardMenu'
import { useHandlerMap } from './cardParts'
import PlacementCard from './PlacementCard'

/** 各線小欄最小寬度（週／兩週） */
const LANE_MIN_PX = { week: 150, twoWeek: 64 } as const

/** 拖曳中的卡（欄頭提示「放開＝自動放到哪條線」用）；null＝沒在拖 */
export interface MultiDragInfo {
  /** 排定卡的 placementId（它本來就在這天時要把自己的工時加回原線）；待排池卡 null */
  placementId: string | null
}

interface CommonProps {
  /** 兩週檢視（迷你卡） */
  dense: boolean
  today: YMD
  dragRule: DragRule | null
  drag: MultiDragInfo | null
  defaultLineId: number | null
  editable: boolean
  canDrag: boolean
  /** 換檢視／換段載入中：畫面上是舊資料 → 不接受放下（遮罩擋不住 dnd-kit） */
  stale: boolean
  hideCompleted: boolean
  handlersFor: (bc: BoardCard, siblings: BoardCard[]) => CardMenuHandlers
  onOpenOrder: (so: string) => void
  onOpenDetail: (bc: BoardCard) => void
  onPickDay: (date: YMD) => void
  onEditCapacity: (date: YMD, lineId?: number) => void
  /** D100 拖曳中的插入線（laneKey＝`${date}:${lineId}`）；不傳＝不畫 */
  reorderHint?: LaneReorderHint | null
  /** D100 被拖的排定卡所在的線（`${date}:${lineId}`）：同線重排不套日期限制 */
  ownLaneKey?: string | null
  /** D100 產能只能看（模擬區沿用正式產能）：入口一律寫「查看產能」 */
  capacityReadOnly?: boolean
}

/** 欄頭（droppable day:日期＝自動選線） */
function DayHeader({ day, dense, blocked, stale, drag, defaultLineId, editable, capacityReadOnly, onPickDay, onEditCapacity }: {
  day: BoardDay
  dense: boolean
  blocked: string | null
  stale: boolean
  drag: MultiDragInfo | null
  defaultLineId: number | null
  editable: boolean
  capacityReadOnly: boolean
  onPickDay: (date: YMD) => void
  onEditCapacity: (date: YMD, lineId?: number) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${day.date}`, disabled: !!blocked || stale })
  const canSetCap = editable && !capacityReadOnly
  const isWeekendOt = day.kind === 'weekend_ot'
  const cap = day.capacity
  const doneCount = day.cards.filter(c => c.completed).length

  // 拖曳中：放開會落在哪條線（同 BoardLayout.onDragEnd 的算法）
  let autoHint: string | null = null
  if (drag && !blocked && !stale) {
    const id = autoLaneFor(day, drag.placementId ? { placementId: drag.placementId } : null, defaultLineId)
    const lane = day.lanes?.find(l => l.lineId === id)
    if (lane) {
      const own = drag.placementId ? day.cards.find(c => c.placementId === drag.placementId && c.laneId === lane.lineId) : undefined
      const rem = lane.remainingMinutes == null ? null : lane.remainingMinutes + (own?.minutes ?? 0)
      autoHint = dense
        ? `→${lane.code}`
        : `放開＝自動放到 ${lane.name}${rem == null ? '（未設定產能）' : `（剩 ${hoursText(rem)}h）`}`
    }
  }

  return (
    <div
      ref={setNodeRef}
      className={`shrink-0 rounded-t-lg border-b border-slate-700 py-1.5 ${dense ? 'px-1' : 'px-2'} ${
        isOver ? 'bg-sky-900/80 ring-2 ring-inset ring-sky-400'
          : day.isToday ? 'bg-sky-950/70' : isWeekendOt ? 'bg-amber-950/50' : 'bg-slate-900'
      }`}
    >
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPickDay(day.date)}
          title={`${day.label}${day.isToday ? '（今天）' : ''}${isWeekendOt ? `（${weekendName(day.date)}加班）` : ''}：切到這一天的「日」檢視`}
          className={`min-w-0 truncate rounded px-0.5 text-left font-bold hover:bg-slate-800 hover:underline ${dense ? 'text-[13px]' : 'text-sm'} ${day.isToday ? 'text-sky-200' : 'text-slate-100'}`}
        >{dense ? <>{md(day.date)}<span className="ml-px text-[10px] font-normal text-slate-400">{day.label.slice(-2, -1)}</span></> : day.label}</button>
        {day.isToday && !dense && <span className="shrink-0 rounded bg-sky-600 px-1 text-[9px] font-bold text-white">今天</span>}
        {isWeekendOt && !dense && <span className="shrink-0 rounded bg-amber-600/80 px-1 text-[9px] font-bold text-white">{weekendName(day.date)}加班</span>}
        <span className="flex-1" />
        {autoHint && <span className={`shrink-0 truncate text-[10px] ${isOver ? 'font-semibold text-sky-100' : 'text-sky-300'}`}>{autoHint}</span>}
        <button
          type="button"
          onClick={() => onEditCapacity(day.date)}
          title={capacityReadOnly ? '查看這天各線的正常／加班時數（模擬區沿用正式產能，只能看）'
            : canSetCap ? '設定這天各線的正常／加班時數' : '查看這天的產能設定'}
          aria-label={canSetCap ? '設定產能' : '查看產能'}
          className="shrink-0 rounded border border-slate-600 px-1 text-[10px] leading-4 text-slate-300 hover:bg-slate-800 hover:text-white"
        >{dense ? '產能' : canSetCap ? '設定產能' : '查看產能'}</button>
      </div>
      <div className="mt-1">
        {/* 整天（D71 總時數＝各線加總） */}
        <CapacityBar used={day.usedMinutes} cap={cap} load={day.load} unknownCards={dense ? 0 : day.unknownMinutesCards} weekend={isWeekendOt} size={dense ? 'lg' : 'md'} />
      </div>
      {!dense && (
        <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-slate-400">
          <span>{day.cards.length} 張{doneCount > 0 ? `（完成 ${doneCount}）` : ''}</span>
          {day.rolledInCount > 0 && <span className="font-semibold text-orange-300">含順延 {day.rolledInCount}</span>}
          {cap.source === 'inherited' && cap.inheritedFrom && <span className="text-slate-500">沿用 {md(cap.inheritedFrom)}</span>}
        </div>
      )}
    </div>
  )
}

/** 一天裡的一條線（droppable lane:日期:線） */
function LaneCol({
  day, lane, cards, blocked, blockedOverlay, stale, dense, today, editable, canDrag, hideCompleted, handlerMap, onOpenOrder, onOpenDetail, onEditCapacity,
  dropLine, capacityReadOnly,
}: {
  day: BoardDay
  lane: BoardLane
  cards: BoardCard[]
  blocked: string | null
  /** D100：這天含被拖的卡自己那格時，不能放的遮罩改由各線自己畫（自己那格不蓋） */
  blockedOverlay: boolean
  stale: boolean
  dense: boolean
  today: YMD
  editable: boolean
  canDrag: boolean
  hideCompleted: boolean
  handlerMap: Map<string, CardMenuHandlers>
  onOpenOrder: (so: string) => void
  onOpenDetail: (bc: BoardCard) => void
  onEditCapacity: (date: YMD, lineId?: number) => void
  /** D100 插入線（這條線的 reorderHint） */
  dropLine: LaneReorderHint | null
  capacityReadOnly: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `lane:${day.date}:${lane.lineId}`, disabled: !!blocked || stale })
  const laneKey = `${day.date}:${lane.lineId}`
  const shown = hideCompleted ? cards.filter(c => !c.completed) : cards
  const hiddenText = hiddenDoneText(cards.length, shown.length)
  const cardSize = cardSizeFor(dense ? 'twoWeek' : 'week')
  const unset = lane.capacity.source === 'unset'
  const used = hoursText(lane.usedMinutes) ?? '0.0'
  // D100 插入線畫在哪張卡上方（beforeId）；放到最後／從別處拖進來＝最後一張下方
  const lineBefore = dropLine && dropLine.mode === 'insert' ? dropLine.beforeId ?? null : null
  const lineAtEnd = !!dropLine && lineBefore == null
  const lastShownId = shown[shown.length - 1]?.placementId ?? null
  const lineText = dropLine && !dense ? dropLineLabel(dropLine.mode) : null

  return (
    <div
      ref={setNodeRef}
      aria-label={`${day.label} ${lane.name}`}
      className={`relative flex min-h-0 flex-1 basis-0 flex-col border-r border-slate-800 last:border-r-0 ${isOver ? 'bg-sky-950/50' : ''}`}
      style={{ minWidth: dense ? LANE_MIN_PX.twoWeek : LANE_MIN_PX.week }}
    >
      {/* 小欄頭：線名＋該線迷你負荷條 */}
      <button
        type="button"
        onClick={() => onEditCapacity(day.date, lane.lineId)}
        title={`${lane.name}：已排 ${used} h${unset ? '（未設定產能）' : ''}；點一下${editable && !capacityReadOnly ? '設定' : '查看'}這條線的產能`}
        className={`shrink-0 space-y-0.5 border-b border-slate-800 px-1 py-1 text-left hover:bg-slate-900 ${isOver ? 'bg-sky-900/60' : 'bg-slate-950/70'}`}
      >
        <div className="flex items-baseline gap-1 text-[10px] leading-3">
          <span className="min-w-0 truncate font-semibold text-slate-200">{dense ? lane.code : lane.name}</span>
          {/* D100：兩週也顯示已排時數（64px 寬放得下「A 3.5h」） */}
          <span className="ml-auto shrink-0 tabular-nums text-slate-400">{used}h</span>
        </div>
        <CapacityBar used={lane.usedMinutes} cap={lane.capacity} load={lane.load} unknownCards={0} weekend={day.kind === 'weekend_ot'} size="xs" />
      </button>
      <div data-lane-list={laneKey} className={`eip-scrollbar min-h-0 flex-1 overflow-y-auto ${dense ? 'space-y-1 p-0.5' : 'space-y-1.5 p-1'}`}>
        {shown.length === 0 ? (
          <div
            className="m-0.5 flex h-12 items-center justify-center rounded border border-dashed border-slate-800 px-0.5 text-center text-[10px] leading-3 text-slate-600"
            title={hiddenText ?? undefined}
          >
            {hiddenText ? (dense ? `${cards.length} 完成` : hiddenText) : canDrag ? (dense ? '拖入' : `拖到 ${lane.name}`) : '—'}
          </div>
        ) : shown.map(bc => (
          // D100：外包一層給拖曳中量位置（data-lane-item）與畫插入線（relative）；key 移到這層，PlacementCard 本身不變
          <div key={bc.placementId} data-lane-item={bc.placementId} className="relative">
            <PlacementCard
              bc={bc}
              today={today}
              size={cardSize}
              editable={editable}
              canDrag={canDrag}
              handlers={handlerMap.get(bc.placementId)!}
              onOpenOrder={onOpenOrder}
              onOpenDetail={onOpenDetail}
            />
            {(lineBefore === bc.placementId || (lineAtEnd && bc.placementId === lastShownId)) && (
              <DropLine at={lineBefore === bc.placementId ? 'top' : 'bottom'} dense={dense} label={lineText} />
            )}
          </div>
        ))}
      </div>

      {blockedOverlay && blocked && (
        <div
          className="pointer-events-none absolute inset-0 z-20 flex items-start justify-center bg-slate-950/60 pt-20"
          style={{ backgroundImage: 'repeating-linear-gradient(135deg, rgba(148,163,184,0.12) 0 8px, transparent 8px 16px)' }}
        >
          {!dense && <span className="mx-1 rounded border border-slate-600 bg-slate-900/90 px-1.5 py-1 text-[10px] text-slate-300">{blocked}</span>}
        </div>
      )}
    </div>
  )
}

/**
 * D100 插入線（同日檢視 LaneColumn 的 sky-400＋光暈）：畫在卡片外包層的上緣／下緣，落在卡片之間的間距裡，
 * 絕對定位、不佔版面，拖曳中卡片不會被推動。兩週（dense，64px 寬）只畫線不放文字。
 */
function DropLine({ at, dense, label }: { at: 'top' | 'bottom'; dense: boolean; label: string | null }) {
  return (
    <div
      className={`pointer-events-none absolute inset-x-0 z-20 h-0.5 rounded-full bg-sky-400 shadow-[0_0_0_2px_rgba(56,189,248,0.3)] ${
        // 落在卡片間距的正中間（週：space-y-1.5＋p-1、兩週：space-y-1＋p-0.5；第一張上方剛好是捲動容器的內距，不會被裁掉）
        at === 'top' ? (dense ? '-top-0.5' : '-top-1') : (dense ? '-bottom-0.5' : '-bottom-1')
      }`}
      aria-hidden
    >
      {label && <span className="absolute -top-2 right-0 rounded bg-sky-600 px-1 text-[9px] leading-4 text-white">{label}</span>}
    </div>
  )
}

function DayCol({ day, ...p }: CommonProps & { day: BoardDay }) {
  const blocked = dropBlockedReason(p.dragRule, day.date)
  // D100：被拖的卡自己那格在這天 → 那格不擋（同線重排不改日期），整天遮罩改由其他各線自己畫
  const ownHere = !!p.ownLaneKey && p.ownLaneKey.startsWith(`${day.date}:`)
  const handlerMap = useHandlerMap(day.cards, p.handlersFor)
  const isWeekendOt = day.kind === 'weekend_ot'
  const lanes = day.lanes ?? []
  const laneIds = new Set(lanes.map(l => l.lineId))
  // 卡片依 laneId 分到各線（順序沿用 day.cards 的伺服器排序）；不在任何 lane 的歸第一條線，不讓卡消失
  const byLane = new Map<number, BoardCard[]>(lanes.map(l => [l.lineId, []]))
  for (const c of day.cards) {
    const id = c.laneId != null && laneIds.has(c.laneId) ? c.laneId : lanes[0]?.lineId
    if (id != null) byLane.get(id)!.push(c)
  }
  const minW = Math.max(1, lanes.length) * (p.dense ? LANE_MIN_PX.twoWeek : LANE_MIN_PX.week)

  return (
    <section
      aria-label={`${day.label} 欄`}
      className={`relative flex h-full min-h-0 flex-1 shrink-0 flex-col rounded-lg border bg-slate-950/50 ${
        day.isToday ? 'border-sky-600/70' : isWeekendOt ? 'border-amber-700/60' : 'border-slate-700'
      }`}
      style={{ minWidth: minW }}
    >
      <DayHeader
        day={day}
        dense={p.dense}
        blocked={blocked}
        stale={p.stale}
        drag={p.drag}
        defaultLineId={p.defaultLineId}
        editable={p.editable}
        capacityReadOnly={!!p.capacityReadOnly}
        onPickDay={p.onPickDay}
        onEditCapacity={p.onEditCapacity}
      />
      {lanes.length === 0 ? (
        <div className="p-2 text-center text-[10px] text-slate-500">尚未取得產線資料</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {lanes.map(lane => {
            const laneKey = `${day.date}:${lane.lineId}`
            return (
              <LaneCol
                key={lane.lineId}
                day={day}
                lane={lane}
                cards={byLane.get(lane.lineId) ?? []}
                blocked={p.ownLaneKey === laneKey ? null : blocked}
                blockedOverlay={ownHere}
                stale={p.stale}
                dense={p.dense}
                today={p.today}
                editable={p.editable}
                canDrag={p.canDrag}
                hideCompleted={p.hideCompleted}
                handlerMap={handlerMap}
                onOpenOrder={p.onOpenOrder}
                onOpenDetail={p.onOpenDetail}
                onEditCapacity={p.onEditCapacity}
                dropLine={p.reorderHint?.laneKey === laneKey ? p.reorderHint : null}
                capacityReadOnly={!!p.capacityReadOnly}
              />
            )
          })}
        </div>
      )}

      {blocked && !ownHere && (
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

export default function MultiDayView({ days, ...rest }: CommonProps & { days: BoardDay[] }) {
  return (
    <div className="eip-scrollbar flex h-full min-h-0 gap-2 overflow-x-auto pb-1">
      {days.map(d => <DayCol key={d.date} day={d} {...rest} />)}
    </div>
  )
}
