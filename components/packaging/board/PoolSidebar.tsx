'use client'

// 左欄：待排池（D21 左半邊）＋待排區。
//
// 卡片與區塊一律沿用 P0 的 PoolBlock／PackagingCard（兩個檔都不改）。
// PoolBlock 內部直接渲染 PackagingCard、沒有預留「包一層」的插槽，所以拖曳用「事件委派」：
//   整個待排池只註冊一個 draggable（id = 'poolcard'），監聽器掛在外層容器；
//   pointerdown 時從事件目標往上找 <article>（PackagingCard 的根元素）與所在區塊（data-pool-block），
//   以「第幾個 article」對回 PoolBlock 收到的 cards 陣列（PoolBlock 依序渲染 cards.slice(0, limit)），
//   再把 draggable 的節點指到那張 article（DragOverlay 才會從卡片原位置起飛），最後交給 dnd-kit 的監聽器。
// 右鍵選單提供鍵盤／精準操作的替代：「排部分數量…」「直接勾完成」「放到待排區」。

import { useCallback, useDeferredValue, useMemo, useState, type MouseEvent, type ReactNode, type SyntheticEvent } from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'
import { PLACEABLE_BLOCKS, type PoolCardMeta } from '@/lib/packaging/scheduleTypes'
import type { PackagingCard, PoolBlock as PoolBlockData, PoolBlockId } from '@/lib/packaging/types'
import PoolBlock from '@/components/packaging/PoolBlock'
import { fmtQty } from '@/components/packaging/poolStyles'
import { isPlaceableBlock, ruleForPoolCard } from './boardLocal'
import { md } from './boardFormat'

/** 側欄區塊順序：可排的在前（依分配優先序 PLACEABLE_BLOCKS），不可排的提醒區塊（3、5c）放最後 */
const SIDEBAR_ORDER: PoolBlockId[] = [...PLACEABLE_BLOCKS, '3', '5c']
const COLLAPSE_KEY = 'packaging.schedule.poolCollapsed.v1'

function readCollapsed(): Set<PoolBlockId> {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(arr) ? arr.filter((x): x is PoolBlockId => typeof x === 'string' && (SIDEBAR_ORDER as string[]).includes(x)) : [])
  } catch { return new Set() }
}
function writeCollapsed(s: Set<PoolBlockId>) {
  try { window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...s])) } catch { /* 存不進去就算了 */ }
}

function haystack(c: PackagingCard): string {
  return [c.so, c.soLineKey, c.customer, c.itemName, c.itemCode, ...c.sources.map(s => s.docNo), c.preStation?.moNbr]
    .filter(Boolean).join('\n').toLowerCase()
}

export type PoolAction = 'partial' | 'complete' | 'holding'

export default function PoolSidebar({
  blocks, cardMeta, today, rollTarget, canDrag, editable, dragKind, onOpenOrder, onPoolAction, changpingSyncLabel, children,
}: {
  blocks: PoolBlockData[]
  cardMeta: Record<string, PoolCardMeta>
  today: string
  /** 順延目標日（「直接勾完成」會排到這天） */
  rollTarget: string
  canDrag: boolean
  editable: boolean
  /** 目前拖曳中的是哪一種卡（擺放卡拖回來＝放回待排池） */
  dragKind: 'pool' | 'placement' | null
  onOpenOrder: (so: string) => void
  onPoolAction: (card: PackagingCard, action: PoolAction) => void
  changpingSyncLabel?: string
  /** 待排池下方（待排區、頁尾資訊） */
  children?: ReactNode
}) {
  const [keyword, setKeyword] = useState('')
  const deferred = useDeferredValue(keyword)
  const [collapsed, setCollapsed] = useState<Set<PoolBlockId>>(() => (typeof window === 'undefined' ? new Set() : readCollapsed()))
  const [menu, setMenu] = useState<{ x: number; y: number; card: PackagingCard } | null>(null)
  const [picked, setPicked] = useState<PackagingCard | null>(null)

  const blockMap = useMemo(() => new Map(blocks.map(b => [b.id, b])), [blocks])
  const ordered = useMemo(() => SIDEBAR_ORDER.map(id => blockMap.get(id)).filter((b): b is PoolBlockData => !!b), [blockMap])

  const q = deferred.trim().toLowerCase()
  const viewCards = useMemo(() => {
    const m = new Map<PoolBlockId, PackagingCard[]>()
    for (const b of ordered) m.set(b.id, q ? b.cards.filter(c => haystack(c).includes(q)) : b.cards)
    return m
  }, [ordered, q])

  const toggle = (id: PoolBlockId) => setCollapsed(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    writeCollapsed(next)
    return next
  })
  const setAll = (c: boolean) => {
    const next = c ? new Set(ordered.map(b => b.id)) : new Set<PoolBlockId>()
    writeCollapsed(next)
    setCollapsed(next)
  }

  // ── 拖曳（事件委派，見檔頭說明） ──
  const { setNodeRef: setDragNode, listeners } = useDraggable({
    id: 'poolcard',
    data: { kind: 'pool', card: picked },
    disabled: !canDrag,
  })
  const { setNodeRef: setDropNode, isOver } = useDroppable({ id: 'pool', disabled: dragKind !== 'placement' })

  /** 從事件目標找出被按住的待排池卡 */
  const cardFromEvent = useCallback((e: SyntheticEvent): { card: PackagingCard; el: HTMLElement } | null => {
    const target = e.target as HTMLElement | null
    const art = target?.closest('article') as HTMLElement | null
    const blk = art?.closest('[data-pool-block]') as HTMLElement | null
    if (!art || !blk) return null
    const id = blk.getAttribute('data-pool-block') as PoolBlockId
    const idx = Array.from(blk.querySelectorAll('article')).indexOf(art)
    const card = viewCards.get(id)?.[idx]
    return card ? { card, el: art } : null
  }, [viewCards])

  const delegated = useMemo(() => {
    if (!canDrag || !listeners) return {}
    const out: Record<string, (e: SyntheticEvent) => void> = {}
    for (const [name, fn] of Object.entries(listeners)) {
      out[name] = (e: SyntheticEvent) => {
        const hit = cardFromEvent(e)
        if (!hit || !isPlaceableBlock(hit.card.block)) return
        setPicked(hit.card)
        setDragNode(hit.el)
        ;(fn as (ev: SyntheticEvent) => void)(e)
      }
    }
    return out
  }, [canDrag, listeners, cardFromEvent, setDragNode])

  const onContextMenu = (e: MouseEvent) => {
    if (!editable) return
    const hit = cardFromEvent(e)
    if (!hit) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, card: hit.card })
  }

  const totalCards = ordered.reduce((n, b) => n + b.cardCount, 0)

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {/* 「放回待排池」的 droppable 只包待排池本身，不包下方的待排區（兩個 droppable 巢狀時，碰撞判定會搶） */}
      <div
        ref={setDropNode}
        className={`flex flex-col gap-3 rounded-xl ${isOver ? 'bg-sky-950/40 ring-2 ring-sky-500/70' : ''}`}
      >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-bold text-slate-100">待排池 <span className="font-normal text-slate-400">（{totalCards} 張）</span></h2>
        <div className="flex-1" />
        <button type="button" onClick={() => setAll(false)} className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400 hover:text-white">全部展開</button>
        <button type="button" onClick={() => setAll(true)} className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400 hover:text-white">全部收合</button>
      </div>
      <input
        type="search"
        value={keyword}
        onChange={e => setKeyword(e.target.value)}
        placeholder="搜尋 SO、品名、客戶、單號…"
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
      />
      {canDrag ? (
        <p className="text-[11px] leading-snug text-slate-500">拖曳卡片到右側日期欄＝排定；拖到下方「待排區」＝先擱置。右鍵卡片可「排部分數量」「直接勾完成」。</p>
      ) : null}
      {dragKind === 'placement' && (
        <div className="rounded-lg border border-dashed border-sky-600 bg-sky-950/30 px-3 py-2 text-center text-xs text-sky-200">放到這裡＝放回待排池</div>
      )}

      <div
        {...delegated}
        onContextMenu={onContextMenu}
        className="space-y-3"
      >
        {ordered.map(b => {
          const placeable = isPlaceableBlock(b.id)
          const notice = !placeable ? (
            <div className="rounded border border-rose-800/60 bg-rose-950/30 px-2 py-1 text-[11px] text-rose-200">
              這一區不能排到日期（{b.id === '3' ? 'D22：未寄出不預排，僅提醒' : '出貨與否不明，比照未寄出'}）
            </div>
          ) : undefined
          return (
            <div key={b.id} data-pool-block={b.id} className={placeable && canDrag ? '[&_article]:cursor-grab' : ''}>
              <PoolBlock
                block={b}
                cards={viewCards.get(b.id) ?? []}
                filtered={!!q}
                collapsed={collapsed.has(b.id)}
                onToggle={() => toggle(b.id)}
                onOpenOrder={onOpenOrder}
                today={today}
                notice={notice}
                changpingSyncLabel={changpingSyncLabel}
              />
            </div>
          )
        })}
      </div>
      </div>

      {children}

      {/* ── 右鍵選單 ── */}
      {menu && (
        <>
          <div className="fixed inset-0 z-40" onPointerDown={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null) }} />
          <div
            role="menu"
            className="fixed z-50 min-w-[12rem] overflow-hidden rounded-lg border border-slate-600 bg-slate-900 py-1 text-xs shadow-xl"
            style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 180) }}
          >
            <div className="border-b border-slate-800 px-3 pb-1.5 pt-1 text-[11px] text-slate-400">
              <div className="font-mono text-slate-200">{menu.card.so}{menu.card.soLine ? `-${menu.card.soLine}` : ''}</div>
              {(() => {
                const m = cardMeta[menu.card.cardId]
                return m ? <div>剩 {fmtQty(m.remainingQty)}{m.placedQty > 0 ? `・已排 ${fmtQty(m.placedQty)}／${fmtQty(m.originalQty)}` : ''}</div> : null
              })()}
            </div>
            {isPlaceableBlock(menu.card.block) ? (
              <>
                <MenuItem label="排部分數量…" onClick={() => { onPoolAction(menu.card, 'partial'); setMenu(null) }} />
                {(() => {
                  // 預排卡（預估可包日晚於順延目標日）：伺服器 place 會先驗 D22 → 一定 422 before_est_ready。
                  // 先停用並說明原因；「現場已包完但塔台還沒跟上」是否允許直接完成，待 Snow 決定。
                  const minDate = ruleForPoolCard(menu.card).minDate
                  const pre = minDate != null && minDate > rollTarget
                  return pre
                    ? <MenuItem label="直接勾完成（排到今天並完成）" disabled hint={`預排卡：預估 ${md(minDate)} 才可包，不能直接完成`} onClick={() => {}} />
                    : <MenuItem label="直接勾完成（排到今天並完成）" onClick={() => { onPoolAction(menu.card, 'complete'); setMenu(null) }} />
                })()}
                <MenuItem label="放到待排區" onClick={() => { onPoolAction(menu.card, 'holding'); setMenu(null) }} />
              </>
            ) : (
              <div className="px-3 py-1.5 text-slate-500">這一區不能排</div>
            )}
            <MenuItem label="訂單詳情" onClick={() => { onOpenOrder(menu.card.so); setMenu(null) }} />
          </div>
        </>
      )}
    </div>
  )
}

function MenuItem({ label, onClick, disabled, hint }: { label: string; onClick: () => void; disabled?: boolean; hint?: string }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={hint}
      className={`block w-full px-3 py-1.5 text-left ${disabled ? 'cursor-not-allowed text-slate-500' : 'text-slate-200 hover:bg-slate-800'}`}
    >
      {label}
      {hint && <span className="block text-[10px] leading-snug text-slate-500">{hint}</span>}
    </button>
  )
}
