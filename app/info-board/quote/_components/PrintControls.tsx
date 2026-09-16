'use client'

import { useRef, type KeyboardEvent, type RefObject } from 'react'
import type { PrintMethod, Sides } from '@/lib/quote/types'
import { METHOD_LABEL } from '../_lib/model'
import { parseInteger } from '../_lib/normalize'
import { NumberInput } from './NumberInput'
import { FOCUS_RING, LABEL_CLASS } from './ui'

/**
 * 分段控制（§12.6）：role=radiogroup；外框墨線、選中段塗黑（在表單上把選項塗黑）。
 * roving tabindex：只有選中段 tabIndex=0；← → 移動並 preventDefault。
 */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
}: {
  label: string
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  disabled?: boolean
}) {
  const refs = useRef<Map<T, HTMLButtonElement>>(new Map())
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const next = options[(idx + dir + options.length) % options.length]
    onChange(next.value)
    refs.current.get(next.value)?.focus()
  }
  return (
    <div role="radiogroup" aria-label={label} className={`inline-flex rounded-(--q-radius) border border-(--q-ink) bg-(--q-card) p-0.5 ${disabled ? 'opacity-60' : ''}`}>
      {options.map((o, idx) => {
        const checked = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            ref={(el) => {
              if (el) refs.current.set(o.value, el)
              else refs.current.delete(o.value)
            }}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            className={`rounded-[2px] px-3.5 py-1.5 text-[13px] leading-5 font-medium transition-colors duration-(--q-dur-fast) ${FOCUS_RING} ${
              checked ? 'bg-(--q-ink) text-(--q-paper)' : 'text-(--q-ink-2) hover:text-(--q-ink)'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function PrintControls({
  methods,
  sides,
  method,
  versions,
  onSides,
  onMethod,
  onVersions,
  versionsError,
  versionsRef,
  disabled,
}: {
  methods: PrintMethod[]
  sides: Sides
  method: PrintMethod
  versions: string
  onSides: (s: Sides) => void
  onMethod: (m: PrintMethod) => void
  onVersions: (raw: string) => void
  versionsError?: string | null
  versionsRef?: RefObject<HTMLInputElement | null>
  disabled?: boolean
}) {
  const isKoshi = method === 'koshi'
  const noPrint = method === 'none'
  return (
    <>
      <div>
        <span className={LABEL_CLASS}>單雙面</span>
        <Segmented<'1' | '2'>
          label="單雙面"
          options={[
            { value: '1', label: '單面' },
            { value: '2', label: '雙面' },
          ]}
          value={String(sides) as '1' | '2'}
          onChange={(v) => onSides(v === '2' ? 2 : 1)}
          disabled={disabled || noPrint}
        />
      </div>
      <div>
        <span className={LABEL_CLASS}>印刷方式</span>
        <Segmented<PrintMethod>
          label="印刷方式"
          options={methods.map((m) => ({ value: m, label: METHOD_LABEL[m] }))}
          value={method}
          onChange={onMethod}
          disabled={disabled}
        />
      </div>
      <div className="q-collapse col-span-2" data-open={isKoshi ? 'true' : 'false'} aria-hidden={!isKoshi}>
        <div>
          <div className="grid grid-cols-2 items-end gap-x-6">
            <NumberInput
              id="q-versions"
              label="版數"
              value={versions}
              onChange={onVersions}
              normalize={(raw) => {
                const n = parseInteger(raw)
                return n === null ? raw.trim() : String(Math.max(1, n))
              }}
              unit="版"
              placeholder="1"
              error={isKoshi ? versionsError : null}
              inputRef={versionsRef}
              disabled={disabled || !isKoshi}
            />
            <p className="pb-3 text-[12px] leading-4 text-(--q-ink-3)">每版計一次製版費</p>
          </div>
        </div>
      </div>
    </>
  )
}
