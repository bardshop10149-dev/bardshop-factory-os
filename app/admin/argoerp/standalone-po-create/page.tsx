'use client'

/**
 * 單獨開立採購單
 * ArgoERP IFAF024 — 不依賴出單表，直接由 SO+批號 查詢明細後建立採購單
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../../lib/supabaseClient'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface LineItem {
  so:            string
  lot_no:        string
  item_code:     string
  description:   string
  quantity:      string
  delivery_date: string
  so_line_no:    string
  uom:           string
  unit_price:    string
  remark2:       string
  packing:       string
}

interface SoLineRaw {
  project_id: string
  line_no: string
  mbp_part: string | null
  description: string | null
  order_qty_oru: number | null
  unit_of_measure_oru: string | null
  duedate: string | null
  remark2: string | null
  packing: string | null
}

interface PoHeader {
  project_id:     string
  modify_ver:     string
  begin_date:     string
  hold_status:    'UNSIGNED' | 'HOLD' | 'CLOSE' | 'OPEN'
  tpn_partner_id: string
  department:     string
  sales_id:       string
  po_type:        'GENERAL' | 'IMPORT'
  payment_term:   string
  payment_mode:   'C' | 'L' | 'N' | 'T'
  currency:       string
  exchange_rate:  string
  tax_rate:       string
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const HEADER_KEY = 'argoerp_po_standalone_header_v1'

const ERP_KEYS = [
  'PROJECT_ID', 'MODIFY_VER', 'BEGIN_DATE', 'HOLD_STATUS',
  'TPN_PARTNER_ID', 'SEG_SEGMENT_NO_DEPARTMENT', 'SALES_ID', 'PO_TYPE',
  'PAYMENT_TERM', 'PAYMENT_MODE', 'CURRENCY', 'EXCHANGE_RATE', 'TAX_RATE',
  'LINE_NO', 'MBP_PART', 'MBP_VER', 'ORDER_QTY_ORU', 'UNIT_OF_MEASURE_ORU',
  'UNIT_PRICE_ORU', 'DUEDATE', 'MBP_LOT_NO', 'REMARK', 'REMARK2', 'PACKING', 'SO_PROJECT_ID', 'TPN_PART_NO',
] as const

const BLANK_ITEM: LineItem = {
  so: '', lot_no: '', item_code: '', description: '',
  quantity: '', delivery_date: '', so_line_no: '',
  uom: 'PCS', unit_price: '0', remark2: '', packing: '',
}

function fmtDate(d: Date) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function pocPrefixToday() {
  const d = new Date()
  return `POC${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

async function fetchNextPocNo(): Promise<string> {
  const prefix = pocPrefixToday()
  const res = await fetch('/api/argoerp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'query', table: 'PJ_PROJECT',
      filters: { PROJECT_ID: `LIKE '${prefix}%'` },
      customColumn: 'PROJECT_ID',
    }),
  })
  const j = await res.json()
  if (!res.ok || !j?.success) throw new Error(j?.error || `查詢 ARGO 採購單號失敗（HTTP ${res.status}）`)
  const rows = Array.isArray(j.apiResult?.RESULT) ? (j.apiResult.RESULT as Array<Record<string, unknown>>) : []
  let maxSeq = 0
  for (const rec of rows) {
    const docNo = String(rec?.PROJECT_ID ?? '').trim().toUpperCase()
    if (!docNo.startsWith(prefix)) continue
    const seq = parseInt(docNo.slice(prefix.length), 10)
    if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq
  }
  return `${prefix}${String(maxSeq + 1).padStart(2, '0')}`
}

function makeDefaultHeader(): PoHeader {
  return {
    project_id: '', modify_ver: '1', begin_date: fmtDate(new Date()),
    hold_status: 'UNSIGNED', tpn_partner_id: 'C01510', department: 'M1100',
    sales_id: '10149', po_type: 'GENERAL', payment_term: 'PM30',
    payment_mode: 'T', currency: 'CNY', exchange_rate: '4', tax_rate: '0',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
export default function StandalonePoCreatePage() {
  const [unlocked, setUnlocked] = useState(false)
  const [pwInput, setPwInput]   = useState('')
  const [pwError, setPwError]   = useState(false)

  const [header, setHeader]         = useState<PoHeader>(makeDefaultHeader)
  const [headerOpen, setHeaderOpen] = useState(true)
  const [lineItems, setLineItems]   = useState<LineItem[]>([])
  const [msg, setMsg]               = useState('')
  const [importing, setImporting]   = useState(false)

  // SO 查詢
  const [soInput, setSoInput]       = useState('')
  const [lotInput, setLotInput]     = useState('')
  const [soFetching, setSoFetching] = useState(false)
  const [fetchedLines, setFetchedLines] = useState<SoLineRaw[]>([])
  const [selectedIdxs, setSelectedIdxs] = useState<Set<number>>(new Set())

  // 取號
  const [poNoLoading, setPoNoLoading] = useState(false)

  // ── localStorage ──
  useEffect(() => {
    try {
      const saved = localStorage.getItem(HEADER_KEY)
      if (saved) {
        const s = JSON.parse(saved)
        const def = makeDefaultHeader()
        const merged: PoHeader = { ...def, ...s }
        for (const k of Object.keys(def) as (keyof PoHeader)[])
          if ((s[k] ?? '') === '') (merged as unknown as Record<string, unknown>)[k] = def[k]
        merged.project_id = ''
        merged.begin_date = fmtDate(new Date())
        setHeader(merged)
      }
    } catch { /* empty */ }
  }, [])
  useEffect(() => { localStorage.setItem(HEADER_KEY, JSON.stringify(header)) }, [header])

  const setH = useCallback(<K extends keyof PoHeader>(k: K, v: PoHeader[K]) => {
    setHeader(p => ({ ...p, [k]: v }))
  }, [])

  const setItem = useCallback((i: number, field: keyof LineItem, val: string) => {
    setLineItems(p => p.map((item, j) => j === i ? { ...item, [field]: val } : item))
  }, [])

  // ── 查詢 SO 明細 ──
  const handleQuerySo = useCallback(async () => {
    const so = soInput.trim()
    if (!so) return
    setSoFetching(true)
    setFetchedLines([])
    try {
      const { data, error } = await supabase
        .from('erp_so_lines')
        .select('project_id, line_no, mbp_part, description, order_qty_oru, unit_of_measure_oru, duedate, remark2, packing')
        .eq('project_id', so)
        .order('line_no', { ascending: true })
      if (error) throw error
      const lines = (data ?? []) as SoLineRaw[]
      setFetchedLines(lines)
      setSelectedIdxs(new Set(lines.map((_, i) => i)))
      if (lines.length === 0) setMsg(`⚠️ ${so} 查無 SO 明細（確認已同步 erp_so_lines）`)
    } catch (e) {
      setMsg(`❌ 查詢失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSoFetching(false)
    }
  }, [soInput])

  // ── 加入選取的明細 ──
  const handleAddSelected = useCallback(() => {
    const so  = soInput.trim()
    const lot = lotInput.trim() || so
    const toAdd = fetchedLines.filter((_, i) => selectedIdxs.has(i))
    const newItems: LineItem[] = toAdd.map(l => ({
      so,
      lot_no:        lot,
      item_code:     l.mbp_part || '',
      description:   l.description || '',
      quantity:      l.order_qty_oru != null ? String(l.order_qty_oru) : '',
      delivery_date: l.duedate ? l.duedate.slice(0, 10).replace(/-/g, '/') : '',
      so_line_no:    String(l.line_no || ''),
      uom:           l.unit_of_measure_oru || 'PCS',
      unit_price:    '0',
      remark2:       l.remark2 || '',
      packing:       l.packing || '',
    }))
    setLineItems(prev => [...prev, ...newItems])
    setFetchedLines([])
    setSoInput('')
    setLotInput('')
    setSelectedIdxs(new Set())
  }, [soInput, lotInput, fetchedLines, selectedIdxs])

  // ── 手動新增空行 ──
  const handleAddBlank = useCallback(() => {
    setLineItems(prev => [...prev, { ...BLANK_ITEM }])
  }, [])

  // ── 刪除明細列 ──
  const handleDeleteRow = useCallback((i: number) => {
    setLineItems(prev => prev.filter((_, j) => j !== i))
  }, [])

  // ── 取號 ──
  const handleFetchPoNo = useCallback(async () => {
    setPoNoLoading(true)
    try {
      const next = await fetchNextPocNo()
      setHeader(p => ({ ...p, project_id: next }))
      setMsg(`✅ 已取得最新採購單號：${next}`)
    } catch (e) {
      setMsg(`❌ 取號失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPoNoLoading(false); setTimeout(() => setMsg(''), 8000)
    }
  }, [])

  // ── Payload ──
  const payload = useMemo<Array<Record<string, string>>>(() => {
    return lineItems.map((item, i) => {
      const rec: Record<string, string> = {}
      rec['PROJECT_ID']                  = header.project_id
      rec['MODIFY_VER']                  = header.modify_ver
      rec['BEGIN_DATE']                  = header.begin_date
      rec['HOLD_STATUS']                 = header.hold_status
      if (header.tpn_partner_id.trim()) rec['TPN_PARTNER_ID']            = header.tpn_partner_id.trim()
      if (header.department.trim())     rec['SEG_SEGMENT_NO_DEPARTMENT'] = header.department.trim()
      if (header.sales_id.trim())       rec['SALES_ID']                  = header.sales_id.trim()
      rec['PO_TYPE']                     = header.po_type
      if (header.payment_term.trim())   rec['PAYMENT_TERM']              = header.payment_term.trim()
      rec['PAYMENT_MODE']                = header.payment_mode
      rec['CURRENCY']                    = header.currency
      rec['EXCHANGE_RATE']               = header.exchange_rate
      rec['TAX_RATE']                    = header.tax_rate
      rec['LINE_NO']                     = String(i + 1)
      rec['MBP_PART']                    = item.item_code
      rec['MBP_VER']                     = '1'
      rec['ORDER_QTY_ORU']               = item.quantity
      rec['UNIT_OF_MEASURE_ORU']         = item.uom || 'PCS'
      rec['UNIT_PRICE_ORU']              = item.unit_price || '0'
      rec['DUEDATE']                     = item.delivery_date
      if (item.lot_no.trim())        rec['MBP_LOT_NO']   = item.lot_no.trim()
      if (item.description.trim())   rec['REMARK']        = item.description.trim()
      if (item.remark2.trim())       rec['REMARK2']       = item.remark2.trim()
      if (item.so.trim())            rec['SO_PROJECT_ID'] = item.so.trim()
      if (item.packing.trim())       rec['PACKING']       = item.packing.trim()
      if (item.so_line_no.trim())    rec['TPN_PART_NO']   = item.so_line_no.trim()
      return rec
    })
  }, [lineItems, header])

  // ── 匯入 ERP ──
  const handleImport = useCallback(async () => {
    if (!header.tpn_partner_id.trim()) { alert('請填寫廠商編號'); return }
    if (payload.length === 0) { alert('尚無明細資料'); return }
    setImporting(true); setMsg('')
    let pid = ''
    try {
      pid = await fetchNextPocNo()
      setHeader(p => ({ ...p, project_id: pid }))
    } catch (e) {
      setImporting(false)
      const m = `❌ 取號失敗，未匯入：${e instanceof Error ? e.message : String(e)}`
      setMsg(m); alert(m); setTimeout(() => setMsg(''), 10000)
      return
    }
    try {
      const importPayload = payload.map(r => ({ ...r, PROJECT_ID: pid }))
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', interfaceId: 'IFAF024', data: importPayload }),
      })
      const result = await res.json()
      if (res.ok && result?.success) {
        const m = `✅ 採購單 ${pid} 已匯入 ERP（${payload.length} 筆明細）`
        setMsg(m); alert(m)
        setLineItems([])
      } else {
        const raw = typeof result?.rawText === 'string'
          ? result.rawText.slice(0, 500)
          : JSON.stringify(result?.apiResult ?? '').slice(0, 500)
        throw new Error(`${result?.error || `HTTP ${res.status}`}\n\n【ARGO 回應】\n${raw}`)
      }
    } catch (e) {
      const m = `❌ 匯入失敗：${e instanceof Error ? e.message : String(e)}`
      setMsg(m); alert(m)
    } finally {
      setImporting(false); setTimeout(() => setMsg(''), 10000)
    }
  }, [payload, header.tpn_partner_id])

  // ─────────────────────────────────────────────────────────────────────────────
  // Render — 密碼鎖
  // ─────────────────────────────────────────────────────────────────────────────
  if (!unlocked) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-8 w-80 flex flex-col items-center gap-4">
          <div className="text-2xl">🔒</div>
          <h2 className="text-white font-semibold text-lg">單獨開立採購單</h2>
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
            className={`w-full px-4 py-2 rounded-lg bg-slate-800 border text-white text-center tracking-widest focus:outline-none ${pwError ? 'border-red-500' : 'border-slate-600 focus:border-orange-500'}`}
          />
          {pwError && <p className="text-red-400 text-xs">密碼錯誤</p>}
          <button
            onClick={() => { if (pwInput === '666') setUnlocked(true); else { setPwError(true); setPwInput('') } }}
            className="w-full py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-medium transition-colors"
          >進入</button>
        </div>
      </div>
    )
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Render — 主頁面
  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1800px] mx-auto">

        {/* ── Page Header ── */}
        <div className="mb-6 border-b border-slate-800 pb-4">
          <h1 className="text-3xl font-bold tracking-tight">單獨開立採購單</h1>
          <p className="text-slate-400 mt-1 text-sm">ArgoERP IFAF024｜輸入銷售訂單號＋批號查出明細，逐筆加入後一次匯入 ERP</p>
        </div>

        {/* ── Message bar ── */}
        {msg && (
          <div className={`mb-4 px-4 py-3 rounded-lg text-sm ${msg.startsWith('❌') ? 'bg-red-900/30 border border-red-700 text-red-300' : msg.startsWith('⚠') ? 'bg-amber-900/30 border border-amber-700 text-amber-300' : 'bg-emerald-900/30 border border-emerald-700 text-emerald-300'}`}>
            {msg}
          </div>
        )}

        {/* ── SO 查詢面板 ── */}
        <div className="mb-6 bg-slate-900 border border-sky-800/40 rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-sky-900/20 border-b border-sky-800/30">
            <span className="text-sm font-semibold text-sky-300">🔍 由銷售訂單查詢明細</span>
          </div>
          <div className="px-4 py-4 flex flex-wrap gap-3 items-end">
            <div>
              <label className="text-xs text-slate-400 block mb-1">銷售訂單號 <span className="text-red-400">*</span></label>
              <input
                value={soInput}
                onChange={e => setSoInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void handleQuerySo()}
                placeholder="SO260803001…"
                className="px-3 py-1.5 rounded-lg bg-slate-800 border border-sky-700/50 text-white font-mono text-sm focus:outline-none focus:border-sky-400 w-48"
              />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">批號（MBP_LOT_NO）</label>
              <input
                value={lotInput}
                onChange={e => setLotInput(e.target.value)}
                placeholder="留空則帶 SO 號…"
                className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white font-mono text-sm focus:outline-none focus:border-sky-400 w-48"
              />
            </div>
            <button
              onClick={() => void handleQuerySo()}
              disabled={!soInput.trim() || soFetching}
              className="px-4 py-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium text-sm transition-colors"
            >
              {soFetching ? '查詢中…' : '查詢'}
            </button>
          </div>

          {/* 查詢結果 */}
          {fetchedLines.length > 0 && (
            <div className="border-t border-sky-800/30 px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-sky-300">{soInput} 共 {fetchedLines.length} 筆明細</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setSelectedIdxs(new Set(fetchedLines.map((_, i) => i)))}
                    className="text-xs text-slate-400 hover:text-sky-300 transition-colors"
                  >全選</button>
                  <span className="text-slate-600">|</span>
                  <button
                    onClick={() => setSelectedIdxs(new Set())}
                    className="text-xs text-slate-400 hover:text-red-300 transition-colors"
                  >全消</button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-800/60 border-b border-slate-700 text-slate-400">
                      <th className="px-2 py-2 text-center w-8">✓</th>
                      <th className="px-2 py-2 text-center">序號</th>
                      <th className="px-3 py-2 text-left">貨號</th>
                      <th className="px-3 py-2 text-left">品名規格</th>
                      <th className="px-2 py-2 text-right">數量</th>
                      <th className="px-2 py-2 text-center">單位</th>
                      <th className="px-3 py-2 text-left">交貨日</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fetchedLines.map((l, i) => (
                      <tr
                        key={i}
                        className={`border-b border-slate-800/50 cursor-pointer hover:bg-slate-800/50 ${selectedIdxs.has(i) ? 'bg-sky-950/30' : ''}`}
                        onClick={() => setSelectedIdxs(prev => {
                          const n = new Set(prev)
                          n.has(i) ? n.delete(i) : n.add(i)
                          return n
                        })}
                      >
                        <td className="px-2 py-1.5 text-center">
                          <input
                            type="checkbox" readOnly checked={selectedIdxs.has(i)}
                            className="accent-sky-500"
                          />
                        </td>
                        <td className="px-2 py-1.5 text-center font-mono text-slate-400">{l.line_no}</td>
                        <td className="px-3 py-1.5 font-mono text-purple-300">{l.mbp_part || '—'}</td>
                        <td className="px-3 py-1.5 text-slate-300 max-w-[280px] truncate">{l.description || '—'}</td>
                        <td className="px-2 py-1.5 text-right text-slate-300">{l.order_qty_oru ?? '—'}</td>
                        <td className="px-2 py-1.5 text-center text-slate-400">{l.unit_of_measure_oru || '—'}</td>
                        <td className="px-3 py-1.5 text-yellow-400/80">{l.duedate ? l.duedate.slice(0, 10) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={handleAddSelected}
                  disabled={selectedIdxs.size === 0}
                  className="px-4 py-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium text-sm transition-colors"
                >
                  ＋加入明細（{selectedIdxs.size} 筆）
                </button>
                <button
                  onClick={() => { setFetchedLines([]); setSelectedIdxs(new Set()) }}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-red-300 text-sm transition-colors"
                >取消</button>
                <span className="text-xs text-slate-500">批號：{lotInput.trim() || soInput.trim() || '（帶入 SO 號）'}</span>
              </div>
            </div>
          )}
        </div>

        {/* ── PO Header Config ── */}
        <div className="mb-6 bg-slate-900 border border-orange-800/40 rounded-lg overflow-hidden">
          <button
            onClick={() => setHeaderOpen(p => !p)}
            className="w-full px-4 py-3 flex items-center justify-between text-left bg-orange-900/20 hover:bg-orange-900/30 transition-colors"
          >
            <span className="text-sm font-semibold text-orange-300">📋 採購單表頭設定（IFAF024 Header）</span>
            <span className="text-slate-400 text-sm">{headerOpen ? '▲ 收起' : '▼ 展開'}</span>
          </button>
          {headerOpen && (
            <div className="px-4 py-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              <div className="col-span-2 md:col-span-1">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label className="text-xs text-slate-400">採購單號 <span className="text-slate-500">（自動取號）</span></label>
                  <button onClick={() => void handleFetchPoNo()} disabled={poNoLoading}
                    className="shrink-0 px-2 py-0.5 rounded bg-indigo-700 hover:bg-indigo-600 disabled:bg-slate-700 disabled:text-slate-500 text-white text-xs whitespace-nowrap">
                    {poNoLoading ? '取號中…' : '抓最新單號'}
                  </button>
                </div>
                <input value={header.project_id} readOnly placeholder="匯入時自動取號"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-orange-600/60 text-slate-300 text-sm focus:outline-none font-mono cursor-default" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">開立日期 <span className="text-red-400">*</span></label>
                <input value={header.begin_date} onChange={e => setH('begin_date', e.target.value)} placeholder="YYYY/MM/DD"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">訂單狀態 <span className="text-red-400">*</span></label>
                <select value={header.hold_status} onChange={e => setH('hold_status', e.target.value as PoHeader['hold_status'])}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none">
                  <option value="UNSIGNED">UNSIGNED</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">廠商編號 <span className="text-red-400">*</span></label>
                <input value={header.tpn_partner_id} onChange={e => setH('tpn_partner_id', e.target.value)} placeholder="GLAF004 廠商代碼"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400 font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">部門 <span className="text-red-400">*</span></label>
                <input value={header.department} onChange={e => setH('department', e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400 font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">業務員 <span className="text-red-400">*</span></label>
                <input value={header.sales_id} onChange={e => setH('sales_id', e.target.value)} placeholder="員工編號"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400 font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">訂單類別 <span className="text-red-400">*</span></label>
                <select value={header.po_type} onChange={e => setH('po_type', e.target.value as PoHeader['po_type'])}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none">
                  <option value="GENERAL">GENERAL（一般）</option>
                  <option value="IMPORT">IMPORT（進口/L/C）</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">付款條件 <span className="text-red-400">*</span></label>
                <input value={header.payment_term} onChange={e => setH('payment_term', e.target.value)} placeholder="GLAF005 條件代碼"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400 font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">付款方式 <span className="text-red-400">*</span></label>
                <select value={header.payment_mode} onChange={e => setH('payment_mode', e.target.value as PoHeader['payment_mode'])}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none">
                  <option value="T">T — T/T</option>
                  <option value="C">C — Cash</option>
                  <option value="L">L — LCM</option>
                  <option value="N">N — Bills</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">幣別 <span className="text-red-400">*</span></label>
                <input value={header.currency} onChange={e => setH('currency', e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400 font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">匯率 <span className="text-red-400">*</span></label>
                <input value={header.exchange_rate} onChange={e => setH('exchange_rate', e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">稅率 <span className="text-red-400">*</span></label>
                <input value={header.tax_rate} onChange={e => setH('tax_rate', e.target.value)} placeholder="0.05 / 0.13 / 0"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400" />
              </div>
            </div>
          )}
        </div>

        {/* ── Status bar + Actions ── */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-3 flex-wrap text-sm">
            <span className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300">
              採購單號：<span className="font-mono text-orange-300">{header.project_id || '—'}</span>
            </span>
            <span className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300">
              廠商：<span className="font-mono text-white">{header.tpn_partner_id || <span className="text-red-400">未填</span>}</span>
            </span>
            <span className={`px-3 py-1.5 rounded-lg border text-sm font-bold ${lineItems.length > 0 ? 'bg-orange-900/30 border-orange-700/50 text-orange-300' : 'bg-slate-800 border-slate-700 text-slate-600'}`}>
              {lineItems.length} 筆明細
            </span>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={handleAddBlank}
              className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 border border-slate-600 text-white text-sm transition-colors"
            >＋手動新增一列</button>
            {lineItems.length > 0 && (
              <>
                <button
                  onClick={() => void handleImport()}
                  disabled={importing}
                  className="px-4 py-2 rounded-lg bg-orange-700 hover:bg-orange-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold text-sm transition-colors"
                >{importing ? '匯入中…' : '🚀 匯入 ERP（IFAF024）'}</button>
                <button
                  onClick={() => setLineItems([])}
                  className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:bg-red-900/40 hover:text-red-300 hover:border-red-700/50 transition-colors text-sm"
                >全部清空</button>
              </>
            )}
          </div>
        </div>

        {/* ── Line items table ── */}
        {lineItems.length > 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700 bg-orange-900/20">
              <h2 className="text-sm font-semibold text-orange-300">
                採購明細（{lineItems.length} 筆）
                <span className="text-xs text-slate-400 font-normal ml-2">橘色欄位可編輯</span>
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800/80 border-b border-slate-700 text-xs">
                    <th className="px-2 py-3 text-center text-slate-500 w-8">#</th>
                    <th className="px-3 py-3 text-left text-slate-300">來源 SO</th>
                    <th className="px-3 py-3 text-left text-orange-300">批號 *</th>
                    <th className="px-3 py-3 text-center text-sky-300">SO序號</th>
                    <th className="px-3 py-3 text-left text-slate-300">貨號 *</th>
                    <th className="px-3 py-3 text-left text-slate-300">品名規格 (REMARK)</th>
                    <th className="px-3 py-3 text-right text-slate-300">數量 *</th>
                    <th className="px-3 py-3 text-center text-orange-300">單位</th>
                    <th className="px-3 py-3 text-right text-orange-300">單價</th>
                    <th className="px-3 py-3 text-left text-slate-300">交貨日 *</th>
                    <th className="px-3 py-3 text-left text-orange-300">備註2</th>
                    <th className="px-3 py-3 text-left text-sky-300">包裝方式</th>
                    <th className="px-2 py-3 text-center text-slate-500 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {lineItems.map((item, i) => (
                    <tr key={i} className={`border-b border-slate-800/50 ${i % 2 === 0 ? '' : 'bg-slate-900/40'} hover:bg-slate-800/30`}>
                      <td className="px-2 py-1 text-center text-slate-500 font-mono text-xs">{i + 1}</td>
                      <td className="px-1 py-1">
                        <input value={item.so} onChange={e => setItem(i, 'so', e.target.value)}
                          placeholder="SO…" className="w-32 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-sky-200 font-mono text-xs focus:outline-none focus:border-sky-500" />
                      </td>
                      <td className="px-1 py-1">
                        <input value={item.lot_no} onChange={e => setItem(i, 'lot_no', e.target.value)}
                          placeholder="批號…" className="w-32 px-2 py-1 rounded bg-slate-800 border border-orange-700/50 text-orange-200 font-mono text-xs focus:outline-none focus:border-orange-400" />
                      </td>
                      <td className="px-1 py-1">
                        <input value={item.so_line_no} onChange={e => setItem(i, 'so_line_no', e.target.value)}
                          className="w-16 px-2 py-1 rounded bg-slate-800 border border-sky-700/40 text-sky-200 text-xs text-center focus:outline-none focus:border-sky-400" />
                      </td>
                      <td className="px-1 py-1">
                        <input value={item.item_code} onChange={e => setItem(i, 'item_code', e.target.value)}
                          placeholder="貨號…" className="w-28 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-white font-mono text-xs focus:outline-none focus:border-orange-400" />
                      </td>
                      <td className="px-1 py-1">
                        <input value={item.description} onChange={e => setItem(i, 'description', e.target.value)}
                          placeholder="品名規格…" className="w-48 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300 text-xs focus:outline-none focus:border-orange-400" />
                      </td>
                      <td className="px-1 py-1">
                        <input value={item.quantity} onChange={e => setItem(i, 'quantity', e.target.value)}
                          className="w-20 px-2 py-1 rounded bg-slate-800 border border-orange-700/40 text-white text-xs text-right focus:outline-none focus:border-orange-400" />
                      </td>
                      <td className="px-1 py-1">
                        <input value={item.uom} onChange={e => setItem(i, 'uom', e.target.value)}
                          className="w-16 px-2 py-1 rounded bg-slate-800 border border-orange-700/40 text-white text-xs text-center focus:outline-none focus:border-orange-400" />
                      </td>
                      <td className="px-1 py-1">
                        <input value={item.unit_price} onChange={e => setItem(i, 'unit_price', e.target.value)}
                          className="w-20 px-2 py-1 rounded bg-slate-800 border border-orange-700/40 text-white text-xs text-right focus:outline-none focus:border-orange-400" />
                      </td>
                      <td className="px-1 py-1">
                        <input value={item.delivery_date} onChange={e => setItem(i, 'delivery_date', e.target.value)}
                          placeholder="YYYY/MM/DD" className="w-28 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-yellow-400/80 text-xs focus:outline-none focus:border-orange-400" />
                      </td>
                      <td className="px-1 py-1">
                        <input value={item.remark2} onChange={e => setItem(i, 'remark2', e.target.value)}
                          placeholder="備註2…" className="w-28 px-2 py-1 rounded bg-slate-800 border border-orange-700/40 text-white text-xs focus:outline-none focus:border-orange-400" />
                      </td>
                      <td className="px-1 py-1">
                        <input value={item.packing} onChange={e => setItem(i, 'packing', e.target.value)}
                          placeholder="包裝…" className="w-24 px-2 py-1 rounded bg-slate-800 border border-sky-700/40 text-sky-200 text-xs focus:outline-none focus:border-sky-400" />
                      </td>
                      <td className="px-2 py-1 text-center">
                        <button onClick={() => handleDeleteRow(i)} title="移除"
                          className="text-slate-600 hover:text-red-400 text-lg leading-none transition-colors">×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-12 text-center">
            <p className="text-slate-500">尚無明細</p>
            <p className="text-slate-600 text-xs mt-2">
              透過上方「由銷售訂單查詢」面板新增，或點「手動新增一列」直接輸入
            </p>
          </div>
        )}

      </div>
    </div>
  )
}
