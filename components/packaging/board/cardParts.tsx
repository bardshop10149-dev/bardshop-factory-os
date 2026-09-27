'use client'

// 排定卡（D60：日／週／兩週檢視、待排區）共用的小零件：完成勾選、右鍵選單、拖曳、滑過提示文字、handlers 快取。
// 三種檢視與待排區都用這一份，延誤（D50）、預排虛線（D22）、已完成（灰＋勾，D24）的表現才會一致。
// 狀態判斷（placementState／cardMarks）是純函式，放在 lib/packaging/boardView.ts（有單元測試）。

import { useMemo, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useDraggable } from '@dnd-kit/core'
import type { BoardCard } from '@/lib/packaging/scheduleTypes'
import { fmtQty } from '@/components/packaging/poolStyles'
import { hoursText, moText, placementState } from '@/lib/packaging/boardView'
import { clock, md } from './boardFormat'
import { lineLabel } from './CardFace'
import { MenuPopup, cardMenuItems, type CardMenuHandlers } from './cardMenu'

/**
 * 週卡／兩週迷你卡的滑過提示：卡上字小或只有單號＋數量，其餘靠提示與卡片詳情。
 * mini：迷你卡的單號不是按鈕（訂單詳情走卡片詳情或右鍵），最後一行的操作說明跟著改。
 */
export function cardTitle(bc: BoardCard, mini = false): string {
  const c = bc.card
  const s = placementState(bc)
  const lines = [
    `${lineLabel(c)}　${c.customer ?? ''}`.trim(),
    c.itemName ?? '（無品名）',
    `數量 ${fmtQty(bc.effectiveQty)}　工時 ${hoursText(bc.minutes) ?? '未知'} h　交期 ${md(c.dueDate)}`,
  ]
  const mo = moText(c)
  if (mo) lines.push(`${mo.isMo ? '製令' : '來源單'} ${mo.text}`)
  if (s.delayed && bc.delayWorkdays > 0) lines.push(`延誤 ${bc.delayWorkdays} 天`)
  if (s.pre && !s.done) lines.push(bc.readiness === 'pre' && bc.preReadyDate ? `預排：預估 ${md(bc.preReadyDate)} 可包` : '預排：可包日未知')
  if (bc.split) lines.push(`拆卡 ${bc.split.index}/${bc.split.total}`)
  if (s.done) lines.push(`已完成：${bc.completed!.byName ?? bc.completed!.by}（${clock(bc.completed!.at)}）`)
  if (s.consumed && !s.done) lines.push('已由待排池扣完（有效數量 0，不需再包）')
  lines.push(mini
    ? '（點卡片看詳情＋訂單詳情・右鍵：完成、拆卡、移動、訂單詳情…）'
    : '（點卡片看詳情・點單號看訂單・右鍵：完成、拆卡、移動…）')
  return lines.join('\n')
}

/** 完成勾選（D24，不回寫塔台）：小勾選框放在卡片第 1 行最右側 */
export function DoneCheck({ bc, editable, handlers }: { bc: BoardCard; editable: boolean; handlers?: CardMenuHandlers }) {
  const s = placementState(bc)
  const disabled = !editable || !handlers || (s.consumed && !s.done)
  return (
    <label
      className={`flex shrink-0 items-center ${disabled ? 'cursor-default' : 'cursor-pointer'}`}
      title={s.done
        ? `已完成：${bc.completed!.byName ?? bc.completed!.by}（${clock(bc.completed!.at)}）；取消勾選可還原`
        : editable ? '勾選＝包裝完成（D24，不回寫塔台）' : '唯讀模式'}
      // 勾選框不是「點卡片」：不開詳情、不起拖曳
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onKeyDown={e => e.stopPropagation()}
    >
      <input
        type="checkbox"
        aria-label={`${lineLabel(bc.card)} 完成`}
        checked={s.done}
        disabled={disabled}
        onChange={() => handlers?.onToggleComplete(bc)}
        className="h-3.5 w-3.5 accent-emerald-500"
      />
    </label>
  )
}

/**
 * 卡片的拖曳（id / data 與先前的列相同：BoardLayout 的 onDragStart 認 kind='placement'）。
 * 只展開 listeners、不展開 attributes（同 SimplePoolCard：沒有 KeyboardSensor，role=button＋「空白鍵拿起」是做不到的說明，
 * 而且卡片裡有單號按鈕與勾選框，role=button 會變成巢狀互動元素）。卡片自己給 role=group＋tabIndex。
 */
export function useCardDrag(bc: BoardCard, canDrag: boolean) {
  const disabled = !canDrag || !!bc.completed
  const d = useDraggable({ id: `pl:${bc.placementId}`, data: { kind: 'placement', bc }, disabled })
  return {
    setNodeRef: d.setNodeRef,
    isDragging: d.isDragging,
    listeners: disabled ? undefined : d.listeners,
    disabled,
  }
}

/** 右鍵選單狀態（滑鼠右鍵；鍵盤 Shift+F10／選單鍵也會觸發 contextmenu 事件） */
export function useCardMenu(bc: BoardCard, opts: { editable: boolean; handlers?: CardMenuHandlers; onOpenOrder: (so: string) => void; withComplete: boolean }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const openAt = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    setPos({ x: Math.max(8, r.right - 180), y: r.top + 24 })
  }
  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault()
    // 鍵盤開的 contextmenu 沒有滑鼠座標（0,0）→ 貼著卡片開
    if (e.clientX === 0 && e.clientY === 0) openAt(e.currentTarget)
    else setPos({ x: e.clientX, y: e.clientY })
  }
  // 用 portal 掛到 body；呼叫端要把 menu 放在卡片元素「外面」（React 的合成事件會沿元件樹冒泡穿過 portal，
  // 放在卡片裡的話，點選單項目的 click 會冒泡成「點卡片」而開詳情）
  const menu = pos && typeof document !== 'undefined' ? createPortal(
    <MenuPopup
      x={pos.x}
      y={pos.y}
      title={lineLabel(bc.card)}
      items={cardMenuItems(bc, opts)}
      onClose={() => setPos(null)}
    />,
    document.body,
  ) : null
  return { onContextMenu, openAt, menu, open: !!pos }
}

/**
 * 每張卡的選單 handlers 依 placementId 快取：同一批 cards／handlersFor 不變就回同一個物件，
 * 卡片元件的 React.memo 才有作用（否則每次重畫 handlersFor(...) 都回新物件，memo 等於沒包）。
 */
export function useHandlerMap(
  cards: BoardCard[],
  handlersFor: (bc: BoardCard, siblings: BoardCard[]) => CardMenuHandlers,
): Map<string, CardMenuHandlers> {
  return useMemo(() => new Map(cards.map(bc => [bc.placementId, handlersFor(bc, cards)])), [cards, handlersFor])
}
