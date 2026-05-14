'use client'

/**
 * 共用元件：單一廠別（C 常平 / O 委外）的出單表→採購單匯出/匯入頁面
 * 由 order-batch-export-c/page.tsx 及 order-batch-export-o/page.tsx 分別引用
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../../../lib/supabaseClient'
import SoOrderModal from '../../../../components/SoOrderModal'

// ──────────────────────────────────────────────────────────────────────────────
// 型別
// ──────────────────────────────────────────────────────────────────────────────
interface SourceRow {
  order_number: string
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
  quantity: string
  delivery_date: string
  plate_count: string
  upload_ro: string
  order_status: string
  pm_note: string
}

interface SoMatchResult {
  line_no: string | null
  pdl_seq: number | null
  status: 'matched' | 'no_order' | 'no_qty_match'
  reason: string
}

interface FailedImportItem {
  key: string
  row: SourceRow
  factory: 'T' | 'C' | 'O'
  error: string
  attemptedAt: string
}

type ExportRow = Record<string, string>

// ──────────────────────────────────────────────────────────────────────────────
// ArgoERP 匯出欄位定義（IFAF044 採購單格式）
// ──────────────────────────────────────────────────────────────────────────────
interface ExportColumn { key: string; label: string; typeLabel: string }

const EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'mo_number',            label: '製令單號',             typeLabel: '文字(32)' },
  { key: 'planned_start_date',   label: '預定投產日',           typeLabel: '日期' },
  { key: 'planned_end_date',     label: '預定結案日',           typeLabel: '日期' },
  { key: 'mo_status',            label: '製令狀態',             typeLabel: '文字(10)' },
  { key: 'status_date',          label: '狀態設定日',           typeLabel: '日期' },
  { key: 'department',           label: '部門',                 typeLabel: '文字(13)' },
  { key: 'cost_department',      label: '成本部門',             typeLabel: '文字(32)' },
  { key: 'seq_number',           label: '編號',                 typeLabel: '數字' },
  { key: 'product_code',         label: '生產貨號',             typeLabel: '文字(64)' },
  { key: 'version',              label: '版本',                 typeLabel: '數字' },
  { key: 'lot_number',           label: '批號',                 typeLabel: '文字(32)' },
  { key: 'datecode',             label: 'DATECODE',             typeLabel: '文字(32)' },
  { key: 'attr_a',               label: '料件屬性A',            typeLabel: '文字(32)' },
  { key: 'attr_b',               label: '料件屬性B',            typeLabel: '文字(32)' },
  { key: 'attr_c',               label: '料件屬性C',            typeLabel: '文字(32)' },
  { key: 'attr_d',               label: '料件屬性D',            typeLabel: '文字(32)' },
  { key: 'planned_qty',          label: '預訂產出量',           typeLabel: '數字' },
  { key: 'delivered_qty',        label: '已繳庫數量',           typeLabel: '數字' },
  { key: 'bom_level',            label: 'BOM製造批料階數',      typeLabel: '數字' },
  { key: 'product_cost_ratio',   label: '成品工費分攤約當比例', typeLabel: '數字' },
  { key: 'material_cost_ratio',  label: '直接原料分攤約當比例', typeLabel: '數字' },
  { key: 'source_order',         label: '來源訂單',             typeLabel: '文字(32)' },
  { key: 'source_order_line',    label: '來源訂單項號',         typeLabel: '數字' },
  { key: 'mo_note',              label: '製令說明',             typeLabel: '文字(2000)' },
  { key: 'create_date',          label: '開立日期',             typeLabel: '日期' },
  { key: 'auto_material',        label: '自動批備料',           typeLabel: '文字(200)' },
  { key: 'batch_number',         label: '批次號',               typeLabel: '文字(64)' },
  { key: 'project_code',         label: '專案代號',             typeLabel: '文字(32)' },
  { key: 'custom_1',             label: '自定義欄位1',          typeLabel: '文字(200)' },
  { key: 'custom_2',             label: '自定義欄位2',          typeLabel: '文字(200)' },
  { key: 'custom_3',             label: '自定義欄位3',          typeLabel: '文字(200)' },
  { key: 'custom_4',             label: '自定義欄位4',          typeLabel: '文字(200)' },
  { key: 'custom_5',             label: '自定義欄位5',          typeLabel: '文字(200)' },
  { key: 'custom_6',             label: '自定義欄位6',          typeLabel: '文字(200)' },
  { key: 'mo_type',              label: '製令型態',             typeLabel: '文字(32)' },
  { key: 'box_label_report',     label: '站間盒裝標籤報表代碼', typeLabel: '文字(32)' },
  { key: 'carton_label_report',  label: '外箱標籤報表代碼',     typeLabel: '文字(32)' },
  { key: 'pallet_label_report',  label: '棧板標籤報表代碼',     typeLabel: '文字(32)' },
  { key: 'routing_code',         label: '途程代碼',             typeLabel: '文字(32)' },
  { key: 'packing_qty',          label: '包裝數量',             typeLabel: '數字' },
]

const ERP_FIELD_CODE_MAP: Record<string, string> = {
  mo_number:           'PROJECT_ID',
  planned_start_date:  'BEGIN_DATE',
  planned_end_date:    'END_DATE',
  mo_status:           'HOLD_STATUS',
  status_date:         'STATUS_DATE',
  department:          'SEG_SEGMENT_NO_DEPARTMENT',
  cost_department:     'PJT_SEG_SEGMENT_NO',
  seq_number:          'LINE_NO',
  product_code:        'MBP_PART',
  version:             'MBP_VER',
  lot_number:          'MBP_LOT_NO',
  datecode:            'MBP_DATECODE',
  attr_a:              'MBP_REFERENCEA',
  attr_b:              'MBP_REFERENCEB',
  attr_c:              'MBP_REFERENCEC',
  attr_d:              'MBP_REFERENCED',
  planned_qty:         'ORDER_QTY',
  delivered_qty:       'ACTUAL_QTY',
  bom_level:           'BOM_LEVELS',
  product_cost_ratio:  'EQUIVALENT_RATIO',
  material_cost_ratio: 'EQUIVALENT_RATIO_M',
  source_order:        'PJT_PROJECT_ID_MO_SO',
  source_order_line:   'LINE_NO_MO_SO',
  mo_note:             'REMARK_LINE',
  create_date:         'MO_BEGIN_DATE',
  auto_material:       'AUTO_PREPARE',
  batch_number:        'BATCH_NO',
  project_code:        'PJT_TASK_ID',
  custom_1:            'PDL01C',
  custom_2:            'PDL02C',
  custom_3:            'PDL03C',
  custom_4:            'PDL04C',
  custom_5:            'PDL05C',
  custom_6:            'PDL06C',
  mo_type:             'MO_TYPE',
  box_label_report:    'INNER_BOX_LABEL_ID',
  carton_label_report: 'BOX_LABEL_ID',
  pallet_label_report: 'PAL_LABEL_ID',
  routing_code:        'ROUTING_ID',
  packing_qty:         'QTY_PACK',
}

const MAPPED_KEYS = new Set([
  'mo_number', 'planned_start_date', 'planned_end_date', 'mo_status',
  'department', 'cost_department', 'seq_number', 'product_code', 'version',
  'lot_number', 'planned_qty', 'bom_level', 'product_cost_ratio',
  'material_cost_ratio', 'source_order', 'source_order_line', 'mo_note', 'create_date', 'auto_material',
])

// ──────────────────────────────────────────────────────────────────────────────
// 工具函式
// ──────────────────────────────────────────────────────────────────────────────
function formatDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

function truncateByByteLength(text: string, maxBytes: number): string {
  if (!text) return ''
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8')
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  let cut = maxBytes
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--
  return decoder.decode(bytes.slice(0, cut))
}

function getNextBusinessDay(from: Date): Date {
  const d = new Date(from)
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return d
}

function parseSoDateDigits(orderNumber: string): string | null {
  const m = orderNumber.match(/^[A-Za-z]+(\d+)/)
  return m ? m[1] : null
}

function createSourceRowKey(row: SourceRow): string {
  return [
    row.order_number, row.doc_type, row.factory,
    row.item_code, row.item_name, row.note,
    row.quantity, row.delivery_date,
  ].join('||')
}

function mergeFailedImports(
  existing: FailedImportItem[],
  rows: SourceRow[],
  error: string,
  attemptedAt: string,
): FailedImportItem[] {
  const map = new Map(existing.map(i => [i.key, i]))
  rows.forEach(row => {
    const key = createSourceRowKey(row)
    map.set(key, { key, row, factory: row.factory, error, attemptedAt })
  })
  return [...map.values()]
}

function removeFailedImportsByRows(existing: FailedImportItem[], rows: SourceRow[]): FailedImportItem[] {
  const keys = new Set(rows.map(createSourceRowKey))
  return existing.filter(i => !keys.has(i.key))
}

// ──────────────────────────────────────────────────────────────────────────────
// Seq cache（模組層，防止同頁面多次出現同號）
// ──────────────────────────────────────────────────────────────────────────────
const seqCache = new Map<string, number>()

async function prefetchSeqFromDb(): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    const res = await fetch('/api/argoerp/mo-summary', { cache: 'no-store' })
    if (!res.ok) return
    const json = await res.json()
    const records: Array<{ mo_number?: string }> = json?.records ?? []
    const maxByKey = new Map<string, number>()
    for (const r of records) {
      const mo = r?.mo_number ?? ''
      const m = mo.match(/^(MO[TCO])(\d{8})(\d{3})$/)
      if (!m) continue
      const key = `${m[1]}${m[2]}`
      const seq = Number(m[3])
      const cur = maxByKey.get(key) ?? 0
      if (seq > cur) maxByKey.set(key, seq)
    }
    for (const [k, v] of maxByKey) seqCache.set(k, v)
  } catch { /* fallback */ }
}

function getMaxUsedSeqLocal(prefix: string, dateDigits: string, storageKey: string): number {
  if (typeof window === 'undefined') return 0
  try {
    const records: Array<{ mo_number?: string }> = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
    const headLen = prefix.length + dateDigits.length
    let max = 0
    for (const r of records) {
      const mo = r?.mo_number ?? ''
      if (mo.length !== headLen + 2) continue
      if (!mo.startsWith(prefix + dateDigits)) continue
      const seq = Number(mo.slice(headLen))
      if (Number.isFinite(seq) && seq > max) max = seq
    }
    return max
  } catch { return 0 }
}

function getMaxUsedSeq(prefix: string, dateDigits: string, storageKey: string): number {
  const dbMax = seqCache.get(`${prefix}${dateDigits}`) ?? 0
  const localMax = getMaxUsedSeqLocal(prefix, dateDigits, storageKey)
  return Math.max(dbMax, localMax)
}

// ──────────────────────────────────────────────────────────────────────────────
// 匯出列映射
// ──────────────────────────────────────────────────────────────────────────────
function mapAllToExport(
  srcRows: SourceRow[],
  matchResults: SoMatchResult[],
  storageKey: string,
): ExportRow[] {
  const today = new Date()
  const todayStr = formatDate(today)
  const nextBizDay = formatDate(getNextBusinessDay(today))
  const todayDateDigits = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

  return srcRows.map((src, rowIndex) => {
    const row: ExportRow = {}
    EXPORT_COLUMNS.forEach(col => { row[col.key] = '' })

    const prefix = src.factory === 'O' ? 'MOO' : `MO${src.factory}`
    const soDateDigits = parseSoDateDigits(src.order_number) ?? todayDateDigits
    const lineNo = matchResults[rowIndex]?.line_no
    const seqStr = lineNo ? String(Number(lineNo)).padStart(2, '0') : '00'
    row.mo_number = `${prefix}${soDateDigits}${seqStr}`

    row.planned_start_date  = nextBizDay
    row.planned_end_date    = src.delivery_date
    row.mo_status           = 'OPEN'
    row.department          = 'M1100'
    row.cost_department     = 'M1000'
    row.seq_number          = lineNo ? String(Number(lineNo)) : '1'
    row.product_code        = src.item_code
    row.version             = '1'
    row.lot_number          = truncateByByteLength(src.order_number, 30)
    row.planned_qty         = src.quantity
    row.bom_level           = '99'
    row.product_cost_ratio  = '1'
    row.material_cost_ratio = '1'
    row.source_order        = src.order_number
    row.source_order_line   = matchResults[rowIndex]?.line_no ?? ''
    row.mo_note             = [src.item_name, src.note].filter(Boolean).join(' ')
    row.create_date         = todayStr
    row.auto_material       = 'N'
    return row
  })
}

function toErpPayload(rows: ExportRow[]): Array<Record<string, string>> {
  return rows.map(row => {
    const erp: Record<string, string> = {}
    for (const [k, v] of Object.entries(row)) {
      const code = ERP_FIELD_CODE_MAP[k]
      if (!code) continue
      const val = (v ?? '').trim()
      if (!val) continue
      erp[code] = val
    }
    return erp
  })
}

// ──────────────────────────────────────────────────────────────────────────────
// Supabase 總表存取
// ──────────────────────────────────────────────────────────────────────────────
function buildSummaryRecords(
  sourceRows: SourceRow[],
  savedAt: string,
  matchResults: SoMatchResult[],
  storageKey: string,
) {
  return mapAllToExport(sourceRows, matchResults, storageKey).map((row, index) => ({
    mo_number:          row.mo_number,
    planned_start_date: row.planned_start_date,
    planned_end_date:   row.planned_end_date,
    mo_status:          row.mo_status,
    department:         row.department,
    product_code:       row.product_code,
    lot_number:         row.lot_number,
    planned_qty:        row.planned_qty,
    source_order:       row.source_order,
    mo_note:            row.mo_note,
    create_date:        row.create_date,
    factory:            sourceRows[index]?.factory ?? 'C',
    saved_at:           savedAt,
    plate_count:        sourceRows[index]?.plate_count ?? '',
  }))
}

async function saveRecordsToSummaryDb(records: ReturnType<typeof buildSummaryRecords>): Promise<void> {
  const res = await fetch('/api/argoerp/mo-summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json?.success) {
    const err = new Error(json?.error || `HTTP ${res.status}`) as Error & { duplicate?: boolean }
    if (json?.duplicate) err.duplicate = true
    throw err
  }
}

async function saveRecordsToSummaryDbUpsert(records: ReturnType<typeof buildSummaryRecords>): Promise<void> {
  const res = await fetch('/api/argoerp/mo-summary?mode=upsert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`)
}

async function saveRecordsToSummary(records: ReturnType<typeof buildSummaryRecords>): Promise<void> {
  await saveRecordsToSummaryDb(records)
  for (const r of records) {
    const m = r.mo_number.match(/^(MO[TCO])(\d{8})(\d{3})$/)
    if (!m) continue
    const key = `${m[1]}${m[2]}`
    const seq = Number(m[3])
    const cur = seqCache.get(key) ?? 0
    if (seq > cur) seqCache.set(key, seq)
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Props
// ──────────────────────────────────────────────────────────────────────────────
interface ThemeConfig {
  accent:     string  // text color      e.g. 'text-orange-300'
  accentBg:   string  // badge bg        e.g. 'bg-orange-900/40'
  accentBorder: string // border         e.g. 'border-orange-700/50'
  btn:        string  // primary button  e.g. 'bg-orange-700 hover:bg-orange-600'
  headerBg:   string  // section header  e.g. 'bg-orange-900/30'
}

interface FactoryOrderExportPageProps {
  factory:    'C' | 'O'
  title:      string
  subtitle:   string
  storageKey:  string
  failedKey:   string
  theme:       ThemeConfig
  hideImport?: boolean
}

// ──────────────────────────────────────────────────────────────────────────────
// Component
// ──────────────────────────────────────────────────────────────────────────────
export default function FactoryOrderExportPage({
  factory, title, subtitle, storageKey, failedKey, theme, hideImport = false,
}: FactoryOrderExportPageProps) {

  // ---- state ----
  const [sourceRows, setSourceRows]       = useState<SourceRow[]>([])
  const [selectedRows, setSelectedRows]   = useState<Set<number>>(new Set())
  const [soModalId, setSoModalId]         = useState<string | null>(null)

  const [availableSheetDates, setAvailableSheetDates] = useState<{ sheet_date: string; row_count: number }[]>([])
  const [sheetDatesLoading, setSheetDatesLoading]     = useState(false)
  const [sheetPickerDate, setSheetPickerDate]         = useState('')
  const [loadedFromSheetDate, setLoadedFromSheetDate] = useState<string | null>(null)

  const [soMatchResults, setSoMatchResults] = useState<SoMatchResult[]>([])
  const [soMatchLoading, setSoMatchLoading] = useState(false)

  const [exportFormat, setExportFormat] = useState<'csv' | 'xlsx'>('csv')
  const [saveMsg, setSaveMsg]           = useState('')
  const [importing, setImporting]       = useState(false)

  const [failedImports, setFailedImports] = useState<FailedImportItem[]>([])

  const [importPreview, setImportPreview] = useState<null | {
    rows: Array<{ mo_number: string; product_code: string; source_order: string; source_order_line: string; planned_qty: string; planned_end_date: string }>
    skippedCount: number
  }>(null)

  // ── localStorage helpers ──
  function loadRows(): SourceRow[] {
    if (typeof window === 'undefined') return []
    try { return JSON.parse(localStorage.getItem(storageKey) ?? '[]') } catch { return [] }
  }
  function saveRows(rows: SourceRow[]) {
    try { localStorage.setItem(storageKey, JSON.stringify(rows)) } catch {}
  }
  function loadFailed(): FailedImportItem[] {
    if (typeof window === 'undefined') return []
    try { return JSON.parse(localStorage.getItem(failedKey) ?? '[]') } catch { return [] }
  }
  function saveFailed(items: FailedImportItem[]) {
    try {
      if (items.length === 0) { localStorage.removeItem(failedKey); return }
      localStorage.setItem(failedKey, JSON.stringify(items))
    } catch {}
  }

  // ── 初始化 ──
  useEffect(() => {
    setSourceRows(loadRows())
    setFailedImports(loadFailed())
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { if (sourceRows.length > 0) saveRows(sourceRows) }, [sourceRows])
  useEffect(() => { saveFailed(failedImports) }, [failedImports])

  // ── 載入出單表日期清單 ──
  useEffect(() => {
    setSheetDatesLoading(true)
    fetch('/api/argoerp/daily-order-sheet')
      .then(r => r.json())
      .then(json => {
        if (json.success) {
          setAvailableSheetDates(json.sheets ?? [])
          if (!sheetPickerDate && json.sheets?.length > 0) {
            setSheetPickerDate(json.sheets[0].sheet_date)
          }
        }
      })
      .catch(() => {})
      .finally(() => setSheetDatesLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── SO 比對 ──
  const buildSoMatches = useCallback(async (rows: SourceRow[]) => {
    if (rows.length === 0) { setSoMatchResults([]); return }
    setSoMatchLoading(true)
    try {
      const orderNumbers = [...new Set(rows.map(r => r.order_number).filter(Boolean))]
      if (orderNumbers.length === 0) {
        setSoMatchResults(rows.map(() => ({ line_no: null, pdl_seq: null, status: 'no_order' as const, reason: '無比對到對應的來源單號' })))
        return
      }
      const { data: soLines } = await supabase
        .from('erp_so_lines')
        .select('project_id, line_no, mbp_part, order_qty_oru, pdl_seq')
        .in('project_id', orderNumbers)
      const lines = soLines ?? []
      const soProjectIds = new Set(lines.map((l: { project_id: string }) => l.project_id))
      const candidateMap = new Map<string, Array<{ line_no: string; pdl_seq: number | null }>>()
      for (const line of lines) {
        const qty = Number(line.order_qty_oru ?? 0)
        const key = `${line.project_id}|${line.mbp_part ?? ''}|${qty}`
        if (!candidateMap.has(key)) candidateMap.set(key, [])
        candidateMap.get(key)!.push({ line_no: String(line.line_no ?? ''), pdl_seq: line.pdl_seq != null ? Number(line.pdl_seq) : null })
      }
      for (const arr of candidateMap.values()) {
        arr.sort((a, b) => (Number(a.line_no) || 0) - (Number(b.line_no) || 0))
      }
      const usageCounter = new Map<string, number>()
      const results: SoMatchResult[] = rows.map(src => {
        if (!src.order_number || !soProjectIds.has(src.order_number)) {
          return { line_no: null, pdl_seq: null, status: 'no_order' as const, reason: '無比對到對應的來源單號' }
        }
        const qty = parseFloat(String(src.quantity).replace(/,/g, '')) || 0
        const key = `${src.order_number}|${src.item_code}|${qty}`
        const candidates = candidateMap.get(key) ?? []
        if (candidates.length === 0) {
          return { line_no: null, pdl_seq: null, status: 'no_qty_match' as const, reason: '有比對到對應的來源單號但無對應數量' }
        }
        const used = usageCounter.get(key) ?? 0
        const candidate = candidates[Math.min(used, candidates.length - 1)]
        usageCounter.set(key, used + 1)
        return { line_no: candidate.line_no, pdl_seq: candidate.pdl_seq, status: 'matched' as const, reason: '' }
      })
      setSoMatchResults(results)
    } catch (e) {
      console.error('buildSoMatches error', e)
      setSoMatchResults([])
    } finally {
      setSoMatchLoading(false)
    }
  }, [])

  // ── 從每日出單表載入 ──
  const handleLoadFromSheet = useCallback(async (date: string) => {
    if (!date) return
    try {
      const res = await fetch(`/api/argoerp/daily-order-sheet?date=${date}`)
      const json = await res.json()
      if (!json.success || !json.sheet) {
        alert(`找不到 ${date} 的出單表，請先到「每日出單表」頁面儲存資料。`)
        return
      }
      type SheetRow = SourceRow & { mo_status?: string; match_status?: string; match_line_no?: string | null; match_pdl_seq?: number | null; match_reason?: string | null }
      const sheetRows = (json.sheet.rows ?? []) as SheetRow[]
      const rows: SourceRow[] = sheetRows
        .filter(r => r.factory === factory)
        .map(r => ({
          order_number: r.order_number, doc_type: r.doc_type, factory: r.factory,
          receiver: r.receiver, is_sample: r.is_sample, has_material: r.has_material,
          designer: r.designer, customer: r.customer, line_nickname: r.line_nickname,
          handler: r.handler, issuer: r.issuer, item_code: r.item_code,
          item_name: r.item_name, note: r.note, quantity: r.quantity,
          delivery_date: r.delivery_date, plate_count: r.plate_count,
          upload_ro: r.upload_ro, order_status: r.order_status, pm_note: r.pm_note,
        }))
      setSourceRows(rows)
      setSelectedRows(new Set())
      setLoadedFromSheetDate(date)

      const hasPrematched = sheetRows.some(r => r.match_status)
      if (hasPrematched) {
        const presetMatches: SoMatchResult[] = sheetRows
          .filter(r => r.factory === factory)
          .map(r => ({
            line_no:  r.match_line_no ?? null,
            pdl_seq:  r.match_pdl_seq ?? null,
            status:   (r.match_status as SoMatchResult['status']) || 'no_order',
            reason:   r.match_reason ?? '',
          }))
        setSoMatchResults(presetMatches)
      } else {
        buildSoMatches(rows)
      }
    } catch (e) {
      alert(`載入出單表失敗：${e}`)
    }
  }, [factory, buildSoMatches])

  // ── 更新出單表列狀態 ──
  const updateSheetRowStatuses = useCallback(async (
    sheetDate: string,
    rows: SourceRow[],
    status: '已匯入製令',
    moNumbers?: string[],
  ) => {
    try {
      const updates = rows.map((r, i) => ({
        row_key: createSourceRowKey(r),
        mo_status: status,
        ...(moNumbers?.[i] ? { mo_number: moNumbers[i] } : {}),
      }))
      await fetch('/api/argoerp/daily-order-sheet', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sheet_date: sheetDate, updates }),
      })
    } catch (e) {
      console.warn('[出單表狀態更新] 失敗', e)
    }
  }, [])

  // ── 匯出 CSV / XLSX ──
  const doExport = useCallback((exportRows: ExportRow[]) => {
    const now = new Date()
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    const factorySuffix = factory === 'C' ? 'MOC_常平' : 'MOO_委外'
    const filename = `ArgoERP_採購單匯出_${factorySuffix}_${ts}`
    const headers  = EXPORT_COLUMNS.map(c => c.label)
    const typeDefs = EXPORT_COLUMNS.map(c => c.typeLabel)
    const dataRows = exportRows.map(row => EXPORT_COLUMNS.map(col => row[col.key] ?? ''))

    if (exportFormat === 'xlsx') {
      const ws = XLSX.utils.aoa_to_sheet([headers, typeDefs, ...dataRows])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '採購單匯出')
      XLSX.writeFile(wb, `${filename}.xlsx`)
    } else {
      const csvLines = [headers.join(','), typeDefs.join(',')]
      dataRows.forEach(cells => {
        csvLines.push(cells.map(v => (v.includes(',') || v.includes('\n') || v.includes('"')) ? `"${v.replace(/"/g, '""')}"` : v).join(','))
      })
      const blob = new Blob(['\uFEFF' + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = `${filename}.csv`; a.click()
      URL.revokeObjectURL(url)
    }
  }, [exportFormat, factory])

  // ── 匯入前預覽 ──
  const handleShowPreview = useCallback(async () => {
    if (sourceRows.length === 0) return
    const withSeqIdx = sourceRows.map((r, i) => ({ r, i })).filter(({ i }) => !!soMatchResults[i]?.line_no)
    const noSeqIdx   = sourceRows.map((r, i) => ({ r, i })).filter(({ i }) => !soMatchResults[i]?.line_no)

    if (noSeqIdx.length > 0) {
      const at = new Date().toLocaleString('zh-TW')
      setFailedImports(prev => mergeFailedImports(prev, noSeqIdx.map(({ r }) => r), '來源訂單序號未比對到', at))
    }
    if (withSeqIdx.length === 0) {
      alert('⚠️ 所有列均無法比對序號，已移入失敗區。請確認 ERP 同步後重新比對。')
      return
    }
    try { await prefetchSeqFromDb() } catch {}
    const withSeqRows  = withSeqIdx.map(({ r }) => r)
    const withSeqMatch = withSeqIdx.map(({ i }) => soMatchResults[i])
    const exportRows = mapAllToExport(withSeqRows, withSeqMatch, storageKey)
    setImportPreview({
      skippedCount: noSeqIdx.length,
      rows: exportRows.map(r => ({
        mo_number:         r.mo_number,
        product_code:      r.product_code,
        source_order:      r.source_order,
        source_order_line: r.source_order_line,
        planned_qty:       r.planned_qty,
        planned_end_date:  r.planned_end_date,
      })),
    })
  }, [sourceRows, soMatchResults, storageKey])

  // ── ERP 匯入 ──
  const handleImportToErp = useCallback(async () => {
    const withIdx    = sourceRows.map((r, i) => ({ r, i })).filter(({ i }) => !!soMatchResults[i]?.line_no)
    const noSeqIdx   = sourceRows.map((r, i) => ({ r, i })).filter(({ i }) => !soMatchResults[i]?.line_no)

    if (noSeqIdx.length > 0) {
      const at = new Date().toLocaleString('zh-TW')
      setFailedImports(prev => mergeFailedImports(prev, noSeqIdx.map(({ r }) => r), '來源訂單序號未比對到', at))
    }
    if (withIdx.length === 0) {
      alert('⚠️ 所有列均無法比對序號，已全數移入失敗區。')
      return
    }

    const filteredRows  = withIdx.map(({ r }) => r)
    const filteredMatch = withIdx.map(({ i }) => soMatchResults[i])

    try { await prefetchSeqFromDb() } catch {}

    const exportRows = mapAllToExport(filteredRows, filteredMatch, storageKey)
    const payload    = toErpPayload(exportRows)
    const interfaceId = 'IFAF044'
    const targetLabel = '採購單'

    setImporting(true)
    setSaveMsg('')
    setImportPreview(null)

    try {
      const response = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'import', interfaceId, data: payload }),
      })
      const result = await response.json()
      const isSuccess = response.ok && result?.success === true
      const errorStr  = typeof result?.error === 'string' ? result.error : ''

      const nowStr = new Date().toLocaleString('zh-TW')
      const records = buildSummaryRecords(filteredRows, nowStr, filteredMatch, storageKey)

      // 製令已存在 → 補存 Supabase
      if (!isSuccess && errorStr.includes('製令單號已存在')) {
        await saveRecordsToSummaryDbUpsert(records)
        setFailedImports(prev => removeFailedImportsByRows(prev, filteredRows))
        const importedKeys = new Set(filteredRows.map(createSourceRowKey))
        setSourceRows(prev => prev.filter(r => !importedKeys.has(createSourceRowKey(r))))
        setSelectedRows(new Set())
        if (loadedFromSheetDate) updateSheetRowStatuses(loadedFromSheetDate, filteredRows, '已匯入製令', records.map(r => r.mo_number))
        const msg = `⚠️ ${records.length} 筆${targetLabel}已存在於 ERP（跳過重複），已補存至製令總表`
        setSaveMsg(msg); alert(msg)
        setTimeout(() => setSaveMsg(''), 6000)
        return
      }

      // 部分成功/失敗解析
      const argoResultRows: Record<string, unknown>[] = Array.isArray(result?.apiResult?.RESULT)
        ? (result.apiResult.RESULT as Record<string, unknown>[]) : []

      if (!isSuccess && argoResultRows.length > 0) {
        const failedSlipErrors = new Map<string, string[]>()
        const seenSlips = new Set<string>()
        for (const row of argoResultRows) {
          const slip = String(row.SLIP_NO ?? '').trim()
          if (!slip) continue
          seenSlips.add(slip)
          if (String(row.CHECK_FLAG ?? '').toUpperCase() === 'N') {
            const detail = String(row.ERROR_CODE ?? row.ERROR ?? '未知錯誤').trim()
            if (!failedSlipErrors.has(slip)) failedSlipErrors.set(slip, [])
            failedSlipErrors.get(slip)!.push(detail)
          }
        }
        const successRows: typeof filteredRows = []
        const successRecs: typeof records      = []
        const failedPairs: { row: SourceRow; error: string }[] = []
        for (let i = 0; i < filteredRows.length; i++) {
          const moNo = records[i]?.mo_number ?? ''
          const errs = failedSlipErrors.get(moNo)
          if (errs) {
            failedPairs.push({ row: filteredRows[i], error: errs.join(' / ') })
          } else if (seenSlips.has(moNo)) {
            successRows.push(filteredRows[i]); successRecs.push(records[i])
          } else {
            failedPairs.push({ row: filteredRows[i], error: 'ARGO 未回報此筆狀態' })
          }
        }
        if (successRows.length > 0) {
          try { await saveRecordsToSummary(successRecs) } catch {}
          fetch('/api/argoerp/mo-upload-log', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: successRecs.map(r => ({ mo_number: r.mo_number, factory: r.factory, product_code: r.product_code, planned_qty: r.planned_qty, source_order: r.source_order, lot_number: r.lot_number, mo_note: r.mo_note, planned_start_date: r.planned_start_date, planned_end_date: r.planned_end_date, create_date: r.create_date, interface_id: interfaceId })) }),
          }).catch(() => {})
          setFailedImports(prev => removeFailedImportsByRows(prev, successRows))
          if (loadedFromSheetDate) updateSheetRowStatuses(loadedFromSheetDate, successRows, '已匯入製令', successRecs.map(r => r.mo_number))
          const importedKeys = new Set(successRows.map(createSourceRowKey))
          setSourceRows(prev => prev.filter(r => !importedKeys.has(createSourceRowKey(r))))
          setSelectedRows(new Set())
        }
        if (failedPairs.length > 0) {
          const at = new Date().toLocaleString('zh-TW')
          setFailedImports(prev => {
            let next = prev
            for (const { row, error } of failedPairs) next = mergeFailedImports(next, [row], error, at)
            return next
          })
        }
        const msg = `${targetLabel}匯入完成：✅ 成功 ${successRows.length} 筆 / ❌ 失敗 ${failedPairs.length} 筆`
        setSaveMsg(msg); alert(msg); setTimeout(() => setSaveMsg(''), 8000)
        return
      }

      if (!isSuccess) {
        const raw = typeof result?.rawText === 'string' ? result.rawText.slice(0, 600) : JSON.stringify(result?.apiResult ?? '').slice(0, 600)
        throw new Error(`${result?.error || `HTTP ${response.status}`}\n\n【ARGO 原始回應】\n${raw}`)
      }

      // 完全成功
      try { await saveRecordsToSummary(records) } catch (saveErr) {
        alert(`⚠️ ERP 已匯入成功，但 Supabase 儲存失敗：${saveErr instanceof Error ? saveErr.message : saveErr}\n請記下製令號：${records.map(r => r.mo_number).join(', ')}`)
      }
      fetch('/api/argoerp/mo-upload-log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: records.map(r => ({ mo_number: r.mo_number, factory: r.factory, product_code: r.product_code, planned_qty: r.planned_qty, source_order: r.source_order, lot_number: r.lot_number, mo_note: r.mo_note, planned_start_date: r.planned_start_date, planned_end_date: r.planned_end_date, create_date: r.create_date, interface_id: interfaceId })) }),
      }).catch(() => {})
      setFailedImports(prev => removeFailedImportsByRows(prev, filteredRows))
      if (loadedFromSheetDate) updateSheetRowStatuses(loadedFromSheetDate, filteredRows, '已匯入製令', records.map(r => r.mo_number))
      const importedKeys = new Set(filteredRows.map(createSourceRowKey))
      setSourceRows(prev => prev.filter(r => !importedKeys.has(createSourceRowKey(r))))
      setSelectedRows(new Set())
      const firstMo = records[0]?.mo_number ?? '?'
      const erpRaw  = typeof result?.rawText === 'string' ? result.rawText.slice(0, 400) : JSON.stringify(result?.apiResult ?? '').slice(0, 400)
      const successMsg = `✅ ${records.length} 筆已匯入 ERP ${targetLabel}並儲存至製令總表`
      setSaveMsg(successMsg)
      alert(`${successMsg}\n\n首筆單號：${firstMo}\n\n【ERP 回應】\n${erpRaw}`)
      setTimeout(() => setSaveMsg(''), 6000)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const at = new Date().toLocaleString('zh-TW')
      setFailedImports(prev => mergeFailedImports(prev, filteredRows, message, at))
      const errMsg = `❌ 匯入失敗：${message}\n${filteredRows.length} 筆已移至失敗區`
      setSaveMsg(errMsg); alert(errMsg); setTimeout(() => setSaveMsg(''), 8000)
    } finally {
      setImporting(false)
    }
  }, [sourceRows, soMatchResults, storageKey, loadedFromSheetDate, updateSheetRowStatuses])

  // ── 選取 ──
  const toggleSelectAll = useCallback(() => {
    setSelectedRows(prev => prev.size === sourceRows.length ? new Set() : new Set(sourceRows.map((_, i) => i)))
  }, [sourceRows])

  const toggleRow = useCallback((idx: number) => {
    setSelectedRows(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }, [])

  const handleDeleteSelected = useCallback(() => {
    if (selectedRows.size === 0) return
    if (!confirm(`確定要刪除選取的 ${selectedRows.size} 筆資料？`)) return
    setSourceRows(prev => prev.filter((_, i) => !selectedRows.has(i)))
    setSelectedRows(new Set())
  }, [selectedRows])

  const handleClearAll = useCallback(() => {
    setSourceRows([]); setSelectedRows(new Set()); setLoadedFromSheetDate(null)
    localStorage.removeItem(storageKey)
  }, [storageKey])

  // ── Derived ──
  const exportPreviewRows = useMemo(
    () => mapAllToExport(sourceRows, soMatchResults, storageKey),
    [sourceRows, soMatchResults, storageKey],
  )
  const EXPORT_PREVIEW_COLS = EXPORT_COLUMNS.filter(
    col => MAPPED_KEYS.has(col.key) || exportPreviewRows.some(r => r[col.key]?.trim()),
  )

  // ──────────────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1800px] mx-auto">

        {/* ── Header ── */}
        <div className="mb-6 border-b border-slate-800 pb-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
            <p className="text-slate-400 mt-1 text-sm">{subtitle}</p>
          </div>
          <div className="flex gap-2 flex-wrap items-center">
            {/* 出單日期選擇器 */}
            {sheetDatesLoading ? (
              <span className="text-slate-500 text-sm px-2">讀取出單表…</span>
            ) : (
              <>
                <select
                  value={sheetPickerDate}
                  onChange={e => setSheetPickerDate(e.target.value)}
                  className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-sm focus:outline-none focus:border-cyan-500"
                >
                  <option value="">選擇出單日期…</option>
                  {availableSheetDates.map(s => (
                    <option key={s.sheet_date} value={s.sheet_date}>
                      {s.sheet_date}（{s.row_count} 筆）
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => handleLoadFromSheet(sheetPickerDate)}
                  disabled={!sheetPickerDate}
                  className="px-4 py-2 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm"
                >
                  📋 載入出單表
                </button>
                {loadedFromSheetDate && (
                  <span className={`text-xs px-2 py-1 rounded border ${theme.accentBg} ${theme.accent} ${theme.accentBorder}`}>
                    已載入 {loadedFromSheetDate}
                  </span>
                )}
              </>
            )}

            {/* SO 比對 */}
            {sourceRows.length > 0 && (
              <button
                onClick={() => buildSoMatches(sourceRows)}
                disabled={soMatchLoading}
                className="px-4 py-2 rounded-lg bg-teal-800 hover:bg-teal-700 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm"
              >
                {soMatchLoading ? '比對中…' : soMatchResults.length > 0
                  ? `🔄 重新比對（${soMatchResults.filter(r => r.status === 'matched').length}/${soMatchResults.length}）`
                  : '🔍 比對來源單號'}
              </button>
            )}

            {/* 匯入預覽 */}
            {!hideImport && sourceRows.length > 0 && (
              <button
                onClick={() => void handleShowPreview()}
                disabled={importing || soMatchResults.length === 0}
                className={`px-4 py-2 rounded-lg ${theme.btn} disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm`}
              >
                🔍 預覽並匯入
              </button>
            )}

            {/* 匯出 CSV / XLSX */}
            {sourceRows.length > 0 && (
              <>
                <select
                  value={exportFormat}
                  onChange={e => setExportFormat(e.target.value as 'csv' | 'xlsx')}
                  className="px-2 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 text-sm focus:outline-none"
                >
                  <option value="csv">CSV</option>
                  <option value="xlsx">XLSX</option>
                </select>
                <button
                  onClick={() => doExport(exportPreviewRows)}
                  className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white font-medium transition-colors text-sm"
                >
                  ⬇ 匯出 {exportFormat.toUpperCase()}
                </button>
              </>
            )}

            {/* 刪除 / 清空 */}
            {selectedRows.size > 0 && (
              <button onClick={handleDeleteSelected} className="px-4 py-2 rounded-lg bg-red-900/60 border border-red-700/50 text-red-300 hover:bg-red-800 transition-colors text-sm">
                🗑 刪除選取 ({selectedRows.size})
              </button>
            )}
            {sourceRows.length > 0 && (
              <button onClick={handleClearAll} className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:bg-red-900/40 hover:text-red-300 hover:border-red-700/50 transition-colors text-sm">
                全部清空
              </button>
            )}
          </div>
        </div>

        {/* ── 訊息列 ── */}
        {saveMsg && (
          <div className={`mb-4 px-4 py-3 rounded-lg text-sm ${saveMsg.startsWith('❌') ? 'bg-red-900/30 border border-red-700 text-red-300' : 'bg-emerald-900/30 border border-emerald-700 text-emerald-300'}`}>
            {saveMsg}
          </div>
        )}

        {/* ── 流程狀態 ── */}
        <div className="mb-6 bg-slate-900 border border-slate-800 rounded-lg p-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <div className="text-xs text-slate-500 mb-1">出單表</div>
              <div className={`font-semibold truncate ${loadedFromSheetDate ? theme.accent : 'text-slate-600'}`}>{loadedFromSheetDate ?? '未載入'}</div>
            </div>
            <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <div className="text-xs text-slate-500 mb-1">已帶入</div>
              <div className={`font-bold ${theme.accent}`}>{sourceRows.length} <span className="text-slate-500 font-normal text-xs">筆</span></div>
            </div>
            <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <div className="text-xs text-slate-500 mb-1">SO 比對</div>
              <div className={`font-semibold ${soMatchResults.length > 0 ? 'text-emerald-300' : 'text-slate-600'}`}>
                {soMatchResults.length > 0 ? `${soMatchResults.filter(r => r.status === 'matched').length} / ${soMatchResults.length}` : '尚未比對'}
              </div>
            </div>
            <div className="rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <div className="text-xs text-slate-500 mb-1">匯入失敗</div>
              <div className={`font-bold ${failedImports.length > 0 ? 'text-red-400' : 'text-slate-600'}`}>
                {failedImports.length > 0 ? `${failedImports.length} 筆` : '—'}
              </div>
            </div>
          </div>
        </div>

        {/* ── 匯入預覽 Modal ── */}
        {!hideImport && importPreview && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setImportPreview(null)}>
            <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-bold text-white">匯入預覽</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    將匯入 <span className={`font-semibold ${theme.accent}`}>{importPreview.rows.length}</span> 筆
                    {importPreview.skippedCount > 0 && <span className="text-amber-400 ml-1">（{importPreview.skippedCount} 筆無序號，已移至失敗區）</span>}
                  </p>
                </div>
                <button onClick={() => setImportPreview(null)} className="text-slate-400 hover:text-white text-lg">✕</button>
              </div>
              <div className="overflow-y-auto flex-1 px-5 py-3">
                <div className="overflow-x-auto rounded-lg border border-slate-700">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-800 text-slate-400">
                        <th className="px-3 py-2 text-left">#</th>
                        <th className="px-3 py-2 text-left whitespace-nowrap">採購單號</th>
                        <th className="px-3 py-2 text-left">貨號</th>
                        <th className="px-3 py-2 text-left">來源訂單</th>
                        <th className="px-3 py-2 text-center">項號</th>
                        <th className="px-3 py-2 text-right">數量</th>
                        <th className="px-3 py-2 text-left whitespace-nowrap">交貨日</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.map((r, i) => (
                        <tr key={i} className={`border-t border-slate-800/50 ${i % 2 === 0 ? '' : 'bg-slate-900/40'}`}>
                          <td className="px-3 py-1.5 text-slate-500">{i + 1}</td>
                          <td className={`px-3 py-1.5 font-mono font-semibold ${theme.accent}`}>{r.mo_number}</td>
                          <td className="px-3 py-1.5 text-slate-300">{r.product_code}</td>
                          <td className="px-3 py-1.5 font-mono text-slate-400">{r.source_order}</td>
                          <td className="px-3 py-1.5 text-center text-slate-400">{r.source_order_line}</td>
                          <td className="px-3 py-1.5 text-right text-slate-300">{r.planned_qty}</td>
                          <td className="px-3 py-1.5 text-yellow-400/80 whitespace-nowrap">{r.planned_end_date}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="px-5 py-4 border-t border-slate-700 flex justify-end gap-3">
                <button onClick={() => setImportPreview(null)} className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors text-sm">取消</button>
                <button
                  onClick={() => void handleImportToErp()}
                  disabled={importing}
                  className={`px-5 py-2 rounded-lg ${theme.btn} disabled:bg-slate-700 disabled:text-slate-400 text-white font-semibold transition-colors text-sm`}
                >
                  {importing ? '匯入中…' : `確認匯入 ERP（${importPreview.rows.length} 筆）`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── 資料表格 ── */}
        {sourceRows.length > 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-800/80 border-b border-slate-700">
                    <th className="px-2 py-3 text-center sticky left-0 bg-slate-800/80 z-10 w-10">
                      <input type="checkbox" checked={selectedRows.size === sourceRows.length} onChange={toggleSelectAll}
                        className="rounded border-slate-600 bg-slate-700 text-cyan-500" />
                    </th>
                    <th className="px-2 py-3 text-center text-slate-500 font-mono text-xs w-10">#</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs whitespace-nowrap">工單編號</th>
                    <th className="px-3 py-3 text-center text-slate-300 font-medium text-xs whitespace-nowrap min-w-[100px]">序號比對</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs whitespace-nowrap">客戶</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs whitespace-nowrap">承辦人</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs whitespace-nowrap">品項編碼</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs">品名/規格</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs">備註</th>
                    <th className="px-3 py-3 text-right text-slate-300 font-medium text-xs whitespace-nowrap">數量</th>
                    <th className="px-3 py-3 text-left text-slate-300 font-medium text-xs whitespace-nowrap">交付日期</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceRows.map((row, idx) => (
                    <tr key={idx} className={`border-b border-slate-800/50 transition-colors ${selectedRows.has(idx) ? 'bg-cyan-950/30' : idx % 2 === 0 ? 'bg-slate-900/50' : 'bg-slate-900/20'} hover:bg-slate-800/50`}>
                      <td className="px-2 py-2 text-center sticky left-0 bg-inherit z-10">
                        <input type="checkbox" checked={selectedRows.has(idx)} onChange={() => toggleRow(idx)}
                          className="rounded border-slate-600 bg-slate-700 text-cyan-500" />
                      </td>
                      <td className="px-2 py-2 text-center text-slate-500 font-mono text-xs">{idx + 1}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs">
                        {row.order_number
                          ? <button onClick={() => setSoModalId(row.order_number)} className="font-mono text-slate-300 hover:text-cyan-300 hover:underline underline-offset-2 text-left">{row.order_number}</button>
                          : <span className="text-slate-700">—</span>}
                      </td>
                      <td className="px-3 py-2 text-center whitespace-nowrap">
                        {soMatchLoading ? (
                          <span className="text-slate-600 text-xs">…</span>
                        ) : soMatchResults[idx] ? (
                          soMatchResults[idx].status === 'matched' ? (
                            <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-emerald-900/50 text-emerald-300 border border-emerald-700/40 font-mono">
                              ✓ {soMatchResults[idx].line_no}
                            </span>
                          ) : (
                            <span
                              className={`inline-block text-xs px-1.5 py-0.5 rounded border font-medium cursor-help ${soMatchResults[idx].status === 'no_order' ? 'bg-red-900/40 text-red-300 border-red-700/40' : 'bg-amber-900/40 text-amber-300 border-amber-700/40'}`}
                              title={soMatchResults[idx].reason}
                            >
                              {soMatchResults[idx].status === 'no_order' ? '✗ 無單號' : '⚠ 無數量'}
                            </span>
                          )
                        ) : <span className="text-slate-700 text-xs">—</span>}
                      </td>
                      <td className="px-3 py-2 text-slate-300 text-xs max-w-[120px] truncate" title={row.customer}>{row.customer || <span className="text-slate-700">—</span>}</td>
                      <td className="px-3 py-2 text-slate-300 text-xs whitespace-nowrap">{row.handler || <span className="text-slate-700">—</span>}</td>
                      <td className="px-3 py-2 text-xs font-mono text-slate-300 whitespace-nowrap">{row.item_code || <span className="text-slate-700">—</span>}</td>
                      <td className="px-3 py-2 text-slate-300 text-xs max-w-[280px] truncate" title={row.item_name}>{row.item_name || <span className="text-slate-700">—</span>}</td>
                      <td className="px-3 py-2 text-slate-400 text-xs max-w-[200px] truncate" title={row.note}>{row.note || <span className="text-slate-700">—</span>}</td>
                      <td className="px-3 py-2 text-right text-slate-300 text-xs whitespace-nowrap">{row.quantity}</td>
                      <td className="px-3 py-2 text-yellow-400/80 text-xs whitespace-nowrap">{row.delivery_date || <span className="text-slate-700">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-12 text-center">
            <p className="text-slate-500">尚無資料，請從上方選擇出單日期並載入</p>
            <p className="text-slate-600 text-xs mt-2">僅顯示廠別為「{factory === 'C' ? '常平 (C)' : '委外 (O)'}」的資料</p>
          </div>
        )}

        {/* ── 失敗區 ── */}
        {failedImports.length > 0 && (
          <div className="mt-6 bg-red-950/20 border border-red-800/40 rounded-lg overflow-hidden">
            <div className="px-4 py-4 border-b border-red-800/30 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-red-300">匯入失敗集中區</h3>
                <p className="text-sm text-red-200/70 mt-1">失敗資料會集中保留，方便修正後重新上傳。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => {
                    setSourceRows(prev => {
                      const map = new Map(prev.map(r => [createSourceRowKey(r), r]))
                      failedImports.forEach(i => map.set(i.key, i.row))
                      return [...map.values()]
                    })
                    setSelectedRows(new Set()); setSaveMsg('✅ 失敗資料已加入主清單'); setTimeout(() => setSaveMsg(''), 4000)
                  }}
                  className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 transition-colors text-sm"
                >
                  加入主清單 ({failedImports.length} 筆)
                </button>
                <button
                  onClick={async () => {
                    const nowStr = new Date().toISOString()
                    const rows = failedImports.map(i => i.row)
                    const records = buildSummaryRecords(rows, nowStr, rows.map(() => ({ line_no: null, pdl_seq: null, status: 'no_order' as const, reason: '' })), storageKey)
                    try {
                      await saveRecordsToSummaryDbUpsert(records)
                      setFailedImports(prev => removeFailedImportsByRows(prev, rows))
                      setSaveMsg(`✅ 已直接轉入製令總表 ${records.length} 筆`)
                    } catch (e) { setSaveMsg(`❌ 轉入失敗：${e instanceof Error ? e.message : String(e)}`) }
                    setTimeout(() => setSaveMsg(''), 5000)
                  }}
                  className="px-3 py-2 rounded-lg bg-emerald-800/70 border border-emerald-700/50 text-emerald-100 hover:bg-emerald-700 transition-colors text-sm"
                >
                  直接轉入製令總表
                </button>
                <button
                  onClick={() => setFailedImports([])}
                  className="px-3 py-2 rounded-lg bg-red-900/60 border border-red-700/50 text-red-200 hover:bg-red-800 transition-colors text-sm"
                >
                  清空失敗區
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-red-950/30 border-b border-red-800/30">
                    {['工單編號', '品項編碼', '品名/規格', '錯誤原因', '失敗時間', '操作'].map(h => (
                      <th key={h} className="px-3 py-2.5 text-left text-red-200/80 text-xs whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {failedImports.map(item => (
                    <tr key={item.key} className="border-b border-red-900/20 bg-slate-950/30 hover:bg-slate-900/50">
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        <button onClick={() => setSoModalId(item.row.order_number)} className="font-mono text-slate-200 hover:text-cyan-300 hover:underline underline-offset-2">
                          {item.row.order_number || '—'}
                        </button>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-300 whitespace-nowrap">{item.row.item_code || '—'}</td>
                      <td className="px-3 py-2 text-xs text-slate-300 max-w-[220px] truncate" title={item.row.item_name}>{item.row.item_name || '—'}</td>
                      <td className="px-3 py-2 text-xs text-red-200 max-w-[320px]">{item.error}</td>
                      <td className="px-3 py-2 text-xs text-slate-400 whitespace-nowrap">{item.attemptedAt}</td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => setFailedImports(prev => prev.filter(i => i.key !== item.key))}
                          className="px-2.5 py-1 rounded-md bg-slate-800 border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-700 transition-colors text-xs"
                        >移除</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── 欄位對應說明 ── */}
        {sourceRows.length > 0 && (
          <details className="mt-6">
            <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-400 mb-2">欄位對應規則</summary>
            <div className={`bg-slate-900/50 border ${theme.accentBorder}/30 rounded-lg p-4 grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs`}>
              {[
                ['自動生成', '採購單號 (MO+廠別+日期+序號)'],
                ['品項編碼', '生產貨號'],
                ['數量', '預訂產出量'],
                ['工單編號', '來源訂單'],
                ['SO LINE_NO', '來源訂單項號'],
                ['品名/規格+備註', '採購單說明'],
                ['交付日期', '預定結案日'],
                ['今天', '開立日期'],
              ].map(([from, to], i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-slate-500 w-24 shrink-0">{from}</span>
                  <span className="text-slate-600">→</span>
                  <span className={theme.accent}>{to}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {/* ── SO 查詢 Modal ── */}
      {soModalId && <SoOrderModal projectId={soModalId} onClose={() => setSoModalId(null)} />}
    </div>
  )
}
