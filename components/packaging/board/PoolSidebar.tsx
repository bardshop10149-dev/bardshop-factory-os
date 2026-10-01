'use client'

// 左欄：待排池（D21 左半邊）＋待排區。
//
// D58：待排池一律用「簡化卡片」（SimplePool／SimplePoolCard，只顯示單號、製令、交期、客戶名稱、品項名稱、數量、PACKING），
// 取代 D57 試用的「表格／卡片」切換（PoolTable 已刪除；P0 的 PoolBlock／PackagingCard 仍給 /packaging/pool 用，這裡不再引用）。
// 拖曳：每張簡化卡片自己是 draggable（不再用事件委派）。
// 右鍵選單提供鍵盤／精準操作的替代：「排部分數量…」「直接勾完成」「放到待排區」；卡片根元素帶 data-pool-card-id，這裡依它找回卡片。
//
// D66 手動加入（分線輪，lines.md §5.3）：「手動加入」區塊（'mn'）排在最上面，手動卡上方有「手動・誰・何時」標記，
//   照樣可拖、可「排部分數量／直接勾完成／放到待排區」。
// D102（Snow：「所有可排的卡片都在那張卡裡面控制」）：手動加入的「＋加入訂單」「改數量」「移出待排池」
//   全部搬到待排池頁（/packaging/pool），這裡不再有任何管理入口（標題列按鈕、右鍵項目、對話框都拿掉）。
//   - showManualTag：是否顯示手動標記（工作台傳 true；AI 模擬區不傳＝維持原樣不顯示）
//   - manualManageHref：傳了就在說明列與手動卡右鍵放「到待排池頁」連結（新分頁開：工作台的編輯權、
//     尚未存完的操作與 Undo 紀錄都留在原分頁；改完回來按「重新整理」即可）
//   - manual（舊 prop）：@deprecated，只剩「傳了＝顯示手動標記」的作用，讓舊呼叫端能編譯、行為不出錯
// D111：「已入庫」區塊（2、5b）可切換「依入庫日（舊→新）」排序；每一區各自記住選擇（localStorage，讀寫都包 try/catch）。
//   排序在這裡做（viewCards），右鍵找卡、搜尋都沿用同一份清單；正式工作台與 AI 模擬區共用這個元件，所以兩邊都有。
// D113 排程區單號搜尋：reveal＝工具列「找卡」要跳到的待排池卡；這裡負責讓它看得到（展開區塊、必要時清掉本欄關鍵字、多畫幾頁），
//   捲動與發光由頁面（cardJump）處理。本欄的關鍵字框只過濾左欄，和工具列的「找卡」是兩回事。

import { useCallback, useDeferredValue, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { useDroppable } from '@dnd-kit/core'
import { MANUAL_BLOCK_ID, PLACEABLE_BLOCKS, type PoolCardMeta, type YMD } from '@/lib/packaging/scheduleTypes'
import type { PackagingCard, PoolBlock as PoolBlockData, PoolBlockId } from '@/lib/packaging/types'
import SimplePool from './SimplePool'
import { fmtQty } from '@/components/packaging/poolStyles'
import { isPlaceableBlock, ruleForPoolCard } from './boardLocal'
import { md } from './boardFormat'
import { RECEIVED_BLOCKS, sortByReceiptDate } from '@/lib/packaging/receipts'

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

const RECEIPT_SORT_KEY = 'packaging.schedule.poolReceiptSort.v1'

/** D111：哪些「已入庫」區塊要依入庫日排序（讀不到、格式不對 → 都用預設排序） */
function readReceiptSort(): Set<PoolBlockId> {
  try {
    const raw = window.localStorage.getItem(RECEIPT_SORT_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(arr) ? arr.filter((x): x is PoolBlockId => typeof x === 'string' && (RECEIVED_BLOCKS as readonly string[]).includes(x)) : [])
  } catch { return new Set() }
}
function writeReceiptSort(s: Set<PoolBlockId>) {
  try { window.localStorage.setItem(RECEIPT_SORT_KEY, JSON.stringify([...s])) } catch { /* 存不進去就算了（無痕模式等） */ }
}

function haystack(c: PackagingCard): string {
  return [c.so, c.soLineKey, c.customer, c.itemName, c.itemCode, ...c.sources.map(s => s.docNo), c.preStation?.moNbr]
    .filter(Boolean).join('\n').toLowerCase()
}

export type PoolAction = 'partial' | 'complete' | 'holding'

/**
 * @deprecated D102：手動加入的管理已搬到待排池頁。保留型別只為舊呼叫端能編譯；
 * 傳了 manual 只會讓手動卡顯示「手動」標記（等同 showManualTag），不再啟用任何加入／改量／移出入口。
 */
export interface PoolManualProps {
  editable: boolean
  busy: boolean
  getLockToken?: () => string | null
  today: YMD
  onChanged: () => void
}

export default function PoolSidebar({
  blocks, cardMeta, today, rollTarget, canDrag, editable, dragKind, onOpenOrder, onPoolAction, children, manual,
  showManualTag, manualManageHref, onCloseLine, reveal = null,
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
  /** @deprecated D102：見 PoolManualProps。只剩「傳了＝顯示手動標記」的作用 */
  manual?: PoolManualProps
  /** D102：手動卡顯示「手動・誰・何時」標記。省略＝跟著 manual（舊行為：傳了 manual 才顯示） */
  showManualTag?: boolean
  /** D102：手動加入的管理頁（工作台傳 '/packaging/pool'；AI 模擬區不傳＝不提示） */
  manualManageHref?: string
  /** D104：右鍵「結案」（不需編輯鎖，只需 packaging_admin；工作台在 me.canEdit 時傳；AI 模擬區由該區自己決定） */
  onCloseLine?: (card: PackagingCard) => void
  /** D113 排程區單號搜尋要跳到這張待排池卡：nonce 每次 +1（同一張卡再跳一次也要重新揭露） */
  reveal?: { cardId: string; nonce: number } | null
}) {
  const [keyword, setKeyword] = useState('')
  const deferred = useDeferredValue(keyword)
  const [collapsed, setCollapsed] = useState<Set<PoolBlockId>>(() => (typeof window === 'undefined' ? new Set() : readCollapsed()))
  const [receiptSorted, setReceiptSorted] = useState<Set<PoolBlockId>>(() => (typeof window === 'undefined' ? new Set() : readReceiptSort()))
  const [menu, setMenu] = useState<{ x: number; y: number; card: PackagingCard } | null>(null)
  const manualTagOn = showManualTag ?? !!manual

  const blockMap = useMemo(() => new Map(blocks.map(b => [b.id, b])), [blocks])
  const ordered = useMemo(() => SIDEBAR_ORDER.map(id => blockMap.get(id)).filter((b): b is PoolBlockData => !!b), [blockMap])

  // D113 排程區單號搜尋跳到待排池卡：卡片所在區塊收合 → 展開；被左欄關鍵字濾掉 → 清掉關鍵字（只有真的被濾掉才清，保留使用者的篩選）。
  // 只改畫面上的 state、不寫 localStorage（使用者的收合偏好不變）。「依 prop 變化調整 state」寫法：render 中比對前值（同 SimplePool）。
  // 「顯示更多」後面的卡由 Section 自己多畫幾頁（revealCardId 往下傳）。
  const [seenReveal, setSeenReveal] = useState<number | null>(null)
  if (reveal && reveal.nonce !== seenReveal) {
    setSeenReveal(reveal.nonce)
    for (const b of ordered) {
      const card = b.cards.find(c => c.cardId === reveal.cardId)
      if (!card) continue
      if (collapsed.has(b.id)) {
        const next = new Set(collapsed)
        next.delete(b.id)
        setCollapsed(next)
      }
      const kw = keyword.trim().toLowerCase()
      if (kw && !haystack(card).includes(kw)) setKeyword('')
      break
    }
  }

  const q = deferred.trim().toLowerCase()
  const viewCards = useMemo(() => {
    const m = new Map<PoolBlockId, PackagingCard[]>()
    for (const b of ordered) {
      const list = q ? b.cards.filter(c => haystack(c).includes(q)) : b.cards
      // D111：已入庫區塊可依入庫日（舊→新）排序；穩定排序，同一天入庫的維持預設順序
      m.set(b.id, receiptSorted.has(b.id) ? sortByReceiptDate(list) : list)
    }
    return m
  }, [ordered, q, receiptSorted])

  const onReceiptSort = useCallback((id: PoolBlockId, on: boolean) => setReceiptSorted(prev => {
    if (prev.has(id) === on) return prev
    const next = new Set(prev)
    if (on) next.add(id)
    else next.delete(id)
    writeReceiptSort(next)
    return next
  }), [])

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
    // D102 前是 !editable && !manual.editable；manual.editable 本來就等於 editable，拿掉 manual 後結果相同
    if (!editable) return
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
      {manualManageHref && (
        // D102：工作台不再有「＋加入訂單」；告訴主管去哪裡做，並說明回來要按重新整理
        <p className="text-[11px] leading-snug text-slate-500">
          手動加入訂單、改數量、移出請到
          <Link href={manualManageHref} target="_blank" rel="noopener" className="mx-0.5 text-amber-300 underline decoration-dotted hover:text-amber-200">待排池頁 ↗</Link>
          （新分頁開啟；改完回這裡按「重新整理」就看得到）。
        </p>
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
          showManualTag={manualTagOn}
          receiptSorted={receiptSorted}
          onReceiptSort={onReceiptSort}
          today={today}
          canDrag={canDrag}
          dragging={dragKind != null}
          onOpenOrder={onOpenOrder}
          revealCardId={reveal?.cardId ?? null}
          revealNonce={reveal?.nonce ?? 0}
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
            {manualManageHref && menu.card.block === MANUAL_BLOCK_ID && (
              // D102：手動卡的改數量／移出在待排池頁；這裡只留一個連結（新分頁，工作台的鎖與未存操作不受影響）
              <div className="border-t border-slate-800">
                <Link
                  href={manualManageHref}
                  target="_blank"
                  rel="noopener"
                  role="menuitem"
                  onClick={() => setMenu(null)}
                  className="block w-full px-3 py-1.5 text-left text-amber-200 hover:bg-slate-800"
                >
                  改數量／移出：到待排池頁 ↗
                  <span className="block text-[10px] leading-snug text-slate-500">新分頁開啟；改完回這裡按「重新整理」</span>
                </Link>
              </div>
            )}
            {onCloseLine && (
              <div className="border-t border-slate-800">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { onCloseLine(menu.card); setMenu(null) }}
                  title="整個 SO 品項行永久不再進待排池；同行未完成的排定卡一併放回；可在已結案清單復原"
                  className="block w-full px-3 py-1.5 text-left text-rose-300 hover:bg-slate-800"
                >
                  結案（不再拉回待排池）
                  <span className="block text-[10px] leading-snug text-slate-500">已完工但漏銷貨／沒改交期時用；不需編輯權</span>
                </button>
              </div>
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
