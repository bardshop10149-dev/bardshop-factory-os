'use client'

// 工作台對話框的共用外殼：遮罩、標題、Esc 關閉。
// 對話框開著時工作台的輪詢照常（資料層處理），但鍵盤 Ctrl+Z 不作用（見 BoardLayout 的鍵盤處理）。

import { useEffect, type ReactNode } from 'react'

export default function Modal({ title, onClose, children, footer, wide = false }: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onPointerDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div
        role="dialog"
        aria-modal="true"
        data-board-dialog
        className={`flex max-h-[90vh] w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 text-slate-200 shadow-2xl`}
      >
        <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
          <h2 className="min-w-0 flex-1 text-base font-bold text-white">{title}</h2>
          <button type="button" onClick={onClose} aria-label="關閉" className="rounded px-2 py-0.5 text-lg leading-none text-slate-400 hover:bg-slate-800 hover:text-white">×</button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-800 px-4 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function Btn({ children, onClick, disabled, tone = 'default', type = 'button', title }: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  tone?: 'default' | 'primary' | 'danger'
  type?: 'button' | 'submit'
  title?: string
}) {
  const cls = tone === 'primary'
    ? 'border-sky-500 bg-sky-600 text-white hover:bg-sky-500'
    : tone === 'danger'
      ? 'border-rose-600 bg-rose-700/80 text-white hover:bg-rose-600'
      : 'border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700'
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title}
      className={`rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${cls}`}>
      {children}
    </button>
  )
}
