'use client'

import React, { useState, useCallback, useEffect } from 'react'
import { supabase } from '../../../../lib/supabaseClient'
import SoOrderModal from '../../../../components/SoOrderModal'

// ── 型別 ─────────────────────────────────────────────────────────────────────
interface PendingRow {
  sheet_date: string
  row_key?: string
  order_number: string
  factory: string
  customer?: string
  item_code?: string
  item_name?: string
  note?: string
  quantity: string
  delivery_date: string
  mo_status?: string | null
  mo_number: string
  match_line_no?: string | null
  material_prep_status?: string | null
  argo_slip_no?: string | null
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

interface BomMaterial {
  material_code: string
  material_name: string | null
  unit: string | null
  bom_qty: number
  bom_base: number
  inventory_qty: number | null
  is_custom: boolean
}

type PartInfo = { name: string | null; unit: string | null; inventory: number | null }

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

// ── MO 詳細 Modal ────────────────────────────────────────────────────
function MoDetailModal({ moNumber, onClose }: { moNumber: string; onClose: () => void }) {
  const [lines, setLines]     = useState<MoLine[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr]         = useState<string | null>(null)

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
        setLines([...(data as MoLine[])].sort((a, b) =>
          a.line_no.localeCompare(b.line_no, undefined, { numeric: true })
        ))
      })
    return () => { cancelled = true }
  }, [moNumber])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const holdStatus = lines[0]?.hold_status ?? null
  const holdCls =
    holdStatus === 'OPEN'  ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' :
    holdStatus === 'CLOSE' ? 'bg-slate-800 text-slate-500 border-slate-700' :
    holdStatus === 'HOLD'  ? 'bg-red-900/40 text-red-300 border-red-700/50' :
    holdStatus             ? 'bg-amber-900/40 text-amber-300 border-amber-700/50' : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700 flex-shrink-0">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-slate-400 text-sm">製令工單</span>
            <span className="font-mono text-violet-300 font-semibold text-lg">{moNumber}</span>
            {holdCls && holdStatus && (
              <span className={`px-2 py-0.5 text-xs rounded border ${holdCls}`}>{holdStatus}</span>
            )}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg leading-none ml-4">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading && <p className="text-slate-400 text-sm text-center py-10">載入中…</p>}
          {err    && <p className="text-red-400 text-sm text-center py-10">{err}</p>}
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
                  <tr key={l.line_no} className="border-b border-slate-800 hover:bg-slate-800/50">
                    <td className="py-2 pr-4 font-mono text-slate-300">{l.line_no}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-cyan-400">{l.mbp_part ?? '—'}</td>
                    <td className="py-2 pr-4 text-slate-400 text-xs">{l.mbp_lot_no ?? '—'}</td>
                    <td className="py-2 pr-4 text-right font-semibold text-amber-300">
                      {l.order_qty != null ? l.order_qty.toLocaleString() : '—'}
                    </td>
                    <td className="py-2 pr-4 text-slate-400 text-xs whitespace-nowrap">{l.begin_date ? normDate(l.begin_date) : '—'}</td>
                    <td className="py-2 pr-4 text-slate-400 text-xs whitespace-nowrap">{l.end_date ? normDate(l.end_date) : '—'}</td>
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
export default function ShortageTrackingPage() {
  const [rows,         setRows]         = useState<PendingRow[]>([])
  const [loading,      setLoading]      = useState(false)
  const [errMsg,       setErrMsg]       = useState('')
  const [loadedAt,     setLoadedAt]     = useState<Date | null>(null)
  const [filterFactory, setFilterFactory] = useState<'ALL' | 'T' | 'C' | 'O'>('ALL')

  // Modals
  const [soModal, setSoModal] = useState<string | null>(null)
  const [moModal, setMoModal] = useState<string | null>(null)

  // ── BOM 展開狀態 ──
  const [expandedMos, setExpandedMos] = useState<Set<string>>(new Set())
  const [bomCache, setBomCache] = useState<Map<string, BomMaterial[]>>(new Map())
  const [loadingBomSet, setLoadingBomSet] = useState<Set<string>>(new Set())
  const [customMaterials, setCustomMaterials] = useState<Record<string, string[]>>(() => {
    if (typeof window === 'undefined') return {}
    try { return JSON.parse(localStorage.getItem('shortage_custom') ?? '{}') as Record<string, string[]> }
    catch { return {} }
  })
  const [customPartInfo, setCustomPartInfo] = useState<Record<string, PartInfo>>({})
  const [materialNotes, setMaterialNotes] = useState<Record<string, string>>(() => {
    if (typeof window === 'undefined') return {}
    try { return JSON.parse(localStorage.getItem('shortage_notes') ?? '{}') as Record<string, string> }
    catch { return {} }
  })
  const [customInputs, setCustomInputs] = useState<Record<string, string>>({})

  const loadData = useCallback(async () => {
    setLoading(true)
    setErrMsg('')
    setRows([])
    try {
      const res  = await fetch('/api/argoerp/pending-prep')
      const json = await res.json() as { success: boolean; rows?: PendingRow[]; error?: string }
      if (!json.success) throw new Error(json.error ?? `HTTP ${res.status}`)
      setRows(json.rows ?? [])
      setLoadedAt(new Date())
    } catch (e) {
      setErrMsg(`載入失敗：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  // ── BOM 展開 ──
  const toggleExpand = useCallback(async (moNumber: string, itemCode: string | undefined) => {
    setExpandedMos(prev => {
      const next = new Set(prev)
      if (next.has(moNumber)) { next.delete(moNumber); return next }
      next.add(moNumber)
      return next
    })
    if (!itemCode || bomCache.has(itemCode)) return
    setLoadingBomSet(prev => new Set([...prev, moNumber]))
    try {
      type RawBom = { child_part: string; lot_child_qty: number | null; lot_base: number | null; bom_ver: number }
      const { data: bomData } = await supabase
        .from('mm_bom_structure')
        .select('child_part, lot_child_qty, lot_base, bom_ver')
        .eq('parent_part', itemCode)
      const raw = (bomData ?? []) as RawBom[]
      if (raw.length === 0) {
        setBomCache(prev => new Map([...prev, [itemCode, []]]))
        return
      }
      const minVer = Math.min(...raw.map(r => r.bom_ver))
      const filtered = raw.filter(r => r.bom_ver === minVer)
      const materialCodes = [...new Set(filtered.map(r => r.child_part).filter(Boolean))]
      const [partRes, invRes] = await Promise.all([
        supabase.from('mm_bom_part_units').select('part_code, part_name, unit_of_measure').in('part_code', materialCodes),
        supabase.from('material_inventory_list').select('item_code, book_count').in('item_code', materialCodes),
      ])
      type PartUnit = { part_code: string; part_name: string | null; unit_of_measure: string | null }
      type InvRow   = { item_code: string; book_count: number | null }
      const partMap: Record<string, PartInfo> = {}
      ;((partRes.data ?? []) as PartUnit[]).forEach(p => {
        partMap[p.part_code] = { name: p.part_name, unit: p.unit_of_measure, inventory: null }
      })
      ;((invRes.data ?? []) as InvRow[]).forEach(iv => {
        if (!partMap[iv.item_code]) partMap[iv.item_code] = { name: null, unit: null, inventory: null }
        partMap[iv.item_code].inventory = iv.book_count
      })
      const materials: BomMaterial[] = filtered.map(r => ({
        material_code: r.child_part,
        material_name: partMap[r.child_part]?.name ?? null,
        unit: partMap[r.child_part]?.unit ?? null,
        bom_qty: r.lot_child_qty ?? 0,
        bom_base: r.lot_base ?? 1,
        inventory_qty: partMap[r.child_part]?.inventory ?? null,
        is_custom: false,
      }))
      setBomCache(prev => new Map([...prev, [itemCode, materials]]))
    } catch { /* silent */ }
    finally {
      setLoadingBomSet(prev => { const next = new Set(prev); next.delete(moNumber); return next })
    }
  }, [bomCache])

  const addCustomMaterial = useCallback(async (moNumber: string, code: string) => {
    const trimmed = code.trim().toUpperCase()
    if (!trimmed) return
    const existing = customMaterials[moNumber] ?? []
    if (existing.includes(trimmed)) return
    const updated = { ...customMaterials, [moNumber]: [...existing, trimmed] }
    setCustomMaterials(updated)
    localStorage.setItem('shortage_custom', JSON.stringify(updated))
    setCustomInputs(prev => ({ ...prev, [moNumber]: '' }))
    if (!customPartInfo[trimmed]) {
      const [partRes, invRes] = await Promise.all([
        supabase.from('mm_bom_part_units').select('part_name, unit_of_measure').eq('part_code', trimmed).maybeSingle(),
        supabase.from('material_inventory_list').select('book_count').eq('item_code', trimmed).maybeSingle(),
      ])
      type P = { part_name: string | null; unit_of_measure: string | null }
      type I = { book_count: number | null }
      setCustomPartInfo(prev => ({
        ...prev,
        [trimmed]: {
          name: (partRes.data as P | null)?.part_name ?? null,
          unit: (partRes.data as P | null)?.unit_of_measure ?? null,
          inventory: (invRes.data as I | null)?.book_count ?? null,
        },
      }))
    }
  }, [customMaterials, customPartInfo])

  const removeCustomMaterial = useCallback((moNumber: string, code: string) => {
    const updated = { ...customMaterials, [moNumber]: (customMaterials[moNumber] ?? []).filter(c => c !== code) }
    setCustomMaterials(updated)
    localStorage.setItem('shortage_custom', JSON.stringify(updated))
  }, [customMaterials])

  const updateNote = useCallback((moNumber: string, materialCode: string, note: string) => {
    const key = `${moNumber}:${materialCode}`
    const updated = { ...materialNotes, [key]: note }
    setMaterialNotes(updated)
    localStorage.setItem('shortage_notes', JSON.stringify(updated))
  }, [materialNotes])

  // 初始化時預取所有自訂料號的品名＆庫存
  useEffect(() => {
    const allCodes = [...new Set(Object.values(customMaterials).flat())]
    const uncached = allCodes.filter(c => !customPartInfo[c])
    if (uncached.length === 0) return
    void Promise.all(uncached.map(async code => {
      const [partRes, invRes] = await Promise.all([
        supabase.from('mm_bom_part_units').select('part_name, unit_of_measure').eq('part_code', code).maybeSingle(),
        supabase.from('material_inventory_list').select('book_count').eq('item_code', code).maybeSingle(),
      ])
      type P = { part_name: string | null; unit_of_measure: string | null }
      type I = { book_count: number | null }
      return { code, info: {
        name: (partRes.data as P | null)?.part_name ?? null,
        unit: (partRes.data as P | null)?.unit_of_measure ?? null,
        inventory: (invRes.data as I | null)?.book_count ?? null,
      }}
    })).then(results => {
      setCustomPartInfo(prev => {
        const next = { ...prev }
        results.forEach(r => { next[r.code] = r.info })
        return next
      })
    })
  }, [customMaterials]) // eslint-disable-line react-hooks/exhaustive-deps

  // 進頁自動載入
  useEffect(() => { void loadData() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = filterFactory === 'ALL' ? rows : rows.filter(r => r.factory === filterFactory)

  const totalQty   = filtered.reduce((s, r) => s + parseQty(r.quantity), 0)
  const cntT       = rows.filter(r => r.factory === 'T').length
  const cntC       = rows.filter(r => r.factory === 'C').length
  const cntO       = rows.filter(r => r.factory === 'O').length

  // 交期色：今天前 = 紅，7天內 = 橙，其餘 = 正常
  const todayStr = new Date().toISOString().slice(0, 10)
  const soonStr  = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
  function delivColor(d: string) {
    const nd = normDate(d)
    if (!nd) return 'text-slate-500'
    if (nd < todayStr) return 'text-red-400 font-semibold'
    if (nd <= soonStr) return 'text-amber-400'
    return 'text-slate-300'
  }
  function invColor(qty: number | null): string {
    if (qty === null) return 'text-slate-500'
    if (qty <= 0) return 'text-red-400 font-semibold'
    if (qty < 50) return 'text-amber-400'
    return 'text-emerald-400'
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="max-w-[1400px] mx-auto">

        {/* ── 標題列 ── */}
        <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-red-400">缺料追蹤</h1>
            <p className="text-slate-400 text-sm mt-1">
              所有每日出單表中「已匯入製令」但尚未完成批備料的訂單
            </p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => void loadData()}
              disabled={loading}
              className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-50
                         text-white text-sm font-medium transition-colors"
            >
              {loading ? '載入中…' : '↺ 重新整理'}
            </button>
            {loadedAt && (
              <span className="text-xs text-slate-500">
                更新：{loadedAt.toLocaleTimeString('zh-TW')}
              </span>
            )}
          </div>
        </div>

        {errMsg && (
          <div className="text-red-400 text-sm mb-4 bg-red-900/20 border border-red-800/40 rounded-lg px-4 py-3">
            {errMsg}
          </div>
        )}

        {/* ── 統計卡片 ── */}
        {rows.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            {/* 全部 */}
            <button
              onClick={() => setFilterFactory('ALL')}
              className={`rounded-xl p-4 border text-left transition-colors ${
                filterFactory === 'ALL'
                  ? 'bg-slate-800 border-slate-500'
                  : 'bg-slate-900 border-slate-700 hover:border-slate-500'
              }`}
            >
              <div className="text-xs text-slate-400 mb-1">全部待備料</div>
              <div className="text-2xl font-bold text-white">{rows.length}</div>
              <div className="text-xs text-slate-500 mt-0.5">合計 {totalQty.toLocaleString()} PCS</div>
            </button>
            {/* 台北 */}
            <button
              onClick={() => setFilterFactory(filterFactory === 'T' ? 'ALL' : 'T')}
              className={`rounded-xl p-4 border text-left transition-colors ${
                filterFactory === 'T'
                  ? 'bg-emerald-900/50 border-emerald-600'
                  : 'bg-slate-900 border-slate-700 hover:border-emerald-700'
              }`}
            >
              <div className="text-xs text-emerald-400 mb-1">台北</div>
              <div className="text-2xl font-bold text-emerald-300">{cntT}</div>
              <div className="text-xs text-slate-500 mt-0.5">筆</div>
            </button>
            {/* 常平 */}
            <button
              onClick={() => setFilterFactory(filterFactory === 'C' ? 'ALL' : 'C')}
              className={`rounded-xl p-4 border text-left transition-colors ${
                filterFactory === 'C'
                  ? 'bg-orange-900/50 border-orange-600'
                  : 'bg-slate-900 border-slate-700 hover:border-orange-700'
              }`}
            >
              <div className="text-xs text-orange-400 mb-1">常平</div>
              <div className="text-2xl font-bold text-orange-300">{cntC}</div>
              <div className="text-xs text-slate-500 mt-0.5">筆</div>
            </button>
            {/* 委外 */}
            <button
              onClick={() => setFilterFactory(filterFactory === 'O' ? 'ALL' : 'O')}
              className={`rounded-xl p-4 border text-left transition-colors ${
                filterFactory === 'O'
                  ? 'bg-fuchsia-900/50 border-fuchsia-600'
                  : 'bg-slate-900 border-slate-700 hover:border-fuchsia-700'
              }`}
            >
              <div className="text-xs text-fuchsia-400 mb-1">委外</div>
              <div className="text-2xl font-bold text-fuchsia-300">{cntO}</div>
              <div className="text-xs text-slate-500 mt-0.5">筆</div>
            </button>
          </div>
        )}

        {/* ── 空結果 ── */}
        {!loading && rows.length === 0 && !errMsg && (
          <div className="text-slate-400 text-center py-20 bg-slate-900 border border-slate-800 rounded-xl">
            {loadedAt ? '🎉 目前沒有待備料的訂單' : '點擊重新整理載入資料'}
          </div>
        )}

        {/* ── 主表格 ── */}
        {filtered.length > 0 && (
          <div className="bg-slate-900 border border-slate-700 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800/70 text-slate-400 text-xs border-b border-slate-700">
                    <th className="text-left px-3 py-3 font-medium">#</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">出單日</th>
                    <th className="text-left px-3 py-3 font-medium">廠</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">銷售訂單</th>
                    <th className="text-left px-3 py-3 font-medium">料號</th>
                    <th className="text-left px-3 py-3 font-medium">品名</th>
                    <th className="text-left px-3 py-3 font-medium">規格</th>
                    <th className="text-right px-3 py-3 font-medium">數量</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">交期</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">製令單號</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">備料狀態</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">批備料單號</th>
                    <th className="text-left px-3 py-3 font-medium">客戶</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, i) => {
                    const qty       = parseQty(r.quantity)
                    const delivNorm = normDate(r.delivery_date)
                    const isExpanded   = expandedMos.has(r.mo_number)
                    const isLoadingBom = loadingBomSet.has(r.mo_number)
                    const bomMaterials = bomCache.get(r.item_code ?? '') ?? null
                    const customs      = customMaterials[r.mo_number] ?? []

                    return (
                      <React.Fragment key={`${r.sheet_date}-${r.row_key ?? r.mo_number}-${i}`}>
                        <tr className="border-b border-slate-800 hover:bg-slate-800/40 transition-colors">
                          {/* # + expand */}
                          <td className="px-2 py-2.5">
                            <button
                              onClick={() => void toggleExpand(r.mo_number, r.item_code)}
                              title={isExpanded ? '收合' : '展開 BOM & 追蹤'}
                              className="flex items-center gap-1 text-slate-500 hover:text-slate-200 transition-colors px-1"
                            >
                              <span className="text-[10px]">{isExpanded ? '▼' : '▶'}</span>
                              <span className="text-xs text-slate-600">{i + 1}</span>
                            </button>
                          </td>

                          {/* 出單日 */}
                          <td className="px-3 py-2.5 text-slate-400 text-xs whitespace-nowrap">{r.sheet_date}</td>

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
                          <td className="px-3 py-2.5 font-mono text-xs text-slate-300 whitespace-nowrap">{r.item_code || '—'}</td>

                          {/* 品名 */}
                          <td className="px-3 py-2.5 text-slate-200 max-w-[140px] truncate" title={r.item_name}>{r.item_name || '—'}</td>

                          {/* 規格 */}
                          <td className="px-3 py-2.5 text-slate-400 text-xs max-w-[100px] truncate" title={r.note}>{r.note || '—'}</td>

                          {/* 數量 */}
                          <td className="px-3 py-2.5 text-right font-mono text-slate-200">
                            {qty > 0 ? qty.toLocaleString() : r.quantity || '—'}
                          </td>

                          {/* 交期 */}
                          <td className={`px-3 py-2.5 text-xs whitespace-nowrap ${delivColor(r.delivery_date)}`}>
                            {delivNorm || r.delivery_date || '—'}
                          </td>

                          {/* 製令單號 */}
                          <td className="px-3 py-2.5">
                            <button
                              onClick={() => setMoModal(r.mo_number)}
                              className="font-mono text-violet-400 hover:text-violet-200 hover:underline text-xs whitespace-nowrap"
                            >
                              {r.mo_number}
                            </button>
                          </td>

                          {/* 備料狀態 */}
                          <td className="px-3 py-2.5">
                            <span className="inline-flex items-center px-1.5 py-0.5 text-xs rounded border bg-red-900/30 text-red-300 border-red-800/50">
                              待備料
                            </span>
                          </td>

                          {/* 批備料單號 */}
                          <td className="px-3 py-2.5 font-mono text-xs text-slate-400">{r.argo_slip_no || '—'}</td>

                          {/* 客戶 */}
                          <td className="px-3 py-2.5 text-slate-400 text-xs max-w-[100px] truncate" title={r.customer ?? ''}>{r.customer || '—'}</td>
                        </tr>

                        {/* ── BOM 展開子行 ── */}
                        {isExpanded && (
                          <tr className="bg-slate-950/60">
                            <td colSpan={13} className="px-4 pb-4 pt-1">
                              <div className="border border-slate-700/50 rounded-lg overflow-hidden">
                                {/* 子表標題 */}
                                <div className="flex items-center justify-between px-3 py-2 bg-slate-800/60 border-b border-slate-700/40">
                                  <span className="text-xs text-slate-300 font-medium">
                                    BOM 明細 &amp; 缺料追蹤
                                    {r.item_code && <span className="ml-2 font-mono text-slate-500 font-normal">{r.item_code}</span>}
                                  </span>
                                  {bomMaterials !== null && (
                                    <span className="text-xs text-slate-600">{bomMaterials.length} 項 BOM 材料</span>
                                  )}
                                </div>

                                {/* 載入中 */}
                                {isLoadingBom && (
                                  <div className="py-5 text-center text-xs text-slate-500">查詢 BOM 中…</div>
                                )}

                                {/* 明細表 */}
                                {!isLoadingBom && (
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-slate-500 bg-slate-800/30 border-b border-slate-700/30">
                                        <th className="text-left px-3 py-2 font-medium">料號</th>
                                        <th className="text-left px-3 py-2 font-medium">品名</th>
                                        <th className="text-center px-3 py-2 font-medium">單位</th>
                                        <th className="text-right px-3 py-2 font-medium whitespace-nowrap">BOM 用量 / 基量</th>
                                        <th className="text-right px-3 py-2 font-medium">庫存</th>
                                        <th className="text-left px-3 py-2 font-medium w-[220px]">備註</th>
                                        <th className="px-2 py-2 w-6"></th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {/* BOM 材料列 */}
                                      {(bomMaterials ?? []).map(m => (
                                        <tr key={m.material_code} className="border-b border-slate-800/60 hover:bg-slate-800/20">
                                          <td className="px-3 py-2 font-mono text-slate-300">{m.material_code}</td>
                                          <td className="px-3 py-2 text-slate-400 max-w-[160px] truncate" title={m.material_name ?? ''}>{m.material_name || '—'}</td>
                                          <td className="px-3 py-2 text-center text-slate-500">{m.unit || '—'}</td>
                                          <td className="px-3 py-2 text-right font-mono text-slate-400">{m.bom_qty} / {m.bom_base}</td>
                                          <td className={`px-3 py-2 text-right font-mono font-semibold ${invColor(m.inventory_qty)}`}>
                                            {m.inventory_qty !== null ? m.inventory_qty.toLocaleString() : '—'}
                                          </td>
                                          <td className="px-3 py-2">
                                            <textarea
                                              value={materialNotes[`${r.mo_number}:${m.material_code}`] ?? ''}
                                              onChange={e => updateNote(r.mo_number, m.material_code, e.target.value)}
                                              rows={1}
                                              placeholder="備註…"
                                              className="w-full bg-transparent border border-slate-700/60 rounded px-2 py-1 text-slate-300 placeholder-slate-600 resize-none focus:outline-none focus:border-slate-500 text-xs"
                                            />
                                          </td>
                                          <td className="px-2 py-2"></td>
                                        </tr>
                                      ))}

                                      {/* 無 BOM 提示 */}
                                      {bomMaterials !== null && bomMaterials.length === 0 && customs.length === 0 && (
                                        <tr>
                                          <td colSpan={7} className="py-3 text-center text-slate-600">
                                            {r.item_code ? `查無「${r.item_code}」的 BOM 資料` : '此訂單無料號，無法查詢 BOM'}
                                          </td>
                                        </tr>
                                      )}

                                      {/* 自訂追蹤料號列 */}
                                      {customs.map(code => {
                                        const info = customPartInfo[code]
                                        return (
                                          <tr key={`custom-${code}`} className="border-b border-slate-800/60 bg-indigo-950/10 hover:bg-indigo-950/20">
                                            <td className="px-3 py-2 font-mono text-indigo-300">
                                              {code}
                                              <span className="ml-1.5 px-1 py-0.5 bg-indigo-900/50 text-indigo-400 rounded text-[9px] border border-indigo-800/50">自訂</span>
                                            </td>
                                            <td className="px-3 py-2 text-slate-400 max-w-[160px] truncate" title={info?.name ?? ''}>{info?.name || '—'}</td>
                                            <td className="px-3 py-2 text-center text-slate-500">{info?.unit || '—'}</td>
                                            <td className="px-3 py-2 text-right text-slate-600">—</td>
                                            <td className={`px-3 py-2 text-right font-mono font-semibold ${invColor(info?.inventory ?? null)}`}>
                                              {info?.inventory != null ? info.inventory.toLocaleString() : '—'}
                                            </td>
                                            <td className="px-3 py-2">
                                              <textarea
                                                value={materialNotes[`${r.mo_number}:${code}`] ?? ''}
                                                onChange={e => updateNote(r.mo_number, code, e.target.value)}
                                                rows={1}
                                                placeholder="備註…"
                                                className="w-full bg-transparent border border-slate-700/60 rounded px-2 py-1 text-slate-300 placeholder-slate-600 resize-none focus:outline-none focus:border-slate-500 text-xs"
                                              />
                                            </td>
                                            <td className="px-2 py-2">
                                              <button
                                                onClick={() => removeCustomMaterial(r.mo_number, code)}
                                                title="移除"
                                                className="text-slate-600 hover:text-red-400 transition-colors leading-none"
                                              >✕</button>
                                            </td>
                                          </tr>
                                        )
                                      })}

                                      {/* 手動新增料號列 */}
                                      <tr className="border-t border-slate-700/30 bg-slate-900/40">
                                        <td colSpan={7} className="px-3 py-2">
                                          <div className="flex items-center gap-2">
                                            <input
                                              type="text"
                                              value={customInputs[r.mo_number] ?? ''}
                                              onChange={e => setCustomInputs(prev => ({ ...prev, [r.mo_number]: e.target.value }))}
                                              onKeyDown={e => { if (e.key === 'Enter') void addCustomMaterial(r.mo_number, customInputs[r.mo_number] ?? '') }}
                                              placeholder="輸入要追蹤的料號…"
                                              className="flex-1 max-w-[240px] bg-slate-800 border border-slate-600 rounded px-2.5 py-1 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-slate-400"
                                            />
                                            <button
                                              onClick={() => void addCustomMaterial(r.mo_number, customInputs[r.mo_number] ?? '')}
                                              className="px-3 py-1 bg-indigo-700 hover:bg-indigo-600 text-white text-xs rounded transition-colors font-medium"
                                            >
                                              ＋ 新增追蹤
                                            </button>
                                          </div>
                                        </td>
                                      </tr>
                                    </tbody>
                                  </table>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    )
                  })}
                </tbody>
                {/* 合計列 */}
                <tfoot>
                  <tr className="bg-slate-800/50 border-t border-slate-700 text-sm">
                    <td colSpan={7} className="px-3 py-2.5 text-slate-400 font-medium">
                      {filterFactory !== 'ALL' && (
                        <span className="mr-2 text-xs text-slate-500">（已篩選廠別）</span>
                      )}
                      共 {filtered.length} 筆
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold text-amber-300 font-mono">
                      {filtered.reduce((s, r) => s + parseQty(r.quantity), 0).toLocaleString()}
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
      {soModal && <SoOrderModal projectId={soModal} onClose={() => setSoModal(null)} />}
      {moModal && <MoDetailModal moNumber={moModal} onClose={() => setMoModal(null)} />}
    </div>
  )
}
