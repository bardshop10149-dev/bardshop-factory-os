'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'

interface PoLine {
  sub_no: string
  item_code: string | null
  description: string | null
  qty: number | null
  unit: string | null
  status: string | null
  start_date: string | null
  end_date: string | null
  remark: string | null
  extra: Record<string, unknown> | null
}

interface Props {
  docNo: string | null
  onClose: () => void
}

export default function PoOrderModal({ docNo, onClose }: Props) {
  const [lines, setLines] = useState<PoLine[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!docNo) return
    setLoading(true)
    setError(null)
    setLines([])
    supabase
      .from('erp_pj_sync')
      .select('sub_no, item_code, description, qty, unit, status, start_date, end_date, customer_vendor, remark, extra')
      .eq('doc_no', docNo)
      .order('sub_no', { ascending: true })
      .then(({ data, error: err }) => {
        setLoading(false)
        if (err) { setError(err.message); return }
        const label = docNo.toUpperCase().startsWith('MPO') ? '請購單' : '採購單'
        if (!data || data.length === 0) { setError(`查無${label}明細`); return }
        setLines(data as PoLine[])
      })
  }, [docNo])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!docNo) return null

  const first = lines[0]
  const isPr = docNo.toUpperCase().startsWith('MPO')
  const typeLabel = isPr ? '請購單' : '採購單'
  const vendor = first?.extra?.['TPN_PARTNER_ID'] as string | undefined
  const currency = first?.extra?.['CURRENCY'] as string | undefined
  const paymentTerm = first?.extra?.['PAYMENT_TERM'] as string | undefined
  const soProjectId = first?.extra?.['SO_PROJECT_ID'] as string | undefined

  const statusColor = (s: string | null) => {
    if (s === 'OPEN') return 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50'
    if (s === 'UNSIGNED') return 'bg-amber-900/40 text-amber-300 border-amber-700/50'
    if (s === 'CLOSE') return 'bg-slate-800 text-slate-500 border-slate-700'
    if (s === 'HOLD') return 'bg-red-900/40 text-red-300 border-red-700/50'
    return 'bg-slate-800 text-slate-400 border-slate-700'
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b border-slate-800 bg-slate-900/80 rounded-t-xl flex-shrink-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="text-slate-400 text-xs font-mono uppercase tracking-widest">{typeLabel}</span>
            <span className="text-xl font-bold font-mono text-purple-300 tracking-wide">{docNo}</span>
            {vendor && (
              <span className="text-slate-200 text-sm font-medium">{vendor}</span>
            )}
            {first?.status && (
              <span className={`px-2 py-0.5 rounded border text-xs font-mono ${statusColor(first.status)}`}>
                {first.status}
              </span>
            )}
            {soProjectId && (
              <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-cyan-400/80 text-xs font-mono">
                SO: {soProjectId}
              </span>
            )}
            {first?.start_date && (
              <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400 text-xs">
                開立：{first.start_date}
              </span>
            )}
            {currency && (
              <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400 text-xs">
                {currency}{paymentTerm ? ` / ${paymentTerm}` : ''}
              </span>
            )}
            {!loading && !error && lines.length > 0 && (
              <span className="text-slate-600 text-xs">共 {lines.length} 筆</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-white transition-colors text-2xl leading-none ml-6 flex-shrink-0 mt-0.5"
            aria-label="關閉"
          >✕</button>
        </div>

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
              {lines.map((line, i) => {
                const tpnPartNo = line.extra?.['TPN_PART_NO'] as string | undefined
                const mbpLotNo = line.extra?.['MBP_LOT_NO'] as string | undefined
                const unitPrice = line.extra?.['UNIT_PRICE_ORU'] as number | undefined
                const packing = line.extra?.['PACKING'] as string | undefined
                return (
                  <div
                    key={i}
                    className="rounded-lg border border-slate-700/60 bg-slate-800/40 px-5 py-4"
                  >
                    {/* Row 1: sub_no + 料號 + 品名 + 狀態 */}
                    <div className="flex flex-wrap items-start gap-x-4 gap-y-1 mb-3">
                      <span className="text-slate-500 font-mono text-sm leading-snug flex-shrink-0 w-7 text-right pt-px">
                        #{line.sub_no}
                      </span>
                      {line.item_code && (
                        <span className="font-mono text-purple-300 text-sm bg-slate-900 border border-slate-700 rounded px-2 py-0.5 flex-shrink-0">
                          {line.item_code}
                        </span>
                      )}
                      {line.description && (
                        <span className="text-slate-100 text-sm font-medium leading-snug flex-1 min-w-[160px]">
                          {line.description}
                        </span>
                      )}
                      {line.status && (
                        <span className={`px-2 py-0.5 rounded border text-xs font-mono flex-shrink-0 ${statusColor(line.status)}`}>
                          {line.status}
                        </span>
                      )}
                    </div>

                    {/* Row 2: 備註 + 包裝 */}
                    {(line.remark || packing) && (
                      <div className="flex flex-wrap gap-x-6 gap-y-2 mb-3 pl-11">
                        {line.remark && (
                          <div>
                            <div className="text-xs text-slate-500 mb-0.5">備註</div>
                            <div className="text-amber-200/90 text-sm whitespace-pre-wrap">{line.remark}</div>
                          </div>
                        )}
                        {packing && (
                          <div>
                            <div className="text-xs text-slate-500 mb-0.5">📦 包裝</div>
                            <div className="text-sky-200/90 text-sm">{packing}</div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Row 3: 交期 + 數量 + 單價 + 批號/行號 */}
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 pl-11 text-sm">
                      {line.end_date && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-500 text-xs">交期</span>
                          <span className="text-slate-200 font-mono">{line.end_date}</span>
                        </div>
                      )}
                      {line.qty != null && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-500 text-xs">數量</span>
                          <span className="text-slate-100 font-mono font-semibold">{line.qty.toLocaleString()}</span>
                          {line.unit && <span className="text-slate-500 text-xs">{line.unit}</span>}
                        </div>
                      )}
                      {unitPrice != null && unitPrice !== 0 && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-500 text-xs">單價</span>
                          <span className="text-emerald-300 font-mono">{unitPrice}</span>
                        </div>
                      )}
                      {mbpLotNo && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-500 text-xs">批號</span>
                          <span className="font-mono text-cyan-300/80 text-xs">{mbpLotNo}</span>
                        </div>
                      )}
                      {tpnPartNo && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-slate-500 text-xs">行號</span>
                          <span className="font-mono text-slate-300 text-xs">{tpnPartNo}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
