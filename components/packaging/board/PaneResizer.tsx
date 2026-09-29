'use client'

// 左右欄寬度拖拉分隔線（Snow 2026-09-27：待排池與排程之間要能拉動寬度）
//
// 互動：
//   - 拖曳：pointer capture，放開才寫入 localStorage（拖曳中只更新畫面，不狂寫儲存）
//   - 雙擊：恢復預設寬度（交回給呼叫端的 RWD 類別）
//   - 鍵盤：聚焦後 ← → 每次 16px，Shift 加速到 64px；Home 最窄、End 最寬（可及性：不能只靠滑鼠）
//   - 報讀器：aria-valuenow／valuemin／valuemax／valuetext 都給；沒拖過（currentWidth=null）時用實際量到的寬度
// 寬度限制在 [MIN_POOL_WIDTH, 視窗寬 × MAX_POOL_RATIO]；視窗縮小時由呼叫端的 max-w 類別兜底。
// 只在桌機（lg 以上）出現：手機是上下堆疊，沒有「左右」可拉。

import { useCallback, useEffect, useRef, useState } from 'react'

export const MIN_POOL_WIDTH = 280
export const MAX_POOL_RATIO = 0.7

export function maxPoolWidth(viewportWidth: number): number {
  return Math.max(MIN_POOL_WIDTH, Math.floor(viewportWidth * MAX_POOL_RATIO))
}

export function clampPoolWidth(w: number, viewportWidth: number): number {
  return Math.round(Math.min(maxPoolWidth(viewportWidth), Math.max(MIN_POOL_WIDTH, w)))
}

interface Props {
  /** 目前左欄的實際寬度（px）；拖曳起點以它為準 */
  getCurrentWidth: () => number
  /** 拖曳中即時更新（不存檔） */
  onResize: (w: number) => void
  /** 放開／鍵盤調整後寫入（存檔） */
  onCommit: (w: number) => void
  /** 雙擊恢復預設 */
  onReset: () => void
  currentWidth: number | null
}

export default function PaneResizer({ getCurrentWidth, onResize, onCommit, onReset, currentWidth }: Props) {
  const drag = useRef<{ startX: number; startW: number; last: number } | null>(null)
  // 給報讀器的數值：實際寬度與上限（依視窗寬）。在 rAF／resize 回呼裡量（版面排好之後），不在 render 中讀 DOM
  const [measured, setMeasured] = useState<{ now: number; max: number } | null>(null)
  useEffect(() => {
    const measure = () => setMeasured({ now: Math.round(getCurrentWidth()), max: maxPoolWidth(window.innerWidth) })
    const raf = window.requestAnimationFrame(measure)
    window.addEventListener('resize', measure)
    return () => { window.cancelAnimationFrame(raf); window.removeEventListener('resize', measure) }
  }, [getCurrentWidth, currentWidth])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const startW = getCurrentWidth()
    drag.current = { startX: e.clientX, startW, last: startW }
    e.currentTarget.setPointerCapture(e.pointerId)
    // 拖曳中全頁維持調整游標、不選取文字（否則滑過表格會反白一片）
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [getCurrentWidth])

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const w = clampPoolWidth(d.startW + (e.clientX - d.startX), window.innerWidth)
    if (w !== d.last) { d.last = w; onResize(w) }
  }, [onResize])

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    // 沒有真的移動（只是點一下）就不存，保留「預設寬度」狀態
    if (d.last !== d.startW) onCommit(d.last)
  }, [onCommit])

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      onCommit(e.key === 'Home' ? MIN_POOL_WIDTH : maxPoolWidth(window.innerWidth))
      return
    }
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = (e.shiftKey ? 64 : 16) * (e.key === 'ArrowLeft' ? -1 : 1)
    onCommit(clampPoolWidth(getCurrentWidth() + step, window.innerWidth))
  }, [getCurrentWidth, onCommit])

  const valueNow = currentWidth ?? measured?.now

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="調整待排池寬度（拖曳；雙擊恢復預設；方向鍵微調，Home 最窄、End 最寬）"
      aria-valuemin={MIN_POOL_WIDTH}
      aria-valuemax={measured?.max}
      aria-valuenow={valueNow}
      aria-valuetext={valueNow != null ? `待排池寬 ${valueNow} px${currentWidth == null ? '（預設）' : ''}` : undefined}
      tabIndex={0}
      title="拖曳調整寬度・雙擊恢復預設"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      className="group relative hidden w-2 shrink-0 cursor-col-resize touch-none select-none outline-none lg:order-2 lg:block"
    >
      {/* 細線平常淡、滑過或聚焦時變亮；外層 8px 寬是可抓的熱區 */}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-slate-700 transition-colors group-hover:w-0.5 group-hover:bg-sky-400 group-focus-visible:w-0.5 group-focus-visible:bg-sky-400" />
      <div className="absolute left-1/2 top-1/2 h-8 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-600 group-hover:bg-sky-400 group-focus-visible:bg-sky-400" />
    </div>
  )
}
