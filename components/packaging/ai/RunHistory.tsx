'use client'

// AI 執行歷史（規格 §三「歷史切換」、預設第 1 點：保留最近 10 次可切換比較；D91 AI 執行也要留 LOG）。
// 每一列：誰、何時、範圍、模式、結果張數、是否已放進模擬區；可「看結果」，或把結果／AI 前狀態載入模擬區。
// 只能載入範圍（horizon＋日期）與目前模擬區相同的那幾次（伺服器另回 window_mismatch 把關）。
// D101：比「工作日」即可（模擬開的週末加班會改變日期清單；有存模擬產線時數的那次，載入時連週末與時數一起載回）。

import { useEffect, useState } from 'react'
import type { AiRunMeta } from '@/lib/packaging/ai/types'
import type { YMD } from '@/lib/packaging/scheduleTypes'
import { Btn } from '@/components/packaging/board/Modal'
import { clock, md } from '@/components/packaging/board/boardFormat'
import Drawer from './Drawer'
import { fetchRuns } from './simApi'
import { isWeekend } from '@/lib/packaging/scheduleCalendar'
import { sameDates } from './simBoard'

/** D101：兩組模擬日期的工作日是否相同（同伺服器 simCapacity.sameWorkdays；這裡不 import 伺服器端的大檔） */
const sameWorkdays = (a: readonly YMD[], b: readonly YMD[]) => sameDates(a.filter(d => !isWeekend(d)), b.filter(d => !isWeekend(d)))
import { MODE_LABEL, RUN_ERROR_LABEL, RUN_STATUS_LABEL, durationText, horizonLabel } from './simText'

export default function RunHistory({ owner, isOwner, currentWindow, busy, nowMs, onClose, onShow, onLoad }: {
  /** 看誰的歷史；null＝自己 */
  owner: string | null
  isOwner: boolean
  /** 目前模擬區的範圍（沒有模擬區 null） */
  currentWindow: YMD[] | null
  busy: boolean
  nowMs: number
  onClose: () => void
  onShow: (runId: number) => void
  onLoad: (runId: number, which: 'result' | 'base') => void
}) {
  const [runs, setRuns] = useState<AiRunMeta[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /** 「重試」＋1 → 重新讀取 */
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    void fetchRuns(owner).then(r => {
      if (!alive) return
      if (r.json && r.json.success) { setRuns(r.json.runs); setErr(null) }
      else setErr(r.error ?? '讀取 AI 執行紀錄失敗')
    })
    return () => { alive = false }
  }, [owner, reloadKey])

  return (
    <Drawer title="AI 排程歷史（最近 10 次）" onClose={onClose}>
      {err ? (
        <div className="rounded border border-rose-800 bg-rose-950/30 p-3 text-xs text-rose-200">
          {err}
          <button type="button" onClick={() => setReloadKey(k => k + 1)} className="ml-2 underline">重試</button>
        </div>
      ) : !runs ? (
        <p className="py-6 text-center text-xs text-slate-400">讀取中…</p>
      ) : runs.length === 0 ? (
        <p className="py-6 text-center text-xs text-slate-400">還沒有 AI 排程紀錄</p>
      ) : (
        <ul className="space-y-2">
          {runs.map(r => {
            const loadable = isOwner && r.status === 'done' && currentWindow != null && sameWorkdays(r.windowDates, currentWindow)
            const why = !isOwner ? '別人的模擬區只能檢視'
              : r.status !== 'done' ? '這次沒有完成，沒有結果可載入'
                : currentWindow == null ? '目前沒有模擬區'
                  : !sameWorkdays(r.windowDates, currentWindow) ? '範圍與目前模擬區不同，不能載入' : undefined
            return (
              <li key={r.id} className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className={`rounded border px-1.5 py-px text-[10px] ${
                    r.status === 'done' ? 'border-emerald-700 bg-emerald-950/50 text-emerald-200'
                      : r.status === 'failed' ? 'border-rose-700 bg-rose-950/50 text-rose-200'
                        : 'border-violet-700 bg-violet-950/50 text-violet-200'
                  }`}>{RUN_STATUS_LABEL[r.status]}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold text-slate-100">
                    {clock(r.startedAt, nowMs)}・{horizonLabel(r.horizon)}・{MODE_LABEL[r.mode]}
                  </span>
                  <span className="text-[10px] text-slate-500">#{r.id}</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-400">
                  {r.windowDates.length > 0 && <span>{md(r.windowDates[0])}～{md(r.windowDates[r.windowDates.length - 1])}</span>}
                  <span>{r.ownerName ?? r.ownerEmail}</span>
                  {r.status !== 'running' && <span>耗時 {durationText(r.durationMs)}</span>}
                  {r.resultCount != null && <span>結果 {r.resultCount} 張</span>}
                  {r.applied === false && <span className="text-amber-300">未放進模擬區</span>}
                </div>
                {r.status === 'failed' && (
                  <div className="mt-1 text-[11px] text-rose-300">{r.errorMessage || (r.errorCode ? RUN_ERROR_LABEL[r.errorCode] : '失敗')}</div>
                )}
                {r.summary && <p className="mt-1 line-clamp-2 text-[11px] text-slate-300">{r.summary}</p>}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Btn onClick={() => onShow(r.id)}>看結果</Btn>
                  <Btn disabled={!loadable || busy} title={why} onClick={() => onLoad(r.id, 'result')}>載入這次結果</Btn>
                  <Btn disabled={!loadable || busy} title={why} onClick={() => onLoad(r.id, 'base')}>載入 AI 前</Btn>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Drawer>
  )
}
