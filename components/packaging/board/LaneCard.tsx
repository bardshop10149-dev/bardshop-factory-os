'use client'

// D68 日檢視時間尺上的一張卡：絕對定位（layoutLane 算好的 top／height），長度＝工時。
// 外觀沿用 CardFace（D58 7 項，D60 左右一致）；太短時精簡（D68「太短時自動精簡為單號＋品名」）：
//   高度 < LANE_CARD_COMPACT_PX（56px，compact）→ 一行「單號＋品名＋工時＋完成勾選」
//   56px ～ MID_FACE_PX（88px，mid）→ 時間列＋「單號＋標記＋完成勾選」＋品名（line-clamp）；
//     CardFace sm 的品名在第 4 行（約 85px 才露出來），這個區間直接用 CardFace 會只看得到單號；客戶／製令改看滑過提示
//   其餘 → 上方一行「10:40–13:40・3.0 h」＋ CardFace（< 130px 用 sm 字級，超出部分截掉）
// 其他：zone over（超過該線加班上限）右側紅條；shifted（被前一張卡的最小高度推下來）時間字變淡；
//      手動加入／調整過工時／線已停用 → 右下角角標（cardParts PlacementBadges）。
//
// D69 拉卡片下緣改工時（lines.md §3.7）：
//   只有持有編輯鎖、未完成、可拖曳（桌機）的卡才有下緣把手（6px）；已完成卡改工時走卡片詳情。
//   把手的 pointerdown／touchstart 一定要 stopPropagation：dnd-kit 的 PointerSensor（onPointerDown）與
//   TouchSensor（onTouchStart，按住 250ms）都掛在卡片本體（React 事件），不擋的話「拉下緣」會同時變成「拖整張卡」；
//   把手另設 touch-action:none，觸控拉動時瀏覽器才不會把手勢當成捲動而送 pointercancel（橫放 iPad、觸控筆電）。
//   放開後的 click 也要擋，否則會冒泡成「點卡片＝開詳情」。
//   拖動中：onResizing(true) 讓 useBoard 暫停套用輪詢結果並略過 Ctrl+Z（放開時 layout 若被換掉，位移量會對到別的起點）。
//   預覽高度＝「放開後會存下的工時」回推的長度（吸附 5 分，所見即所存）＋浮動提示；Esc 取消。
//   放開：新工時＝resizeToMinutes(自然底部 + 位移)，以「工時分鐘」吸附 5 分（每條線比例不同，吸附在存下來的量上才一致）。
//   用「自然底部」（沒被推擠時的位置）而不是畫面底部：被推下來的卡（shifted）畫面底部比實際工時低，會多算。

import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import {
  LANE_CARD_COMPACT_PX,
  LANE_CARD_MIN_PX,
  type BoardCard,
  type LaneCardLayout,
  type LaneScale,
} from '@/lib/packaging/scheduleTypes'
import { cardBarTone, cardMarks, hoursText, isCardDanger, placementFrame, placementState } from '@/lib/packaging/boardView'
import { clockText, resizeToMinutes, workToClock } from '@/lib/packaging/laneTimeline'
import { md } from './boardFormat'
import CardFace, { BAR_CLASS, CardMarks, OrderNo, lineLabel } from './CardFace'
import type { CardMenuHandlers } from './cardMenu'
import { DoneCheck, PlacementBadges, cardTitle, useCardDrag, useCardMenu } from './cardParts'
import { rulerPx } from './TimeRuler'

const FRAME_CLASS: Record<ReturnType<typeof placementFrame>, string> = {
  solid: 'border-slate-700 hover:border-slate-500',
  pre: 'border-dashed border-sky-400/80',
  preWarn: 'border-dashed border-orange-400',
}

/** CardFace 用 md 字級的最小高度（時間列 16px＋md 7 項約 110px） */
const FULL_FACE_PX = 130
/** 低於這個高度（且 ≥ LANE_CARD_COMPACT_PX）用中間版面：時間列＋單號＋品名（CardFace sm 的品名第 4 行約 85px 才露出） */
const MID_FACE_PX = 88
/** 中間版面的品名放得下兩行的高度 */
const MID_TWO_LINE_PX = 72
/** 位移小於這個 px 視為沒拉（只是點到把手） */
const RESIZE_DEADZONE_PX = 3

const LaneCard = memo(function LaneCard({ bc, layout, scale, today, editable, canDrag, canResize, handlers, onOpenOrder, onOpenDetail, onResize, onResizing }: {
  bc: BoardCard
  layout: LaneCardLayout
  scale: LaneScale
  today: string
  editable: boolean
  canDrag: boolean
  /** 持有編輯鎖＋桌機＋資料不是舊的；已完成卡另外擋 */
  canResize: boolean
  handlers: CardMenuHandlers
  onOpenOrder: (so: string) => void
  onOpenDetail: (bc: BoardCard) => void
  /** 放開下緣：newEffMinutes＝新的「有效工時」（已吸附 5 分、≥ 5）；是否回到標準值由呼叫端判斷 */
  onResize: (bc: BoardCard, newEffMinutes: number) => void
  /** 拉下緣開始／結束（useBoard.setDragging：拉動中暫停套用輪詢、略過 Undo 快捷鍵） */
  onResizing?: (active: boolean) => void
}) {
  const s = placementState(bc)
  const { setNodeRef, isDragging, listeners, disabled } = useCardDrag(bc, canDrag)
  const menu = useCardMenu(bc, { editable, handlers, onOpenOrder, withComplete: true })
  const bar = cardBarTone(s, isCardDanger(bc.card, today, bc.flags))
  const muted = s.done || s.consumed
  const resizable = canResize && !s.done && !s.consumed

  // ── 拉下緣 ──
  // ref＝即時值（pointer 事件與 Esc 監聽讀）；state＝畫面（預覽高度與提示）
  const dragRef = useRef<{ startY: number; dy: number; pointerId: number } | null>(null)
  const [dy, setDy] = useState<number | null>(null)
  const naturalBottom = rulerPx(layout.clockEnd)
  const previewMinutes = dy == null ? null : resizeToMinutes(layout, naturalBottom + dy, scale)

  useEffect(() => {
    if (dy == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      dragRef.current = null
      setDy(null)
      onResizing?.(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [dy, onResizing])

  // 拉動中被卸載（換日、卡片被移走）：把暫停旗標還回去，免得輪詢一直停住
  const resizingRef = useRef(false)
  useEffect(() => { resizingRef.current = dy != null }, [dy])
  useEffect(() => () => { if (resizingRef.current) onResizing?.(false) }, [onResizing])

  const onHandleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startY: e.clientY, dy: 0, pointerId: e.pointerId }
    setDy(0)
    onResizing?.(true)
  }
  const onHandleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = dragRef.current
    if (!r || r.pointerId !== e.pointerId) return
    e.stopPropagation()
    r.dy = e.clientY - r.startY
    setDy(r.dy)
  }
  const onHandleUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = dragRef.current
    e.stopPropagation()
    if (!r || r.pointerId !== e.pointerId) return // Esc 取消過（已經 onResizing(false)）
    dragRef.current = null
    setDy(null)
    // 先送出（佇列非空）再解除暫停：setDragging(false) 看到佇列非空就交給 pump 在清空後補抓，不會先抓一份舊資料
    if (Math.abs(r.dy) >= RESIZE_DEADZONE_PX) onResize(bc, resizeToMinutes(layout, naturalBottom + r.dy, scale))
    onResizing?.(false)
  }
  const onHandleCancel = () => {
    if (!dragRef.current) return
    dragRef.current = null
    setDy(null)
    onResizing?.(false)
  }

  // 預覽高度：還在死區內＝原高度（只是按到把手，不跳）；拉開後＝會存下的工時換算回來的底部（所見即所存）。
  // 不能用「畫面高度＋位移」：被最小高度撐高、被推擠（shifted）、工時未知（自然高度 0）的卡，畫面底部≠自然底部，
  // 看到的長度會比存下的工時長一截。
  const height = dy == null || previewMinutes == null || Math.abs(dy) < RESIZE_DEADZONE_PX
    ? layout.heightPx
    : Math.max(LANE_CARD_MIN_PX, rulerPx(workToClock(layout.workStart + previewMinutes, scale)) - layout.topPx)
  const compact = height < LANE_CARD_COMPACT_PX
  const mid = !compact && height < MID_FACE_PX
  const face = height >= FULL_FACE_PX ? 'md' : 'sm'
  const timeTone = layout.shifted ? 'text-slate-500' : layout.zone === 'over' ? 'text-red-300' : layout.zone === 'overtime' ? 'text-orange-300' : 'text-slate-400'
  const timeTitle = layout.shifted ? '前一張卡太短、最小高度把這張往下推，時間僅供參考' : '依累計工時換算，僅供參考（不排時段，D5）'
  const minutesText = hoursText(bc.minutes)
  const timeText = layout.zone === 'unknown'
    ? '工時未知'
    : `${clockText(layout.clockStart)}–${clockText(layout.clockEnd)}`

  return (
    <>
      <div
        ref={setNodeRef}
        // D113 排程區單號搜尋：跳轉靠這個屬性找卡、發光樣式也用它選中（拖曳時的浮動卡 PlacementCardOverlay 不加，免得一張卡兩個元素）
        data-placement-id={bc.placementId}
        {...listeners}
        role="group"
        tabIndex={0}
        aria-roledescription="排定卡"
        aria-label={`${lineLabel(bc.card)} ${bc.card.customer ?? ''} ${bc.card.itemName ?? ''}${s.done ? '（已完成）' : ''}`}
        aria-keyshortcuts="Enter Shift+F10"
        title={cardTitle(bc)}
        onClick={() => onOpenDetail(bc)}
        onKeyDown={e => {
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenDetail(bc) }
        }}
        onContextMenu={menu.onContextMenu}
        style={{ top: layout.topPx, height }}
        className={`absolute inset-x-1 overflow-hidden rounded-md border outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
          FRAME_CLASS[placementFrame(s)]
        } ${muted ? 'bg-slate-800/80' : 'bg-slate-900 hover:bg-slate-800'} ${
          disabled ? 'cursor-pointer' : 'cursor-grab active:cursor-grabbing'
        } ${isDragging ? 'opacity-30' : ''} ${menu.open || dy != null ? 'z-[5] ring-2 ring-sky-500' : ''}`}
      >
        {compact ? (
          // 精簡：單號＋品名一行（D68「太短時精簡」）；完成勾選也留著（短卡是一天裡最多的卡，D24 要能直接勾）
          <div className="flex h-full min-w-0 items-center text-[11px] leading-4">
            <span className={`h-full w-1 shrink-0 ${BAR_CLASS[bar]}`} aria-hidden />
            <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-1.5 pr-2">
              <span className={`flex min-w-0 flex-1 items-center gap-1.5 ${muted ? 'opacity-60' : ''}`}>
                <OrderNo card={bc.card} onOpenOrder={onOpenOrder} className={`shrink-0 ${muted ? 'line-through decoration-slate-500' : ''}`} />
                <span className="min-w-0 flex-1 truncate text-slate-200">{bc.card.itemName ?? '（無品名）'}</span>
              </span>
              <PlacementBadges bc={bc} className="shrink-0" />
              <span className="shrink-0 text-[10px] tabular-nums text-slate-400">{minutesText ?? '?'}h</span>
              <DoneCheck bc={bc} editable={editable} handlers={handlers} />
            </div>
          </div>
        ) : mid ? (
          // 中間高度：時間列＋「單號＋標記＋勾選」＋品名（D68 精簡的延伸；客戶、製令、數量看滑過提示／卡片詳情）
          <div className="flex h-full min-w-0 text-[11px] leading-[15px]">
            <span className={`w-1 shrink-0 ${BAR_CLASS[bar]}`} aria-hidden />
            <div className="min-w-0 flex-1 pl-1.5 pr-2">
              <div className={`truncate text-[10px] leading-4 tabular-nums ${timeTone}`} title={timeTitle}>{timeText}・{minutesText ?? '?'} h</div>
              <div className="flex min-w-0 items-center gap-1">
                <OrderNo card={bc.card} onOpenOrder={onOpenOrder} className={muted ? 'line-through decoration-slate-500 opacity-55' : ''} />
                <span className="flex-1" />
                <CardMarks marks={cardMarks(bc, 'sm', md)} small />
                <PlacementBadges bc={bc} className="shrink-0" />
                <DoneCheck bc={bc} editable={editable} handlers={handlers} />
              </div>
              <div className={`break-words font-medium text-slate-100 ${height >= MID_TWO_LINE_PX ? 'line-clamp-2' : 'line-clamp-1'} ${muted ? 'opacity-55' : ''}`}>
                {bc.card.itemName ?? '（無品名）'}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* 時間列（D68：卡片位置＝累計工時換算的鐘面時刻；被推下來時淡色、僅供參考） */}
            <div className="flex min-w-0 items-center text-[10px] leading-4">
              <span className={`h-4 w-1 shrink-0 ${BAR_CLASS[bar]}`} aria-hidden />
              <span className={`truncate px-2 tabular-nums ${timeTone}`} title={timeTitle}>{timeText}・{minutesText ?? '?'} h</span>
            </div>
            <CardFace
              card={bc.card}
              today={today}
              size={face}
              onOpenOrder={onOpenOrder}
              bar={bar}
              marks={cardMarks(bc, face, md)}
              muted={muted}
              check={<DoneCheck bc={bc} editable={editable} handlers={handlers} />}
              // D111：時間尺上的卡高度＝工時、超出會被截掉 → 入庫資訊放最後，不把原本的 7 項擠出去（滑過提示 cardTitle 一定看得到）
              receiptAt="bottom"
            />
          </>
        )}
        {/* 超過該線加班上限：右側紅條 */}
        {layout.zone === 'over' && <span className="pointer-events-none absolute inset-y-0 right-0 w-1 bg-red-500" aria-hidden />}
        {!compact && !mid && <PlacementBadges bc={bc} className="absolute bottom-1 right-1.5" />}
        {/* D69 下緣把手（6px） */}
        {resizable && (
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="拉動調整工時"
            title="上下拉動調整這張卡的工時（吸附 5 分；Esc 取消）"
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onPointerCancel={onHandleCancel}
            onLostPointerCapture={onHandleCancel}
            onTouchStart={e => e.stopPropagation()}
            onClick={e => e.stopPropagation()}
            onKeyDown={e => e.stopPropagation()}
            className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize touch-none bg-transparent hover:bg-sky-500/60"
          />
        )}
      </div>
      {/* 拖動中的浮動提示（放在卡片外面才不會被 overflow-hidden 裁掉） */}
      {dy != null && previewMinutes != null && (
        <div
          className="pointer-events-none absolute inset-x-1 z-30 rounded border border-sky-500 bg-slate-950/95 px-2 py-1 text-[11px] tabular-nums text-sky-100 shadow-lg"
          style={{ top: layout.topPx + height + 4 }}
        >
          工時 {hoursText(previewMinutes)} h
          <span className="text-slate-400">（標準 {hoursText(bc.minutesStd) ?? '未知'} h）</span>
          ・約 {clockText(workToClock(layout.workStart + previewMinutes, scale))} 結束
        </div>
      )}
      {menu.menu}
    </>
  )
})

export default LaneCard
