'use client'

// 日期欄／待排區裡的一張（子）卡：外框包裝。
// **卡片本體原樣渲染 P0 的 PackagingCard（樣式不改，延後細節「卡片樣式先不動」）**，
// 預排虛線、延誤標籤、完成勾選、選單等全部加在外框上。

import { useState, type ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'
import type { BoardCard, PlacementFlag } from '@/lib/packaging/scheduleTypes'
import PackagingCard from '@/components/packaging/PackagingCard'
import { clock, md } from './boardFormat'

export interface CardMenuHandlers {
  onToggleComplete: (bc: BoardCard) => void
  onSplit: (bc: BoardCard) => void
  onMoveTo: (bc: BoardCard) => void
  onToHolding: (bc: BoardCard) => void
  onUnplace: (bc: BoardCard) => void
  /** 同欄同行 ≥ 2 張未完成子卡時才有 */
  onMerge?: (bc: BoardCard) => void
}

const WARN_FRAME_CODES = new Set(['pre_due', 'before_est_ready', 'line_eta_passed'])

const FLAG_CHIP: Record<PlacementFlag['level'], string> = {
  danger: 'border-red-500/70 bg-red-950/60 text-red-200',
  warn: 'border-orange-500/70 bg-orange-950/50 text-orange-200',
  info: 'border-slate-600 bg-slate-800/80 text-slate-300',
}

function Menu({ items, onClose }: { items: { label: string; onClick: () => void; danger?: boolean }[]; onClose: () => void }) {
  return (
    <>
      {/* 透明底層：點外面就關閉 */}
      <div className="fixed inset-0 z-40" onPointerDown={e => { e.stopPropagation(); onClose() }} />
      <div
        role="menu"
        className="absolute right-1 top-7 z-50 min-w-[10rem] overflow-hidden rounded-lg border border-slate-600 bg-slate-900 py-1 text-xs shadow-xl"
        onPointerDown={e => e.stopPropagation()}
      >
        {items.map(it => (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            onClick={() => { onClose(); it.onClick() }}
            className={`block w-full px-3 py-1.5 text-left hover:bg-slate-800 ${it.danger ? 'text-rose-300' : 'text-slate-200'}`}
          >{it.label}</button>
        ))}
      </div>
    </>
  )
}

/** 純外觀（拖曳中的 DragOverlay 也用它） */
export function CardFrame({ bc, today, editable, onOpenOrder, handlers, changpingSyncLabel, isOverlay = false, dragHandle }: {
  bc: BoardCard
  today: string
  /** 持有編輯鎖（可勾完成、開選單） */
  editable: boolean
  onOpenOrder: (so: string) => void
  handlers?: CardMenuHandlers
  changpingSyncLabel?: string
  isOverlay?: boolean
  dragHandle?: ReactNode
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const done = !!bc.completed
  const consumed = bc.flags.some(f => f.code === 'pool_consumed' || f.code === 'not_placeable_now') && bc.effectiveQty <= 0
  const pre = bc.readiness !== 'ready'
  const warnFrame = bc.flags.some(f => WARN_FRAME_CODES.has(f.code))
  const delayed = bc.flags.find(f => f.code === 'delayed')
  const otherFlags = bc.flags.filter(f => f.code !== 'delayed')

  // D22 預排：外層 2px 虛線（藍＝正常預排、橘＝到期未就緒／排在預估可包日之前）
  const outline = pre || warnFrame
    ? `outline-2 outline-dashed outline-offset-2 ${warnFrame ? 'outline-orange-400' : 'outline-sky-400/80'}`
    : ''

  const menuItems: { label: string; onClick: () => void; danger?: boolean }[] = []
  if (handlers && editable && !done) {
    if (!consumed) {
      menuItems.push({ label: '拆卡…', onClick: () => handlers.onSplit(bc) })
      menuItems.push({ label: '移到日期…', onClick: () => handlers.onMoveTo(bc) })
      if (bc.displayDate != null) menuItems.push({ label: '移到待排區', onClick: () => handlers.onToHolding(bc) })
      if (handlers.onMerge) menuItems.push({ label: '合併同行子卡', onClick: () => handlers.onMerge!(bc) })
    }
    menuItems.push({ label: '放回待排池', onClick: () => handlers.onUnplace(bc), danger: true })
  }
  menuItems.push({ label: '訂單詳情', onClick: () => onOpenOrder(bc.card.so) })

  return (
    <div
      className={`relative rounded-lg ${outline} ${isOverlay ? 'w-[264px] rotate-1 shadow-2xl ring-2 ring-sky-400' : ''} ${consumed ? 'grayscale' : ''}`}
    >
      {/* ── 外框頂列：完成勾選、延誤、預排、拆卡、選單 ── */}
      <div className="flex items-center gap-1 pb-1 text-[10px]">
        {dragHandle}
        <label
          className={`flex items-center gap-1 rounded px-1 py-0.5 ${editable && !consumed ? 'cursor-pointer hover:bg-slate-800' : 'cursor-default'}`}
          title={done
            ? `已完成：${bc.completed!.byName ?? bc.completed!.by}（${clock(bc.completed!.at)}）；取消勾選可還原`
            : editable ? '勾選＝包裝完成（D24，不回寫塔台）' : '唯讀模式'}
          onPointerDown={e => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={done}
            disabled={!editable || !handlers || (consumed && !done)}
            onChange={() => handlers?.onToggleComplete(bc)}
            className="h-3.5 w-3.5 accent-emerald-500"
          />
          <span className={done ? 'font-semibold text-emerald-300' : 'text-slate-400'}>{done ? '已完成' : '完成'}</span>
        </label>
        {delayed && (
          <span title={delayed.label} className="rounded bg-orange-600 px-1.5 py-0.5 font-bold text-white">
            {delayed.label}
          </span>
        )}
        {pre && !done && (
          <span
            title="D22 預排：尚未入庫／前站未完工的量"
            className={`rounded border px-1 py-0.5 ${warnFrame ? 'border-orange-500/70 text-orange-200' : 'border-sky-500/60 text-sky-200'}`}
          >
            {bc.readiness === 'pre' && bc.preReadyDate ? `預排 ${md(bc.preReadyDate)} 可包` : '預排・可包日未知'}
          </span>
        )}
        {bc.qty !== bc.effectiveQty && !consumed && (
          <span title={`儲存數量 ${bc.qty}，待排池減少後有效 ${bc.effectiveQty}`} className="text-slate-400">
            有效 {bc.effectiveQty}／{bc.qty}
          </span>
        )}
        {bc.source === 'ai' && <span className="rounded border border-violet-500/60 px-1 text-violet-200">AI</span>}
        <span className="flex-1" />
        {!isOverlay && (
          <button
            type="button"
            aria-label="卡片選單"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onPointerDown={e => e.stopPropagation()}
            onClick={() => setMenuOpen(v => !v)}
            className="rounded px-1.5 text-sm leading-none text-slate-400 hover:bg-slate-800 hover:text-white"
          >⋯</button>
        )}
        {menuOpen && <Menu items={menuItems} onClose={() => setMenuOpen(false)} />}
      </div>

      {otherFlags.length > 0 && (
        <div className="flex flex-wrap gap-1 pb-1">
          {otherFlags.map(f => (
            <span key={f.code} title={f.label} className={`rounded border px-1.5 py-px text-[10px] ${FLAG_CHIP[f.level]}`}>{f.label}</span>
          ))}
        </div>
      )}

      {consumed && !done && editable && handlers && (
        <div className="mb-1 flex items-center gap-2 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-400">
          <span className="flex-1">已由待排池扣完，不需再包</span>
          <button
            type="button"
            onPointerDown={e => e.stopPropagation()}
            onClick={() => handlers.onUnplace(bc)}
            className="rounded border border-slate-600 px-2 py-0.5 text-slate-200 hover:bg-slate-800"
          >移除</button>
        </div>
      )}

      <div className={`relative ${done ? 'opacity-50' : ''}`}>
        <PackagingCard card={bc.card} today={today} onOpenOrder={onOpenOrder} changpingSyncLabel={changpingSyncLabel} />
        {done && (
          <span className="pointer-events-none absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white shadow" aria-hidden>✓</span>
        )}
      </div>
    </div>
  )
}

export default function DraggableCard(props: {
  bc: BoardCard
  today: string
  editable: boolean
  /** 桌機且持有鎖；已完成的卡一律不可拖 */
  canDrag: boolean
  onOpenOrder: (so: string) => void
  handlers: CardMenuHandlers
  changpingSyncLabel?: string
}) {
  const { canDrag, ...frameProps } = props
  const { bc } = props
  const disabled = !canDrag || !!bc.completed
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `pl:${bc.placementId}`,
    data: { kind: 'placement', bc },
    disabled,
  })
  // 不套 transform：拖曳中顯示的是 DragOverlay，原位置只變淡（避免欄內捲動時原卡跟著抖）
  return (
    <div
      ref={setNodeRef}
      {...(disabled ? {} : listeners)}
      {...(disabled ? {} : attributes)}
      aria-roledescription={disabled ? undefined : '可拖曳的排程卡'}
      className={`${disabled ? '' : 'cursor-grab active:cursor-grabbing'} ${isDragging ? 'opacity-30' : ''} touch-manipulation`}
    >
      <CardFrame {...frameProps} />
    </div>
  )
}
