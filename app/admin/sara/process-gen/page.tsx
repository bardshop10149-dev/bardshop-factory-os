'use client'

import { useState, useCallback } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

interface GenRow {
  job_sequence: number
  workcenter: string
  job_name: string
  job_quantity: number
  est_time: number
  time_unit: string
}

interface LookupResult {
  item_code: string
  route_id: string
  rows: GenRow[]
  warnings: string[]
}

export default function ProcessGenPage() {
  const [itemCode, setItemCode] = useState('')
  const [moNumber, setMoNumber] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<LookupResult | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const handleGenerate = useCallback(async () => {
    const code = itemCode.trim().toUpperCase()
    const qty = parseFloat(quantity) || 1
    if (!code) { setError('請輸入品項編碼'); return }
    setLoading(true)
    setError('')
    setResult(null)

    try {
      // 1. 品項 → 途程
      const { data: irData, error: irErr } = await supabase
        .from('item_routes')
        .select('item_code, route_id')
        .eq('item_code', code)
        .limit(1)
        .single()
      if (irErr || !irData) throw new Error(`找不到品項 ${code} 的途程對應（item_routes 無資料）`)

      const routeId = irData.route_id

      // 2. 途程 → 工序列表
      const { data: roData, error: roErr } = await supabase
        .from('route_operations')
        .select('sequence, op_name')
        .eq('route_id', routeId)
        .order('sequence', { ascending: true })
      if (roErr) throw new Error(`查詢工序失敗：${roErr.message}`)
      if (!roData || roData.length === 0) throw new Error(`途程 ${routeId} 在 route_operations 中無工序資料`)

      // 3. 工序 → 生產時間
      const opNames = roData.map(r => r.op_name)
      const { data: otData } = await supabase
        .from('operation_times')
        .select('op_name, station, std_time_min')
        .in('op_name', opNames)

      const timeMap = new Map<string, { station: string; std_time_min: number }>(
        (otData ?? []).map(r => [r.op_name, { station: r.station ?? '', std_time_min: Number(r.std_time_min ?? 0) }])
      )

      const warnings: string[] = []
      const rows: GenRow[] = roData.map(op => {
        const timeInfo = timeMap.get(op.op_name)
        if (!timeInfo) warnings.push(`工序「${op.op_name}」在 operation_times 中無生產時間`)
        const stdTime = timeInfo?.std_time_min ?? 0
        return {
          job_sequence: op.sequence,
          workcenter: timeInfo?.station ?? '',
          job_name: op.op_name,
          job_quantity: qty,
          est_time: Math.round(stdTime * qty * 100) / 100,
          time_unit: 'min',
        }
      })

      setResult({ item_code: code, route_id: routeId, rows, warnings })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [itemCode, quantity])

  const buildCsvLines = useCallback(() => {
    if (!result) return []
    const mo = moNumber.trim() || '(未填)'
    const qty = parseFloat(quantity) || 1
    const headers = [
      'manufacturing_order_number', 'product_name', 'production_quantity',
      'job_sequence', 'workcenter', 'job_name', 'job_quantity', 'out_sourcing',
      'est_time', 'time_unit',
    ]
    const dataRows = result.rows.map(r => [
      mo, result.item_code, String(qty),
      String(r.job_sequence), r.workcenter, r.job_name, String(r.job_quantity), 'N',
      String(r.est_time), r.time_unit,
    ])
    return [headers, ...dataRows]
  }, [result, moNumber, quantity])

  const handleCopyTsv = useCallback(() => {
    const lines = buildCsvLines()
    if (!lines.length) return
    const tsv = lines.map(row => row.join('\t')).join('\n')
    navigator.clipboard.writeText(tsv).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }, [buildCsvLines])

  const handleDownloadCsv = useCallback(() => {
    const lines = buildCsvLines()
    if (!lines.length) return
    const csv = lines.map(row =>
      row.map(v => v.includes(',') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v).join(',')
    ).join('\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `SARA_process_${itemCode.trim() || 'output'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [buildCsvLines, itemCode])

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-emerald-300">SARA 工序格式產生器</h1>
        <p className="text-xs text-slate-400 mt-0.5">
          由品項編碼查詢對應途程 → 工序列表 → 生產時間，自動產生 SARA_101 工序列
        </p>
      </div>

      {/* 輸入區 */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label className="block text-xs text-slate-400 mb-1">品項編碼（品號）<span className="text-red-400">*</span></label>
          <input
            type="text"
            value={itemCode}
            onChange={e => setItemCode(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && void handleGenerate()}
            placeholder="例：PCOAA-RNB"
            className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500 font-mono"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">製令號（選填，用於匯出）</label>
          <input
            type="text"
            value={moNumber}
            onChange={e => setMoNumber(e.target.value)}
            placeholder="例：MOT26070101"
            className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500 font-mono"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">生產數量</label>
          <input
            type="number"
            value={quantity}
            onChange={e => setQuantity(e.target.value)}
            min={1}
            className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500"
          />
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={() => void handleGenerate()}
          disabled={loading}
          className="px-5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-semibold"
        >
          {loading ? '查詢中…' : '🔍 產生工序列'}
        </button>
        {result && (
          <>
            <button
              onClick={handleCopyTsv}
              className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm"
            >
              {copied ? '✅ 已複製' : '📋 複製 TSV'}
            </button>
            <button
              onClick={handleDownloadCsv}
              className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm"
            >
              ⬇ 下載 CSV
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-950/50 border border-red-700/50 rounded-lg text-red-300 text-sm">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-3">
          {/* 查詢摘要 */}
          <div className="flex flex-wrap gap-3 text-xs">
            <span className="px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg">
              品項：<span className="text-emerald-300 font-mono font-bold">{result.item_code}</span>
            </span>
            <span className="px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg">
              途程：<span className="text-cyan-300 font-mono">{result.route_id}</span>
            </span>
            <span className="px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg">
              工序數：<span className="text-white font-bold">{result.rows.length}</span>
            </span>
            <span className="px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg">
              總工時：<span className="text-amber-300 font-bold">{result.rows.reduce((s, r) => s + r.est_time, 0).toFixed(1)} min</span>
            </span>
          </div>

          {result.warnings.length > 0 && (
            <div className="px-4 py-2 bg-amber-950/40 border border-amber-700/40 rounded-lg space-y-0.5">
              {result.warnings.map((w, i) => (
                <div key={i} className="text-amber-300 text-xs">⚠ {w}</div>
              ))}
            </div>
          )}

          {/* 工序表 */}
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="bg-slate-900/80 text-slate-400 text-[11px] uppercase">
                  <th className="px-3 py-2.5 border-b border-slate-800 w-12 text-center">工序</th>
                  <th className="px-3 py-2.5 border-b border-slate-800">站點（工作中心）</th>
                  <th className="px-3 py-2.5 border-b border-slate-800 text-emerald-400">工序名稱</th>
                  <th className="px-3 py-2.5 border-b border-slate-800 text-right">生產數量</th>
                  <th className="px-3 py-2.5 border-b border-slate-800 text-right text-amber-300">預估工時 (min)</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r, idx) => (
                  <tr key={idx} className="border-b border-slate-800/50 hover:bg-slate-900/50">
                    <td className="px-3 py-2 text-center text-slate-400 font-mono">{r.job_sequence}</td>
                    <td className="px-3 py-2 text-slate-300">{r.workcenter || <span className="text-slate-600">—</span>}</td>
                    <td className="px-3 py-2 text-emerald-300 font-medium">{r.job_name}</td>
                    <td className="px-3 py-2 text-right text-white font-mono">{r.job_quantity}</td>
                    <td className="px-3 py-2 text-right text-amber-300 font-mono">{r.est_time > 0 ? r.est_time : <span className="text-slate-600">—</span>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-900/60">
                  <td colSpan={4} className="px-3 py-2 text-right text-xs text-slate-400">合計工時</td>
                  <td className="px-3 py-2 text-right font-bold text-amber-300 font-mono">
                    {result.rows.reduce((s, r) => s + r.est_time, 0).toFixed(1)} min
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* CSV 預覽 */}
          <details className="group">
            <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300 select-none">
              展開 CSV 預覽（可複製貼入 SARA_101）
            </summary>
            <pre className="mt-2 p-3 bg-slate-900 border border-slate-800 rounded-lg text-[11px] text-slate-400 font-mono overflow-x-auto">
              {buildCsvLines().map(r => r.join('\t')).join('\n')}
            </pre>
          </details>
        </div>
      )}

      <div className="text-[11px] text-slate-600 space-y-0.5 pt-1 border-t border-slate-800/50">
        <p>・資料來源：item_routes（品項→途程）、route_operations（途程→工序）、operation_times（工序→生產時間）</p>
        <p>・預估工時 = 單位生產時間（std_time_min）× 生產數量</p>
        <p>・若工序無生產時間，顯示 — 並提示警告；需先至「工序總表更新」頁上傳最新資料</p>
      </div>
    </div>
  )
}
