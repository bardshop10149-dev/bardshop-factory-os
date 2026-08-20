'use client'

import { useEffect, useState } from 'react'

// 製令(MOT) → 塔台所有製程與各站報工量。
// 資料走 /api/argoerp/mo-route（後端 service-role + 塔台 session），不從前端直連。

interface Step {
  sequence: number | null
  station: string | null
  opName: string | null
  requiredQty: number | null
  reportedQty: number
  remainingQty: number | null
  resources: string[]
  note: string | null
  sourcing: string | null
  reported: boolean
  inStandardRoute: boolean
  statuses: string[]
  firstStart: string | null
  lastEnd: string | null
}

interface Lot {
  lotId: number | null
  lotNbr: string | null
  docNbr: string | null
  productName: string | null
  productDesc: string | null
  customerName: string | null
  qty: number | null
  progressPercentage: number | null
  healthState: string | null
  actionState: string | null
  achState: string | null
  warningState: unknown
  steps: Step[]
}

interface Payload {
  status: string
  error?: string
  source: 'sara_live' | 'db_fallback'
  saraError?: string
  mo: string
  matchedBy: 'mo' | 'source_order' | null
  erpInfo: {
    itemCode: string | null
    orderQty: number
    holdStatus: string | null
    beginDate: string | null
    endDate: string | null
    sourceOrder: string | null
    routeId?: string | null
  }
  receipt?: {
    state: 'completed' | 'partial' | 'none' | 'unknown'
    orderQty: number
    actualQty: number
    rejectQty: number
    lastUpdate: string | null
    error: string | null
  }
  lots: Lot[]
  totals: { lotCount: number; stepCount: number; reportedStepCount: number }
}

interface Props {
  moNumber: string | null
  onClose: () => void
}

const nf = (n: number | null | undefined) =>
  n == null ? '—' : (Number.isInteger(n) ? n : Number(n.toFixed(2))).toLocaleString()

const fmtTime = (s: string | null) => {
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
}

// 依報工/剩餘判斷該站狀態。
// noLiveRecord：製令已繳庫完工、塔台也已結案移除現場紀錄 —— 這時 0 報工代表
// 「紀錄已不存在」，不是「還沒做」，標成未開工會誤導現場。
const stepState = (s: Step, noLiveRecord = false) => {
  if (noLiveRecord && s.reportedQty <= 0) {
    return { label: '無現場紀錄', cls: 'bg-slate-800 text-slate-500 border-slate-700' }
  }
  const req = s.requiredQty
  if (req != null && req > 0) {
    if (s.reportedQty >= req) return { label: '已完成', cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' }
    if (s.reportedQty > 0) return { label: '進行中', cls: 'bg-sky-900/40 text-sky-300 border-sky-700/50' }
    return { label: '未開工', cls: 'bg-slate-800 text-slate-500 border-slate-700' }
  }
  if (s.statuses.includes('running')) return { label: '進行中', cls: 'bg-sky-900/40 text-sky-300 border-sky-700/50' }
  if (s.statuses.includes('pause')) return { label: '暫停', cls: 'bg-amber-900/40 text-amber-300 border-amber-700/50' }
  if (s.statuses.includes('finished')) return { label: '已完工', cls: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' }
  if (s.reported) return { label: '有報工', cls: 'bg-slate-800 text-slate-300 border-slate-700' }
  return { label: '未開工', cls: 'bg-slate-800 text-slate-500 border-slate-700' }
}

/**
 * 取製令的塔台製程資料。
 * 抽成 hook，讓「出單表的製令視窗」與「業務查詢的製令明細」共用同一份
 * 取數與競態處理，不要各寫一份。
 */
export function useMoRoute(moNumber: string | null) {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!moNumber) return
    // cancelled 旗標：連續開關不同製令時，舊請求回來不覆蓋新結果
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      setData(null)
      try {
        const r = await fetch(`/api/argoerp/mo-route?mo=${encodeURIComponent(moNumber)}`)
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
  }, [moNumber])

  return { data, loading, error }
}

/**
 * 製程表本體（不含彈窗外框），供彈窗與嵌入式（業務查詢的製令明細）共用。
 * 純呈現：資料一律由外部以 useMoRoute 取得後傳入。
 */
export function MoRouteBody({
  data,
  loading,
  error,
  className,
}: {
  data: Payload | null
  loading: boolean
  error: string | null
  /** 預設是彈窗內的捲動容器；嵌入時可覆寫成不佔滿高度的樣式 */
  className?: string
}) {
  const lots = data?.lots ?? []
  const receipt = data?.receipt
  const done = receipt?.state === 'completed'
  // 已完工繳庫、但畫面資料是備援快照 → 塔台已結案移除現場紀錄
  const noLiveRecord = done && data?.source === 'db_fallback'

  return (
    <div className={className ?? 'p-5 overflow-y-auto flex-1'}>
      {!loading && !error && receipt && receipt.state !== 'unknown' && (
        <div
          className={`mb-4 rounded-lg border px-4 py-3 ${
            done
              ? 'bg-emerald-950/30 border-emerald-800/60'
              : receipt.state === 'partial'
                ? 'bg-sky-950/30 border-sky-800/60'
                : 'bg-slate-800/40 border-slate-700'
          }`}
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className={`text-sm font-semibold ${done ? 'text-emerald-300' : receipt.state === 'partial' ? 'text-sky-300' : 'text-slate-300'}`}>
              {done ? '✅ 此製令已完工繳庫' : receipt.state === 'partial' ? '繳庫進行中' : '尚未繳庫'}
            </span>
            <span className="font-mono text-base text-slate-100">
              {nf(receipt.actualQty)} <span className="text-slate-500">/</span> {nf(receipt.orderQty)}
            </span>
            {receipt.rejectQty > 0 && (
              <span className="text-xs text-amber-400">不良 {nf(receipt.rejectQty)}</span>
            )}
            {receipt.lastUpdate && (
              <span className="text-xs text-slate-500">
                {/* ARGO 有時只回日期不含時分，硬套時間格式會顯示成 00:00 而誤導 */}
                ARGO 更新於 {receipt.lastUpdate.includes(':') ? (fmtTime(receipt.lastUpdate) ?? receipt.lastUpdate) : receipt.lastUpdate}
              </span>
            )}
          </div>
          {noLiveRecord && (
            <div className="mt-1.5 text-xs text-slate-400">
              塔台已結案並移除此單的現場紀錄，下方為<b className="text-slate-300">標準途程</b>，不代表各站的實際報工狀況。
            </div>
          )}
        </div>
      )}

      {loading && <div className="flex items-center justify-center h-40 text-slate-400 text-sm">讀取塔台製程中…</div>}
      {error && <div className="flex items-center justify-center h-40 text-red-400 text-sm">⚠ {error}</div>}

      {!loading && !error && data && lots.length === 0 && (
        <div className="flex flex-col items-center justify-center h-40 text-slate-400 text-sm gap-2">
          <div>{done ? '塔台已無此製令的現場紀錄（已結案移除）' : '塔台查無此製令的製程'}</div>
          <div className="text-xs text-slate-500">
            {data.erpInfo?.itemCode
              ? done
                ? `品號 ${data.erpInfo.itemCode}｜此單已完工繳庫，屬正常情形`
                : `品號 ${data.erpInfo.itemCode}｜可能尚未匯入塔台或已結案移除`
              : '找不到此製令'}
          </div>
          {data.saraError && <div className="text-xs text-amber-500/80 max-w-lg text-center">塔台連線問題：{data.saraError}</div>}
        </div>
      )}

      {!loading && !error && lots.map((lot, li) => (
        <div key={li} className={li > 0 ? 'mt-6 pt-5 border-t border-slate-800' : ''}>
          {/* 批次摘要 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-3">
            {lot.lotNbr && (
              <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 text-xs">批 #{lot.lotNbr}</span>
            )}
            {lot.productName && <span className="text-slate-200 text-sm font-medium">{lot.productName}</span>}
            {lot.qty != null && (
              <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 text-xs">數量 {nf(lot.qty)}</span>
            )}
            {lot.customerName && <span className="text-slate-500 text-xs">{lot.customerName}</span>}
            {lot.progressPercentage != null && (
              <span className="ml-auto flex items-center gap-2">
                <span className="text-slate-500 text-xs">進度</span>
                <span className="w-28 h-1.5 rounded bg-slate-800 overflow-hidden">
                  <span className="block h-full bg-emerald-500/70" style={{ width: `${Math.min(100, lot.progressPercentage)}%` }} />
                </span>
                <span className={`font-mono text-sm ${lot.progressPercentage >= 100 ? 'text-emerald-300' : 'text-slate-200'}`}>
                  {lot.progressPercentage}%
                </span>
              </span>
            )}
          </div>

          {lot.productDesc && (
            <div className="text-slate-400 text-xs mb-3">{lot.productDesc}</div>
          )}

          {/* 製程表 */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-500 text-xs border-b border-slate-800">
                  <th className="text-left font-normal py-2 pr-2 w-10">序</th>
                  <th className="text-left font-normal py-2 pr-3">站點</th>
                  <th className="text-left font-normal py-2 pr-3">工序</th>
                  <th className="text-right font-normal py-2 pr-3 w-20">應做</th>
                  <th className="text-right font-normal py-2 pr-3 w-24">已報工</th>
                  <th className="text-right font-normal py-2 pr-3 w-20">剩餘</th>
                  <th className="text-center font-normal py-2 w-20">狀態</th>
                </tr>
              </thead>
              <tbody>
                {lot.steps.map((s, i) => {
                  const st = stepState(s, noLiveRecord)
                  const done = s.requiredQty != null && s.requiredQty > 0 && s.reportedQty >= s.requiredQty
                  const timeInfo = fmtTime(s.lastEnd)
                  return (
                    <tr key={i} className="border-b border-slate-800/60 last:border-0">
                      <td className="py-2 pr-2 text-slate-500 font-mono text-xs align-top">{s.sequence ?? '—'}</td>
                      <td className="py-2 pr-3 align-top">
                        <span className={s.reported ? 'text-slate-100' : 'text-slate-500'}>{s.station || '—'}</span>
                        {s.sourcing && s.sourcing !== 'in_house' && (
                          <span className="ml-1.5 px-1 py-0.5 rounded border border-sky-700/50 bg-sky-950/40 text-sky-300 text-[10px]">委外</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 align-top">
                        <div className={s.reported ? 'text-slate-300' : 'text-slate-600'}>{s.opName || '—'}</div>
                        {s.resources.length > 0 && (
                          <div className="text-slate-500 text-xs mt-0.5">{s.resources.join('、')}</div>
                        )}
                        {s.note && <div className="text-amber-200/70 text-xs mt-0.5">{s.note}</div>}
                        {timeInfo && <div className="text-slate-600 text-[11px] mt-0.5">最後報工 {timeInfo}</div>}
                      </td>
                      <td className="py-2 pr-3 text-right font-mono text-slate-400 align-top">{nf(s.requiredQty)}</td>
                      <td className={`py-2 pr-3 text-right font-mono font-semibold align-top ${s.reportedQty > 0 ? 'text-emerald-300' : 'text-slate-600'}`}>
                        {nf(s.reportedQty)}
                      </td>
                      <td className={`py-2 pr-3 text-right font-mono align-top ${done ? 'text-slate-600' : 'text-amber-300'}`}>
                        {nf(s.remainingQty)}
                      </td>
                      <td className="py-2 text-center align-top">
                        <span className={`px-2 py-0.5 rounded border text-[11px] whitespace-nowrap ${st.cls}`}>{st.label}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {!loading && !error && data && lots.length > 0 && (
        <div className="mt-4 pt-3 border-t border-slate-800 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
          <span>共 {data.totals.stepCount} 道製程</span>
          <span className="text-emerald-400">已報工 {data.totals.reportedStepCount} 站</span>
          {data.totals.lotCount > 1 && <span>{data.totals.lotCount} 個批次</span>}
          {data.erpInfo?.sourceOrder && <span>來源訂單 {data.erpInfo.sourceOrder}</span>}
        </div>
      )}
    </div>
  )
}

export default function MoRouteModal({ moNumber, onClose }: Props) {
  const { data, loading, error } = useMoRoute(moNumber)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!moNumber) return null
  const receipt = data?.receipt
  const done = receipt?.state === 'completed'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-6 overflow-y-auto" onClick={onClose}>
      <div
        className="w-full max-w-4xl rounded-xl border border-slate-700 bg-slate-900 shadow-2xl flex flex-col max-h-[88vh] mt-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-700/70 flex-shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">製令</span>
            <span className="font-mono text-violet-300 text-lg font-semibold">{moNumber}</span>
            {data?.erpInfo?.itemCode && (
              <span className="font-mono text-purple-300 text-sm bg-slate-800 border border-slate-700 rounded px-2 py-0.5">
                {data.erpInfo.itemCode}
              </span>
            )}
            {data?.source === 'sara_live' && (
              <span className="px-2 py-0.5 rounded bg-emerald-950/40 border border-emerald-700/50 text-emerald-300 text-[11px]" title="直接讀取塔台即時資料">
                塔台即時
              </span>
            )}
            {data?.source === 'db_fallback' && (
              <span className="px-2 py-0.5 rounded bg-amber-950/40 border border-amber-700/50 text-amber-300 text-[11px]" title={data.saraError || '塔台未連線，改用資料庫的報工快照（可能非最新）'}>
                ⚠ 快照資料
              </span>
            )}
            {done && (
              <span
                className="px-2 py-0.5 rounded bg-emerald-900/50 border border-emerald-600/60 text-emerald-300 text-[11px] font-medium"
                title={`ARGO 繳庫 ${receipt?.actualQty} / ${receipt?.orderQty}`}
              >
                ✅ 已完工
              </span>
            )}
            {data?.matchedBy === 'source_order' && (
              <span className="px-2 py-0.5 rounded bg-amber-950/40 border border-amber-700/50 text-amber-300 text-[11px]" title="塔台這批掛在訂單層級，非製令號">
                以訂單號對應
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-white transition-colors text-2xl leading-none ml-6 flex-shrink-0"
            aria-label="關閉"
          >✕</button>
        </div>

        <MoRouteBody data={data} loading={loading} error={error} />
      </div>
    </div>
  )
}
