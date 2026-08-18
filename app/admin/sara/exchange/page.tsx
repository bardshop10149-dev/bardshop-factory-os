'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

const CSV_H1 = 'Order Number,Manufacturing Order Number,Product Name,Product Description,Lot Number,Production Quantity,Due,Priority Level,Earliest Start Time,Job Sequence,Workcenter,Job Name,Job Quantity,Out Sourcing,Est. Time,Time Unit,BOM Components,Material Required Quantity,customer_id,assigned_machine,Rule,Parameter 1'
const CSV_H2 = '訂單編號,(必填)工單編號,(必填)品號,規格,生產批號,(必填)生產需求數量,(必填)需求日,排程優先等級(1-99),最早可開始時間,(必填)工序,(必填)站點,(必填)製程名稱,製程數量,製程委外,(必填)預估工時,工時單位,BOM元件品號,物料需求數量,客戶名稱,分配機台,規則,參數1'

function parseCSVRows(text: string): string[][] {
  const result: string[][] = []
  for (const line of text.split(/\r?\n/)) {
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
      } else if (ch === ',' || ch === '') { cells.push(cell.trim()); cell = ''; i++ }
      else { cell += ch; i++ }
    }
    if (cells.length > 1 || cells[0]) result.push(cells)
  }
  return result
}

function escCsv(v: string | number): string {
  const s = String(v ?? '')
  return /[,"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

interface ExchangeRow {
  id: number
  data_type: string
  ref_key: string | null
  payload: unknown
  status: 'pending' | 'consumed'
  note: string | null
  created_at: string
  consumed_at: string | null
  expires_at: string | null
}

const STATUS_BADGE: Record<string, string> = {
  pending:  'bg-amber-900/40 text-amber-300 border-amber-700/50',
  consumed: 'bg-slate-800 text-slate-400 border-slate-700',
}

export default function SaraExchangePage() {
  const [unlocked, setUnlocked] = useState(false)
  const [pwInput, setPwInput]   = useState('')
  const [pwError, setPwError]   = useState(false)

  const [rows, setRows]         = useState<ExchangeRow[]>([])
  const [loading, setLoading]   = useState(false)
  const [statusFilter, setStatusFilter] = useState<'pending' | 'consumed' | 'all'>('all')
  const [typeFilter, setTypeFilter]     = useState('')
  const [total, setTotal]       = useState(0)

  // CSV 累積區
  const [csvRows, setCsvRows]   = useState<string[][]>([])
  const [csvLoading, setCsvLoading] = useState(false)
  const [csvMsg, setCsvMsg]     = useState('')
  const [lastPulledAt, setLastPulledAt] = useState<string | null>(null)
  // 上傳檔案引用：分別用於「取代基底」和「追加新列」

  // 新增表單
  const [showAdd, setShowAdd]   = useState(false)
  const [addType, setAddType]   = useState('')
  const [addRef, setAddRef]     = useState('')
  const [addNote, setAddNote]   = useState('')
  const [addPayload, setAddPayload] = useState('{}')
  const [addMsg, setAddMsg]     = useState('')
  const [adding, setAdding]     = useState(false)

  // 選取刪除
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [delMsg, setDelMsg]     = useState('')

  const [expandedId, setExpandedId] = useState<number | null>(null)

  // 載入 API Key（server-side env，僅管理員可見）
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  useEffect(() => {
    fetch('/api/sara/exchange-key', { cache: 'no-store' })
      .then(r => r.json())
      .then((j: { key: string | null }) => setApiKey(j.key))
      .catch(() => {})
  }, [])

  // 載入 CSV buffer
  const loadCsvBuffer = useCallback(async () => {
    setCsvLoading(true)
    try {
      const res = await fetch('/api/sara/exchange-csv', { cache: 'no-store' })
      const j = await res.json() as { success: boolean; rows?: string[][]; last_pulled_at?: string | null }
      if (j.success) {
        setCsvRows(j.rows ?? [])
        setLastPulledAt(j.last_pulled_at ?? null)
      }
    } finally { setCsvLoading(false) }
  }, [])

  useEffect(() => { void loadCsvBuffer() }, [loadCsvBuffer])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      let q = supabase
        .from('sara_exchange')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .limit(200)
      if (statusFilter !== 'all') q = q.eq('status', statusFilter)
      if (typeFilter.trim()) q = q.ilike('data_type', `%${typeFilter.trim()}%`)
      const { data, count, error } = await q
      if (error) throw error
      setRows((data ?? []) as ExchangeRow[])
      setTotal(count ?? 0)
    } finally {
      setLoading(false)
    }
  }, [statusFilter, typeFilter])

  useEffect(() => { void load() }, [load])

  // 上傳檔案引用：分別用於「取代基底」和「追加新列」
  const csvReplaceRef = useRef<HTMLInputElement>(null)
  const csvAppendRef  = useRef<HTMLInputElement>(null)

  // ── CSV 上傳（append=false 就是取代基底）──
  const handleCsvUpload = useCallback(async (file: File, append: boolean) => {
    setCsvMsg('')
    const text = await file.text()
    const allRows = parseCSVRows(text)
    const dataRows = allRows.filter(r => r[0] !== 'Order Number' && r[0] !== '訂單編號' && r.length >= 10)
    if (dataRows.length === 0) { setCsvMsg('⚠️ 未偵測到有效資料列（已跳過標題行）'); return }
    if (!append && csvRows.length > 0) {
      if (!confirm(`確定用此 CSV 「取代」目前的 ${csvRows.length} 列資料？`)) return
    }
    setCsvLoading(true)
    try {
      const res = await fetch('/api/sara/exchange-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: dataRows, append }),
      })
      const j = await res.json() as { success: boolean; count?: number; error?: string }
      if (!j.success) throw new Error(j.error)
      setCsvMsg(append
        ? `✅ 已追加 ${dataRows.length} 列，累積共 ${j.count} 列`
        : `✅ 已取代基底，現共 ${j.count} 列`)
      await loadCsvBuffer()
    } catch (e) {
      setCsvMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally { setCsvLoading(false) }
  }, [loadCsvBuffer, csvRows.length])

  // ── 下載 CSV buffer ──
  const handleCsvDownload = useCallback(() => {
    if (csvRows.length === 0) return
    const lines = [CSV_H1, CSV_H2, ...csvRows.map(r => r.map(escCsv).join(','))].join('\r\n')
    const blob = new Blob(['\uFEFF' + lines], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url
    a.download = `SARA_combined_${new Date().toISOString().slice(0, 10)}.csv`
    a.click(); URL.revokeObjectURL(url)
  }, [csvRows])

  // ── 清空 CSV buffer ──
  const handleCsvClear = useCallback(async () => {
    if (!confirm(`確定清空 CSV 累積區（${csvRows.length} 列）？`)) return
    setCsvLoading(true)
    try {
      await fetch('/api/sara/exchange-csv', { method: 'DELETE' })
      setCsvRows([]); setCsvMsg('✅ 已清空')
      setTimeout(() => setCsvMsg(''), 3000)
    } finally { setCsvLoading(false) }
  }, [csvRows.length])

  const handleAdd = async () => {
    if (!addType.trim()) { setAddMsg('❌ 請填寫資料類型'); return }
    let parsed: unknown
    try { parsed = JSON.parse(addPayload) } catch { setAddMsg('❌ Payload 不是合法 JSON'); return }
    setAdding(true); setAddMsg('')
    try {
      const res = await fetch('/api/sara/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data_type: addType.trim(), ref_key: addRef.trim() || undefined, payload: parsed, note: addNote.trim() || undefined }),
      })
      const j = await res.json() as { success: boolean; error?: string }
      if (!j.success) throw new Error(j.error)
      setAddMsg('✅ 已新增')
      setAddType(''); setAddRef(''); setAddNote(''); setAddPayload('{}')
      setShowAdd(false)
      void load()
    } catch (e) {
      setAddMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally { setAdding(false) }
  }

  const handleDelete = async () => {
    if (selected.size === 0) return
    if (!confirm(`確定刪除 ${selected.size} 筆？`)) return
    setDeleting(true); setDelMsg('')
    try {
      const res = await fetch('/api/sara/exchange', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selected] }),
      })
      const j = await res.json() as { success: boolean; error?: string }
      if (!j.success) throw new Error(j.error)
      setDelMsg(`✅ 已刪除 ${selected.size} 筆`)
      setSelected(new Set())
      void load()
    } catch (e) {
      setDelMsg(`❌ ${e instanceof Error ? e.message : String(e)}`)
    } finally { setDeleting(false) }
  }

  const handleClearConsumed = async () => {
    if (!confirm('確定清除所有 consumed 的資料？')) return
    setDeleting(true)
    try {
      await fetch('/api/sara/exchange', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'consumed' }),
      })
      void load()
    } finally { setDeleting(false) }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://your-domain.vercel.app'
  const apiUrl = `${origin}/api/sara/exchange`

  if (!unlocked) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-8 w-80 flex flex-col items-center gap-4">
          <div className="text-2xl">🔒</div>
          <h2 className="text-white font-semibold text-lg">SARA 資料交換區</h2>
          <p className="text-slate-400 text-sm">請輸入密碼以繼續</p>
          <input
            type="password" value={pwInput}
            onChange={e => { setPwInput(e.target.value); setPwError(false) }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                if (pwInput === '666') setUnlocked(true)
                else { setPwError(true); setPwInput('') }
              }
            }}
            placeholder="密碼" autoFocus
            className={`w-full px-4 py-2 rounded-lg bg-slate-800 border text-white text-center tracking-widest focus:outline-none ${
              pwError ? 'border-red-500' : 'border-slate-600 focus:border-cyan-500'
            }`}
          />
          {pwError && <p className="text-red-400 text-xs">密碼錯誤</p>}
          <button
            onClick={() => { if (pwInput === '666') setUnlocked(true); else { setPwError(true); setPwInput('') } }}
            className="w-full py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium transition-colors"
          >進入</button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-6xl mx-auto">

        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold">SARA 資料交換區</h1>
          <p className="text-slate-400 text-sm mt-1">將轉換後的塔台格式資料放入此區，塔台透過 API Key 呼叫端口拉取</p>
        </div>

        {/* API 端口說明卡片 */}
        <div className="mb-6 rounded-xl border border-cyan-800/40 bg-cyan-950/20 p-5">
          <h2 className="text-sm font-semibold text-cyan-300 mb-4">📡 塔台呼叫端口（CSV 格式）完整串接說明</h2>
          <div className="space-y-4 text-xs">

            {/* Step 1 */}
            <div className="rounded-lg bg-slate-900/60 border border-slate-700 p-4">
              <div className="text-slate-300 font-semibold mb-2">① 端口 URL</div>
              <code className="block px-3 py-2 rounded bg-slate-950 text-cyan-200 font-mono select-all text-sm">
                {`${origin}/api/sara/exchange-csv`}
              </code>
            </div>

            {/* Step 2 */}
            <div className="rounded-lg bg-slate-900/60 border border-slate-700 p-4">
              <div className="text-slate-300 font-semibold mb-2">② 認證 Header（必填）</div>
              <div className="flex items-center gap-3 flex-wrap">
                <code className="px-3 py-2 rounded bg-slate-950 text-amber-200 font-mono select-all">
                  Authorization: Bearer {showKey && apiKey ? apiKey : (apiKey ? '••••••••••••' : '（未設定）')}
                </code>
                {apiKey && (
                  <button onClick={() => setShowKey(v => !v)}
                    className="px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-200 transition-colors">
                    {showKey ? '隱藏' : '顯示'} Key
                  </button>
                )}
                {!apiKey && (
                  <span className="text-amber-400">⚠️ Vercel 尚未設定 SARA_EXCHANGE_API_KEY</span>
                )}
              </div>
              {showKey && apiKey && (
                <div className="mt-2 p-2 rounded bg-amber-950/40 border border-amber-700/40 text-amber-300">
                  ⚠️ 此 Key 請妥善保管，不要外傳
                </div>
              )}
            </div>

            {/* Step 3 */}
            <div className="rounded-lg bg-slate-900/60 border border-slate-700 p-4">
              <div className="text-slate-300 font-semibold mb-2">③ 呼叫範例</div>
              <div className="space-y-1 font-mono text-slate-300">
                <div className="text-slate-500"># 拉取全部 CSV 資料</div>
                <div className="select-all">GET {`${origin}/api/sara/exchange-csv`}</div>
                <div className="text-slate-500 mt-2"># 拉取後自動清空 buffer（建議塔台使用）</div>
                <div className="select-all">GET {`${origin}/api/sara/exchange-csv`}?mark_consumed=true</div>
              </div>
            </div>

            {/* Step 4 */}
            <div className="rounded-lg bg-slate-900/60 border border-slate-700 p-4">
              <div className="text-slate-300 font-semibold mb-2">④ 回傳格式（JSON）</div>
              <pre className="text-slate-300 font-mono text-[11px] leading-relaxed overflow-x-auto">{`{
  "success": true,
  "count": N,
  "fetched_at": "2026-08-11T...",
  "data": [
    {
      "Order Number": "RO26042028",
      "Manufacturing Order Number": "RO26042028",
      "Product Name": "CCUSD-KZ",
      "Product Description": "...",
      "Lot Number": "",
      "Production Quantity": "210",
      "Due": "2026/7/27",
      "Priority Level": "",
      "Earliest Start Time": "2026/04/24",
      "Job Sequence": "1",
      "Workcenter": "轉運站",
      "Job Name": "委外/11天回",
      "Job Quantity": "210",
      "Out Sourcing": "",
      "Est. Time": "15840",
      "Time Unit": "分鐘",
      "BOM Components": "",
      "Material Required Quantity": "",
      "customer_id": "",
      "assigned_machine": "",
      "Rule": "",
      "Parameter 1": ""
    },
    ...
  ]
}`}</pre>
            </div>

            {/* Step 5 */}
            <div className="rounded-lg bg-slate-900/60 border border-slate-700 p-4">
              <div className="text-slate-300 font-semibold mb-2">⑤ 完整 curl 範例</div>
              <pre className="text-slate-300 font-mono overflow-x-auto text-[11px] leading-relaxed select-all">{`curl -X GET \\
  "${origin}/api/sara/exchange-csv?mark_consumed=true" \\
  -H "Authorization: Bearer ${showKey && apiKey ? apiKey : (apiKey ? '••••••••••••' : '<YOUR_API_KEY>')}" \\
  -H "Accept: application/json"`}</pre>
            </div>

          </div>
        </div>

        {/* ── CSV 累積區 ── */}
        <div className="mb-6 rounded-xl border border-emerald-800/40 bg-emerald-950/20 p-5">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
            <div>
              <h2 className="text-sm font-semibold text-emerald-300">📄 CSV 累積區（交換主體）</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                <span className="text-amber-300">📄 取代基底</span>：清空後放入新 CSV（週期性更新整份資料）　
                <span className="text-emerald-300">＋ 追加新列</span>：在現有資料後加入（工序格式產生後追加）
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {csvMsg && (
                <span className={`text-xs ${csvMsg.startsWith('✅') ? 'text-emerald-400' : csvMsg.startsWith('⚠') ? 'text-amber-400' : 'text-red-400'}`}>
                  {csvMsg}
                </span>
              )}
              <span className={`px-3 py-1 rounded-full text-xs font-semibold border ${csvRows.length > 0 ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' : 'bg-slate-800 text-slate-500 border-slate-700'}`}>
                {csvLoading ? '載入中…' : `累積 ${csvRows.length} 列`}
              </span>
              <span className={`px-3 py-1 rounded-full text-xs font-medium border ${lastPulledAt ? 'bg-slate-800 text-slate-300 border-slate-700' : 'bg-slate-800 text-slate-500 border-slate-700'}`}
                title="塔台最後一次成功呼叫本端口的時間（不論是否帶 mark_consumed）">
                📡 塔台上次呼出：{lastPulledAt ? new Date(lastPulledAt).toLocaleString('zh-TW', { hour12: false }) : '尚無紀錄'}
              </span>
              <input ref={csvReplaceRef} type="file" accept=".csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) void handleCsvUpload(f, false); e.target.value = '' }} />
              <input ref={csvAppendRef} type="file" accept=".csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) void handleCsvUpload(f, true); e.target.value = '' }} />
              <div className="flex flex-col gap-1">
                <button onClick={() => csvReplaceRef.current?.click()} disabled={csvLoading}
                  className="px-4 py-2 rounded-lg bg-amber-700 hover:bg-amber-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium transition-colors whitespace-nowrap"
                  title="清空 buffer 後放入此 CSV（更新基底）">
                  📄 取代基底
                </button>
                <button onClick={() => csvAppendRef.current?.click()} disabled={csvLoading}
                  className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium transition-colors whitespace-nowrap"
                  title="在現有 buffer 後方加入新列">
                  ➕ 追加新列
                </button>
              </div>
              <button onClick={handleCsvDownload} disabled={csvRows.length === 0 || csvLoading}
                className="px-4 py-2 rounded-lg bg-sky-700 hover:bg-sky-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium transition-colors">
                ⬇ 下載合併 CSV
              </button>
              <button onClick={() => void handleCsvClear()} disabled={csvRows.length === 0 || csvLoading}
                className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 text-sm hover:bg-red-900/40 hover:text-red-300 hover:border-red-700/50 disabled:opacity-40 transition-colors">
                清空
              </button>
            </div>
          </div>
          {csvRows.length > 0 && (
            <div className="text-xs text-slate-500 font-mono bg-slate-900/60 rounded px-3 py-2 border border-slate-800">
              前 3 列預覽：{csvRows.slice(0, 3).map(r => `[${r[0]}, ${r[1]}, ${r[2]}...]`).join(' | ')}
            </div>
          )}
        </div>

        {/* 控制列 */}
        <div className="mb-4 flex flex-wrap gap-3 items-center justify-between">
          <div className="flex gap-2 items-center flex-wrap">
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as 'pending' | 'consumed' | 'all')}
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none"
            >
              <option value="all">全部狀態</option>
              <option value="pending">⏳ pending</option>
              <option value="consumed">✅ consumed</option>
            </select>
            <input
              type="text"
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              placeholder="篩選資料類型..."
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 w-44 focus:outline-none focus:border-cyan-500/50"
            />
            <span className="text-xs text-slate-500">共 <span className="text-cyan-300 font-mono font-semibold">{total}</span> 筆</span>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            {delMsg && <span className={`text-xs ${delMsg.startsWith('✅') ? 'text-emerald-400' : 'text-red-400'}`}>{delMsg}</span>}
            {selected.size > 0 && (
              <button onClick={() => void handleDelete()} disabled={deleting}
                className="px-3 py-2 rounded-lg bg-red-900/50 border border-red-700/50 text-red-300 text-sm hover:bg-red-800/60 disabled:opacity-50 transition-colors">
                🗑 刪除 {selected.size} 筆
              </button>
            )}
            <button onClick={() => void handleClearConsumed()} disabled={deleting}
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 text-sm hover:bg-slate-700 disabled:opacity-50 transition-colors">
              清除已消費
            </button>
            <button onClick={() => setShowAdd(v => !v)}
              className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm font-medium transition-colors">
              + 新增資料
            </button>
          </div>
        </div>

        {/* 新增表單 */}
        {showAdd && (
          <div className="mb-5 rounded-xl border border-cyan-800/40 bg-slate-900 p-5 space-y-3">
            <h3 className="text-sm font-semibold text-cyan-300">新增交換資料</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">資料類型 *</label>
                <input value={addType} onChange={e => setAddType(e.target.value)}
                  placeholder="如 mo_list, schedule, order_status"
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">參考鍵</label>
                <input value={addRef} onChange={e => setAddRef(e.target.value)}
                  placeholder="如 2026-08-06, MOT2601234..."
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50" />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">備註</label>
                <input value={addNote} onChange={e => setAddNote(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-sm text-slate-200 focus:outline-none focus:border-cyan-500/50" />
              </div>
            </div>
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Payload（JSON）</label>
              <textarea
                value={addPayload}
                onChange={e => setAddPayload(e.target.value)}
                rows={6}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500/50 resize-y"
              />
            </div>
            <div className="flex gap-3 items-center">
              <button onClick={() => void handleAdd()} disabled={adding}
                className="px-5 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50 text-white text-sm font-medium transition-colors">
                {adding ? '新增中...' : '確認新增'}
              </button>
              <button onClick={() => setShowAdd(false)}
                className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 text-sm hover:bg-slate-700 transition-colors">
                取消
              </button>
              {addMsg && <span className={`text-sm ${addMsg.startsWith('✅') ? 'text-emerald-400' : 'text-red-400'}`}>{addMsg}</span>}
            </div>
          </div>
        )}

        {/* 資料表格 */}
        <div className="rounded-xl border border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 bg-slate-900 text-slate-400 text-xs">
                <th className="px-3 py-2 w-8">
                  <input type="checkbox"
                    checked={rows.length > 0 && rows.every(r => selected.has(r.id))}
                    onChange={() => {
                      if (rows.every(r => selected.has(r.id))) setSelected(new Set())
                      else setSelected(new Set(rows.map(r => r.id)))
                    }}
                    className="accent-cyan-500 cursor-pointer" />
                </th>
                <th className="px-3 py-2 text-left w-16">ID</th>
                <th className="px-3 py-2 text-left">資料類型</th>
                <th className="px-3 py-2 text-left">參考鍵</th>
                <th className="px-3 py-2 text-left w-24">狀態</th>
                <th className="px-3 py-2 text-left w-40">建立時間</th>
                <th className="px-3 py-2 text-left w-40">拉取時間</th>
                <th className="px-3 py-2 text-left">備註</th>
                <th className="px-3 py-2 text-center w-16">Payload</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={9} className="text-center py-10 text-slate-500">載入中...</td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={9} className="text-center py-10 text-slate-500">暫無資料</td></tr>}
              {!loading && rows.map(r => (
                <>
                  <tr key={r.id} className="border-b border-slate-800 hover:bg-slate-900/40 transition-colors">
                    <td className="px-3 py-2 text-center">
                      <input type="checkbox" checked={selected.has(r.id)}
                        onChange={() => setSelected(prev => {
                          const n = new Set(prev); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n
                        })}
                        className="accent-cyan-500 cursor-pointer" />
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-500 text-xs">{r.id}</td>
                    <td className="px-3 py-2 font-mono text-cyan-300 text-xs">{r.data_type}</td>
                    <td className="px-3 py-2 font-mono text-slate-300 text-xs">{r.ref_key ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-0.5 rounded border text-[10px] font-medium ${STATUS_BADGE[r.status] ?? ''}`}>
                        {r.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-slate-400 text-xs whitespace-nowrap">
                      {new Date(r.created_at).toLocaleString('zh-TW', { hour12: false })}
                    </td>
                    <td className="px-3 py-2 text-slate-500 text-xs whitespace-nowrap">
                      {r.consumed_at ? new Date(r.consumed_at).toLocaleString('zh-TW', { hour12: false }) : '—'}
                    </td>
                    <td className="px-3 py-2 text-slate-400 text-xs">{r.note ?? ''}</td>
                    <td className="px-3 py-2 text-center">
                      <button
                        onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                        className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-xs text-slate-300 hover:bg-slate-700 transition-colors"
                      >
                        {expandedId === r.id ? '收起' : '展開'}
                      </button>
                    </td>
                  </tr>
                  {expandedId === r.id && (
                    <tr key={`${r.id}-payload`} className="bg-slate-900/60">
                      <td colSpan={9} className="px-6 py-3">
                        <pre className="text-xs font-mono text-slate-300 overflow-x-auto max-h-80 bg-slate-950 rounded p-3 border border-slate-800">
                          {JSON.stringify(r.payload, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>

      </div>
    </div>
  )
}
