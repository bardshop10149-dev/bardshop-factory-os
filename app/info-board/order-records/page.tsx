'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { NavButton } from '../../../components/NavButton'
import SoOrderModal from '../../../components/SoOrderModal'
import PoProgressChips from '../../../components/PoProgressChips'
import { supabase } from '../../../lib/supabaseClient'

// ─── erp_pj_sync 型別 ─────────────────────────────────────
interface PjRecord {
  id: number
  doc_type: string
  doc_no: string
  sub_no: string
  item_code: string | null
  description: string | null
  qty: number
  unit: string | null
  status: string | null
  start_date: string | null
  end_date: string | null
  customer_vendor: string | null
  remark: string | null
  extra: Record<string, unknown> | null
  synced_at: string
}

// ─── 製令明細型別 (erp_mo_lines) ──────────────────────────────
interface MoLine {
  id: number
  project_id: string
  begin_date: string | null
  end_date: string | null
  hold_status: string | null
  mo_begin_date: string | null
  line_no: string
  mbp_part: string | null
  mbp_lot_no: string | null
  order_qty: number
  source_order: string | null
  synced_at: string
}

// ─── ERP 同步資料彈跳視窗 (採購單 erp_pj_sync / 製令 erp_mo_lines) ────
function PjSyncModal({ docNo, onClose }: { docNo: string; onClose: () => void }) {
  const isMo = docNo.startsWith('MO')

  // PO/PR rows (erp_pj_sync)
  const [poRows, setPoRows] = useState<PjRecord[]>([])
  // MO rows (erp_mo_lines)
  const [moRows, setMoRows] = useState<MoLine[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  // 採購追蹤（進度＝採購手動點的已出貨；入庫＝ARGO 回寫的實際入庫量），key = sub_no
  const [track, setTrack] = useState<Record<string, { progress: string; received_qty: number | null; po_status: string | null }>>({})

  useEffect(() => {
    if (!docNo) return
    setLoading(true); setErr(null); setPoRows([]); setMoRows([]); setTrack({})
    if (isMo) {
      supabase
        .from('erp_mo_lines')
        .select('*')
        .eq('project_id', docNo)
        .order('line_no', { ascending: true })
        .then(({ data, error }) => {
          setLoading(false)
          if (error) { setErr(error.message); return }
          setMoRows(((data ?? []) as MoLine[]).sort((a, b) =>
            a.line_no.localeCompare(b.line_no, undefined, { numeric: true })
          ))
        })
    } else {
      supabase
        .from('erp_pj_sync')
        .select('*')
        .eq('doc_no', docNo)
        .order('sub_no', { ascending: true })
        .then(({ data, error }) => {
          setLoading(false)
          if (error) { setErr(error.message); return }
          setPoRows(((data ?? []) as PjRecord[]).sort((a, b) =>
            String(a.sub_no ?? '').localeCompare(String(b.sub_no ?? ''), undefined, { numeric: true })
          ))
        })
    }
  }, [docNo, isMo])

  // 採購單才抓進度／入庫（po-public 只回進度、入庫量、交期，不含供應商與付款）
  useEffect(() => {
    if (!docNo || !docNo.startsWith('PO')) return
    let alive = true
    fetch(`/api/purchasing/po-public?po=${encodeURIComponent(docNo)}`)
      .then(res => (res.ok ? res.json() : null))
      .then(json => {
        if (!alive || !json?.success) return
        const map: Record<string, { progress: string; received_qty: number | null; po_status: string | null }> = {}
        for (const l of json.lines as { sub_no: string; progress: string; received_qty: number | null; po_status: string | null }[]) {
          map[String(l.sub_no)] = { progress: l.progress, received_qty: l.received_qty, po_status: l.po_status ?? null }
        }
        setTrack(map)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [docNo])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const poHdr = poRows[0]
  const poExtra = poHdr?.extra as Record<string, unknown> | null | undefined
  const moHdr = moRows[0]
  const isPo = docNo.startsWith('PO')
  const totalRows = isMo ? moRows.length : poRows.length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/80 rounded-t-xl flex-shrink-0">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className={`text-xl font-bold font-mono tracking-wide ${isPo ? 'text-orange-300' : 'text-violet-300'}`}>{docNo}</span>
            {/* PO 標頭資訊 */}
            {!isMo && poHdr?.doc_type && (
              <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-400 text-xs">{poHdr.doc_type}</span>
            )}
            {!isMo && poHdr?.customer_vendor && <span className="text-slate-200 text-sm">{poHdr.customer_vendor}</span>}
            {!isMo && poHdr?.status && (
              <span className={`px-2 py-0.5 rounded border text-xs font-bold ${
                poHdr.status === 'OPEN'  ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50'
                : poHdr.status === 'CLOSE' ? 'bg-slate-800 text-slate-500 border-slate-600'
                : poHdr.status === 'HOLD'  ? 'bg-amber-900/40 text-amber-300 border-amber-700/50'
                : 'bg-slate-800 text-slate-400 border-slate-600'
              }`}>{poHdr.status}</span>
            )}
            {!isMo && !!poHdr?.start_date && <span className="text-slate-500 text-xs">開立：{poHdr.start_date}</span>}
            {isPo && !!poExtra?.SO_PROJECT_ID && (
              <span className="text-slate-500 text-xs">銷售單：<span className="text-cyan-400 font-mono">{String(poExtra.SO_PROJECT_ID)}</span></span>
            )}
            {/* MO 標頭資訊 */}
            {isMo && moHdr?.hold_status && (
              <span className={`px-2 py-0.5 rounded border text-xs font-bold ${
                moHdr.hold_status === 'OPEN'  ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50'
                : moHdr.hold_status === 'CLOSE' ? 'bg-slate-800 text-slate-500 border-slate-600'
                : moHdr.hold_status === 'HOLD'  ? 'bg-amber-900/40 text-amber-300 border-amber-700/50'
                : 'bg-slate-800 text-slate-400 border-slate-600'
              }`}>{moHdr.hold_status}</span>
            )}
            {isMo && !!moHdr?.begin_date && <span className="text-slate-500 text-xs">開立：{moHdr.begin_date}</span>}
            {isMo && !!moHdr?.end_date && <span className="text-slate-500 text-xs">預交：{moHdr.end_date}</span>}
            {!loading && totalRows > 0 && <span className="text-slate-600 text-xs">共 {totalRows} 筆</span>}
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors text-2xl leading-none ml-6 flex-shrink-0 mt-0.5">✕</button>
        </div>

        {/* Body — min-h-0 讓 flex-1 可正確收縮以啟動捲動 */}
        <div className="overflow-y-auto flex-1 min-h-0">
          {loading ? (
            <div className="text-center py-12 text-slate-500">載入中…</div>
          ) : err ? (
            <div className="text-center py-12 text-red-400">{err}</div>
          ) : totalRows === 0 ? (
            <div className="text-center py-12 text-slate-500">同步區查無資料</div>
          ) : isMo ? (
            /* ── 製令明細 (erp_mo_lines) ── */
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 uppercase tracking-wider sticky top-0 bg-slate-950">
                  <th className="px-4 py-2 border-b border-slate-800">行號</th>
                  <th className="px-4 py-2 border-b border-slate-800 text-purple-300">品項編碼</th>
                  <th className="px-4 py-2 border-b border-slate-800 text-right">數量</th>
                  <th className="px-4 py-2 border-b border-slate-800">開工日</th>
                  <th className="px-4 py-2 border-b border-slate-800">交期</th>
                  <th className="px-4 py-2 border-b border-slate-800 text-cyan-400">銷售批號</th>
                  <th className="px-4 py-2 border-b border-slate-800">來源訂單</th>
                </tr>
              </thead>
              <tbody>
                {moRows.map((r, i) => (
                  <tr key={r.id ?? i} className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors">
                    <td className="px-4 py-2 text-slate-400 font-mono">{r.line_no || '—'}</td>
                    <td className="px-4 py-2 font-mono text-purple-300">{r.mbp_part || '—'}</td>
                    <td className="px-4 py-2 text-right text-slate-300">{r.order_qty > 0 ? r.order_qty.toLocaleString() : '—'}</td>
                    <td className="px-4 py-2 text-slate-400 whitespace-nowrap">{r.mo_begin_date || '—'}</td>
                    <td className="px-4 py-2 text-slate-400 whitespace-nowrap">{r.end_date || '—'}</td>
                    <td className="px-4 py-2 font-mono text-cyan-400 text-xs">{r.mbp_lot_no || '—'}</td>
                    <td className="px-4 py-2 text-slate-400 text-xs">{r.source_order || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            /* ── 採購/請購明細 (erp_pj_sync) ── */
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 uppercase tracking-wider sticky top-0 bg-slate-950">
                  <th className="px-4 py-2 border-b border-slate-800">序號</th>
                  <th className="px-4 py-2 border-b border-slate-800 text-purple-300">品項編碼</th>
                  <th className="px-4 py-2 border-b border-slate-800">品名/規格</th>
                  <th className="px-4 py-2 border-b border-slate-800 text-right">數量</th>
                  <th className="px-4 py-2 border-b border-slate-800">單位</th>
                  <th className="px-4 py-2 border-b border-slate-800">交貨日</th>
                  {isPo && <th className="px-4 py-2 border-b border-slate-800 text-emerald-400">進度</th>}
                  {isPo && <th className="px-4 py-2 border-b border-slate-800 text-emerald-400">入庫</th>}
                  {isPo && <th className="px-4 py-2 border-b border-slate-800 text-cyan-400">銷售單/序</th>}
                  <th className="px-4 py-2 border-b border-slate-800">備註</th>
                </tr>
              </thead>
              <tbody>
                {poRows.map((r, i) => {
                  const rx = r.extra as Record<string, unknown> | null | undefined
                  return (
                    <tr key={r.id ?? i} className="border-b border-slate-800/60 hover:bg-slate-800/30 transition-colors">
                      <td className="px-4 py-2 text-slate-400 font-mono">{r.sub_no || '—'}</td>
                      <td className="px-4 py-2 font-mono text-purple-300">{r.item_code || '—'}</td>
                      <td className="px-4 py-2 text-slate-200 max-w-[280px] truncate" title={r.description ?? ''}>{r.description || '—'}</td>
                      <td className="px-4 py-2 text-right text-slate-300">{r.qty > 0 ? r.qty.toLocaleString() : '—'}</td>
                      <td className="px-4 py-2 text-slate-400">{r.unit || '—'}</td>
                      <td className="px-4 py-2 text-slate-400 whitespace-nowrap">{r.end_date || '—'}</td>
                      {isPo && (() => {
                        // 與採購專區同視覺的三里程碑（發單→出貨→到倉）；ARGO 狀態 OPEN 自動亮「發單」
                        const t = track[String(r.sub_no)]
                        return (
                          <td className="px-4 py-2 whitespace-nowrap">
                            <PoProgressChips progress={t?.progress} poStatus={t?.po_status ?? r.status ?? null} />
                          </td>
                        )
                      })()}
                      {isPo && (() => {
                        const recv = track[String(r.sub_no)]?.received_qty ?? null
                        const full = recv != null && r.qty > 0 && recv >= r.qty
                        return (
                          <td className="px-4 py-2 whitespace-nowrap text-xs">
                            {recv == null || recv <= 0 ? (
                              <span className="text-slate-600">未入庫</span>
                            ) : (
                              <span className={full ? 'text-emerald-300' : 'text-amber-300'}>
                                {full ? '已入庫' : '部分'} {recv.toLocaleString()}{r.qty > 0 ? `/${r.qty.toLocaleString()}` : ''}
                              </span>
                            )}
                          </td>
                        )
                      })()}
                      {isPo && (
                        <td className="px-4 py-2 text-xs">
                          <div className="font-mono text-cyan-400">{String(rx?.MBP_LOT_NO ?? '—')}</div>
                          <div className="text-slate-500">{String(rx?.SO_LINE_NO ?? '—')}</div>
                        </td>
                      )}
                      <td className="px-4 py-2 text-slate-500 text-xs max-w-[180px] truncate" title={r.remark ?? ''}>{r.remark || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── 型別 ─────────────────────────────────────────────────
interface SheetRow {
  row_key?: string
  order_number: string
  doc_type: string
  factory: 'T' | 'C' | 'O'
  item_code: string
  item_name: string
  quantity: string
  plate_count: string
  customer: string
  handler?: string        // J承辦人（業務）
  issuer?: string         // K開單人員
  delivery_date: string
  mo_status: '已匯入製令' | null
  mo_number?: string | null
  po_number?: string | null
  po_sub_no?: string | null
  po_status?: 'matched' | 'no_match' | null
  match_status?: 'matched' | 'no_order' | 'no_qty_match' | null
  match_line_no?: string | null
  match_reason?: string | null
  material_prep_status?: '已備料' | '無需備料' | '已批備料' | null
  argo_slip_no?: string | null
}

interface SheetMeta {
  sheet_date: string
  row_count: number
  updated_at: string
}

// ─── 狀態標籤 ───────────────────────────────────────────────
const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  '已匯入製令': { label: '已匯入製令', cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50' },
  '已匯入採單': { label: '已匯入採單', cls: 'bg-orange-900/50 text-orange-300 border-orange-700/50' },
}

function factoryBadge(f: 'T' | 'C' | 'O') {
  if (f === 'C') return <span className="px-1.5 py-0.5 rounded text-[10px] bg-orange-900/40 text-orange-300 border border-orange-700/50">常平</span>
  if (f === 'O') return <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-900/40 text-purple-300 border border-purple-700/50">委外</span>
  return <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-700/60 text-slate-400 border border-slate-600/50">台北</span>
}

// ─── 跨日期搜尋結果 ─────────────────────────────────────────
interface SearchGroup {
  sheet_date: string
  rows: SheetRow[]
}

export default function OrderRecordsPage() {
  const [availableSheets, setAvailableSheets] = useState<SheetMeta[]>([])
  const [selectedDate, setSelectedDate] = useState('')
  const [sheetRows, setSheetRows] = useState<SheetRow[]>([])
  const [loading, setLoading] = useState(false)

  // 工廠篩選
  const [soModalId, setSoModalId] = useState<string | null>(null)
  const [pjModalDocNo, setPjModalDocNo] = useState<string | null>(null)

  const [factoryFilter, setFactoryFilter] = useState<'all' | 'T' | 'C' | 'O'>('all')

  // 本頁搜尋（過濾已載入的日期）
  const [searchQuery, setSearchQuery] = useState('')

  // 跨日期搜尋
  const [globalSearch, setGlobalSearch] = useState('')
  const [globalSearching, setGlobalSearching] = useState(false)
  const [globalResults, setGlobalResults] = useState<SearchGroup[] | null>(null)

  // ── 讀取日期清單 ──────────────────────────────────────────
  const loadSheetList = useCallback(async () => {
    try {
      const res = await fetch('/api/argoerp/daily-order-sheet')
      const json = await res.json()
      if (json.success) {
        const sheets: SheetMeta[] = json.sheets ?? []
        setAvailableSheets(sheets)
        if (sheets.length > 0 && !selectedDate) {
          setSelectedDate(sheets[0].sheet_date)
        }
      }
    } catch {}
  }, [selectedDate])

  // ── 讀取指定日期 ──────────────────────────────────────────
  const loadSheet = useCallback(async (date: string) => {
    if (!date) return
    setLoading(true)
    setSheetRows([])
    try {
      const res = await fetch(`/api/argoerp/daily-order-sheet?date=${date}`)
      const json = await res.json()
      if (json.success && json.sheet) {
        setSheetRows(Array.isArray(json.sheet.rows) ? (json.sheet.rows as SheetRow[]) : [])
      }
    } catch {}
    finally { setLoading(false) }
  }, [])

  useEffect(() => { loadSheetList() }, [loadSheetList])
  useEffect(() => { if (selectedDate) loadSheet(selectedDate) }, [selectedDate, loadSheet])

  // ── 跨日期搜尋 ────────────────────────────────────────────
  const runGlobalSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) { setGlobalResults(null); return }
    setGlobalSearching(true)
    setGlobalResults(null)
    try {
      const res = await fetch(`/api/argoerp/daily-order-sheet?search=${encodeURIComponent(trimmed)}`)
      const json = await res.json()
      if (json.success) {
        setGlobalResults((json.results ?? []) as SearchGroup[])
      }
    } catch {}
    finally { setGlobalSearching(false) }
  }, [])

  // ── 派生：過濾後的列 ──────────────────────────────────────
  const filteredRows = sheetRows.filter(r => {
    if (factoryFilter !== 'all' && r.factory !== factoryFilter) return false
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      return (
        r.order_number?.toLowerCase().includes(q) ||
        r.mo_number?.toLowerCase().includes(q) ||
        r.po_number?.toLowerCase().includes(q) ||
        r.item_code?.toLowerCase().includes(q)
      )
    }
    return true
  })

  // ── 統計 ─────────────────────────────────────────────────
  const stat = {
    total: filteredRows.length,
    mo: filteredRows.filter(r => r.mo_status === '已匯入製令' || !!r.mo_number?.startsWith('MO')).length,
    po: filteredRows.filter(r => r.po_status === 'matched').length,
    pending: filteredRows.filter(r => !(r.mo_status === '已匯入製令' || r.mo_number?.startsWith('MO')) && r.po_status !== 'matched').length,
  }

  // ── Row 渲染（共用於單日和跨日搜尋結果）────────────────────
  const renderRow = (row: SheetRow, idx: number) => {
    // 有有效製令單號即視為已匯入製令（涵蓋舊資料 mo_status 未同步的情況）
    const isMoImported = row.mo_status === '已匯入製令' || !!row.mo_number?.startsWith('MO')
    const effectiveStatus = isMoImported
      ? '已匯入製令'
      : ((row.factory === 'C' || row.factory === 'O') && row.po_status === 'matched' ? '已匯入採單' : null)
    const statusInfo = effectiveStatus ? STATUS_LABELS[effectiveStatus] : null

    return (
      <tr
        key={row.row_key || idx}
        className={`border-b border-slate-800/60 text-sm transition-colors ${
          isMoImported
            ? 'bg-emerald-950/20'
            : row.factory === 'C' && row.po_status === 'matched'
            ? 'bg-orange-950/20'
            : row.factory === 'O' && row.po_status === 'matched'
            ? 'bg-purple-950/20'
            : 'hover:bg-slate-900/40'
        }`}
      >
        {/* # */}
        <td className="px-3 py-2 text-slate-600 text-xs">{idx + 1}</td>

        {/* 工單 + 廠別 */}
        <td className="px-3 py-2">
          <button
            onClick={() => setSoModalId(row.order_number)}
            className="font-mono text-cyan-300 whitespace-nowrap hover:text-cyan-100 hover:underline underline-offset-2 text-left"
          >{row.order_number}</button>
          <div className="mt-0.5 flex items-center gap-1">
            {factoryBadge(row.factory)}
            <span className="text-slate-600 text-[10px]">{row.doc_type}</span>
          </div>
        </td>

        {/* SO序號 */}
        <td className="px-3 py-2 text-center">
          {row.match_status === 'matched' && row.match_line_no ? (
            <span className="px-2 py-0.5 rounded border text-xs font-mono bg-emerald-900/40 text-emerald-300 border-emerald-700/50">{row.match_line_no}</span>
          ) : row.match_status === 'no_order' ? (
            <span className="px-2 py-0.5 rounded border text-xs bg-red-900/30 text-red-300 border-red-800/50" title={row.match_reason ?? ''}>無單號</span>
          ) : row.match_status === 'no_qty_match' ? (
            <span className="px-2 py-0.5 rounded border text-xs bg-amber-900/30 text-amber-300 border-amber-700/50" title={row.match_reason ?? ''}>數量不符</span>
          ) : (
            <span className="text-slate-600 text-xs">—</span>
          )}
        </td>

        {/* 品項編碼 / 品名 */}
        <td className="px-3 py-2">
          <div className="font-mono text-purple-300 text-xs">{row.item_code}</div>
          <div className="text-slate-300 text-[10px] mt-0.5 max-w-[280px] truncate" title={row.item_name}>{row.item_name}</div>
        </td>

        {/* 數量 */}
        <td className="px-3 py-2 text-slate-300 text-right whitespace-nowrap">{row.quantity}</td>

        {/* 盤數 */}
        <td className="px-3 py-2 text-yellow-400 text-center font-mono font-semibold">{row.plate_count || '—'}</td>

        {/* 客戶 */}
        <td className="px-3 py-2 text-slate-400 max-w-[110px] truncate text-xs" title={row.customer}>{row.customer}</td>

        {/* 業務（承辦人） */}
        <td className="px-3 py-2 text-slate-300 whitespace-nowrap text-xs">{row.handler || '—'}</td>

        {/* 開單人員 */}
        <td className="px-3 py-2 text-slate-400 whitespace-nowrap text-xs">{row.issuer || '—'}</td>

        {/* 交付日 */}
        <td className="px-3 py-2 text-slate-500 whitespace-nowrap text-xs">{row.delivery_date}</td>

        {/* 製令 / 採購單號 */}
        <td className="px-3 py-2 font-mono text-xs">
          {(row.factory === 'C' || row.factory === 'O') ? (
            row.po_status === 'matched' && row.po_number ? (
              <div>
                <button
                  onClick={() => setPjModalDocNo(row.po_number!)}
                  className={`hover:underline underline-offset-2 ${row.factory === 'C' ? 'text-orange-300 hover:text-orange-100' : 'text-purple-300 hover:text-purple-100'}`}
                >{row.po_number}</button>
                {row.po_sub_no && <span className="text-slate-500 ml-1">#{row.po_sub_no}</span>}
              </div>
            ) : row.po_status === 'no_match' ? (
              <span className="text-red-400 text-[10px]">無對應採購單</span>
            ) : row.mo_number ? (
              <button onClick={() => setPjModalDocNo(row.mo_number!)} className="text-violet-300 hover:text-violet-100 hover:underline underline-offset-2">{row.mo_number}</button>
            ) : (
              <span className="text-slate-600">—</span>
            )
          ) : row.mo_number ? (
            <button onClick={() => setPjModalDocNo(row.mo_number!)} className="text-violet-300 hover:text-violet-100 hover:underline underline-offset-2">{row.mo_number}</button>
          ) : (
            <span className="text-slate-600">—</span>
          )}
        </td>

        {/* 批備料 */}
        <td className="px-3 py-2">
          {row.material_prep_status === '已批備料' ? (
            <div>
              <span className="px-2 py-0.5 rounded border text-xs bg-teal-900/40 text-teal-300 border-teal-700/50">已批備料</span>
              {row.argo_slip_no && <div className="font-mono text-[10px] text-teal-400/70 mt-0.5">{row.argo_slip_no}</div>}
            </div>
          ) : row.material_prep_status === '已備料' ? (
            <div>
              <span className="px-2 py-0.5 rounded border text-xs bg-emerald-900/40 text-emerald-300 border-emerald-700/50">已備料</span>
              {row.argo_slip_no && <div className="font-mono text-[10px] text-emerald-400/70 mt-0.5">{row.argo_slip_no}</div>}
            </div>
          ) : row.material_prep_status === '無需備料' ? (
            <span className="px-2 py-0.5 rounded border text-xs bg-slate-800 text-slate-400 border-slate-700">無需備料</span>
          ) : (
            <span className="text-slate-600 text-xs">—</span>
          )}
        </td>

        {/* 狀態 */}
        <td className="px-3 py-2">
          {statusInfo ? (
            <span className={`px-2 py-0.5 rounded border text-xs ${statusInfo.cls}`}>{statusInfo.label}</span>
          ) : (
            <span className="text-slate-600 text-xs">未轉單</span>
          )}
        </td>
      </tr>
    )
  }

  // ── 表格標頭 ─────────────────────────────────────────────
  const TableHead = () => (
    <thead>
      <tr className="text-left text-xs text-slate-500 uppercase tracking-wider">
        <th className="px-3 py-2 border-b border-slate-800 w-8">#</th>
        <th className="px-3 py-2 border-b border-slate-800 min-w-[140px]">工單 / 廠別</th>
        <th className="px-3 py-2 border-b border-slate-800 text-emerald-400 text-center">SO序號</th>
        <th className="px-3 py-2 border-b border-slate-800 text-purple-300 min-w-[260px]">品項編碼 / 品名規格</th>
        <th className="px-3 py-2 border-b border-slate-800 text-right">數量</th>
        <th className="px-3 py-2 border-b border-slate-800 text-yellow-400 text-center">盤數</th>
        <th className="px-3 py-2 border-b border-slate-800">客戶</th>
        <th className="px-3 py-2 border-b border-slate-800">業務</th>
        <th className="px-3 py-2 border-b border-slate-800">開單人員</th>
        <th className="px-3 py-2 border-b border-slate-800">交付日</th>
        <th className="px-3 py-2 border-b border-slate-800">製令/採購單號</th>
        <th className="px-3 py-2 border-b border-slate-800">批備料</th>
        <th className="px-3 py-2 border-b border-slate-800">狀態</th>
      </tr>
    </thead>
  )

  return (
    <div className="min-h-screen bg-[#050b14] text-slate-300">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(14,165,233,0.12),_transparent_45%)] pointer-events-none" />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,#030812_0%,#050d18_30%,#060f1d_70%,#050b14_100%)] pointer-events-none" />

      {/* ── Header ──────────────────────────────────────────── */}
      <div className="bg-slate-900/70 border-b border-slate-800 backdrop-blur-xl sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-3">
          <NavButton href="/" direction="home" title="回系統入口" className="px-3 py-1.5" />
          <div>
            <h1 className="text-2xl font-black text-white tracking-wide">發單記錄查詢</h1>
            <p className="text-xs text-amber-300 uppercase tracking-widest">業務資訊看板 / Order Records</p>
          </div>
          <div className="ml-auto">
            <Link
              href="/"
              className="px-3 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 text-xs transition-colors"
            >
              回首頁
            </Link>
          </div>
        </div>
      </div>

      <div className="relative z-10 max-w-7xl mx-auto px-4 py-6 space-y-5">

        {/* ── 篩選列 ────────────────────────────────────────── */}
        <div className="bg-slate-900/60 border border-slate-800 rounded-2xl px-5 py-4 flex flex-wrap items-center gap-4">

          {/* 日期選擇 */}
          <div className="flex items-center gap-2">
            <label className="text-slate-400 text-sm whitespace-nowrap">出單日期</label>
            <select
              value={selectedDate}
              onChange={e => { setSelectedDate(e.target.value); setGlobalResults(null) }}
              className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-cyan-500"
            >
              {availableSheets.length === 0 && <option value="">— 無資料 —</option>}
              {availableSheets.map(s => (
                <option key={s.sheet_date} value={s.sheet_date}>
                  {s.sheet_date}（{s.row_count} 筆）
                </option>
              ))}
            </select>
          </div>

          {/* 廠別篩選 */}
          <div className="flex items-center gap-1.5">
            {(['all', 'T', 'C', 'O'] as const).map(f => (
              <button
                key={f}
                onClick={() => setFactoryFilter(f)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  factoryFilter === f
                    ? f === 'all' ? 'bg-slate-600 border-slate-500 text-white'
                      : f === 'T' ? 'bg-slate-700 border-slate-500 text-white'
                      : f === 'C' ? 'bg-orange-700 border-orange-500 text-white'
                      : 'bg-purple-700 border-purple-500 text-white'
                    : 'bg-slate-800/60 border-slate-700 text-slate-400 hover:border-slate-500'
                }`}
              >
                {f === 'all' ? '全部' : f === 'T' ? '台北' : f === 'C' ? '常平' : '委外'}
              </button>
            ))}
          </div>

          {/* 本日關鍵字搜尋 */}
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="篩選工單/品項…"
              className="pl-9 pr-8 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm w-44 focus:outline-none focus:border-cyan-500 placeholder:text-slate-500"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs">✕</button>
            )}
          </div>

          {/* 跨日期搜尋 */}
          <div className="flex items-center gap-2 ml-auto">
            <div className="relative">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
              </svg>
              <input
                type="text"
                value={globalSearch}
                onChange={e => { setGlobalSearch(e.target.value); if (!e.target.value.trim()) setGlobalResults(null) }}
                onKeyDown={e => e.key === 'Enter' && runGlobalSearch(globalSearch)}
                placeholder="跨日期搜尋單號…"
                className="pl-9 pr-8 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm w-52 focus:outline-none focus:border-amber-500 placeholder:text-slate-500"
              />
              {globalSearch && (
                <button onClick={() => { setGlobalSearch(''); setGlobalResults(null) }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs">✕</button>
              )}
            </div>
            <button
              onClick={() => runGlobalSearch(globalSearch)}
              disabled={!globalSearch.trim() || globalSearching}
              className="px-3 py-2 rounded-lg bg-amber-800/60 hover:bg-amber-700/70 disabled:bg-slate-800 disabled:text-slate-600 border border-amber-700/50 disabled:border-slate-700 text-amber-200 text-sm font-medium transition-colors"
            >
              {globalSearching ? '搜尋中…' : '跨日搜尋'}
            </button>
            {globalResults !== null && (
              <button onClick={() => { setGlobalResults(null); setGlobalSearch('') }}
                className="px-2 py-2 rounded-lg border border-slate-700 text-slate-400 hover:text-white text-xs transition-colors">
                清除
              </button>
            )}
          </div>
        </div>

        {/* ── Modals ───────────────────────────────────────── */}
      {soModalId && <SoOrderModal projectId={soModalId} onClose={() => setSoModalId(null)} />}
      {pjModalDocNo && <PjSyncModal docNo={pjModalDocNo} onClose={() => setPjModalDocNo(null)} />}

      {/* ── 跨日期搜尋結果 ────────────────────────────────── */}
        {globalResults !== null && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-amber-300 font-bold">跨日期搜尋結果</span>
              <span className="text-xs text-slate-500">共 {globalResults.reduce((a, g) => a + g.rows.length, 0)} 筆 / {globalResults.length} 個日期</span>
            </div>
            {globalResults.length === 0 ? (
              <div className="text-center py-12 text-slate-500">無符合結果</div>
            ) : globalResults.map(group => (
              <div key={group.sheet_date} className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 bg-slate-800/60 border-b border-slate-700 flex items-center gap-2">
                  <span className="text-amber-300 font-mono font-bold">{group.sheet_date}</span>
                  <span className="text-xs text-slate-500">{group.rows.length} 筆</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <TableHead />
                    <tbody>
                      {group.rows.map((row, idx) => renderRow(row, idx))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── 單日出單表 ────────────────────────────────────── */}
        {globalResults === null && (
          <>
            {/* 統計列 */}
            {!loading && filteredRows.length > 0 && (
              <div className="flex flex-wrap gap-3 text-xs">
                <span className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300">
                  共 <span className="text-white font-bold">{stat.total}</span> 筆
                </span>
                <span className="px-3 py-1.5 rounded-lg bg-emerald-950/40 border border-emerald-800/50 text-emerald-300">
                  已匯入製令 <span className="font-bold">{stat.mo}</span>
                </span>
                {stat.po > 0 && (
                  <span className="px-3 py-1.5 rounded-lg bg-orange-950/40 border border-orange-800/50 text-orange-300">
                    已匯入採單 <span className="font-bold">{stat.po}</span>
                  </span>
                )}
                <span className="px-3 py-1.5 rounded-lg bg-slate-900/60 border border-slate-700 text-slate-400">
                  未轉單 <span className="font-bold text-slate-200">{stat.pending}</span>
                </span>
              </div>
            )}

            {/* 表格 */}
            <div className="bg-slate-900/60 border border-slate-800 rounded-2xl overflow-hidden">
              {loading ? (
                <div className="text-center py-16 text-slate-500">
                  <svg className="animate-spin w-6 h-6 mx-auto mb-3 text-slate-600" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
                  </svg>
                  載入中…
                </div>
              ) : filteredRows.length === 0 ? (
                <div className="text-center py-16 text-slate-500">
                  {selectedDate ? '此日期無資料' : '請選擇出單日期'}
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <TableHead />
                    <tbody>
                      {filteredRows.map((row, idx) => renderRow(row, idx))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
