'use client'

import { useRef } from 'react'
import { fmtDate, fmtTime } from '../_lib/format'
import { BTN_SECONDARY } from './ui'

/**
 * 產生報價後的摘要（§12.6）：標頭編號＋時間、「複製」次要鈕、可貼 LINE 的 <pre>。
 * 複製用 navigator.clipboard.writeText，失敗 fallback 選取 <pre> 並提示手動複製；
 * 「已複製 ✓」在按鈕文字內切換 2 秒，不用 toast。
 */
export type CopyState = 'idle' | 'copied' | 'failed'

export function QuoteSummary({
  quoteNo,
  createdAt,
  text,
  copyState,
  onCopy,
}: {
  quoteNo: string
  createdAt: Date
  text: string
  copyState: CopyState
  onCopy: (selectFallback: () => void) => void
}) {
  const preRef = useRef<HTMLPreElement>(null)
  const selectPre = () => {
    const el = preRef.current
    if (!el) return
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }
  return (
    <section aria-label="報價摘要" className="q-scroll mt-4 max-h-[40dvh] overflow-y-auto rounded-(--q-radius) border border-(--q-line) bg-(--q-card) p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="q-num text-[12px] leading-4 text-(--q-ink-2)">
          <span className="font-medium text-(--q-ink)">{quoteNo}</span>
          <span className="ml-2">
            {fmtDate(createdAt)} {fmtTime(createdAt)}
          </span>
        </div>
        <button
          type="button"
          onClick={() => onCopy(selectPre)}
          className={`${BTN_SECONDARY} ${copyState === 'failed' ? 'border-(--q-seal) text-(--q-seal) hover:bg-(--q-seal)' : ''}`}
        >
          {copyState === 'copied' ? '已複製 ✓' : copyState === 'failed' ? '請手動複製' : '複製'}
        </button>
      </div>
      <pre ref={preRef} className="mt-3 whitespace-pre-wrap font-(family-name:--q-font-sans) text-[13px] leading-[22px] text-(--q-ink)">
        {text}
      </pre>
    </section>
  )
}
