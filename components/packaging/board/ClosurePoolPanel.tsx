'use client'

// D110 結案池面板（右側抽屜；正式工作台與 AI 模擬區共用）。
//
// 主管反映「訂單多，不記得結過哪些」→ 列出近 30 天結案的 SO-項次：單號-項次、客戶、品名、數量、交期、原區塊、
// 誰、何時、備註、結案當下 ARGO 已銷量。預設看「今天」，可切「近 7 天／近 30 天」。
// 每列可「復原」（POST /api/packaging/closures action 'restore'，需 packaging_admin）：該行照正常規則回到待排池。
// 資料來源 GET /api/packaging/closures（前端不直接查表）；清單狀態在 useClosures.useClosureList，這裡只負責畫。
// 復原是兩段式（先按「復原」、再按「確定復原」）：復原會讓卡片重新出現在所有人的待排池，不該一按就發生。

import { useEffect, useMemo, useState } from 'react'
import type { Closure } from '@/lib/packaging/scheduleTypes'
import { POOL_BLOCK_META } from '@/lib/packaging/types'
import { fmtQty } from '@/components/packaging/poolStyles'
import Drawer from '@/components/packaging/ai/Drawer'
import { clock, md } from './boardFormat'
import { CLOSURE_RANGE_LABEL, closuresInRange, type ClosureRange } from './closureLocal'
import type { ClosureListApi } from './useClosures'

const RANGES: ClosureRange[] = ['today', '7d', '30d']

export interface RestoreResult {
  ok: boolean
  /** 失敗原因（顯示在那一列下面） */
  message?: string
}

export default function ClosurePoolPanel({ list, canRestore, pendingCount, nowMs, onRestore, onOpenOrder, onClose }: {
  list: ClosureListApi
  /** 有 packaging_admin 才能復原（唯讀者只能看清單） */
  canRestore: boolean
  /** 背景還在送出的結案筆數（送完會自動出現在清單） */
  pendingCount: number
  nowMs: number
  onRestore: (c: Closure) => Promise<RestoreResult>
  onOpenOrder?: (so: string) => void
  onClose: () => void
}) {
  const [range, setRange] = useState<ClosureRange>('today')
  const [showRestored, setShowRestored] = useState(false)
  /** 等第二次確認的那一列 */
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [rowError, setRowError] = useState<{ id: number; message: string } | null>(null)

  // 打開面板就重抓一次（別的主管結的、別的分頁結的也要看得到）
  const { refresh } = list
  useEffect(() => { void refresh() }, [refresh])

  const today = list.today
  const counts = useMemo(() => {
    const out = {} as Record<ClosureRange, number>
    for (const r of RANGES) out[r] = today ? closuresInRange(list.list, r, today).filter(c => !c.restoredAt).length : 0
    return out
  }, [list.list, today])
  const inRange = useMemo(() => (today ? closuresInRange(list.list, range, today) : []), [list.list, range, today])
  const restoredCount = inRange.filter(c => c.restoredAt).length
  const rows = showRestored ? inRange : inRange.filter(c => !c.restoredAt)

  const restore = async (c: Closure) => {
    if (busyId != null) return
    setBusyId(c.id)
    setRowError(null)
    try {
      const r = await onRestore(c)
      if (!r.ok) setRowError({ id: c.id, message: r.message ?? '復原失敗' })
    } finally {
      setBusyId(null)
      setConfirmId(null)
    }
  }

  return (
    <Drawer title={<span>結案池 <span className="text-sm font-normal text-slate-400">（今天 {counts.today} 筆）</span></span>} label="結案池" wide onClose={onClose}>
      <div className="space-y-3">
        <p className="text-[11px] leading-relaxed text-slate-400">
          結案的 SO-項次永久不再進待排池。結錯了按「復原」，那一行會照正常規則回到待排池（排程要重新排）。
        </p>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <div className="flex overflow-hidden rounded-lg border border-slate-700" role="tablist" aria-label="結案日期範圍">
            {RANGES.map(r => (
              <button
                key={r}
                type="button"
                role="tab"
                aria-selected={range === r}
                onClick={() => { setRange(r); setConfirmId(null) }}
                className={`px-3 py-1.5 font-semibold ${range === r ? 'bg-rose-800/70 text-white' : 'bg-slate-900 text-slate-300 hover:bg-slate-800'}`}
              >
                {CLOSURE_RANGE_LABEL[r]} <span className="tabular-nums text-[11px] font-normal opacity-80">{counts[r]}</span>
              </button>
            ))}
          </div>
          <label className="flex cursor-pointer items-center gap-1.5 text-slate-300">
            <input type="checkbox" checked={showRestored} onChange={e => setShowRestored(e.target.checked)} className="accent-sky-500" />
            顯示已復原的{restoredCount > 0 ? `（${restoredCount}）` : ''}
          </label>
          <span className="flex-1" />
          <button type="button" onClick={() => void refresh()} disabled={list.loading}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-slate-300 hover:bg-slate-800 disabled:opacity-50">
            {list.loading ? '更新中…' : '重新整理'}
          </button>
        </div>

        {pendingCount > 0 && (
          <p className="rounded border border-amber-700/60 bg-amber-950/30 px-3 py-1.5 text-[11px] text-amber-200">
            還有 {pendingCount} 筆結案正在背景送出，送完會自動出現在這裡。
          </p>
        )}
        {list.error && <p role="alert" className="rounded border border-red-700 bg-red-950/50 px-3 py-2 text-xs text-red-200">{list.error}</p>}
        {!canRestore && <p className="text-[11px] text-slate-500">你是唯讀權限：可以看清單，復原需要包裝主管（packaging_admin）。</p>}

        {!list.loaded && !list.error ? (
          <p className="py-8 text-center text-xs text-slate-500">載入中…</p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-500">{CLOSURE_RANGE_LABEL[range]}沒有{showRestored ? '' : '未復原的'}結案。</p>
        ) : (
          <ul className="space-y-2">
            {rows.map(c => {
              const restored = !!c.restoredAt
              return (
                <li key={c.id} className={`rounded-lg border px-3 py-2 text-xs ${restored ? 'border-slate-800 bg-slate-950/40 opacity-70' : 'border-slate-700 bg-slate-950/60'}`}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {onOpenOrder ? (
                      <button type="button" onClick={() => onOpenOrder(c.so)} title="訂單詳情"
                        className="font-mono text-sm font-bold text-sky-300 underline decoration-dotted hover:text-sky-200">{c.so}-{c.soLine}</button>
                    ) : (
                      <span className="font-mono text-sm font-bold text-slate-100">{c.so}-{c.soLine}</span>
                    )}
                    {c.blockAtClose && (
                      <span className="rounded border border-slate-600 bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300" title="結案當下卡片所在的區塊">
                        {POOL_BLOCK_META[c.blockAtClose].title}
                      </span>
                    )}
                    {restored && <span className="rounded border border-emerald-700/60 bg-emerald-950/40 px-1.5 py-0.5 text-[10px] text-emerald-200">已復原</span>}
                    <span className="flex-1" />
                    {!restored && canRestore && (
                      confirmId === c.id ? (
                        <span className="flex items-center gap-1.5">
                          <span className="text-[11px] text-amber-200">這一行會回到待排池</span>
                          <button type="button" disabled={busyId != null} onClick={() => void restore(c)}
                            className="rounded border border-amber-500 bg-amber-700/70 px-2 py-0.5 font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
                            {busyId === c.id ? '復原中…' : '確定復原'}
                          </button>
                          <button type="button" disabled={busyId != null} onClick={() => setConfirmId(null)}
                            className="rounded border border-slate-600 px-2 py-0.5 text-slate-300 hover:bg-slate-800 disabled:opacity-50">取消</button>
                        </span>
                      ) : (
                        <button type="button" disabled={busyId != null} onClick={() => { setConfirmId(c.id); setRowError(null) }}
                          className="rounded border border-slate-600 bg-slate-800 px-2 py-0.5 font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50">復原</button>
                      )
                    )}
                  </div>
                  <div className="mt-1 break-words text-slate-200">
                    <span className="text-slate-400">{c.customer ?? '（無客戶名稱）'}</span>
                    <span className="mx-1 text-slate-600">・</span>
                    <span className="font-semibold">{c.itemName ?? '（無品名）'}</span>
                    {c.itemCode && <span className="ml-1 font-mono text-[11px] text-slate-500">{c.itemCode}</span>}
                  </div>
                  <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-400">
                    <div className="flex gap-1"><dt>數量</dt><dd className="tabular-nums text-slate-200">{fmtQty(c.qtyAtClose)}</dd></div>
                    <div className="flex gap-1"><dt>交期</dt><dd className="text-slate-200">{c.dueDate ? md(c.dueDate) : '—'}</dd></div>
                    <div className="flex gap-1" title="結案當下 ARGO 銷貨鏡像分配到這一行的已銷貨量">
                      <dt>結案時 ARGO 已銷</dt>
                      <dd className="tabular-nums text-slate-200">{c.soldQtyAtClose == null ? '無紀錄' : fmtQty(c.soldQtyAtClose)}</dd>
                    </div>
                    <div className="flex gap-1"><dt>結案</dt><dd className="text-slate-200">{c.closedByName ?? '（未具名）'}・{clock(c.closedAt, nowMs)}</dd></div>
                    {restored && (
                      <div className="flex gap-1"><dt>復原</dt><dd className="text-slate-200">{c.restoredByName ?? '（未具名）'}・{clock(c.restoredAt, nowMs)}</dd></div>
                    )}
                  </dl>
                  {c.note && <p className="mt-1 break-words rounded bg-slate-900 px-2 py-1 text-[11px] text-slate-300">備註：{c.note}</p>}
                  {rowError?.id === c.id && <p role="alert" className="mt-1 text-[11px] text-rose-300">{rowError.message}</p>}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Drawer>
  )
}
