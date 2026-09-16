'use client'

import { useEffect, useState } from 'react'

// 訂單（SO/SOB/SOA/RO）在塔台走到哪一站。
//
// 為什麼可以直接拿訂單號去查「製令」用的 /api/argoerp/mo-route：塔台的批多半掛在
// 訂單層級而非製令層級——sara_wip_records.mo_nbr 取樣 1000 筆裡，RO/SO/SOB 約佔七成，
// MOT 只佔兩成。mo-route 本來就用 mo_nbr/doc_nbr 精準比對，餵訂單號一樣命中，
// 所以這裡不另做 API，直接借用生管出單表在用的那一支。
//
// 與 MoRouteModal 的分工：那支是獨立彈窗、給製令看的完整製程表（含標準途程裡還沒
// 開工的站）；這裡是嵌在訂單詳情裡的摘要，只列塔台真的有紀錄的站，回答「這張單現在
// 走到哪」。訂單沒有單一品號、撈不到標準途程，硬要列未開工的站反而是雜訊。

interface Step {
  sequence: number | null
  station: string | null
  opName: string | null
  requiredQty: number | null
  reportedQty: number
  resources: string[]
  reported: boolean
  statuses: string[]
  firstStart: string | null
  lastEnd: string | null
}

interface Lot {
  lotNbr: string | null
  productName: string | null
  qty: number | null
  progressPercentage: number | null
  steps: Step[]
}

interface Payload {
  status: string
  error?: string
  source: 'sara_live' | 'db_fallback'
  saraError?: string
  lots: Lot[]
  totals: { lotCount: number; stepCount: number; reportedStepCount: number }
}

const nf = (n: number | null | undefined) =>
  n == null ? '—' : (Number.isInteger(n) ? n : Number(n.toFixed(2))).toLocaleString()

const fmtTime = (s: string | null) => {
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

// 站點狀態：沿用 MoRouteModal 的語彙與配色，兩邊看起來才像同一個系統
const stepState = (s: Step) => {
  if (s.statuses.includes('running')) return { label: '進行中', cls: 'bg-sky-900/40 text-sky-300 border-sky-700/50' }
  if (s.statuses.includes('pause')) return { label: '暫停', cls: 'bg-amber-900/40 text-amber-300 border-amber-700/50' }
  if (s.statuses.includes('finished')) return { label: '已完工', cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' }
  if (s.reported) return { label: '有報工', cls: 'bg-slate-800 text-slate-300 border-slate-700' }
  return { label: '未開工', cls: 'bg-slate-800 text-slate-500 border-slate-700' }
}

export default function SoSaraProgress({ projectId }: { projectId: string | null }) {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!projectId) return
    // cancelled：連開好幾張單時，舊請求回來不要蓋掉新的
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    const load = async () => {
      try {
        const r = await fetch(`/api/argoerp/mo-route?mo=${encodeURIComponent(projectId)}`)
        const j = (await r.json()) as Payload
        if (cancelled) return
        if (!r.ok || j.status !== 'ok') setError(j.error || `讀取失敗 (HTTP ${r.status})`)
        else setData(j)
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [projectId])

  if (!projectId) return null
  const lots = data?.lots ?? []
  const totals = data?.totals

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-300">🏭 塔台生產進度</span>
        {data?.source === 'sara_live' && (
          <span
            className="rounded border border-emerald-700/50 bg-emerald-950/40 px-2 py-0.5 text-[11px] text-emerald-300"
            title="直接讀取塔台即時資料"
          >塔台即時</span>
        )}
        {data?.source === 'db_fallback' && (
          <span
            className="rounded border border-amber-700/50 bg-amber-950/40 px-2 py-0.5 text-[11px] text-amber-300"
            title={data.saraError || '塔台未連線，改用資料庫的報工快照（可能非最新）'}
          >⚠ 快照資料</span>
        )}
        {!loading && !error && totals && lots.length > 0 && (
          <span className="text-xs text-slate-500">
            {totals.stepCount} 道製程・已報工 {totals.reportedStepCount} 站
            {totals.lotCount > 1 && `・${totals.lotCount} 個批次`}
          </span>
        )}
      </div>

      {loading && <div className="py-6 text-center text-sm text-slate-500">讀取塔台進度中…</div>}
      {error && <div className="py-6 text-center text-sm text-red-400">⚠ {error}</div>}

      {/* 查無不是錯誤：純接單、委外不報工、尚未上線的單本來就沒有報工紀錄 */}
      {!loading && !error && lots.length === 0 && (
        <div className="py-5 text-center text-sm text-slate-500">
          塔台查無這張訂單的報工紀錄
          <div className="mt-1 text-xs text-slate-600">可能尚未開工、屬委外不報工，或已結案從塔台移除</div>
        </div>
      )}

      {!loading && !error && lots.map((lot, li) => (
        <div key={li} className={li > 0 ? 'mt-5 border-t border-slate-800 pt-4' : ''}>
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            {lot.lotNbr && (
              <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-300">批 #{lot.lotNbr}</span>
            )}
            {lot.productName && <span className="text-sm text-slate-200">{lot.productName}</span>}
            {lot.qty != null && (
              <span className="rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-300">數量 {nf(lot.qty)}</span>
            )}
            {lot.progressPercentage != null && (
              <span className="ml-auto flex items-center gap-2">
                <span className="h-1.5 w-24 overflow-hidden rounded bg-slate-800">
                  <span className="block h-full bg-emerald-500/70" style={{ width: `${Math.min(100, lot.progressPercentage)}%` }} />
                </span>
                <span className={`font-mono text-sm ${lot.progressPercentage >= 100 ? 'text-emerald-300' : 'text-slate-200'}`}>
                  {lot.progressPercentage}%
                </span>
              </span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-500">
                  <th className="w-8 py-1.5 pr-2 text-left font-normal">序</th>
                  <th className="py-1.5 pr-3 text-left font-normal">站點</th>
                  <th className="py-1.5 pr-3 text-left font-normal">工序</th>
                  <th className="w-24 py-1.5 pr-3 text-right font-normal">已報工</th>
                  <th className="w-20 py-1.5 text-center font-normal">狀態</th>
                </tr>
              </thead>
              <tbody>
                {lot.steps.map((s, i) => {
                  const st = stepState(s)
                  const t = fmtTime(s.lastEnd) ?? fmtTime(s.firstStart)
                  return (
                    <tr key={i} className="border-b border-slate-800/60 last:border-0">
                      <td className="py-1.5 pr-2 align-top font-mono text-xs text-slate-500">{s.sequence ?? '—'}</td>
                      <td className="py-1.5 pr-3 align-top">
                        <span className={s.reported ? 'text-slate-100' : 'text-slate-500'}>{s.station || '—'}</span>
                      </td>
                      <td className="py-1.5 pr-3 align-top">
                        <div className={s.reported ? 'text-slate-300' : 'text-slate-600'}>{s.opName || '—'}</div>
                        {s.resources.length > 0 && (
                          <div className="mt-0.5 text-xs text-slate-500">{s.resources.join('、')}</div>
                        )}
                        {t && <div className="mt-0.5 text-[11px] text-slate-600">最後報工 {t}</div>}
                      </td>
                      <td className={`py-1.5 pr-3 text-right align-top font-mono font-semibold ${s.reportedQty > 0 ? 'text-emerald-300' : 'text-slate-600'}`}>
                        {nf(s.reportedQty)}
                      </td>
                      <td className="py-1.5 text-center align-top">
                        <span className={`whitespace-nowrap rounded border px-2 py-0.5 text-[11px] ${st.cls}`}>{st.label}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}
