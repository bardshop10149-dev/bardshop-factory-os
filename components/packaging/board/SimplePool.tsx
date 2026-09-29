'use client'

// D58 待排池（簡化卡片版，取代 D57 的表格／卡片切換）。
// 依區塊分組：標題列可收合（收合狀態由 PoolSidebar 管、存 localStorage），顯示張數與工時合計；
// 區塊內是 SimplePoolCard 網格——左欄窄時一欄，使用者把分隔線（D59）拉寬後自動變兩欄以上。
// 卡片上沒放的資訊（工時與來源、品項編碼、備註、狀態、完整 PACKING、預估可包日、全部旗標）：
//   - 滑鼠停留或鍵盤聚焦卡片 → 提示 PoolHoverTip（快速瞄一眼）
//   - 點卡片本身（或聚焦後按 Enter）→ 卡片詳情 CardDetailDialog（D61；與右側排定卡共用；觸控裝置也拿得到）
//   - 點單號 → 訂單詳情（全部品項＋示意圖，BoardLayout 的 PackagingOrderModal）
// D66：「手動加入」區塊（'mn'）的卡在卡片上方加「手動・誰・何時」標記（showManualTag；資料來自 cardMeta[*].manual）。
// D111：「已入庫」區塊（2 常平已入庫、5b 委外已入庫）展開後多一列排序切換「預設／依入庫日（舊→新）」；
//   選擇由 PoolSidebar 管（存 localStorage、排序也在那裡做），這裡只畫按鈕。滑過提示多一行入庫批次（CardInfo）。

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { PoolCardMeta } from '@/lib/packaging/scheduleTypes'
import type { PackagingCard, PoolBlock as PoolBlockData, PoolBlockId } from '@/lib/packaging/types'
import { BLOCK_TONE, TONE_STYLES, fmtHours } from '@/components/packaging/poolStyles'
import { RECEIVED_BLOCKS } from '@/lib/packaging/receipts'
import { isPlaceableBlock } from './boardLocal'
import SimplePoolCard from './SimplePoolCard'
import CardDetailDialog, { CardInfo } from './CardDetailDialog'

/** 一段先畫這麼多張，其餘按「顯示更多」 */
const PAGE = 60

function Section({ block, cards, cardMeta, showManualTag, filtered, collapsed, onToggle, today, canDrag, descId, onOpenOrder, onOpenDetail, onHover, receiptSorted, onReceiptSort }: {
  block: PoolBlockData
  /** D111：這一區目前是否「依入庫日（舊→新）」排序；onReceiptSort 沒傳＝不顯示排序切換 */
  receiptSorted: boolean
  onReceiptSort?: (on: boolean) => void
  cardMeta: Record<string, PoolCardMeta>
  showManualTag: boolean
  cards: PackagingCard[]
  filtered: boolean
  collapsed: boolean
  onToggle: () => void
  today: string
  canDrag: boolean
  descId: string
  onOpenOrder: (so: string) => void
  onOpenDetail: (card: PackagingCard) => void
  onHover: (card: PackagingCard | null, el: HTMLElement | null) => void
}) {
  const [limit, setLimit] = useState(PAGE)
  const tone = TONE_STYLES[BLOCK_TONE[block.id]]
  const placeable = isPlaceableBlock(block.id)
  // 搜尋中：張數與工時都只算符合的卡（全區數字放到 title，避免把全區工時誤認成符合卡的工時）
  const matchMinutes = filtered ? cards.reduce((a, c) => a + (c.work.minutes ?? 0), 0) : 0
  return (
    <section className={`overflow-hidden rounded-lg border ${tone.border}`} data-pool-block={block.id}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={`flex w-full items-center gap-2 px-2 py-1.5 text-left ${tone.headerBg} hover:brightness-125`}
      >
        <span className={`h-3 w-1 rounded ${tone.bar}`} aria-hidden />
        <span className={`min-w-0 flex-1 truncate text-xs font-bold ${tone.title}`} title={block.hint}>{block.title}</span>
        {filtered ? (
          <span
            className="shrink-0 text-[11px] tabular-nums text-slate-300"
            title={`全區 ${block.cardCount} 張・${fmtHours(block.totalMinutes)}h`}
          >
            符合 {cards.length} 張・{fmtHours(matchMinutes)}h<span className="text-slate-400">（全區 {block.cardCount}）</span>
          </span>
        ) : (
          <span className="shrink-0 text-[11px] tabular-nums text-slate-300">{block.cardCount} 張・{fmtHours(block.totalMinutes)}h</span>
        )}
        {block.overdueCount > 0 && <span className="shrink-0 rounded bg-red-600/80 px-1 text-[10px] font-bold text-white">逾期 {block.overdueCount}</span>}
        <span className="shrink-0 text-[10px] text-slate-400">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div className="border-t border-slate-800 p-1.5">
          {!placeable && (
            <div className="mb-1.5 rounded border border-rose-800/60 bg-rose-950/30 px-2 py-1 text-[11px] text-rose-200">
              這一區不能排到日期（{block.id === '3' ? 'D22：未寄出不預排，僅提醒' : '出貨與否不明，比照未寄出'}）
            </div>
          )}
          {onReceiptSort && cards.length > 1 && (
            <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[11px] text-slate-400" role="group" aria-label={`${block.title} 排序`}>
              <span>排序</span>
              {([[false, '預設', '逾期 → 打樣 → 剩餘工作天'], [true, '依入庫日（舊→新）', '最早一批入庫日越早的排越前面（放最久的先包）；沒有入庫日的排最後']] as const).map(([on, text, tip]) => (
                <button
                  key={text}
                  type="button"
                  aria-pressed={receiptSorted === on}
                  title={tip}
                  onClick={() => onReceiptSort(on)}
                  className={`rounded border px-1.5 py-0.5 ${receiptSorted === on
                    ? 'border-sky-600 bg-sky-950/60 text-sky-200'
                    : 'border-slate-700 text-slate-400 hover:text-white'}`}
                >{text}</button>
              ))}
            </div>
          )}
          {cards.length === 0 ? (
            <p className="py-1.5 text-center text-[11px] text-slate-500">{filtered ? '沒有符合的卡' : '沒有卡片'}</p>
          ) : (
            // min(260px,100%)：左欄被拉到最窄（280px，扣掉捲軸與內距後可能不到 260）時，一欄就縮成可用寬度，不裁切卡片
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(260px,100%),1fr))] gap-1.5">
              {cards.slice(0, limit).map(c => (
                <SimplePoolCard
                  key={c.cardId}
                  card={c}
                  manual={showManualTag ? (cardMeta[c.cardId]?.manual ?? null) : null}
                  today={today}
                  canDrag={canDrag}
                  descId={descId}
                  onOpenOrder={onOpenOrder}
                  onOpenDetail={onOpenDetail}
                  onHover={onHover}
                />
              ))}
            </div>
          )}
          {cards.length > limit && (
            <button
              type="button"
              onClick={() => setLimit(l => l + PAGE)}
              className="mt-1.5 w-full rounded border border-slate-800 py-1 text-[11px] text-slate-400 hover:bg-slate-800 hover:text-white"
            >顯示更多（還有 {cards.length - limit} 張）</button>
          )}
        </div>
      )}
    </section>
  )
}

/** 滑過（或鍵盤聚焦）卡片的提示 */
function PoolHoverTip({ card, meta, rect, today }: { card: PackagingCard; meta: PoolCardMeta | undefined; rect: DOMRect; today: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const w = 320
  // 預設放在卡片右邊；右邊放不下（左欄被拉很寬）就放左邊
  const left = rect.right + 8 + w <= window.innerWidth ? rect.right + 8 : Math.max(8, rect.left - w - 8)
  // 垂直位置：畫出來後量實際高度再夾進視窗（內容長短不一，不能用固定值估）。
  // 直接改 DOM 的 style.top、不走 state：只影響這一個浮層，也避免多一輪重畫。
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const h = el.offsetHeight
    el.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - h - 8))}px`
  }, [rect])
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-[55] max-h-[calc(100vh-16px)] space-y-0.5 overflow-hidden rounded-lg border border-slate-600 bg-slate-900/95 px-3 py-2 text-[11px] leading-snug text-slate-200 shadow-2xl"
      style={{ left, top: rect.top, width: w }}
    >
      <div className="flex items-baseline font-mono text-sky-300">
        {card.so}{card.soLine ? `-${card.soLine}` : ''}
        <span className="flex-1" />
        <span className="font-sans text-[10px] text-slate-400">點卡片看詳情</span>
      </div>
      <CardInfo card={card} meta={meta} today={today} />
    </div>,
    document.body,
  )
}

export default function SimplePool({ blocks, viewCards, cardMeta, filtered, collapsed, onToggle, today, canDrag, dragging, onOpenOrder, showManualTag = false, receiptSorted, onReceiptSort }: {
  blocks: PoolBlockData[]
  /** D111：哪些「已入庫」區塊目前依入庫日排序（排序本身由 PoolSidebar 做好放在 viewCards） */
  receiptSorted?: ReadonlySet<PoolBlockId>
  /** D111：切換某一區的排序；不傳＝不顯示排序切換 */
  onReceiptSort?: (id: PoolBlockId, on: boolean) => void
  viewCards: Map<PoolBlockId, PackagingCard[]>
  cardMeta: Record<string, PoolCardMeta>
  filtered: boolean
  collapsed: Set<PoolBlockId>
  onToggle: (id: PoolBlockId) => void
  today: string
  canDrag: boolean
  /** 拖曳中不顯示滑過提示 */
  dragging: boolean
  onOpenOrder: (so: string) => void
  /** D66：手動卡顯示「手動・誰・何時」標記（D102 起由 PoolSidebar 的 showManualTag 決定：工作台傳 true、AI 模擬區不傳） */
  showManualTag?: boolean
}) {
  const [hover, setHover] = useState<{ card: PackagingCard; rect: DOMRect } | null>(null)
  const [detail, setDetail] = useState<PackagingCard | null>(null)
  const descId = useId()
  const timer = useRef<number | null>(null)
  // 拖曳中（包含從右側拖排定列經過待排池）不記滑過的卡：否則放開後提示會出現在舊位置
  const draggingRef = useRef(dragging)
  useEffect(() => { draggingRef.current = dragging }, [dragging])
  // 拖曳一開始就清掉目前的提示（React 建議的「依 prop 變化調整 state」寫法：在 render 中比對前值，不用 effect）
  const [prevDragging, setPrevDragging] = useState(dragging)
  if (prevDragging !== dragging) {
    setPrevDragging(dragging)
    if (dragging) setHover(null)
  }
  const clearTimer = useCallback(() => {
    if (timer.current != null) { window.clearTimeout(timer.current); timer.current = null }
  }, [])
  // 卸載時清掉還沒觸發的計時器
  useEffect(() => clearTimer, [clearTimer])
  // 任何捲動（左欄、右側、整頁；scroll 不冒泡，所以用捕獲階段）→ 收起提示：rect 是舊的，留著會停在錯的位置
  useEffect(() => {
    const onScroll = () => { clearTimer(); setHover(null) }
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [clearTimer])
  const onHover = useCallback((card: PackagingCard | null, el: HTMLElement | null) => {
    clearTimer()
    if (!card || !el || draggingRef.current) { setHover(null); return }
    // 稍等一下才出現：滑鼠只是經過時不要一路閃
    timer.current = window.setTimeout(() => {
      timer.current = null
      if (!draggingRef.current) setHover({ card, rect: el.getBoundingClientRect() })
    }, 300)
  }, [clearTimer])
  const onOpenDetail = useCallback((card: PackagingCard) => {
    clearTimer()
    setHover(null)
    setDetail(card)
  }, [clearTimer])
  return (
    <div className="space-y-2" onPointerDown={() => onHover(null, null)}>
      <p id={descId} hidden>按 Enter 開啟卡片詳情；Shift+F10 開啟操作選單（排部分數量、直接勾完成、放到待排區）。拖曳排定請用滑鼠。</p>
      {blocks.map(b => (
        <Section
          key={b.id}
          block={b}
          cards={viewCards.get(b.id) ?? []}
          cardMeta={cardMeta}
          showManualTag={showManualTag}
          filtered={filtered}
          collapsed={collapsed.has(b.id)}
          onToggle={() => onToggle(b.id)}
          today={today}
          canDrag={canDrag}
          descId={descId}
          onOpenOrder={onOpenOrder}
          onOpenDetail={onOpenDetail}
          onHover={onHover}
          receiptSorted={receiptSorted?.has(b.id) ?? false}
          onReceiptSort={onReceiptSort && RECEIVED_BLOCKS.includes(b.id) ? (on => onReceiptSort(b.id, on)) : undefined}
        />
      ))}
      {hover && !dragging && !detail && <PoolHoverTip card={hover.card} meta={cardMeta[hover.card.cardId]} rect={hover.rect} today={today} />}
      {detail && (
        <CardDetailDialog
          card={detail}
          meta={cardMeta[detail.cardId]}
          today={today}
          onClose={() => setDetail(null)}
          onOpenOrder={onOpenOrder}
        />
      )}
    </div>
  )
}
