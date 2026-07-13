'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

interface SoLine {
  line_no: number | null
  description: string | null
  mbp_part: string | null
  duedate: string | null
  order_qty_oru: number | null
  unit_of_measure_oru: string | null
  remark: string | null
  packing: string | null
  remark2: string | null
  hold_status: string | null
}

interface SoOrderMeta {
  project_id: string
  begin_date: string | null
  sales_name: string | null
  partner_name: string | null
  customer_remark: string | null
}

interface Props {
  projectId: string | null
  onClose: () => void
  /** true：按下時即時回 ARGO 撈最新明細（規格/備註/包裝/表頭備註），撈不到才退回同步表。
   *  用於「當天新單／剛更新的單」同步表可能還沒更新的情境（如出單表➜委外請購）。 */
  liveRefresh?: boolean
}

export default function SoOrderModal({ projectId, onClose, liveRefresh = false }: Props) {
  const [meta, setMeta] = useState<SoOrderMeta | null>(null)
  const [lines, setLines] = useState<SoLine[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<'live' | 'synced' | null>(null)

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setMeta(null)
    setLines([])
    setSource(null)

    // 同步表（erp_so_lines）：即時查不到或未啟用即時時的來源
    const loadFromSynced = async (): Promise<boolean> => {
      const { data, error: err } = await supabase
        .from('erp_so_lines')
        .select('project_id, begin_date, sales_name, partner_name, customer_remark, line_no, description, mbp_part, duedate, order_qty_oru, unit_of_measure_oru, remark, packing, remark2, hold_status')
        .eq('project_id', projectId)
        .order('line_no', { ascending: true })
      if (cancelled) return true
      if (err) { setError(err.message); return true }
      if (!data || data.length === 0) return false
      const first = data[0]
      setMeta({
        project_id: first.project_id,
        begin_date: first.begin_date,
        sales_name: first.sales_name,
        partner_name: first.partner_name,
        customer_remark: first.customer_remark ?? null,
      })
      setLines(data.map(r => ({
        line_no: r.line_no,
        description: r.description,
        mbp_part: r.mbp_part,
        duedate: r.duedate,
        order_qty_oru: r.order_qty_oru,
        unit_of_measure_oru: r.unit_of_measure_oru,
        remark: r.remark,
        packing: r.packing,
        remark2: r.remark2,
        hold_status: r.hold_status,
      })))
      setSource('synced')
      return true
    }

    // 即時：回 ARGO 撈單張 SO 明細（query_so_detail）
    const loadFromArgo = async (): Promise<boolean> => {
      try {
        const res = await fetch('/api/argoerp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'query_so_detail', projectId }),
        })
        const j = await res.json()
        if (cancelled) return true
        if (!res.ok || !j?.success || !Array.isArray(j.lines) || j.lines.length === 0) return false
        setMeta({
          project_id: j.meta?.project_id ?? projectId,
          begin_date: j.meta?.begin_date ?? null,
          sales_name: j.meta?.sales_name ?? null,
          partner_name: j.meta?.partner_name ?? null,
          customer_remark: j.meta?.customer_remark ?? null,
        })
        setLines(j.lines as SoLine[])
        setSource('live')
        return true
      } catch {
        return false
      }
    }

    ;(async () => {
      // 即時模式：先試 ARGO，失敗（含無明細）再退回同步表
      const ok = liveRefresh ? (await loadFromArgo() || await loadFromSynced()) : await loadFromSynced()
      if (cancelled) return
      if (!ok) setError('查無明細資料')
      setLoading(false)
    })()

    return () => { cancelled = true }
  }, [projectId, liveRefresh])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!projectId) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-[96vw] max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-slate-800 bg-slate-900/80 rounded-t-xl flex-shrink-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="text-xl font-bold font-mono text-cyan-300 tracking-wide">{projectId}</span>
            {meta?.partner_name && (
              <span className="text-slate-200 text-sm font-medium">{meta.partner_name}</span>
            )}
            {meta?.sales_name && (
              <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400 text-xs">
                業務：{meta.sales_name}
              </span>
            )}
            {meta?.begin_date && (
              <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400 text-xs">
                開立：{meta.begin_date}
              </span>
            )}
            {!loading && !error && lines.length > 0 && (
              <span className="text-slate-600 text-xs">共 {lines.length} 筆</span>
            )}
            {!loading && !error && source === 'live' && (
              <span className="px-2 py-0.5 rounded bg-emerald-900/40 border border-emerald-700/50 text-emerald-300 text-xs">⚡ ARGO 即時</span>
            )}
            {!loading && !error && source === 'synced' && (
              <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400 text-xs">同步資料</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-white transition-colors text-2xl leading-none ml-6 flex-shrink-0 mt-0.5"
            aria-label="關閉"
          >
            ✕
          </button>
        </div>

        {/* 表頭備註 CUSTOMER_REMARK（整張單共用，有值才顯示）*/}
        {meta?.customer_remark && (
          <div className="px-6 py-3 border-b border-slate-800 bg-amber-950/20 flex-shrink-0">
            <span className="text-xs text-amber-500/80 mr-2">表頭備註</span>
            <span className="text-amber-200/90 text-sm whitespace-pre-wrap align-middle">{meta.customer_remark}</span>
          </div>
        )}

        {/* Body */}
        <div className="p-5 overflow-y-auto flex-1">
          {loading && (
            <div className="flex items-center justify-center h-40 text-slate-400 text-sm">讀取中…</div>
          )}
          {error && (
            <div className="flex items-center justify-center h-40 text-red-400 text-sm">⚠ {error}</div>
          )}
          {!loading && !error && lines.length > 0 && (
            <div className="flex flex-col gap-3">
              {lines.map((line, i) => (
                <div
                  key={i}
                  className={`rounded-lg border px-5 py-4 ${
                    line.hold_status
                      ? 'border-red-700/50 bg-red-950/20'
                      : i % 2 === 0
                      ? 'border-slate-700/60 bg-slate-800/40'
                      : 'border-slate-800/60 bg-slate-800/20'
                  }`}
                >
                  {/* Row 1: 序號 + 品項名稱 + 料號 + 狀態 */}
                  <div className="flex flex-wrap items-start gap-x-4 gap-y-1 mb-3">
                    <span className="text-slate-500 font-mono text-sm leading-snug flex-shrink-0 w-7 text-right pt-px">
                      {line.line_no ?? i + 1}
                    </span>
                    <span className="text-slate-100 text-sm font-medium leading-snug flex-1 min-w-[160px]">
                      {line.description || <span className="text-slate-600 font-normal italic">（無品項名稱）</span>}
                    </span>
                    {line.mbp_part && (
                      <span className="font-mono text-slate-400 text-xs bg-slate-900 border border-slate-700 rounded px-2 py-0.5 flex-shrink-0">
                        {line.mbp_part}
                      </span>
                    )}
                    {line.hold_status && (
                      <span className="px-2 py-0.5 rounded text-xs bg-red-900/60 text-red-300 border border-red-700/50 flex-shrink-0">
                        ⛔ {line.hold_status}
                      </span>
                    )}
                  </div>

                  {/* Row 2: 商品備註 + 備註2 + 包裝方式 */}
                  {(line.remark || line.remark2 || line.packing) && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-x-6 gap-y-2 mb-3 pl-11">
                      {line.remark && (
                        <div>
                          <div className="text-xs text-slate-500 mb-0.5">商品備註</div>
                          <div className="text-amber-200/90 text-sm leading-relaxed whitespace-pre-wrap">{line.remark}</div>
                        </div>
                      )}
                      {line.remark2 && (
                        <div>
                          <div className="text-xs text-slate-500 mb-0.5">備註2</div>
                          <div className="text-slate-300 text-sm leading-relaxed whitespace-pre-wrap">{line.remark2}</div>
                        </div>
                      )}
                      {line.packing && (
                        <div>
                          <div className="text-xs text-slate-500 mb-0.5">📦 包裝方式</div>
                          <div className="text-sky-200/90 text-sm leading-relaxed whitespace-pre-wrap">{line.packing}</div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Row 3: 交貨日 + 數量 + 單位 */}
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-1 pl-11 text-sm">
                    {line.duedate && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-500 text-xs">交貨日</span>
                        <span className="text-slate-200 font-mono">{line.duedate}</span>
                      </div>
                    )}
                    {line.order_qty_oru != null && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-500 text-xs">數量</span>
                        <span className="text-slate-100 font-mono font-semibold">
                          {line.order_qty_oru.toLocaleString()}
                        </span>
                        {line.unit_of_measure_oru && (
                          <span className="text-slate-400 text-xs">{line.unit_of_measure_oru}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
