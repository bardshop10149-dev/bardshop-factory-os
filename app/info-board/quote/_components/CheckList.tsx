'use client'

import { useId, useMemo, useRef, useState } from 'react'
import { fmtInt, fmtYen } from '../_lib/format'
import { parseInteger } from '../_lib/normalize'
import { BTN_TEXT, FOCUS_RING, IconCheck } from './ui'

/**
 * 配件／包裝勾選列（§12.6）：勾選｜名稱｜單價｜每件用量。
 * 勾選框是 `<button role=checkbox>`（Space 切換）；未勾選時數量欄 opacity-40 不可操作。
 * 數量減到 0 ＝ 取消勾選。
 *
 * `showPrice=false`：不在列上顯示成本單價（配件清單用）。成本仍然照算，只是不擺在
 * 挑配件的畫面上——業務挑的是「要哪個扣環」，單價是右側成本明細的事。
 * 例外是階梯價欄位（紙卡這種單價隨數量變的），那是業務要填的輸入，不是成本展示，
 * 即使 showPrice=false 仍會出現。
 */
export interface CheckRow {
  item: string
  name: string
  on: boolean
  /** 單價（RMB）；價格表找不到時 null */
  price: number | null
  unit: string
  /** 第四欄：accessory＝每件用量 k；packing per_n_units＝每 n 件；固定項顯示「每件 1」 */
  qtyMode: 'k' | 'n' | 'fixed'
  qtyValue: number
  /** qtyMode=fixed 時顯示的文字（「每件 1」「每箱 2」） */
  fixedText?: string
  /** 階梯價：讓業務改單價 */
  tierPrice?: boolean
  priceOverride?: number | null
  /** 列下方補充（例如「約 250 箱（50,000 ÷ 200，無條件進位）」） */
  note?: string | null
}

function QtyCell({
  row,
  onQty,
  disabled,
}: {
  row: CheckRow
  onQty: (n: number) => void
  disabled: boolean
}) {
  const id = useId()
  const [text, setText] = useState<string | null>(null)
  const composing = useRef(false)
  // mode 'n' 是「每 n 件用 1 個」，不一定是箱（OPP 中袋也是這個模式），所以只寫「每 … 件」
  const prefix = row.qtyMode === 'k' ? '每件' : '每'
  const suffix = row.qtyMode === 'k' ? '個' : '件'

  if (row.qtyMode === 'fixed') {
    return <span className="q-num block text-right text-[12px] leading-4 text-(--q-ink-3)">{row.fixedText ?? `每件 ${fmtInt(row.qtyValue)}`}</span>
  }
  const commit = (raw: string) => {
    if (composing.current) return
    const n = parseInteger(raw)
    setText(null)
    if (n === null) return
    onQty(Math.max(0, n))
  }
  return (
    <label htmlFor={id} className="q-num flex h-8 items-stretch justify-end text-[12px] leading-4 text-(--q-ink-3)">
      <span className="flex items-center pr-1.5">{prefix}</span>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={`${row.name} ${prefix}用量`}
        disabled={disabled}
        value={text ?? fmtInt(row.qtyValue)}
        onChange={(e) => setText(e.target.value)}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={(e) => {
          composing.current = false
          commit(e.currentTarget.value)
        }}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault()
            commit(e.currentTarget.value)
          }
        }}
        className={`w-[44px] rounded-(--q-radius) border border-(--q-line) bg-(--q-card) px-1.5 text-right text-[13px] leading-5 text-(--q-ink) outline-none transition-[border-color] duration-(--q-dur-fast) hover:border-(--q-ink-2) focus:border-(--q-ink) focus:ring-2 focus:ring-(--q-accent)/25 disabled:cursor-not-allowed`}
      />
      <span className="flex items-center pl-1.5">{suffix}</span>
    </label>
  )
}

function PriceCell({ row, onPrice }: { row: CheckRow; onPrice?: (p: number | null) => void }) {
  const id = useId()
  const [text, setText] = useState<string | null>(null)
  const shown = row.priceOverride ?? row.price
  if (!row.tierPrice || !onPrice) {
    return (
      <span className="q-num text-[12px] leading-4 text-(--q-ink-3)">
        {shown !== null ? `${fmtYen(shown, shown < 0.1 ? 4 : 2)}／${row.unit}` : '單價待補'}
      </span>
    )
  }
  const commit = (raw: string) => {
    setText(null)
    const t = raw.replace(/[¥,\s]/g, '')
    if (t === '') {
      onPrice(null)
      return
    }
    const n = Number(t)
    if (Number.isFinite(n) && n >= 0) onPrice(n)
  }
  return (
    <label htmlFor={id} className="q-num flex items-center gap-1 text-[12px] leading-4 text-(--q-ink-3)">
      <span>¥</span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        aria-label={`${row.name} 單價（階梯價可改）`}
        disabled={!row.on}
        value={text ?? (shown !== null ? String(shown) : '')}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            commit(e.currentTarget.value)
          }
        }}
        className="w-[56px] rounded-(--q-radius) border border-(--q-line) bg-(--q-card) px-1.5 text-right text-[12px] leading-4 text-(--q-ink) outline-none hover:border-(--q-ink-2) focus:border-(--q-ink) focus:ring-2 focus:ring-(--q-accent)/25 disabled:cursor-not-allowed"
      />
      <span>／{row.unit} · 階梯價</span>
    </label>
  )
}

export function CheckList({
  rows,
  onToggle,
  onQty,
  onPrice,
  disabled,
  emptyText,
  showPrice = true,
  collapseAfter,
  searchable = false,
}: {
  rows: CheckRow[]
  onToggle: (item: string, on: boolean) => void
  onQty: (item: string, n: number) => void
  onPrice?: (item: string, p: number | null) => void
  disabled?: boolean
  emptyText: string
  /** false＝不顯示成本單價（階梯價輸入不受影響） */
  showPrice?: boolean
  /** 超過這個數量就只先列前 N 項（已勾選的一定會列出），其餘收起來 */
  collapseAfter?: number
  /** 顯示搜尋框 */
  searchable?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const searchId = useId()
  const q = query.trim().toLowerCase()

  const filtered = useMemo(
    () => (q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.item.toLowerCase().includes(q)) : rows),
    [rows, q],
  )
  // 收合時：已勾選的一律留著（否則勾了又收起來會像「被取消了」），其餘只留前 N 項
  const collapsed = !!collapseAfter && !q && !expanded && filtered.length > collapseAfter
  const shown = collapsed ? filtered.filter((r, i) => r.on || i < collapseAfter) : filtered
  const hiddenCount = filtered.length - shown.length

  const anyPriceCell = rows.some((r) => showPrice || r.tierPrice)
  const gridCols = anyPriceCell
    ? 'grid-cols-[20px_1fr_auto_104px] max-md:grid-cols-[20px_1fr_88px]'
    : 'grid-cols-[20px_1fr_104px] max-md:grid-cols-[20px_1fr_88px]'
  if (!rows.length) {
    return <p className="border-y border-(--q-line) py-3 text-[13px] leading-5 text-(--q-ink-3)">※ {emptyText}</p>
  }
  return (
    <>
      {(searchable || collapseAfter) && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {searchable ? (
            <input
              id={searchId}
              type="search"
              value={query}
              disabled={disabled}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋配件（扣、珠鍊、登山…）"
              aria-label="搜尋配件"
              className={`h-8 w-[240px] max-w-full rounded-(--q-radius) border border-(--q-line) bg-(--q-card) px-3 text-[13px] leading-5 text-(--q-ink) outline-none transition-[border-color] duration-(--q-dur-fast) placeholder:text-(--q-ink-3) hover:border-(--q-ink-2) focus:border-(--q-ink) focus:ring-2 focus:ring-(--q-accent)/25 ${FOCUS_RING}`}
            />
          ) : (
            <span />
          )}
          {collapseAfter && !q && (
            <button type="button" onClick={() => setExpanded((v) => !v)} className={`${BTN_TEXT} text-[12px]`}>
              {expanded ? '只顯示常用' : `顯示全部 ${rows.length} 項`}
            </button>
          )}
        </div>
      )}
      {!shown.length && (
        <p className="border-y border-(--q-line) py-3 text-[13px] leading-5 text-(--q-ink-3)">※ 找不到符合「{query.trim()}」的配件</p>
      )}
      <div className="divide-y divide-(--q-line) border-y border-(--q-line)">
      {shown.map((row) => {
        const labelId = `q-chk-${row.item.replace(/[^\w]/g, '_')}`
        return (
          <div key={row.item} className={`transition-colors duration-(--q-dur-fast) hover:bg-(--q-paper-2) ${disabled ? 'opacity-60' : ''}`}>
            <div className={`grid items-center gap-3 py-2 ${gridCols}`}>
              <button
                type="button"
                role="checkbox"
                aria-checked={row.on}
                aria-labelledby={labelId}
                disabled={disabled}
                onClick={() => onToggle(row.item, !row.on)}
                className={`flex size-4 items-center justify-center rounded-[2px] border border-(--q-ink) transition-colors duration-(--q-dur-fast) ${FOCUS_RING} ${
                  row.on ? 'bg-(--q-ink) text-(--q-paper)' : 'bg-(--q-card) text-transparent'
                }`}
              >
                <IconCheck />
              </button>
              <button
                type="button"
                id={labelId}
                tabIndex={-1}
                disabled={disabled}
                onClick={() => onToggle(row.item, !row.on)}
                className={`cursor-pointer truncate text-left text-[14px] leading-[22px] ${row.on ? 'text-(--q-ink)' : 'text-(--q-ink-2)'}`}
                title={row.name}
              >
                {row.name}
              </button>
              {anyPriceCell && (
                <div className="max-md:hidden">
                  {showPrice || row.tierPrice ? (
                    <PriceCell row={row} onPrice={onPrice ? (p) => onPrice(row.item, p) : undefined} />
                  ) : null}
                </div>
              )}
              <div className={row.on ? '' : 'pointer-events-none opacity-40'}>
                <QtyCell
                  row={row}
                  disabled={!!disabled || !row.on}
                  onQty={(n) => {
                    if (n <= 0) onToggle(row.item, false)
                    else onQty(row.item, n)
                  }}
                />
              </div>
            </div>
            {row.on && row.note && (
              <p className="q-num pb-2 pl-8 text-[11px] leading-4 text-(--q-ink-3)">{row.note}</p>
            )}
          </div>
        )
      })}
      </div>
      {collapsed && hiddenCount > 0 && (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-3 text-[12px] leading-4 text-(--q-ink-3)">
          <span>常用 {shown.length} 項顯示中，另有 {hiddenCount} 項較少用的配件已收起</span>
          <button type="button" onClick={() => setExpanded(true)} className={`${BTN_TEXT} text-(--q-accent)`}>
            展開全部 {rows.length} 項 ↓
          </button>
        </p>
      )}
      {expanded && collapseAfter && !q && filtered.length > collapseAfter && (
        <p className="mt-2 text-[12px] leading-4 text-(--q-ink-3)">
          <button type="button" onClick={() => setExpanded(false)} className={`${BTN_TEXT} text-(--q-accent)`}>
            只顯示常用 ↑
          </button>
        </p>
      )}
    </>
  )
}
