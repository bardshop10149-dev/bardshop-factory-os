'use client'

// 工作台對話框的共用外殼：遮罩、標題、Esc 關閉、焦點管理。
// 對話框開著時工作台的輪詢照常（資料層處理），但鍵盤 Ctrl+Z 不作用（見 BoardLayout 的鍵盤處理）。
//
// 焦點（鍵盤操作）：
//   - 開啟時：焦點移進對話框（內容已有 autoFocus 的欄位就不搶；否則移到「×」關閉鈕）
//   - 開著時：Tab／Shift+Tab 圈在對話框內（aria-modal 只告訴讀螢幕軟體，Tab 仍會跑到背後的卡片，
//     再按 Enter 就會多開一個彈窗——所以要自己攔）
//   - 關閉時：焦點還給開啟前的元素（例：按 Enter 開詳情的那張卡）
// Esc：只有「最上層」的工作台對話框處理，且在 window 捕獲階段就攔下（stopPropagation）——
//   否則同時開著的 SoOrderModal（全站共用、在 window 冒泡階段聽 Esc）會跟著一起關。
//   同 ZoomableViewer 的做法。

import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** 自己是不是最上層的工作台對話框（後掛上的在 DOM 後面＝在上面；z-index 相同） */
function isTopDialog(el: HTMLElement | null): boolean {
  if (!el) return false
  const all = document.querySelectorAll('[data-board-dialog]')
  return all.length > 0 && all[all.length - 1] === el
}

export default function Modal({ title, onClose, children, footer, wide = false }: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  // 開啟前的焦點：要在「第一次 render」就記下——effect 執行時子元件的 autoFocus 已經把焦點搬進來了
  const [returnTo] = useState<HTMLElement | null>(() =>
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null)

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    const root = dialogRef.current
    if (!root || !isTopDialog(root)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // 捕獲階段攔下：底下的對話框（含 SoOrderModal）收不到這個 Esc
      onClose()
      return
    }
    if (e.key === 'Tab') {
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => el.offsetParent !== null || el === document.activeElement)
      if (items.length === 0) { e.preventDefault(); root.focus({ preventScroll: true }); return }
      const at = items.indexOf(document.activeElement as HTMLElement)
      // 焦點在對話框內、且不在頭尾：交給瀏覽器（輸入框、下拉選單照常）
      if (at > 0 && at < items.length - 1) return
      if (at === 0 && !e.shiftKey && items.length > 1) return
      if (at === items.length - 1 && e.shiftKey && items.length > 1) return
      e.preventDefault()
      const next = e.shiftKey
        ? (at <= 0 ? items.length - 1 : at - 1)
        : (at < 0 || at >= items.length - 1 ? 0 : at + 1)
      items[next].focus()
    }
  })

  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e)
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [])

  useEffect(() => {
    const root = dialogRef.current
    if (root && !root.contains(document.activeElement)) (closeRef.current ?? root).focus({ preventScroll: true })
    return () => {
      // 還給開啟前的元素（它還在畫面上才還；卡片可能已被放回待排池而消失）
      if (returnTo && returnTo.isConnected) returnTo.focus({ preventScroll: true })
    }
  }, [returnTo])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4" onPointerDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        data-board-dialog
        className={`flex max-h-[90vh] w-full ${wide ? 'max-w-4xl' : 'max-w-lg'} flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900 text-slate-200 shadow-2xl outline-none`}
      >
        <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
          <h2 className="min-w-0 flex-1 text-base font-bold text-white">{title}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="關閉" className="rounded px-2 py-0.5 text-lg leading-none text-slate-400 hover:bg-slate-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400">×</button>
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
