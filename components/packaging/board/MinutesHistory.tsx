'use client'

// D69 卡片詳情的「修改歷程」：這張（子）卡每次改工時的紀錄＋同品號過去的修改摘要（學習用）。
// 資料：GET /api/packaging/adjustments?placementId=&itemCode=（唯讀；只回名字、不回 email）。
// - 這張卡：新到舊，含「復原」產生的紀錄（方式標「復原」）。
// - 同品號：排除復原產生的紀錄；「改後平均每件 x 分（標準 y 分）」讓主管判斷標準工時是否偏離。
// migration 未套用（新表不存在）時只顯示提示，不影響詳情其他內容。

import { useEffect, useState } from 'react'
import type { AdjustmentsResponse, MinutesEditVia, PackagingLine, TimeAdjustment } from '@/lib/packaging/scheduleTypes'
import { hoursText } from '@/lib/packaging/boardView'
import { lineNameOf } from '@/lib/packaging/scheduleLines'
import { clock, md } from './boardFormat'
import { fetchAdjustments } from './boardApi'

type Ok = Extract<AdjustmentsResponse, { success: true }>

const VIA_LABEL: Record<MinutesEditVia, string> = { drag: '拉下緣', dialog: '詳情輸入', undo: '復原' }

/** 每件分鐘：小數位依大小調整（0.05 分／件這種很常見） */
function perUnitText(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return '—'
  const d = x >= 10 ? 1 : x >= 1 ? 2 : 3
  return String(Math.round(x * 10 ** d) / 10 ** d)
}

const h = (m: number | null | undefined): string => (m == null ? '—' : `${hoursText(m)}h`)

function Row({ a, lines, showWhere }: { a: TimeAdjustment; lines?: PackagingLine[]; showWhere: boolean }) {
  return (
    <li className="py-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="tabular-nums text-slate-400">{clock(a.createdAt)}</span>
        <span className="text-slate-200">{a.actorName ?? '—'}</span>
        <span className="tabular-nums">
          {h(a.beforeMinutes)} → <b className={a.cleared ? 'text-slate-300' : 'text-amber-200'}>{h(a.afterMinutes)}</b>
          {a.cleared && <span className="ml-1 text-slate-400">（回到標準）</span>}
        </span>
        <span className={`rounded px-1 text-[10px] ${a.via === 'undo' ? 'bg-slate-800 text-slate-400' : 'bg-slate-800 text-slate-300'}`}>{VIA_LABEL[a.via] ?? a.via}</span>
        {showWhere && (
          <span className="text-[10px] text-slate-500">
            {a.planDate ? md(a.planDate) : '待排區'}{a.lineId != null && lines ? ` ${lineNameOf(lines, a.lineId)}` : ''}・{a.qty} 件
          </span>
        )}
      </div>
      {a.reason && <div className="break-words pl-1 text-[11px] text-slate-400">原因：{a.reason}</div>}
    </li>
  )
}

export default function MinutesHistory({ placementId, itemCode, stdPerUnit, lines }: {
  placementId: string
  itemCode: string | null
  /** 目前的標準每件分鐘（沒有歷史紀錄可參考時用；可為 null） */
  stdPerUnit?: number | null
  lines?: PackagingLine[]
}) {
  const [data, setData] = useState<Ok | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await fetchAdjustments({ placementId, itemCode })
      if (!alive) return
      setLoading(false)
      if (r.json?.success) { setData(r.json); setErr(null) }
      else setErr(r.error ?? '讀取修改歷程失敗')
    })()
    return () => { alive = false }
  }, [placementId, itemCode])

  if (loading) return <p className="text-[11px] text-slate-500">讀取修改歷程…</p>
  if (err) return <p className="text-[11px] text-orange-300">{err}</p>
  if (!data) return null

  const same = data.sameItem
  // 標準每件分鐘：優先用最近一筆紀錄當時的值（和平均值同一個基準），沒有才用目前卡片的
  const std = same.recent.find(a => a.perUnitStd != null)?.perUnitStd ?? stdPerUnit ?? null
  return (
    <div className="space-y-2">
      {data.placement.length === 0 ? (
        <p className="text-[11px] text-slate-500">這張卡還沒有改過工時。</p>
      ) : (
        <ul className="divide-y divide-slate-800/70 text-[11px]">
          {data.placement.map(a => <Row key={a.id} a={a} lines={lines} showWhere={false} />)}
        </ul>
      )}
      {itemCode && (
        <div className="rounded border border-slate-800 bg-slate-950/50 px-2 py-1.5 text-[11px]">
          {same.count === 0 ? (
            <span className="text-slate-500">同品號（<span className="font-mono">{itemCode}</span>）過去沒有修改紀錄。</span>
          ) : (
            <>
              <div className="text-slate-300">
                同品號過去 <b>{same.count}</b> 次修改，改後平均每件 <b className="text-amber-200">{perUnitText(same.avgPerUnitAfter)}</b> 分
                <span className="text-slate-400">（標準 {perUnitText(std)} 分）</span>
                <span className="ml-1 text-[10px] text-slate-500">不含復原產生的紀錄</span>
              </div>
              {same.recent.length > 0 && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[10px] text-slate-400 hover:text-slate-200">最近 {same.recent.length} 筆</summary>
                  <ul className="mt-1 divide-y divide-slate-800/70">
                    {same.recent.map(a => <Row key={a.id} a={a} lines={lines} showWhere />)}
                  </ul>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
