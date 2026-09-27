'use client'

// 左欄：待排池（D21 左半邊）＋待排區。
//
// D58：待排池一律用「簡化卡片」（SimplePool／SimplePoolCard，只顯示單號、製令、交期、客戶名稱、品項名稱、數量、PACKING），
// 取代 D57 試用的「表格／卡片」切換（PoolTable 已刪除；P0 的 PoolBlock／PackagingCard 仍給 /packaging/pool 用，這裡不再引用）。
// 拖曳：每張簡化卡片自己是 draggable（不再用事件委派）。
// 右鍵選單提供鍵盤／精準操作的替代：「排部分數量…」「直接勾完成」「放到待排區」；卡片根元素帶 data-pool-card-id，這裡依它找回卡片。
//
// D66 手動加入（分線輪，lines.md §5.3）：父層傳了 manual 才啟用——
//   - 待排池標題列「＋加入訂單」→ ManualAddDialog（查單號、勾品項行、加入）
//   - 「手動加入」區塊（'mn'）排在最上面；手動卡右鍵多「改手動加入數量…」「移出待排池」
//   對話框與 API 呼叫都在這裡（(b)）完成，成功後呼叫 manual.onChanged，由父層重新載入工作台。
//   寫入佇列忙碌中（busy）時停用加入／移出，避免與拖曳的寫入交錯。

import { useCallback, useDeferredValue, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { MANUAL_BLOCK_ID, PLACEABLE_BLOCKS, type ManualInclusionMeta, type PoolCardMeta, type YMD } from '@/lib/packaging/scheduleTypes'
import type { PackagingCard, PoolBlock as PoolBlockData, PoolBlockId } from '@/lib/packaging/types'
import SimplePool from './SimplePool'
import { fmtQty } from '@/components/packaging/poolStyles'
import { isPlaceableBlock, ruleForPoolCard } from './boardLocal'
import { md } from './boardFormat'
import ManualAddDialog, { ManualEditDialog, ManualRemoveDialog } from './ManualAddDialog'

/**
 * 側欄區塊順序：D66「手動加入」最上面（主管特地加進來的，最常要找）；
 * 其餘可排的依分配優先序 PLACEABLE_BLOCKS，不可排的提醒區塊（3、5c）放最後
 */
const SIDEBAR_ORDER: PoolBlockId[] = [MANUAL_BLOCK_ID, ...PLACEABLE_BLOCKS.filter(b => b !== MANUAL_BLOCK_ID), '3', '5c']
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

/** D66 手動加入的設定（父層傳了才顯示「＋加入訂單」與手動卡的選單） */
export interface PoolManualProps {
  /** 持有編輯鎖 */
  editable: boolean
  /** 寫入佇列忙碌中（useBoard.pending > 0）時停用加入／移出，避免與拖曳交錯 */
  busy: boolean
  getLockToken: () => string | null
  today: YMD
  /** 加入／改數量／移出成功（父層重新載入工作台） */
  onChanged: () => void
}

type ManualDialog =
  | { t: 'add' }
  | { t: 'edit'; card: PackagingCard; meta: ManualInclusionMeta; placedQty: number }
  | { t: 'remove'; card: PackagingCard; meta: ManualInclusionMeta }

export default function PoolSidebar({
  blocks, cardMeta, today, rollTarget, canDrag, editable, dragKind, onOpenOrder, onPoolAction, children, manual,
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
  /** 待排池下方（待排區、頁尾資訊） */
  children?: ReactNode
  /**
   * D66：傳了才顯示「＋加入訂單」與手動卡的「改數量／移出待排池」選單。
   * 對話框與 API 呼叫都在這裡完成；成功後呼叫 onChanged，父層重新載入工作台。
   */
  manual?: PoolManualProps
}) {
  const [keyword, setKeyword] = useState('')
  const deferred = useDeferredValue(keyword)
  const [collapsed, setCollapsed] = useState<Set<PoolBlockId>>(() => (typeof window === 'undefined' ? new Set() : readCollapsed()))
  const [menu, setMenu] = useState<{ x: number; y: number; card: PackagingCard } | null>(null)
  const [manualDialog, setManualDialog] = useState<ManualDialog | null>(null)
  const manualWritable = !!manual && manual.editable && !manual.busy

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

  // 「放回待排池」：從右側把排定列拖回來
  const { setNodeRef: setDropNode, isOver } = useDroppable({ id: 'pool', disabled: dragKind !== 'placement' })

  /** 從事件目標找出被按住的待排池卡（卡片根元素帶 data-pool-card-id） */
  const cardFromEvent = useCallback((e: MouseEvent): PackagingCard | null => {
    const el = (e.target as HTMLElement | null)?.closest('[data-pool-card-id]')
    const id = el?.getAttribute('data-pool-card-id')
    if (!id) return null
    for (const list of viewCards.values()) {
      const card = list.find(c => c.cardId === id)
      if (card) return card
    }
    return null
  }, [viewCards])

  const onContextMenu = (e: MouseEvent) => {
    if (!editable && !(manual?.editable)) return
    const card = cardFromEvent(e)
    if (!card) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, card })
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
        {manual && (
          <button
            type="button"
            onClick={() => setManualDialog({ t: 'add' })}
            disabled={manual.busy}
            title={!manual.editable ? '查詢訂單品項為什麼不在待排池；取得編輯權後才能加入'
              : manual.busy ? '儲存中，請稍候' : '手動把不在待排池的訂單品項加進來排程（D66）'}
            className="rounded border border-violet-700 bg-violet-950/40 px-2 py-0.5 text-[11px] font-semibold text-violet-200 hover:bg-violet-900/50 disabled:opacity-40"
          >＋加入訂單</button>
        )}
        <div className="flex-1" />
        <button type="button" onClick={() => setAll(false)} className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400 hover:text-white">全部展開</button>
        <button type="button" onClick={() => setAll(true)} className="rounded border border-slate-700 px-2 py-0.5 text-[11px] text-slate-400 hover:text-white">全部收合</button>
      </div>
      <input
        type="search"
        value={keyword}
        onChange={e => setKeyword(e.target.value)}
        placeholder="搜尋 SO、製令、品名、客戶、單號…"
        className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
      />
      {canDrag ? (
        <p className="text-[11px] leading-snug text-slate-500">
          拖曳卡片到右側日期＝排定；拖到下方「待排區」＝先擱置。右鍵可「排部分數量」「直接勾完成」。
          滑鼠停在卡片上可看工時、品項編碼、備註與提醒；點卡片看卡片詳情，點單號看訂單詳情。
        </p>
      ) : (
        <p className="text-[11px] leading-snug text-slate-500">點卡片看卡片詳情（工時、備註、提醒），點單號看訂單詳情。</p>
      )}
      {dragKind === 'placement' && (
        <div className="rounded-lg border border-dashed border-sky-600 bg-sky-950/30 px-3 py-2 text-center text-xs text-sky-200">放到這裡＝放回待排池</div>
      )}

      <div onContextMenu={onContextMenu}>
        <SimplePool
          blocks={ordered}
          viewCards={viewCards}
          cardMeta={cardMeta}
          filtered={!!q}
          collapsed={collapsed}
          onToggle={toggle}
          showManualTag={!!manual}
          today={today}
          canDrag={canDrag}
          dragging={dragKind != null}
          onOpenOrder={onOpenOrder}
        />
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
            style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.max(8, Math.min(menu.y, window.innerHeight - 260)) }}
          >
            <div className="border-b border-slate-800 px-3 pb-1.5 pt-1 text-[11px] text-slate-400">
              <div className="font-mono text-slate-200">{menu.card.so}{menu.card.soLine ? `-${menu.card.soLine}` : ''}</div>
              {(() => {
                const m = cardMeta[menu.card.cardId]
                return m ? <div>剩 {fmtQty(m.remainingQty)}{m.placedQty > 0 ? `・已排 ${fmtQty(m.placedQty)}／${fmtQty(m.originalQty)}` : ''}</div> : null
              })()}
            </div>
            {isPlaceableBlock(menu.card.block) && editable ? (
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
            ) : !isPlaceableBlock(menu.card.block) ? (
              <div className="px-3 py-1.5 text-slate-500">這一區不能排</div>
            ) : null}
            {(() => {
              // D66 手動卡：改數量／移出（寫入佇列忙碌中先停用）
              const m = cardMeta[menu.card.cardId]
              if (!manual || menu.card.block !== MANUAL_BLOCK_ID || !m?.manual) return null
              const mm = m.manual
              const hint = !manual.editable ? '需要編輯權' : manual.busy ? '儲存中，請稍候' : undefined
              return (
                <div className="border-t border-slate-800">
                  <MenuItem label="改手動加入數量…" disabled={!manualWritable} hint={hint}
                    onClick={() => { setManualDialog({ t: 'edit', card: menu.card, meta: mm, placedQty: m.placedQty }); setMenu(null) }} />
                  <MenuItem label="移出待排池" disabled={!manualWritable} hint={hint}
                    onClick={() => { setManualDialog({ t: 'remove', card: menu.card, meta: mm }); setMenu(null) }} />
                </div>
              )
            })()}
            <MenuItem label="訂單詳情" onClick={() => { onOpenOrder(menu.card.so); setMenu(null) }} />
          </div>
        </>
      )}

      {/* ── D66 手動加入的對話框 ── */}
      {manual && manualDialog?.t === 'add' && (
        <ManualAddDialog
          editable={manual.editable && !manual.busy}
          getLockToken={manual.getLockToken}
          onClose={() => setManualDialog(null)}
          onChanged={manual.onChanged}
        />
      )}
      {manual && manualDialog?.t === 'edit' && (
        <ManualEditDialog
          card={manualDialog.card}
          meta={manualDialog.meta}
          placedQty={manualDialog.placedQty}
          getLockToken={manual.getLockToken}
          onClose={() => setManualDialog(null)}
          onChanged={manual.onChanged}
        />
      )}
      {manual && manualDialog?.t === 'remove' && (
        <ManualRemoveDialog
          card={manualDialog.card}
          meta={manualDialog.meta}
          getLockToken={manual.getLockToken}
          onClose={() => setManualDialog(null)}
          onChanged={manual.onChanged}
        />
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
