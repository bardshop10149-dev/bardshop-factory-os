'use client'

// 排定卡（日／週／兩週檢視、待排區，D60）的右鍵選單（鍵盤：Shift+F10）。
// 鍵盤：Shift+F10 開啟後焦點在選單內，↑↓ 移動、Enter 執行、Esc 關閉並回到卡片（見 MenuPopup）。
// 含「勾完成／取消完成」——兩週迷你卡沒有常駐的勾選框，右鍵就要能完成（D24）。
// 分線輪：排定卡加「移到 B 線」（同一天換線，D67）與「調整工時…」（開卡片詳情的工時編輯，D69）。

import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { BoardCard } from '@/lib/packaging/scheduleTypes'
import { placementState } from '@/lib/packaging/boardView'

/** 排定卡的操作（BoardLayout.handlersFor 產生；每張卡依 placementId 快取，見 cardParts 的 useHandlerMap） */
export interface CardMenuHandlers {
  onToggleComplete: (bc: BoardCard) => void
  onSplit: (bc: BoardCard) => void
  onMoveTo: (bc: BoardCard) => void
  onToHolding: (bc: BoardCard) => void
  onUnplace: (bc: BoardCard) => void
  /** 同欄同行 ≥ 2 張未完成子卡時才有 */
  onMerge?: (bc: BoardCard) => void
  /** D67 同一天換線（排在日期上的未完成卡）；moveLines＝可選的線（啟用中，依 sortOrder） */
  onMoveLine?: (bc: BoardCard, lineId: number) => void
  moveLines?: readonly { id: number; name: string }[]
  /** D69 調整工時（開卡片詳情；已完成的卡也可以改，記錄實際花的時間） */
  onEditMinutes?: (bc: BoardCard) => void
  /**
   * D104 結案（整個 SO 品項行永久不再進待排池；這張與同行的未完成排定卡一併放回）。
   * 不需編輯鎖（結案是單據事實）→ 不看 editable，只看有沒有給（BoardLayout 只在 me.canEdit 時給）。
   */
  onCloseLine?: (bc: BoardCard) => void
}

export interface MenuItem {
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
  hint?: string
}

/** 已由待排池扣完、不需再包的卡（有效數量 0） */
export function isConsumed(bc: BoardCard): boolean {
  return placementState(bc).consumed
}

export function cardMenuItems(bc: BoardCard, opts: {
  editable: boolean
  handlers?: CardMenuHandlers
  onOpenOrder: (so: string) => void
  /** 是否放「勾完成」（卡片上已有常駐勾選框時也保留：右鍵一次做完比找小勾選框快） */
  withComplete: boolean
}): MenuItem[] {
  const { editable, handlers, onOpenOrder, withComplete } = opts
  const done = !!bc.completed
  const consumed = isConsumed(bc)
  const items: MenuItem[] = []
  if (handlers && editable) {
    if (withComplete && (!consumed || done)) {
      items.push({ label: done ? '取消完成' : '勾完成', onClick: () => handlers.onToggleComplete(bc) })
    }
    if (!done) {
      if (!consumed) {
        items.push({ label: '拆卡…', onClick: () => handlers.onSplit(bc) })
        items.push({ label: '移到日期…', onClick: () => handlers.onMoveTo(bc) })
        if (bc.displayDate != null && handlers.onMoveLine && handlers.moveLines) {
          for (const l of handlers.moveLines) {
            if (l.id === bc.laneId) continue
            items.push({ label: `移到 ${l.name}`, onClick: () => handlers.onMoveLine!(bc, l.id), hint: '同一天換到這條線' })
          }
        }
        if (bc.displayDate != null) items.push({ label: '移到待排區', onClick: () => handlers.onToHolding(bc) })
        if (handlers.onMerge) items.push({ label: '合併同行子卡', onClick: () => handlers.onMerge!(bc) })
      }
    }
    if (handlers.onEditMinutes && (!consumed || done)) items.push({ label: '調整工時…', onClick: () => handlers.onEditMinutes!(bc) })
    if (!done) items.push({ label: '放回待排池', onClick: () => handlers.onUnplace(bc), danger: true })
  }
  // D104：結案不需編輯鎖（唯讀持鎖狀態也能按）；已完成的卡不提供（完成量已計入，結掉整行沒有意義）
  if (handlers?.onCloseLine && !done) {
    items.push({ label: '結案（不再拉回待排池）', onClick: () => handlers.onCloseLine!(bc), danger: true, hint: '整個 SO 品項行永久不再進待排池；同行未完成的排定卡一併放回' })
  }
  items.push({ label: '訂單詳情', onClick: () => onOpenOrder(bc.card.so) })
  return items
}

/** 選單裡可用的項目（停用的跳過） */
function enabledItems(menu: HTMLElement | null): HTMLButtonElement[] {
  return [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])]
}

/**
 * 固定定位的選單（右鍵位置或卡片旁）；點外面、按右鍵、Esc 關閉。
 * 鍵盤（WAI-ARIA menu 模式）：開啟時焦點移到第一個可用項目、↑↓／Home／End 移動、Enter 執行、
 * Esc／Tab 關閉並把焦點還給開選單前的元素（卡片）。
 * 選單用 portal 掛在 body 最後面，DOM 上離卡片很遠：不主動把焦點搬進來的話，Tab 只會跳到下一張卡、Esc 也收不到。
 * Esc 聽在 window 捕獲階段（焦點不在選單內也收得到，例：滑鼠右鍵開的）。
 */
export function MenuPopup({ x, y, title, items, onClose }: {
  x: number
  y: number
  title?: string
  items: MenuItem[]
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  // 開選單前的焦點（右鍵按下時卡片已取得焦點；Shift+F10 時就是卡片）——第一次 render 就記下
  const [returnTo] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null)

  /** 關閉並還焦點。要「先」還焦點再執行項目：項目若開對話框，Modal 會記住當下焦點（卡片）當作關閉後的歸還對象 */
  const close = () => {
    const menu = menuRef.current
    const active = document.activeElement
    const focusInMenu = !!menu && (active == null || active === document.body || menu.contains(active))
    if (focusInMenu && returnTo?.isConnected) returnTo.focus({ preventScroll: true })
    onClose()
  }
  // window 上的 Esc 監聽只掛一次；透過 effect event 呼叫最新的 close
  const onEscape = useEffectEvent(() => close())

  useEffect(() => {
    enabledItems(menuRef.current)[0]?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onEscape()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const list = enabledItems(menuRef.current)
    if (list.length === 0) return
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    let next: number | null = null
    if (e.key === 'ArrowDown') next = at < 0 || at >= list.length - 1 ? 0 : at + 1
    else if (e.key === 'ArrowUp') next = at <= 0 ? list.length - 1 : at - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = list.length - 1
    else if (e.key === 'Tab') { e.preventDefault(); close(); return }
    if (next == null) return
    e.preventDefault()
    list[next].focus()
  }

  const w = typeof window === 'undefined' ? 1920 : window.innerWidth
  const h = typeof window === 'undefined' ? 1080 : window.innerHeight
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onPointerDown={e => { e.stopPropagation(); close() }}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); close() }}
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={title ? `${title} 操作` : '卡片操作'}
        onKeyDown={onMenuKey}
        onPointerDown={e => e.stopPropagation()}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation() }}
        className="fixed z-50 min-w-[11rem] overflow-hidden rounded-lg border border-slate-600 bg-slate-900 py-1 text-xs shadow-xl"
        style={{ left: Math.min(x, w - 200), top: Math.min(y, h - 40 - items.length * 28) }}
      >
        {title && <div className="border-b border-slate-800 px-3 pb-1.5 pt-1 font-mono text-[11px] text-slate-300" aria-hidden>{title}</div>}
        {items.map(it => (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={it.disabled}
            title={it.hint}
            onClick={() => { close(); it.onClick() }}
            className={`block w-full px-3 py-1.5 text-left outline-none focus-visible:bg-slate-800 ${it.disabled ? 'cursor-not-allowed text-slate-500' : it.danger ? 'text-rose-300 hover:bg-slate-800' : 'text-slate-200 hover:bg-slate-800'}`}
          >{it.label}</button>
        ))}
      </div>
    </>
  )
}
