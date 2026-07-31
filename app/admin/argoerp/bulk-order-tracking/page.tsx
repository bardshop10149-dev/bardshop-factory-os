'use client'

import { useState, useCallback, useEffect } from 'react'
import { supabase } from '../../../../lib/supabaseClient'
import SoOrderModal from '../../../../components/SoOrderModal'

// ── 型別 ─────────────────────────────────────────────────────────────────────
interface BulkRow {
  sheet_date: string
  row_key?: string
  order_number: string
  doc_type?: string
  factory: string
  customer?: string
  item_code?: string
  item_name?: string
  note?: string
  packing?: string
  quantity: string
  delivery_date: string
  mo_status?: string | null
  mo_number?: string | null
  match_line_no?: string | null
  material_prep_status?: string | null
  po_number?: string | null
  pr_number?: string | null
  argo_slip_no?: string | null
  machine?: string | null
  designer?: string | null
  handler?: string | null
}

interface MoLine {
  line_no: string
  mbp_part: string | null
  mbp_lot_no: string | null
  order_qty: number | null
  begin_date: string | null
  end_date: string | null
  hold_status: string | null
  source_order: string | null
}

// ── helpers ───────────────────────────────────────────────────────────────────
function normDate(d: unknown): string {
  if (!d) return ''
  const s = String(d).split(/[ T]/)[0].replace(/\//g, '-').split('-')
  if (s.length !== 3) return ''
  return `${s[0]}-${s[1].padStart(2, '0')}-${s[2].padStart(2, '0')}`
}

function parseQty(q: unknown): number {
  return parseFloat(String(q ?? '0').replace(/,/g, '')) || 0
}

function factoryBadge(f: string) {
  if (f === 'T') return 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50'
  if (f === 'C') return 'bg-orange-900/40 text-orange-300 border-orange-700/50'
  if (f === 'O') return 'bg-fuchsia-900/40 text-fuchsia-300 border-fuchsia-700/50'
  return 'bg-slate-800 text-slate-400 border-slate-700'
}

function factoryLabel(f: string) {
  if (f === 'T') return '台北'
  if (f === 'C') return '常平'
  if (f === 'O') return '委外'
  return f || '?'
}

function moChip(s: string | null | undefined) {
  if (s === '已匯入製令') return 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50'
  return 'bg-slate-800/60 text-slate-400 border-slate-700'
}

function prepChip(s: string | null | undefined) {
  if (s === '已備料' || s === '無需備料' || s === '已批備料')
    return 'bg-sky-900/40 text-sky-300 border-sky-700/50'
  return 'bg-amber-900/40 text-amber-300 border-amber-700/50'
}

// ── MO 詳細 Modal ─────────────────────────────────────────────────────────────
function MoDetailModal({ moNumber, onClose }: { moNumber: string; onClose: () => void }) {
  const [lines, setLines]   = useState<MoLine[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr]        = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true); setErr(null); setLines([])

    supabase
      .from('erp_mo_lines')
      .select('line_no, mbp_part, mbp_lot_no, order_qty, begin_date, end_date, hold_status, source_order')
      .eq('project_id', moNumber)
      .order('line_no', { ascending: true })
      .then(({ data, error }) => {
        if (cancelled) return
        setLoading(false)
        if (error) { setErr(error.message); return }
        if (!data || data.length === 0) { setErr('ARGO 同步表查無此製令（可能尚未同步）'); return }
        setLines(
          [...(data as MoLine[])].sort((a, b) =>
            a.line_no.localeCompare(b.line_no, undefined, { numeric: true })
          )
        )
      })
    return () => { cancelled = true }
  }, [moNumber])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const holdStatus = lines[0]?.hold_status ?? null
  const holdBadge =
    holdStatus === 'OPEN'     ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' :
    holdStatus === 'CLOSE'    ? 'bg-slate-800 text-slate-500 border-slate-700' :
    holdStatus === 'HOLD'     ? 'bg-red-900/40 text-red-300 border-red-700/50' :
    holdStatus                ? 'bg-amber-900/40 text-amber-300 border-amber-700/50' : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700 flex-shrink-0">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-slate-400 text-sm">製令工單</span>
            <span className="font-mono text-violet-300 font-semibold text-lg">{moNumber}</span>
            {holdBadge && holdStatus && (
              <span className={`px-2 py-0.5 text-xs rounded border ${holdBadge}`}>{holdStatus}</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors text-lg leading-none ml-4"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <p className="text-slate-400 text-sm text-center py-10">載入中…</p>
          )}
          {err && (
            <p className="text-red-400 text-sm text-center py-10">{err}</p>
          )}
          {!loading && !err && lines.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-400 text-xs border-b border-slate-700">
                  <th className="text-left py-2 pr-4 font-medium">序號</th>
                  <th className="text-left py-2 pr-4 font-medium">料號</th>
                  <th className="text-left py-2 pr-4 font-medium">批號</th>
                  <th className="text-right py-2 pr-4 font-medium">數量</th>
                  <th className="text-left py-2 pr-4 font-medium">開始日</th>
                  <th className="text-left py-2 pr-4 font-medium">結束日</th>
                  <th className="text-left py-2 font-medium">來源 SO</th>
                </tr>
              </thead>
              <tbody>
                {lines.map(l => (
                  <tr key={l.line_no} className="border-b border-slate-800 hover:bg-slate-800/50 transition-colors">
                    <td className="py-2 pr-4 font-mono text-slate-300">{l.line_no}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-cyan-400">{l.mbp_part ?? '—'}</td>
                    <td className="py-2 pr-4 text-slate-400 text-xs">{l.mbp_lot_no ?? '—'}</td>
                    <td className="py-2 pr-4 text-right font-semibold text-amber-300">
                      {l.order_qty != null ? l.order_qty.toLocaleString() : '—'}
                    </td>
                    <td className="py-2 pr-4 text-slate-400 text-xs whitespace-nowrap">
                      {l.begin_date ? normDate(l.begin_date) : '—'}
                    </td>
                    <td className="py-2 pr-4 text-slate-400 text-xs whitespace-nowrap">
                      {l.end_date ? normDate(l.end_date) : '—'}
                    </td>
                    <td className="py-2 text-slate-400 text-xs">{l.source_order ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 主頁 ──────────────────────────────────────────────────────────────────────
export default function BulkOrderTrackingPage() {
  // 預設交期區間：今天 ~ +60 天
  const todayStr  = new Date().toISOString().slice(0, 10)
  const futureStr = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10)

  const [deliveryFrom, setDeliveryFrom] = useState(todayStr)
  const [deliveryTo,   setDeliveryTo]   = useState(futureStr)
  const [minQty,       setMinQty]       = useState('1000')
  const [rows,         setRows]         = useState<BulkRow[]>([])
  const [loading,      setLoading]      = useState(false)
  const [errMsg,       setErrMsg]       = useState('')
  const [queried,      setQueried]      = useState(false)

  // Modals
  const [soModal, setSoModal] = useState<string | null>(null)
  const [moModal, setMoModal] = useState<string | null>(null)

  const handleQuery = useCallback(async () => {
    setLoading(true)
    setErrMsg('')
    setQueried(false)
    setRows([])
    try {
      const params = new URLSearchParams()
      if (deliveryFrom) params.set('delivery_from', deliveryFrom)
      if (deliveryTo)   params.set('delivery_to',   deliveryTo)
      if (minQty)       params.set('min_qty',        minQty)
      const res  = await fetch(`/api/argoerp/bulk-orders?${params}`)
      const json = await res.json() as { success: boolean; rows?: BulkRow[]; error?: string }
      if (!json.success) throw new Error(json.error ?? `HTTP ${res.status}`)
      setRows(json.rows ?? [])
      setQueried(true)
    } catch (e) {
      setErrMsg(`查詢失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [deliveryFrom, deliveryTo, minQty])

  const totalQty = rows.reduce((sum, r) => sum + parseQty(r.quantity), 0)

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="max-w-[1400px] mx-auto">

        {/* ── 標題 ── */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-cyan-300">大量訂單追蹤</h1>
          <p className="text-slate-400 text-sm mt-1">
            篩選每日出單表中數量超過指定門檻的訂單，依交期區間查詢
          </p>
        </div>

        {/* ── 篩選列 ── */}
        <div className="bg-slate-900 border border-slate-700 rounded-xl p-5 mb-6 flex flex-wrap items-end gap-5">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-400">交期從</label>
            <input
              type="date"
              value={deliveryFrom}
              onChange={e => setDeliveryFrom(e.target.value)}
              className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100
                         focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-400">交期至</label>
            <input
              type="date"
              value={deliveryTo}
              onChange={e => setDeliveryTo(e.target.value)}
              className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100
                         focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-400">最小數量（PCS）</label>
            <input
              type="number"
              min="1"
              value={minQty}
              onChange={e => setMinQty(e.target.value)}
              className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 w-36
                         focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500/30"
            />
          </div>
          <button
            onClick={() => void handleQuery()}
            disabled={loading}
            className="px-6 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50
                       text-white font-semibold text-sm transition-colors"
          >
            {loading ? '查詢中…' : '🔍 查詢'}
          </button>
        </div>

        {errMsg && (
          <div className="text-red-400 text-sm mb-4 bg-red-900/20 border border-red-800/40 rounded-lg px-4 py-3">
            {errMsg}
          </div>
        )}

        {/* ── 統計列 ── */}
        {queried && (
          <div className="mb-4 flex flex-wrap items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="text-slate-400 text-sm">符合條件</span>
              <span className="font-bold text-cyan-300 text-lg">{rows.length}</span>
              <span className="text-slate-400 text-sm">筆</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-slate-400 text-sm">合計數量</span>
              <span className="font-bold text-amber-300 text-lg">{totalQty.toLocaleString()}</span>
              <span className="text-slate-400 text-sm">PCS</span>
            </div>
            {rows.length > 0 && (
              <div className="flex items-center gap-3 ml-auto">
                <span className="text-xs text-slate-500">
                  台北 {rows.filter(r => r.factory === 'T').length} 筆 ／
                  常平 {rows.filter(r => r.factory === 'C').length} 筆 ／
                  委外 {rows.filter(r => r.factory === 'O').length} 筆
                </span>
              </div>
            )}
          </div>
        )}

        {/* ── 空結果 ── */}
        {queried && rows.length === 0 && (
          <div className="text-slate-400 text-center py-16 bg-slate-900 border border-slate-800 rounded-xl">
            查無符合條件的訂單
          </div>
        )}

        {/* ── 資料表格 ── */}
        {rows.length > 0 && (
          <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800/70 text-slate-400 text-xs border-b border-slate-700">
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">#</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">出單日</th>
                    <th className="text-left px-3 py-3 font-medium">廠</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">銷售訂單</th>
                    <th className="text-left px-3 py-3 font-medium">料號</th>
                    <th className="text-left px-3 py-3 font-medium">品名</th>
                    <th className="text-left px-3 py-3 font-medium">規格／備註</th>
                    <th className="text-right px-3 py-3 font-medium">數量</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">交期</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">製令單號</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">製令狀態</th>
                    <th className="text-left px-3 py-3 font-medium">備料</th>
                    <th className="text-left px-3 py-3 font-medium">客戶</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const qty      = parseQty(r.quantity)
                    const qtyColor =
                      qty >= 5000 ? 'text-red-400 font-bold' :
                      qty >= 2000 ? 'text-amber-300 font-semibold' :
                      'text-slate-200'
                    // 交期色：逾期 = 紅色
                    const delivNorm = normDate(r.delivery_date)
                    const isPast    = delivNorm && delivNorm < new Date().toISOString().slice(0, 10)
                    const delivColor = isPast ? 'text-red-400' : 'text-slate-300'

                    return (
                      <tr
                        key={`${r.sheet_date}-${r.row_key ?? i}`}
                        className="border-b border-slate-800 hover:bg-slate-800/40 transition-colors"
                      >
                        {/* # */}
                        <td className="px-3 py-2.5 text-slate-600 text-xs">{i + 1}</td>

                        {/* 出單日 */}
                        <td className="px-3 py-2.5 text-slate-400 text-xs whitespace-nowrap">
                          {r.sheet_date}
                        </td>

                        {/* 廠別 */}
                        <td className="px-3 py-2.5">
                          <span className={`inline-flex items-center px-1.5 py-0.5 text-xs rounded border ${factoryBadge(r.factory)}`}>
                            {factoryLabel(r.factory)}
                          </span>
                        </td>

                        {/* 銷售訂單 */}
                        <td className="px-3 py-2.5">
                          <button
                            onClick={() => setSoModal(r.order_number)}
                            className="font-mono text-cyan-400 hover:text-cyan-200 hover:underline text-xs whitespace-nowrap"
                          >
                            {r.order_number}
                          </button>
                        </td>

                        {/* 料號 */}
                        <td className="px-3 py-2.5 font-mono text-xs text-slate-300 whitespace-nowrap">
                          {r.item_code || '—'}
                        </td>

                        {/* 品名 */}
                        <td className="px-3 py-2.5 text-slate-200 max-w-[140px] truncate" title={r.item_name}>
                          {r.item_name || '—'}
                        </td>

                        {/* 規格/備註 */}
                        <td className="px-3 py-2.5 text-slate-400 text-xs max-w-[120px] truncate" title={r.note}>
                          {r.note || '—'}
                        </td>

                        {/* 數量 */}
                        <td className={`px-3 py-2.5 text-right font-mono ${qtyColor}`}>
                          {qty.toLocaleString()}
                        </td>

                        {/* 交期 */}
                        <td className={`px-3 py-2.5 text-xs whitespace-nowrap ${delivColor}`}>
                          {delivNorm || r.delivery_date || '—'}
                        </td>

                        {/* 製令單號 */}
                        <td className="px-3 py-2.5">
                          {r.mo_number ? (
                            <button
                              onClick={() => setMoModal(r.mo_number!)}
                              className="font-mono text-violet-400 hover:text-violet-200 hover:underline text-xs whitespace-nowrap"
                            >
                              {r.mo_number}
                            </button>
                          ) : (
                            // 常平顯示採購單，委外顯示請購單
                            r.po_number ? (
                              <span className="font-mono text-orange-400 text-xs">{r.po_number}</span>
                            ) : r.pr_number ? (
                              <span className="font-mono text-fuchsia-400 text-xs">{r.pr_number}</span>
                            ) : (
                              <span className="text-slate-600 text-xs">—</span>
                            )
                          )}
                        </td>

                        {/* 製令狀態 */}
                        <td className="px-3 py-2.5">
                          {r.mo_status ? (
                            <span className={`inline-flex items-center px-1.5 py-0.5 text-xs rounded border ${moChip(r.mo_status)}`}>
                              {r.mo_status}
                            </span>
                          ) : (
                            <span className="text-slate-600 text-xs">—</span>
                          )}
                        </td>

                        {/* 備料狀態 */}
                        <td className="px-3 py-2.5">
                          {r.material_prep_status ? (
                            <span className={`inline-flex items-center px-1.5 py-0.5 text-xs rounded border ${prepChip(r.material_prep_status)}`}>
                              {r.material_prep_status}
                            </span>
                          ) : (
                            <span className="text-slate-600 text-xs">—</span>
                          )}
                        </td>

                        {/* 客戶 */}
                        <td className="px-3 py-2.5 text-slate-400 text-xs max-w-[100px] truncate" title={r.customer ?? ''}>
                          {r.customer || '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
                {/* 合計列 */}
                <tfoot>
                  <tr className="bg-slate-800/50 border-t border-slate-700 text-sm">
                    <td colSpan={7} className="px-3 py-2.5 text-slate-400 font-medium">
                      合計 {rows.length} 筆
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold text-amber-300 font-mono">
                      {totalQty.toLocaleString()}
                    </td>
                    <td colSpan={5} />
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ── Modals ── */}
      {soModal && (
        <SoOrderModal
          projectId={soModal}
          onClose={() => setSoModal(null)}
        />
      )}
      {moModal && (
        <MoDetailModal
          moNumber={moModal}
          onClose={() => setMoModal(null)}
        />
      )}
    </div>
  )
}
