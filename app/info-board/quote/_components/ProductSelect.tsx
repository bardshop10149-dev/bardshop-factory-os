'use client'

import type { Ref } from 'react'
import type { CatalogProduct } from '@/lib/quote/api'
import { boardShortLabel } from '../_lib/format'
import { METHOD_LABEL } from '../_lib/model'
import { LABEL_CLASS, Msg, SELECT_CLASS, SelectShell } from './ui'

/**
 * 品項下拉（§12.6）：原生 select 樣式化；只列 published（catalog 已過濾）。
 * 選中後顯示「預設板材 … · 建議印刷 … · 每盤數量依尺寸、板材與拼板間距自動計算」。
 */
export function ProductSelect({
  products,
  value,
  onChange,
  error,
  disabled,
  selectRef,
}: {
  products: CatalogProduct[]
  value: string
  onChange: (id: string) => void
  error?: string | null
  disabled?: boolean
  selectRef?: Ref<HTMLSelectElement>
}) {
  const current = products.find((p) => p.id === value) ?? null
  const msgId = 'q-product-msg'

  return (
    <div className="col-span-2">
      <label htmlFor="q-product" className={LABEL_CLASS}>
        品項
      </label>
      <SelectShell>
        <select
          id="q-product"
          ref={selectRef}
          value={value}
          disabled={disabled}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? msgId : undefined}
          onChange={(e) => onChange(e.target.value)}
          className={`${SELECT_CLASS} ${error ? 'border-(--q-seal) ring-2 ring-(--q-seal)/20' : ''}`}
        >
          <option value="">{disabled ? '載入中…' : '請選擇品項'}</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {'　'}
              {p.category}
              {p.status !== 'published' ? '（未發布）' : ''}
            </option>
          ))}
        </select>
      </SelectShell>
      {error ? (
        <Msg tone="seal" id={msgId}>
          {error}
        </Msg>
      ) : current ? (
        <p className="mt-1.5 text-[12px] leading-4 text-(--q-ink-2)">
          預設板材{' '}
          <span className="q-num">
            {boardShortLabel(
              current.config.boards.defaultItem,
              current.config.boards.options.find((o) => o.item === current.config.boards.defaultItem)?.label,
            )}
          </span>{' '}
          · 建議印刷 {METHOD_LABEL[current.config.defaultPrintMethod]} · 每盤數量依尺寸、板材與拼板間距自動計算
        </p>
      ) : (
        <p className="mt-1.5 text-[12px] leading-4 text-(--q-ink-3)">只列出已發布的品項</p>
      )}
    </div>
  )
}
