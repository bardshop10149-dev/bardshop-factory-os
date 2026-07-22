'use client'

/**
 * 出單表➜常平採購
 * ArgoERP IFAF024 — 採購訂單（PO）介面
 *
 * 結構：一張採購單（主表）+ 多筆明細（來自每日出單表常平欄）
 * 與製令匯出不同，PO 有獨立表頭欄位，所有細項共用同一個 PROJECT_ID
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../../../lib/supabaseClient'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface SourceRow {
  row_key?: string
  order_number: string; doc_type: string; factory: 'T' | 'C' | 'O'
  receiver: string; is_sample: string; has_material: string
  designer: string; customer: string; line_nickname: string
  handler: string; issuer: string
  item_code: string; item_name: string; note: string
  quantity: string; delivery_date: string; plate_count: string
  upload_ro: string; order_status: string; pm_note: string
  /** 出單表原始序號（B欄），強制套用為 TPN_PART_NO */
  line_no_input?: string
}

interface PoHeader {
  project_id:     string
  modify_ver:     string
  begin_date:     string
  hold_status:    'OPEN' | 'HOLD' | 'CLOSE' | 'UNSIGNED'
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

interface LineEdit {
  mbp_ver:    string
  uom:        string
  unit_price: string
  lot_no:     string
  remark2:    string
  so_line_no: string
  packing:    string
}

interface MatchResult {
  status: 'matched' | 'no_order' | 'no_qty_match' | null
  line_no: string | null
  reason:  string
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const HEADER_KEY  = 'argoerp_po_c_header_v1'

/** IFAF024 ERP 欄位順序（匯出 CSV/XLSX 用） */
const ERP_KEYS = [
  'PROJECT_ID', 'MODIFY_VER', 'BEGIN_DATE', 'HOLD_STATUS',
  'TPN_PARTNER_ID', 'SEG_SEGMENT_NO_DEPARTMENT', 'SALES_ID', 'PO_TYPE',
  'PAYMENT_TERM', 'PAYMENT_MODE', 'CURRENCY', 'EXCHANGE_RATE', 'TAX_RATE',
  'LINE_NO', 'MBP_PART', 'MBP_VER', 'ORDER_QTY_ORU', 'UNIT_OF_MEASURE_ORU',
  'UNIT_PRICE_ORU', 'DUEDATE', 'MBP_LOT_NO', 'REMARK', 'REMARK2', 'PACKING', 'SO_PROJECT_ID', 'TPN_PART_NO',
] as const

const DEF_EDIT: LineEdit = { mbp_ver: '1', uom: 'PCS', unit_price: '0', lot_no: '', remark2: '', so_line_no: '', packing: '' }

function fmtDate(d: Date) {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function pocPrefixToday() {
  const d = new Date()
  return `POC${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** 即時查 ARGO 採購主檔（PJ_PROJECT）當天既有 POC 單號，回最大流水 +1（例 POC2026070902）。
 *  不依賴 erp_pj_sync（要手動跑同步才會新，取號會撞單）。 */
async function fetchNextPocNo(): Promise<string> {
  const prefix = pocPrefixToday()
  const res = await fetch('/api/argoerp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'query',
      table: 'PJ_PROJECT',
      filters: { PROJECT_ID: `LIKE '${prefix}%'` },
      customColumn: 'PROJECT_ID',
    }),
  })
  const j = await res.json()
  if (!res.ok || !j?.success) throw new Error(j?.error || `查詢 ARGO 採購單號失敗（HTTP ${res.status}）`)
  const apiResult = (j.apiResult ?? {}) as Record<string, unknown>
  const rows = Array.isArray(apiResult.RESULT) ? apiResult.RESULT as Array<Record<string, unknown>> : []
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
export default function PoBatchExportCPage() {
  const [unlocked, setUnlocked] = useState(false)
  const [pwInput, setPwInput]   = useState('')
  const [pwError, setPwError]   = useState(false)

  const [sourceRows, setSourceRows] = useState<SourceRow[]>([])
  const [lineEdits, setLineEdits]   = useState<LineEdit[]>([])
  const [header, setHeader]         = useState<PoHeader>(makeDefaultHeader)
  const [headerOpen, setHeaderOpen] = useState(true)

  const [availDates, setAvailDates]       = useState<{ sheet_date: string; row_count: number; pending_c_count?: number }[]>([])
  const [datesLoading, setDatesLoading]   = useState(false)
  const [pickerDate, setPickerDate]       = useState('')
  const [loadedDate, setLoadedDate]       = useState<string | null>(null)

  const [exportFmt, setExportFmt] = useState<'csv' | 'xlsx'>('csv')
  const [importing, setImporting] = useState(false)
  const [matching, setMatching]   = useState(false)
  const [matchResults, setMatchResults] = useState<MatchResult[]>([])
  const [msg, setMsg]             = useState('')
  const [bulkPrice, setBulkPrice] = useState('')
  const [poSearchId, setPoSearchId]   = useState('')
  const [poSearching, setPoSearching] = useState(false)
  const [poSyncRows, setPoSyncRows]   = useState<Array<Record<string, unknown>> | null>(null)

  // ── Init from localStorage（僅還原表頭設定，不還原資料列）──
  useEffect(() => {
    try {
      const h = localStorage.getItem(HEADER_KEY)
      if (h) {
        const saved = JSON.parse(h)
        const def = makeDefaultHeader()
        // merge: 對空字串欄位也用預設值覆蓋
        const merged: PoHeader = { ...def, ...saved }
        for (const k of Object.keys(def) as (keyof PoHeader)[]) {
          if ((saved[k] ?? '') === '') (merged as unknown as Record<string, unknown>)[k] = def[k]
        }
        // 單號＝傳入時自動取號、開單日期＝一律帶當天，兩者都不還原 localStorage 舊值
        // （委外請購頁曾因日期停在舊值，ARGO 單開立日錯置成 6/25）
        merged.project_id = ''
        merged.begin_date = fmtDate(new Date())
        setHeader(merged)
      }
    } catch {}
  }, [])

  useEffect(() => { localStorage.setItem(HEADER_KEY, JSON.stringify(header)) }, [header])

  // ── Fetch sheet dates ──
  useEffect(() => {
    setDatesLoading(true)
    fetch('/api/argoerp/daily-order-sheet')
      .then(r => r.json())
      .then(j => {
        if (j.success) {
          setAvailDates(j.sheets ?? [])
          if (!pickerDate && j.sheets?.length) setPickerDate(j.sheets[0].sheet_date)
        }
      })
      .catch(() => {})
      .finally(() => setDatesLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Load from sheet ──
  const loadSheet = useCallback(async (date: string) => {
    if (!date) return
    try {
      const r = await fetch(`/api/argoerp/daily-order-sheet?date=${date}`)
      const j = await r.json()
      if (!j.success || !j.sheet) { alert(`找不到 ${date} 的出單表`); return }
      type SheetRowRaw = SourceRow & { po_status?: string; po_number?: string | null }
      const allCRows = (j.sheet.rows ?? []).filter((x: SheetRowRaw) => x.factory === 'C')
      const rows: SourceRow[] = allCRows.filter((x: SheetRowRaw) =>
        !x.po_number && x.po_status !== 'matched'
      )
      if (allCRows.length === 0) {
        alert(`${date} 出單表中沒有常平廠訂單`)
        return
      }
      if (rows.length === 0) {
        alert(`${date} 所有常平廠訂單（${allCRows.length} 筆）均已有採購單紀錄`)
        return
      }
      setSourceRows(rows)
      setLineEdits(rows.map((row) => {
        const seq = (row as unknown as Record<string, unknown>)['line_no_input'] as string | undefined
          || (row as unknown as Record<string, unknown>)['match_line_no'] as string | undefined
          || ''
        return { ...DEF_EDIT, lot_no: row.order_number, so_line_no: seq }
      }))
      setMatchResults([])
      setLoadedDate(date)

      // 缺序號警告
      const missingSeqRows = rows.filter(r => {
        const seq = (r as unknown as Record<string, unknown>)['line_no_input'] as string | undefined
        return !seq
      })
      if (missingSeqRows.length > 0) {
        const examples = [...new Set(missingSeqRows.map(r => r.order_number))].slice(0, 3).join('、')
        alert(`⚠️ ${missingSeqRows.length} 筆資料缺少 SO 序號（TPN_PART_NO 將為空）：${examples}${missingSeqRows.length > 3 ? '…' : ''}\n請先在每日出單表補齊 B欄序號，再重新載入。`)
      }
    } catch (e) { alert(`載入失敗：${e}`) }
  }, [])

  // ── Build ERP payload (memoized) ──
  const payload = useMemo<Array<Record<string, string>>>(() => {
    return sourceRows.map((row, i) => {
      const e = lineEdits[i] ?? DEF_EDIT
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
      rec['MBP_PART']                    = row.item_code
      rec['MBP_VER']                     = e.mbp_ver || '1'
      rec['ORDER_QTY_ORU']               = row.quantity
      rec['UNIT_OF_MEASURE_ORU']         = e.uom || 'PCS'
      rec['UNIT_PRICE_ORU']              = e.unit_price || '0'
      rec['DUEDATE']                     = row.delivery_date
      if ((e.lot_no ?? '').trim())              rec['MBP_LOT_NO']               = e.lot_no.trim()
      const remark = [row.item_name, row.note].filter(Boolean).join(' ')
      if (remark)                        rec['REMARK']                   = remark
      if ((e.remark2 ?? '').trim())             rec['REMARK2']                  = e.remark2.trim()
      rec['SO_PROJECT_ID']               = row.order_number
      if ((e.packing ?? '').trim())    rec['PACKING']     = e.packing.trim()
      if ((e.so_line_no ?? '').trim()) {
        rec['TPN_PART_NO'] = e.so_line_no.trim()
      }
      return rec
    })
  }, [sourceRows, lineEdits, header])

  // ── Export CSV / XLSX ──
  const doExport = useCallback(() => {
    if (payload.length === 0) return
    const now = new Date()
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    const fn = `ArgoERP_常平採購單_${header.project_id}_${ts}`
    const dataRows = payload.map(r => ERP_KEYS.map(k => r[k] ?? ''))
    if (exportFmt === 'xlsx') {
      const ws = XLSX.utils.aoa_to_sheet([[...ERP_KEYS], ...dataRows])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '採購單')
      XLSX.writeFile(wb, `${fn}.xlsx`)
    } else {
      const lines = [[...ERP_KEYS].join(','), ...dataRows.map(row =>
        row.map(v => (v.includes(',') || v.includes('"') || v.includes('\n'))
          ? `"${v.replace(/"/g, '""')}"` : v).join(','),
      )]
      const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `${fn}.csv`; a.click()
      URL.revokeObjectURL(url)
    }
  }, [payload, exportFmt, header.project_id])

  // ── 手動抓最新單號（僅供預覽，實際匯入時會再重抓一次）──
  const [poNoLoading, setPoNoLoading] = useState(false)
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

  // ── Import to ERP ──
  const handleImport = useCallback(async () => {
    if (!header.tpn_partner_id.trim()) { alert('請填寫廠商編號'); return }
    if (payload.length === 0) { alert('尚無明細資料'); return }
    setImporting(true); setMsg('')

    // 按下傳入 ARGO 當下即時取號：抓當天最新 POC 單號 +1，不使用畫面上可能過期的舊值
    let pid = ''
    try {
      pid = await fetchNextPocNo()
      setHeader(p => ({ ...p, project_id: pid }))
    } catch (e) {
      setImporting(false)
      const m = `❌ 取號失敗，未匯入：${e instanceof Error ? e.message : String(e)}`
      setMsg(m); alert(m)
      setTimeout(() => setMsg(''), 10000)
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
        setSourceRows([]); setLineEdits([]); setLoadedDate(null)
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

  const setH = useCallback(<K extends keyof PoHeader>(k: K, v: PoHeader[K]) => {
    setHeader(p => ({ ...p, [k]: v }))
  }, [])

  const setLE = useCallback((i: number, k: keyof LineEdit, v: string) => {
    setLineEdits(p => p.map((e, j) => j === i ? { ...e, [k]: v } : e))
  }, [])

  const applyBulkPrice = useCallback(() => {
    if (!bulkPrice.trim()) return
    setLineEdits(p => p.map(e => ({ ...e, unit_price: bulkPrice.trim() })))
    setBulkPrice('')
  }, [bulkPrice])

  const handleClearAll = useCallback(() => {
    setSourceRows([]); setLineEdits([]); setMatchResults([]); setLoadedDate(null)
  }, [])

  // ── 移除已匯入項目（比對 erp_pj_sync sub_no = LINE_NO）──
  const [removingImported, setRemovingImported] = useState(false)
  const removeImported = useCallback(async () => {
    const pid = header.project_id.trim()
    if (!pid) { alert('請先按「抓最新單號」取得採購單號'); return }
    if (sourceRows.length === 0) return
    setRemovingImported(true)
    try {
      const { data, error } = await supabase
        .from('erp_pj_sync')
        .select('sub_no')
        .eq('doc_type', '採購單號')
        .eq('doc_no', pid)
      if (error) throw error
      const imported = data ?? []
      if (imported.length === 0) {
        setMsg('⚠️ erp_pj_sync 查無此採購單，請先至 ERP 同步區執行 PO 同步')
        setTimeout(() => setMsg(''), 6000)
        return
      }
      // sub_no 即 LINE_NO（payload 建立時 i+1）
      const importedLineNos = new Set(imported.map(r => String(r.sub_no ?? '').trim()))
      const keepIndices: number[] = []
      for (let i = 0; i < sourceRows.length; i++) {
        const lineNo = String(i + 1)
        if (!importedLineNos.has(lineNo)) keepIndices.push(i)
      }
      const removedCount = sourceRows.length - keepIndices.length
      if (removedCount === 0) {
        setMsg(`ℹ️ 查無已匯入行號（erp_pj_sync 有 ${imported.length} 筆，但 LINE_NO 未對應）`)
        setTimeout(() => setMsg(''), 6000)
        return
      }
      setSourceRows(prev => keepIndices.map(i => prev[i]))
      setLineEdits(prev => keepIndices.map(i => prev[i] ?? DEF_EDIT))
      setMatchResults(prev => keepIndices.map(i => prev[i] ?? { status: null, line_no: null, reason: '' }))
      setMsg(`✅ 已移除 ${removedCount} 筆已匯入項目（LINE_NO: ${[...importedLineNos].sort().join(', ')}），剩餘 ${keepIndices.length} 筆`)
      setTimeout(() => setMsg(''), 8000)
    } catch (e) {
      setMsg(`❌ 查詢失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setMsg(''), 6000)
    } finally { setRemovingImported(false) }
  }, [header.project_id, sourceRows])

  // ── 查詢 ERP 同步区採購單 (erp_pj_sync) ──
  const searchPoSync = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) return
    setPoSearching(true)
    try {
      const { data, error } = await supabase
        .from('erp_pj_sync')
        .select('doc_no,sub_no,item_code,description,qty,unit,status,start_date,end_date,customer_vendor,remark,extra,synced_at')
        .eq('doc_type', '採購單號')
        .ilike('doc_no', `%${trimmed}%`)
        .order('doc_no', { ascending: true })
        .order('sub_no', { ascending: true })
        .limit(200)
      if (error) throw error
      setPoSyncRows(data ?? [])
    } catch (e) {
      setMsg(`❌ 查詢失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setMsg(''), 6000)
    } finally { setPoSearching(false) }
  }, [])

  // ── 回寫採購單號到每日出單表 ──
  const [syncingPoBack, setSyncingPoBack] = useState(false)
  const syncPoNumberBack = useCallback(async () => {
    const pid = header.project_id.trim()
    if (!pid) { alert('請先按「抓最新單號」或先匯入 ERP 取得採購單號'); return }
    if (!loadedDate) { alert('尚未載入出單表日期'); return }
    if (sourceRows.length === 0) return
    setSyncingPoBack(true); setMsg('')
    try {
      const updates = sourceRows
        .filter(r => r.row_key)
        .map(r => ({ row_key: r.row_key!, po_number: pid, po_status: 'matched' }))
      if (updates.length === 0) { setMsg('⚠️ 來源資料無 row_key，無法回寫'); setTimeout(() => setMsg(''), 5000); return }
      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: loadedDate, updates }),
      })
      const j = await res.json()
      if (!j.success) throw new Error(j.error ?? '回寫失敗')
      setMsg(`✅ 已將 ${updates.length} 筆常平訂單的採購單號（${pid}）回寫至 ${loadedDate} 出單表`)
      setTimeout(() => setMsg(''), 8000)
    } catch (e) {
      setMsg(`❌ 回寫失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setMsg(''), 6000)
    } finally { setSyncingPoBack(false) }
  }, [header.project_id, loadedDate, sourceRows])

  // ── 來源序號比對 (erp_so_lines) ──
  const runSerialMatch = useCallback(async () => {
    if (sourceRows.length === 0) return
    setMatching(true); setMsg('')
    try {
      const orderNumbers = [...new Set(sourceRows.map(r => r.order_number).filter(Boolean))]
      const { data: soLines, error } = await supabase
        .from('erp_so_lines')
        .select('project_id, line_no, mbp_part, order_qty_oru, unit_of_measure_oru, remark2, packing')
        .in('project_id', orderNumbers.length > 0 ? orderNumbers : ['__none__'])
      if (error) throw error
      const lines = soLines ?? []
      const soProjectIds = new Set(lines.map((l: { project_id: string }) => l.project_id))
      type SoLine = { project_id: string; line_no: unknown; mbp_part: string | null; order_qty_oru: unknown; unit_of_measure_oru: string | null; remark2: string | null; packing: string | null }
      const candidateMap = new Map<string, string[]>()
      const soLineInfoMap = new Map<string, { uom: string | null; remark2: string | null; packing: string | null }>()
      for (const line of (lines as SoLine[])) {
        const qty = Number(line.order_qty_oru ?? 0)
        const key = `${line.project_id}|${line.mbp_part ?? ''}|${qty}`
        if (!candidateMap.has(key)) candidateMap.set(key, [])
        candidateMap.get(key)!.push(String(line.line_no ?? ''))
        soLineInfoMap.set(`${line.project_id}|${String(line.line_no ?? '')}`, { uom: line.unit_of_measure_oru, remark2: line.remark2, packing: line.packing })
      }
      for (const arr of candidateMap.values())
        arr.sort((a, b) => (Number(a) || 0) - (Number(b) || 0))
      const usageCounter = new Map<string, number>()

      const results: MatchResult[] = sourceRows.map(src => {
        if (!src.order_number || !soProjectIds.has(src.order_number))
          return { status: 'no_order', line_no: null, reason: '無對應來源單號' }
        const qty = parseFloat(String(src.quantity).replace(/,/g, '')) || 0
        const key = `${src.order_number}|${src.item_code}|${qty}`
        const candidates = candidateMap.get(key) ?? []
        if (candidates.length === 0)
          return { status: 'no_qty_match', line_no: null, reason: '有來源單號但無對應數量' }
        const used = usageCounter.get(key) ?? 0
        const lineNo = candidates[Math.min(used, candidates.length - 1)]
        usageCounter.set(key, used + 1)
        return { status: 'matched', line_no: lineNo, reason: '' }
      })
      setMatchResults(results)
      setLineEdits(prev => prev.map((e, i) => {
        if (results[i]?.status !== 'matched' || !results[i].line_no) return e
        const lineNo = results[i].line_no!
        const soInfo = soLineInfoMap.get(`${sourceRows[i]?.order_number ?? ''}|${lineNo}`)
        return {
          ...e,
          so_line_no: lineNo,
          uom:        soInfo?.uom || e.uom,
          remark2:    soInfo?.remark2 ?? e.remark2,
          packing:    soInfo?.packing ?? e.packing,
        }
      }))
      const matched = results.filter(r => r.status === 'matched').length
      setMsg(`✅ 序號比對完成：成功 ${matched} / ${results.length}`)
      setTimeout(() => setMsg(''), 5000)
    } catch (e) {
      setMsg(`❌ 比對失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setMsg(''), 6000)
    } finally { setMatching(false) }
  }, [sourceRows])

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────
  if (!unlocked) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="bg-slate-900 border border-slate-700 rounded-2xl p-8 w-80 flex flex-col items-center gap-4">
          <div className="text-2xl">🔒</div>
          <h2 className="text-white font-semibold text-lg">常平採購</h2>
          <p className="text-slate-400 text-sm">請輸入密碼以繼續</p>
          <input
            type="password"
            value={pwInput}
            onChange={e => { setPwInput(e.target.value); setPwError(false) }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                if (pwInput === '666') { setUnlocked(true) }
                else { setPwError(true); setPwInput('') }
              }
            }}
            placeholder="密碼"
            autoFocus
            className={`w-full px-4 py-2 rounded-lg bg-slate-800 border text-white text-center tracking-widest focus:outline-none ${
              pwError ? 'border-red-500' : 'border-slate-600 focus:border-cyan-500'
            }`}
          />
          {pwError && <p className="text-red-400 text-xs">密碼錯誤</p>}
          <button
            onClick={() => {
              if (pwInput === '666') { setUnlocked(true) }
              else { setPwError(true); setPwInput('') }
            }}
            className="w-full py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium transition-colors"
          >
            進入
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1800px] mx-auto">

        {/* ── Page Header ── */}
        <div className="mb-6 border-b border-slate-800 pb-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">出單表➜常平採購</h1>
            <p className="text-slate-400 mt-1 text-sm">ArgoERP — 每日出單表（常平 C）→ IFAF024 採購訂單（PO）｜一張主表 + 多筆明細</p>
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            {datesLoading ? (
              <span className="text-slate-500 text-sm px-2">讀取出單表…</span>
            ) : (
              <>
                <select
                  value={pickerDate}
                  onChange={e => setPickerDate(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-sm focus:outline-none focus:border-orange-500"
                >
                  <option value="">選擇出單日期…</option>
                  {availDates.map(s => (
                    <option key={s.sheet_date} value={s.sheet_date}>
                      {s.sheet_date}（{s.pending_c_count != null ? (s.pending_c_count > 0 ? `待處理 ${s.pending_c_count} 筆` : '已完成') : `${s.row_count} 筆`}）
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => loadSheet(pickerDate)}
                  disabled={!pickerDate}
                  className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm"
                >
                  📋 載入出單表
                </button>
                {loadedDate && (
                  <span className="text-xs px-2 py-1 rounded border bg-orange-900/40 text-orange-300 border-orange-700/50">
                    已載入 {loadedDate}
                  </span>
                )}
              </>
            )}
            {sourceRows.length > 0 && (
              <>
                <button
                  onClick={() => void runSerialMatch()}
                  disabled={matching || importing}
                  className="px-4 py-2 rounded-lg bg-indigo-700 hover:bg-indigo-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm"
                >
                  {matching ? '比對中…' : '🔍 來源序號比對'}
                </button>
                <button
                  onClick={() => void handleImport()}
                  disabled={importing || matching}
                  className="px-4 py-2 rounded-lg bg-orange-700 hover:bg-orange-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-semibold transition-colors text-sm"
                >
                  {importing ? '匯入中…' : '🚀 匯入 ERP（IFAF024）'}
                </button>
                <button
                  onClick={handleClearAll}
                  className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:bg-red-900/40 hover:text-red-300 hover:border-red-700/50 transition-colors text-sm"
                >
                  全部清空
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Message bar ── */}
        {msg && (
          <div className={`mb-4 px-4 py-3 rounded-lg text-sm ${msg.startsWith('❌') ? 'bg-red-900/30 border border-red-700 text-red-300' : 'bg-emerald-900/30 border border-emerald-700 text-emerald-300'}`}>
            {msg}
          </div>
        )}

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
                <input value={header.begin_date} onChange={e => setH('begin_date', e.target.value)}
                  placeholder="YYYY/MM/DD"
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
                <input value={header.tpn_partner_id} onChange={e => setH('tpn_partner_id', e.target.value)}
                  placeholder="GLAF004 廠商代碼"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400 font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">部門 <span className="text-red-400">*</span></label>
                <input value={header.department} onChange={e => setH('department', e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400 font-mono" />
              </div>
              <div>
                <label className="text-xs text-slate-400 block mb-1">業務員 <span className="text-red-400">*</span></label>
                <input value={header.sales_id} onChange={e => setH('sales_id', e.target.value)}
                  placeholder="員工編號"
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
                <input value={header.payment_term} onChange={e => setH('payment_term', e.target.value)}
                  placeholder="GLAF005 條件代碼"
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
                <input value={header.tax_rate} onChange={e => setH('tax_rate', e.target.value)}
                  placeholder="0.05 / 0.13 / 0"
                  className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm focus:outline-none focus:border-orange-400" />
              </div>
            </div>
          )}
        </div>

        {/* ── Status bar ── */}
        <div className="mb-6 bg-slate-900 border border-slate-800 rounded-lg p-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <div className="text-xs text-slate-500 mb-1">出單表</div>
              <div className={`font-semibold truncate ${loadedDate ? 'text-orange-300' : 'text-slate-600'}`}>{loadedDate ?? '未載入'}</div>
            </div>
            <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <div className="text-xs text-slate-500 mb-1">採購單號（PROJECT_ID）</div>
              <div className="font-mono font-bold text-orange-300 truncate">{header.project_id || '—'}</div>
            </div>
            <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <div className="text-xs text-slate-500 mb-1">明細筆數</div>
              <div className={`font-bold ${sourceRows.length > 0 ? 'text-orange-300' : 'text-slate-600'}`}>
                {sourceRows.length} <span className="text-slate-500 font-normal text-xs">筆</span>
              </div>
            </div>
            <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <div className="text-xs text-slate-500 mb-1">廠商編號</div>
              <div className={`font-mono text-sm ${header.tpn_partner_id ? 'text-white' : 'text-red-400'}`}>
                {header.tpn_partner_id || '⚠ 未填寫'}
              </div>
            </div>
          </div>
        </div>

        {/* ── Line items table ── */}
        {sourceRows.length > 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-700 bg-orange-900/20 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-orange-300">
                採購明細（{sourceRows.length} 筆）
                <span className="text-xs text-slate-400 font-normal ml-2">橘色欄位可逐列編輯</span>
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">批量設定單價：</span>
                <input
                  value={bulkPrice}
                  onChange={e => setBulkPrice(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && applyBulkPrice()}
                  placeholder="輸入單價"
                  className="w-24 px-2 py-1 rounded bg-slate-800 border border-orange-700/60 text-orange-200 text-xs text-right focus:outline-none focus:border-orange-400"
                />
                <button
                  onClick={applyBulkPrice}
                  disabled={!bulkPrice.trim()}
                  className="px-3 py-1 rounded bg-orange-800/70 border border-orange-700/50 text-orange-200 hover:bg-orange-700 disabled:opacity-40 transition-colors text-xs"
                >
                  套用全部
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800/80 border-b border-slate-700">
                    <th className="px-2 py-3 text-center text-slate-500 font-mono text-xs w-10">#</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs whitespace-nowrap">銷售訂單</th>
                    <th className="px-3 py-3 text-center text-indigo-300 font-medium text-xs whitespace-nowrap">比對序號</th>
                    <th className="px-3 py-3 text-center text-sky-300 font-medium text-xs whitespace-nowrap">SO序號 *</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs whitespace-nowrap">貨號</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs">品名/規格 / 批號</th>
                    <th className="px-3 py-3 text-right text-slate-300 font-medium text-xs whitespace-nowrap">數量</th>
                    <th className="px-3 py-3 text-center text-orange-300 font-medium text-xs whitespace-nowrap">單位</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs whitespace-nowrap">交貨日</th>
                    <th className="px-3 py-3 text-left text-orange-300 font-medium text-xs whitespace-nowrap">備註2 / 包裝方式</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceRows.map((row, i) => (
                    <tr key={i} className={`border-b border-slate-800/50 ${i % 2 === 0 ? '' : 'bg-slate-900/40'} hover:bg-slate-800/50`}>
                      <td className="px-2 py-1.5 text-center text-slate-500 font-mono text-xs">{i + 1}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-slate-300 whitespace-nowrap">{row.order_number || '—'}</td>
                      <td className="px-3 py-1.5 text-center">
                        {matchResults[i]?.status === 'matched' && matchResults[i].line_no ? (
                          <span className="px-2 py-0.5 rounded border text-xs font-mono bg-emerald-900/40 text-emerald-300 border-emerald-700/50">{matchResults[i].line_no}</span>
                        ) : matchResults[i]?.status === 'no_order' ? (
                          <span className="px-1.5 py-0.5 rounded border text-xs bg-red-900/30 text-red-300 border-red-800/50" title={matchResults[i].reason}>無單號</span>
                        ) : matchResults[i]?.status === 'no_qty_match' ? (
                          <span className="px-1.5 py-0.5 rounded border text-xs bg-amber-900/30 text-amber-300 border-amber-700/50" title={matchResults[i].reason}>數量不符</span>
                        ) : (
                          <span className="text-slate-700 text-xs">—</span>
                        )}
                      </td>
                      <td className="px-1 py-1">
                        <input value={lineEdits[i]?.so_line_no ?? ''} onChange={e => setLE(i, 'so_line_no', e.target.value)}
                          className="w-16 px-2 py-1 rounded bg-slate-800 border border-sky-700/50 text-sky-200 text-xs text-center focus:outline-none focus:border-sky-400" />
                      </td>
                      <td className="px-3 py-1.5 font-mono text-xs text-slate-300 whitespace-nowrap">{row.item_code || '—'}</td>
                      <td className="px-3 py-1.5 max-w-[240px]">
                        <div className="text-xs text-slate-300 truncate" title={[row.item_name, row.note].filter(Boolean).join(' ')}>
                          {[row.item_name, row.note].filter(Boolean).join(' ') || '—'}
                        </div>
                        <input value={lineEdits[i]?.lot_no ?? ''} onChange={e => setLE(i, 'lot_no', e.target.value)}
                          placeholder="批號…"
                          className="mt-1 w-full px-2 py-0.5 rounded bg-slate-800 border border-orange-700/40 text-white text-xs focus:outline-none focus:border-orange-400" />
                      </td>
                      <td className="px-3 py-1.5 text-right text-xs text-slate-300 whitespace-nowrap">{row.quantity}</td>
                      <td className="px-1 py-1">
                        <input value={lineEdits[i]?.uom ?? 'PCS'} onChange={e => setLE(i, 'uom', e.target.value)}
                          className="w-16 px-2 py-1 rounded bg-slate-800 border border-orange-700/40 text-white text-xs text-center focus:outline-none focus:border-orange-400" />
                      </td>
                      <td className="px-3 py-1.5 text-xs text-yellow-400/80 whitespace-nowrap">{row.delivery_date || '—'}</td>
                      <td className="px-1 py-1.5">
                        <input value={lineEdits[i]?.remark2 ?? ''} onChange={e => setLE(i, 'remark2', e.target.value)}
                          placeholder="備註2…"
                          className="w-32 px-2 py-1 rounded bg-slate-800 border border-orange-700/40 text-white text-xs focus:outline-none focus:border-orange-400" />
                        <input value={lineEdits[i]?.packing ?? ''} onChange={e => setLE(i, 'packing', e.target.value)}
                          placeholder="包裝方式…"
                          className="mt-1 w-32 px-2 py-1 rounded bg-slate-800 border border-sky-700/40 text-sky-200 text-xs focus:outline-none focus:border-sky-400" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-12 text-center">
            <p className="text-slate-500">尚無明細，請選擇出單日期並載入</p>
            <p className="text-slate-600 text-xs mt-2">自動篩選廠別「常平（C）」且尚未有採購單紀錄的訂單；每天所有常平訂單共用一張採購單</p>
          </div>
        )}

        {/* ── 欄位對應說明 ── */}
        {sourceRows.length > 0 && (
          <details className="mt-6">
            <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-400 mb-2">IFAF024 欄位對應說明</summary>
            <div className="bg-slate-900/50 border border-orange-800/20 rounded-lg p-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1">
                <div className="col-span-full text-orange-300 font-semibold mb-1">表頭（Header）— 全部明細共用</div>
                {[
                  ['PROJECT_ID', '採購單號（手動設定）'],
                  ['MODIFY_VER', '變更版本（預設 1）'],
                  ['BEGIN_DATE', '開立日期（手動設定）'],
                  ['HOLD_STATUS', '訂單狀態（預設 OPEN）'],
                  ['TPN_PARTNER_ID', '廠商編號（手動設定）'],
                  ['SEG_SEGMENT_NO_DEPARTMENT', '部門（預設 M1100）'],
                  ['SALES_ID', '業務員（手動設定）'],
                  ['PO_TYPE', '訂單類別（GENERAL）'],
                  ['PAYMENT_TERM', '付款條件（手動設定）'],
                  ['PAYMENT_MODE', '付款方式（T=T/T）'],
                  ['CURRENCY', '幣別（NTD）'],
                  ['EXCHANGE_RATE', '匯率（1）'],
                  ['TAX_RATE', '稅率（0.05）'],
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <span className="text-slate-500 w-36 shrink-0 font-mono">{k}</span>
                    <span className="text-orange-300">{v}</span>
                  </div>
                ))}
                <div className="col-span-full text-orange-300 font-semibold mt-3 mb-1">明細（Line）— 每筆出單表各一列</div>
                {[
                  ['LINE_NO', '序號（自動遞增）'],
                  ['MBP_PART', '品項編碼'],
                  ['ORDER_QTY_ORU', '數量'],
                  ['UNIT_OF_MEASURE_ORU', '採購單位（可逐列修改）'],
                  ['UNIT_PRICE_ORU', '單價（可逐列修改）'],
                  ['DUEDATE', '交貨日期'],
                  ['REMARK', '品名規格+備註'],
                  ['SO_PROJECT_ID', '銷售訂單（工單編號）'],
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-2">
                    <span className="text-slate-500 w-36 shrink-0 font-mono">{k}</span>
                    <span className="text-orange-300">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          </details>
        )}

        {/* ── ERP 採購單同步確認 ── */}
        <div className="mt-8 bg-slate-900 border border-slate-700 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="text-sm font-semibold text-slate-200">🔎 ERP 同步確認 — 採購單號查詢</h2>
              {poSearching && (
                <span className="px-2 py-0.5 rounded-full text-xs bg-slate-700 text-slate-400 animate-pulse">查詢中…</span>
              )}
              {!poSearching && poSyncRows === null && (
                <span className="px-2 py-0.5 rounded-full text-xs bg-slate-800 border border-slate-700 text-slate-500">未查詢</span>
              )}
              {!poSearching && poSyncRows !== null && poSyncRows.length === 0 && (
                <span className="px-2 py-0.5 rounded-full text-xs bg-red-900/40 border border-red-800/50 text-red-300">查無資料</span>
              )}
              {!poSearching && poSyncRows !== null && poSyncRows.length > 0 && (
                <span className="px-2 py-0.5 rounded-full text-xs bg-emerald-900/40 border border-emerald-700/50 text-emerald-300">✓ {poSyncRows.length} 筆</span>
              )}
              <p className="text-xs text-slate-500 w-full mt-0">查詢 erp_pj_sync，doc_type=採購單號</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={poSearchId}
                onChange={e => setPoSearchId(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && void searchPoSync(poSearchId)}
                placeholder="輸入採購單號…"
                className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-600 text-white text-sm w-48 focus:outline-none focus:border-orange-400 font-mono placeholder:text-slate-500"
              />
              <button
                onClick={() => {
                  const q = poSearchId.trim() || header.project_id
                  setPoSearchId(q)
                  void searchPoSync(q)
                }}
                disabled={poSearching}
                className="px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm font-medium transition-colors"
              >
                {poSearching ? '查詢中…' : '查詢'}
              </button>
              {header.project_id && poSearchId !== header.project_id && (
                <button
                  onClick={() => { setPoSearchId(header.project_id); void searchPoSync(header.project_id) }}
                  className="px-3 py-1.5 rounded-lg bg-orange-900/40 border border-orange-700/50 text-orange-300 hover:bg-orange-800/50 text-xs transition-colors whitespace-nowrap"
                >
                  帶入 {header.project_id}
                </button>
              )}
            </div>
          </div>

          {poSyncRows === null ? (
            <div className="px-4 py-8 text-center text-slate-600 text-sm">
              請輸入採購單號後點「查詢」，或點「帶入」自動填入目前表頭採購單號
            </div>
          ) : poSyncRows.length === 0 ? (
            <div className="px-4 py-8 text-center text-slate-500 text-sm">
              ERP 同步區中找不到採購單號含「{poSearchId}」的資料<br />
              <span className="text-xs text-slate-600 mt-1 block">請確認已在 ERP 同步頁面執行「採購單號」同步，或該採購單尚未建立於 ArgoERP</span>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="px-4 py-2 text-xs text-slate-400 bg-slate-900/50 border-b border-slate-800">
                共 {poSyncRows.length} 筆，同步時間：{poSyncRows[0]?.synced_at ? String(poSyncRows[0].synced_at).slice(0, 19).replace('T', ' ') : '—'}
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-800/60 border-b border-slate-700 text-slate-400">
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">採購單號</th>
                    <th className="px-2 py-2 text-center font-medium">序號</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">品項編碼</th>
                    <th className="px-3 py-2 text-left font-medium">品名/規格</th>
                    <th className="px-2 py-2 text-right font-medium">數量</th>
                    <th className="px-2 py-2 text-center font-medium">單位</th>
                    <th className="px-2 py-2 text-center font-medium">狀態</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">開立日</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">交貨日</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">廠商</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">來源SO</th>
                    <th className="px-2 py-2 text-center font-medium whitespace-nowrap">SO序號</th>
                    <th className="px-3 py-2 text-left font-medium">備註2</th>
                  </tr>
                </thead>
                <tbody>
                  {poSyncRows.map((r, i) => (
                    <tr key={i} className={`border-b border-slate-800/40 ${i % 2 === 0 ? '' : 'bg-slate-900/30'}`}>
                      <td className="px-3 py-1.5 font-mono text-orange-300 whitespace-nowrap">{String(r.doc_no ?? '—')}</td>
                      <td className="px-2 py-1.5 text-center font-mono text-slate-400">{String(r.sub_no ?? '—')}</td>
                      <td className="px-3 py-1.5 font-mono text-purple-300 whitespace-nowrap">{String(r.item_code ?? '—')}</td>
                      <td className="px-3 py-1.5 text-slate-300 max-w-[220px] truncate" title={String(r.description ?? '')}>{String(r.description ?? '—')}</td>
                      <td className="px-2 py-1.5 text-right text-slate-300">{String(r.qty ?? '—')}</td>
                      <td className="px-2 py-1.5 text-center text-slate-400">{String(r.unit ?? '—')}</td>
                      <td className="px-2 py-1.5 text-center">
                        {r.status === 'OPEN'
                          ? <span className="px-1.5 py-0.5 rounded text-xs bg-emerald-900/40 text-emerald-300">OPEN</span>
                          : r.status === 'CLOSE'
                          ? <span className="px-1.5 py-0.5 rounded text-xs bg-slate-700 text-slate-400">CLOSE</span>
                          : r.status
                          ? <span className="px-1.5 py-0.5 rounded text-xs bg-amber-900/40 text-amber-300">{String(r.status)}</span>
                          : <span className="text-slate-600">—</span>
                        }
                      </td>
                      <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap">{String(r.start_date ?? '—').slice(0, 10)}</td>
                      <td className="px-3 py-1.5 text-yellow-400/80 whitespace-nowrap">{String(r.end_date ?? '—').slice(0, 10)}</td>
                      <td className="px-3 py-1.5 font-mono text-slate-400 whitespace-nowrap">{String(r.customer_vendor ?? '—')}</td>
                      <td className="px-3 py-1.5 font-mono text-sky-300/80 whitespace-nowrap">{String((r.extra as Record<string,unknown>)?.SO_PROJECT_ID ?? '—')}</td>
                      <td className="px-2 py-1.5 text-center font-mono text-sky-200">{String((r.extra as Record<string,unknown>)?.SO_LINE_NO ?? '—')}</td>
                      <td className="px-3 py-1.5 text-slate-500 max-w-[160px] truncate" title={String(r.remark ?? '')}>{String(r.remark ?? '—')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
