'use client'

import type { ReactNode, RefObject } from 'react'
import { normalizeDimText, normalizeQtyText, parseSizePair } from '../_lib/normalize'
import type { SizeState } from '../_lib/model'
import { NumberInput } from './NumberInput'
import { LABEL_CLASS, Msg } from './ui'

/**
 * 款列（§12.6）：兩列的格子——
 *   第一列  板材厚度｜毛利率
 *   第二列  尺寸 W × H｜數量
 * 之前是一列 flex-wrap，寬度不夠時欄位會擠在一起或換行換得很難看；
 * 改成固定兩列後每格寬度都留得夠，選項文字（「2 貼 2（1.8 + 1.8 mm）」）不會被切掉。
 * 所有訊息（錯誤、無法拼板、毛利率覆寫提示）都放在格子下方整列顯示，不擠進欄位裡。
 */

// 寬度取捨：扣掉單位格與左右內距後，輸入區要放得下「100.5」這種 5 碼（15px 等寬 ≈ 45px）。
// 92px 會把「10.2」裁成「10.」——比太寬更糟。
const DIM_W = 'w-[108px]'
const QTY_W = 'w-[140px]'

export function SizeRow({
  size,
  onChange,
  errors,
  warnings,
  refs,
  onQtyEnter,
  sizeMessage,
  board,
  afterBoard,
  boardNotice,
}: {
  size: SizeState
  /** 款序號（預留給多款；目前單款不顯示） */
  index?: number
  onChange: (patch: Partial<SizeState>) => void
  errors: { w?: string | null; h?: string | null; qty?: string | null }
  warnings?: { qty?: string | null }
  /** 尺寸下方的訊息（無法拼板 seal／接近極限 warn），不把輸入框標成 invalid */
  sizeMessage?: { tone: 'seal' | 'warn'; text: string } | null
  refs: { w: RefObject<HTMLInputElement | null>; h: RefObject<HTMLInputElement | null>; qty: RefObject<HTMLInputElement | null> }
  onQtyEnter?: () => void
  /** 板材厚度控制項（窄欄，排在尺寸前面） */
  board?: ReactNode
  /** 排在板材右邊的額外控制項（工程模式的毛利率） */
  afterBoard?: ReactNode
  /** 板材相關訊息，整列寬 */
  boardNotice?: ReactNode
}) {
  const sizeError = errors.w ?? errors.h ?? null

  return (
    <div className="col-span-2">
      <div className="grid grid-cols-[auto_auto] justify-start gap-x-6 gap-y-4 max-md:grid-cols-1">
        {board}
        {afterBoard}

        <div>
          <span className={LABEL_CLASS}>尺寸 W × H</span>
          <div className="flex items-start">
            <NumberInput
              id="q-w"
              ariaLabel="寬度 cm"
              value={size.w}
              onChange={(w) => onChange({ w })}
              normalize={normalizeDimText}
              onCommit={(raw) => {
                const pair = parseSizePair(raw)
                if (!pair) return false
                onChange({ w: normalizeDimText(String(pair.w)), h: normalizeDimText(String(pair.h)) })
                return true
              }}
              unit="cm"
              placeholder="寬"
              error={errors.w}
              hideMessage
              inputRef={refs.w}
              onEnter={() => refs.h.current?.focus()}
              className={DIM_W}
            />
            <span className="px-2 pt-2 font-(family-name:--q-font-serif) text-[16px] leading-6 text-(--q-ink-2)" aria-hidden="true">
              ×
            </span>
            <NumberInput
              id="q-h"
              ariaLabel="高度 cm"
              value={size.h}
              onChange={(h) => onChange({ h })}
              normalize={normalizeDimText}
              unit="cm"
              placeholder="高"
              error={errors.h}
              hideMessage
              inputRef={refs.h}
              onEnter={() => refs.qty.current?.focus()}
              className={DIM_W}
            />
          </div>
        </div>

        <NumberInput
          id="q-qty"
          label="數量"
          ariaLabel="數量 pcs"
          value={size.qty}
          onChange={(qty) => onChange({ qty })}
          normalize={normalizeQtyText}
          unit="pcs"
          placeholder="0"
          error={errors.qty}
          warning={warnings?.qty}
          hideMessage
          inputRef={refs.qty}
          onEnter={onQtyEnter}
          className={QTY_W}
        />
      </div>

      {/* 訊息一律走整列：錯誤與「無法拼板」都可能很長，放欄位下方會把格子撐歪 */}
      {boardNotice}
      {sizeError ? (
        <Msg tone="seal">{sizeError}</Msg>
      ) : errors.qty ? (
        <Msg tone="seal">{errors.qty}</Msg>
      ) : warnings?.qty ? (
        <Msg tone="warn">{warnings.qty}</Msg>
      ) : sizeMessage ? (
        <p className={`q-num mt-1.5 text-[12px] leading-4 ${sizeMessage.tone === 'seal' ? 'text-(--q-seal)' : 'text-(--q-warn)'}`}>
          ※ {sizeMessage.text}
        </p>
      ) : null}
    </div>
  )
}
