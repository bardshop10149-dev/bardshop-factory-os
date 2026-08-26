'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../../../../lib/supabaseClient'
import SoOrderModal from '../../../../components/SoOrderModal'

// ==================== 型別 ====================
interface GroupRow {
  row_key: string
  order_number: string
  doc_type: string
  factory: 'T' | 'C' | 'O'
  customer: string
  item_code: string
  item_name: string
  note: string
  packing?: string
  quantity: string
  delivery_date: string
  plate_count: string
  handler: string
  issuer: string
  is_sample: string
  has_material: string
  designer: string
  line_nickname: string
  upload_ro: string
  order_status: string
  pm_note: string
  receiver: string
  mo_status: '已匯入製令' | null
  mo_number?: string
  match_line_no?: string | null
  sheet_date: string
}

type PostSyncStep = { label: string; status: 'pending' | 'running' | 'done' | 'error' }

type PreviewGroup = {
  mo: string
  rows: Array<{ row: GroupRow; lineNo: number }>
}

type DateSummary = {
  date: string
  total: number
  pending: number
  imported: number
}

// ==================== 工具函式 ====================
function fmtDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function nextBizDay(from: Date): Date {
  const d = new Date(from)
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return d
}

function truncateToBytes(text: string, maxBytes: number): string {
  const enc = new TextEncoder()
  const bytes = enc.encode(text)
  if (bytes.length <= maxBytes) return text
  const dec = new TextDecoder('utf-8')
  let cut = maxBytes
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--
  return dec.decode(bytes.slice(0, cut))
}

function fixPackingShift(row: GroupRow, sheetDate: string): GroupRow {
  if (sheetDate >= '2026-06-18') return row
  if (!row.quantity || !/^\d{4}[\/\-]/.test(row.quantity)) return row
  return {
    ...row,
    packing:       '',
    quantity:      row.packing       ?? '',
    delivery_date: row.quantity      ?? '',
    plate_count:   row.delivery_date ?? '',
    upload_ro:     row.plate_count   ?? '',
    order_status:  row.upload_ro     ?? '',
    pm_note:       row.order_status  ?? '',
  }
}

function buildErpRecord(row: GroupRow, moNumber: string, lineNo: number = 1): Record<string, string> {
  const today = new Date()
  const rec: Record<string, string> = {}
  rec['PROJECT_ID'] = moNumber
  rec['BEGIN_DATE'] = fmtDate(nextBizDay(today))
  if (row.delivery_date) rec['END_DATE'] = row.delivery_date.replace(/\//g, '-')
  rec['HOLD_STATUS'] = 'OPEN'
  rec['SEG_SEGMENT_NO_DEPARTMENT'] = 'M1100'
  rec['PJT_SEG_SEGMENT_NO'] = 'M1000'
  rec['MO_BEGIN_DATE'] = fmtDate(today)
  rec['AUTO_PREPARE'] = 'N'
  rec['LINE_NO'] = String(lineNo)
  if (row.item_code) rec['MBP_PART'] = row.item_code
  rec['MBP_VER'] = '1'
  if (row.order_number) rec['MBP_LOT_NO'] = truncateToBytes(row.order_number, 30)
  if (row.quantity) rec['ORDER_QTY'] = row.quantity.replace(/,/g, '')
  rec['BOM_LEVELS'] = '99'
  rec['EQUIVALENT_RATIO'] = '1'
  rec['EQUIVALENT_RATIO_M'] = '1'
  if (row.order_number) rec['PJT_PROJECT_ID_MO_SO'] = row.order_number
  const noteStr = [row.item_name, row.note].filter(Boolean).join(' ')
  if (noteStr) rec['REMARK_LINE'] = noteStr
  return rec
}

function genMotNumber(date: Date, seq: number): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `MOT${y}${m}${d}${String(seq).padStart(2, '0')}`
}

// 集單製令單號類型
const MOS_TYPES: Array<{ label: string; code: string }> = [
  { label: '0.8mm 集單', code: '08MM' },
  { label: '2mm 集單',   code: '2MM'  },
  { label: '3mm 集單',   code: '3MM'  },
  { label: '5mm 集單',   code: '5MM'  },
  { label: '8mm 集單',   code: '8MM'  },
  { label: 'PVC 卡片',   code: 'PVC'  },
]

// MOS 集單製令單號格式：MOS + 訂單號數字部分 + 序號(2碼) + -類型- + MMDD
// 例：SOB260629503 序號1 8mm → MOS26062950301-8MM-0707
function genMosNumber(orderNumber: string, matchLineNo: string | null | undefined, typeCode: string, date: Date): string {
  const numericPart = orderNumber.replace(/^[A-Za-z]+/, '')
  const seq = String(parseInt(String(matchLineNo ?? '1'), 10) || 1).padStart(2, '0')
  const mmdd = `${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  return `MOS${numericPart}${seq}-${typeCode}-${mmdd}`
}

// ==================== 頁面元件 ====================
export default function GroupOrderExportPage() {
  const [rows, setRows] = useState<GroupRow[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set())
  const [activeTab, setActiveTab] = useState<'unmatched' | 'matched' | 'imported'>('unmatched')
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [moInputs, setMoInputs] = useState<Record<string, string>>({})
  const [autoMatching, setAutoMatching] = useState(false)
  const [autoMatchMsg, setAutoMatchMsg] = useState('')
  const [moQtyMismatch, setMoQtyMismatch] = useState<Set<string>>(new Set())
  const [importPreview, setImportPreview] = useState<PreviewGroup[] | null>(null)
  const [importing, setImporting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [soModalId, setSoModalId] = useState<string | null>(null)
  const [postSyncModal, setPostSyncModal] = useState<{ show: boolean; steps: PostSyncStep[]; error: string | null } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [forceReimport, setForceReimport] = useState(false)
  const [mosType, setMosType] = useState<string>('8MM')

  // ==================== 載入 ====================
  const loadRows = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('daily_order_sheets')
        .select('sheet_date, rows')
        .order('sheet_date', { ascending: false })
      if (error) throw error
      const allRows: GroupRow[] = []
      for (const sheet of (data ?? [])) {
        const sheetRows = Array.isArray(sheet.rows) ? (sheet.rows as GroupRow[]) : []
        for (const r of sheetRows) {
          if (!String(r.doc_type ?? '').includes('集單')) continue
          const fixed = fixPackingShift(r, sheet.sheet_date)
          allRows.push({ ...fixed, sheet_date: sheet.sheet_date })
        }
      }
      setRows(allRows)
      const inputs: Record<string, string> = {}
      for (const r of allRows) {
        if (r.mo_number) inputs[r.row_key] = r.mo_number
      }
      setMoInputs(inputs)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadRows() }, [loadRows])

  // ==================== 衍生資料 ====================
  const dateSummary = useMemo<DateSummary[]>(() => {
    const map = new Map<string, DateSummary>()
    for (const r of rows) {
      const s = map.get(r.sheet_date) ?? { date: r.sheet_date, total: 0, pending: 0, imported: 0 }
      s.total++
      if (r.mo_status === '已匯入製令') s.imported++
      else s.pending++
      map.set(r.sheet_date, s)
    }
    return [...map.values()].sort((a, b) => b.date.localeCompare(a.date))
  }, [rows])

  const getMo = useCallback((r: GroupRow) => (moInputs[r.row_key] ?? '').trim(), [moInputs])

  const filteredRows = useMemo(() => {
    let result = selectedDates.size === 0 ? rows : rows.filter(r => selectedDates.has(r.sheet_date))
    if (activeTab === 'unmatched') result = result.filter(r => r.mo_status !== '已匯入製令' && !getMo(r))
    else if (activeTab === 'matched') result = result.filter(r => r.mo_status !== '已匯入製令' && !!getMo(r))
    else result = result.filter(r => r.mo_status === '已匯入製令')
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase()
      result = result.filter(r =>
        r.order_number?.toLowerCase().includes(q) ||
        r.item_code?.toLowerCase().includes(q) ||
        r.customer?.toLowerCase().includes(q) ||
        getMo(r).toLowerCase().includes(q)
      )
    }
    return result
  }, [rows, selectedDates, activeTab, searchQuery, getMo])

  const targetRows = useMemo(() =>
    selectedKeys.size > 0 ? filteredRows.filter(r => selectedKeys.has(r.row_key)) : filteredRows
  , [filteredRows, selectedKeys])

  const allSelected = filteredRows.length > 0 && filteredRows.every(r => selectedKeys.has(r.row_key))
  const unmatchedCount = useMemo(() => rows.filter(r => r.mo_status !== '已匯入製令' && !getMo(r)).length, [rows, getMo])
  const matchedCount = useMemo(() => rows.filter(r => r.mo_status !== '已匯入製令' && !!getMo(r)).length, [rows, getMo])
  const importedCount = useMemo(() => rows.filter(r => r.mo_status === '已匯入製令').length, [rows])

  const toggleAll = () => {
    if (allSelected) {
      setSelectedKeys(prev => { const n = new Set(prev); filteredRows.forEach(r => n.delete(r.row_key)); return n })
    } else {
      setSelectedKeys(prev => { const n = new Set(prev); filteredRows.forEach(r => n.add(r.row_key)); return n })
    }
  }

  // ==================== 自動比對製令 ====================
  const handleAutoMatch = useCallback(async () => {
    setAutoMatching(true)
    setAutoMatchMsg('')
    try {
      const needMatch = rows.filter(r => r.order_number?.trim())
      if (needMatch.length === 0) {
        setAutoMatchMsg('ℹ️ 沒有可比對的列（訂單號為空）')
        setTimeout(() => setAutoMatchMsg(''), 6000)
        return
      }
      const orderNumbers = [...new Set(needMatch.map(r => r.order_number.trim()))]
      const [res1, res2, resCount] = await Promise.all([
        supabase.from('erp_mo_lines').select('project_id, source_order, mbp_lot_no, mbp_part, order_qty').in('source_order', orderNumbers),
        supabase.from('erp_mo_lines').select('project_id, source_order, mbp_lot_no, mbp_part, order_qty').in('mbp_lot_no', orderNumbers),
        supabase.from('erp_mo_lines').select('project_id', { count: 'exact', head: true }),
      ])
      if (res1.error) throw res1.error
      if (res2.error) throw res2.error
      const totalInTable = resCount.count ?? 0
      const moLines = [
        ...(res1.data ?? []),
        ...(res2.data ?? []).filter(r2 => !(res1.data ?? []).some(r1 => r1.project_id === r2.project_id)),
      ]
      if (moLines.length === 0) {
        setAutoMatchMsg(totalInTable === 0
          ? '⚠ erp_mo_lines 尚無資料（請先到「ERP 同步」頁執行製令同步）'
          : `⚠ ERP ${totalInTable} 筆製令中，無 source_order 或 mbp_lot_no 符合集單訂單號`)
        setTimeout(() => setAutoMatchMsg(''), 10000)
        return
      }
      const matchMap = new Map<string, Array<{ project_id: string; erp_qty: number }>>()
      for (const line of moLines) {
        const so = (line.source_order ?? line.mbp_lot_no ?? '').trim()
        const part = (line.mbp_part ?? '').trim()
        if (!so || !part || !line.project_id) continue
        if (!/^MO[TM]/i.test(line.project_id)) continue
        const key = `${so}|${part}`
        const arr = matchMap.get(key) ?? []
        if (!arr.some(c => c.project_id === line.project_id)) {
          arr.push({ project_id: line.project_id, erp_qty: Number(line.order_qty ?? 0) })
          matchMap.set(key, arr)
        }
      }
      let matched = 0, qtyMismatch = 0, dupSkipped = 0
      const newMismatchKeys = new Set<string>()
      const newlyMatched: Record<string, string> = {}
      const usedProjectIds = new Set<string>()
      for (const r of needMatch) {
        const key = `${r.order_number.trim()}|${r.item_code.trim()}`
        const candidates = matchMap.get(key)
        if (!candidates || candidates.length === 0) continue
        const available = candidates.filter(c => !usedProjectIds.has(c.project_id))
        if (available.length === 0) { dupSkipped++; continue }
        const rowQty = Math.round(Number(r.quantity ?? 0))
        const exactMatch = rowQty > 0 ? available.find(c => Math.round(c.erp_qty) === rowQty) : undefined
        const hit = exactMatch ?? available.reduce((best, c) => c.project_id > best.project_id ? c : best)
        usedProjectIds.add(hit.project_id)
        newlyMatched[r.row_key] = hit.project_id
        matched++
        const erpQty = Math.round(hit.erp_qty)
        if (!isNaN(rowQty) && rowQty > 0 && rowQty !== erpQty) { newMismatchKeys.add(r.row_key); qtyMismatch++ }
      }
      const toClear = needMatch.filter(r => !newlyMatched[r.row_key])
      setMoInputs(prev => {
        const next = { ...prev, ...newlyMatched }
        for (const r of toClear) delete next[r.row_key]
        return next
      })
      setMoQtyMismatch(prev => {
        const next = new Set(prev)
        for (const k of newMismatchKeys) next.add(k)
        for (const r of toClear) next.delete(r.row_key)
        return next
      })
      if (needMatch.length > 0) {
        const byDate = new Map<string, Array<{ row_key: string; mo_number: string }>>()
        for (const r of needMatch) {
          const mo = newlyMatched[r.row_key] ?? ''
          const arr = byDate.get(r.sheet_date) ?? []
          arr.push({ row_key: r.row_key, mo_number: mo })
          byDate.set(r.sheet_date, arr)
        }
        for (const [date, updates] of byDate) {
          await fetch('/api/argoerp/daily-order-sheet', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sheet_date: date, updates }),
          })
        }
        setRows(prev => prev.map(r => {
          if (newlyMatched[r.row_key]) return { ...r, mo_number: newlyMatched[r.row_key] }
          if (toClear.some(c => c.row_key === r.row_key)) return { ...r, mo_number: undefined }
          return r
        }))
      }
      const dupNote = dupSkipped > 0 ? `⚠ 另有 ${dupSkipped} 筆因 ERP 製令重複使用被跳過` : ''
      if (matched === 0 && dupSkipped === 0) {
        const sampleMo = moLines.find(l => /^MO[TM]/i.test(l.project_id ?? '')) ?? moLines[0]
        const sampleRow = needMatch[0]
        setAutoMatchMsg(`⚠ ERP 比對 ${needMatch.length} 筆無符合｜ERP樣本 so=${sampleMo?.source_order ?? '(null)'} part=${sampleMo?.mbp_part ?? '(null)'}｜集單樣本 order=${sampleRow?.order_number} item=${sampleRow?.item_code}`)
      } else {
        const mismatchNote = qtyMismatch > 0 ? `，${qtyMismatch} 筆數量不符（橘色警示）` : ''
        const clearNote = toClear.length > 0 ? `，已清除 ${toClear.length} 筆無效舊單號` : ''
        const msgs = [`✅ ERP 比對符合 ${matched} 筆${mismatchNote}${clearNote}，已自動儲存`]
        if (dupNote) msgs.push(dupNote)
        setAutoMatchMsg(msgs.join('｜'))
      }
      setTimeout(() => setAutoMatchMsg(''), 12000)
    } catch (e) {
      setAutoMatchMsg(`❌ 比對失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setAutoMatchMsg(''), 8000)
    } finally {
      setAutoMatching(false)
    }
  }, [rows])

  // ==================== 自動產生 MOT 單號 ====================
  const handleAutoGenerateMOT = useCallback(async () => {
    const toGenerate = (selectedKeys.size > 0 ? filteredRows.filter(r => selectedKeys.has(r.row_key)) : filteredRows)
      .filter(r => r.mo_status !== '已匯入製令' && !getMo(r) && r.order_number?.trim())
    if (toGenerate.length === 0) {
      setAutoMatchMsg('ℹ️ 所有可見列都已有製令單號（或無訂單號）')
      setTimeout(() => setAutoMatchMsg(''), 4000)
      return
    }
    const today = new Date()
    const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
    const prefix = `MOT${dateStr}`

    // 查 DB 中今日日期序號已使用的 MOT 號
    const { data: existing } = await supabase
      .from('argoerp_mo_upload_log')
      .select('mo_number')
      .like('mo_number', `${prefix}%`)
    const usedNums = new Set((existing ?? []).map((r: { mo_number: string }) => r.mo_number))
    // 加入目前頁面所有已有的製令號（含跨日期）
    Object.values(moInputs).forEach(m => { if (m) usedNums.add(m) })
    rows.forEach(r => { if (r.mo_number) usedNums.add(r.mo_number) })

    // 將 SOA 訂單號轉為 MOT 前綴：strip 'SOA' + 去掉所有 '-'
    // e.g. SOA260622-111733-229 → MOT26062211173322901 (line seq 01)
    const soaBase = (orderNum: string) => 'MOT' + orderNum.replace(/^SOA/, '').replace(/-/g, '')
    const isSoa = (orderNum: string) => /^SOA/i.test(orderNum)

    // 分組：SOA 訂單依 order_number 分組，其餘走全域序號
    const soaGroups = new Map<string, typeof toGenerate>()
    const nonSoa: typeof toGenerate = []
    for (const r of toGenerate) {
      if (isSoa(r.order_number)) {
        const arr = soaGroups.get(r.order_number) ?? []
        arr.push(r)
        soaGroups.set(r.order_number, arr)
      } else {
        nonSoa.push(r)
      }
    }

    const newInputs: Record<string, string> = {}

    // SOA 訂單：base = MOT + stripped_order，序號從 01 開始，組內遞增
    for (const [orderNum, orderRows] of soaGroups) {
      const base = soaBase(orderNum)
      let lineSeq = 1
      for (const r of orderRows) {
        let mot = `${base}${String(lineSeq).padStart(2, '0')}`
        while (usedNums.has(mot)) { lineSeq++; mot = `${base}${String(lineSeq).padStart(2, '0')}` }
        newInputs[r.row_key] = mot
        usedNums.add(mot)
        lineSeq++
      }
    }

    // 非 SOA：沿用 MOT+today+全域序號
    let globalSeq = 1
    for (const r of nonSoa) {
      while (usedNums.has(genMotNumber(today, globalSeq))) globalSeq++
      const mot = genMotNumber(today, globalSeq)
      newInputs[r.row_key] = mot
      usedNums.add(mot)
      globalSeq++
    }

    setMoInputs(prev => ({ ...prev, ...newInputs }))
    const soaCount = toGenerate.length - nonSoa.length
    const note = soaCount > 0 ? `（其中 ${soaCount} 筆 SOA 訂單使用訂單號派生格式）` : ''
    setAutoMatchMsg(`✅ 已自動產生 ${toGenerate.length} 個 MOT 單號${note}`)
    setTimeout(() => setAutoMatchMsg(''), 6000)
  }, [filteredRows, selectedKeys, getMo, moInputs, rows])

  // ==================== 自動產生 MOS 集單製令單號 ====================
  const handleAutoGenerateMOS = useCallback(async () => {
    const toGenerate = (selectedKeys.size > 0 ? filteredRows.filter(r => selectedKeys.has(r.row_key)) : filteredRows)
      .filter(r => r.mo_status !== '已匯入製令' && !getMo(r) && r.order_number?.trim())
    if (toGenerate.length === 0) {
      setAutoMatchMsg('ℹ️ 所有可見列都已有製令單號（或無訂單號）')
      setTimeout(() => setAutoMatchMsg(''), 4000)
      return
    }
    const today = new Date()
    const usedNums = new Set([...Object.values(moInputs), ...rows.map(r => r.mo_number ?? '')].filter(Boolean))
    const newInputs: Record<string, string> = {}
    for (const r of toGenerate) {
      let mos = genMosNumber(r.order_number, r.match_line_no, mosType, today)
      // 號碼已包含訂單+序號+類型+日期，一般不會重復；如遇重複加後綴避雜
      let suffix = 1
      while (usedNums.has(mos)) { mos = `${genMosNumber(r.order_number, r.match_line_no, mosType, today)}-${String(suffix).padStart(2, '0')}`; suffix++ }
      newInputs[r.row_key] = mos
      usedNums.add(mos)
    }
    setMoInputs(prev => ({ ...prev, ...newInputs }))
    const label = MOS_TYPES.find(t => t.code === mosType)?.label ?? mosType
    setAutoMatchMsg(`✅ 已自動產生 ${toGenerate.length} 個 MOS 製令單號（${label}）`)
    setTimeout(() => setAutoMatchMsg(''), 6000)
  }, [filteredRows, selectedKeys, getMo, moInputs, rows, mosType])

  // ==================== 清除比對結果 ====================
  const handleClearMatches = useCallback(async () => {
    if (!confirm('確定要清除所有已比對的製令單號？此操作將同步寫入資料庫，清除後需重新執行自動比對。')) return
    const toClear = rows.filter(r =>
      (r.mo_number && r.mo_number.trim()) ||
      (moInputs[r.row_key] && moInputs[r.row_key].trim())
    )
    setMoInputs(prev => { const n = { ...prev }; toClear.forEach(r => delete n[r.row_key]); return n })
    setMoQtyMismatch(new Set())
    setRows(prev => prev.map(r => toClear.some(c => c.row_key === r.row_key) ? { ...r, mo_number: undefined } : r))
    if (toClear.length === 0) {
      setAutoMatchMsg('ℹ️ 目前沒有已比對的製令單號可清除')
      setTimeout(() => setAutoMatchMsg(''), 4000)
      return
    }
    try {
      const byDate = new Map<string, Array<{ row_key: string; mo_number: string }>>()
      for (const r of toClear) {
        const arr = byDate.get(r.sheet_date) ?? []
        arr.push({ row_key: r.row_key, mo_number: '' })
        byDate.set(r.sheet_date, arr)
      }
      for (const [date, updates] of byDate) {
        await fetch('/api/argoerp/daily-order-sheet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheet_date: date, updates }),
        })
      }
      setAutoMatchMsg(`🗑 已清除 ${toClear.length} 筆比對結果`)
    } catch (e) {
      setAutoMatchMsg(`❌ 清除失敗：${e instanceof Error ? e.message : String(e)}`)
    }
    setTimeout(() => setAutoMatchMsg(''), 8000)
  }, [rows, moInputs])

  // ==================== 儲存製令單號至 DB ====================
  const handleSaveMo = useCallback(async () => {
    const targets = targetRows.filter(r => r.mo_status !== '已匯入製令' && getMo(r))
    if (targets.length === 0) {
      setSaveMsg('ℹ️ 沒有可儲存的列（請確認已填寫製令單號）')
      setTimeout(() => setSaveMsg(''), 3000)
      return
    }
    setSaving(true); setSaveMsg('')
    try {
      const byDate = new Map<string, Array<{ row_key: string; mo_number: string }>>()
      for (const r of targets) {
        const arr = byDate.get(r.sheet_date) ?? []
        arr.push({ row_key: r.row_key, mo_number: getMo(r) })
        byDate.set(r.sheet_date, arr)
      }
      for (const [date, updates] of byDate) {
        const res = await fetch('/api/argoerp/daily-order-sheet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheet_date: date, updates: updates.map(u => ({ row_key: u.row_key, mo_number: u.mo_number })) }),
        })
        const json = await res.json()
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      }
      setRows(prev => prev.map(r => {
        const t = targets.find(t => t.row_key === r.row_key)
        return t ? { ...r, mo_number: getMo(r) } : r
      }))
      setSaveMsg(`✅ 已儲存 ${targets.length} 筆製令單號`)
      setTimeout(() => setSaveMsg(''), 4000)
    } catch (e) {
      setSaveMsg(`❌ 儲存失敗：${e}`)
      setTimeout(() => setSaveMsg(''), 6000)
    } finally { setSaving(false) }
  }, [targetRows, getMo])

  // ==================== 標記為已匯入 ====================
  const handleMarkAsImported = useCallback(async () => {
    const targets = targetRows.filter(r => getMo(r) && r.mo_status !== '已匯入製令')
    if (targets.length === 0) {
      setSaveMsg('ℹ️ 沒有可標記的列（需有製令單號且尚未標示為已匯入）')
      setTimeout(() => setSaveMsg(''), 4000)
      return
    }
    if (!confirm(`確定將 ${targets.length} 筆標記為「已匯入製令」？\n（只更新本系統狀態，不呼叫 ERP API）`)) return
    setSaving(true); setSaveMsg('')
    try {
      const byDate = new Map<string, Array<{ row_key: string; mo_number: string }>>()
      for (const r of targets) {
        const arr = byDate.get(r.sheet_date) ?? []
        arr.push({ row_key: r.row_key, mo_number: getMo(r) })
        byDate.set(r.sheet_date, arr)
      }
      for (const [date, updates] of byDate) {
        const res = await fetch('/api/argoerp/daily-order-sheet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sheet_date: date,
            updates: updates.map(u => ({ row_key: u.row_key, mo_status: '已匯入製令', mo_number: u.mo_number })),
          }),
        })
        const json = await res.json()
        if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      }
      const keys = new Set(targets.map(r => r.row_key))
      setRows(prev => prev.map(r => keys.has(r.row_key) ? { ...r, mo_status: '已匯入製令', mo_number: getMo(r) } : r))
      setSaveMsg(`✅ 已標記 ${targets.length} 筆為「已匯入製令」`)
      setTimeout(() => setSaveMsg(''), 5000)
    } catch (e) {
      setSaveMsg(`❌ 標記失敗：${e}`)
      setTimeout(() => setSaveMsg(''), 6000)
    } finally { setSaving(false) }
  }, [targetRows, getMo])

  // ==================== 匯入後自動同步 ====================
  // 集單頁的匯入來源本質上會橫跨多個出單表日期（同一批次可同時匯入好幾天累積的集單），
  // 不像「出單表→製令工單」頁面單純對應單一出單表日期。因此這裡改以「這批實際匯入成功
  // 的列各自帶的 sheet_date」為準，對每一個唯一日期各自完整跑一次「序號比對 → MO/批
  // 備料狀態同步 → (必要時)採購單比對 → 存回出單表」，而不是只同步固定的某一天。
  const runPostImportSync = useCallback(async (sheetDates: string[]) => {
    const uniqueDates = [...new Set(sheetDates)].filter(Boolean).sort()
    if (uniqueDates.length === 0) return

    type StepDesc = { key: string; label: string }
    const stepDescs: StepDesc[] = [{ key: 'erp_sync', label: 'ERP 同步：製令' }]
    for (const d of uniqueDates) {
      stepDescs.push({ key: `match_${d}`, label: `出單表序號比對（${d}）` })
      stepDescs.push({ key: `mo_${d}`, label: `同步製令／批備料狀態（${d}）` })
      stepDescs.push({ key: `po_${d}`, label: `比對採購單（${d}）` })
      stepDescs.push({ key: `save_${d}`, label: `儲存出單表（${d}）` })
    }
    stepDescs.push({ key: 'reload', label: '重新載入頁面資料' })

    const idxOf = (key: string) => stepDescs.findIndex(s => s.key === key)
    const steps: PostSyncStep[] = stepDescs.map((s, i) => ({ label: s.label, status: i === 0 ? 'running' : 'pending' }))
    const setStep = (key: string, status: PostSyncStep['status']) => {
      const i = idxOf(key)
      if (i < 0) return
      setPostSyncModal(prev => prev ? { ...prev, steps: prev.steps.map((s, j) => j === i ? { ...s, status } : s) } : null)
    }
    const skipDate = (d: string) => {
      setStep(`match_${d}`, 'done'); setStep(`mo_${d}`, 'done')
      setStep(`po_${d}`, 'done'); setStep(`save_${d}`, 'done')
    }

    setPostSyncModal({ show: true, steps, error: null })
    let poSynced = false
    try {
      // ── Step 0: ERP 同步：製令 ──────────────────────────────────
      const syncRes = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync_mo' }),
      })
      const syncJson = await syncRes.json()
      if (!syncRes.ok || syncJson.status !== 'ok') {
        throw new Error(`ERP 同步失敗：${String(syncJson.error ?? `HTTP ${syncRes.status}`)}`)
      }
      setStep('erp_sync', 'done')

      // ── 逐一日期：序號比對 → MO/批備料狀態同步 → 採購單比對 → 存回 ──
      for (const sheetDate of uniqueDates) {
        const sheetRes = await fetch(`/api/argoerp/daily-order-sheet?date=${sheetDate}`, { cache: 'no-store' })
        const sheetJson = await sheetRes.json()
        if (!sheetJson.success || !sheetJson.sheet) { skipDate(sheetDate); continue }
        type DR = Record<string, unknown>
        let dRows: DR[] = Array.isArray(sheetJson.sheet.rows) ? (sheetJson.sheet.rows as DR[]) : []
        const rawText: string = (sheetJson.sheet.raw_text as string) ?? ''
        if (dRows.length === 0) { skipDate(sheetDate); continue }

        // ── Step 1: 序號比對 ─────────────────────────────────────
        setStep(`match_${sheetDate}`, 'running')
        const orderNumbers = [...new Set(dRows.map(r => r.order_number as string).filter(Boolean))]
        const { data: soLines } = await supabase
          .from('erp_so_lines')
          .select('project_id, line_no, mbp_part, order_qty_oru, pdl_seq')
          .in('project_id', orderNumbers.length > 0 ? orderNumbers : ['__none__'])
        const soProjectIds = new Set((soLines ?? []).map((l: { project_id: string }) => l.project_id))
        const candidateMap = new Map<string, Array<{ line_no: string; pdl_seq: number | null }>>()
        for (const line of (soLines ?? [])) {
          const qty = Number((line as { order_qty_oru: unknown }).order_qty_oru ?? 0)
          const key = `${(line as { project_id: string }).project_id}|${(line as { mbp_part: unknown }).mbp_part ?? ''}|${qty}`
          if (!candidateMap.has(key)) candidateMap.set(key, [])
          candidateMap.get(key)!.push({ line_no: String((line as { line_no: unknown }).line_no ?? ''), pdl_seq: (line as { pdl_seq: unknown }).pdl_seq != null ? Number((line as { pdl_seq: unknown }).pdl_seq) : null })
        }
        for (const arr of candidateMap.values()) arr.sort((a, b) => (Number(a.line_no) || 0) - (Number(b.line_no) || 0))
        const usageCounter = new Map<string, number>()
        dRows = dRows.map(src => {
          const orderNo = src.order_number as string
          const itemCode = src.item_code as string
          if (!orderNo || !soProjectIds.has(orderNo))
            return { ...src, match_status: 'no_order', match_line_no: null, match_pdl_seq: null, match_reason: '無對應來源單號' }
          const qty = parseFloat(String(src.quantity ?? '').replace(/,/g, '')) || 0
          const key = `${orderNo}|${itemCode}|${qty}`
          const candidates = candidateMap.get(key) ?? []
          if (candidates.length === 0)
            return { ...src, match_status: 'no_qty_match', match_line_no: null, match_pdl_seq: null, match_reason: '有來源單號但無對應數量' }
          const used = usageCounter.get(key) ?? 0
          if (used >= candidates.length) {
            // 來源列數超過 ARGO 實際候選行數，不可再重複沿用最後一個候選（會產生重複單號）
            // 明確標記為需人工確認，而非靜默夾住
            usageCounter.set(key, used + 1)
            return { ...src, match_status: 'insufficient_candidates', match_line_no: null, match_pdl_seq: null, match_reason: '候選序號不足，需要人工確認（來源需求列數多於 ARGO 對應行數）' }
          }
          const candidate = candidates[used]
          usageCounter.set(key, used + 1)
          return { ...src, match_status: 'matched', match_line_no: candidate.line_no, match_pdl_seq: candidate.pdl_seq, match_reason: '' }
        })
        setStep(`match_${sheetDate}`, 'done')

        // ── Step 2: MO / 批備料狀態同步 ─────────────────────────
        setStep(`mo_${sheetDate}`, 'running')
        const noNone = orderNumbers.length > 0 ? orderNumbers : ['__none__']
        const [{ data: moLogs, error: moErr }, { data: erp_mo, error: erpErr }] = await Promise.all([
          supabase.from('argoerp_mo_upload_log')
            .select('mo_number, source_order, product_code, planned_qty, uploaded_at')
            .in('source_order', noNone)
            .order('uploaded_at', { ascending: false }),
          supabase.from('erp_mo_lines')
            .select('project_id, source_order, mbp_part, order_qty, line_no')
            .in('source_order', noNone),
        ])
        if (moErr) throw moErr
        if (erpErr) throw erpErr
        const rawLogMoNumbers = [...new Set(
          (moLogs ?? []).map((l: { mo_number: string }) => l.mo_number).filter((n): n is string => !!n?.startsWith('MO'))
        )]
        let activeMoNumbers = new Set(rawLogMoNumbers)
        if (rawLogMoNumbers.length > 0) {
          const { data: summaryRows } = await supabase.from('argoerp_mo_summary').select('mo_number').in('mo_number', rawLogMoNumbers)
          activeMoNumbers = new Set((summaryRows ?? []).map((r: { mo_number: string }) => r.mo_number))
        }
        const moMap = new Map<string, { mo_number: string }>()
        const moBaseMap = new Map<string, Array<{ mo_number: string; qty: number }>>()
        for (const log of (moLogs ?? [])) {
          const l = log as { mo_number: string; source_order: string; product_code: string; planned_qty: string }
          if (!l.mo_number?.startsWith('MO') || !activeMoNumbers.has(l.mo_number)) continue
          const qty = String(l.planned_qty ?? '').trim()
          if (!moMap.has(`${l.source_order}|${l.product_code}|${qty}`)) moMap.set(`${l.source_order}|${l.product_code}|${qty}`, { mo_number: l.mo_number })
          const baseKey = `${l.source_order}|${l.product_code}`
          const baseArr = moBaseMap.get(baseKey) ?? []
          if (!baseArr.some(x => x.mo_number === l.mo_number)) baseArr.push({ mo_number: l.mo_number, qty: parseFloat(qty.replace(/,/g, '')) || 0 })
          moBaseMap.set(baseKey, baseArr)
        }
        const erpMoMap = new Map<string, string>()
        const erpMoBaseMap = new Map<string, Array<{ mo_number: string; qty: number }>>()
        const erpMoBySourceOrder = new Map<string, Set<string>>()
        for (const mo of (erp_mo ?? [])) {
          const m = mo as { project_id: string; source_order: string; mbp_part: string; line_no: unknown; order_qty: unknown }
          if (!m.source_order || !m.mbp_part || !m.project_id?.startsWith('MO')) continue
          if (m.line_no != null) {
            const lineNoStr = String(parseInt(String(m.line_no), 10)).padStart(2, '0')
            const seqKey = `${m.source_order}|${m.mbp_part}|${lineNoStr}`
            if (!erpMoMap.has(seqKey)) erpMoMap.set(seqKey, m.project_id)
          }
          const baseKey = `${m.source_order}|${m.mbp_part}`
          const arr = erpMoBaseMap.get(baseKey) ?? []
          if (!arr.some(x => x.mo_number === m.project_id)) arr.push({ mo_number: m.project_id, qty: Number(m.order_qty ?? 0) })
          erpMoBaseMap.set(baseKey, arr)
          const moSet = erpMoBySourceOrder.get(m.source_order) ?? new Set<string>()
          moSet.add(m.project_id); erpMoBySourceOrder.set(m.source_order, moSet)
        }
        dRows = dRows.map(r => {
          const matchSeq = r.match_line_no != null ? String(parseInt(r.match_line_no as string, 10)).padStart(2, '0') : null
          const orderNo = r.order_number as string
          const itemCode = r.item_code as string
          const moNo = r.mo_number as string | undefined
          if (moNo?.startsWith('MO')) {
            const erpMosForOrder = erpMoBySourceOrder.get(orderNo)
            if (erpMosForOrder && !erpMosForOrder.has(moNo))
              return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
            // 硬性規定：製令末兩碼必須等於銷售訂單項號（matchSeq）才算比對成立，沒有項號就
            // 無法驗證，一律視為比對不成立、清除既有值（2026-08-26 與使用者確認的硬性規定）
            if (!matchSeq) return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
            const erpConfirm = erpMoMap.get(`${orderNo}|${itemCode}|${matchSeq}`)
            if (!erpConfirm) {
              const moSuffix = moNo.slice(-2)
              if (!/^\d{2}$/.test(moSuffix) || moSuffix !== matchSeq)
                return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
              return r
            }
            if (erpConfirm === moNo) return r
            return { ...r, mo_number: erpConfirm, mo_status: '已匯入製令' }
          }
          if (matchSeq) {
            const erpHit = erpMoMap.get(`${orderNo}|${itemCode}|${matchSeq}`)
            if (erpHit) return { ...r, mo_number: erpHit, mo_status: '已匯入製令' }
          }
          // 硬性規定：以下所有 fallback 都必須有 matchSeq 且製令末兩碼與其相等才算比對成立
          if (!matchSeq) return r
          const qty = String(r.quantity ?? '').trim()
          const qtyNum = parseFloat(qty.replace(/,/g, '')) || 0
          const logHit = moMap.get(`${orderNo}|${itemCode}|${qty}`)
          if (logHit && logHit.mo_number.slice(-2) === matchSeq) {
            const erpMosForOrder = erpMoBySourceOrder.get(orderNo)
            const stillInArgo = !erpMosForOrder || erpMosForOrder.has(logHit.mo_number)
            if (stillInArgo)
              return { ...r, mo_number: logHit.mo_number, mo_status: '已匯入製令' }
          }
          // 「唯一製令」保底 fallback：必須這張製令實際登記的數量跟這一列要的數量吻合、且末兩碼
          // 等於項號才套用，不能只憑「這批只查得到一張製令」就認定，否則同品號同訂單若出現
          // 數量不同的追加列，會被誤套用到別列早就完工的製令上（2026-08-26 發現：SO260805024
          // 項次4 的 1 片客戶備品被誤套用成項次2 那張數量8、已繳庫完工的製令）
          const logBaseHits = (moBaseMap.get(`${orderNo}|${itemCode}`) ?? [])
            .filter(x => x.qty === qtyNum && x.mo_number.slice(-2) === matchSeq)
          if (logBaseHits.length === 1) {
            const hit = logBaseHits[0]
            const erpMosForOrder = erpMoBySourceOrder.get(orderNo)
            const stillInArgo = !erpMosForOrder || erpMosForOrder.has(hit.mo_number)
            if (stillInArgo)
              return { ...r, mo_number: hit.mo_number, mo_status: '已匯入製令' }
          }
          const baseHits = (erpMoBaseMap.get(`${orderNo}|${itemCode}`) ?? [])
            .filter(x => x.qty === qtyNum && x.mo_number.slice(-2) === matchSeq)
          if (baseHits.length === 1) return { ...r, mo_number: baseHits[0].mo_number, mo_status: '已匯入製令' }
          if (moNo && !moNo.startsWith('MO')) return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
          return r
        })
        const moNumbers = [...new Set(dRows.map(r => r.mo_number as string).filter((v): v is string => !!v))]
        if (moNumbers.length > 0) {
          const [{ data: prepLogs, error: prepErr }, { data: erpPrepLines }] = await Promise.all([
            supabase.from('argoerp_material_prep_log').select('mo_number, status, logged_at').in('mo_number', moNumbers).order('logged_at', { ascending: false }),
            supabase.from('erp_material_prep_lines').select('mo_number').in('mo_number', moNumbers),
          ])
          if (prepErr) throw prepErr
          const prepMap = new Map<string, string>()
          for (const log of (prepLogs ?? [])) {
            const l = log as { mo_number: string; status: string }
            if (!prepMap.has(l.mo_number)) prepMap.set(l.mo_number, l.status)
          }
          const erpPrepSet = new Set<string>((erpPrepLines ?? []).map((l: { mo_number: string }) => l.mo_number).filter(Boolean))
          dRows = dRows.map(r => {
            const moNo2 = r.mo_number as string | undefined
            if (!moNo2) return r
            if (erpPrepSet.has(moNo2)) return { ...r, material_prep_status: '已批備料' }
            if (prepMap.has(moNo2)) return { ...r, material_prep_status: prepMap.get(moNo2) }
            // 這張製令查無備料紀錄：清除可能殘留自「上一個（已被更正掉的）製令」的備料狀態，
            // 備料單號也要套用跟製令單號一樣的比對邏輯，不能沿用對不上目前製令的舊狀態
            return { ...r, material_prep_status: null }
          })
        }
        setStep(`mo_${sheetDate}`, 'done')

        // ── Step 3: 採購單比對（集單頁一般只有製令/T廠，但出單表資料模型仍允許
        //           常平/委外列混入同一天，因此比照「出單表→製令工單」頁完整處理）──
        setStep(`po_${sheetDate}`, 'running')
        const hasCRows = dRows.some(r => r.factory === 'C')
        const hasORows = dRows.some(r => r.factory === 'O')
        if (hasCRows || hasORows) {
          if (!poSynced) {
            await fetch('/api/argoerp', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'sync_po' }),
            }).catch(() => {})
            poSynced = true
          }
          type PoC = { doc_no: string; sub_no: string; item_code: string | null; qty: number; status: string | null; start_date: string | null; extra: Record<string, unknown> | null; _used: boolean }
          const matchPoRows = (rRows: DR[], pool: PoC[], fac: 'C' | 'O', sDate: string): DR[] => {
            return rRows.map(row => {
              if (row.factory !== fac) return row
              if (row.po_status === 'no_po') return row
              if (row.po_confirmed && row.po_number) return row  // 使用者已人工確認採購單，保留
              const itemCode = row.item_code as string
              const qty = parseFloat(String(row.quantity ?? '').replace(/,/g, '')) || 0
              const matchLineNo = String(row.match_line_no ?? '').trim()
              const orderNo = String(row.order_number ?? '').trim()
              // P1: 料號 + 數量 + SO_PROJECT_ID
              let hitIdx = pool.findIndex(c =>
                !c._used && c.item_code === itemCode && c.qty === qty &&
                String(c.extra?.SO_PROJECT_ID ?? '').trim() === orderNo
              )
              // P2: 料號 + 數量 + MBP_LOT_NO
              if (hitIdx === -1)
                hitIdx = pool.findIndex(c =>
                  !c._used && c.item_code === itemCode && c.qty === qty &&
                  String(c.extra?.MBP_LOT_NO ?? '').trim() === orderNo
                )
              // P3（O 廠）: 料號 + TPN_PART_NO + SO/LOT 指向同一工單（不要求 qty 完全相符）
              if (hitIdx === -1 && matchLineNo && fac === 'O')
                hitIdx = pool.findIndex(c =>
                  !c._used && c.item_code === itemCode &&
                  String(c.extra?.TPN_PART_NO ?? '') === matchLineNo &&
                  (
                    String(c.extra?.SO_PROJECT_ID ?? '').trim() === orderNo ||
                    String(c.extra?.MBP_LOT_NO ?? '').trim() === orderNo
                  )
                )
              // fallback: 料號 + 數量
              if (hitIdx === -1)
                hitIdx = pool.findIndex(c => !c._used && c.item_code === itemCode && c.qty === qty)
              if (hitIdx === -1) return { ...row, po_status: 'no_match' }
              const delivDateStr = String(row.delivery_date ?? sDate).replace(/\//g, '-')
              pool[hitIdx]._used = true
              const p3Mismatch = fac === 'O' && matchLineNo &&
                String(pool[hitIdx].extra?.TPN_PART_NO ?? '') === matchLineNo &&
                pool[hitIdx].qty !== qty
              return {
                ...row,
                po_number: pool[hitIdx].doc_no,
                po_sub_no: pool[hitIdx].sub_no,
                po_status: p3Mismatch ? 'qty_mismatch' : 'matched',
                po_qty_erp: p3Mismatch ? pool[hitIdx].qty : null,
                po_start_date: pool[hitIdx].start_date,
                po_extra: pool[hitIdx].extra,
                delivery_date: delivDateStr || sDate,
              }
            })
          }
          if (hasCRows) {
            const itemCodes = [...new Set(dRows.filter(r => r.factory === 'C').map(r => r.item_code as string).filter(Boolean))]
            if (itemCodes.length > 0) {
              const { data: poRows } = await supabase.from('erp_pj_sync')
                .select('doc_no, sub_no, item_code, qty, status, start_date, extra')
                .eq('doc_type', '採購單號').in('status', ['OPEN', 'UNSIGNED']).eq('customer_vendor', 'C01510').in('item_code', itemCodes).order('doc_no', { ascending: false })
              const pool: PoC[] = (poRows ?? []).map((r: Record<string, unknown>) => ({ doc_no: r.doc_no as string, sub_no: r.sub_no as string, item_code: r.item_code as string | null, qty: Number(r.qty ?? 0), status: r.status as string | null, start_date: (r.start_date as string | null) ?? null, extra: (r.extra ?? null) as Record<string, unknown> | null, _used: false }))
              dRows = matchPoRows(dRows, pool, 'C', sheetDate)
            }
          }
          if (hasORows) {
            const itemCodesO = [...new Set(dRows.filter(r => r.factory === 'O').map(r => r.item_code as string).filter(Boolean))]
            if (itemCodesO.length > 0) {
              const { data: poRowsO } = await supabase.from('erp_pj_sync')
                .select('doc_no, sub_no, item_code, qty, status, start_date, extra')
                .eq('doc_type', '採購單號').in('status', ['OPEN', 'UNSIGNED']).neq('customer_vendor', 'C01510').in('item_code', itemCodesO).order('doc_no', { ascending: false })
              const poolO: PoC[] = (poRowsO ?? []).map((r: Record<string, unknown>) => ({ doc_no: r.doc_no as string, sub_no: r.sub_no as string, item_code: r.item_code as string | null, qty: Number(r.qty ?? 0), status: r.status as string | null, start_date: (r.start_date as string | null) ?? null, extra: (r.extra ?? null) as Record<string, unknown> | null, _used: false }))
              dRows = matchPoRows(dRows, poolO, 'O', sheetDate)
            }
          }
        }
        setStep(`po_${sheetDate}`, 'done')

        // ── Step 4: 儲存 ─────────────────────────────────────────
        setStep(`save_${sheetDate}`, 'running')
        const saveRes = await fetch('/api/argoerp/daily-order-sheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheet_date: sheetDate, raw_text: rawText, rows: dRows }),
        })
        const saveJson = await saveRes.json()
        if (!saveRes.ok || !saveJson.success) throw new Error(saveJson.error || `HTTP ${saveRes.status}`)
        setStep(`save_${sheetDate}`, 'done')
      }

      // ── 全部日期同步完成後，重新載入本頁集單資料，反映最新狀態 ──
      setStep('reload', 'running')
      await loadRows()
      setStep('reload', 'done')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setPostSyncModal(prev => prev ? {
        ...prev,
        steps: prev.steps.map(s => s.status === 'running' ? { ...s, status: 'error' } : s),
        error: msg,
      } : null)
    }
  }, [loadRows])

  // ==================== 預覽 ====================
  const handleShowPreview = useCallback(() => {
    const targets = (forceReimport ? targetRows : targetRows.filter(r => r.mo_status !== '已匯入製令'))
      .filter(r => getMo(r))
    if (targets.length === 0) {
      alert('⚠️ 沒有可匯入的列（請確認已填寫製令單號且尚未匯入）')
      return
    }
    const moGroups = new Map<string, GroupRow[]>()
    for (const r of targets) {
      const mo = getMo(r)
      const arr = moGroups.get(mo) ?? []
      arr.push(r)
      moGroups.set(mo, arr)
    }
    const preview: PreviewGroup[] = []
    for (const [mo, groupRows] of moGroups) {
      preview.push({ mo, rows: groupRows.map((row, i) => ({ row, lineNo: i + 1 })) })
    }
    setImportPreview(preview)
  }, [targetRows, getMo, forceReimport])

  // ==================== 匯入 ERP ====================
  const handleImport = useCallback(async () => {
    if (!importPreview) return
    setImporting(true)
    setSaveMsg('')
    const successRows: GroupRow[] = []
    const failedRows: Array<{ row: GroupRow; error: string }> = []
    const now = new Date()
    const allTargets = importPreview.flatMap(g => g.rows.map(r => r.row))
    let shouldRunSync = false
    try {
      const payload: Record<string, string>[] = []
      for (const group of importPreview) {
        group.rows.forEach(({ row, lineNo }) => payload.push(buildErpRecord(row, group.mo, lineNo)))
      }
      const response = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', interfaceId: 'IFAF028', data: payload }),
      })

      // ARGO 有時回傳非 JSON（HTML 錯誤頁或空白），需安全解析
      let result: Record<string, unknown> | null = null
      try {
        result = await response.json() as Record<string, unknown>
      } catch {
        // 非 JSON 回應：HTTP 200 視為成功，否則視為失敗
        if (response.ok) {
          allTargets.forEach(r => successRows.push(r))
          shouldRunSync = true
        } else {
          throw new Error(`HTTP ${response.status}：非 JSON 回應`)
        }
        result = null
      }

      if (result !== null) {
        const apiResult = (result?.apiResult ?? {}) as Record<string, unknown>
        const argoResults: Record<string, unknown>[] = Array.isArray(apiResult.RESULT)
          ? (apiResult.RESULT as Record<string, unknown>[]) : []
        const hasN = argoResults.some(r => String(r.CHECK_FLAG ?? '').toUpperCase() === 'N')
        const hasY = argoResults.some(r => String(r.CHECK_FLAG ?? '').toUpperCase() === 'Y')

        if (argoResults.length > 0 && !hasN) {
          // RESULT 有資料且無 N → 全成功
          allTargets.forEach(r => successRows.push(r))
          shouldRunSync = true
        } else if (hasN) {
          // 部分或全部失敗
          // 製令（IFAF028）回報的單號欄位是 PROJECT_ID（= 我們送出的 mo_number），
          // 而非 SLIP_NO；互為備援避免欄位名差異導致失敗列讀不到值、誤判為成功。
          const failedMos = new Map<string, string[]>()
          for (const r of argoResults) {
            if (String(r.CHECK_FLAG ?? '').toUpperCase() === 'N') {
              const slip = String(r.PROJECT_ID ?? r.SLIP_NO ?? r.MO_NO ?? '').trim()
              const err = String(r.ERROR_CODE ?? r.ERROR ?? '').trim()
              if (slip) { if (!failedMos.has(slip)) failedMos.set(slip, []); failedMos.get(slip)!.push(err) }
            }
          }
          for (const r of allTargets) {
            const mo = getMo(r)
            if (failedMos.has(mo)) failedRows.push({ row: r, error: failedMos.get(mo)!.join(' / ') })
            else successRows.push(r)
          }
          if (successRows.length > 0 || hasY) shouldRunSync = true
        } else if (result?.success === true || result?.status === 'ok' || result?.anySuccess === true) {
          // 空 RESULT + success=true → ARGO 寫入成功（IFAF028 常見模式）
          allTargets.forEach(r => successRows.push(r))
          shouldRunSync = true
        } else {
          // 明確失敗
          const errMsg = String(result?.error ?? result?.message ?? `HTTP ${response.status}`)
          throw new Error(errMsg)
        }
      }
    } catch (e) {
      allTargets.forEach(r => failedRows.push({ row: r, error: e instanceof Error ? e.message : String(e) }))
    }
    if (successRows.length > 0) {
      const byDate = new Map<string, Array<{ row_key: string; mo_number: string }>>()
      for (const r of successRows) {
        const arr = byDate.get(r.sheet_date) ?? []
        arr.push({ row_key: r.row_key, mo_number: getMo(r) })
        byDate.set(r.sheet_date, arr)
      }
      for (const [date, updates] of byDate) {
        await fetch('/api/argoerp/daily-order-sheet', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sheet_date: date,
            updates: updates.map(u => ({ row_key: u.row_key, mo_status: '已匯入製令', mo_number: u.mo_number })),
          }),
        }).catch(() => {})
      }
      fetch('/api/argoerp/mo-upload-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: successRows.map(r => ({
            mo_number: getMo(r),
            factory: r.factory,
            product_code: r.item_code,
            planned_qty: r.quantity,
            source_order: r.order_number,
            lot_number: truncateToBytes(r.order_number, 30),
            mo_note: [r.item_name, r.note].filter(Boolean).join(' '),
            planned_start_date: fmtDate(nextBizDay(now)),
            planned_end_date: r.delivery_date,
            create_date: fmtDate(now),
            interface_id: 'IFAF028',
          })),
        }),
      }).catch(() => {})
      const successKeys = new Set(successRows.map(r => r.row_key))
      setRows(prev => prev.map(r =>
        successKeys.has(r.row_key) ? { ...r, mo_status: '已匯入製令', mo_number: getMo(r) } : r
      ))
    }
    setImportPreview(null)
    setImporting(false)
    const msg = successRows.length > 0
      ? `✅ 成功 ${successRows.length} 筆${failedRows.length > 0 ? `，❌ 失敗 ${failedRows.length} 筆` : ''}`
      : failedRows.length > 0 ? `❌ 失敗 ${failedRows.length} 筆（ERP 已收到請求，請確認是否實際匯入成功）` : ''
    if (msg) setSaveMsg(msg)
    if (failedRows.length > 0 && successRows.length === 0) {
      alert(`${msg}\n\n失敗明細：\n${failedRows.slice(0, 10).map(f => `${f.row.order_number} [${f.row.item_code}]: ${f.error}`).join('\n')}\n\n⚠️ 如確認 ERP 已建立製令，可使用「標記為已匯入」手動更新狀態。`)
    }
    // 同步對象一律用「這批實際匯入成功的列」各自帶的 sheet_date（可能橫跨多個日期），
    // 而不是固定用今天——集單本來就可能一次帶入好幾天累積下來的訂單。
    if (shouldRunSync && successRows.length > 0) {
      const uniqueSheetDates = [...new Set(successRows.map(r => r.sheet_date))]
      void runPostImportSync(uniqueSheetDates)
    }
    setTimeout(() => setSaveMsg(''), 10000)
  }, [importPreview, getMo, runPostImportSync])

  // ==================== 渲染 ====================
  const statusMsg = saveMsg || autoMatchMsg
  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-6 space-y-5">

      {/* ── 標題 ── */}
      <div>
        <h1 className="text-xl font-bold text-white">集合單 ➜ 製令工單</h1>
        <p className="text-xs text-slate-400 mt-0.5">
          顯示所有出單表中單據種類含「集單」的項目，可比對 ERP 製令或建立新製令後匯入 ARGO。
        </p>
      </div>

      {/* ── 日期面板 ── */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[11px] text-slate-400 font-semibold uppercase tracking-widest">出單日期</span>
          <span className="text-[11px] text-slate-600">點選篩選，再次點擊取消</span>
        </div>
        {loading && rows.length === 0 ? (
          <div className="text-xs text-slate-600">載入中…</div>
        ) : (
          <div className="flex flex-wrap gap-2 items-center">
            <button
              onClick={() => setSelectedDates(new Set())}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                selectedDates.size === 0
                  ? 'bg-cyan-800/60 border-cyan-600 text-cyan-100'
                  : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500'
              }`}
            >
              全部
              <span className="ml-1 text-slate-500">({rows.length})</span>
            </button>
            {dateSummary.map(d => (
              <button
                key={d.date}
                onClick={() => setSelectedDates(prev => {
                  const n = new Set(prev)
                  n.has(d.date) ? n.delete(d.date) : n.add(d.date)
                  return n
                })}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  selectedDates.has(d.date)
                    ? 'bg-cyan-800/60 border-cyan-600 text-cyan-100'
                    : d.pending > 0
                      ? 'bg-amber-950/40 border-amber-700/50 text-amber-300 hover:border-amber-500'
                      : 'bg-slate-800 border-emerald-800/40 text-slate-400 hover:border-slate-500'
                }`}
              >
                {d.date}
                {d.pending > 0
                  ? <span className="px-1.5 py-0.5 rounded bg-amber-800/60 text-amber-300 text-[10px] font-bold">{d.pending} 待</span>
                  : <span className="text-emerald-500 text-[10px]">✓</span>
                }
              </button>
            ))}
            {selectedDates.size > 0 && (
              <span className="text-[11px] text-cyan-400 ml-1">已選 {selectedDates.size} 個日期</span>
            )}
          </div>
        )}
      </div>

      {/* ── Tab 列 + 搜尋 ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1">
            {(
            [
              ['unmatched', '未比對', unmatchedCount, 'bg-red-900/50 border-red-600/60 text-red-200', 'bg-red-800/60 text-red-300'],
              ['matched',   '待匯入', matchedCount,   'bg-amber-900/50 border-amber-600/60 text-amber-200', 'bg-amber-800/60 text-amber-300'],
              ['imported',  '已匯入', importedCount,  'bg-emerald-900/50 border-emerald-600/60 text-emerald-200', 'bg-emerald-800/60 text-emerald-300'],
            ] as const
          ).map(([tab, label, count, activeClass, badgeActive]) => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); setSelectedKeys(new Set()); setSelectedDates(new Set()) }}
              className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                activeTab === tab ? activeClass : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
              <span className={`ml-2 px-1.5 py-0.5 rounded text-[11px] ${
                activeTab === tab ? badgeActive : 'bg-slate-700 text-slate-500'
              }`}>{count}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="搜尋工單、品項、客戶、製令…"
            className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-1.5 w-52 focus:outline-none focus:border-cyan-500 placeholder-slate-500"
          />
          <button onClick={loadRows} disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-xs disabled:opacity-50"
          >
            {loading ? '…' : '🔄'}
          </button>
        </div>
      </div>

      {/* ── 操作工具列（未比對 / 待匯入 Tab 才顯示）── */}
      {activeTab !== 'imported' && (
        <div className="flex flex-wrap gap-2 items-center p-3 bg-slate-900/60 border border-slate-800 rounded-xl">
          <button onClick={() => void handleAutoMatch()} disabled={autoMatching || loading}
            className="px-4 py-1.5 rounded-lg bg-teal-700 hover:bg-teal-600 text-white text-xs font-semibold disabled:opacity-50">
            {autoMatching ? '比對中…' : '🔍 自動比對製令'}
          </button>
          <button onClick={() => void handleAutoGenerateMOT()} disabled={autoMatching || loading}
            className="px-4 py-1.5 rounded-lg bg-violet-700 hover:bg-violet-600 text-white text-xs font-semibold disabled:opacity-50">
            ✨ 自動產生 MOT 單號
          </button>
          <div className="flex items-center gap-1.5">
            <select
              value={mosType}
              onChange={e => setMosType(e.target.value)}
              className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2 py-1.5 focus:outline-none focus:border-purple-500"
            >
              {MOS_TYPES.map(t => (
                <option key={t.code} value={t.code}>{t.label}</option>
              ))}
            </select>
            <button onClick={() => void handleAutoGenerateMOS()} disabled={autoMatching || loading}
              className="px-4 py-1.5 rounded-lg bg-purple-700 hover:bg-purple-600 text-white text-xs font-semibold disabled:opacity-50"
              title="以選定集單類型產生 MOS 製令單號">
              🗂 產生 MOS 集單號
            </button>
          </div>
          <button onClick={() => void handleClearMatches()} disabled={autoMatching || loading}
            className="px-3 py-1.5 rounded-lg bg-red-900/60 hover:bg-red-800/70 text-red-300 text-xs font-semibold border border-red-700/50 disabled:opacity-50">
            🗑 清除比對結果
          </button>
          <div className="h-4 border-l border-slate-700" />
          <button onClick={() => void handleSaveMo()} disabled={saving || importing || loading}
            className="px-4 py-1.5 rounded-lg bg-slate-600 hover:bg-slate-500 text-white text-xs font-semibold disabled:opacity-50">
            {saving ? '儲存中…' : '💾 儲存製令單號'}
          </button>
          <button onClick={() => void handleMarkAsImported()} disabled={saving || importing || loading}
            className="px-4 py-1.5 rounded-lg bg-emerald-800 hover:bg-emerald-700 text-emerald-200 text-xs font-semibold border border-emerald-700/50 disabled:opacity-50">
            ✔ 標記為已匯入
          </button>
          <button onClick={handleShowPreview} disabled={importing || saving || loading}
            className="px-4 py-1.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-semibold disabled:opacity-50">
            {importing ? '匯入中…' : '⬆ 預覽並匯入 ERP'}
          </button>
          <label className={`flex items-center gap-1.5 cursor-pointer px-3 py-1.5 rounded-lg border text-xs font-medium select-none transition-colors ${
            forceReimport ? 'bg-red-900/60 border-red-600 text-red-300' : 'bg-slate-800 border-slate-700 text-slate-400 hover:border-slate-500'
          }`}>
            <input type="checkbox" checked={forceReimport} onChange={e => setForceReimport(e.target.checked)} className="accent-red-500 cursor-pointer" />
            強制重新匯入
          </label>
          {selectedKeys.size > 0 && (
            <span className="text-xs text-cyan-400 ml-1">已選 {selectedKeys.size} 筆</span>
          )}
        </div>
      )}

      {/* ── 狀態訊息 ── */}
      {statusMsg && (
        <div className={`px-4 py-2.5 rounded-lg text-sm border ${
          statusMsg.startsWith('✅') ? 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50'
          : statusMsg.startsWith('⚠') ? 'bg-yellow-900/50 text-yellow-300 border-yellow-700/50'
          : statusMsg.startsWith('ℹ️') || statusMsg.startsWith('🗑') ? 'bg-slate-800 text-slate-300 border-slate-700'
          : 'bg-red-900/50 text-red-300 border-red-700/50'
        }`}>
          {statusMsg}
        </div>
      )}

      {/* ── 資料表 ── */}
      {loading && rows.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-slate-500 gap-2">
          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          載入中…
        </div>
      ) : filteredRows.length === 0 ? (
        <div className="flex items-center justify-center py-16 text-slate-600 text-sm">
          {activeTab === 'unmatched' ? '✅ 目前沒有未比對的集單'
            : activeTab === 'matched' ? '尚無待匯入記錄'
            : '尚無已匯入記錄'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800">
          <table className="w-full text-xs text-left border-collapse">
            <thead>
              <tr className="bg-slate-900/80 text-slate-400 text-[11px] uppercase">
                <th className="px-2 py-2.5 border-b border-slate-800 w-8 text-center">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-cyan-500 cursor-pointer" />
                </th>
                <th className="px-3 py-2.5 border-b border-slate-800 w-7">#</th>
                <th className="px-3 py-2.5 border-b border-slate-800 whitespace-nowrap">
                  <div className="text-slate-500">出單日期</div>
                  <div className="text-cyan-400">工單號</div>
                </th>
                <th className="px-3 py-2.5 border-b border-slate-800">客戶</th>
                <th className="px-3 py-2.5 border-b border-slate-800 text-purple-300 min-w-[200px]">品項 / 品名規格</th>
                <th className="px-3 py-2.5 border-b border-slate-800">備註</th>
                <th className="px-3 py-2.5 border-b border-slate-800 text-right">數量</th>
                <th className="px-3 py-2.5 border-b border-slate-800 whitespace-nowrap">交期</th>
                <th className="px-3 py-2.5 border-b border-slate-800 text-teal-300 min-w-[210px]">
                  製令單號
                  {activeTab !== 'imported' && <span className="text-slate-600 font-normal ml-1 normal-case">（可手動修改）</span>}
                </th>
                <th className="px-3 py-2.5 border-b border-slate-800 w-24">狀態</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row, idx) => {
                const isImported = row.mo_status === '已匯入製令'
                const currentMo = getMo(row)
                const hasMo = !!currentMo
                const isQtyMismatch = moQtyMismatch.has(row.row_key)
                return (
                  <tr
                    key={row.row_key}
                    className={`border-b border-slate-800/50 transition-colors ${
                      isImported ? 'bg-emerald-950/20'
                      : hasMo ? 'bg-cyan-950/10'
                      : 'hover:bg-slate-900/50'
                    }`}
                  >
                    <td className="px-2 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(row.row_key)}
                        onChange={() => setSelectedKeys(prev => {
                          const n = new Set(prev)
                          n.has(row.row_key) ? n.delete(row.row_key) : n.add(row.row_key)
                          return n
                        })}
                        className="accent-cyan-500 cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-2 text-slate-600">{idx + 1}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <div className="font-mono text-slate-500 text-[11px]">{row.sheet_date}</div>
                      <button
                        onClick={() => row.order_number && setSoModalId(row.order_number)}
                        className="font-mono text-cyan-300 hover:text-cyan-100 hover:underline text-left"
                      >
                        {row.order_number}
                      </button>
                    </td>
                    <td className="px-3 py-2 text-slate-300 max-w-[90px] truncate" title={row.customer}>{row.customer}</td>
                    <td className="px-3 py-2">
                      <div className="text-purple-300 font-mono">{row.item_code}</div>
                      {row.item_name && (
                        <div className="text-slate-400 mt-0.5 max-w-[220px] truncate text-[11px]" title={row.item_name}>{row.item_name}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-400 max-w-[120px] truncate" title={row.note}>{row.note}</td>
                    <td className="px-3 py-2 text-right text-white font-mono whitespace-nowrap">{row.quantity}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-300">{row.delivery_date}</td>
                    <td className="px-3 py-2">
                      {isImported || activeTab === 'imported' ? (
                        <span className="font-mono text-emerald-300">{currentMo || row.mo_number}</span>
                      ) : (
                        <div>
                          <input
                            type="text"
                            value={currentMo}
                            onChange={e => setMoInputs(prev => ({ ...prev, [row.row_key]: e.target.value }))}
                            placeholder="輸入或自動產生…"
                            className={`w-full bg-slate-800 border rounded px-2 py-1 font-mono text-xs focus:outline-none focus:border-teal-500 placeholder-slate-600 ${
                              isQtyMismatch ? 'border-amber-600 text-amber-300' : 'border-slate-700 text-teal-300'
                            }`}
                          />
                          {isQtyMismatch && <div className="text-[10px] text-amber-400 mt-0.5">⚠ 數量與 ERP 不符</div>}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {isImported ? (
                        <span className="px-2 py-0.5 rounded text-[11px] bg-emerald-900/50 text-emerald-300 border border-emerald-700/50 whitespace-nowrap">已匯入</span>
                      ) : hasMo ? (
                        <span className="px-2 py-0.5 rounded text-[11px] bg-cyan-900/50 text-cyan-300 border border-cyan-700/50 whitespace-nowrap">待匯入</span>
                      ) : (
                        <span className="text-slate-600 text-[11px]">未比對</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── 說明 ── */}
      <div className="text-[11px] text-slate-600 space-y-0.5 pt-1 border-t border-slate-800/50">
        <p>・「自動比對製令」：查 ERP erp_mo_lines，依訂單號＋品項碼比對，優先選數量吻合的製令。</p>
        <p>・「自動產生 MOT 單號」：為尚無製令號的列產生今日 MOT 號碼（格式 MOTyyyyMMddNN），可手動修改後再匯入。</p>
        <p>・「儲存製令單號」：將單號存回出單表資料庫，不呼叫 ERP。</p>
        <p>・「預覽並匯入 ERP」：呼叫 IFAF028 送入 ERP，成功後自動更新狀態並觸發製令同步。</p>
        <p>・「標記為已匯入」：僅更新本系統狀態（適用於已在 ERP 建立但本系統尚未記錄的製令）。</p>
      </div>

      {/* ── 匯入預覽 Modal ── */}
      {importPreview && (
        <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4" onClick={() => setImportPreview(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-3xl max-h-[88vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-700 flex items-start justify-between shrink-0">
              <div>
                <h2 className="text-base font-bold text-white">匯入預覽 — 集單製令工單</h2>
                <p className="text-xs text-slate-400 mt-1">
                  共 <span className="text-violet-300 font-semibold">{importPreview.length}</span> 張製令・
                  <span className="text-cyan-300 font-semibold">{importPreview.reduce((n, g) => n + g.rows.length, 0)}</span> 筆明細
                  <span className="ml-2 px-1.5 py-0.5 rounded text-[11px] bg-violet-900/60 text-violet-300">IFAF028</span>
                </p>
              </div>
              <button onClick={() => setImportPreview(null)} className="text-slate-500 hover:text-white text-xl leading-none">✕</button>
            </div>
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
              {importPreview.map(group => (
                <div key={group.mo} className="border border-violet-800/50 rounded-lg overflow-hidden">
                  <div className="flex items-center gap-3 px-4 py-2.5 bg-violet-950/60 border-b border-violet-800/40">
                    <span className="text-xs text-slate-400">製令單號</span>
                    <span className="font-mono text-violet-300 font-bold tracking-wide">{group.mo}</span>
                    <span className="ml-auto text-xs text-slate-500">{group.rows.length} 筆明細</span>
                  </div>
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="bg-slate-800/60 text-slate-400 text-[11px]">
                        <th className="px-3 py-2 text-center w-10">LINE</th>
                        <th className="px-3 py-2 text-left">品項編碼</th>
                        <th className="px-3 py-2 text-left min-w-[150px]">品名備註</th>
                        <th className="px-3 py-2 text-left">來源工單</th>
                        <th className="px-3 py-2 text-right">數量</th>
                        <th className="px-3 py-2 text-left">交期</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map(({ row, lineNo }) => (
                        <tr key={row.row_key} className="border-t border-slate-800/40">
                          <td className="px-3 py-2 text-center text-slate-500">{lineNo}</td>
                          <td className="px-3 py-2 font-mono text-purple-300">{row.item_code}</td>
                          <td className="px-3 py-2 text-slate-300">{[row.item_name, row.note].filter(Boolean).join(' ')}</td>
                          <td className="px-3 py-2 font-mono text-cyan-300">{row.order_number}</td>
                          <td className="px-3 py-2 text-right text-white font-mono">{row.quantity}</td>
                          <td className="px-3 py-2 text-slate-300">{row.delivery_date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
            <div className="px-5 py-4 border-t border-slate-700 flex items-center justify-end gap-3 shrink-0">
              <button onClick={() => setImportPreview(null)} className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm">取消</button>
              <button
                onClick={() => void handleImport()}
                disabled={importing}
                className="px-5 py-2 rounded-lg bg-violet-700 hover:bg-violet-600 disabled:bg-slate-700 disabled:text-slate-400 text-white text-sm font-semibold flex items-center gap-1.5"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                確認匯入 ERP
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 匯入後同步進度 Modal ── */}
      {postSyncModal?.show && (
        <div className="fixed inset-0 bg-black/80 z-[100] flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="p-2 rounded-full bg-teal-900/50 text-teal-400">
                <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
              </div>
              <div>
                <div className="font-semibold text-white">匯入後同步中</div>
                <div className="text-xs text-slate-400 mt-0.5">正在更新 ERP 資料…</div>
              </div>
            </div>
            <div className="space-y-3">
              {postSyncModal.steps.map((step, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-6 h-6 flex items-center justify-center shrink-0">
                    {step.status === 'done' && <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>}
                    {step.status === 'running' && <svg className="w-5 h-5 text-cyan-400 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" /></svg>}
                    {step.status === 'error' && <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>}
                    {step.status === 'pending' && <div className="w-3 h-3 rounded-full border-2 border-slate-600 mx-auto" />}
                  </div>
                  <span className={`text-sm ${
                    step.status === 'done' ? 'text-emerald-400'
                    : step.status === 'running' ? 'text-cyan-300 font-medium'
                    : step.status === 'error' ? 'text-red-400'
                    : 'text-slate-500'
                  }`}>{step.label}</span>
                </div>
              ))}
            </div>
            {postSyncModal.error && (
              <div className="mt-4 p-3 bg-red-950/40 border border-red-700/50 rounded-lg text-red-300 text-xs">
                <p className="font-semibold mb-1">錯誤</p>
                <p>{postSyncModal.error}</p>
              </div>
            )}
            {postSyncModal.steps.every(s => s.status === 'done' || s.status === 'error') && (
              <div className="mt-5 flex justify-end">
                <button onClick={() => setPostSyncModal(null)} className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm">關閉</button>
              </div>
            )}
          </div>
        </div>
      )}

      {soModalId && <SoOrderModal projectId={soModalId} onClose={() => setSoModalId(null)} />}
    </div>
  )
}
