'use client'

// 工作台頂部的檢視切換（D56）：日／週／兩週＋◀ 今天 ▶。
// 日：◀ ▶ 前一個／後一個工作台日期（跳過非工作日；開加班的週六照 D48 顯示）
// 週／兩週：◀ ▶ 一次平移 5／10 個台灣工作日。過去的日子不在工作台上（D50 延誤卡已順延到今天），◀ 到今天就停。

import type { ReactNode } from 'react'
import { VIEW_LABEL, type BoardViewMode } from '@/lib/packaging/boardView'

const MODES: BoardViewMode[] = ['day', 'week', 'twoWeek']

export default function ViewSwitcher({ view, onView, rangeLabel, onPrev, onNext, onToday, atToday, busy, extra }: {
  view: BoardViewMode
  onView: (v: BoardViewMode) => void
  rangeLabel: string
  /** null＝已到最前面 */
  onPrev: (() => void) | null
  onNext: (() => void) | null
  onToday: () => void
  atToday: boolean
  /** 換視窗載入中 */
  busy: boolean
  extra?: ReactNode
}) {
  const navBtn = 'rounded border border-slate-700 bg-slate-900 px-2.5 py-1 text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40'
  const unit = view === 'day' ? '一天' : view === 'week' ? '5 個工作日' : '10 個工作日'
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <div role="group" aria-label="檢視範圍" className="inline-flex overflow-hidden rounded-lg border border-slate-600">
        {MODES.map(m => (
          <button
            key={m}
            type="button"
            aria-pressed={view === m}
            onClick={() => onView(m)}
            className={`px-3 py-1 font-semibold ${view === m ? 'bg-sky-600 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}
          >{VIEW_LABEL[m]}</button>
        ))}
      </div>
      <button type="button" className={navBtn} disabled={!onPrev} onClick={() => onPrev?.()} title={`往前${unit}`} aria-label={`往前${unit}`}>◀</button>
      <button type="button" className={navBtn} disabled={atToday} onClick={onToday}>今天</button>
      <button type="button" className={navBtn} disabled={!onNext} onClick={() => onNext?.()} title={`往後${unit}`} aria-label={`往後${unit}`}>▶</button>
      <span className="font-semibold text-slate-200">{rangeLabel}</span>
      {busy && <span className="animate-pulse text-amber-300">載入中…</span>}
      {extra}
    </div>
  )
}
