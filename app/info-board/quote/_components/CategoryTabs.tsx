'use client'

import { useRef, type KeyboardEvent } from 'react'
import type { CatalogCategory } from '@/lib/quote/api'
import { FOCUS_RING } from './ui'

/**
 * 品類分頁（§12.6）：role=tablist、2px 墨線指示（不用膠囊底色）、灰態帶「尚未開放」小標。
 * 鍵盤：roving tabindex——只有選中頁 tabIndex=0，← → 在可用分頁間移動並跳過灰態。
 */
export function CategoryTabs({
  categories,
  value,
  onChange,
}: {
  categories: CatalogCategory[]
  value: CatalogCategory['code']
  onChange: (code: CatalogCategory['code']) => void
}) {
  const refs = useRef<Map<string, HTMLButtonElement>>(new Map())

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const dir = e.key === 'ArrowRight' ? 1 : -1
    let i = idx
    for (let step = 0; step < categories.length; step++) {
      i = (i + dir + categories.length) % categories.length
      const c = categories[i]
      if (c.enabled) {
        refs.current.get(c.code)?.focus()
        onChange(c.code)
        return
      }
    }
  }

  return (
    <div role="tablist" aria-label="品類" className="flex items-end gap-8 overflow-x-auto border-b border-(--q-line)">
      {categories.map((c, idx) => {
        const selected = c.code === value
        const base = `relative shrink-0 pb-3 text-[15px] leading-[22px] font-medium tracking-[0.02em] transition-colors duration-(--q-dur-fast) ${FOCUS_RING}`
        if (!c.enabled) {
          return (
            <button
              key={c.code}
              type="button"
              role="tab"
              aria-selected={false}
              aria-disabled="true"
              tabIndex={-1}
              className={`${base} cursor-not-allowed text-(--q-disabled)`}
              onClick={(e) => e.preventDefault()}
            >
              {c.name}
              <span className="ml-1.5 rounded-[2px] border border-(--q-line) px-1 py-px text-[10px] leading-[14px] tracking-[0.08em] text-(--q-ink-3)">尚未開放</span>
            </button>
          )
        }
        return (
          <button
            key={c.code}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            ref={(el) => {
              if (el) refs.current.set(c.code, el)
              else refs.current.delete(c.code)
            }}
            onClick={() => onChange(c.code)}
            onKeyDown={(e) => onKeyDown(e, idx)}
            className={`${base} ${
              selected
                ? 'text-(--q-ink) after:absolute after:inset-x-0 after:-bottom-px after:h-(--q-rule) after:bg-(--q-ink)'
                : 'text-(--q-ink-2) hover:text-(--q-ink)'
            }`}
          >
            {c.name}
          </button>
        )
      })}
    </div>
  )
}
