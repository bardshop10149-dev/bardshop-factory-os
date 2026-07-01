'use client'

import { useState, useCallback, useRef } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

// ── 型別 ─────────────────────────────────────────────────────────

interface InputRow {
  order_number: string
  item_code: string
  item_spec: string
  quantity: number
  due: string
  pan_count: number
}

interface SaraRow {
  order_number: string
  mfg_order_number: string
  product_name: string
  product_desc: string
  lot_number: string
  prod_qty: number
  due: string
  priority: string
  earliest_start: string
  job_seq: number | string
  workcenter: string
  job_name: string
  job_qty: number
  outsourcing: string
  est_time: number
  time_unit: string
  bom: string
  mat_req_qty: string
  _noRoute?: boolean
}

interface SingleRow {
  job_sequence: number
  workcenter: string
  job_name: string
  job_quantity: number
  est_time: number
}

// ── CSV 解析（支援引號欄位） ──────────────────────────────────────

function parseCSV(text: string): string[][] {
  const result: string[][] = []
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const cells: string[] = []
    let i = 0, cell = ''
    while (i <= line.length) {
      const ch = line[i] ?? ''
      if (ch === '"') {
        i++
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { cell += '"'; i += 2 }
          else if (line[i] === '"') { i++; break }
          else cell += line[i++]
        }
      } else if (ch === ',' || ch === '') {
        cells.push(cell.trim()); cell = ''; i++
      } else {
        cell += ch; i++
      }
    }
    if (cells.length > 1 || cells[0]) result.push(cells)
  }
  return result
}

// ── 欄位索引偵測 ─────────────────────────────────────────────────

function detectCols(header: string[]): Record<string, number> {
  const m: Record<string, number> = {}
  let specFound = false
  for (let i = 0; i < header.length; i++) {
    const h = header[i].trim()
    if (!('order' in m) && ['工單編號', '訂單編號', '訂貨單號'].includes(h)) m.order = i
    if (!('item' in m)  && h === '品項編碼') m.item = i
    if (!('qty' in m)   && ['數量', '生產需求數量'].includes(h)) m.qty = i
    if (!('due' in m)   && ['交付日期', '需求日', '交期'].includes(h)) m.due = i
    if (!('pan' in m)   && h === '盤數') m.pan = i
    if (!specFound && ['備註', '品項名稱', '規格'].includes(h)) { m.spec = i; specFound = true }
  }
  return m
}

// ── 輔助函式 ─────────────────────────────────────────────────────

const isPackagingStation = (s: string) => s.includes('包裝站')

function fmtToday(): string {
  const d = new Date()
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function escCsv(v: string | number): string {
  const s = String(v ?? '')
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// ── 頁面 ─────────────────────────────────────────────────────────

export default function ProcessGenPage() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [activeTab, setActiveTab] = useState<'batch' | 'single'>('batch')

  // Batch state
  const [fileName, setFileName]     = useState('')
  const [inputRows, setInputRows]   = useState<InputRow[]>([])
  const [saraRows, setSaraRows]     = useState<SaraRow[]>([])
  const [genWarns, setGenWarns]     = useState<string[]>([])
  const [generating, setGenerating] = useState(false)
  const [dlDone, setDlDone]         = useState(false)
  const [isDragOver, setIsDragOver] = useState(false)

  // Single lookup state
  const [itemCode, setItemCode]         = useState('')
  const [quantity, setQuantity]         = useState('1')
  const [moNumber, setMoNumber]         = useState('')
  const [singleRows, setSingleRows]     = useState<SingleRow[] | null>(null)
  const [singleRoute, setSingleRoute]   = useState('')
  const [singleWarns, setSingleWarns]   = useState<string[]>([])
  const [singleError, setSingleError]   = useState('')
  const [singleLoading, setSingleLoading] = useState(false)
  const [copied, setCopied]             = useState(false)

  // ── 解析 CSV ──────────────────────────────────────────────────

  const handleFile = useCallback((file: File) => {
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = e => {
      const text = e.target?.result as string
      const rows = parseCSV(text)
      if (!rows.length) return

      let hIdx = -1
      let cols: Record<string, number> = {}
      for (let i = 0; i < Math.min(3, rows.length); i++) {
        cols = detectCols(rows[i])
        if ('order' in cols && 'item' in cols) { hIdx = i; break }
      }
      // 若無法偵測，使用 0630C.csv 固定欄位
      if (hIdx === -1) {
        cols = { order: 0, item: 11, spec: 12, qty: 14, due: 15, pan: 16 }
      }

      const parsed: InputRow[] = []
      for (let i = hIdx + 1; i < rows.length; i++) {
        const c = rows[i]
        const order = (c[cols.order] ?? '').trim()
        const item  = (c[cols.item]  ?? '').trim()
        if (!order || !item || order === '工單編號' || order === '訂單編號') continue
        const qty = parseFloat((c[cols.qty] ?? '').replace(/,/g, '')) || 0
        if (qty <= 0) continue
        const panStr = (c[cols.pan ?? -1] ?? '').trim()
        parsed.push({
          order_number: order,
          item_code:    item,
          item_spec:    (c[cols.spec ?? -1] ?? '').trim(),
          quantity:     qty,
          due:          (c[cols.due ?? -1] ?? '').trim(),
          pan_count:    panStr ? parseFloat(panStr) || 0 : 0,
        })
      }
      setInputRows(parsed)
      setSaraRows([])
      setGenWarns([])
    }
    reader.readAsText(file, 'UTF-8')
  }, [])

  // ── 批量產生 SARA ──────────────────────────────────────────────

  const handleGenerate = useCallback(async () => {
    if (!inputRows.length) return
    setGenerating(true)
    setGenWarns([])
    setSaraRows([])
    const warns: string[] = []
    const today = fmtToday()

    try {
      const uniqueItems = [...new Set(inputRows.map(r => r.item_code))]

      // 1. item_routes
      type IrRow = { item_code: string; route_id: string }
      const { data: irData } = await supabase
        .from('item_routes').select('item_code,route_id').in('item_code', uniqueItems)
      const irMap = new Map<string, string>(((irData ?? []) as IrRow[]).map(r => [r.item_code, r.route_id]))

      const missing = uniqueItems.filter(c => !irMap.has(c))
      if (missing.length) warns.push(`${missing.length} 個品號無途程（item_routes）：${missing.slice(0, 6).join('、')}${missing.length > 6 ? '…' : ''}`)

      // 2. route_operations
      const uniqueRoutes = [...new Set([...irMap.values()])]
      type RoRow = { route_id: string; sequence: number; op_name: string }
      const { data: roData } = uniqueRoutes.length
        ? await supabase.from('route_operations').select('route_id,sequence,op_name').in('route_id', uniqueRoutes).order('sequence')
        : { data: [] as RoRow[] }
      const roMap = new Map<string, { sequence: number; op_name: string }[]>()
      for (const r of (roData ?? []) as RoRow[]) {
        const arr = roMap.get(r.route_id) ?? []
        arr.push({ sequence: r.sequence, op_name: r.op_name })
        roMap.set(r.route_id, arr)
      }

      // 3. operation_times
      const uniqueOps = [...new Set(((roData ?? []) as RoRow[]).map(r => r.op_name))]
      type OtRow = { op_name: string; station: string; std_time_min: number }
      const { data: otData } = uniqueOps.length
        ? await supabase.from('operation_times').select('op_name,station,std_time_min').in('op_name', uniqueOps)
        : { data: [] as OtRow[] }
      const otMap = new Map<string, { station: string; std_time_min: number }>(
        ((otData ?? []) as OtRow[]).map(r => [r.op_name, { station: r.station ?? '', std_time_min: Number(r.std_time_min ?? 0) }])
      )

      const missingTimes = uniqueOps.filter(op => !otMap.has(op))
      if (missingTimes.length) warns.push(`${missingTimes.length} 個工序無生產時間（operation_times）：${missingTimes.slice(0, 4).join('、')}${missingTimes.length > 4 ? '…' : ''}`)

      // 4. 產生輸出列
      const out: SaraRow[] = []
      for (const row of inputRows) {
        const routeId = irMap.get(row.item_code)
        if (!routeId) {
          out.push({
            order_number: row.order_number, mfg_order_number: row.order_number,
            product_name: row.item_code, product_desc: row.item_spec,
            lot_number: '', prod_qty: row.quantity, due: row.due,
            priority: '', earliest_start: today,
            job_seq: '', workcenter: '', job_name: '', job_qty: row.quantity,
            outsourcing: '', est_time: 0, time_unit: '分鐘', bom: '', mat_req_qty: '',
            _noRoute: true,
          })
          continue
        }
        const ops = roMap.get(routeId) ?? []
        for (const op of ops) {
          const ot      = otMap.get(op.op_name)
          const station = ot?.station ?? ''
          const std     = ot?.std_time_min ?? 0
          // 包裝站 → 生產數量；其他站點 → 盤數（盤數為 0 時使用生產數量）
          const jobQty  = (row.pan_count > 0 && !isPackagingStation(station)) ? row.pan_count : row.quantity
          const est     = Math.round(std * jobQty * 10) / 10
          out.push({
            order_number: row.order_number, mfg_order_number: row.order_number,
            product_name: row.item_code, product_desc: row.item_spec,
            lot_number: '', prod_qty: row.quantity, due: row.due,
            priority: '', earliest_start: today,
            job_seq: op.sequence, workcenter: station, job_name: op.op_name,
            job_qty: jobQty, outsourcing: '', est_time: est, time_unit: '分鐘',
            bom: '', mat_req_qty: '',
          })
        }
      }
      setSaraRows(out)
      setGenWarns(warns)
    } catch (e) {
      setGenWarns([`錯誤：${e instanceof Error ? e.message : String(e)}`])
    } finally {
      setGenerating(false)
    }
  }, [inputRows])

  // ── 下載 SARA CSV ─────────────────────────────────────────────

  const handleDownload = useCallback(() => {
    const rows = saraRows.filter(r => !r._noRoute)
    if (!rows.length) return
    const h1 = 'Order Number,Manufacturing Order Number,Product Name,Product Description,Lot Number,Production Quantity,Due,Priority Level,Earliest Start Time,Job Sequence,Workcenter,Job Name,Job Quantity,Out Sourcing,Est. Time,Time Unit,BOM Components,Material Required Quantity'
    const h2 = '訂單編號,(必填)工單編號,(必填)品號,規格,生產批號,(必填)生產需求數量,(必填)需求日,排程優先等級(1-99),最早可開始時間,(必填)工序,(必填)站點,(必填)製程名稱,製程數量,製程委外,(必填)預估工時,工時單位,BOM元件品號,物料需求數量'
    const data = rows.map(r =>
      [r.order_number, r.mfg_order_number, r.product_name, r.product_desc,
       r.lot_number, r.prod_qty, r.due, r.priority, r.earliest_start,
       r.job_seq, r.workcenter, r.job_name, r.job_qty, r.outsourcing,
       r.est_time, r.time_unit, r.bom, r.mat_req_qty].map(escCsv).join(',')
    )
    const csv = [h1, h2, ...data].join('\r\n')
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `SARA_101_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    setDlDone(true)
    setTimeout(() => setDlDone(false), 2000)
  }, [saraRows])

  // ── 單品查詢 ──────────────────────────────────────────────────

  const handleSingleGenerate = useCallback(async () => {
    const code = itemCode.trim().toUpperCase()
    const qty  = parseFloat(quantity) || 1
    if (!code) { setSingleError('請輸入品項編碼'); return }
    setSingleLoading(true); setSingleError(''); setSingleRows(null); setSingleWarns([])

    try {
      const { data: irData, error: irErr } = await supabase
        .from('item_routes').select('item_code,route_id').eq('item_code', code).limit(1).single()
      if (irErr || !irData) throw new Error(`找不到品項 ${code} 的途程（item_routes 無資料）`)
      setSingleRoute(irData.route_id as string)

      type SOp = { sequence: number; op_name: string }
      const { data: roData } = await supabase
        .from('route_operations').select('sequence,op_name').eq('route_id', irData.route_id).order('sequence')
      if (!(roData as unknown[])?.length) throw new Error(`途程 ${irData.route_id} 無工序資料`)

      type OtRow = { op_name: string; station: string; std_time_min: number }
      const opNames = (roData as SOp[]).map(r => r.op_name)
      const { data: otData } = await supabase
        .from('operation_times').select('op_name,station,std_time_min').in('op_name', opNames)
      const otM = new Map<string, { station: string; std_time_min: number }>(
        ((otData ?? []) as OtRow[]).map(r => [r.op_name, { station: r.station ?? '', std_time_min: Number(r.std_time_min ?? 0) }])
      )

      const warns: string[] = []
      const result: SingleRow[] = (roData as SOp[]).map(op => {
        const ot  = otM.get(op.op_name)
        if (!ot) warns.push(`工序「${op.op_name}」無生產時間`)
        const std = ot?.std_time_min ?? 0
        return { job_sequence: op.sequence, workcenter: ot?.station ?? '', job_name: op.op_name, job_quantity: qty, est_time: Math.round(std * qty * 10) / 10 }
      })
      setSingleRows(result); setSingleWarns(warns)
    } catch (e) {
      setSingleError(e instanceof Error ? e.message : String(e))
    } finally {
      setSingleLoading(false)
    }
  }, [itemCode, quantity])

  const handleCopyTsv = useCallback(() => {
    if (!singleRows) return
    const mo  = moNumber.trim() || '(未填)'
    const qty = parseFloat(quantity) || 1
    const hdr = ['manufacturing_order_number', 'product_name', 'production_quantity', 'job_sequence', 'workcenter', 'job_name', 'job_quantity', 'out_sourcing', 'est_time', 'time_unit']
    const data = singleRows.map(r => [mo, itemCode.trim(), qty, r.job_sequence, r.workcenter, r.job_name, r.job_quantity, 'N', r.est_time, '分鐘'])
    navigator.clipboard.writeText([hdr, ...data].map(r => r.join('\t')).join('\n')).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    })
  }, [singleRows, moNumber, quantity, itemCode])

  // ── 統計 ──────────────────────────────────────────────────────

  const successCount = saraRows.filter(r => !r._noRoute).length
  const noRouteCount = saraRows.filter(r => r._noRoute).length

  // ── 渲染 ──────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-6 space-y-4">

      <div>
        <h1 className="text-xl font-bold text-emerald-300">SARA 工序格式產生器</h1>
        <p className="text-xs text-slate-400 mt-0.5">由每日出單表 CSV 查詢途程，自動產出塔台 SARA_101 匯入格式</p>
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1 bg-slate-900 p-1 rounded-lg w-fit border border-slate-800">
        {(['batch', 'single'] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-4 py-1.5 rounded text-sm font-medium transition-colors ${activeTab === t ? 'bg-emerald-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
            {t === 'batch' ? '📄 CSV 批量轉換' : '🔍 單品查詢'}
          </button>
        ))}
      </div>

      {/* ══════════════════════════════════════════ BATCH */}
      {activeTab === 'batch' && (
        <div className="space-y-4">

          {/* 上傳區 */}
          <div
            onDragOver={e => { e.preventDefault(); setIsDragOver(true) }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={e => { e.preventDefault(); setIsDragOver(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
            onClick={() => fileRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${isDragOver ? 'border-emerald-400 bg-emerald-950/20' : 'border-slate-700 hover:border-emerald-600'}`}
          >
            <input ref={fileRef} type="file" accept=".csv" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }} />
            <p className="text-slate-400 text-sm">拖曳 CSV 或點此上傳</p>
            <p className="text-xs text-slate-600 mt-1">每日出單表格式（0630C.csv 等）</p>
            {fileName && <p className="mt-2 text-emerald-400 text-sm font-mono">📄 {fileName}</p>}
          </div>

          {/* 解析摘要 + 產生按鈕 */}
          {inputRows.length > 0 && (
            <div className="flex flex-wrap gap-3 items-center">
              <span className="text-xs bg-slate-800 px-3 py-1 rounded-lg border border-slate-700">
                解析 <span className="text-white font-bold">{inputRows.length}</span> 筆
              </span>
              <span className="text-xs bg-slate-800 px-3 py-1 rounded-lg border border-slate-700">
                品號 <span className="text-cyan-300 font-bold">{new Set(inputRows.map(r => r.item_code)).size}</span> 種
              </span>
              <span className="text-xs bg-slate-800 px-3 py-1 rounded-lg border border-slate-700">
                訂單 <span className="text-indigo-300 font-bold">{new Set(inputRows.map(r => r.order_number)).size}</span> 張
              </span>
              <button onClick={() => void handleGenerate()} disabled={generating}
                className="px-5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-semibold">
                {generating ? '⏳ 查詢途程中…' : '⚙ 產生 SARA 格式'}
              </button>
            </div>
          )}

          {/* 警告 */}
          {genWarns.length > 0 && (
            <div className="px-4 py-2 bg-amber-950/40 border border-amber-700/40 rounded-lg space-y-0.5">
              {genWarns.map((w, i) => <div key={i} className="text-amber-300 text-xs">⚠ {w}</div>)}
            </div>
          )}

          {/* 輸出結果 */}
          {saraRows.length > 0 && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-3 items-center">
                <span className="text-xs bg-slate-800 px-3 py-1 rounded-lg border border-slate-700">
                  輸出 <span className="text-emerald-300 font-bold">{successCount}</span> 工序列
                </span>
                {noRouteCount > 0 && (
                  <span className="text-xs bg-red-900/30 px-3 py-1 rounded-lg border border-red-700/40 text-red-300">
                    ⚠ {noRouteCount} 筆品號無途程（已排除於 CSV）
                  </span>
                )}
                <button onClick={handleDownload}
                  className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm font-semibold">
                  {dlDone ? '✅ 已下載' : '⬇ 下載 SARA CSV'}
                </button>
              </div>

              {/* 預覽表 */}
              <div className="overflow-x-auto rounded-xl border border-slate-800 max-h-[450px] overflow-y-auto">
                <table className="w-full text-xs text-left border-collapse min-w-max">
                  <thead className="sticky top-0 bg-slate-900 z-10">
                    <tr className="text-slate-400 text-[10px] uppercase">
                      <th className="px-2 py-2 border-b border-slate-800">訂單</th>
                      <th className="px-2 py-2 border-b border-slate-800">品號</th>
                      <th className="px-2 py-2 border-b border-slate-800 text-right">生產量</th>
                      <th className="px-2 py-2 border-b border-slate-800">交期</th>
                      <th className="px-2 py-2 border-b border-slate-800 text-center">工序</th>
                      <th className="px-2 py-2 border-b border-slate-800 text-cyan-400">站點</th>
                      <th className="px-2 py-2 border-b border-slate-800 text-emerald-400">製程名稱</th>
                      <th className="px-2 py-2 border-b border-slate-800 text-right">製程量</th>
                      <th className="px-2 py-2 border-b border-slate-800 text-right text-amber-300">工時(min)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {saraRows.slice(0, 600).map((r, i) => (
                      <tr key={i} className={`border-b border-slate-800/40 ${r._noRoute ? 'bg-red-950/20' : 'hover:bg-slate-900/50'}`}>
                        <td className="px-2 py-1.5 font-mono text-slate-300 whitespace-nowrap">{r.order_number}</td>
                        <td className="px-2 py-1.5 font-mono text-slate-200 whitespace-nowrap">{r.product_name}</td>
                        <td className="px-2 py-1.5 text-right text-white font-mono">{r.prod_qty}</td>
                        <td className="px-2 py-1.5 text-slate-400 whitespace-nowrap">{r.due}</td>
                        <td className="px-2 py-1.5 text-center text-slate-400 font-mono">
                          {r._noRoute ? <span className="text-red-400 text-[10px]">無途程</span> : r.job_seq}
                        </td>
                        <td className="px-2 py-1.5 text-cyan-300 whitespace-nowrap">{r.workcenter}</td>
                        <td className="px-2 py-1.5 text-emerald-300 whitespace-nowrap">{r.job_name}</td>
                        <td className="px-2 py-1.5 text-right font-mono">{r.job_qty || '—'}</td>
                        <td className="px-2 py-1.5 text-right text-amber-300 font-mono">
                          {r.est_time > 0 ? r.est_time : <span className="text-slate-600">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {saraRows.length > 600 && (
                  <p className="text-center text-xs text-slate-500 py-2">
                    僅顯示前 600 列，下載 CSV 包含全部 {successCount} 工序列
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════ SINGLE */}
      {activeTab === 'single' && (
        <div className="space-y-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">品項編碼 <span className="text-red-400">*</span></label>
              <input type="text" value={itemCode} onChange={e => setItemCode(e.target.value.toUpperCase())}
                onKeyDown={e => e.key === 'Enter' && void handleSingleGenerate()}
                placeholder="例：PACRTSPE3-55S"
                className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500 font-mono" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">製令號（選填）</label>
              <input type="text" value={moNumber} onChange={e => setMoNumber(e.target.value)}
                placeholder="例：MOT26070101"
                className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500 font-mono" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">生產數量</label>
              <input type="number" value={quantity} onChange={e => setQuantity(e.target.value)} min={1}
                className="w-full bg-slate-800 border border-slate-700 text-slate-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-emerald-500" />
            </div>
          </div>

          <div className="flex gap-3">
            <button onClick={() => void handleSingleGenerate()} disabled={singleLoading}
              className="px-5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-sm font-semibold">
              {singleLoading ? '查詢中…' : '🔍 查詢工序'}
            </button>
            {singleRows && (
              <button onClick={handleCopyTsv} className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm">
                {copied ? '✅ 已複製 TSV' : '📋 複製 TSV'}
              </button>
            )}
          </div>

          {singleError && (
            <div className="px-4 py-3 bg-red-950/50 border border-red-700/50 rounded-lg text-red-300 text-sm">{singleError}</div>
          )}

          {singleRows && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg">途程：<span className="text-cyan-300 font-mono">{singleRoute}</span></span>
                <span className="px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg">工序數：<span className="font-bold">{singleRows.length}</span></span>
                <span className="px-2 py-1 bg-slate-800 border border-slate-700 rounded-lg">
                  總工時：<span className="text-amber-300 font-bold">{singleRows.reduce((s, r) => s + r.est_time, 0).toFixed(1)} min</span>
                </span>
              </div>
              {singleWarns.length > 0 && (
                <div className="px-4 py-2 bg-amber-950/40 border border-amber-700/40 rounded-lg">
                  {singleWarns.map((w, i) => <div key={i} className="text-amber-300 text-xs">⚠ {w}</div>)}
                </div>
              )}
              <div className="overflow-x-auto rounded-xl border border-slate-800">
                <table className="w-full text-xs text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-900/80 text-slate-400 text-[11px] uppercase">
                      <th className="px-3 py-2.5 border-b border-slate-800 w-12 text-center">工序</th>
                      <th className="px-3 py-2.5 border-b border-slate-800">站點</th>
                      <th className="px-3 py-2.5 border-b border-slate-800 text-emerald-400">製程名稱</th>
                      <th className="px-3 py-2.5 border-b border-slate-800 text-right">數量</th>
                      <th className="px-3 py-2.5 border-b border-slate-800 text-right text-amber-300">工時 (min)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {singleRows.map((r, i) => (
                      <tr key={i} className="border-b border-slate-800/50 hover:bg-slate-900/50">
                        <td className="px-3 py-2 text-center text-slate-400 font-mono">{r.job_sequence}</td>
                        <td className="px-3 py-2 text-slate-300">{r.workcenter || <span className="text-slate-600">—</span>}</td>
                        <td className="px-3 py-2 text-emerald-300 font-medium">{r.job_name}</td>
                        <td className="px-3 py-2 text-right font-mono">{r.job_quantity}</td>
                        <td className="px-3 py-2 text-right text-amber-300 font-mono">
                          {r.est_time > 0 ? r.est_time : <span className="text-slate-600">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-slate-900/60">
                      <td colSpan={4} className="px-3 py-2 text-right text-xs text-slate-400">合計工時</td>
                      <td className="px-3 py-2 text-right font-bold text-amber-300 font-mono">
                        {singleRows.reduce((s, r) => s + r.est_time, 0).toFixed(1)} min
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="text-[11px] text-slate-600 space-y-0.5 pt-2 border-t border-slate-800/50">
        <p>・工序資料來源：item_routes（品號↔途程）、route_operations（途程→工序順序）、operation_times（工序→站點＋標準工時）</p>
        <p>・製程量：包裝站以生產數量計；其他站點以盤數計（盤數未填時使用生產數量）</p>
        <p>・預估工時 = std_time_min × 製程量；最早開始時間 = 產生時的當日日期</p>
      </div>
    </div>
  )
}
