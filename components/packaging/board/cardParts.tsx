'use client'

// 排定卡（D60：日／週／兩週檢視、待排區）共用的小零件：完成勾選、右鍵選單、拖曳、滑過提示文字、handlers 快取。
// 三種檢視與待排區都用這一份，延誤（D50）、預排虛線（D22）、已完成（灰＋勾，D24）的表現才會一致。
// 狀態判斷（placementState／cardMarks）是純函式，放在 lib/packaging/boardView.ts（有單元測試）。

import { useMemo, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { useDraggable } from '@dnd-kit/core'
import type { BoardCard } from '@/lib/packaging/scheduleTypes'
import { fmtQty } from '@/components/packaging/poolStyles'
import { hoursText, moText, placementState, type CardSize } from '@/lib/packaging/boardView'
import { receiptFace } from '@/lib/packaging/receipts'
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
    `數量 ${fmtQty(bc.effectiveQty)}　工時 ${hoursText(bc.minutes) ?? '未知'} h${bc.minutesOverride ? `（主管調整，標準 ${hoursText(bc.minutesStd) ?? '未知'} h）` : ''}　交期 ${md(c.dueDate)}`,
  ]
  const mo = moText(c)
  if (mo) lines.push(`${mo.isMo ? '製令' : '來源單'} ${mo.text}`)
  // D111：入庫批次與已放天數（兩週迷你卡放不下，只在這裡看得到；用排定卡自己的可包量判斷要不要算「已放」）
  const rc = receiptFace(c)
  if (rc) lines.push(rc.text)
  if (s.delayed && bc.delayWorkdays > 0) lines.push(`延誤 ${bc.delayWorkdays} 天`)
  if (s.pre && !s.done) lines.push(bc.readiness === 'pre' && bc.preReadyDate ? `預排：預估 ${md(bc.preReadyDate)} 可包` : '預排：可包日未知')
  if (bc.split) lines.push(`拆卡 ${bc.split.index}/${bc.split.total}`)
  if (s.done) lines.push(`已完成：${bc.completed!.byName ?? bc.completed!.by}（${clock(bc.completed!.at)}）`)
  if (s.consumed && !s.done) lines.push('已由待排池扣完（有效數量 0，不需再包）')
  if (bc.manual) lines.push(`手動加入：${bc.manual.addedByName ?? bc.manual.addedBy}（${clock(bc.manual.addedAt)}）`)
  const inactive = bc.flags.find(f => f.code === 'line_inactive')
  if (inactive) lines.push(inactive.label)
  lines.push(mini
    ? '（點卡片看詳情＋訂單詳情・右鍵：完成、拆卡、移動、訂單詳情…）'
    : '（點卡片看詳情・點單號看訂單・右鍵：完成、拆卡、移動…）')
  return lines.join('\n')
}

/**
 * 分線輪的小角標（CardFace 不能改，D58 的 7 項外觀不動；新資訊由外框元件加，lines.md §5.0）：
 *   手＝D66 手動加入的品項　✎＝D69 主管調整過工時　⚠＝所屬線已停用、暫顯示在預設線
 */
export function PlacementBadges({ bc, className = '', hideMinutes = false }: {
  bc: BoardCard
  className?: string
  /** D100：卡片上已有「工時」小標（MinutesChip，調整過會標 ✎）→ 角標不再重複畫 ✎；日檢視 LaneCard 不傳，照舊 */
  hideMinutes?: boolean
}) {
  const inactive = bc.flags.find(f => f.code === 'line_inactive')
  const ov = !!bc.minutesOverride && !hideMinutes
  if (!bc.manual && !ov && !inactive) return null
  return (
    <span className={`pointer-events-none flex items-center gap-0.5 text-[9px] font-bold leading-3 ${className}`}>
      {bc.manual && (
        <span className="rounded bg-violet-700/90 px-0.5 text-white" title={`手動加入：${bc.manual.addedByName ?? bc.manual.addedBy}（${clock(bc.manual.addedAt)}）`}>手</span>
      )}
      {ov && bc.minutesOverride && (
        <span className="rounded bg-slate-700 px-0.5 text-amber-200" title={`工時已由 ${bc.minutesOverride.byName ?? bc.minutesOverride.by} 調整（標準 ${hoursText(bc.minutesStd) ?? '未知'} h）`}>✎</span>
      )}
      {inactive && <span className="rounded bg-orange-700 px-0.5 text-white" title={inactive.label}>⚠</span>}
    </span>
  )
}

/**
 * D100 卡片上的「工時 X.Xh」小標（週 sm、待排區／窄螢幕 md、兩週迷你卡）。
 * 為什麼：週／兩週卡片原本完全看不到工時，唯一線索是 9px、點不到的 ✎ 角標，要改工時只能點整張卡再往下找——
 *   Snow 回報「改時數的入口縮成小圖示，看不懂」。日檢視有時間列與拉下緣，這裡補上文字入口。
 * - 調整過（覆寫）＝琥珀色＋✎；工時未知＝橘色「工時 ?」（照樣可以點進去設定，設定後才計入負荷）
 * - md／sm 且有 onEdit：按鈕（開卡片詳情並直接聚焦工時輸入框）。照 OrderNo 的寫法在 pointerdown／click／keydown 都 stopPropagation：
 *   按住小標不會起拖曳、點了不會冒泡成「點卡片」。
 * - 迷你卡一律純文字：迷你卡上的按鈕會吃掉拖曳與點擊（PlacementCard 檔頭記錄過的問題）；點整張迷你卡本來就會開詳情。
 *   迷你卡內容寬只有約 45px（清單出捲軸時約 35px）：「✎工時 12.5h」放不下、被截成「✎工時 1…」，最需要看的數字反而不見（D100 驗證 F5）
 *   → 迷你卡只寫「✎12.5h」／「3.5h」（約 32px，數字完整；「工時」兩字留給讀屏軟體，滑過提示是整張卡的 cardTitle，已含工時與標準值）；
 *   工時未知寫「工時?」。兩週欄頭本來就用「A 3.5h」表示已排時數，同一種寫法。
 * - 已由待排池扣完（有效數量 0、未完成）：純文字（右鍵選單也不給「調整工時…」）。
 */
export function MinutesChip({ bc, size, onEdit }: { bc: BoardCard; size: CardSize; onEdit?: (bc: BoardCard) => void }) {
  const s = placementState(bc)
  const h = hoursText(bc.minutes)
  const ov = !!bc.minutesOverride
  const tone = h == null ? 'text-orange-300' : ov ? 'text-amber-200' : 'text-slate-300'
  if (size === 'mini') {
    return (
      // 截斷只是防呆（極端值不撐破卡片）；一般工時一定放得下
      <span className={`min-w-0 truncate whitespace-nowrap text-[9px] leading-3 tabular-nums ${tone}`}>
        {h == null ? '工時?' : <><span className="sr-only">工時 </span>{`${ov ? '✎' : ''}${h}h`}</>}
      </span>
    )
  }
  const text = `${ov ? '✎' : ''}工時 ${h ?? '?'}h`
  const title = h == null
    ? '工時未知（未計入負荷）'
    : `工時 ${h} h${ov ? `（已調整，標準 ${hoursText(bc.minutesStd) ?? '未知'} h）` : '（標準估計）'}`
  const clickable = !!onEdit && !(s.consumed && !s.done)
  if (!clickable) {
    return <span className={`shrink-0 whitespace-nowrap text-[10px] leading-4 tabular-nums ${tone}`} title={title}>{text}</span>
  }
  return (
    <button
      type="button"
      onPointerDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onEdit!(bc) }}
      onKeyDown={e => e.stopPropagation()}
      title={`${title}・點一下調整工時`}
      aria-label={`${lineLabel(bc.card)} 工時 ${h ?? '未知'} 小時，點一下調整`}
      className={`shrink-0 whitespace-nowrap rounded border px-1 text-[10px] leading-4 tabular-nums hover:bg-slate-700 ${
        ov ? 'border-amber-700/70 bg-amber-950/40' : 'border-slate-600 bg-slate-800/80'
      } ${tone}`}
    >{text}</button>
  )
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
