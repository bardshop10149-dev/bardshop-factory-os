'use client'

// 日檢視（D68／D70，取代 D62 的卡片牆）：左側時間尺 10:00～24:00，每條啟用中的線一欄，卡片沿時間往下疊、長度＝工時。
//
// 版面：
//   ┌ ◀ 前一天（放置區）             後一天 ▶ ┐   ← 平常是換日按鈕，拖曳中是 droppable `day:日期`（自動選線，D72）
//   │ 9/29（二） 總計 已排 38.5／正常 45（+15）h  [設定產能] │
//   │ [整天負荷條 xl，刻度 10:00／19:00／24:00]            │
//   │ 時間 │ A 線 線頭（sticky） │ B 線 線頭 │ C 線 線頭 │   ← 一個捲動容器：線頭 sticky top、時間尺 sticky left
//   │10:00 │ 卡…                 │ 卡…       │           │
//   │19:00═╪═════════════════════╪═══════════╪═══════════│
//   │24:00 │                     │ 超出上限  │           │
//
// 每條線的卡＝day.cards 依 laneId 篩出（順序沿用伺服器 §3.6 固定排序），layoutLane 以該線 LaneScale 換算；
// 所有線本體同高（取各線最後一張卡底部與 24:00 的最大值），格線才對得齊。
// 寬度 < 1024px（手機／平板，不能拖）→ 各線上下堆疊、不畫時間尺（lines.md §5.2）。
// 換日載入中（stale）所有 droppable 關閉：遮罩只擋畫面、擋不住 dnd-kit。

import { useMemo, type ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'
import type { BoardCard, BoardDay, BoardLane, LaneScale, YMD } from '@/lib/packaging/scheduleTypes'
import { hiddenDoneText, hoursText } from '@/lib/packaging/boardView'
import { weekendName } from '@/lib/packaging/scheduleCalendar'
import { clockText, laneScale, layoutLane, workToClock } from '@/lib/packaging/laneTimeline'
import { dropBlockedReason, type DragRule } from './boardLocal'
import { md, mdw } from './boardFormat'
import CapacityBar from './CapacityBar'
import type { CardMenuHandlers } from './cardMenu'
import { useHandlerMap } from './cardParts'
import LaneColumn, { type LaneEntry } from './LaneColumn'
import PlacementCard from './PlacementCard'
import TimeRuler, { RULER_BASE_HEIGHT_PX, RULER_WIDTH_PX } from './TimeRuler'

/** 24:00（鐘面分鐘）：「最晚的線」超過就改寫「超過 24:00」 */
const RULER_END_CLOCK = 24 * 60

/** 最後一張卡底下留一點空間（放下提示、超出標籤） */
const BODY_PAD_PX = 24

/**
 * 「前／後一個工作日」：拖曳中＝放置區（放下＝移到那天）；平常＝淡色的換日按鈕。
 * 高度固定（h-7），兩種狀態切換時版面不跳。
 * 線別：日檢視只載入當天，前後一天各線剩多少不知道，沒辦法 pickAutoLane → BoardLayout.autoLane 退回
 * 「排定卡沿用原線（仍啟用時）、待排池的卡放預設線」；提示字照實際行為寫，不寫「剩餘最多」。
 */
function NavDrop({ date, dir, dragRule, dragging, stale, defaultLineName, onGo }: {
  date: YMD
  dir: 'prev' | 'next'
  dragRule: DragRule | null
  dragging: boolean
  stale: boolean
  defaultLineName: string | null
  onGo: (date: YMD) => void
}) {
  const lineHint = `排定卡沿用原線；待排池的卡放預設線${defaultLineName ? `（${defaultLineName}）` : ''}`
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
          <span className="truncate text-[10px] opacity-80" title={blocked ? undefined : lineHint}>{blocked ? `（${blocked}）` : '（沿用原線／預設線）'}</span>
        </>
      ) : (
        <button
          type="button"
          onClick={() => onGo(date)}
          className="truncate rounded px-2 text-[11px] text-slate-500 hover:bg-slate-800 hover:text-slate-200"
          title={`換到這一天（拖曳時這裡是放置區：放下＝移到這一天，${lineHint}）`}
        >{`${arrowL}${mdw(date)}${arrowR}`}</button>
      )}
    </div>
  )
}

interface LaneModel {
  lane: BoardLane
  scale: LaneScale
  entries: LaneEntry[]
  bottomPx: number
}

/** 各線的卡與版面（純計算；卡片不在任何 lane 的——理論上不會有——歸到第一條線，不讓卡從畫面消失） */
function buildLaneModels(day: BoardDay): LaneModel[] {
  const lanes = day.lanes ?? []
  if (lanes.length === 0) return []
  const ids = new Set(lanes.map(l => l.lineId))
  const byLane = new Map<number, BoardCard[]>(lanes.map(l => [l.lineId, []]))
  for (const c of day.cards) {
    const id = c.laneId != null && ids.has(c.laneId) ? c.laneId : lanes[0].lineId
    byLane.get(id)!.push(c)
  }
  return lanes.map(lane => {
    const cards = byLane.get(lane.lineId) ?? []
    const scale = laneScale(lane.capacity)
    const layouts = layoutLane(cards.map(c => ({ placementId: c.placementId, minutes: c.minutes })), scale)
    const entries = cards.map((bc, i) => ({ bc, layout: layouts[i] }))
    const last = layouts[layouts.length - 1]
    return { lane, scale, entries, bottomPx: last ? last.topPx + last.heightPx : 0 }
  })
}

export default function DayLanesView({
  day, today, prevDate, nextDate, dragRule, dragging, editable, canDrag, canResize, stale, stacked, hideCompleted,
  defaultLineName, handlersFor, onOpenOrder, onOpenDetail, onEditCapacity, onGoDate, onResize, onResizing, loadingOverlay,
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
  /** 可以拉卡片下緣改工時（持有編輯鎖＋桌機＋不是舊資料） */
  canResize: boolean
  /** 換日載入中：畫面上是舊的那一天 → 所有放置區關閉 */
  stale: boolean
  /** 窄螢幕：各線上下堆疊、不畫時間尺 */
  stacked: boolean
  hideCompleted: boolean
  /** 前後一天放置區的提示（那天沒載入，待排池的卡放預設線） */
  defaultLineName: string | null
  handlersFor: (bc: BoardCard, siblings: BoardCard[]) => CardMenuHandlers
  onOpenOrder: (so: string) => void
  onOpenDetail: (bc: BoardCard) => void
  /** lineId 有給＝從某條線的線頭 ⚙ 打開 */
  onEditCapacity: (date: YMD, lineId?: number) => void
  onGoDate: (date: YMD) => void
  onResize: (bc: BoardCard, newEffMinutes: number) => void
  /** 拉下緣開始／結束（暫停輪詢、略過 Undo 快捷鍵） */
  onResizing?: (active: boolean) => void
  loadingOverlay?: ReactNode
}) {
  const handlerMap = useHandlerMap(day.cards, handlersFor)
  const models = useMemo(() => buildLaneModels(day), [day])
  const bodyHeightPx = Math.max(RULER_BASE_HEIGHT_PX, ...models.map(m => m.bottomPx + BODY_PAD_PX))
  const cap = day.capacity
  const isWeekendOt = day.kind === 'weekend_ot'
  const doneCount = day.cards.filter(c => c.completed).length
  const regularText = isWeekendOt ? '0' : hoursText(cap.regularMinutes)
  const overtimeText = hoursText(cap.overtimeMinutes)
  const unsetNames = (day.lanes ?? []).filter(l => l.capacity.source === 'unset').map(l => l.name)
  // 「最晚的線約做到幾點」：各線各自換算（整天加總換算的時刻會誤導，見 CapacityBar showReach）
  let latest: { name: string; clock: number } | null = null
  for (const m of models) {
    if (!(m.lane.usedMinutes > 0)) continue
    const clock = workToClock(m.lane.usedMinutes, m.scale)
    if (!latest || clock > latest.clock) latest = { name: m.lane.name, clock }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* ── 前／後一個工作日（平常＝換日按鈕，拖曳中＝放置區；一直佔位，拖曳開始時版面不跳） ── */}
      {(prevDate || nextDate) && (
        <div className="flex shrink-0 gap-2">
          {prevDate
            ? <NavDrop date={prevDate} dir="prev" dragRule={dragRule} dragging={dragging} stale={stale} defaultLineName={defaultLineName} onGo={onGoDate} />
            : <div className="h-7 flex-1" />}
          {nextDate
            ? <NavDrop date={nextDate} dir="next" dragRule={dragRule} dragging={dragging} stale={stale} defaultLineName={defaultLineName} onGo={onGoDate} />
            : <div className="h-7 flex-1" />}
        </div>
      )}

      <section
        aria-label={`${day.label} 排程`}
        className={`relative flex min-h-[16rem] flex-1 flex-col overflow-hidden rounded-xl border lg:min-h-0 ${
          day.isToday ? 'border-sky-600/70' : isWeekendOt ? 'border-amber-700/60' : 'border-slate-700'
        }`}
      >
        {/* ── 頂部：日期、總計（D71 總時數＝各線加總）、整天負荷條 ── */}
        <div className={`shrink-0 space-y-2 border-b border-slate-700 px-3 py-2 ${
          day.isToday ? 'bg-sky-950/60' : isWeekendOt ? 'bg-amber-950/50' : 'bg-slate-900'
        }`}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <div className="flex items-baseline gap-1.5">
              <span className={`text-lg font-bold ${day.isToday ? 'text-sky-200' : 'text-slate-100'}`}>{day.label}</span>
              {day.isToday && <span className="rounded bg-sky-600 px-1 text-[10px] font-bold text-white">今天</span>}
              {isWeekendOt && <span className="rounded bg-amber-600/80 px-1 text-[10px] font-bold text-white">{weekendName(day.date)}加班</span>}
            </div>
            <dl className="flex flex-wrap items-baseline gap-x-3 text-xs tabular-nums text-slate-300" title="總時數＝各線加總（D71）">
              <div><dt className="inline text-slate-500">總計 正常 </dt><dd className="inline font-semibold">{regularText != null ? `${regularText}h` : '—'}</dd></div>
              <div><dt className="inline text-slate-500">加班 </dt><dd className="inline font-semibold">{overtimeText != null ? `${overtimeText}h` : '—'}</dd></div>
              {cap.source === 'inherited' && cap.inheritedFrom && <div className="text-[11px] text-slate-500">產能沿用 {md(cap.inheritedFrom)}</div>}
            </dl>
            <div className="flex flex-wrap gap-x-2 text-[11px] text-slate-400">
              <span>{day.cards.length} 張{doneCount > 0 ? `（完成 ${doneCount}）` : ''}</span>
              {day.rolledInCount > 0 && <span className="font-semibold text-orange-300">含順延 {day.rolledInCount} 張</span>}
              {unsetNames.length > 0 && <span className="text-slate-500">{unsetNames.join('、')} 尚未設定產能</span>}
              {latest && (
                <span
                  className={`tabular-nums ${latest.clock > RULER_END_CLOCK + 0.5 ? 'font-semibold text-red-300' : 'text-slate-300'}`}
                  title="各線依自己的正常／加班時數換算，取最晚的一條（僅供參考，不排時段，D5）"
                >最晚 {latest.name} 約做到 {latest.clock > RULER_END_CLOCK + 0.5 ? '超過 24:00' : clockText(latest.clock)}</span>
              )}
            </div>
            <span className="flex-1" />
            <button
              type="button"
              onClick={() => onEditCapacity(day.date)}
              className="rounded border border-slate-600 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-800"
            >{editable ? '設定產能' : '查看產能'}</button>
          </div>
          <div className="max-w-3xl">
            <CapacityBar used={day.usedMinutes} cap={cap} load={day.load} unknownCards={day.unknownMinutesCards} weekend={isWeekendOt} size="xl" showReach={false} />
          </div>
        </div>

        {models.length === 0 ? (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-slate-500">
            尚未取得產線資料（分線 migration 套用後才會出現 A／B／C 線）
          </div>
        ) : stacked ? (
          // ── 窄螢幕：各線上下堆疊（不能拖，也不畫時間尺） ──
          <div className="eip-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto bg-slate-950 p-2">
            {models.map(m => {
              const shown = hideCompleted ? m.entries.filter(e => !e.bc.completed) : m.entries
              return (
                <div key={m.lane.lineId} className="rounded-lg border border-slate-800">
                  <div className="space-y-1 border-b border-slate-800 bg-slate-900 px-2 py-1.5">
                    <div className="flex items-center gap-2 text-sm font-bold text-slate-100">
                      {m.lane.name}
                      <span className="text-[10px] font-normal text-slate-500">{m.lane.cardCount} 張</span>
                      <span className="flex-1" />
                      <button type="button" onClick={() => onEditCapacity(day.date, m.lane.lineId)} aria-label={`${m.lane.name} 產能設定`}
                        className="rounded px-1 text-[12px] font-normal text-slate-400 hover:bg-slate-800 hover:text-white">⚙</button>
                    </div>
                    <CapacityBar used={m.lane.usedMinutes} cap={m.lane.capacity} load={m.lane.load} unknownCards={m.lane.unknownMinutesCards} weekend={isWeekendOt} size="md" />
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-1.5 p-1.5">
                    {shown.length === 0 ? (
                      <p className="px-2 py-3 text-center text-[11px] text-slate-500">{hiddenDoneText(m.entries.length, 0) ?? '這條線還沒有排定項目'}</p>
                    ) : shown.map(({ bc }) => (
                      <PlacementCard
                        key={bc.placementId}
                        bc={bc}
                        today={today}
                        size="md"
                        editable={editable}
                        canDrag={false}
                        handlers={handlerMap.get(bc.placementId)!}
                        onOpenOrder={onOpenOrder}
                        onOpenDetail={onOpenDetail}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          // ── 桌機：時間尺＋各線一欄（一個捲動容器：線頭 sticky top、時間尺 sticky left；線多時橫向捲動） ──
          <div className="eip-scrollbar min-h-0 flex-1 overflow-auto bg-slate-950">
            <div className="flex w-full" style={{ minWidth: RULER_WIDTH_PX + models.length * 220 }}>
              <TimeRuler bodyHeightPx={bodyHeightPx} weekend={isWeekendOt} />
              {models.map(m => (
                <LaneColumn
                  key={m.lane.lineId}
                  date={day.date}
                  lane={m.lane}
                  scale={m.scale}
                  entries={m.entries}
                  bodyHeightPx={bodyHeightPx}
                  weekend={isWeekendOt}
                  today={today}
                  dragRule={dragRule}
                  stale={stale}
                  editable={editable}
                  canDrag={canDrag}
                  canResize={canResize}
                  hideCompleted={hideCompleted}
                  handlerMap={handlerMap}
                  onOpenOrder={onOpenOrder}
                  onOpenDetail={onOpenDetail}
                  onResize={onResize}
                  onResizing={onResizing}
                  onEditCapacity={onEditCapacity}
                />
              ))}
            </div>
          </div>
        )}
        {loadingOverlay}
      </section>
    </div>
  )
}
