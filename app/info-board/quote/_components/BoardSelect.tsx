'use client'

import type { Ref } from 'react'
import type { CatalogPriceItem } from '@/lib/quote/api'
import type { ProductBoardOption } from '@/lib/quote/types'
import { boardLayout, boardShortLabel, boardThickness, fitsBoard, fmtDim, fmtSize } from '../_lib/format'
import { BTN_TEXT, LABEL_CLASS, Msg, SELECT_CLASS, SelectShell } from './ui'

export interface BoardChoice {
  /** 送給 API 的值（選項 key ?? 價格表品名）；同一主板可出現在多個貼合組合，所以不能拿 item 當識別 */
  value: string
  /** 主板價格表品名 */
  item: string
  label: string
  thickness: number | null
  /** 貼合款第二板（2貼2 → 另一張 1.8） */
  pair: { item: string; thickness: number | null } | null
  price: number | null
  layout: { w: number; h: number } | null
  /** 目前尺寸放得下嗎（null＝板材無套版資料或尚未填尺寸） */
  fits: boolean | null
}

/** 把品項的板材選項對到價格表：單片價、厚度、套版可用範圍、是否放得下 */
export function buildBoardChoices(
  options: ProductBoardOption[],
  prices: Map<string, CatalogPriceItem>,
  w: number | null,
  h: number | null,
): BoardChoice[] {
  return options.map((o) => {
    const p = prices.get(o.item) ?? null
    const layout = boardLayout(p?.attrs ?? null)
    const pairPrice = o.pairItem ? (prices.get(o.pairItem) ?? null) : null
    return {
      value: o.key ?? o.item,
      item: o.item,
      // 貼合款的短標是「2 貼 2」這種組合名，不是從品名抽出來的規格
      label: o.pairItem ? (o.label ?? boardShortLabel(o.item)) : boardShortLabel(o.item, o.label),
      thickness: boardThickness(o.item, p?.attrs ?? null),
      pair: o.pairItem ? { item: o.pairItem, thickness: boardThickness(o.pairItem, pairPrice?.attrs ?? null) } : null,
      price: p ? p.price : null,
      layout,
      fits: w !== null && h !== null ? fitsBoard(w, h, layout) : null,
    }
  })
}

/** 所有款都放得下的最小板材（依套版面積→厚度→原順序） */
export function smallestFittingBoard(choices: BoardChoice[]): BoardChoice | null {
  const ok = choices.filter((c) => c.fits === true && c.layout)
  if (!ok.length) return null
  return [...ok].sort((a, b) => {
    const aa = a.layout!.w * a.layout!.h
    const bb = b.layout!.w * b.layout!.h
    if (aa !== bb) return aa - bb
    return (a.thickness ?? 0) - (b.thickness ?? 0)
  })[0]
}

/**
 * 板材下拉（§12.6）：業務選的其實只有「厚度」——板材尺寸是拼板的事、單價是成本的事，
 * 兩者都不該出現在挑選清單上。所以 option 只顯示「2.8 mm」；只有當同一個厚度對到多張
 * 不同尺寸的板時，才補上尺寸避免兩個選項長得一模一樣。
 * 放不下的 option 後綴「（尺寸不足）」但不隱藏；手動選了不足板材 → seal 訊息＋一鍵改用。
 */
export function BoardSelect({
  choices,
  value,
  onChange,
  error,
  disabled,
  selectRef,
  className = '',
}: {
  choices: BoardChoice[]
  value: string
  onChange: (item: string) => void
  error?: string | null
  disabled?: boolean
  selectRef?: Ref<HTMLSelectElement>
  className?: string
}) {
  const current = choices.find((c) => c.value === value) ?? null
  // 同厚度有多張板才需要補尺寸區分（貼合組合不算，它們用組合名區分）
  const thickCount = new Map<string, number>()
  for (const c of choices) {
    if (c.pair) continue
    const k = c.thickness !== null ? fmtDim(c.thickness) : c.label
    thickCount.set(k, (thickCount.get(k) ?? 0) + 1)
  }
  const optionText = (c: BoardChoice) => {
    if (c.pair) {
      const t1 = c.thickness !== null ? fmtDim(c.thickness) : '?'
      const t2 = c.pair.thickness !== null ? fmtDim(c.pair.thickness) : '?'
      return `${c.label}（${t1} + ${t2} mm）${c.fits === false ? '（尺寸不足）' : ''}`
    }
    const t = c.thickness !== null ? `${fmtDim(c.thickness)} mm` : c.label
    const dup = c.thickness !== null && (thickCount.get(fmtDim(c.thickness)) ?? 0) > 1
    return `${t}${dup && c.layout ? `（${fmtSize(c.layout.w, c.layout.h)} 板）` : ''}${c.fits === false ? '（尺寸不足）' : ''}`
  }
  // 貼合款依總厚度排（2貼1 < 2貼2 < 3貼1 < 3貼2）
  const totalT = (c: BoardChoice) => (c.thickness ?? 0) + (c.pair?.thickness ?? 0)
  const sorted = [...choices].sort((a, b) => totalT(a) - totalT(b))
  const notFit = current?.fits === false

  return (
    <div className={className}>
      <label htmlFor="q-board" className={LABEL_CLASS}>
        板材厚度
      </label>
      <SelectShell>
        <select
          id="q-board"
          ref={selectRef}
          value={value}
          disabled={disabled}
          aria-invalid={!!error || notFit || undefined}
          aria-describedby={error || notFit ? 'q-board-msg' : undefined}
          onChange={(e) => onChange(e.target.value)}
          className={`${SELECT_CLASS} q-num ${error || notFit ? 'border-(--q-seal) ring-2 ring-(--q-seal)/20' : ''}`}
        >
          <option value="">請選擇厚度</option>
          {sorted.map((c) => (
            <option key={c.value} value={c.value}>
              {optionText(c)}
            </option>
          ))}
        </select>
      </SelectShell>
    </div>
  )
}

/**
 * 板材相關訊息（自動預選提示／放不下時的 seal 訊息＋一鍵改用）。
 * 跟控制項分開是因為控制項只有 132px 寬，而「改用 400 × 600 →」這種訊息放不進去。
 */
export function BoardNotice({
  choices,
  value,
  onChange,
  sizeText,
  autoPicked,
  error,
}: {
  choices: BoardChoice[]
  value: string
  onChange: (item: string) => void
  sizeText: string | null
  autoPicked: boolean
  error?: string | null
}) {
  const current = choices.find((c) => c.value === value) ?? null
  const notFit = current?.fits === false
  const alt = notFit ? smallestFittingBoard(choices) : null
  if (error) return <Msg tone="seal" id="q-board-msg">{error}</Msg>
  if (notFit && current) {
    return (
      <div id="q-board-msg" className="mt-1.5 flex flex-wrap items-baseline gap-x-3 text-[12px] leading-4 text-(--q-seal)">
        <span className="q-num">
          ※ {sizeText ?? '目前尺寸'} 超過 {current.label} 板可用範圍
          {current.layout ? `（扣邊後 ${fmtSize(current.layout.w, current.layout.h)}，旋轉後仍放不下）` : ''}，無法拼板
        </span>
        {alt && (
          <button type="button" onClick={() => onChange(alt.value)} className={`${BTN_TEXT} q-num text-(--q-accent)`}>
            改用 {alt.label} →
          </button>
        )}
      </div>
    )
  }
  if (autoPicked && sizeText && current) {
    return <p className="q-num mt-1.5 text-[12px] leading-4 text-(--q-ink-2)">已依 {sizeText} 自動選用最小可容納板材，可手動更換</p>
  }
  return null
}
