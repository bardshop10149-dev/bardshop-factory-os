'use client'

// 右側抽屜（AI 結果、歷史、規則與門檻、採用紀錄共用）：外觀比照正式工作台的 VersionsPanel。
// 手機寬度：全寬（max-w 只在較寬的螢幕生效）。Esc 關閉：只有在沒有工作台對話框（Modal，data-board-dialog）開著時才處理，
// 否則會跟對話框的 Esc 一起關掉。

import { useEffect, useEffectEvent, type ReactNode } from 'react'

export default function Drawer({ title, onClose, children, footer, wide = false, label }: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** 較寬（AI 結果、門檻表） */
  wide?: boolean
  /** aria-label（title 不是純文字時用） */
  label?: string
}) {
  const onEsc = useEffectEvent(() => onClose())
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[data-board-dialog]')) return
      onEsc()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  return (
    <>
      <div className="fixed inset-0 z-[55] bg-black/40" onPointerDown={onClose} />
      <aside
        className={`fixed inset-y-0 right-0 z-[56] flex w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'} flex-col border-l border-slate-700 bg-slate-900 text-slate-200 shadow-2xl`}
        aria-label={label ?? (typeof title === 'string' ? title : undefined)}
      >
        <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
          <h2 className="min-w-0 flex-1 text-base font-bold text-white">{title}</h2>
          <button type="button" onClick={onClose} aria-label="關閉" className="rounded px-2 text-lg text-slate-400 hover:bg-slate-800 hover:text-white">×</button>
        </div>
        <div className="eip-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 px-4 py-3">{footer}</div>}
      </aside>
    </>
  )
}
