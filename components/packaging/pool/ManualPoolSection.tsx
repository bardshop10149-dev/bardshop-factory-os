'use client'

// D102 待排池頁的「手動加入」區塊（'mn'）：待排池頁是可排卡片的唯一控制台，手動卡的改數量／移出都在這裡。
//
// 為什麼不交給 PoolBlock：PoolBlock 內部直接 map 出 PackagingCard、沒有插槽，PackagingCard 也沒有 data-* 屬性，
// 兩個檔都禁改 → 這裡另寫一個區塊元件，直接「組合」原封不動的 PackagingCard：
//   卡片上方＝手動色條（「手動・誰・何時」＋途程＋原因＋已排／已完成／可排）
//   卡片本身＝PackagingCard 原樣（它的狀態徽章會顯示 statusLabel「手動加入」，也是一個手動標記）
//   卡片下方＝「改數量…」「移出待排池」按鈕（只給主管）
// 不用右鍵選單：這一頁常在平板／手機看，觸控裝置叫不出右鍵，也不容易被發現；明確的按鈕最直覺。
// 視覺語言照抄 PoolBlock（同一套 TONE_STYLES，'mn'＝琥珀色），標題列數字一律用伺服器算好的整區合計。
//
// 已全數完成的手動紀錄（伺服器拆到 manual.ended）另列「可移出清理」清單：不出卡、不計張數與工時，
// 但紀錄還在——確定不再需要就在這裡移出（lines.md §6.3「紀錄的終點」，以前只能從查詢對話框移出）。

import { useState } from 'react'
import { POOL_BLOCK_META, type PackagingCard as PackagingCardData, type PoolBlock as PoolBlockData } from '@/lib/packaging/types'
import { MANUAL_BLOCK_ID } from '@/lib/packaging/scheduleTypes'
import type { PoolManualLine, PoolManualSection } from '@/lib/packaging/manualPool'
import PackagingCard from '@/components/packaging/PackagingCard'
import { BLOCK_TONE, TONE_STYLES, fmtHours, fmtQty } from '@/components/packaging/poolStyles'
import { manualTag } from '@/components/packaging/board/CardDetailDialog'

/** 一次先畫這麼多張（同 PoolBlock）；手動紀錄上限 300，一口氣全畫手機會卡 */
const PAGE = 40

export default function ManualPoolSection({
  block, cards, filtered, collapsed, onToggle, manual, today, canEdit, changpingSyncLabel, onOpenOrder, onAdd, onEdit, onRemove,
}: {
  /** 'mn' 區塊（伺服器已把已全數完成的拆到 manual.ended）；undefined＝手動加入暫不可用 */
  block: PoolBlockData | undefined
  /** 經頁面關鍵字／焦點篩選、排序後要顯示的卡（同其他區塊，來自頁面的 viewCards.get('mn')） */
  cards: PackagingCardData[]
  filtered: boolean
  collapsed: boolean
  onToggle: () => void
  manual: PoolManualSection
  today: string
  /** 主管（is_admin 或 packaging_admin）：可加入、改數量、移出；否則只能查詢 */
  canEdit: boolean
  changpingSyncLabel?: string
  onOpenOrder: (so: string) => void
  /** 空區塊提示裡的「＋加入訂單／查詢訂單」 */
  onAdd: () => void
  onEdit: (card: PackagingCardData, line: PoolManualLine) => void
  onRemove: (card: PackagingCardData, line: PoolManualLine) => void
}) {
  const [limit, setLimit] = useState(PAGE)
  const tone = TONE_STYLES[BLOCK_TONE[MANUAL_BLOCK_ID]]
  const meta = POOL_BLOCK_META[MANUAL_BLOCK_ID]
  const unavailable = !manual.available || !block
  const cardCount = block?.cardCount ?? 0
  const empty = cardCount === 0
  const shown = cards.slice(0, limit)
  const { soGone, backInPool, soldOut } = manual.skipped
  const skippedParts = [
    backInPool > 0 ? `${backInPool} 行已回到自動待排池` : null,
    soGone > 0 ? `${soGone} 行 ERP 已查無（多半已結案）` : null,
    soldOut > 0 ? `${soldOut} 行已全數銷貨` : null,
  ].filter(Boolean)

  return (
    <section
      id={`pool-block-${MANUAL_BLOCK_ID}`}
      className={`scroll-mt-4 min-w-0 overflow-hidden rounded-xl border ${tone.border} bg-slate-950/40`}
    >
      {/* ── 標題列（點擊折疊；沒卡時也要看得到空區塊說明，所以不像 PoolBlock 那樣停用） ── */}
      <div className={`relative ${tone.headerBg}`}>
        <span className={`absolute inset-y-0 left-0 w-1 ${tone.bar}`} aria-hidden />
        <button
          type="button"
          onClick={onToggle}
          disabled={empty || unavailable}
          aria-expanded={!collapsed}
          className="w-full pl-3.5 pr-3 py-2 text-left disabled:cursor-default"
        >
          <div className="flex items-start gap-2">
            <span className={`mt-0.5 shrink-0 rounded bg-slate-950/60 px-1.5 font-mono text-[11px] font-bold ${tone.title}`}>{MANUAL_BLOCK_ID}</span>
            <div className="min-w-0 flex-1">
              <h3 className={`text-sm font-bold leading-tight ${tone.title}`}>{meta.title}</h3>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-400">
                {meta.hint}。所有可排的卡都在這一頁控制：加入、改數量、移出都在這裡做（D102）。
              </p>
            </div>
            {!empty && !unavailable && (
              <span className="shrink-0 pt-0.5 text-[11px] text-slate-400">{collapsed ? '展開 ▾' : '收合 ▴'}</span>
            )}
          </div>
          {!unavailable && block && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 pl-0.5 text-[11px]">
              <span className="text-slate-200">
                <b className="text-base leading-none">{cardCount}</b> 張
                {!empty && (filtered || cards.length !== cardCount) && (
                  <span className="ml-1 text-sky-300">（顯示 {cards.length}／共 {cardCount}）</span>
                )}
              </span>
              <span className="text-amber-200" title="已知工時合計（1 人，分鐘換算小時）">
                工時 <b className="text-sm leading-none">{fmtHours(block.totalMinutes)}</b> 小時
              </span>
              {block.unknownMinutesCards > 0 && <span className="text-orange-300">工時未知 {block.unknownMinutesCards}</span>}
              {block.overdueCount > 0 && <span className="font-semibold text-red-300">逾期 {block.overdueCount}</span>}
              {block.sampleCount > 0 && <span className="text-fuchsia-300">打樣類 {block.sampleCount}</span>}
            </div>
          )}
        </button>
        {!canEdit && !unavailable && (
          <p className="border-t border-slate-800/60 pl-3.5 pr-3 py-1 text-[11px] text-slate-500">
            唯讀：可按上方「查詢訂單」看某張單為什麼不在待排池；加入、改數量、移出需要包裝主管權限。
          </p>
        )}
      </div>

      {unavailable ? (
        <div className="m-2 rounded border border-orange-700/60 bg-orange-950/30 px-3 py-2 text-xs text-orange-200">
          手動加入暫時無法使用：{manual.error ?? '伺服器沒有回傳手動加入資料'}。待排池其他區塊不受影響。
        </div>
      ) : (
        <>
          {empty && (
            <div className="flex flex-wrap items-center gap-2 px-3 py-3 text-xs text-slate-400">
              <span>
                {canEdit
                  ? '目前沒有手動加入的品項。不在待排池的訂單品項，可以按「＋加入訂單」加進來排程。'
                  : '目前沒有手動加入的品項。想知道某張單為什麼不在待排池，可以按「查詢訂單」。'}
              </span>
              <button type="button" onClick={onAdd}
                className="rounded border border-amber-600/60 bg-amber-900/30 px-2 py-0.5 text-[11px] font-semibold text-amber-100 hover:bg-amber-800/50">
                {canEdit ? '＋加入訂單' : '查詢訂單'}
              </button>
            </div>
          )}

          {!collapsed && !empty && (
            <div className="p-2">
              {cards.length === 0 ? (
                <p className="px-1 py-3 text-center text-xs text-slate-400">沒有符合篩選條件的卡片</p>
              ) : (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {shown.map(c => (
                    <ManualCard
                      key={c.cardId}
                      card={c}
                      line={manual.lines[c.soLineKey]}
                      today={today}
                      canEdit={canEdit}
                      changpingSyncLabel={changpingSyncLabel}
                      onOpenOrder={onOpenOrder}
                      onEdit={onEdit}
                      onRemove={onRemove}
                    />
                  ))}
                </div>
              )}
              {cards.length > shown.length && (
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  <button type="button" onClick={() => setLimit(l => l + PAGE)}
                    className="rounded border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-300 hover:text-white">
                    再顯示 {Math.min(PAGE, cards.length - shown.length)} 張
                  </button>
                  <button type="button" onClick={() => setLimit(cards.length)}
                    className="rounded border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-400 hover:text-white">
                    全部顯示（剩 {cards.length - shown.length}）
                  </button>
                </div>
              )}
            </div>
          )}

          {manual.ended.length > 0 && (
            <EndedList manual={manual} canEdit={canEdit} onOpenOrder={onOpenOrder} onRemove={onRemove} />
          )}

          {skippedParts.length > 0 && (
            <p className="px-3 pb-2 text-[11px] leading-snug text-slate-500">
              另有 {skippedParts.join('、')}：這些手動加入紀錄保留、但不出卡（同工作台頁尾的說法）。
            </p>
          )}
        </>
      )}
    </section>
  )
}

/** 一張手動卡＝手動色條＋PackagingCard 原樣＋（主管）動作列 */
function ManualCard({ card, line, today, canEdit, changpingSyncLabel, onOpenOrder, onEdit, onRemove }: {
  card: PackagingCardData
  line: PoolManualLine | undefined
  today: string
  canEdit: boolean
  changpingSyncLabel?: string
  onOpenOrder: (so: string) => void
  onEdit: (card: PackagingCardData, line: PoolManualLine) => void
  onRemove: (card: PackagingCardData, line: PoolManualLine) => void
}) {
  const m = line?.meta
  const showProgress = !!line && (line.placedQty > 0 || line.completedQty > 0)
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-amber-700/40 bg-amber-950/10 p-1">
      {m && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded bg-amber-900/30 px-2 py-1 text-[11px] text-amber-100">
          <span className="font-semibold">{manualTag(m)}</span>
          {/* D103：手動加入的數量＝這筆訂單的總量（含已完成），不是剩餘量 */}
          <span className="text-amber-200/80" title="總量＝這筆訂單要包的全部數量（含已完成）">{m.routeType}・總量 {fmtQty(m.qty)}</span>
          {m.reason && <span className="min-w-0 break-words text-amber-200/70">原因：{m.reason}</span>}
          {showProgress && line && (
            <span className="ml-auto text-slate-300"
              title="已排＝還沒完成的排定卡合計；可排＝還能從待排池拿去排的量（同排程工作台）；沒有出貨時 總量＝已完成＋已排＋可排">
              {line.placedQty > 0 && <>已排 {fmtQty(line.placedQty)}・</>}
              {line.completedQty > 0 && <>已完成 {fmtQty(line.completedQty)}・</>}
              可排 <b className="text-white">{fmtQty(line.remainingQty)}</b>
            </span>
          )}
        </div>
      )}
      <PackagingCard card={card} today={today} onOpenOrder={onOpenOrder} changpingSyncLabel={changpingSyncLabel} />
      {canEdit && line && (
        <div className="flex flex-wrap gap-1.5 px-1 pb-0.5">
          <button type="button" onClick={() => onEdit(card, line)}
            aria-label={`改 ${card.soLineKey} 的手動加入數量`}
            className="rounded border border-amber-600/60 bg-amber-900/30 px-2 py-0.5 text-[11px] text-amber-100 hover:bg-amber-800/50">
            改數量…
          </button>
          <button type="button" onClick={() => onRemove(card, line)}
            aria-label={`把 ${card.soLineKey} 移出待排池`}
            className="rounded border border-rose-700/60 bg-rose-950/40 px-2 py-0.5 text-[11px] text-rose-200 hover:bg-rose-900/50">
            移出待排池
          </button>
        </div>
      )}
    </div>
  )
}

/** 已全數完成的手動紀錄：不出卡、不計張數與工時，可移出清理（預設收合） */
function EndedList({ manual, canEdit, onOpenOrder, onRemove }: {
  manual: PoolManualSection
  canEdit: boolean
  onOpenOrder: (so: string) => void
  onRemove: (card: PackagingCardData, line: PoolManualLine) => void
}) {
  return (
    <details className="group mx-2 mb-2 rounded border border-slate-800 bg-slate-950/40 text-[11px] text-slate-400">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-2 py-1.5 [&::-webkit-details-marker]:hidden">
        <span className="transition-transform group-open:rotate-90">▶</span>
        <span className="font-semibold text-slate-300">已全數完成的手動加入（{manual.ended.length} 行）</span>
        <span>已不出卡、不算張數與工時；確定不再需要可移出（紀錄保留）</span>
      </summary>
      <ul className="divide-y divide-slate-800/70 border-t border-slate-800">
        {manual.ended.map(({ card, line }) => (
          <li key={card.cardId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5">
            <button type="button" onClick={() => onOpenOrder(card.so)} title="開啟訂單詳情"
              className="font-mono text-sky-300 hover:underline">{card.soLineKey}</button>
            <span className="min-w-0 flex-1 break-words text-slate-300">{card.itemName ?? '（無品名）'}</span>
            <span className="whitespace-nowrap">總量 {fmtQty(line.meta.qty)}・已完成 {fmtQty(line.completedQty)}</span>
            {canEdit && (
              <button type="button" onClick={() => onRemove(card, line)}
                aria-label={`把已完成的 ${card.soLineKey} 移出`}
                className="rounded border border-rose-700/60 px-1.5 py-0.5 text-rose-200 hover:bg-rose-950/60">移出</button>
            )}
          </li>
        ))}
      </ul>
    </details>
  )
}
