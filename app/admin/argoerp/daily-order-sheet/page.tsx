'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../../../../lib/supabaseClient'
import SoOrderModal from '../../../../components/SoOrderModal'
import PoOrderModal from '../../../../components/PoOrderModal'

// ===== 舊系統入庫紀錄比對 =====
interface LegacyReceiptRow {
  entry_no: string
  entry_date: string | null
  order_number: string
  source_location: string
  handler_name: string
  item_name: string
  good_qty: number
}

// ===== 塔台報工紀錄比對 =====
interface SaraWipRow {
  work_order: string
  mo_nbr: string | null
  doc_nbr: string | null
  product_name: string | null
  product_subname: string | null
  product_description: string | null
  workcenter_name: string | null
  job_name: string | null
  job_sequence: number | null
  status: string | null
  wip_qty: number | null
  real_end_time: string | null
  report_resources: string | null
  username: string | null
}

// ===== 型別定義（與 order-batch-export 一致）=====
interface SourceRow {
  order_number: string
  line_no_input: string   // B欄：貼入時直接填寫的序號（空字串 = 無填入，需比對）
  doc_type: string
  factory: 'T' | 'C' | 'O'
  receiver: string
  is_sample: string
  has_material: string
  designer: string
  customer: string
  line_nickname: string
  handler: string
  issuer: string
  item_code: string
  item_name: string
  note: string
  packing: string
  quantity: string
  delivery_date: string
  plate_count: string
  upload_ro: string
  order_status: string
  pm_note: string
  assigned_machine: string
}

export type MatchStatus = 'matched' | 'no_order' | 'no_qty_match'

export interface SheetRow extends SourceRow {
  row_key: string
  mo_status: '已匯入製令' | '暫緩區' | null
  mo_number?: string
  // 常平採購單比對結果（對應 erp_pj_sync）
  po_number?: string | null
  po_sub_no?: string | null
  po_status?: 'matched' | 'no_match' | 'no_po' | 'qty_mismatch' | null
  po_qty_erp?: number | null  // ERP 採購單數量（僅 qty_mismatch 時有值，供人工判斷用）
  po_confirmed?: boolean      // 使用者已人工確認採購單，同步時不覆蓋
  // 委外請購單比對結果（對應 erp_pj_sync doc_type=請購單號；為輔，採購單優先顯示）
  // 比對鏈：出單表 order_number(SO) → erp_so_lines.tpn_part_no(RO) → 請購單 extra.SO_PROJECT_ID(RO)
  pr_number?: string | null
  pr_sub_no?: string | null
  pr_status?: 'matched' | 'no_match' | null
  // 序號比對結果（對應 erp_so_lines）
  match_status?: MatchStatus | null
  match_line_no?: string | null
  match_pdl_seq?: number | null
  match_reason?: string | null
  // 批備料狀態（對應 argoerp_material_prep_log 最近一筆 或 erp_material_prep_lines ARGO 批備料單）
  material_prep_status?: '已備料' | '無需備料' | '已批備料' | null
  // ARGO 批備料建立的單據號碼（對應 argoerp_material_prep_log.argo_slip_no）
  argo_slip_no?: string | null
  // 機台分配（對應 argoerp_mo_machine_assign）
  machine?: string
}

interface SheetMeta {
  sheet_date: string
  row_count: number
  updated_at: string
}

// ===== 採購單（erp_pj_sync）資料型別 =====
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

// ===== 工具函式 =====
function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function detectFactory(docType: string): 'T' | 'C' | 'O' {
  if (docType.includes('常平')) return 'C'
  if (docType.includes('委外')) return 'O'
  return 'T'
}

function createRowKey(row: SourceRow): string {
  return [
    row.order_number,
    row.doc_type,
    row.factory,
    row.item_code,
    row.item_name,
    row.note,
    row.quantity,
    row.delivery_date,
  ].join('||')
}

function parseTSV(text: string): string[][] {
  const rows: string[][] = []
  let current = ''
  let cells: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { current += '"'; i++ }
        else inQuotes = false
      } else { current += ch }
    } else {
      if (ch === '"' && current.trim() === '') { inQuotes = true; current = '' }
      else if (ch === '\t') { cells.push(current.trim()); current = '' }
      else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        if (ch === '\r') i++
        cells.push(current.trim())
        if (cells.some(c => c !== '')) rows.push(cells)
        cells = []; current = ''
      } else if (ch === '\r') {
        cells.push(current.trim())
        if (cells.some(c => c !== '')) rows.push(cells)
        cells = []; current = ''
      } else { current += ch }
    }
  }
  cells.push(current.trim())
  if (cells.some(c => c !== '')) rows.push(cells)
  return rows
}

// 2026-06-18 起出單表新增 PACKING 欄（cells[14]），舊日期無此欄，後面欄位需往前移一格
const PACKING_COL_SINCE = '2026-06-18'

// 若舊日期的 row 是在 packing 欄加入後才儲存（無 raw_text 可重新解析時），
// quantity 欄會存到交付日字串 → 偵測並往回移一格還原
function fixStoredPackingShift<T extends {
  packing?: string; quantity?: string; delivery_date?: string
  plate_count?: string; upload_ro?: string; order_status?: string
  pm_note?: string; assigned_machine?: string
}>(row: T, sheetDate: string): T {
  if (sheetDate >= PACKING_COL_SINCE) return row
  if (!row.quantity || !/^\d{4}[\/\-]/.test(row.quantity)) return row
  return {
    ...row,
    packing:          '',
    quantity:         row.packing         ?? '',
    delivery_date:    row.quantity        ?? '',
    plate_count:      row.delivery_date   ?? '',
    upload_ro:        row.plate_count     ?? '',
    order_status:     row.upload_ro       ?? '',
    pm_note:          row.order_status    ?? '',
    assigned_machine: row.pm_note         ?? '',
  }
}

function parseSourceRows(text: string, sheetDate?: string): { rows: SourceRow[]; error: string; duplicateWarnings: string[] } {
  const hasPackingCol = !sheetDate || sheetDate >= PACKING_COL_SINCE
  const rawRows = parseTSV(text.trim())
  if (rawRows.length === 0) return { rows: [], error: '未偵測到有效資料行', duplicateWarnings: [] }

  // 合併因儲存格內換行而被切分的延續行：
  // 若某行第一格為空白，代表上一筆資料的儲存格值含有 \n，
  // 需要把這行的內容（跳過空白的第一格）接在上一行後面。
  // 例：品名欄 "客製 | 悠遊卡\n單面印刷" 會被切成兩行，col[14]（數量）才不會遺失。
  const allRows: string[][] = []
  for (const row of rawRows) {
    if ((row[0] ?? '').trim() === '' && allRows.length > 0) {
      // 延續行：附加到上一行（略過空白的 col[0]）
      allRows[allRows.length - 1].push(...row.slice(1))
    } else {
      allRows.push([...row])
    }
  }

  const headerKeywords = ['工單編號', '品項編碼', '單據種類', '品名/規格', '交付日期', '訂單狀態', '生產廠別', '承辦人', '開單人員', '客戶', '美編', '序號', '備註']
  let startIdx = 0
  for (let h = 0; h < Math.min(allRows.length, 3); h++) {
    const rowCells = allRows[h]
    const lineText = rowCells.join('\t')
    const firstCell = rowCells[0]?.trim() ?? ''
    const looksLikeOrderNo = /^[A-Za-z]{1,4}\d/.test(firstCell)
    if (!looksLikeOrderNo && (headerKeywords.some(kw => lineText.includes(kw)) || h === startIdx)) {
      startIdx = h + 1
    } else break
  }
  const parsed: SourceRow[] = []
  for (let i = startIdx; i < allRows.length; i++) {
    const cells = allRows[i]
    const docType = (cells[2] ?? '').trim()
    const row: SourceRow = {
      order_number: (cells[0] ?? '').trim(),
      line_no_input: (cells[1] ?? '').trim(),
      doc_type: docType,
      factory: detectFactory(docType),
      receiver: (cells[3] ?? '').trim(),
      is_sample: (cells[4] ?? '').trim(),
      has_material: (cells[5] ?? '').trim(),
      designer: (cells[6] ?? '').trim(),
      customer: (cells[7] ?? '').trim(),
      line_nickname: (cells[8] ?? '').trim(),
      handler: (cells[9] ?? '').trim(),
      issuer: (cells[10] ?? '').trim(),
      item_code: (cells[11] ?? '').trim(),
      item_name: (cells[12] ?? '').trim(),
      note: (cells[13] ?? '').trim(),
      // PACKING 欄從 2026-06-18 起才有（舊資料往前移一格）
      packing: hasPackingCol ? (cells[14] ?? '').trim() : '',
      quantity: hasPackingCol ? (cells[15] ?? '').trim() : (cells[14] ?? '').trim(),
      delivery_date: hasPackingCol ? (cells[16] ?? '').trim() : (cells[15] ?? '').trim(),
      plate_count: hasPackingCol ? (cells[17] ?? '').trim() : (cells[16] ?? '').trim(),
      upload_ro: hasPackingCol ? (cells[18] ?? '').trim() : (cells[17] ?? '').trim(),
      order_status: hasPackingCol ? (cells[19] ?? '').trim() : (cells[18] ?? '').trim(),
      pm_note: hasPackingCol ? (cells[20] ?? '').trim() : (cells[19] ?? '').trim(),
      assigned_machine: hasPackingCol ? (cells[21] ?? '').trim() : (cells[20] ?? '').trim(),
    }
    if (row.order_number || row.item_code) parsed.push(row)
  }

  if (parsed.length === 0) return { rows: [], error: '未解析到有效資料，請確認資料是從 Excel 以 Tab 分隔複製', duplicateWarnings: [] }

  // 重複訂單號+序號偵測
  const seenDupKeys = new Set<string>()
  const duplicateWarnings: string[] = []
  for (const row of parsed) {
    if (!row.line_no_input) continue
    const dupKey = `${row.order_number}|${row.line_no_input}`
    if (seenDupKeys.has(dupKey)) {
      duplicateWarnings.push(`${row.order_number} 序號 ${row.line_no_input}`)
    }
    seenDupKeys.add(dupKey)
  }
  return { rows: parsed, error: '', duplicateWarnings }
}

function encodeTsvCell(v: string): string {
  if (/["\t\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

function rowsToTsv(rows: string[][]): string {
  return rows.map(r => r.map(c => encodeTsvCell(c ?? '')).join('\t')).join('\n')
}

function toCsvCell(v: unknown): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`
}

function downloadCsv(fileName: string, headers: string[], rows: unknown[][]): void {
  const bom = '\uFEFF'
  const csvContent = bom + [
    headers.map(toCsvCell).join(','),
    ...rows.map(r => r.map(toCsvCell).join(',')),
  ].join('\n')

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  '已匯入製令': { label: '已匯入製令', cls: 'bg-emerald-900/50 text-emerald-300 border-emerald-700/50' },
  '已匯入採單': { label: '已匯入採單', cls: 'bg-orange-900/50 text-orange-300 border-orange-700/50' },
  '暫緩區': { label: '暫緩區', cls: 'bg-amber-900/50 text-amber-300 border-amber-700/50' },
}

// ── 交期檢查工具函式 ──────────────────────────────────────────────────────────

/** 解析日期字串（支援 YYYY/M/D、YYYY-MM-DD、YYYYMMDD），回傳 Date 或 null */
function parseDeliveryDate(s: string): Date | null {
  const t = (s ?? '').trim()
  if (!t) return null
  let y: number, m: number, d: number
  if (/^\d{8}$/.test(t)) {
    y = +t.slice(0, 4); m = +t.slice(4, 6); d = +t.slice(6, 8)
  } else {
    const parts = t.slice(0, 10).split(/[\/\-]/)
    if (parts.length < 3) return null
    y = +parts[0]; m = +parts[1]; d = +parts[2]
  }
  if (!y || !m || !d) return null
  const dt = new Date(y, m - 1, d)
  return isNaN(dt.getTime()) ? null : dt
}

/**
 * 從「出單表日期」（day 0）開始，計算到 to 有幾個工作天（週一～週五）。
 * from 本身是 day 0，所以從 from+1 起算。
 * 如果 to <= from，回傳 0。
 */
function countWorkingDaysFrom(from: Date, to: Date): number {
  const start = new Date(from)
  start.setHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setHours(0, 0, 0, 0)
  if (end <= start) return 0
  let count = 0
  const cur = new Date(start)
  cur.setDate(cur.getDate() + 1) // day 1
  while (cur <= end) {
    const dow = cur.getDay()
    if (dow !== 0 && dow !== 6) count++
    cur.setDate(cur.getDate() + 1)
  }
  return count
}

const FACTORY_LABEL_ZH: Record<string, string> = { T: '台北', C: '常平', O: '委外' }
const DUE_THRESHOLD: Record<string, number> = { T: 4, C: 5, O: 5 }

interface DueDateAnomaly {
  order_number: string
  factory: string
  customer: string
  item_code: string
  item_name: string
  quantity: string
  delivery_date: string
  reason: string
}

type OutsourcePrefix = 'MOT' | 'POC' | 'POO' | 'MPO'

function getOutsourcePrefix(docNo?: string | null): OutsourcePrefix | null {
  const v = String(docNo ?? '').trim().toUpperCase()
  if (v.startsWith('MOT')) return 'MOT'
  if (v.startsWith('POC')) return 'POC'
  if (v.startsWith('POO')) return 'POO'
  if (v.startsWith('MPO')) return 'MPO'
  return null
}

function getOutsourcePrefixStyles(prefix: OutsourcePrefix | null): { rowBg: string; text: string; badge: string } {
  switch (prefix) {
    case 'MOT':
      return { rowBg: 'bg-emerald-950/25', text: 'text-emerald-300 hover:text-emerald-100', badge: 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50' }
    case 'POC':
      return { rowBg: 'bg-orange-950/25', text: 'text-orange-300 hover:text-orange-100', badge: 'bg-orange-900/40 text-orange-300 border-orange-700/50' }
    case 'POO':
      return { rowBg: 'bg-fuchsia-950/25', text: 'text-fuchsia-300 hover:text-fuchsia-100', badge: 'bg-fuchsia-900/40 text-fuchsia-300 border-fuchsia-700/50' }
    case 'MPO':
      return { rowBg: 'bg-sky-950/30', text: 'text-sky-300 hover:text-sky-100', badge: 'bg-sky-900/40 text-sky-300 border-sky-700/50' }
    default:
      return { rowBg: 'bg-purple-950/20', text: 'text-purple-300 hover:text-purple-100', badge: 'bg-purple-900/40 text-purple-300 border-purple-700/50' }
  }
}

// ===== 頁面元件 =====
export default function DailyOrderSheetPage() {
  const [selectedDate, setSelectedDate] = useState('')
  const [availableSheets, setAvailableSheets] = useState<SheetMeta[]>([])
  const [sheetRows, setSheetRows] = useState<SheetRow[]>([])
  const [rawText, setRawText] = useState('')
  const [rawEditorMode, setRawEditorMode] = useState<'excel' | 'text'>('excel')
  const [rawGrid, setRawGrid] = useState<string[][]>([])
  const [currentRawText, setCurrentRawText] = useState('')   // stored raw_text for this date
  const [showPasteArea, setShowPasteArea] = useState(false)
  const [parseError, setParseError] = useState('')
  const [parseWarnings, setParseWarnings] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [editFactoryIdx, setEditFactoryIdx] = useState<number | null>(null)
  const [matching, setMatching] = useState(false)
  const [syncingMo, setSyncingMo] = useState(false)
  const [machines, setMachines] = useState<string[]>([])
  const [moMachines, setMoMachines] = useState<Record<string, string>>({})
  const [rowMachines, setRowMachines] = useState<Record<string, string>>({})
  const [savingMachine, setSavingMachine] = useState(false)
  const [machineChanged, setMachineChanged] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())

  // ---- 分頁 ----
  const [activeMainTab, setActiveMainTab] = useState<'daily' | 'c-orders'>('daily')

  // ---- 常平廠訂單 ----
  const [cOrders, setCOrders] = useState<PjRecord[]>([])
  const [cOrdersLoading, setCOrdersLoading] = useState(false)
  const [cOrdersSearch, setCOrdersSearch] = useState('')
  const [cOrdersStatusFilter, setCOrdersStatusFilter] = useState('OPEN')
  const [pinnedCOrderKeys, setPinnedCOrderKeys] = useState<Set<string>>(new Set())

  const togglePinCOrder = (key: string) => {
    setPinnedCOrderKeys(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // 頂置訂單排在最前
  const sortedCOrders = [
    ...cOrders.filter(r => pinnedCOrderKeys.has(`${r.doc_no}|${r.sub_no}`)),
    ...cOrders.filter(r => !pinnedCOrderKeys.has(`${r.doc_no}|${r.sub_no}`)),
  ]
  const [soModalId, setSoModalId] = useState<string | null>(null)
  const [poModalId, setPoModalId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeFactory, setActiveFactory] = useState<'ALL' | 'T' | 'C' | 'O' | 'G'>('ALL')
  const [globalSearch, setGlobalSearch] = useState('')
  const [globalSearching, setGlobalSearching] = useState(false)
  const [globalResults, setGlobalResults] = useState<{ sheet_date: string; rows: SheetRow[] }[] | null>(null)
  const [sampleRefInputs, setSampleRefInputs] = useState<Record<string, string>>({})
  const [legacyModal, setLegacyModal] = useState<{ query: string; rows: LegacyReceiptRow[]; saraWipRows: SaraWipRow[]; loading: boolean } | null>(null)
  const [dueDateModal, setDueDateModal] = useState<DueDateAnomaly[] | null>(null)
  const [dueDateCopied, setDueDateCopied] = useState(false)

  // ---- 常平廠訂單（C01510 採購單）----
  const fetchCOrders = useCallback(async () => {
    setCOrdersLoading(true)
    try {
      let query = supabase
        .from('erp_pj_sync')
        .select('*', { count: 'exact' })
        .eq('doc_type', '採購單號')
        .eq('customer_vendor', 'C01510')
        .order('doc_no', { ascending: true })
      if (cOrdersStatusFilter) query = query.eq('status', cOrdersStatusFilter)
      if (cOrdersSearch.trim()) {
        const kw = cOrdersSearch.trim()
        query = query.or(`doc_no.ilike.%${kw}%,item_code.ilike.%${kw}%,description.ilike.%${kw}%,remark.ilike.%${kw}%`)
      }
      const { data } = await query
      setCOrders((data ?? []) as PjRecord[])
    } catch (e) {
      console.error('fetchCOrders error', e)
    } finally {
      setCOrdersLoading(false)
    }
  }, [cOrdersSearch, cOrdersStatusFilter])

  useEffect(() => {
    if (activeMainTab === 'c-orders') fetchCOrders()
  }, [activeMainTab, fetchCOrders])

  // ---- 舊系統入庫紀錄比對 + 塔台報工紀錄比對 ----
  const handleLegacyLookup = useCallback(async (orderNo: string) => {
    const q = orderNo.trim()
    if (!q) return
    setLegacyModal({ query: q, rows: [], saraWipRows: [], loading: true })
    const [legacyRes, saraWipRes] = await Promise.all([
      supabase
        .from('legacy_inventory_receipts')
        .select('entry_no, entry_date, order_number, source_location, handler_name, item_name, good_qty')
        .eq('order_number', q)
        .order('entry_date', { ascending: true })
        .order('entry_no', { ascending: true }),
      supabase
        .from('sara_wip_records')
        .select('work_order, mo_nbr, doc_nbr, product_name, product_subname, product_description, workcenter_name, job_name, job_sequence, status, wip_qty, real_end_time, report_resources, username')
        .eq('workcenter_name', '印刷站2F')
        .or(`mo_nbr.eq.${q},doc_nbr.eq.${q}`)
        .order('real_end_time', { ascending: false }),
    ])
    setLegacyModal({
      query: q,
      rows: legacyRes.error || !legacyRes.data ? [] : (legacyRes.data as LegacyReceiptRow[]),
      saraWipRows: saraWipRes.error || !saraWipRes.data ? [] : (saraWipRes.data as SaraWipRow[]),
      loading: false,
    })
  }, [])

  // ---- 讀取所有日期清單 ----
  const loadSheetList = useCallback(async () => {
    try {
      const res = await fetch('/api/argoerp/daily-order-sheet')
      const json = await res.json()
      if (json.success) setAvailableSheets(json.sheets ?? [])
    } catch {}
  }, [])

  // ---- 讀取指定日期的出單表 ----
  const loadSheet = useCallback(async (date: string) => {
    if (!date) return
    setLoading(true)
    setSheetRows([])
    setSelectedKeys(new Set())
    setCurrentRawText('')
    setShowPasteArea(false)
    setParseError('')
    try {
      const res = await fetch(`/api/argoerp/daily-order-sheet?date=${date}`)
      const json = await res.json()
      if (json.success && json.sheet) {
        const storedRows: SheetRow[] = Array.isArray(json.sheet.rows) ? json.sheet.rows as SheetRow[] : []
        const rawTextStored: string = json.sheet.raw_text ?? ''

        // 以 raw_text 重新解析確保所有廠別（T/C/O）都能正確還原，
        // 再以 row_key 對應，保留 DB 裡已有的 MO / 採購單 / 機台等富化資料
        // raw_text 無法取得時退用 storedRows，並對舊格式錯位資料做修正
        let finalRows: SheetRow[] = storedRows.map(r => fixStoredPackingShift(r, date))
        if (rawTextStored.trim()) {
          const { rows: parsedRows } = parseSourceRows(rawTextStored, date)
          if (parsedRows.length > 0) {
            const enrichedMap = new Map(storedRows.map(r => [r.row_key, r]))
            finalRows = parsedRows.map(r => {
              const key = createRowKey(r)
              const stored = enrichedMap.get(key)
              const base: SheetRow = { ...r, row_key: key, mo_status: stored?.mo_status ?? null }
              if (stored) {
                if (stored.mo_number       !== undefined) base.mo_number       = stored.mo_number
                if (stored.po_number       !== undefined) base.po_number       = stored.po_number
                if (stored.po_sub_no       !== undefined) base.po_sub_no       = stored.po_sub_no
                if (stored.po_status       !== undefined) base.po_status       = stored.po_status
                if (stored.po_qty_erp      !== undefined) base.po_qty_erp      = stored.po_qty_erp
                if (stored.po_confirmed    !== undefined) base.po_confirmed    = stored.po_confirmed
                if (stored.pr_number       !== undefined) base.pr_number       = stored.pr_number
                if (stored.pr_sub_no       !== undefined) base.pr_sub_no       = stored.pr_sub_no
                if (stored.pr_status       !== undefined) base.pr_status       = stored.pr_status
                if (stored.match_status    !== undefined) base.match_status    = stored.match_status
                if (stored.match_line_no   !== undefined) base.match_line_no   = stored.match_line_no
                if (stored.match_pdl_seq   !== undefined) base.match_pdl_seq   = stored.match_pdl_seq
                if (stored.match_reason    !== undefined) base.match_reason    = stored.match_reason
                if (stored.material_prep_status !== undefined) base.material_prep_status = stored.material_prep_status
                if (stored.argo_slip_no    !== undefined) base.argo_slip_no    = stored.argo_slip_no
                if (stored.machine         !== undefined) base.machine         = stored.machine
              }
              return base
            })
          }
        }

        setSheetRows(finalRows)
        // 還原沒有 mo_number 的 row-level 機台分配
        const rmMap: Record<string, string> = {}
        for (const r of finalRows) {
          if (!r.mo_number && r.machine) rmMap[r.row_key] = r.machine
        }
        setRowMachines(rmMap)
        setCurrentRawText(rawTextStored)
      } else {
        setSheetRows([])
        setCurrentRawText('')
        setShowPasteArea(true)  // 此日尚無資料，直接展開貼上區
      }
    } catch (e) {
      setSaveMsg(`❌ 讀取失敗：${e}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadSheetList() }, [loadSheetList])
  useEffect(() => { loadSheet(selectedDate) }, [selectedDate, loadSheet])

  useEffect(() => {
    if (!rawText.trim()) {
      setRawGrid([])
      return
    }
    setRawGrid(parseTSV(rawText))
  }, [rawText])

  // 當日期清單載入後，若尚未選日期，自動選今天或最近一筆
  useEffect(() => {
    if (selectedDate || availableSheets.length === 0) return
    const today = todayStr()
    const hasToday = availableSheets.some(s => s.sheet_date === today)
    setSelectedDate(hasToday ? today : availableSheets[0].sheet_date)
  }, [availableSheets, selectedDate])

  // ---- 跨日期單號搜尋 ----
  const runGlobalSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) { setGlobalResults(null); return }
    setGlobalSearching(true)
    setGlobalResults(null)
    try {
      const res = await fetch(`/api/argoerp/daily-order-sheet?search=${encodeURIComponent(trimmed)}`)
      const json = await res.json()
      if (json.success) setGlobalResults(json.results ?? [])
    } catch {}
    finally { setGlobalSearching(false) }
  }, [])

  // ---- is_sample 預填「打樣/追加單號」輸入框 ----
  useEffect(() => {
    setSampleRefInputs(prev => {
      const updates: Record<string, string> = {}
      for (const r of sheetRows) {
        const sk = r.row_key
        if (r.is_sample && !prev[sk]) updates[sk] = r.is_sample
      }
      return Object.keys(updates).length > 0 ? { ...prev, ...updates } : prev
    })
  }, [sheetRows])

  // ---- 載入機台清單（selectedDate 變動時重試，避免首次失敗後選單空白）----
  useEffect(() => {
    fetch('/api/argoerp/machines')
      .then(r => r.json())
      .then(j => { if (j.success) setMachines((j.machines as { name: string }[]).map(m => m.name)) })
      .catch(() => {})
  }, [selectedDate])

  // 當出單表載入後，載入對應製令的機台分配
  useEffect(() => {
    const moNums = [...new Set(sheetRows.map(r => r.mo_number).filter((v): v is string => !!v && v.startsWith('MO')))]
    if (moNums.length === 0) return
    fetch('/api/argoerp/mo-machine-assign')
      .then(r => r.json())
      .then(j => {
        if (j.success) {
          const map: Record<string, string> = {}
          ;(j.assignments as { mo_number: string; machine: string }[]).forEach(a => {
            if (a.machine) map[a.mo_number] = a.machine
          })

          // 對 argoerp_mo_machine_assign 查無機台的製令，以 sheetRows.machine（已存）或 assigned_machine（原始貼上）補填
          const fallback: { mo_number: string; machine: string }[] = []
          for (const r of sheetRows) {
            if (r.mo_number && !map[r.mo_number]) {
              const fallbackMachine = r.machine || r.assigned_machine
              if (fallbackMachine) {
                map[r.mo_number] = fallbackMachine
                fallback.push({ mo_number: r.mo_number, machine: fallbackMachine })
              }
            }
          }
          if (fallback.length > 0) {
            fetch('/api/argoerp/mo-machine-assign', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ assignments: fallback }),
            }).catch(() => {})
          }

          // 用 merge 方式更新：DB 值填補空缺，但保留使用者已手動改過的選擇
          // { ...map, ...prev }：prev（使用者最新狀態）覆蓋 map（DB 值）
          setMoMachines(prev => ({ ...map, ...prev }))
        }
      })
      .catch(() => {})
  }, [sheetRows])

  const setMoMachine = useCallback((moNumber: string, machine: string) => {
    setMoMachines(prev => ({ ...prev, [moNumber]: machine }))
    setMachineChanged(true)
  }, [])

  // ---- 儲存機台分配：PATCH 到 Supabase + mo-machine-assign，然後重新讀回 ----
  const handleSaveMachines = useCallback(async () => {
    if (!selectedDate) return
    setSavingMachine(true)
    setSaveMsg('')
    try {
      // 1. 更新 mo-machine-assign 表（有 mo_number 的列）
      const moAssignments = sheetRows
        .filter(r => r.mo_number)
        .map(r => ({
          mo_number: r.mo_number!,
          machine: moMachines[r.mo_number!] || '',
        }))
      if (moAssignments.length > 0) {
        await fetch('/api/argoerp/mo-machine-assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignments: moAssignments }),
        })
      }

      // 2. PATCH daily_order_sheets.rows 的 machine 欄位（所有列）
      const updates = sheetRows.map(r => ({
        row_key: r.row_key,
        machine: r.mo_number
          ? (moMachines[r.mo_number] || '')
          : (rowMachines[r.row_key] || ''),
      }))
      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: selectedDate, updates }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)

      // 3. 同步更新本地 sheetRows 的 machine 欄位（避免呼叫 loadSheet 引發 token 問題）
      setSheetRows(prev => prev.map(r => ({
        ...r,
        machine: r.mo_number
          ? (moMachines[r.mo_number] || r.machine || '')
          : (rowMachines[r.row_key] || r.machine || ''),
      })))
      setMachineChanged(false)
      setSaveMsg('✅ 機台分配已儲存')
      setTimeout(() => setSaveMsg(''), 4000)
    } catch (e) {
      setSaveMsg(`❌ 機台儲存失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setSaveMsg(''), 5000)
    } finally {
      setSavingMachine(false)
    }
  }, [sheetRows, selectedDate, moMachines, rowMachines])

  // ---- 解析貼上資料 ----
  const handleParse = useCallback(() => {
    setParseError('')
    setParseWarnings([])
    if (!rawText.trim()) { setParseError('請先貼上資料'); return }
    const { rows, error, duplicateWarnings } = parseSourceRows(rawText, selectedDate)
    if (error) { setParseError(error); return }

    const sheetRowsNew: SheetRow[] = rows.map(r => ({
      ...r,
      row_key: createRowKey(r),
      mo_status: null,
      // 若原始資料已填入序號（B欄），直接預填 match_line_no，無需比對
      ...(r.line_no_input
        ? { match_line_no: r.line_no_input, match_status: 'matched' as MatchStatus, match_reason: '原始資料直接填入' }
        : {}),
    }))

    // 保留已有狀態（相同 row_key 的保留舊狀態）
    const existingMap = new Map(sheetRows.map(r => [r.row_key, r]))
    const merged = sheetRowsNew.map(r => {
      const old = existingMap.get(r.row_key)
      return old ? { ...r, mo_status: old.mo_status, mo_number: old.mo_number } : r
    })
    setSheetRows(merged)
    setShowPasteArea(false)
    setParseError('')
    if (duplicateWarnings.length > 0) {
      setParseWarnings(duplicateWarnings)
    }
  }, [rawText, sheetRows, selectedDate])

  // ---- 儲存至 Supabase ----
  const handleSave = useCallback(async () => {
    if (sheetRows.length === 0) { setSaveMsg('❌ 沒有可儲存的資料'); return }
    setSaving(true)
    setSaveMsg('')
    try {
      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: selectedDate, raw_text: rawText || currentRawText, rows: sheetRows }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setSaveMsg(`✅ 已儲存 ${sheetRows.length} 筆至 ${selectedDate}`)
      setCurrentRawText(rawText || currentRawText)
      setRawText('')
      await loadSheetList()
      setTimeout(() => setSaveMsg(''), 4000)
    } catch (e) {
      setSaveMsg(`❌ 儲存失敗：${e}`)
      setTimeout(() => setSaveMsg(''), 5000)
    } finally {
      setSaving(false)
    }
  }, [sheetRows, selectedDate, rawText, currentRawText, loadSheetList])

  // ---- 列印（使用製令工單 A4 格式）----
  const handlePrint = () => {
    const printRows = sheetRows.filter((r, i) => selectedKeys.has(r.row_key || String(i)))
    if (printRows.length === 0) return

    const moRecords = printRows.map(r => ({
      mo_number: r.mo_number || r.order_number,
      planned_start_date: '',
      planned_end_date: r.delivery_date,
      mo_status: r.mo_status || '',
      department: '',
      product_code: r.item_code,
      lot_number: r.customer,
      planned_qty: String(r.quantity),
      source_order: r.order_number,
      mo_note: [r.item_name, r.plate_count ? `盤數：${r.plate_count}` : ''].filter(Boolean).join(' | '),
      create_date: selectedDate,
      factory: r.factory,
      prep_status: r.material_prep_status || '',
      machine: r.mo_number ? (moMachines[r.mo_number] || '') : (rowMachines[r.row_key] || ''),
      line_no_override: r.match_line_no || undefined,
      po_number: r.po_number ?? undefined,
      pr_number: r.pr_number ?? undefined,
      pr_sub_no: r.pr_sub_no ?? undefined,
    }))

    sessionStorage.setItem('mo_print_selection', JSON.stringify(moRecords))
    window.open('/admin/argoerp/mo-summary/print', '_blank')
  }

  // ---- 刪除整張出單表 ----
  const handleDelete = useCallback(async () => {
    if (!confirm(`確定要刪除 ${selectedDate} 的出單表（${sheetRows.length} 筆）？此操作不可復原。`)) return
    setSaving(true)
    try {
      const res = await fetch(`/api/argoerp/daily-order-sheet?date=${selectedDate}`, { method: 'DELETE' })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setSheetRows([])
      setCurrentRawText('')
      setShowPasteArea(true)
      setSaveMsg(`✅ 已刪除 ${selectedDate} 出單表`)
      await loadSheetList()
      setTimeout(() => setSaveMsg(''), 4000)
    } catch (e) {
      setSaveMsg(`❌ 刪除失敗：${e}`)
    } finally {
      setSaving(false)
    }
  }, [selectedDate, sheetRows.length, loadSheetList])

  // ---- 刪除單列 ----
  const handleDeleteRow = useCallback((idx: number) => {
    setSheetRows(prev => prev.filter((_, i) => i !== idx))
  }, [])

  // ---- 序號比對：對 erp_so_lines 比對品項+數量 → 寫回 match_* 欄位後立即儲存 ----
  const runSerialMatch = useCallback(async () => {
    if (sheetRows.length === 0) return
    setMatching(true)
    setSaveMsg('')
    try {
      const orderNumbers = [...new Set(sheetRows.map(r => r.order_number).filter(Boolean))]
      const { data: soLines, error } = await supabase
        .from('erp_so_lines')
        .select('project_id, line_no, mbp_part, order_qty_oru, pdl_seq, description, tpn_part_no, remark, remark2')
        .in('project_id', orderNumbers.length > 0 ? orderNumbers : ['__none__'])
      if (error) throw error
      const lines = soLines ?? []
      const soProjectIds = new Set(lines.map(l => l.project_id))
      const candidateMap = new Map<string, Array<{ line_no: string; pdl_seq: number | null; description: string; tpn_part_no: string; remark: string; remark2: string }>>()
      for (const line of lines) {
        const qty = Number(line.order_qty_oru ?? 0)
        const key = `${line.project_id}|${line.mbp_part ?? ''}|${qty}`
        if (!candidateMap.has(key)) candidateMap.set(key, [])
        candidateMap.get(key)!.push({
          line_no: String(line.line_no ?? ''),
          pdl_seq: line.pdl_seq != null ? Number(line.pdl_seq) : null,
          description: String(line.description ?? '').trim(),
          tpn_part_no: String(line.tpn_part_no ?? '').trim(),
          remark: String(line.remark ?? '').trim(),
          remark2: String(line.remark2 ?? '').trim(),
        })
      }
      for (const arr of candidateMap.values()) arr.sort((a, b) => (Number(a.line_no) || 0) - (Number(b.line_no) || 0))

      // ── 跨日期序號鎖定 ──────────────────────────────────────────────────────
      // 查詢所有其他日期出單表中已配對的 (order_number, line_no)，
      // 記錄是被哪個 row_key 佔用的。比對時同序號嚴禁分配給不同 row_key（不同列內容）。
      // 同 row_key（同一筆來源列出現在多個日期）則允許沿用相同序號。
      const claimedLineByOrder = new Map<string, Map<string, string>>() // order_number → Map<line_no, row_key>
      try {
        const { data: otherSheets } = await supabase
          .from('daily_order_sheets')
          .select('rows')
          .neq('sheet_date', selectedDate)
          .order('sheet_date', { ascending: false })
          .limit(90)
        for (const sheet of (otherSheets ?? [])) {
          const rows = Array.isArray((sheet as { rows?: unknown }).rows)
            ? ((sheet as { rows: Record<string, unknown>[] }).rows)
            : []
          for (const row of rows) {
            const orderNo = String(row.order_number ?? '').trim()
            const lineNo  = String(row.match_line_no ?? '').trim()
            const rowKey  = String(row.row_key ?? '').trim()
            if (!orderNo || !lineNo || !rowKey) continue
            if (!claimedLineByOrder.has(orderNo)) claimedLineByOrder.set(orderNo, new Map())
            const m = claimedLineByOrder.get(orderNo)!
            if (!m.has(lineNo)) m.set(lineNo, rowKey) // 最新日期優先（desc 排序）
          }
        }
      } catch (claimErr) {
        console.warn('讀取跨日期序號鎖定失敗，略過鎖定：', claimErr)
      }
      // ─────────────────────────────────────────────────────────────────────────

      // 同一工單內同品號同數量有多筆時，用以下優先順序縮小到唯一候選：
      //   ① 品名/規格（item_name vs erp_so_lines.description）精準比對 ← 最可靠，優先
      //   ② RO 編號（is_sample vs tpn_part_no/remark）比對             ← 次之
      //   ③ 跨日期未佔用的序號（claimedLineByOrder 鎖定）
      //   ④ 本次跑中未分配序號（usedSet）                               ← 兜底
      const usedLineNosByKey = new Map<string, Set<string>>()

      const normalizeText = (v: string): string => v.replace(/\s+/g, '').trim()

      const next: SheetRow[] = sheetRows.map(src => {
        // 原始資料已有序號（B欄直接填入）→ 跳過比對，保留現有值
        if (src.line_no_input) return src

        if (!src.order_number || !soProjectIds.has(src.order_number)) {
          return { ...src, match_status: 'no_order', match_line_no: null, match_pdl_seq: null, match_reason: '無對應來源單號' }
        }
        const qty = parseFloat(String(src.quantity).replace(/,/g, '')) || 0
        const key = `${src.order_number}|${src.item_code}|${qty}`
        const candidates = candidateMap.get(key) ?? []
        if (candidates.length === 0) {
          return { ...src, match_status: 'no_qty_match', match_line_no: null, match_pdl_seq: null, match_reason: '有來源單號但無對應數量' }
        }

        let narrowed = candidates
        // ① 品名/規格比對（最可靠：同工單同品號同數量但不同款式 → description 各自不同）
        if (narrowed.length > 1) {
          const itemNameKey = normalizeText(String(src.item_name ?? ''))
          if (itemNameKey) {
            const byDesc = narrowed.filter(c => normalizeText(c.description) === itemNameKey)
            if (byDesc.length > 0) narrowed = byDesc
          }
        }
        // ② 仍多筆時，用 RO 編號（is_sample vs tpn_part_no/remark）再縮小
        if (narrowed.length > 1) {
          const roRef = String(src.is_sample ?? '').trim()
          if (roRef) {
            const byRo = narrowed.filter(c => c.tpn_part_no === roRef || c.remark === roRef || c.remark2 === roRef)
            if (byRo.length > 0) narrowed = byRo
          }
        }

        // ③ 跨日期鎖定過濾：排除被其他 row_key 佔用的序號
        const claimedForOrder = claimedLineByOrder.get(src.order_number) ?? new Map<string, string>()
        const crossDateAvail = narrowed.filter(c => {
          const claimedBy = claimedForOrder.get(c.line_no)
          return !claimedBy || claimedBy === src.row_key  // 未被佔用 OR 同一列內容可沿用
        })
        if (crossDateAvail.length > 0) narrowed = crossDateAvail

        // ④ 兜底：取本次比對跑中尚未用過的最小序號
        const usedSet = usedLineNosByKey.get(key) ?? new Set<string>()
        usedLineNosByKey.set(key, usedSet)
        const candidate =
          narrowed.find(c => !usedSet.has(c.line_no))
          ?? narrowed[narrowed.length - 1]

        usedSet.add(candidate.line_no)
        return { ...src, match_status: 'matched', match_line_no: candidate.line_no, match_pdl_seq: candidate.pdl_seq, match_reason: '' }
      })
      setSheetRows(next)

      // 立即儲存
      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: selectedDate, raw_text: currentRawText, rows: next }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      const matched = next.filter(r => r.match_status === 'matched').length
      setSaveMsg(`✅ 序號比對完成並儲存：成功 ${matched} / ${next.length}`)
      setTimeout(() => setSaveMsg(''), 5000)
    } catch (e) {
      setSaveMsg(`❌ 比對失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setSaveMsg(''), 6000)
    } finally {
      setMatching(false)
    }
  }, [sheetRows, selectedDate, currentRawText])

  // ---- 同步製令狀態：
  //   1. argoerp_mo_upload_log（本系統建立的製令，source_order+product_code 比對）
  //   2. erp_mo_lines（ARGO 同步區的製令，source_order+mbp_part 比對 → 可抓到 ARGO 直接建立的製令）
  //   3. argoerp_material_prep_log（批備料狀態，mo_number 比對）
  const runMoSync = useCallback(async () => {
    if (sheetRows.length === 0) return
    setSyncingMo(true)
    setSaveMsg('')
    try {
      const orderNumbers = [...new Set(sheetRows.map(r => r.order_number).filter(Boolean))]
      const noNone = orderNumbers.length > 0 ? orderNumbers : ['__none__']

      // 1. 查本系統製令上傳紀錄
      const { data: moLogs, error: moErr } = await supabase
        .from('argoerp_mo_upload_log')
        .select('mo_number, source_order, product_code, planned_qty, uploaded_at')
        .in('source_order', noNone)
        .order('uploaded_at', { ascending: false })
      if (moErr) throw moErr

      // 過濾掉已從 argoerp_mo_summary 刪除的製令（upload log 是永久歷史，刪除 summary 不會連動）
      const rawLogMoNumbers = [...new Set(
        (moLogs ?? []).map(l => l.mo_number).filter((n): n is string => !!n?.startsWith('MO'))
      )]
      let activeMoNumbers = new Set(rawLogMoNumbers)
      if (rawLogMoNumbers.length > 0) {
        const { data: summaryRows } = await supabase
          .from('argoerp_mo_summary')
          .select('mo_number')
          .in('mo_number', rawLogMoNumbers)
        const stillExists = new Set((summaryRows ?? []).map(r => r.mo_number))
        activeMoNumbers = stillExists
      }

      const moMap = new Map<string, { mo_number: string }>()
      for (const log of (moLogs ?? [])) {
        if (!log.mo_number?.startsWith('MO')) continue  // 排除非製令單號的資料
        if (!activeMoNumbers.has(log.mo_number)) continue  // 排除已刪除的製令
        const qty = String(log.planned_qty ?? '').trim()
        const k1 = `${log.source_order}|${log.product_code}|${qty}`
        const k2 = `${log.source_order}|${log.product_code}`
        if (!moMap.has(k1)) moMap.set(k1, { mo_number: log.mo_number })
        if (!moMap.has(k2)) moMap.set(k2, { mo_number: log.mo_number })
      }

      // 2. 查 erp_mo_lines（ARGO 同步區），source_order = 工單編號，mbp_part = 品項編碼
      const { data: erp_mo, error: erpErr } = await supabase
        .from('erp_mo_lines')
        .select('project_id, source_order, mbp_part, order_qty, line_no')
        .in('source_order', noNone)
      if (erpErr) throw erpErr
      // erp_mo_lines 是 ARGO 直接建立的製令，末碼跟你的 SO 序號無關
      // 必須用 erp_mo_lines.line_no（ARGO 的 SO 序號欄）作為比對依據
      const erpMoMap = new Map<string, string>()       // source_order|mbp_part|line_no(padded) → mo_number
      const erpMoBaseMap = new Map<string, string[]>() // source_order|mbp_part → [mo_numbers]
      // source_order → Set<mo_number>：用於驗證某來源訂單的製令是否仍存在於 ARGO
      // 若 Set 存在（erp_mo_lines 已同步）但不含該 MO → 代表已從 ARGO 刪除
      const erpMoBySourceOrder = new Map<string, Set<string>>()
      for (const mo of (erp_mo ?? [])) {
        if (!mo.source_order || !mo.mbp_part || !mo.project_id) continue
        if (!mo.project_id.startsWith('MO')) continue
        // 用 line_no 作為 SO 序號 key（ARGO 中的欄位，不用末碼）
        if (mo.line_no != null) {
          const lineNoStr = String(parseInt(String(mo.line_no), 10)).padStart(2, '0')
          const seqKey = `${mo.source_order}|${mo.mbp_part}|${lineNoStr}`
          if (!erpMoMap.has(seqKey)) erpMoMap.set(seqKey, mo.project_id)
        }
        const baseKey = `${mo.source_order}|${mo.mbp_part}`
        const arr = erpMoBaseMap.get(baseKey) ?? []
        if (!arr.includes(mo.project_id)) erpMoBaseMap.set(baseKey, [...arr, mo.project_id])
        // 建立 source_order → Set<mo_number>
        const moSet = erpMoBySourceOrder.get(mo.source_order) ?? new Set<string>()
        moSet.add(mo.project_id)
        erpMoBySourceOrder.set(mo.source_order, moSet)
      }

      // 3. 對每列嘗試找出 mo_number
      //    ① erp_mo_lines：用 line_no 精準比對（ARGO 直接建立的 MO）
      //    ② argoerp_mo_upload_log：末碼=序號（你們系統建立的 MO）
      //    ③ erpMoBaseMap 唯一製令 fallback
      const next: SheetRow[] = sheetRows.map(r => {
        const matchSeq = r.match_line_no != null
          ? String(parseInt(r.match_line_no, 10)).padStart(2, '0')
          : null

        // 若已有 MO：先檢查是否仍存在於 ARGO erp_mo_lines
        if (r.mo_number?.startsWith('MO')) {
          const erpMosForOrder = erpMoBySourceOrder.get(r.order_number)
          // erp_mo_lines 已同步此來源訂單，但找不到此製令 → 已從 ARGO 刪除，清除
          if (erpMosForOrder && !erpMosForOrder.has(r.mo_number)) {
            return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
          }
          if (!matchSeq) return r
          const erpConfirm = erpMoMap.get(`${r.order_number}|${r.item_code}|${matchSeq}`)
          if (!erpConfirm) return r              // ARGO 尚無資料，保留上傳 log 結果
          if (erpConfirm === r.mo_number) return r  // 已確認正確
          return { ...r, mo_number: erpConfirm, mo_status: '已匯入製令' as const }  // 更正
        }

        const qty = String(r.quantity).trim()

        // ① erp_mo_lines：用 line_no 精準比對
        if (matchSeq) {
          const erpHit = erpMoMap.get(`${r.order_number}|${r.item_code}|${matchSeq}`)
          if (erpHit) return { ...r, mo_number: erpHit, mo_status: '已匯入製令' as const }
        }

        // ② 上傳 log：你們系統建立的 MO，末碼=序號
        const k1 = `${r.order_number}|${r.item_code}|${qty}`
        const logHit = moMap.get(k1) ?? moMap.get(`${r.order_number}|${r.item_code}`)
        if (logHit) {
          // erp_mo_lines 已同步此來源訂單但找不到該製令 → 已從 ARGO 刪除，跳過
          const erpMosForOrder = erpMoBySourceOrder.get(r.order_number)
          const stillInArgo = !erpMosForOrder || erpMosForOrder.has(logHit.mo_number)
          if (stillInArgo && (!matchSeq || logHit.mo_number.slice(-2) === matchSeq)) {
            return { ...r, mo_number: logHit.mo_number, mo_status: '已匯入製令' as const }
          }
        }

        // ③ 唯一製令 fallback
        const baseHits = erpMoBaseMap.get(`${r.order_number}|${r.item_code}`) ?? []
        if (baseHits.length === 1) return { ...r, mo_number: baseHits[0], mo_status: '已匯入製令' as const }

        if (r.mo_number && !r.mo_number.startsWith('MO')) {
          return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
        }
        return r
      })

      // 3. 對所有有 mo_number 的列查批備料狀態
      const moNumbers = [...new Set(next.map(r => r.mo_number).filter((v): v is string => !!v))]
      if (moNumbers.length > 0) {
        const { data: prepLogs, error: prepErr } = await supabase
          .from('argoerp_material_prep_log')
          .select('mo_number, status, logged_at')
          .in('mo_number', moNumbers)
          .order('logged_at', { ascending: false })
        if (prepErr) throw prepErr
        const prepMap = new Map<string, '已備料' | '無需備料'>()
        for (const log of (prepLogs ?? [])) {
          if (!prepMap.has(log.mo_number)) prepMap.set(log.mo_number, log.status as '已備料' | '無需備料')
        }

        // 查 ARGO 批備料單（erp_material_prep_lines），製令單號完整相符才視為已批備料
        const { data: erpPrepLines } = await supabase
          .from('erp_material_prep_lines')
          .select('mo_number')
          .in('mo_number', moNumbers)
        const erpPrepSet = new Set<string>(
          (erpPrepLines ?? []).map((l: { mo_number: string }) => l.mo_number).filter(Boolean)
        )

        for (let i = 0; i < next.length; i++) {
          const moNo = next[i].mo_number
          if (!moNo) continue
          if (erpPrepSet.has(moNo)) {
            next[i] = { ...next[i], material_prep_status: '已批備料' }
          } else if (prepMap.has(moNo)) {
            next[i] = { ...next[i], material_prep_status: prepMap.get(moNo)! }
          }
        }
      }

      // 若 row 原本已分配機台，轉換成 MO 後遷移至 moMachines
      // ⚠️ 必須在 setSheetRows 之前完成，否則 useEffect(sheetRows) 會重新 fetch
      //    mo-machine-assign 舊資料覆蓋掉剛遷移的機台
      const toMigrate = next.filter(r => r.mo_number && r.machine)
      if (toMigrate.length > 0) {
        const assignments = toMigrate.map(r => ({ mo_number: r.mo_number!, machine: r.machine! }))
        setMoMachines(prev => {
          const m = { ...prev }
          for (const a of assignments) if (!m[a.mo_number]) m[a.mo_number] = a.machine
          return m
        })
        await fetch('/api/argoerp/mo-machine-assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignments }),
        }).catch(() => {})
      }

      setSheetRows(next)

      // 立即儲存
      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: selectedDate, raw_text: currentRawText, rows: next }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      const newMo = next.filter((r, i) => r.mo_number && !sheetRows[i]?.mo_number).length
      const batchPrepCount = next.filter(r => r.material_prep_status === '已批備料').length
      const prepCount = next.filter(r => r.material_prep_status && r.material_prep_status !== '已批備料').length
      const prepMsg = batchPrepCount > 0 ? `已批備料 ${batchPrepCount} 筆${prepCount > 0 ? `、其他狀態 ${prepCount} 筆` : ''}` : prepCount > 0 ? `批備料狀態 ${prepCount} 筆` : '無批備料紀錄'
      setSaveMsg(`✅ 製令狀態同步完成：新增 ${newMo} 筆製令連結，${prepMsg}`)
      setTimeout(() => setSaveMsg(''), 5000)
    } catch (e) {
      setSaveMsg(`❌ 同步失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setSaveMsg(''), 6000)
    } finally {
      setSyncingMo(false)
    }
  }, [sheetRows, selectedDate, currentRawText])

  // ---- 採購單比對：對 erp_pj_sync 以 item_code + qty 比對 factory=C（常平）及 factory=O（委外）列 ----
  const [syncingPo, setSyncingPo] = useState(false)

  // 共用配對邏輯（C 與 O 均適用）
  type PoCandidate = { doc_no: string; sub_no: string; item_code: string | null; qty: number; status: string | null; start_date: string | null; extra: Record<string, unknown> | null; _used: boolean }
  const matchPoRows = (rows: SheetRow[], pool: PoCandidate[], factory: 'C' | 'O', sheetDate: string): SheetRow[] => {
    // fallback 日期門檻：PO 開單日距出單表日期不得超過 6 個月，防止舊 PO 誤配新單
    const sheetMs = new Date(sheetDate).getTime()
    const SIX_MONTHS_MS = 6 * 30 * 24 * 60 * 60 * 1000
    const isPoRecent = (c: PoCandidate): boolean => {
      if (c.start_date) return sheetMs - new Date(c.start_date).getTime() <= SIX_MONTHS_MS
      // 從 doc_no 解析（格式 POYYMM...）
      if (/^[A-Z]{2}\d{6}/.test(c.doc_no)) {
        const year = 2000 + parseInt(c.doc_no.slice(2, 4), 10)
        const month = parseInt(c.doc_no.slice(4, 6), 10) - 1
        return sheetMs - new Date(year, month, 1).getTime() <= SIX_MONTHS_MS
      }
      return true
    }
    return rows.map(row => {
      if (row.factory !== factory) return row
      if (row.po_status === 'no_po') return row       // 使用者已標記無須採購，保留
      if (row.po_confirmed && row.po_number) return row // 使用者已人工確認採購單，保留
      if (!row.item_code) return { ...row, po_number: null, po_sub_no: null, po_status: 'no_match' }
      const qty = parseFloat(String(row.quantity).replace(/,/g, '')) || 0
      const matchLineNo = (row.match_line_no ?? '').trim()
      // 第一優先：料號 + 數量 + SO_PROJECT_ID === 銷售訂單號（委外 PO 用此欄位記錄來源單）
      let hitIdx = pool.findIndex(c =>
        !c._used && (c.item_code ?? '') === row.item_code && c.qty === qty &&
        String(c.extra?.SO_PROJECT_ID ?? '') === (row.order_number ?? '')
      )
      // 第二優先：料號 + 數量 + MBP_LOT_NO === 銷售訂單號（常平 PO 批號即 SO 單號）
      if (hitIdx === -1)
        hitIdx = pool.findIndex(c =>
          !c._used && (c.item_code ?? '') === row.item_code && c.qty === qty &&
          String(c.extra?.MBP_LOT_NO ?? '').trim() === (row.order_number ?? '').trim()
        )
      // 第三優先：料號 + TPN_PART_NO === match_line_no + SO_PROJECT_ID / MBP_LOT_NO 指向同一工單
      // 僅委外（O）適用；此優先不要求 qty 完全相符（ERP 採購單 qty 可能與出單表分批不同）
      // → qty 相符：直接 matched；qty 不符：標記 qty_mismatch 供人工確認
      let p3QtyMismatch = false
      if (hitIdx === -1 && matchLineNo && factory === 'O') {
        hitIdx = pool.findIndex(c =>
          !c._used && (c.item_code ?? '') === row.item_code &&
          String(c.extra?.TPN_PART_NO ?? '') === matchLineNo &&
          (
            String(c.extra?.SO_PROJECT_ID ?? '').trim() === (row.order_number ?? '').trim() ||
            String(c.extra?.MBP_LOT_NO ?? '').trim() === (row.order_number ?? '').trim()
          )
        )
        if (hitIdx !== -1 && pool[hitIdx].qty !== qty) p3QtyMismatch = true
      }
      // fallback：僅料號 + 數量，且 MBP_LOT_NO 為空，且 SO_PROJECT_ID 也為空或一致，
      // 且 PO 開單日距出單表日期不超過 6 個月（防止舊年份 PO 誤配新訂單）
      // 常平（C）與委外（O）都有明確的批號/來源訂單可比對，不走此 fallback
      if (hitIdx === -1 && factory !== 'C' && factory !== 'O')
        hitIdx = pool.findIndex(c =>
          !c._used && (c.item_code ?? '') === row.item_code && c.qty === qty &&
          !String(c.extra?.MBP_LOT_NO ?? '').trim() &&
          (!String(c.extra?.SO_PROJECT_ID ?? '').trim() || String(c.extra?.SO_PROJECT_ID ?? '') === (row.order_number ?? '')) &&
          isPoRecent(c)
        )
      if (hitIdx === -1) return { ...row, po_number: null, po_sub_no: null, po_status: 'no_match', mo_status: null }
      pool[hitIdx]._used = true
      if (p3QtyMismatch)
        return { ...row, po_number: pool[hitIdx].doc_no, po_sub_no: pool[hitIdx].sub_no, po_status: 'qty_mismatch', po_qty_erp: pool[hitIdx].qty }
      return { ...row, po_number: pool[hitIdx].doc_no, po_sub_no: pool[hitIdx].sub_no, po_status: 'matched' }
    })
  }

  // ---- 委外請購單比對（PR 為輔，採購單優先）----
  // 比對鏈：出單表 order_number(SO) → erp_so_lines.tpn_part_no(RO) → erp_pj_sync 請購單 extra.SO_PROJECT_ID(RO)
  const extractRo = (...candidates: Array<unknown>): string | null => {
    for (const c of candidates) {
      const s = String(c ?? '').trim()
      if (!s) continue
      const m = s.match(/RO\d{6,}/i)
      if (m) return m[0].toUpperCase()
    }
    return null
  }

  type PrCandidate = { doc_no: string; sub_no: string; item_code: string | null; ro: string; status: string | null; _used: boolean }
  // 對僅 factory==='O' 的列做請購單比對；rows 已是最新狀態（含採購比對結果）
  // 比對優先序：
  //   (a) 直接 SO 號比對：請購 extra.PROJECT_ID / MBP_LOT_NO 直接帶出單表 SO 號（委外 MPO 類請購常見，無 RO）
  //   (b) RO 橋接比對：SO → erp_so_lines.tpn_part_no(RO) → 請購 extra.SO_PROJECT_ID(RO)
  const matchPrRowsByPool = (
    rows: SheetRow[],
    soToRoByItem: Map<string, string>,  // key: `${SO}|${item_code}` → RO
    soToRoAny: Map<string, string>,     // key: SO → 任一 RO（item 對不到時 fallback）
    roToPr: Map<string, PrCandidate[]>, // RO → 請購候選
    soToPr: Map<string, PrCandidate[]>, // SO → 請購候選（直接 SO 號比對）
  ): SheetRow[] => {
    const pickHit = (cands: PrCandidate[] | undefined, itemCode: string | null | undefined): PrCandidate | undefined => {
      if (!cands || cands.length === 0) return undefined
      const myItem = (itemCode ?? '').trim()
      // 優先：料號精準相符且未用
      const exactHit = cands.find(c => !c._used && (c.item_code ?? '').trim() === myItem)
      if (exactHit) return exactHit
      // 次之：PR 本身沒有料號（整張請購，不限定品項）且未用
      const blankItemHit = cands.find(c => !c._used && !(c.item_code ?? '').trim())
      if (blankItemHit) return blankItemHit
      // 料號不符且 PR 本身有明確料號 → 不配（避免誤配到不同品項）
      return undefined
    }
    return rows.map(row => {
      if (row.factory !== 'O') return row
      const so = String(row.order_number ?? '').trim()
      if (!so) return { ...row, pr_number: null, pr_sub_no: null, pr_status: 'no_match' }

      // (a) 直接 SO 號比對（優先）
      const directHit = pickHit(soToPr.get(so), row.item_code)
      if (directHit) {
        directHit._used = true
        return { ...row, pr_number: directHit.doc_no, pr_sub_no: directHit.sub_no, pr_status: 'matched' }
      }

      // (b) RO 橋接比對（後備）
      const ro = soToRoByItem.get(`${so}|${row.item_code}`) ?? soToRoAny.get(so) ?? null
      if (ro) {
        const roHit = pickHit(roToPr.get(ro), row.item_code)
        if (roHit) {
          roHit._used = true
          return { ...row, pr_number: roHit.doc_no, pr_sub_no: roHit.sub_no, pr_status: 'matched' }
        }
      }
      return { ...row, pr_number: null, pr_sub_no: null, pr_status: 'no_match' }
    })
  }

  // 依出單表 O 列建立 SO→請購 對應並比對，回傳更新後 rows
  const matchPrRows = async (rows: SheetRow[]): Promise<SheetRow[]> => {
    const oRows = rows.filter(r => r.factory === 'O')
    if (oRows.length === 0) return rows
    const soNos = [...new Set(oRows.map(r => String(r.order_number ?? '').trim()).filter(Boolean))]
    if (soNos.length === 0) return rows

    // 1) 直接 SO 號比對：請購 extra.PROJECT_ID 或 MBP_LOT_NO 直接帶出單表 SO 號
    //    （委外 MPO 類請購常將 SO 號存於 MBP_LOT_NO，且 SO_PROJECT_ID/RO 為空，無法走 RO 橋接）
    const soToPr = new Map<string, PrCandidate[]>()
    const pushSoPr = (so: string, r: { doc_no: string; sub_no: string; item_code: string | null; status: string | null }) => {
      const key = so.trim()
      if (!key) return
      if (!soToPr.has(key)) soToPr.set(key, [])
      const list = soToPr.get(key)!
      // 去重：同 doc_no#sub_no 只留一筆
      if (list.some(c => c.doc_no === r.doc_no && c.sub_no === r.sub_no)) return
      list.push({ doc_no: r.doc_no, sub_no: r.sub_no, item_code: r.item_code, ro: '', status: r.status, _used: false })
    }
    for (const field of ['MBP_LOT_NO', 'PROJECT_ID'] as const) {
      const { data: prDirect, error: prDirectErr } = await supabase
        .from('erp_pj_sync')
        .select('doc_no, sub_no, item_code, status, extra')
        .eq('doc_type', '請購單號')
        .in(`extra->>${field}`, soNos)
      if (prDirectErr) throw prDirectErr
      for (const r of prDirect ?? []) {
        const so = String((r.extra as Record<string, unknown> | null)?.[field] ?? '').trim()
        pushSoPr(so, r)
      }
    }

    // 2) SO → RO（透過 erp_so_lines.tpn_part_no）
    const { data: soLines, error: soErr } = await supabase
      .from('erp_so_lines')
      .select('project_id, mbp_part, tpn_part_no')
      .in('project_id', soNos)
    if (soErr) throw soErr
    const soToRoByItem = new Map<string, string>()
    const soToRoAny = new Map<string, string>()
    for (const l of soLines ?? []) {
      const ro = extractRo(l.tpn_part_no)
      if (!ro) continue
      const so = String(l.project_id ?? '').trim()
      const item = String(l.mbp_part ?? '').trim()
      if (item) { const k = `${so}|${item}`; if (!soToRoByItem.has(k)) soToRoByItem.set(k, ro) }
      if (!soToRoAny.has(so)) soToRoAny.set(so, ro)
    }
    const ros = [...new Set([...soToRoByItem.values(), ...soToRoAny.values()])]

    // 3) RO → 請購單（erp_pj_sync doc_type=請購單號，extra.SO_PROJECT_ID 為 RO）
    const roToPr = new Map<string, PrCandidate[]>()
    if (ros.length > 0) {
      const { data: prRows, error: prErr } = await supabase
        .from('erp_pj_sync')
        .select('doc_no, sub_no, item_code, status, extra')
        .eq('doc_type', '請購單號')
        .in('extra->>SO_PROJECT_ID', ros)
      if (prErr) throw prErr
      for (const r of prRows ?? []) {
        const ro = String((r.extra as Record<string, unknown> | null)?.SO_PROJECT_ID ?? '').trim().toUpperCase()
        if (!ro) continue
        if (!roToPr.has(ro)) roToPr.set(ro, [])
        roToPr.get(ro)!.push({ doc_no: r.doc_no, sub_no: r.sub_no, item_code: r.item_code, ro, status: r.status, _used: false })
      }
    }

    // 兩種比對來源皆無 → O 列標 no_match
    if (soToPr.size === 0 && ros.length === 0) {
      return rows.map(r => r.factory === 'O' ? { ...r, pr_number: null, pr_sub_no: null, pr_status: 'no_match' } : r)
    }

    return matchPrRowsByPool(rows, soToRoByItem, soToRoAny, roToPr, soToPr)
  }

  const runPoMatch = useCallback(async () => {
    const cRows = sheetRows.filter(r => r.factory === 'C')
    const oRows = sheetRows.filter(r => r.factory === 'O')
    if (cRows.length === 0 && oRows.length === 0) {
      setSaveMsg('ℹ️ 本日出單表無常平／委外廠列')
      setTimeout(() => setSaveMsg(''), 4000)
      return
    }
    setSyncingPo(true)
    setSaveMsg('')
    try {
      // 先從 DB 拉最新 rows，確保多台電腦作業時能取得其他人的人工確認結果（po_confirmed）
      const latestRes = await fetch(`/api/argoerp/daily-order-sheet?date=${selectedDate}`)
      const latestJson = await latestRes.json()
      let next: SheetRow[] = latestJson.success && latestJson.sheet?.rows
        ? (latestJson.sheet.rows as SheetRow[])
        : sheetRows

      // ── 常平（C01510）──
      if (cRows.length > 0) {
        const itemCodes = [...new Set(cRows.map(r => r.item_code).filter(Boolean))]
        if (itemCodes.length > 0) {
          const { data: poRows, error } = await supabase
            .from('erp_pj_sync')
            .select('doc_no, sub_no, item_code, qty, status, start_date, extra')
            .eq('doc_type', '採購單號')
            .in('status', ['OPEN', 'UNSIGNED'])
            .eq('customer_vendor', 'C01510')
            .in('item_code', itemCodes)
            .order('doc_no', { ascending: false })
          if (error) throw error
          const pool: PoCandidate[] = (poRows ?? []).map(r => ({
            doc_no: r.doc_no, sub_no: r.sub_no, item_code: r.item_code,
            qty: Number(r.qty ?? 0), status: r.status,
            start_date: (r.start_date as string | null) ?? null,
            extra: (r.extra ?? null) as Record<string, unknown> | null, _used: false,
          }))
          next = matchPoRows(next, pool, 'C', selectedDate)
        }
      }

      // ── 委外（任意廠商，排除常平 C01510）──
      if (oRows.length > 0) {
        const itemCodesO = [...new Set(oRows.map(r => r.item_code).filter(Boolean))]
        if (itemCodesO.length > 0) {
          const { data: poRowsO, error: errO } = await supabase
            .from('erp_pj_sync')
            .select('doc_no, sub_no, item_code, qty, status, start_date, extra')
            .eq('doc_type', '採購單號')
            .in('status', ['OPEN', 'UNSIGNED'])
            .neq('customer_vendor', 'C01510')
            .in('item_code', itemCodesO)
            .order('doc_no', { ascending: false })
          if (errO) throw errO
          const poolO: PoCandidate[] = (poRowsO ?? []).map(r => ({
            doc_no: r.doc_no, sub_no: r.sub_no, item_code: r.item_code,
            qty: Number(r.qty ?? 0), status: r.status,
            start_date: (r.start_date as string | null) ?? null,
            extra: (r.extra ?? null) as Record<string, unknown> | null, _used: false,
          }))
          next = matchPoRows(next, poolO, 'O', selectedDate)
        }
      }

      // ── 委外請購單比對（PR 為輔）──
      try {
        next = await matchPrRows(next)
      } catch (prE) {
        console.error('請購單比對失敗（不影響採購結果）：', prE)
      }

      setSheetRows(next)

      // 立即儲存
      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: selectedDate, raw_text: currentRawText, rows: next }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      const cMatched = next.filter(r => r.factory === 'C' && r.po_status === 'matched').length
      const cNoMatch = next.filter(r => r.factory === 'C' && r.po_status === 'no_match').length
      const oMatched = next.filter(r => r.factory === 'O' && r.po_status === 'matched').length
      const oNoMatch = next.filter(r => r.factory === 'O' && r.po_status === 'no_match').length
      const oPrMatched = next.filter(r => r.factory === 'O' && r.pr_status === 'matched').length
      const parts: string[] = []
      if (cRows.length > 0) parts.push(`常平 ${cMatched}/${cRows.length}${cNoMatch > 0 ? `（未配 ${cNoMatch}）` : ''}`)
      if (oRows.length > 0) parts.push(`委外 ${oMatched}/${oRows.length}${oNoMatch > 0 ? `（未配 ${oNoMatch}）` : ''}${oPrMatched > 0 ? `、請購 ${oPrMatched}` : ''}`)
      setSaveMsg(`✅ 採購單比對完成：${parts.join('　')}`)
      setTimeout(() => setSaveMsg(''), 6000)
    } catch (e) {
      setSaveMsg(`❌ 採購單比對失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setSaveMsg(''), 6000)
    } finally { setSyncingPo(false) }
  }, [sheetRows, selectedDate, currentRawText])

  // ---- 漏單檢測：跨所有日期，匯出未比對到製令且未比對到採購單的列 ----
  const [exportingMissing, setExportingMissing] = useState(false)
  const [exportingSheetCsv, setExportingSheetCsv] = useState(false)

  // ---- 交期檢查 ----
  const handleDueDateCheck = useCallback(() => {
    // 以出單表日期（selectedDate）為 day 0，而非執行當天
    const sheetDateObj = selectedDate ? new Date(selectedDate) : new Date()
    sheetDateObj.setHours(0, 0, 0, 0)

    const anomalies: DueDateAnomaly[] = []
    for (const row of sheetRows) {
      const factoryKey = row.factory ?? ''
      const threshold = DUE_THRESHOLD[factoryKey]
      if (threshold === undefined) continue
      if (!row.delivery_date) continue
      const dueDate = parseDeliveryDate(row.delivery_date)
      if (!dueDate) continue
      const workDays = countWorkingDaysFrom(sheetDateObj, dueDate)
      if (workDays < threshold) {
        const factoryLabel = FACTORY_LABEL_ZH[factoryKey] ?? factoryKey
        const reason = `${factoryLabel}訂單交期不足${threshold}工作天`
        const dueStr = `${dueDate.getFullYear()}/${dueDate.getMonth() + 1}/${dueDate.getDate()}`
        anomalies.push({
          order_number: row.order_number ?? '',
          factory: factoryKey,
          customer: row.customer ?? '',
          item_code: row.item_code ?? '',
          item_name: row.item_name ?? '',
          quantity: row.quantity != null ? String(row.quantity) : '',
          delivery_date: dueStr,
          reason,
        })
      }
    }
    if (anomalies.length === 0) {
      alert('✅ 所有訂單交期正常')
      return
    }
    setDueDateCopied(false)
    setDueDateModal(anomalies)
  }, [sheetRows, selectedDate])

  const handleExportSheetCsv = useCallback(() => {
    if (sheetRows.length === 0) {
      setSaveMsg('❌ 沒有可匯出的資料')
      setTimeout(() => setSaveMsg(''), 3000)
      return
    }

    setExportingSheetCsv(true)
    try {
      const headers = [
        '出單日期', '工單編號', '單據種類', '生產廠別', '客戶', '品項編碼', '品名/規格', '備註',
        '數量', '交付日期', '訂單狀態', '製令狀態', '製令單號', '採購狀態', '採購單號', '採購序號',
        '備料狀態', '批備料單號', '機台',
      ]
      const rows = sheetRows.map(r => [
        selectedDate,
        r.order_number,
        r.doc_type,
        r.factory,
        r.customer,
        r.item_code,
        r.item_name,
        r.note,
        r.quantity,
        r.delivery_date,
        r.order_status,
        (r.mo_status ?? (((r.factory === 'C' || r.factory === 'O') && r.po_status === 'matched') ? '已匯入採單' : '')),
        r.mo_number ?? '',
        r.po_status ?? '',
        r.po_number ?? '',
        r.po_sub_no ?? '',
        r.material_prep_status ?? '',
        r.argo_slip_no ?? '',
        (r.mo_number
          ? (moMachines[r.mo_number] ?? r.machine ?? r.assigned_machine ?? rowMachines[r.row_key] ?? '')
          : (rowMachines[r.row_key] ?? r.machine ?? r.assigned_machine ?? '')),
      ])

      const datePart = selectedDate || todayStr()
      downloadCsv(`每日出單表_${datePart}.csv`, headers, rows)
      setSaveMsg(`✅ 已匯出 CSV：${datePart}（${sheetRows.length} 筆）`)
      setTimeout(() => setSaveMsg(''), 4000)
    } catch (e) {
      setSaveMsg(`❌ CSV 匯出失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setSaveMsg(''), 5000)
    } finally {
      setExportingSheetCsv(false)
    }
  }, [sheetRows, selectedDate, moMachines, rowMachines])

  const handleMissingExport = useCallback(async () => {
    const ok = confirm(
      '⚠️ 漏單檢測說明\n\n' +
      '此功能以「目前資料庫內的比對狀態」為準。\n\n' +
      '建議執行前先完成：\n' +
      '  1. ERP 同步頁面 → 全同步（MO / PO / PR）\n' +
      '  2. 各日出單表 → 一鍵全同步\n\n' +
      '確定以目前資料直接匯出？'
    )
    if (!ok) return
    setExportingMissing(true)
    setSaveMsg('')
    try {
      type RawRow = Record<string, unknown>
      const { data, error } = await supabase
        .from('daily_order_sheets')
        .select('sheet_date, rows')
        .order('sheet_date', { ascending: false })
      if (error) throw error

      const missing: Array<{ sheet_date: string } & RawRow> = []
      for (const sheet of (data ?? [])) {
        const rows = Array.isArray(sheet.rows) ? (sheet.rows as RawRow[]) : []
        for (const row of rows) {
          const hasMo  = row.mo_status === '已匯入製令'
          const hasPo  = row.po_status === 'matched' && !!row.po_number
          const isNoPo = row.po_status === 'no_po'
          if (!hasMo && !hasPo && !isNoPo) {
            missing.push({ sheet_date: sheet.sheet_date, ...row })
          }
        }
      }

      const headers = ['出單日期', '工單編號', '單據種類', '生產廠別', '客戶', '品項編碼', '品名/規格', '備註', '數量', '交付日期', '製令狀態', '製令單號', '採購單號', '採購序號']
      const csvRows = missing.map(r => [
        r.sheet_date,
        r.order_number ?? '',
        r.doc_type ?? '',
        r.factory ?? '',
        r.customer ?? '',
        r.item_code ?? '',
        r.item_name ?? '',
        r.note ?? '',
        r.quantity ?? '',
        r.delivery_date ?? '',
        r.mo_status ?? '',
        r.mo_number ?? '',
        r.po_number ?? '',
        r.po_sub_no ?? '',
      ])

      const bom = '\uFEFF'
      const csvContent = bom + [
        headers.map(h => `"${h}"`).join(','),
        ...csvRows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')),
      ].join('\n')

      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `漏單檢測_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
      setSaveMsg(`✅ 漏單匯出完成，共 ${missing.length} 筆`)
      setTimeout(() => setSaveMsg(''), 5000)
    } catch (e) {
      setSaveMsg(`❌ 漏單匯出失敗：${e}`)
    } finally {
      setExportingMissing(false)
    }
  }, [])

  // ---- 一鍵全同步（序號比對 → 製令同步 → 採購比對）一次完成，只儲存一次 ----
  const [syncingAll, setSyncingAll] = useState(false)

  const runAllSync = useCallback(async () => {
    if (sheetRows.length === 0) return
    setSyncingAll(true)
    setSaveMsg('⏳ 全同步進行中：序號比對…')
    let currentRows: SheetRow[] = sheetRows
    try {
      // ── Step 1: 序號比對 ──────────────────────────────────────
      const orderNumbers = [...new Set(currentRows.map(r => r.order_number).filter(Boolean))]
      const { data: soLines, error: soErr } = await supabase
        .from('erp_so_lines')
        .select('project_id, line_no, mbp_part, order_qty_oru, pdl_seq, description, tpn_part_no, remark, remark2')
        .in('project_id', orderNumbers.length > 0 ? orderNumbers : ['__none__'])
      if (soErr) throw soErr
      const soProjectIds = new Set((soLines ?? []).map(l => l.project_id))
      const candidateMap = new Map<string, Array<{ line_no: string; pdl_seq: number | null; description: string; tpn_part_no: string; remark: string; remark2: string }>>()
      for (const line of (soLines ?? [])) {
        const qty = Number(line.order_qty_oru ?? 0)
        const key = `${line.project_id}|${line.mbp_part ?? ''}|${qty}`
        if (!candidateMap.has(key)) candidateMap.set(key, [])
        candidateMap.get(key)!.push({
          line_no: String(line.line_no ?? ''),
          pdl_seq: line.pdl_seq != null ? Number(line.pdl_seq) : null,
          description: String(line.description ?? '').trim(),
          tpn_part_no: String(line.tpn_part_no ?? '').trim(),
          remark: String(line.remark ?? '').trim(),
          remark2: String(line.remark2 ?? '').trim(),
        })
      }
      for (const arr of candidateMap.values()) arr.sort((a, b) => (Number(a.line_no) || 0) - (Number(b.line_no) || 0))

      // 跨日期序號鎖定
      const claimedLineByOrderAll = new Map<string, Map<string, string>>()
      try {
        const { data: otherSheetsAll } = await supabase
          .from('daily_order_sheets')
          .select('rows')
          .neq('sheet_date', selectedDate)
          .order('sheet_date', { ascending: false })
          .limit(90)
        for (const sheet of (otherSheetsAll ?? [])) {
          const rows = Array.isArray((sheet as { rows?: unknown }).rows)
            ? ((sheet as { rows: Record<string, unknown>[] }).rows) : []
          for (const row of rows) {
            const orderNo = String(row.order_number ?? '').trim()
            const lineNo  = String(row.match_line_no ?? '').trim()
            const rowKey  = String(row.row_key ?? '').trim()
            if (!orderNo || !lineNo || !rowKey) continue
            if (!claimedLineByOrderAll.has(orderNo)) claimedLineByOrderAll.set(orderNo, new Map())
            const m = claimedLineByOrderAll.get(orderNo)!
            if (!m.has(lineNo)) m.set(lineNo, rowKey)
          }
        }
      } catch { /* 略過，不影響主流程 */ }

      const normalizeTextAll = (v: string): string => v.replace(/\s+/g, '').trim()
      const usedLineNosByKeyAll = new Map<string, Set<string>>()
      currentRows = currentRows.map(src => {
        if (!src.order_number || !soProjectIds.has(src.order_number)) {
          return { ...src, match_status: 'no_order', match_line_no: null, match_pdl_seq: null, match_reason: '無對應來源單號' }
        }
        const qty = parseFloat(String(src.quantity).replace(/,/g, '')) || 0
        const key = `${src.order_number}|${src.item_code}|${qty}`
        const candidates = candidateMap.get(key) ?? []
        if (candidates.length === 0) {
          return { ...src, match_status: 'no_qty_match', match_line_no: null, match_pdl_seq: null, match_reason: '有來源單號但無對應數量' }
        }
        let narrowed = candidates
        // ① 品名/規格比對
        if (narrowed.length > 1) {
          const k = normalizeTextAll(String(src.item_name ?? ''))
          if (k) { const b = narrowed.filter(c => normalizeTextAll(c.description) === k); if (b.length > 0) narrowed = b }
        }
        // ② RO 編號比對
        if (narrowed.length > 1) {
          const roRef = String(src.is_sample ?? '').trim()
          if (roRef) { const b = narrowed.filter(c => c.tpn_part_no === roRef || c.remark === roRef || c.remark2 === roRef); if (b.length > 0) narrowed = b }
        }
        // ③ 跨日期鎖定
        const claimed = claimedLineByOrderAll.get(src.order_number) ?? new Map<string, string>()
        const avail = narrowed.filter(c => { const by = claimed.get(c.line_no); return !by || by === src.row_key })
        if (avail.length > 0) narrowed = avail
        // ④ 兜底：本次跑中未用的最小序號
        const usedSet = usedLineNosByKeyAll.get(key) ?? new Set<string>()
        usedLineNosByKeyAll.set(key, usedSet)
        const candidate = narrowed.find(c => !usedSet.has(c.line_no)) ?? narrowed[narrowed.length - 1]
        usedSet.add(candidate.line_no)
        return { ...src, match_status: 'matched', match_line_no: candidate.line_no, match_pdl_seq: candidate.pdl_seq, match_reason: '' }
      })
      const serialMatched = currentRows.filter(r => r.match_status === 'matched').length

      // ── Step 2: 同步製令/批備料狀態 ──────────────────────────
      setSaveMsg('⏳ 全同步進行中：同步製令/批備料…')
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
        (moLogs ?? []).map(l => l.mo_number).filter((n): n is string => !!n?.startsWith('MO'))
      )]
      let activeMoNumbers = new Set(rawLogMoNumbers)
      if (rawLogMoNumbers.length > 0) {
        const { data: summaryRows } = await supabase
          .from('argoerp_mo_summary').select('mo_number').in('mo_number', rawLogMoNumbers)
        activeMoNumbers = new Set((summaryRows ?? []).map(r => r.mo_number))
      }
      const moMap = new Map<string, { mo_number: string }>()
      for (const log of (moLogs ?? [])) {
        if (!log.mo_number?.startsWith('MO') || !activeMoNumbers.has(log.mo_number)) continue
        const qty = String(log.planned_qty ?? '').trim()
        const k1 = `${log.source_order}|${log.product_code}|${qty}`
        const k2 = `${log.source_order}|${log.product_code}`
        if (!moMap.has(k1)) moMap.set(k1, { mo_number: log.mo_number })
        if (!moMap.has(k2)) moMap.set(k2, { mo_number: log.mo_number })
      }
      const erpMoMap = new Map<string, string>()
      const erpMoBaseMap = new Map<string, string[]>()
      const erpMoBySourceOrder = new Map<string, Set<string>>()
      for (const mo of (erp_mo ?? [])) {
        if (!mo.source_order || !mo.mbp_part || !mo.project_id?.startsWith('MO')) continue
        if (mo.line_no != null) {
          const lineNoStr = String(parseInt(String(mo.line_no), 10)).padStart(2, '0')
          const seqKey = `${mo.source_order}|${mo.mbp_part}|${lineNoStr}`
          if (!erpMoMap.has(seqKey)) erpMoMap.set(seqKey, mo.project_id)
        }
        const baseKey = `${mo.source_order}|${mo.mbp_part}`
        const arr = erpMoBaseMap.get(baseKey) ?? []
        if (!arr.includes(mo.project_id)) erpMoBaseMap.set(baseKey, [...arr, mo.project_id])
        const moSet = erpMoBySourceOrder.get(mo.source_order) ?? new Set<string>()
        moSet.add(mo.project_id)
        erpMoBySourceOrder.set(mo.source_order, moSet)
      }
      const prevRows = currentRows
      currentRows = currentRows.map(r => {
        const matchSeq = r.match_line_no != null ? String(parseInt(r.match_line_no, 10)).padStart(2, '0') : null
        if (r.mo_number?.startsWith('MO')) {
          const erpMosForOrder = erpMoBySourceOrder.get(r.order_number)
          if (erpMosForOrder && !erpMosForOrder.has(r.mo_number))
            return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
          if (!matchSeq) return r
          const erpConfirm = erpMoMap.get(`${r.order_number}|${r.item_code}|${matchSeq}`)
          if (!erpConfirm || erpConfirm === r.mo_number) return r
          return { ...r, mo_number: erpConfirm, mo_status: '已匯入製令' as const }
        }
        const qty = String(r.quantity).trim()
        if (matchSeq) {
          const erpHit = erpMoMap.get(`${r.order_number}|${r.item_code}|${matchSeq}`)
          if (erpHit) return { ...r, mo_number: erpHit, mo_status: '已匯入製令' as const }
        }
        const logHit = moMap.get(`${r.order_number}|${r.item_code}|${qty}`) ?? moMap.get(`${r.order_number}|${r.item_code}`)
        if (logHit) {
          const erpMosForOrder = erpMoBySourceOrder.get(r.order_number)
          const stillInArgo = !erpMosForOrder || erpMosForOrder.has(logHit.mo_number)
          if (stillInArgo && (!matchSeq || logHit.mo_number.slice(-2) === matchSeq))
            return { ...r, mo_number: logHit.mo_number, mo_status: '已匯入製令' as const }
        }
        const baseHits = erpMoBaseMap.get(`${r.order_number}|${r.item_code}`) ?? []
        if (baseHits.length === 1) return { ...r, mo_number: baseHits[0], mo_status: '已匯入製令' as const }
        if (r.mo_number && !r.mo_number.startsWith('MO'))
          return { ...r, mo_number: undefined, mo_status: null, material_prep_status: null }
        return r
      })
      const moNumbers = [...new Set(currentRows.map(r => r.mo_number).filter((v): v is string => !!v))]
      if (moNumbers.length > 0) {
        const [{ data: prepLogs, error: prepErr }, { data: erpPrepLines }] = await Promise.all([
          supabase.from('argoerp_material_prep_log')
            .select('mo_number, status, logged_at').in('mo_number', moNumbers)
            .order('logged_at', { ascending: false }),
          supabase.from('erp_material_prep_lines').select('mo_number').in('mo_number', moNumbers),
        ])
        if (prepErr) throw prepErr
        const prepMap = new Map<string, '已備料' | '無需備料'>()
        for (const log of (prepLogs ?? [])) {
          if (!prepMap.has(log.mo_number)) prepMap.set(log.mo_number, log.status as '已備料' | '無需備料')
        }
        const erpPrepSet = new Set<string>(
          (erpPrepLines ?? []).map((l: { mo_number: string }) => l.mo_number).filter(Boolean)
        )
        for (let i = 0; i < currentRows.length; i++) {
          const moNo = currentRows[i].mo_number
          if (!moNo) continue
          if (erpPrepSet.has(moNo)) currentRows[i] = { ...currentRows[i], material_prep_status: '已批備料' }
          else if (prepMap.has(moNo)) currentRows[i] = { ...currentRows[i], material_prep_status: prepMap.get(moNo)! }
        }
      }
      const newMo = currentRows.filter((r, i) => r.mo_number && !prevRows[i]?.mo_number).length
      const batchPrepCount = currentRows.filter(r => r.material_prep_status === '已批備料').length

      // ── Step 3: 採購單比對（常平 C01510 + 委外 42828690）────
      const hasCRows = currentRows.some(r => r.factory === 'C')
      const hasORows = currentRows.some(r => r.factory === 'O')
      let poMatched = 0
      let oPoMatched = 0
      if (hasCRows || hasORows) {
        setSaveMsg('⏳ 全同步進行中：比對採購單…')
        type AllSyncCandidate = { doc_no: string; sub_no: string; item_code: string | null; qty: number; status: string | null; start_date: string | null; extra: Record<string, unknown> | null; _used: boolean }

        // 常平（C）
        if (hasCRows) {
          const itemCodes = [...new Set(currentRows.filter(r => r.factory === 'C').map(r => r.item_code).filter(Boolean))]
          if (itemCodes.length > 0) {
            const { data: poRows, error: poErr } = await supabase
              .from('erp_pj_sync')
              .select('doc_no, sub_no, item_code, qty, status, start_date, extra')
              .eq('doc_type', '採購單號')
              .in('status', ['OPEN', 'UNSIGNED'])
              .eq('customer_vendor', 'C01510')
              .in('item_code', itemCodes)
              .order('doc_no', { ascending: false })
            if (poErr) throw poErr
            const pool: AllSyncCandidate[] = (poRows ?? []).map(r => ({
              doc_no: r.doc_no, sub_no: r.sub_no, item_code: r.item_code,
              qty: Number(r.qty ?? 0), status: r.status,
              start_date: (r.start_date as string | null) ?? null,
              extra: (r.extra ?? null) as Record<string, unknown> | null, _used: false,
            }))
            currentRows = matchPoRows(currentRows, pool, 'C', selectedDate)
            poMatched = currentRows.filter(r => r.factory === 'C' && r.po_status === 'matched').length
          }
        }

        // 委外（O）— 任意廠商，排除常平 C01510
        if (hasORows) {
          const itemCodesO = [...new Set(currentRows.filter(r => r.factory === 'O').map(r => r.item_code).filter(Boolean))]
          if (itemCodesO.length > 0) {
            const { data: poRowsO, error: poErrO } = await supabase
              .from('erp_pj_sync')
              .select('doc_no, sub_no, item_code, qty, status, start_date, extra')
              .eq('doc_type', '採購單號')
              .in('status', ['OPEN', 'UNSIGNED'])
              .neq('customer_vendor', 'C01510')
              .in('item_code', itemCodesO)
              .order('doc_no', { ascending: false })
            if (poErrO) throw poErrO
            const poolO: AllSyncCandidate[] = (poRowsO ?? []).map(r => ({
              doc_no: r.doc_no, sub_no: r.sub_no, item_code: r.item_code,
              qty: Number(r.qty ?? 0), status: r.status,
              start_date: (r.start_date as string | null) ?? null,
              extra: (r.extra ?? null) as Record<string, unknown> | null, _used: false,
            }))
            currentRows = matchPoRows(currentRows, poolO, 'O', selectedDate)
            oPoMatched = currentRows.filter(r => r.factory === 'O' && r.po_status === 'matched').length
          }
        }
      }

      // ── Step 3b: 委外請購單比對（PR 為輔，採購單優先）────
      let oPrMatched = 0
      if (hasORows) {
        setSaveMsg('⏳ 全同步進行中：比對委外請購單…')
        try {
          currentRows = await matchPrRows(currentRows)
          oPrMatched = currentRows.filter(r => r.factory === 'O' && r.pr_status === 'matched').length
        } catch (prE) {
          console.error('請購單比對失敗（不影響其他結果）：', prE)
        }
      }

      // ── 最終儲存（僅此一次）──────────────────────────────────
      setSheetRows(currentRows)

      // 若 row 原本已分配機台，轉換成 MO 後遷移至 moMachines
      const toMigrate = currentRows.filter(r => r.mo_number && r.machine)
      if (toMigrate.length > 0) {
        const assignments = toMigrate.map(r => ({ mo_number: r.mo_number!, machine: r.machine! }))
        setMoMachines(prev => {
          const next2 = { ...prev }
          for (const a of assignments) if (!next2[a.mo_number]) next2[a.mo_number] = a.machine
          return next2
        })
        await fetch('/api/argoerp/mo-machine-assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignments }),
        }).catch(() => {})
      }

      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: selectedDate, raw_text: currentRawText, rows: currentRows }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      const parts = [
        `序號比對 ${serialMatched}/${currentRows.length}`,
        `製令連結 +${newMo}`,
        batchPrepCount > 0 ? `已批備料 ${batchPrepCount}` : null,
        hasCRows ? `常平採購單 ${poMatched}/${currentRows.filter(r => r.factory === 'C').length}` : null,
        hasORows ? `委外採購單 ${oPoMatched}/${currentRows.filter(r => r.factory === 'O').length}` : null,
        hasORows && oPrMatched > 0 ? `委外請購單 ${oPrMatched}` : null,
      ].filter(Boolean).join('　')
      setSaveMsg(`✅ 全同步完成：${parts}`)
      setTimeout(() => setSaveMsg(''), 8000)
    } catch (e) {
      setSaveMsg(`❌ 全同步失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setSaveMsg(''), 6000)
    } finally {
      setSyncingAll(false)
    }
  }, [sheetRows, selectedDate, currentRawText])

  // ---- 全日期批次比對（跨所有日期重新跑 MO + PO 比對後儲存）----
  const [batchSyncing, setBatchSyncing] = useState(false)
  const [batchProgress, setBatchProgress] = useState<string>('')

  const runBatchAllDatesSync = useCallback(async () => {
    const ok = confirm(
      '⚠️ 全日期批次比對\n\n' +
      '將對所有日期的出單表重新執行 MO 比對 + 採購單比對，並逐張寫回資料庫。\n\n' +
      '建議先完成 ERP 同步頁面的全同步（MO / PO / PR），再執行本操作。\n\n' +
      '確定執行？'
    )
    if (!ok) return
    setBatchSyncing(true)
    setBatchProgress('')
    setSaveMsg('')
    try {
      // 1. 一次抓全部 SO 明細（所有比對的依據）
      const { data: allSoLines, error: soErr } = await supabase
        .from('erp_so_lines')
        .select('project_id, line_no, mbp_part, order_qty_oru, pdl_seq')
      if (soErr) throw soErr
      const soProjectIds = new Set((allSoLines ?? []).map(l => l.project_id))
      const candidateMap = new Map<string, Array<{ line_no: string; pdl_seq: number | null }>>()
      for (const line of (allSoLines ?? [])) {
        const qty = Number(line.order_qty_oru ?? 0)
        const key = `${line.project_id}|${line.mbp_part ?? ''}|${qty}`
        if (!candidateMap.has(key)) candidateMap.set(key, [])
        candidateMap.get(key)!.push({ line_no: String(line.line_no ?? ''), pdl_seq: line.pdl_seq != null ? Number(line.pdl_seq) : null })
      }
      for (const arr of candidateMap.values()) arr.sort((a, b) => (Number(a.line_no) || 0) - (Number(b.line_no) || 0))

      // 2. 一次抓全部 MO 相關資料
      const { data: allMoLogs, error: moErr } = await supabase
        .from('argoerp_mo_upload_log')
        .select('mo_number, source_order, product_code, planned_qty, uploaded_at')
        .order('uploaded_at', { ascending: false })
      if (moErr) throw moErr
      const rawLogMoNumbers = [...new Set(
        (allMoLogs ?? []).map(l => l.mo_number).filter((n): n is string => !!n?.startsWith('MO'))
      )]
      let activeMoNumbers = new Set(rawLogMoNumbers)
      if (rawLogMoNumbers.length > 0) {
        const { data: summaryRows } = await supabase
          .from('argoerp_mo_summary').select('mo_number').in('mo_number', rawLogMoNumbers)
        activeMoNumbers = new Set((summaryRows ?? []).map(r => r.mo_number))
      }
      const moMap = new Map<string, { mo_number: string }>()
      for (const log of (allMoLogs ?? [])) {
        if (!log.mo_number?.startsWith('MO') || !activeMoNumbers.has(log.mo_number)) continue
        const qty = String(log.planned_qty ?? '').trim()
        const k1 = `${log.source_order}|${log.product_code}|${qty}`
        const k2 = `${log.source_order}|${log.product_code}`
        if (!moMap.has(k1)) moMap.set(k1, { mo_number: log.mo_number })
        if (!moMap.has(k2)) moMap.set(k2, { mo_number: log.mo_number })
      }
      const { data: allErpMo, error: erpErr } = await supabase
        .from('erp_mo_lines')
        .select('project_id, source_order, mbp_part, order_qty, line_no')
      if (erpErr) throw erpErr
      const erpMoMap = new Map<string, string>()
      const erpMoBaseMap = new Map<string, string[]>()
      const erpMoBySourceOrder = new Map<string, Set<string>>()
      for (const mo of (allErpMo ?? [])) {
        if (!mo.source_order || !mo.mbp_part || !mo.project_id?.startsWith('MO')) continue
        if (mo.line_no != null) {
          const lineNoStr = String(parseInt(String(mo.line_no), 10)).padStart(2, '0')
          const seqKey = `${mo.source_order}|${mo.mbp_part}|${lineNoStr}`
          if (!erpMoMap.has(seqKey)) erpMoMap.set(seqKey, mo.project_id)
        }
        const baseKey = `${mo.source_order}|${mo.mbp_part}`
        const arr = erpMoBaseMap.get(baseKey) ?? []
        if (!arr.includes(mo.project_id)) erpMoBaseMap.set(baseKey, [...arr, mo.project_id])
        const moSet = erpMoBySourceOrder.get(mo.source_order) ?? new Set<string>()
        moSet.add(mo.project_id)
        erpMoBySourceOrder.set(mo.source_order, moSet)
      }
      const { data: allPrepLogs, error: prepErr } = await supabase
        .from('argoerp_material_prep_log')
        .select('mo_number, status, logged_at')
        .order('logged_at', { ascending: false })
      if (prepErr) throw prepErr
      const prepMap = new Map<string, '已備料' | '無需備料'>()
      for (const log of (allPrepLogs ?? [])) {
        if (!prepMap.has(log.mo_number)) prepMap.set(log.mo_number, log.status as '已備料' | '無需備料')
      }
      const { data: allErpPrep } = await supabase.from('erp_material_prep_lines').select('mo_number')
      const erpPrepSet = new Set<string>((allErpPrep ?? []).map((l: { mo_number: string }) => l.mo_number).filter(Boolean))

      // 3. 一次抓全部 OPEN 採購單 pool（供所有日期比對用）
      type Candidate = { doc_no: string; sub_no: string; item_code: string | null; qty: number; status: string | null; start_date: string | null; extra: Record<string, unknown> | null; _used: boolean }

      // 常平（C01510）
      const { data: allPoRows, error: poErr } = await supabase
        .from('erp_pj_sync')
        .select('doc_no, sub_no, item_code, qty, status, start_date, extra')
        .eq('doc_type', '採購單號')
        .in('status', ['OPEN', 'UNSIGNED'])
        .eq('customer_vendor', 'C01510')
        .order('doc_no', { ascending: false })
      if (poErr) throw poErr
      const globalPoPool: Candidate[] = (allPoRows ?? []).map(r => ({
        doc_no: r.doc_no, sub_no: r.sub_no, item_code: r.item_code,
        qty: Number(r.qty ?? 0), status: r.status ?? null,
        start_date: (r.start_date as string | null) ?? null,
        extra: (r.extra ?? null) as Record<string, unknown> | null, _used: false,
      }))

      // 委外（任意廠商，排除常平 C01510）
      const { data: allPoRowsO, error: poErrO } = await supabase
        .from('erp_pj_sync')
        .select('doc_no, sub_no, item_code, qty, status, start_date, extra')
        .eq('doc_type', '採購單號')
        .in('status', ['OPEN', 'UNSIGNED'])
        .neq('customer_vendor', 'C01510')
        .order('doc_no', { ascending: false })
      if (poErrO) throw poErrO
      const globalPoPoolO: Candidate[] = (allPoRowsO ?? []).map(r => ({
        doc_no: r.doc_no, sub_no: r.sub_no, item_code: r.item_code,
        qty: Number(r.qty ?? 0), status: r.status ?? null,
        start_date: (r.start_date as string | null) ?? null,
        extra: (r.extra ?? null) as Record<string, unknown> | null, _used: false,
      }))

      // 4. 逐張出單表處理
      const { data: allSheets, error: sheetsErr } = await supabase
        .from('daily_order_sheets')
        .select('sheet_date, rows, raw_text')
        .order('sheet_date', { ascending: false })
      if (sheetsErr) throw sheetsErr

      const sheets = allSheets ?? []
      let totalUpdated = 0

      for (let si = 0; si < sheets.length; si++) {
        const sheet = sheets[si]
        const sheetDate = sheet.sheet_date as string
        setBatchProgress(`${sheetDate}（${si + 1} / ${sheets.length}）`)
        let rows: SheetRow[] = Array.isArray(sheet.rows) ? (sheet.rows as SheetRow[]) : []
        if (rows.length === 0) continue

        // Step A: 序號比對
        const orderNumbers = [...new Set(rows.map(r => r.order_number).filter(Boolean))]
        const usageCounter = new Map<string, number>()
        rows = rows.map(src => {
          if (!src.order_number || !soProjectIds.has(src.order_number))
            return { ...src, match_status: 'no_order' as const, match_line_no: null, match_pdl_seq: null, match_reason: '無對應來源單號' }
          const qty = parseFloat(String(src.quantity).replace(/,/g, '')) || 0
          const key = `${src.order_number}|${src.item_code}|${qty}`
          const candidates = candidateMap.get(key) ?? []
          if (candidates.length === 0)
            return { ...src, match_status: 'no_qty_match' as const, match_line_no: null, match_pdl_seq: null, match_reason: '有來源單號但無對應數量' }
          const used = usageCounter.get(key) ?? 0
          const candidate = candidates[Math.min(used, candidates.length - 1)]
          usageCounter.set(key, used + 1)
          return { ...src, match_status: 'matched' as const, match_line_no: candidate.line_no, match_pdl_seq: candidate.pdl_seq, match_reason: '' }
        })

        // Step B: MO 比對
        rows = rows.map(r => {
          const matchSeq = r.match_line_no != null ? String(parseInt(r.match_line_no, 10)).padStart(2, '0') : null
          if (r.mo_number?.startsWith('MO')) {
            const erpMosForOrder = erpMoBySourceOrder.get(r.order_number)
            if (erpMosForOrder && !erpMosForOrder.has(r.mo_number))
              return { ...r, mo_number: undefined, mo_status: null as null, material_prep_status: null as null }
            if (!matchSeq) return r
            const erpConfirm = erpMoMap.get(`${r.order_number}|${r.item_code}|${matchSeq}`)
            if (!erpConfirm || erpConfirm === r.mo_number) return r
            return { ...r, mo_number: erpConfirm, mo_status: '已匯入製令' as const }
          }
          const qty = String(r.quantity).trim()
          if (matchSeq) {
            const erpHit = erpMoMap.get(`${r.order_number}|${r.item_code}|${matchSeq}`)
            if (erpHit) return { ...r, mo_number: erpHit, mo_status: '已匯入製令' as const }
          }
          const logHit = moMap.get(`${r.order_number}|${r.item_code}|${qty}`) ?? moMap.get(`${r.order_number}|${r.item_code}`)
          if (logHit) {
            const erpMosForOrder = erpMoBySourceOrder.get(r.order_number)
            const stillInArgo = !erpMosForOrder || erpMosForOrder.has(logHit.mo_number)
            if (stillInArgo && (!matchSeq || logHit.mo_number.slice(-2) === matchSeq))
              return { ...r, mo_number: logHit.mo_number, mo_status: '已匯入製令' as const }
          }
          const baseHits = erpMoBaseMap.get(`${r.order_number}|${r.item_code}`) ?? []
          if (baseHits.length === 1) return { ...r, mo_number: baseHits[0], mo_status: '已匯入製令' as const }
          if (r.mo_number && !r.mo_number.startsWith('MO'))
            return { ...r, mo_number: undefined, mo_status: null as null, material_prep_status: null as null }
          return r
        })

        // Step B2: 批備料狀態
        for (let i = 0; i < rows.length; i++) {
          const moNo = rows[i].mo_number
          if (!moNo) continue
          if (erpPrepSet.has(moNo)) rows[i] = { ...rows[i], material_prep_status: '已批備料' }
          else if (prepMap.has(moNo)) rows[i] = { ...rows[i], material_prep_status: prepMap.get(moNo)! }
        }

        // Step C: 採購單比對（每張獨立 pool，避免跨日期搶佔）
        // 常平（C）
        const sheetPoPool: Candidate[] = globalPoPool.map(c => ({ ...c, _used: false }))
        if (rows.some(r => r.factory === 'C')) {
          rows = matchPoRows(rows, sheetPoPool, 'C', sheetDate)
        }
        // 委外（O）
        const sheetPoPoolO: Candidate[] = globalPoPoolO.map(c => ({ ...c, _used: false }))
        if (rows.some(r => r.factory === 'O')) {
          rows = matchPoRows(rows, sheetPoPoolO, 'O', sheetDate)
        }

        // Step C2: 委外請購單比對（PR 為輔，採購單優先）
        if (rows.some(r => r.factory === 'O')) {
          try {
            rows = await matchPrRows(rows)
          } catch (prE) {
            console.error(`請購單比對失敗（${sheetDate}，不影響其他結果）：`, prE)
          }
        }

        // Step D: 寫回 DB
        await fetch('/api/argoerp/daily-order-sheet', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheet_date: sheetDate, raw_text: sheet.raw_text ?? '', rows }),
        })
        totalUpdated++

        // 若剛好是目前選取的日期，同步更新頁面 state
        if (sheetDate === selectedDate) setSheetRows(rows)
      }

      setBatchProgress('')
      setSaveMsg(`✅ 批次比對完成，共更新 ${totalUpdated} 張出單表`)
      setTimeout(() => setSaveMsg(''), 8000)
    } catch (e) {
      setBatchProgress('')
      setSaveMsg(`❌ 批次比對失敗：${e instanceof Error ? e.message : String(e)}`)
      setTimeout(() => setSaveMsg(''), 6000)
    } finally {
      setBatchSyncing(false)
    }
  }, [selectedDate])

  // ---- 切換廠別 ----
  // ---- 標記/取消 無須採購（O廠列）----
  const handleConfirmQtyMismatch = useCallback(async (rowKey: string, confirm: boolean) => {
    const next: SheetRow[] = sheetRows.map(r => {
      if ((r.row_key || '') !== rowKey) return r
      if (confirm) return { ...r, po_status: 'matched' as const, po_qty_erp: null, po_confirmed: true }
      return { ...r, po_status: 'no_match' as const, po_number: null, po_sub_no: null, po_qty_erp: null, po_confirmed: false }
    })
    setSheetRows(next)
    setSaving(true)
    try {
      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: selectedDate, raw_text: currentRawText, rows: next }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setSaveMsg(confirm ? '✅ 已確認採購單配對' : '✅ 已取消配對')
      setTimeout(() => setSaveMsg(''), 2000)
    } catch (e) {
      setSaveMsg(`❌ 儲存失敗：${e}`)
    } finally {
      setSaving(false)
    }
  }, [sheetRows, selectedDate, currentRawText])

  const handleToggleNoPo = useCallback(async (rowKey: string) => {
    const next: SheetRow[] = sheetRows.map(r => {
      if ((r.row_key || '') !== rowKey) return r
      const newStatus = r.po_status === 'no_po' ? null : 'no_po' as const
      return { ...r, po_status: newStatus, po_number: newStatus === 'no_po' ? null : r.po_number, po_sub_no: newStatus === 'no_po' ? null : r.po_sub_no }
    })
    setSheetRows(next)
    setSaving(true)
    try {
      const res = await fetch('/api/argoerp/daily-order-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: selectedDate, raw_text: currentRawText, rows: next }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setSaveMsg('✅ 已更新')
      setTimeout(() => setSaveMsg(''), 2000)
    } catch (e) {
      setSaveMsg(`❌ 儲存失敗：${e}`)
    } finally {
      setSaving(false)
    }
  }, [sheetRows, selectedDate, currentRawText])

  const handleChangeFactory = useCallback((idx: number, factory: 'T' | 'C' | 'O') => {
    setSheetRows(prev => prev.map((r, i) => {
      if (i !== idx) return r
      return { ...r, factory, row_key: createRowKey({ ...r, factory }) }
    }))
    setEditFactoryIdx(null)
  }, [])

  const factoryBadge = (f: 'T' | 'C' | 'O', docType?: string) => {
    if ((docType ?? '').includes('集單'))
      return <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-violet-900/40 text-violet-300">集單</span>
    const m = { T: 'bg-blue-900/40 text-blue-300', C: 'bg-orange-900/40 text-orange-300', O: 'bg-purple-900/40 text-purple-300' }
    const l = { T: '台北', C: '常平', O: '委外' }
    return <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${m[f]}`}>{l[f]}</span>
  }

  const hasUnsaved = sheetRows.length > 0 && (rawText.trim() ? true : false)
  const hasData = sheetRows.length > 0

  // 與表格中相同的篩選條件，確保全選只選當前顯示的列
  const visibleRows = sheetRows.filter(r => {
    const isJidan = (r.doc_type ?? '').includes('集單')
    if (activeFactory === 'G') {
      if (!isJidan) return false
    } else if (activeFactory !== 'ALL') {
      if (isJidan) return false
      if (r.factory !== activeFactory) return false
    }
    if (!searchQuery.trim()) return true
    const q = searchQuery.trim().toLowerCase()
    return (r.order_number?.toLowerCase().includes(q)) || (r.mo_number?.toLowerCase().includes(q)) || (r.po_number?.toLowerCase().includes(q))
  })

  const allSelected = visibleRows.length > 0 && visibleRows.every((r, i) => selectedKeys.has(r.row_key || String(i)))
  const toggleAll = () => {
    if (allSelected) setSelectedKeys(new Set())
    else setSelectedKeys(new Set(visibleRows.map((r, i) => r.row_key || String(i))))
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1600px] mx-auto">

        {/* Header */}
        <div className="mb-6 border-b border-slate-800 pb-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">每日出單表</h1>
            <p className="text-slate-400 mt-1 text-sm">貼上每日工單清單 → 儲存 → 在「訂單批量轉製令匯出」頁面選取日期載入</p>
          </div>

          {/* 跨日期單號搜尋 */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="relative">
              <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/>
              </svg>
              <input
                type="text"
                value={globalSearch}
                onChange={e => { setGlobalSearch(e.target.value); if (!e.target.value.trim()) setGlobalResults(null) }}
                onKeyDown={e => e.key === 'Enter' && runGlobalSearch(globalSearch)}
                placeholder="跨日期搜尋單號…"
                className="pl-9 pr-8 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm w-52 focus:outline-none focus:border-cyan-500 placeholder:text-slate-500"
              />
              {globalSearch && (
                <button onClick={() => { setGlobalSearch(''); setGlobalResults(null) }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs">✕</button>
              )}
            </div>
            <button
              onClick={() => runGlobalSearch(globalSearch)}
              disabled={!globalSearch.trim() || globalSearching}
              className="px-3 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm font-medium transition-colors"
            >
              {globalSearching ? '搜尋中…' : '搜尋'}
            </button>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {/* 日期選擇 */}
            <div className="flex items-center gap-2">
              <label className="text-slate-400 text-sm whitespace-nowrap">出單日期</label>
              <input
                type="date"
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-cyan-500"
              />
            </div>
            {/* 全日期批次比對 + 漏單檢測 — 跨所有日期，不需選取特定日 */}
            {availableSheets.length > 0 && (
              <>
                <button
                  onClick={() => void runBatchAllDatesSync()}
                  disabled={batchSyncing || exportingMissing}
                  className="px-4 py-2 rounded-lg bg-violet-900/60 border border-violet-700/50 hover:bg-violet-800 disabled:bg-slate-700 disabled:text-slate-500 disabled:border-slate-600 text-violet-200 text-sm font-medium transition-colors flex items-center gap-1.5"
                  title="對所有日期的出單表重新執行 MO + 採購單比對，並寫回資料庫"
                >
                  <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                  </svg>
                  {batchSyncing ? (batchProgress ? `比對中 ${batchProgress}` : '比對中…') : '🔁 全日期批次比對'}
                </button>
              </>
            )}
            {hasData && (
              <>
                <button
                  onClick={() => void runAllSync()}
                  disabled={syncingAll || saving}
                  className="px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-600 disabled:bg-slate-700 text-white text-sm font-medium transition-colors"
                  title="依序執行：序號比對 → 同步製令/批備料 → 比對採購單，最後儲存一次"
                >
                  {syncingAll ? '全同步中…' : '⚡ 一鍵全同步'}
                </button>
                <button
                  onClick={handleDueDateCheck}
                  className="px-4 py-2 rounded-lg bg-rose-700 hover:bg-rose-600 text-white text-sm font-medium transition-colors"
                  title="檢查目前出單表各廠別訂單是否滿足工作天數要求"
                >
                  📅 交期檢查
                </button>
                <button
                  onClick={() => void handleSaveMachines()}
                  disabled={savingMachine || !machineChanged}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                    machineChanged
                      ? 'bg-yellow-600 hover:bg-yellow-500 text-white'
                      : 'bg-slate-700 text-slate-500 border border-slate-600'
                  } disabled:cursor-not-allowed`}
                  title="將目前所有機台選擇儲存至 Supabase，並重新讀回確認"
                >
                  {savingMachine ? '儲存中…' : `🖥 儲存機台分配${machineChanged ? ' *' : ''}`}
                </button>
                <button
                  onClick={handleExportSheetCsv}
                  disabled={exportingSheetCsv}
                  className="px-4 py-2 rounded-lg bg-indigo-700 hover:bg-indigo-600 disabled:bg-slate-700 text-white text-sm font-medium transition-colors"
                  title="匯出目前日期的出單資料為 CSV"
                >
                  {exportingSheetCsv ? '匯出中…' : `📤 匯出 CSV（${selectedDate || '當日'}）`}
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-700 text-white text-sm font-medium transition-colors"
                >
                  {saving ? '儲存中…' : `💾 更新儲存 (${sheetRows.length} 筆)`}
                </button>
                <button
                  onClick={handlePrint}
                  disabled={selectedKeys.size === 0}
                  className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:bg-slate-800 disabled:text-slate-600 text-white text-sm font-medium transition-colors flex items-center gap-1.5"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" /></svg>
                  列印{selectedKeys.size > 0 ? ` (${selectedKeys.size})` : ''}
                </button>
              </>
            )}
            {saveMsg && (
              <span className={`text-sm ${saveMsg.startsWith('❌') ? 'text-red-400' : 'text-emerald-400'}`}>{saveMsg}</span>
            )}
          </div>
        </div>

        <div>
          {/* ===== 分頁切換 ===== */}
          <div className="mb-5 flex gap-1 border-b border-slate-800">
            <button
              onClick={() => setActiveMainTab('daily')}
              className={`px-5 py-2.5 text-sm font-medium rounded-t-lg transition-colors border-b-2 ${
                activeMainTab === 'daily'
                  ? 'border-cyan-500 text-cyan-300 bg-slate-900'
                  : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
              }`}
            >
              📋 每日出單表
            </button>
            <button
              onClick={() => setActiveMainTab('c-orders')}
              className={`px-5 py-2.5 text-sm font-medium rounded-t-lg transition-colors border-b-2 ${
                activeMainTab === 'c-orders'
                  ? 'border-orange-500 text-orange-300 bg-slate-900'
                  : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
              }`}
            >
              🏭 常平廠訂單
              {pinnedCOrderKeys.size > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-orange-500 text-white text-[10px] font-bold leading-none">{pinnedCOrderKeys.size}</span>
              )}
            </button>
          </div>

          {/* ===== 每日出單表分頁 ===== */}
          {activeMainTab === 'daily' && (<>
          {/* 水平日期列：顯示最近 10 天，超過 10 天以下拉選單呈現 */}
          {availableSheets.length > 0 && (() => {
            const recentSheets = availableSheets.slice(0, 10)
            const olderSheets = availableSheets.slice(10)
            return (
              <div className="mb-4 flex gap-2 flex-wrap items-center">
                {recentSheets.map(s => (
                  <button
                    key={s.sheet_date}
                    onClick={() => setSelectedDate(s.sheet_date)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${
                      s.sheet_date === selectedDate
                        ? 'bg-cyan-700 text-white border-cyan-600'
                        : 'bg-slate-900 text-slate-300 border-slate-700 hover:bg-slate-800'
                    }`}
                  >
                    {s.sheet_date} <span className="opacity-60">{s.row_count}筆</span>
                  </button>
                ))}
                {olderSheets.length > 0 && (
                  <select
                    value={olderSheets.some(s => s.sheet_date === selectedDate) ? selectedDate : ''}
                    onChange={e => { if (e.target.value) setSelectedDate(e.target.value) }}
                    className={`px-2 py-1.5 rounded-lg text-xs font-medium transition-colors border focus:outline-none focus:border-cyan-500 ${
                      olderSheets.some(s => s.sheet_date === selectedDate)
                        ? 'bg-cyan-700 text-white border-cyan-600'
                        : 'bg-slate-900 text-slate-400 border-slate-700 hover:bg-slate-800'
                    }`}
                  >
                    <option value="">更早的日期…</option>
                    {olderSheets.map(s => (
                      <option key={s.sheet_date} value={s.sheet_date}>{s.sheet_date}（{s.row_count}筆）</option>
                    ))}
                  </select>
                )}
              </div>
            )
          })()}

          {/* 跨日期搜尋結果 */}
          {(globalResults !== null) && (
            <div className="mb-4 bg-slate-900 border border-cyan-800/50 rounded-lg overflow-hidden">
              <div className="px-4 py-2.5 bg-cyan-900/20 border-b border-cyan-800/30 flex items-center justify-between">
                <span className="text-sm font-semibold text-cyan-300">
                  {globalSearching ? '搜尋中…' : globalResults.length === 0
                    ? `找不到符合「${globalSearch}」的工單`
                    : `「${globalSearch}」搜尋結果（${globalResults.reduce((n, r) => n + r.rows.length, 0)} 筆，共 ${globalResults.length} 個日期）`
                  }
                </span>
                <button onClick={() => setGlobalResults(null)} className="text-slate-500 hover:text-slate-300 text-xs">✕ 關閉</button>
              </div>
              {globalResults.length > 0 && (
                <div className="divide-y divide-slate-800">
                  {globalResults.map(group => (
                    <div key={group.sheet_date} className="px-4 py-3">
                      <button
                        onClick={() => { setSelectedDate(group.sheet_date); setGlobalResults(null); setGlobalSearch('') }}
                        className="text-xs font-semibold text-cyan-400 hover:text-cyan-200 underline underline-offset-2 mb-2 inline-block"
                      >
                        📅 {group.sheet_date}（{group.rows.length} 筆）→ 跳至此日
                      </button>
                      <div className="flex flex-col gap-1">
                        {group.rows.map((row, i) => (
                          <div key={i} className="flex flex-wrap items-center gap-2 text-xs bg-slate-950/60 rounded px-3 py-1.5">
                            <span className="font-mono text-cyan-300">{row.order_number}</span>
                            {row.mo_number && <span className="font-mono text-emerald-300">{row.mo_number}</span>}
                            {{T: <span className="px-1.5 py-0.5 rounded bg-blue-900/40 text-blue-300">台北</span>,
                              C: <span className="px-1.5 py-0.5 rounded bg-orange-900/40 text-orange-300">常平</span>,
                              O: <span className="px-1.5 py-0.5 rounded bg-purple-900/40 text-purple-300">委外</span>}[row.factory]}
                            <span className="text-purple-300 font-mono">{row.item_code}</span>
                            <span className="text-slate-400 truncate max-w-[220px]">{row.item_name}</span>
                            <span className="text-slate-500 ml-auto">{row.delivery_date}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 主內容 */}
          <div className="min-w-0">
            {/* 貼上區 */}
            {(showPasteArea || (!hasData && !loading)) && (
              <div className="mb-6 bg-slate-900 border border-slate-800 rounded-lg p-4">
                <h2 className="text-lg font-semibold text-white mb-2">
                  📋 貼上 {selectedDate} 的工單資料
                </h2>
                <p className="text-xs text-slate-500 mb-3">
                  從 Excel / Google Sheet 複製工單表格後貼上（Tab 分隔）。儲存後可在「訂單批量轉製令匯出」頁面選取此日期載入。
                </p>
                <div className="mb-2 flex items-center gap-2">
                  <button
                    onClick={() => setRawEditorMode('excel')}
                    className={`px-3 py-1.5 rounded text-xs border ${rawEditorMode === 'excel' ? 'bg-cyan-700 border-cyan-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'}`}
                  >
                    Excel 格式
                  </button>
                  <button
                    onClick={() => setRawEditorMode('text')}
                    className={`px-3 py-1.5 rounded text-xs border ${rawEditorMode === 'text' ? 'bg-cyan-700 border-cyan-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'}`}
                  >
                    純文字
                  </button>
                </div>

                {rawEditorMode === 'text' ? (
                  <textarea
                    value={rawText}
                    onChange={e => setRawText(e.target.value)}
                    placeholder="從 Excel 複製工單表格後貼上此處..."
                    className="w-full h-44 bg-slate-950 border border-slate-700 rounded-lg p-3 text-sm text-slate-200 font-mono resize-y focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30 placeholder:text-slate-600"
                  />
                ) : (
                  <div className="border border-slate-700 rounded-lg bg-slate-950 overflow-auto max-h-[420px]">
                    {rawGrid.length === 0 ? (
                      <div className="p-4 text-xs text-slate-500">先貼上資料，這裡會以 Excel 表格方式顯示，可直接修正儲存格內容。</div>
                    ) : (
                      <table className="min-w-full border-collapse text-xs">
                        <thead className="sticky top-0 bg-slate-900 z-10">
                          <tr>
                            <th className="px-2 py-1 border-b border-slate-700 text-slate-400">#</th>
                            {Array.from({ length: rawGrid.reduce((m, r) => Math.max(m, r.length), 0) }).map((_, ci) => (
                              <th key={`col-${ci}`} className="px-2 py-1 border-b border-slate-700 text-slate-400 min-w-[120px]">欄位 {ci + 1}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rawGrid.map((row, ri) => {
                            const maxCols = rawGrid.reduce((m, r) => Math.max(m, r.length), 0)
                            return (
                              <tr key={`raw-row-${ri}`} className="border-b border-slate-800/60">
                                <td className="px-2 py-1 align-top text-slate-500">{ri + 1}</td>
                                {Array.from({ length: maxCols }).map((_, ci) => (
                                  <td key={`raw-cell-${ri}-${ci}`} className="px-1 py-1 align-top">
                                    <input
                                      value={row[ci] ?? ''}
                                      onChange={(e) => {
                                        const next = rawGrid.map(r => [...r])
                                        if (!next[ri]) next[ri] = []
                                        next[ri][ci] = e.target.value
                                        setRawGrid(next)
                                        setRawText(rowsToTsv(next))
                                      }}
                                      className="w-full bg-slate-900 border border-slate-700 rounded px-1.5 py-1 text-slate-200 focus:outline-none focus:border-cyan-500"
                                    />
                                  </td>
                                ))}
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
                {parseError && (
                  <p className="mt-2 text-red-400 text-sm">{parseError}</p>
                )}
                {parseWarnings.length > 0 && (
                  <div className="mt-2 p-3 rounded-lg bg-amber-900/30 border border-amber-700/50">
                    <p className="text-amber-300 text-sm font-semibold mb-1">⚠ 發現重複的訂單號＋序號組合（{parseWarnings.length} 筆），請確認來源資料：</p>
                    <ul className="text-amber-400 text-xs space-y-0.5">
                      {parseWarnings.map((w, i) => <li key={i}>• {w}</li>)}
                    </ul>
                  </div>
                )}
                <div className="mt-3 flex gap-2 flex-wrap">
                  <button
                    onClick={handleParse}
                    disabled={!rawText.trim()}
                    className="px-5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium text-sm"
                  >
                    解析資料
                  </button>
                  <button
                    onClick={() => setRawText('')}
                    className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-white text-sm"
                  >
                    清除
                  </button>
                  {hasData && (
                    <button
                      onClick={() => setShowPasteArea(false)}
                      className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-white text-sm"
                    >
                      取消
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* 載入中 */}
            {loading && (
              <div className="flex items-center justify-center py-20 text-slate-500">
                <svg className="animate-spin w-6 h-6 mr-2" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                載入中…
              </div>
            )}

            {/* 解析後未儲存提示 */}
            {!loading && sheetRows.length > 0 && (
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-slate-300 text-sm font-medium">共 <span className="text-cyan-300 font-bold">{sheetRows.length}</span> 筆</span>
                  <span className="text-xs text-slate-500">
                    已匯入製令：<span className="text-emerald-400">{sheetRows.filter(r => r.mo_status === '已匯入製令').length}</span>
                    ／暫緩區：<span className="text-amber-400">{sheetRows.filter(r => r.mo_status === '暫緩區').length}</span>
                    ／尚未轉單：<span className="text-slate-400">{sheetRows.filter(r => !r.mo_status).length}</span>
                    {sheetRows.some(r => (r.doc_type ?? '').includes('集單')) && (
                      <span className="ml-2 text-violet-400">
                        ／集單：{sheetRows.filter(r => (r.doc_type ?? '').includes('集單')).length}
                      </span>
                    )}
                  </span>
                </div>
                {!showPasteArea && currentRawText && (
                  <button
                    onClick={() => { setRawText(currentRawText); setRawEditorMode('excel'); setShowPasteArea(true) }}
                    className="text-xs text-slate-400 hover:text-slate-200 underline"
                  >
                    查看原始資料
                  </button>
                )}
              </div>
            )}

            {/* 廠別快速標籤 */}
            {!loading && sheetRows.length > 0 && (
              <div className="mb-3 flex items-center gap-1 flex-wrap">
                {(['ALL', 'T', 'C', 'O', 'G'] as const).map(f => {
                  const count = f === 'ALL'
                    ? sheetRows.length
                    : f === 'G'
                    ? sheetRows.filter(r => (r.doc_type ?? '').includes('集單')).length
                    : sheetRows.filter(r => r.factory === f && !(r.doc_type ?? '').includes('集單')).length
                  if (f !== 'ALL' && count === 0) return null
                  const label = f === 'ALL' ? '全部' : f === 'T' ? '台北' : f === 'C' ? '常平' : f === 'O' ? '委外' : '集單'
                  const colors = f === 'ALL'
                    ? 'bg-slate-700 text-slate-200 border-slate-600'
                    : f === 'T' ? 'bg-cyan-900/60 text-cyan-200 border-cyan-700/60'
                    : f === 'C' ? 'bg-orange-900/60 text-orange-200 border-orange-700/60'
                    : f === 'O' ? 'bg-purple-900/60 text-purple-200 border-purple-700/60'
                    : 'bg-violet-900/60 text-violet-200 border-violet-700/60'
                  const activeColors = f === 'ALL'
                    ? 'bg-slate-500 text-white border-slate-400'
                    : f === 'T' ? 'bg-cyan-700 text-white border-cyan-500'
                    : f === 'C' ? 'bg-orange-700 text-white border-orange-500'
                    : f === 'O' ? 'bg-purple-700 text-white border-purple-500'
                    : 'bg-violet-700 text-white border-violet-500'
                  return (
                    <button
                      key={f}
                      onClick={() => setActiveFactory(f)}
                      className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                        activeFactory === f ? activeColors : colors + ' hover:opacity-80'
                      }`}
                    >
                      {label}
                      <span className="ml-1.5 opacity-75">{count}</span>
                    </button>
                  )
                })}
              </div>
            )}

            {/* 搜尋列 */}
            {!loading && sheetRows.length > 0 && (
              <div className="mb-3 flex items-center gap-2">
                <div className="relative">
                  <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/></svg>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="搜尋工單 / 製令/採購單號…"
                    className="pl-8 pr-8 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm w-56 focus:outline-none focus:border-cyan-500/70 placeholder:text-slate-600"
                  />
                  {searchQuery && (
                    <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-xs">✕</button>
                  )}
                </div>
                {searchQuery && (
                  <span className="text-xs text-slate-400">找到 <span className="text-cyan-300 font-bold">{sheetRows.filter(r => {
                    const q = searchQuery.trim().toLowerCase()
                    return (r.order_number?.toLowerCase().includes(q)) || (r.mo_number?.toLowerCase().includes(q)) || (r.po_number?.toLowerCase().includes(q))
                  }).length}</span> 筆</span>
                )}
              </div>
            )}

            {/* 資料表格 */}
            {!loading && sheetRows.length > 0 && (
              <>
                {/* 未儲存提示 */}
                {rawText && sheetRows.length > 0 && (
                  <div className="mb-3 px-4 py-2 rounded-lg bg-yellow-900/30 border border-yellow-700/50 text-yellow-300 text-sm flex items-center justify-between">
                    <span>⚠️ 資料已解析但尚未儲存，請點「更新儲存」</span>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs"
                    >
                      {saving ? '儲存中…' : '立即儲存'}
                    </button>
                  </div>
                )}
                <div className="overflow-x-auto rounded-lg border border-slate-800">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-900 text-slate-400 uppercase text-[11px]">
                        <th className="px-2 py-2 border-b border-slate-800 w-8 text-center">
                          <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-cyan-500 cursor-pointer" />
                        </th>
                        <th className="px-3 py-2 border-b border-slate-800 w-8">#</th>
                        <th className="px-3 py-2 border-b border-slate-800 text-cyan-400">工單 / 廠別</th>
                        <th className="px-3 py-2 border-b border-slate-800">序號</th>
                        <th className="px-3 py-2 border-b border-slate-800 text-purple-300 min-w-[280px]">品項編碼 / 品名規格</th>
                        <th className="px-3 py-2 border-b border-slate-800">數量</th>
                        <th className="px-3 py-2 border-b border-slate-800 text-yellow-400">盤數</th>
                        <th className="px-3 py-2 border-b border-slate-800">客戶</th>
                        <th className="px-3 py-2 border-b border-slate-800">交付日</th>
                        <th className="px-3 py-2 border-b border-slate-800">製令/採購單號</th>
                        <th className="px-3 py-2 border-b border-slate-800">批備料</th>
                        <th className="px-3 py-2 border-b border-slate-800 whitespace-nowrap">打樣/追加單號</th>
                        <th className="px-3 py-2 border-b border-slate-800">機台</th>
                        <th className="px-3 py-2 border-b border-slate-800 w-20">狀態</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((row, idx) => {
                        const effectiveStatus = row.mo_status ?? ((row.factory === 'C' || row.factory === 'O') && row.po_status === 'matched' ? '已匯入採單' : null)
                        const statusInfo = effectiveStatus ? STATUS_LABELS[effectiveStatus] : null
                        const sk = row.row_key || String(idx)
                        const outsourcedDocNo = row.factory === 'O'
                          ? (((row.po_status === 'matched' || row.po_status === 'qty_mismatch') && row.po_number)
                            ? row.po_number
                            : row.mo_number)
                          : null
                        const outsourcedPrefix = getOutsourcePrefix(outsourcedDocNo)
                        const outsourcedStyles = getOutsourcePrefixStyles(outsourcedPrefix)
                        return (
                          <tr
                            key={`${row.row_key || 'row'}::${idx}`}
                            className={`border-b border-slate-800/60 transition-colors ${
                              row.mo_status === '已匯入製令'
                                ? 'bg-emerald-950/20'
                                : row.mo_status === '暫緩區'
                                ? 'bg-amber-950/20'
                                : row.factory === 'C' && row.po_status === 'matched'
                                ? 'bg-orange-950/20'
                                : row.factory === 'O' && (row.po_status === 'matched' || row.mo_number)
                                ? outsourcedStyles.rowBg
                                : row.factory === 'O' && row.po_status === 'no_po'
                                ? 'bg-slate-900/60'
                                : 'hover:bg-slate-900/50'
                            }`}
                          >
                            <td className="px-2 py-2 text-center">
                              <input
                                type="checkbox"
                                checked={selectedKeys.has(sk)}
                                onChange={() => setSelectedKeys(prev => {
                                  const next = new Set(prev)
                                  next.has(sk) ? next.delete(sk) : next.add(sk)
                                  return next
                                })}
                                className="accent-cyan-500 cursor-pointer"
                              />
                            </td>
                            <td className="px-3 py-2 text-slate-600">{idx + 1}</td>
                            <td className="px-3 py-2">
                              <button
                                onClick={() => setSoModalId(row.order_number)}
                                className="font-mono text-cyan-300 whitespace-nowrap hover:text-cyan-100 hover:underline underline-offset-2 text-left"
                              >
                                {row.order_number}
                              </button>
                              <div className="mt-0.5">
                                {editFactoryIdx === idx ? (
                                  <div className="flex gap-1">
                                    {(['T', 'C', 'O'] as const).map(f => (
                                      <button key={f} onClick={() => handleChangeFactory(idx, f)}
                                        className={`px-2 py-0.5 rounded text-xs border ${row.factory === f ? 'bg-cyan-700 text-white border-cyan-600' : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'}`}>
                                        {f === 'T' ? '台北' : f === 'C' ? '常平' : '委外'}
                                      </button>
                                    ))}
                                    <button onClick={() => setEditFactoryIdx(null)} className="px-2 py-0.5 rounded text-xs bg-slate-800 text-slate-400 border border-slate-700">✕</button>
                                  </div>
                                ) : (
                                  <button onClick={() => setEditFactoryIdx(idx)}>
                                    {factoryBadge(row.factory, row.doc_type)}
                                  </button>
                                )}
                              </div>
                              <div className="text-slate-500 text-[10px] mt-0.5">{row.doc_type}</div>
                            </td>
                            <td className="px-3 py-2">
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
                            <td className="px-3 py-2">
                              <div className="font-mono text-purple-300">{row.item_code}</div>
                              <div className="text-slate-200 text-[10px] mt-0.5 max-w-[320px] truncate" title={row.item_name}>{row.item_name}</div>
                            </td>
                            <td className="px-3 py-2 text-slate-300 text-right">{row.quantity}</td>
                            <td className="px-3 py-2 text-yellow-400 text-center font-mono font-semibold">{row.plate_count || '—'}</td>
                            <td className="px-3 py-2 text-slate-400 w-[110px] whitespace-normal break-words leading-snug">{row.customer}</td>
                            <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{row.delivery_date}</td>
                            <td className="px-3 py-2 font-mono text-xs">
                              {(row.factory === 'C' || row.factory === 'O') ? (
                                row.po_status === 'matched' && row.po_number ? (
                                  <div>
                                    <button
                                      onClick={() => setPoModalId(row.po_number!)}
                                      className={`hover:underline underline-offset-2 text-left ${row.factory === 'C' ? 'text-orange-300 hover:text-orange-100' : outsourcedStyles.text}`}
                                    >{row.po_number}</button>
                                    {row.po_sub_no && <span className="text-slate-500 ml-1">#{row.po_sub_no}</span>}
                                    {row.factory === 'O' && outsourcedPrefix && (
                                      <span className={`ml-1 px-1.5 py-0.5 rounded border text-[10px] ${outsourcedStyles.badge}`}>{outsourcedPrefix}</span>
                                    )}
                                  </div>
                                ) : row.po_status === 'qty_mismatch' && row.po_number ? (
                                  <div>
                                    <button
                                      onClick={() => setPoModalId(row.po_number!)}
                                      className={`${row.factory === 'O' ? outsourcedStyles.text : 'text-amber-300 hover:text-amber-100'} hover:underline underline-offset-2 text-left`}
                                    >{row.po_number}</button>
                                    {row.po_sub_no && <span className="text-slate-500 ml-1">#{row.po_sub_no}</span>}
                                    {row.factory === 'O' && outsourcedPrefix && (
                                      <span className={`ml-1 px-1.5 py-0.5 rounded border text-[10px] ${outsourcedStyles.badge}`}>{outsourcedPrefix}</span>
                                    )}
                                    <div className="mt-1 px-1.5 py-0.5 rounded border text-[10px] bg-amber-950/40 text-amber-300 border-amber-700/50 inline-block">
                                      ⚠ 數量不符 ERP:{row.po_qty_erp ?? '?'} / 出單:{row.quantity}
                                    </div>
                                    <div className="mt-1 flex gap-1">
                                      <button
                                        onClick={() => void handleConfirmQtyMismatch(sk, true)}
                                        className="px-1.5 py-0.5 rounded border text-[10px] bg-emerald-900/40 text-emerald-300 border-emerald-700/50 hover:bg-emerald-800/60 transition-colors"
                                      >✓ 確認</button>
                                      <button
                                        onClick={() => void handleConfirmQtyMismatch(sk, false)}
                                        className="px-1.5 py-0.5 rounded border text-[10px] bg-slate-800 text-slate-400 border-slate-600 hover:bg-slate-700 transition-colors"
                                      >✕ 取消</button>
                                    </div>
                                  </div>
                                ) : row.po_status === 'no_po' ? (
                                  <div className="flex items-center gap-1.5">
                                    <span className="px-1.5 py-0.5 rounded border text-[10px] bg-slate-800 text-slate-400 border-slate-600">無須採購</span>
                                    {row.factory === 'O' && (
                                      <button
                                        onClick={() => void handleToggleNoPo(sk)}
                                        className="text-[10px] text-slate-500 hover:text-amber-400 transition-colors"
                                        title="取消無須採購"
                                      >↺撤销</button>
                                    )}
                                  </div>
                                ) : row.po_status === 'no_match' ? (
                                  <div>
                                    <span className="text-red-400 text-[10px]">無對應採購單</span>
                                    {row.factory === 'O' && (
                                      <div className="mt-1">
                                        <button
                                          onClick={() => void handleToggleNoPo(sk)}
                                          className="px-1.5 py-0.5 rounded border text-[10px] bg-slate-800 text-slate-400 border-slate-600 hover:bg-slate-700 hover:text-slate-200 transition-colors"
                                        >無須採購</button>
                                      </div>
                                    )}
                                  </div>
                                ) : row.mo_number ? (
                                  <div>
                                    <span className={row.factory === 'O' ? outsourcedStyles.text : 'text-violet-300'}>{row.mo_number}</span>
                                    {row.factory === 'O' && outsourcedPrefix && (
                                      <span className={`ml-1 px-1.5 py-0.5 rounded border text-[10px] ${outsourcedStyles.badge}`}>{outsourcedPrefix}</span>
                                    )}
                                    {row.factory === 'O' && (
                                      <div className="mt-1">
                                        <button
                                          onClick={() => void handleToggleNoPo(sk)}
                                          className="px-1.5 py-0.5 rounded border text-[10px] bg-slate-800 text-slate-400 border-slate-600 hover:bg-slate-700 hover:text-slate-200 transition-colors"
                                        >無須採購</button>
                                      </div>
                                    )}
                                  </div>
                                ) : (
                                  <div>
                                    <span className="text-slate-600">—</span>
                                    {row.factory === 'O' && (
                                      <div className="mt-1">
                                        <button
                                          onClick={() => void handleToggleNoPo(sk)}
                                          className="px-1.5 py-0.5 rounded border text-[10px] bg-slate-800 text-slate-400 border-slate-600 hover:bg-slate-700 hover:text-slate-200 transition-colors"
                                        >無須採購</button>
                                      </div>
                                    )}
                                  </div>
                                )
                              ) : row.mo_number ? (
                                <span className="text-violet-300">{row.mo_number}</span>
                              ) : (
                                <span className="text-slate-600">—</span>
                              )}
                              {row.factory === 'O' && row.pr_status === 'matched' && row.pr_number && (
                                <div className="mt-1 text-[10px] text-sky-400/80" title="同步區請購單（採購單優先，請購為輔）">
                                  請購 {row.pr_number}{row.pr_sub_no && <span className="text-slate-500">#{row.pr_sub_no}</span>}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              {row.material_prep_status === '已批備料' ? (
                                <div>
                                  <span className="px-2 py-0.5 rounded border text-xs bg-teal-900/40 text-teal-300 border-teal-700/50">已批備料</span>
                                  {row.argo_slip_no && (
                                    <div className="font-mono text-[10px] text-teal-400/70 mt-0.5">{row.argo_slip_no}</div>
                                  )}
                                </div>
                              ) : row.material_prep_status === '已備料' ? (
                                <div>
                                  <span className="px-2 py-0.5 rounded border text-xs bg-emerald-900/40 text-emerald-300 border-emerald-700/50">已備料</span>
                                  {row.argo_slip_no && (
                                    <div className="font-mono text-[10px] text-emerald-400/70 mt-0.5">{row.argo_slip_no}</div>
                                  )}
                                </div>
                              ) : row.material_prep_status === '無需備料' ? (
                                <span className="px-2 py-0.5 rounded border text-xs bg-slate-800 text-slate-400 border-slate-700">無需備料</span>
                              ) : (
                                <span className="text-slate-600 text-xs">—</span>
                              )}
                            </td>
                            <td className="px-2 py-2">
                              <div className="flex items-center gap-1">
                                <input
                                  type="text"
                                  value={sampleRefInputs[sk] ?? ''}
                                  onChange={e => setSampleRefInputs(prev => ({ ...prev, [sk]: e.target.value }))}
                                  onKeyDown={e => { if (e.key === 'Enter') void handleLegacyLookup(sampleRefInputs[sk] ?? '') }}
                                  placeholder="RO…"
                                  className="w-28 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-200 text-xs focus:outline-none focus:border-cyan-500/60"
                                />
                                <button
                                  onClick={() => void handleLegacyLookup(sampleRefInputs[sk] ?? '')}
                                  disabled={!sampleRefInputs[sk]?.trim()}
                                  className="px-2 py-1 rounded text-xs bg-slate-700 hover:bg-cyan-700 border border-slate-600 text-slate-300 hover:text-white transition-colors disabled:opacity-30"
                                >
                                  比對
                                </button>
                              </div>
                            </td>
                            <td className="px-2 py-2">
                              {row.mo_number ? (
                                <select
                                  value={moMachines[row.mo_number] || ''}
                                  onChange={e => {
                                    const machine = e.target.value
                                    setMoMachine(row.mo_number!, machine)
                                  }}
                                  className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-cyan-500 min-w-[90px]"
                                >
                                  <option value="">— —</option>
                                  {machines.map(m => <option key={m} value={m}>{m}</option>)}
                                </select>
                              ) : (
                                <select
                                  value={rowMachines[row.row_key] || ''}
                                  onChange={e => {
                                    const machine = e.target.value
                                    setRowMachines(prev => ({ ...prev, [row.row_key]: machine }))
                                    setMachineChanged(true)
                                  }}
                                  className="bg-slate-800 border border-slate-600 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-cyan-500 min-w-[90px]"
                                >
                                  <option value="">— —</option>
                                  {machines.map(m => <option key={m} value={m}>{m}</option>)}
                                </select>
                              )}
                            </td>
                            <td className="px-3 py-2 w-20">
                              {statusInfo ? (
                                <span className={`px-1.5 py-0.5 rounded border text-xs font-medium whitespace-normal leading-snug inline-block ${statusInfo.cls}`}>
                                  {statusInfo.label}
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.5 rounded border border-slate-700 text-slate-500 text-xs whitespace-normal leading-snug inline-block">尚未轉單</span>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* 空白狀態 */}
            {!loading && !hasData && !showPasteArea && (
              <div className="text-center py-20 text-slate-600">
                <div className="text-4xl mb-3">📋</div>
                <p>{selectedDate} 尚無出單表資料</p>
                <button
                  onClick={() => setShowPasteArea(true)}
                  className="mt-4 px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm"
                >
                  + 新增出單表
                </button>
              </div>
            )}

            {/* 空白狀態 */}
            {!loading && !hasData && !showPasteArea && (
              <div className="text-center py-20 text-slate-600">
                <div className="text-4xl mb-3">📋</div>
                <p>{selectedDate} 尚無出單表資料</p>
                <button
                  onClick={() => setShowPasteArea(true)}
                  className="mt-4 px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm"
                >
                  + 新增出單表
                </button>
              </div>
            )}
          </div>
          </>)}

          {/* ===== 常平廠訂單分頁 ===== */}
          {activeMainTab === 'c-orders' && (
            <div>
              {/* 工具列 */}
              <div className="mb-4 flex flex-wrap gap-3 items-center">
                <div className="relative flex-1 min-w-[200px] max-w-sm">
                  <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/>
                  </svg>
                  <input
                    type="text"
                    value={cOrdersSearch}
                    onChange={e => setCOrdersSearch(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && fetchCOrders()}
                    placeholder="搜尋採購單號 / 料號 / 品名…"
                    className="w-full pl-9 pr-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-white text-sm focus:outline-none focus:border-orange-500 placeholder:text-slate-500"
                  />
                </div>
                <select
                  value={cOrdersStatusFilter}
                  onChange={e => setCOrdersStatusFilter(e.target.value)}
                  className="bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-orange-500"
                >
                  <option value="">全部狀態</option>
                  <option value="OPEN">OPEN</option>
                  <option value="CLOSED">CLOSED</option>
                  <option value="CANCEL">CANCEL</option>
                </select>
                <button
                  onClick={() => fetchCOrders()}
                  disabled={cOrdersLoading}
                  className="px-4 py-2 rounded-lg bg-orange-700 hover:bg-orange-600 disabled:bg-slate-700 text-white text-sm font-medium transition-colors"
                >
                  {cOrdersLoading ? '載入中…' : '🔄 重新載入'}
                </button>
                <span className="text-slate-500 text-xs ml-auto">{cOrders.length} 筆</span>
              </div>

              {/* 表格 */}
              {cOrdersLoading ? (
                <div className="text-center py-20 text-slate-500">載入中…</div>
              ) : cOrders.length === 0 ? (
                <div className="text-center py-20 text-slate-600">
                  <div className="text-4xl mb-3">📦</div>
                  <p>找不到常平廠（C01510）採購訂單</p>
                </div>
              ) : (
                <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-800/80 text-slate-400 text-[11px] uppercase tracking-wider">
                          <th className="px-3 py-2.5 whitespace-nowrap">採購單號</th>
                          <th className="px-3 py-2.5 whitespace-nowrap">行號</th>
                          <th className="px-3 py-2.5 whitespace-nowrap">銷售訂單</th>
                          <th className="px-3 py-2.5 whitespace-nowrap">料號</th>
                          <th className="px-3 py-2.5 whitespace-nowrap">品名 / 規格</th>
                          <th className="px-3 py-2.5 whitespace-nowrap text-right">數量</th>
                          <th className="px-3 py-2.5 whitespace-nowrap">單位</th>
                          <th className="px-3 py-2.5 whitespace-nowrap">開始日</th>
                          <th className="px-3 py-2.5 whitespace-nowrap">交期</th>
                          <th className="px-3 py-2.5 whitespace-nowrap">狀態</th>
                          <th className="px-3 py-2.5 whitespace-nowrap">備註</th>
                          <th className="px-3 py-2.5 whitespace-nowrap"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/60">
                        {sortedCOrders.map((r, i) => {
                          const rowKey = `${r.doc_no}|${r.sub_no}`
                          const isPinned = pinnedCOrderKeys.has(rowKey)
                          const statusCls = r.status === 'OPEN'
                            ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50'
                            : r.status === 'CLOSED'
                              ? 'bg-slate-800 text-slate-400 border-slate-600'
                              : 'bg-red-900/30 text-red-400 border-red-700/50'
                          return (
                            <tr key={r.id} className={`hover:bg-slate-800/40 ${isPinned ? 'bg-orange-950/30 border-l-2 border-orange-600/60' : i % 2 === 0 ? '' : 'bg-slate-900/30'}`}>
                              <td className="px-3 py-2 font-mono text-cyan-300 whitespace-nowrap">{r.doc_no}</td>
                              <td className="px-3 py-2 font-mono text-slate-400 whitespace-nowrap">{r.sub_no}</td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                {r.extra?.MBP_LOT_NO ? (
                                  <button
                                    onClick={() => setSoModalId(String(r.extra!.MBP_LOT_NO))}
                                    className="font-mono text-amber-300 hover:text-amber-200 hover:underline text-xs"
                                  >{String(r.extra.MBP_LOT_NO)}</button>
                                ) : <span className="text-slate-600">—</span>}
                              </td>
                              <td className="px-3 py-2 font-mono text-purple-300 whitespace-nowrap">{r.item_code ?? '—'}</td>
                              <td className="px-3 py-2 text-slate-200 max-w-[280px]">
                                <div className="truncate" title={r.description ?? ''}>{r.description ?? '—'}</div>
                              </td>
                              <td className="px-3 py-2 text-right font-mono text-emerald-300 whitespace-nowrap">
                                {typeof r.qty === 'number' ? r.qty.toLocaleString() : r.qty}
                              </td>
                              <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{r.unit ?? '—'}</td>
                              <td className="px-3 py-2 text-slate-400 whitespace-nowrap font-mono text-[11px]">{r.start_date ?? '—'}</td>
                              <td className="px-3 py-2 text-slate-300 whitespace-nowrap font-mono text-[11px]">{r.end_date ?? '—'}</td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                {r.status ? (
                                  <span className={`px-2 py-0.5 rounded border text-[10px] font-medium ${statusCls}`}>{r.status}</span>
                                ) : <span className="text-slate-600">—</span>}
                              </td>
                              <td className="px-3 py-2 text-slate-400 max-w-[160px]">
                                <div className="truncate" title={r.remark ?? ''}>{r.remark ?? '—'}</div>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                <button
                                  onClick={() => togglePinCOrder(rowKey)}
                                  className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                                    isPinned
                                      ? 'bg-orange-600 hover:bg-orange-500 text-white'
                                      : 'bg-slate-700 hover:bg-orange-700 text-slate-300 hover:text-white'
                                  }`}
                                >
                                  {isPinned ? '★ 已頂置' : '轉四川'}
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <SoOrderModal projectId={soModalId} onClose={() => setSoModalId(null)} />
      <PoOrderModal docNo={poModalId} onClose={() => setPoModalId(null)} />

      {/* 交期檢查 Modal */}
      {dueDateModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setDueDateModal(null)}
        >
          <div
            className="bg-slate-900 border border-red-700/50 rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[80vh]"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between shrink-0">
              <h2 className="text-lg font-bold text-red-300">⚠ 交期異常（{dueDateModal.length} 筆）</h2>
              <button
                onClick={() => setDueDateModal(null)}
                className="text-slate-500 hover:text-white transition-colors text-xl leading-none"
              >✕</button>
            </div>

            {/* Body */}
            <div className="overflow-y-auto flex-1 p-4">
              <div className="bg-slate-950 rounded-lg p-3 font-mono text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">
                {dueDateModal.map(a =>
                  `訂單號:${a.order_number}(${FACTORY_LABEL_ZH[a.factory] ?? a.factory})\n客戶:${a.customer}\n交期:${a.delivery_date} 數量:${a.quantity}\n品項:${a.item_code}\n異常原因:${a.reason}`
                ).join('\n\n')}
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 py-3 border-t border-slate-700 shrink-0 flex items-center gap-3">
              <button
                onClick={() => {
                  const text = dueDateModal.map(a =>
                    `訂單號:${a.order_number}(${FACTORY_LABEL_ZH[a.factory] ?? a.factory})\n客戶:${a.customer}\n交期:${a.delivery_date} 數量:${a.quantity}\n品項:${a.item_code}\n異常原因:${a.reason}`
                  ).join('\n\n')
                  void navigator.clipboard.writeText(text).then(() => {
                    setDueDateCopied(true)
                    setTimeout(() => setDueDateCopied(false), 2000)
                  })
                }}
                className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 text-white text-sm font-medium transition-colors"
              >
                {dueDateCopied ? '✅ 已複製' : '📋 一鍵複製'}
              </button>
              <button
                onClick={() => setDueDateModal(null)}
                className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-300 text-sm transition-colors"
              >
                關閉
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 入庫比對 + 塔台報工 Modal */}
      {legacyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => setLegacyModal(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between shrink-0">
              <div>
                <h2 className="text-white font-semibold">入庫比對</h2>
                <p className="text-slate-400 text-sm mt-0.5">訂貨單號：<span className="font-mono text-amber-300">{legacyModal.query}</span></p>
              </div>
              <button onClick={() => setLegacyModal(null)} className="text-slate-500 hover:text-white transition-colors text-xl leading-none">✕</button>
            </div>

            {/* Body */}
            <div className="overflow-y-auto flex-1 divide-y divide-slate-800">
              {legacyModal.loading ? (
                <div className="py-16 text-center text-slate-400 text-sm">比對中…</div>
              ) : (
                <>
                  {/* ── 舊系統入庫紀錄 ── */}
                  <div>
                    <div className="px-4 py-2 bg-slate-800/50 text-xs font-semibold text-slate-300 uppercase tracking-wide">
                      舊系統入庫紀錄
                      {legacyModal.rows.length > 0 && (
                        <span className="ml-2 font-normal text-slate-400 normal-case">共 {legacyModal.rows.length} 筆</span>
                      )}
                    </div>
                    {legacyModal.rows.length === 0 ? (
                      <div className="py-6 text-center space-y-1">
                        <p className="text-slate-500 text-xs">未找到舊系統入庫紀錄</p>
                      </div>
                    ) : (
                      <table className="w-full text-xs">
                        <thead className="bg-slate-800/90">
                          <tr className="border-b border-slate-700">
                            <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">日期-號碼</th>
                            <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">訂貨單號</th>
                            <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">出庫工廠</th>
                            <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">承辦人</th>
                            <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">品項名[規格]</th>
                            <th className="px-3 py-2.5 text-right text-slate-300 whitespace-nowrap">良品數</th>
                          </tr>
                        </thead>
                        <tbody>
                          {legacyModal.rows.map((r, i) => (
                            <tr key={i} className={`border-b border-slate-800/40 ${i % 2 === 0 ? 'bg-slate-900/40' : ''}`}>
                              <td className="px-3 py-2 font-mono text-cyan-300 whitespace-nowrap">{r.entry_no}</td>
                              <td className="px-3 py-2 font-mono text-amber-300/80 whitespace-nowrap">{r.order_number}</td>
                              <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{r.source_location}</td>
                              <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{r.handler_name}</td>
                              <td className="px-3 py-2 text-slate-200 max-w-[320px] truncate" title={r.item_name}>{r.item_name}</td>
                              <td className="px-3 py-2 text-right font-mono text-emerald-300 whitespace-nowrap">{r.good_qty.toLocaleString()}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  {/* ── 塔台報工紀錄（印刷站2F）── */}
                  <div>
                    <div className="px-4 py-2 bg-slate-800/50 text-xs font-semibold text-slate-300 uppercase tracking-wide">
                      塔台報工紀錄（印刷站2F）
                      {legacyModal.saraWipRows.length > 0 && (
                        <span className="ml-2 font-normal text-slate-400 normal-case">共 {legacyModal.saraWipRows.length} 筆</span>
                      )}
                    </div>
                    {legacyModal.saraWipRows.length === 0 ? (
                      <div className="py-6 text-center space-y-1">
                        <p className="text-slate-500 text-xs">未找到印刷站2F報工紀錄</p>
                      </div>
                    ) : (
                      <table className="w-full text-xs">
                        <thead className="bg-slate-800/90">
                          <tr className="border-b border-slate-700">
                            <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">站點</th>
                            <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">製程名稱</th>
                            <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">生產料號</th>
                            <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">品名</th>
                            <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">來源單號</th>
                            <th className="px-3 py-2.5 text-right text-slate-300 whitespace-nowrap">回報數量</th>
                            <th className="px-3 py-2.5 text-left text-slate-300 whitespace-nowrap">報工資源</th>
                          </tr>
                        </thead>
                        <tbody>
                          {legacyModal.saraWipRows.map((r, i) => (
                            <tr key={r.work_order} className={`border-b border-slate-800/40 ${i % 2 === 0 ? 'bg-slate-900/40' : ''}`}>
                              <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{r.workcenter_name ?? '—'}</td>
                              <td className="px-3 py-2 text-slate-300 whitespace-nowrap">{r.job_name ?? '—'}</td>
                              <td className="px-3 py-2 font-mono text-slate-400 whitespace-nowrap">{r.product_name ?? '—'}</td>
                              <td className="px-3 py-2 text-slate-200 max-w-[160px] truncate" title={r.product_subname ?? r.product_description ?? ''}>{r.product_subname || r.product_description || '—'}</td>
                              <td className="px-3 py-2 font-mono text-amber-300/80 whitespace-nowrap">{r.doc_nbr ?? '—'}</td>
                              <td className="px-3 py-2 text-right font-mono text-emerald-300 whitespace-nowrap">
                                {r.wip_qty != null ? r.wip_qty.toLocaleString() : '—'}
                              </td>
                              <td className="px-3 py-2 text-slate-400 max-w-[140px] truncate" title={r.report_resources ?? ''}>{r.report_resources ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            {!legacyModal.loading && (
              <div className="px-5 py-3 border-t border-slate-700 shrink-0 flex items-center justify-between">
                <span className="text-slate-400 text-xs">
                  入庫 {legacyModal.rows.length} 筆・報工 {legacyModal.saraWipRows.length} 筆
                </span>
                <button onClick={() => setLegacyModal(null)} className="px-4 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm transition-colors">關閉</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
