'use client'

import { useState, useCallback, useEffect, useMemo } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../../../../lib/supabaseClient'

// ==================== 來源欄位（貼上的格式） ====================
const INPUT_COLUMNS = [
  '工單編號', '', '單據種類', '簽收人員', '打樣', '附素材',
  '美編', '客戶/供應商名', 'LINE暱稱', '承辦人', '開單人員',
  '品項編碼', '品名/規格', '備註', '數量', '交付日期',
  '盤數', '上傳RO', '訂單狀態', '生管/物管備註',
] as const

interface SourceRow {
  order_number: string    // 工單編號
  doc_type: string        // 單據種類
  factory: 'T' | 'C' | 'O'  // 生產廠別 T=台北 C=常平 O=委外
  receiver: string        // 簽收人員
  is_sample: string       // 打樣
  has_material: string    // 附素材
  designer: string        // 美編
  customer: string        // 客戶/供應商名
  line_nickname: string   // LINE暱稱
  handler: string         // 承辦人
  issuer: string          // 開單人員
  item_code: string       // 品項編碼
  item_name: string       // 品名/規格
  note: string            // 備註
  quantity: string        // 數量
  delivery_date: string   // 交付日期
  plate_count: string     // 盤數
  upload_ro: string       // 上傳RO
  order_status: string    // 訂單狀態
  pm_note: string         // 生管/物管備註
}

// 根據單據種類自動判斷廠別
function detectFactory(docType: string): 'T' | 'C' | 'O' {
  if (docType.includes('常平')) return 'C'
  if (docType.includes('委外')) return 'O'
  return 'T'
}

// ==================== ArgoERP 匯出欄位定義 ====================
interface ExportColumn {
  key: string
  label: string
  typeLabel: string
}

const EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'mo_number', label: '製令單號', typeLabel: '文字(32)' },
  { key: 'planned_start_date', label: '預定投產日', typeLabel: '日期' },
  { key: 'planned_end_date', label: '預定結案日', typeLabel: '日期' },
  { key: 'mo_status', label: '製令狀態', typeLabel: '文字(10)' },
  { key: 'status_date', label: '狀態設定日', typeLabel: '日期' },
  { key: 'department', label: '部門', typeLabel: '文字(13)' },
  { key: 'cost_department', label: '成本部門', typeLabel: '文字(32)' },
  { key: 'seq_number', label: '編號', typeLabel: '數字' },
  { key: 'product_code', label: '生產貨號', typeLabel: '文字(64)' },
  { key: 'version', label: '版本', typeLabel: '數字' },
  { key: 'lot_number', label: '批號', typeLabel: '文字(32)' },
  { key: 'datecode', label: 'DATECODE', typeLabel: '文字(32)' },
  { key: 'attr_a', label: '料件屬性A', typeLabel: '文字(32)' },
  { key: 'attr_b', label: '料件屬性B', typeLabel: '文字(32)' },
  { key: 'attr_c', label: '料件屬性C', typeLabel: '文字(32)' },
  { key: 'attr_d', label: '料件屬性D', typeLabel: '文字(32)' },
  { key: 'planned_qty', label: '預訂產出量', typeLabel: '數字' },
  { key: 'delivered_qty', label: '已繳庫數量', typeLabel: '數字' },
  { key: 'bom_level', label: 'BOM製造批料階數', typeLabel: '數字' },
  { key: 'product_cost_ratio', label: '成品工費分攤約當比例', typeLabel: '數字' },
  { key: 'material_cost_ratio', label: '直接原料分攤約當比例', typeLabel: '數字' },
  { key: 'source_order', label: '來源訂單', typeLabel: '文字(32)' },
  { key: 'source_order_line', label: '來源訂單項號', typeLabel: '數字' },
  { key: 'mo_note', label: '製令說明', typeLabel: '文字(2000)' },
  { key: 'create_date', label: '開立日期', typeLabel: '日期' },
  { key: 'auto_material', label: '自動批備料', typeLabel: '文字(200)' },
  { key: 'batch_number', label: '批次號', typeLabel: '文字(64)' },
  { key: 'project_code', label: '專案代號', typeLabel: '文字(32)' },
  { key: 'custom_1', label: '自定義欄位1', typeLabel: '文字(200)' },
  { key: 'custom_2', label: '自定義欄位2', typeLabel: '文字(200)' },
  { key: 'custom_3', label: '自定義欄位3', typeLabel: '文字(200)' },
  { key: 'custom_4', label: '自定義欄位4', typeLabel: '文字(200)' },
  { key: 'custom_5', label: '自定義欄位5', typeLabel: '文字(200)' },
  { key: 'custom_6', label: '自定義欄位6', typeLabel: '文字(200)' },
  { key: 'mo_type', label: '製令型態', typeLabel: '文字(32)' },
  { key: 'box_label_report', label: '站間盒裝標籤報表代碼', typeLabel: '文字(32)' },
  { key: 'carton_label_report', label: '外箱標籤報表代碼', typeLabel: '文字(32)' },
  { key: 'pallet_label_report', label: '棧板標籤報表代碼', typeLabel: '文字(32)' },
  { key: 'routing_code', label: '途程代碼', typeLabel: '文字(32)' },
  { key: 'packing_qty', label: '包裝數量', typeLabel: '數字' },
]

// ==================== ArgoERP IFAF028 介面欄位代碼對應 ====================
// 將內部英文 key 轉為 ArgoERP 介面實際接受的「轉檔欄位」代碼
// 來源：IFAF028 製令介面轉檔（PJ_PROJECT / PJ_PROJECTDETAIL → PJ_PROJECTDETAIL_MO_INTERFACE）
const ERP_FIELD_CODE_MAP: Record<string, string> = {
  mo_number: 'PROJECT_ID',
  planned_start_date: 'BEGIN_DATE',
  planned_end_date: 'END_DATE',
  mo_status: 'HOLD_STATUS',
  status_date: 'STATUS_DATE',
  // 部門/成本部門：必填欄位 (V)。注意 ERP 規格代碼是 SEG_ 不是 SBG_（之前 typo 導致 invalid column）
  department: 'SEG_SEGMENT_NO_DEPARTMENT',
  cost_department: 'PJT_SEG_SEGMENT_NO',
  seq_number: 'LINE_NO',
  product_code: 'MBP_PART',
  version: 'MBP_VER',
  lot_number: 'MBP_LOT_NO',
  datecode: 'MBP_DATECODE',
  attr_a: 'MBP_REFERENCEA',
  attr_b: 'MBP_REFERENCEB',
  attr_c: 'MBP_REFERENCEC',
  attr_d: 'MBP_REFERENCED',
  planned_qty: 'ORDER_QTY',
  delivered_qty: 'ACTUAL_QTY',
  bom_level: 'BOM_LEVELS',
  product_cost_ratio: 'EQUIVALENT_RATIO',
  material_cost_ratio: 'EQUIVALENT_RATIO_M',
  source_order: 'PJT_PROJECT_ID_MO_SO',
  source_order_line: 'LINE_NO_MO_SO',
  mo_note: 'REMARK_LINE',
  create_date: 'MO_BEGIN_DATE',
  auto_material: 'AUTO_PREPARE',
  batch_number: 'BATCH_NO',
  project_code: 'PJT_TASK_ID',
  custom_1: 'PDL01C',
  custom_2: 'PDL02C',
  custom_3: 'PDL03C',
  custom_4: 'PDL04C',
  custom_5: 'PDL05C',
  custom_6: 'PDL06C',
  mo_type: 'MO_TYPE',
  box_label_report: 'INNER_BOX_LABEL_ID',
  carton_label_report: 'BOX_LABEL_ID',
  pallet_label_report: 'PAL_LABEL_ID',
  routing_code: 'ROUTING_ID',
  packing_qty: 'QTY_PACK',
}

// 將內部 ExportRow（英文 key）轉換為 ArgoERP 介面 payload（ERP 欄位代碼為 key）
// 只送有值的欄位，避免 ORA-00957（duplicate column）— 某些欄位 ERP 程序內部會自填，
// 若我們再送空字串會造成重複欄位錯誤。
function toErpPayload(rows: ExportRow[]): Array<Record<string, string>> {
  return rows.map(row => {
    const erp: Record<string, string> = {}
    for (const [internalKey, value] of Object.entries(row)) {
      const erpCode = ERP_FIELD_CODE_MAP[internalKey]
      if (!erpCode) continue
      const v = (value ?? '').trim()
      if (!v) continue   // 空值不送，避免覆蓋/重複到 ERP 程序自填的欄位
      erp[erpCode] = v
    }
    return erp
  })
}

// 有對應來源資料的欄位 key（用於高亮顯示）
const MAPPED_KEYS = new Set([
  'mo_number', 'planned_start_date', 'planned_end_date', 'mo_status',
  'department', 'cost_department', 'seq_number', 'product_code', 'version',
  'lot_number', 'planned_qty', 'bom_level', 'product_cost_ratio',
  'material_cost_ratio', 'source_order', 'source_order_line', 'mo_note', 'create_date', 'auto_material',
])

type ExportRow = Record<string, string>

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

// ==================== 工具函式 ====================
function formatDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// 以 byte 長度截斷字串（UTF-8）——中文一字 3 bytes、英數 1 byte
function truncateByByteLength(text: string, maxBytes: number): string {
  if (!text) return ''
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8')
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  // 從 maxBytes 位置往前品找不會切斷多字节字符的位置
  let cut = maxBytes
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--
  return decoder.decode(bytes.slice(0, cut))
}

// 取得下一個工作日（跳過六日）
function getNextBusinessDay(from: Date): Date {
  const d = new Date(from)
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1)
  }
  return d
}

function getImportConfig(factory: 'T' | 'C' | 'O') {
  if (factory === 'T') {
    return { interfaceId: 'IFAF028', targetLabel: '製令', shortLabel: 'MOT' }
  }
  return { interfaceId: 'IFAF044', targetLabel: '採購單', shortLabel: factory === 'C' ? 'MOC' : 'MOO' }
}

// ==================== 批次映射（需要一次處理全部來計算流水號）====================
// 流水號來源：以 Supabase 製令總表為準（DB 唯一鍵 mo_number 是最後防線），
// localStorage 只是離線備援。每次匯入/儲存前會先 prefetchSeqFromDb() 同步最新狀態。
//
// 模組層 cache：key = "MOT20260422" → 該日該前綴在 DB 已用過的最大流水號
const seqCacheFromDb = new Map<string, number>()

async function prefetchSeqFromDb(): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    const res = await fetch(`/api/argoerp/mo-summary`, {
      cache: 'no-store',
    })
    if (!res.ok) return
    const json = await res.json()
    const records: Array<{ mo_number?: string }> = json?.records ?? []
    const maxByKey = new Map<string, number>()
    for (const r of records) {
      const mo = r?.mo_number ?? ''
      // 期望格式：MOT/MOC/MOO + 8碼日期 + 3碼流水
      const m = mo.match(/^(MO[TCO])(\d{8})(\d{3})$/)
      if (!m) continue
      const key = `${m[1]}${m[2]}`
      const seq = Number(m[3])
      const cur = maxByKey.get(key) ?? 0
      if (seq > cur) maxByKey.set(key, seq)
    }
    // 寫回模組 cache（以 DB 為準，覆蓋舊值）
    for (const [k, v] of maxByKey) seqCacheFromDb.set(k, v)
  } catch {
    // 網路異常時靜默 fallback 到 localStorage；DB 唯一鍵會擋下重複寫入
  }
}

// 從 localStorage 取得指定前綴+日期已使用過的最大流水號（離線/未 prefetch 時 fallback）
function getMaxUsedSeqFromLocal(prefix: string, dateDigits: string): number {
  if (typeof window === 'undefined') return 0
  try {
    const records: Array<{ mo_number?: string }> = JSON.parse(localStorage.getItem(MO_SUMMARY_KEY) ?? '[]')
    const headLen = prefix.length + dateDigits.length // 例: MOT + 20260422 = 11
    let max = 0
    for (const r of records) {
      const mo = r?.mo_number ?? ''
      if (mo.length !== headLen + 2) continue
      if (!mo.startsWith(prefix + dateDigits)) continue
      const seq = Number(mo.slice(headLen))
      if (Number.isFinite(seq) && seq > max) max = seq
    }
    return max
  } catch {
    return 0
  }
}

// 流水號起點：取 DB cache 與 localStorage 兩者最大值
function getMaxUsedSeq(prefix: string, dateDigits: string): number {
  const dbMax = seqCacheFromDb.get(`${prefix}${dateDigits}`) ?? 0
  const localMax = getMaxUsedSeqFromLocal(prefix, dateDigits)
  return Math.max(dbMax, localMax)
}

// 從銷售訂單號解析日期（8碼 YYYYMMDD）
// 格式：英文前綴 + YY(2) + MM(2) + DD(2) + 後綴，例 RO26050101 → 20260501
// 從銷售訂單號取出英文前綴後的完整數字串
// 例：RO26042801 → "26042801"、RO26050101 → "26050101"
function parseSoDateDigits(orderNumber: string): string | null {
  const m = orderNumber.match(/^[A-Za-z]+(\d+)/)
  if (!m) return null
  return m[1]
}

function mapAllToExport(srcRows: SourceRow[], matchResults?: SoMatchResult[]): ExportRow[] {
  const today = new Date()
  const todayStr = formatDate(today)
  const nextBizDay = formatDate(getNextBusinessDay(today))
  // 今日日期作為 fallback（當 SO 號無法解析時使用）
  const todayDateDigits = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

  return srcRows.map((src, rowIndex) => {
    const row: ExportRow = {}
    EXPORT_COLUMNS.forEach(col => { row[col.key] = '' })

    // 製令單號：MO + 廠別(T/C/O) + 來源單號日期(YYYYMMDD) + 兩碼序號
    // 末兩碼直接取 source_order_line（來源訂單項號 LINE_NO），例 LINE_NO=5 → 05
    // 日期取自來源銷售訂單號（例 RO26050101 → 20260501），無法解析時 fallback 今日
    const prefix = src.factory === 'O' ? 'MOO' : `MO${src.factory}`
    const soDateDigits = parseSoDateDigits(src.order_number) ?? todayDateDigits
    const lineNo = matchResults?.[rowIndex]?.line_no
    const seqStr = lineNo ? String(Number(lineNo)).padStart(2, '0') : '00'
    row.mo_number = `${prefix}${soDateDigits}${seqStr}`

    row.planned_start_date = nextBizDay                // 預定投產日：下一個工作日
    row.planned_end_date = src.delivery_date            // 預定結案日：交付日期
    row.mo_status = 'OPEN'                             // 製令狀態
    row.department = 'M1100'                           // 部門
    row.cost_department = 'M1000'                      // 成本部門
    row.seq_number = lineNo ? String(Number(lineNo)) : '1'  // 編號：來源訂單項號（LINE_NO）
    row.product_code = src.item_code                   // 生產貨號：品項編碼
    row.version = '1'                                  // 版本
    // 批號(MBP_LOT_NO)：來源訂單號截斷 30 bytes（ERP 欄位限制 32 bytes，留餘裕）
    row.lot_number = truncateByByteLength(src.order_number, 30)
    row.custom_1 = ''                                  // 自定義欄位1：暫不送出
    row.planned_qty = src.quantity                     // 預訂產出量：數量
    row.bom_level = '99'                               // BOM製造批料階數
    row.product_cost_ratio = '1'                       // 成品工費分攤約當比例
    row.material_cost_ratio = '1'                      // 直接原料分攤約當比例
    row.source_order = src.order_number                // 來源訂單：工單編號
    row.source_order_line = matchResults?.[rowIndex]?.line_no ?? ''  // 來源訂單項號：SO 行號（ERP 比對）
    row.mo_note = [src.item_name, src.note].filter(Boolean).join(' ')  // 製令說明：品名/規格+備註
    row.create_date = todayStr                         // 開立日期：今天
    row.auto_material = 'N'                            // 自動批備料

    return row
  })
}

// ==================== localStorage ====================
const STORAGE_KEY = 'argoerp_order_batch_export_v2'
const FAILED_IMPORTS_KEY = 'argoerp_failed_imports'

// ==================== TSV 解析器（處理含 Tab/換行的引號欄位）====================
function parseTSV(text: string): string[][] {
  const rows: string[][] = []
  let current = ''
  let cells: string[] = []
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else {
      if (ch === '"' && current.trim() === '') {
        inQuotes = true
        current = ''
      } else if (ch === '\t') {
        cells.push(current.trim())
        current = ''
      } else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        if (ch === '\r') i++
        cells.push(current.trim())
        if (cells.some(c => c !== '')) rows.push(cells)
        cells = []
        current = ''
      } else if (ch === '\r') {
        cells.push(current.trim())
        if (cells.some(c => c !== '')) rows.push(cells)
        cells = []
        current = ''
      } else {
        current += ch
      }
    }
  }
  // 最後一行
  cells.push(current.trim())
  if (cells.some(c => c !== '')) rows.push(cells)

  return rows
}

function loadFromStorage(): SourceRow[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveToStorage(rows: SourceRow[]) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(rows)) } catch {}
}

function loadFailedImports(): FailedImportItem[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(FAILED_IMPORTS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveFailedImports(items: FailedImportItem[]) {
  try {
    if (items.length === 0) {
      localStorage.removeItem(FAILED_IMPORTS_KEY)
      return
    }
    localStorage.setItem(FAILED_IMPORTS_KEY, JSON.stringify(items))
  } catch {}
}

const MO_SUMMARY_KEY = 'argoerp_mo_summary'

function buildSummaryRecords(sourceRows: SourceRow[], savedAt: string, matchResults?: SoMatchResult[]) {
  return mapAllToExport(sourceRows, matchResults).map((row, index) => ({
    mo_number: row.mo_number,
    planned_start_date: row.planned_start_date,
    planned_end_date: row.planned_end_date,
    mo_status: row.mo_status,
    department: row.department,
    product_code: row.product_code,
    // lot_number 顯示來源訂單號（已在 mapAllToExport 截斷 30 bytes）
    lot_number: row.lot_number,
    planned_qty: row.planned_qty,
    source_order: row.source_order,
    mo_note: row.mo_note,
    create_date: row.create_date,
    factory: sourceRows[index]?.factory ?? 'T',
    saved_at: savedAt,
    plate_count: sourceRows[index]?.plate_count ?? '',
  }))
}

function saveRecordsToSummaryLocal(records: ReturnType<typeof buildSummaryRecords>) {
  const existing = JSON.parse(localStorage.getItem(MO_SUMMARY_KEY) ?? '[]')
  const existingMap = new Map(existing.map((record: { mo_number: string }) => [record.mo_number, record]))

  records.forEach(record => {
    existingMap.set(record.mo_number, record)
  })

  localStorage.setItem(MO_SUMMARY_KEY, JSON.stringify([...existingMap.values()]))
}

// 寫入 Supabase 製令總表（DB 唯一鍵會擋重複）。失敗會 throw。
async function saveRecordsToSummaryDb(records: ReturnType<typeof buildSummaryRecords>): Promise<void> {
  const res = await fetch('/api/argoerp/mo-summary', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records }),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || !json?.success) {
    const msg = json?.error || `HTTP ${res.status}`
    const err = new Error(msg) as Error & { duplicate?: boolean }
    if (json?.duplicate) err.duplicate = true
    throw err
  }
}

// 雙寫：先寫 DB，DB 成功再寫 localStorage（讓 DB 為主、本地為備援）
async function saveRecordsToSummary(records: ReturnType<typeof buildSummaryRecords>): Promise<void> {
  await saveRecordsToSummaryDb(records)
  try { saveRecordsToSummaryLocal(records) } catch {}
  // 同步更新 seq cache
  for (const r of records) {
    const m = r.mo_number.match(/^(MO[TCO])(\d{8})(\d{3})$/)
    if (!m) continue
    const key = `${m[1]}${m[2]}`
    const seq = Number(m[3])
    const cur = seqCacheFromDb.get(key) ?? 0
    if (seq > cur) seqCacheFromDb.set(key, seq)
  }
}

function createSourceRowKey(row: SourceRow): string {
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

function mergeSourceRows(existing: SourceRow[], additions: SourceRow[]): SourceRow[] {
  const rowMap = new Map(existing.map(row => [createSourceRowKey(row), row]))
  additions.forEach(row => {
    rowMap.set(createSourceRowKey(row), row)
  })
  return [...rowMap.values()]
}

function mergeFailedImports(existing: FailedImportItem[], rows: SourceRow[], error: string, attemptedAt: string): FailedImportItem[] {
  const itemMap = new Map(existing.map(item => [item.key, item]))
  rows.forEach(row => {
    const key = createSourceRowKey(row)
    itemMap.set(key, {
      key,
      row,
      factory: row.factory,
      error,
      attemptedAt,
    })
  })
  return [...itemMap.values()]
}

function removeFailedImportsByRows(existing: FailedImportItem[], rows: SourceRow[]): FailedImportItem[] {
  const keys = new Set(rows.map(createSourceRowKey))
  return existing.filter(item => !keys.has(item.key))
}

function sourceRowsToTsv(rows: SourceRow[]): string {
  const header = INPUT_COLUMNS.join('\t')
  const lines = rows.map(row => [
    row.order_number,
    '',
    row.doc_type,
    row.receiver,
    row.is_sample,
    row.has_material,
    row.designer,
    row.customer,
    row.line_nickname,
    row.handler,
    row.issuer,
    row.item_code,
    row.item_name,
    row.note,
    row.quantity,
    row.delivery_date,
    row.plate_count,
    row.upload_ro,
    row.order_status,
    row.pm_note,
  ].join('\t'))
  return [header, ...lines].join('\n')
}

function factoryLabel(factory: 'T' | 'C' | 'O'): string {
  if (factory === 'O') return '委外'
  if (factory === 'C') return '常平'
  return '台北'
}

// ==================== 元件 ====================
export default function OrderBatchExportPage() {
  const [pasteText, setPasteText] = useState('')
  const [sourceRows, setSourceRows] = useState<SourceRow[]>([])
  const [parseError, setParseError] = useState('')
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())
  const [showPasteArea, setShowPasteArea] = useState(true)
  const [viewMode, setViewMode] = useState<'source' | 'export'>('source')
  const [exportFormat, setExportFormat] = useState<'csv' | 'xlsx'>('csv')
  const [saveMsg, setSaveMsg] = useState('')
  const [importingFactory, setImportingFactory] = useState<'T' | 'C' | 'O' | null>(null)
  const [failedImports, setFailedImports] = useState<FailedImportItem[]>([])
  const [importPreview, setImportPreview] = useState<{
    factory: 'T' | 'C' | 'O'
    dbMax: number
    skippedCount: number
    rows: Array<{ mo_number: string; product_code: string; source_order: string; source_order_line: string; planned_qty: string; custom_1: string; planned_end_date: string }>
  } | null>(null)
  const [poLinks, setPoLinks] = useState<Array<{
    po_project_id: string; pdl_seq: number | null; so_project_id: string; pdl_seq_so: number | null; line_no: string; mbp_part: string; order_qty_oru: number | null
  }> | null>(null)
  const [poLinksLoading, setPoLinksLoading] = useState(false)
  const [soMatchResults, setSoMatchResults] = useState<SoMatchResult[]>([])
  const [soMatchLoading, setSoMatchLoading] = useState(false)

  // ---- ERP 销售訂單 比對（品項編碼 + 數量 對源單號 + 行號）----
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
      // Group: project_id + mbp_part + qty → sorted candidates
      const candidateMap = new Map<string, Array<{ line_no: string; pdl_seq: number | null }>>()
      for (const line of lines) {
        const qty = Number(line.order_qty_oru ?? 0)
        const key = `${line.project_id}|${line.mbp_part ?? ''}|${qty}`
        if (!candidateMap.has(key)) candidateMap.set(key, [])
        candidateMap.get(key)!.push({ line_no: String(line.line_no ?? ''), pdl_seq: line.pdl_seq != null ? Number(line.pdl_seq) : null })
      }
      // Sort each group by line_no ascending (numeric)
      for (const arr of candidateMap.values()) {
        arr.sort((a, b) => (Number(a.line_no) || 0) - (Number(b.line_no) || 0))
      }
      // Assign line_no in order, duplicates get next candidate
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

  // 還原暫存
  useEffect(() => {
    const saved = loadFromStorage()
    const failed = loadFailedImports()
    if (saved.length > 0) {
      setSourceRows(saved)
      setShowPasteArea(false)
    }
    if (failed.length > 0) {
      setFailedImports(failed)
    }
  }, [])

  // 自動暫存
  useEffect(() => {
    if (sourceRows.length > 0) saveToStorage(sourceRows)
  }, [sourceRows])

  useEffect(() => {
    saveFailedImports(failedImports)
  }, [failedImports])

  // ---- 解析來源資料 ----
  const handleParse = useCallback(() => {
    setParseError('')
    const text = pasteText.trim()
    if (!text) { setParseError('請先貼上資料'); return }

    // 使用支援引號欄位的 TSV 解析器（處理含 Tab/換行的儲存格）
    const allRows = parseTSV(text)
    if (allRows.length === 0) { setParseError('未偵測到有效資料行'); return }

    // 偵測 header 行（包含任一關鍵欄位名稱就跳過）
    // 跳過標題列：檢查每一行開頭，若不像工單編號（RO 開頭）就當 header 跳過
    let startIdx = 0
    const headerKeywords = [
      '工單編號', '品項編碼', '單據種類', '品名/規格', '交付日期', '訂單狀態',
      '生產廠別', '承辦人', '開單人員', '客戶', '美編', '序號', '備註',
    ]
    for (let h = 0; h < Math.min(allRows.length, 3); h++) {
      const rowCells = allRows[h]
      const lineText = rowCells.join('\t')
      const firstCell = rowCells[0]?.trim() ?? ''
      // 如果該行包含任一標題關鍵字，或第一格不是 RO 開頭的工單編號，就跳過
      if (headerKeywords.some(kw => lineText.includes(kw)) || (!firstCell.match(/^RO\d/) && h === startIdx)) {
        startIdx = h + 1
      } else {
        break
      }
    }

    const parsed: SourceRow[] = []
    for (let i = startIdx; i < allRows.length; i++) {
      const cells = allRows[i]
      const docType = (cells[2] ?? '').trim()
      const row: SourceRow = {
        order_number: (cells[0] ?? '').trim(),
        // cells[1] 是空欄，跳過
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
        quantity: (cells[14] ?? '').trim(),
        delivery_date: (cells[15] ?? '').trim(),
        plate_count: (cells[16] ?? '').trim(),
        upload_ro: (cells[17] ?? '').trim(),
        order_status: (cells[18] ?? '').trim(),
        pm_note: (cells[19] ?? '').trim(),
      }
      // 至少要有工單編號或品項編碼才算有效
      if (row.order_number || row.item_code) {
        parsed.push(row)
      }
    }

    if (parsed.length === 0) {
      setParseError('未解析到有效資料，請確認資料是從 Excel 以 Tab 分隔複製')
      return
    }

    setSourceRows(prev => {
      const nextRows = [...prev, ...parsed]
      buildSoMatches(nextRows)
      return nextRows
    })
    setPasteText('')
    setShowPasteArea(false)
  }, [pasteText, buildSoMatches])

  // ---- 切換選取列的廠別 ----
  const handleToggleFactory = useCallback((target: 'T' | 'C' | 'O') => {
    if (selectedRows.size === 0) return
    setSourceRows(prev => prev.map((row, i) =>
      selectedRows.has(i) ? { ...row, factory: target } : row
    ))
  }, [selectedRows])

  // ---- 下載匯出檔案（可重複使用）----
  const doExport = useCallback((exportRows: ExportRow[], suffix: string) => {
    const now = new Date()
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    const filename = suffix ? `ArgoERP_製令匯出_${suffix}_${ts}` : `ArgoERP_製令匯出_${ts}`

    const headers = EXPORT_COLUMNS.map(c => c.label)
    const typeDefs = EXPORT_COLUMNS.map(c => c.typeLabel)
    const dataRows = exportRows.map(row => EXPORT_COLUMNS.map(col => row[col.key] ?? ''))

    if (exportFormat === 'xlsx') {
      const wsData = [headers, typeDefs, ...dataRows]
      const ws = XLSX.utils.aoa_to_sheet(wsData)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, '製令匯出')
      XLSX.writeFile(wb, `${filename}.xlsx`)
    } else {
      const csvLines: string[] = []
      csvLines.push(headers.join(','))
      csvLines.push(typeDefs.join(','))
      dataRows.forEach(cells => {
        const line = cells.map(val => {
          if (val.includes(',') || val.includes('\n') || val.includes('"')) {
            return `"${val.replace(/"/g, '""')}"`
          }
          return val
        })
        csvLines.push(line.join(','))
      })
      const BOM = '\uFEFF'
      const blob = new Blob([BOM + csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${filename}.csv`
      a.click()
      URL.revokeObjectURL(url)
    }
  }, [exportFormat])

  // ---- 匯出全部（CSV / XLSX）----
  const handleExport = useCallback(() => {
    if (sourceRows.length === 0) return
    doExport(mapAllToExport(sourceRows, soMatchResults), '')
  }, [sourceRows, soMatchResults, doExport])

  // ---- 依廠別匯出 ----
  const handleExportByFactory = useCallback((factory: 'T' | 'C' | 'O') => {
    const filtered = sourceRows.filter(r => r.factory === factory)
    if (filtered.length === 0) return
    const suffixMap = { T: 'MOT_台北', C: 'MOC_常平', O: 'MOO_委外' }
    doExport(mapAllToExport(filtered), suffixMap[factory])
  }, [sourceRows, doExport])

  // ---- 儲存至總表 ----
  const handleSaveToSummary = useCallback(async () => {
    if (sourceRows.length === 0) return
    const nowStr = new Date().toLocaleString('zh-TW')
    try {
      // 先從 Supabase 同步所有已使用的流水號 → 避免不同裝置同時誤出同號
      await prefetchSeqFromDb()

      const newRecords = buildSummaryRecords(sourceRows, nowStr, soMatchResults)
      await saveRecordsToSummary(newRecords)
      setSaveMsg(`✅ 已儲存 ${newRecords.length} 筆至製令總表（Supabase）`)
      setTimeout(() => setSaveMsg(''), 3000)
    } catch (e) {
      const msg = e instanceof Error ? e.message : '儲存失敗'
      setSaveMsg(`❌ 儲存失敗：${msg}`)
      setTimeout(() => setSaveMsg(''), 5000)
    }
  }, [sourceRows])

  // ---- 匯入 ERP 並儲存至總表 ----
  const handleImportToErp = useCallback(async (factory: 'T' | 'C' | 'O') => {
    const withIdx = sourceRows.map((r, i) => ({ r, i })).filter(({ r }) => r.factory === factory)
    if (withIdx.length === 0) return
    const allMatch = withIdx.map(({ i }) => soMatchResults[i])

    // 分離有序號 vs 無序號 — 無序號不可匯入，移入暫緩區
    const withSeqIdx = withIdx.filter((_, j) => !!allMatch[j]?.line_no)
    const noSeqIdx = withIdx.filter((_, j) => !allMatch[j]?.line_no)
    if (noSeqIdx.length > 0) {
      const attemptedAt = new Date().toLocaleString('zh-TW')
      setFailedImports(prev => mergeFailedImports(
        prev,
        noSeqIdx.map(({ r }) => r),
        '來源訂單序號未比對到，請確認 ERP 同步後重新比對',
        attemptedAt
      ))
    }
    if (withSeqIdx.length === 0) {
      alert('⚠️ 本批次所有列均無法比對序號，已移入暫緩區，無資料可匯入。')
      return
    }

    const filteredRows = withSeqIdx.map(({ r }) => r)
    const filteredMatch = withSeqIdx.map(({ i }) => soMatchResults[i])

    // 先同步 Supabase 製令總表中所有已用流水號 → 使 mo_number 生成不撒號
    await prefetchSeqFromDb()

    const { interfaceId, targetLabel } = getImportConfig(factory)
    const exportRows = mapAllToExport(filteredRows, filteredMatch)
    // 所有介面一律轉換為 ERP 欄位代碼（IFAF028 製令、IFAF044 採購單皆使用相同欄位代碼）
    const payload = toErpPayload(exportRows)

    setImportingFactory(factory)
    setSaveMsg('')

    console.log('[ArgoERP 匯入] 開始', { factory, interfaceId, count: payload.length, sample: payload[0] })

    try {
      const response = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'import',
          interfaceId,
          data: payload,
        }),
      })

      const result = await response.json()
      console.log('[ArgoERP 匯入] API 回應', { httpStatus: response.status, result })

      const errorMessage =
        result?.error ||
        result?.message ||
        result?.apiResult?.ERROR ||
        result?.apiResult?.error ||
        result?.rawText
      const isSuccess = response.ok && result?.success === true

      if (!isSuccess) {
        throw new Error(errorMessage || `ArgoERP 匯入失敗 (HTTP ${response.status})`)
      }

      const nowStr = new Date().toLocaleString('zh-TW')
      const records = buildSummaryRecords(filteredRows, nowStr, filteredMatch)
      try {
        await saveRecordsToSummary(records)
      } catch (saveErr) {
        const sm = saveErr instanceof Error ? saveErr.message : '未知錯誤'
        console.error('[ArgoERP 匯入] DB 儲存總表失敗', saveErr)
        alert(`⚠️ ERP 已匯入成功，但製令總表（Supabase）儲存失敗：${sm}\n\n請記下以下製令號並手動補登：\n${records.map(r => r.mo_number).join(', ')}`)
      }

      // 寫入製令上傳紀錄（fire-and-forget，不阻塞主流程）
      fetch('/api/argoerp/mo-upload-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: records.map(r => ({
            mo_number:          r.mo_number,
            factory:            r.factory,
            product_code:       r.product_code,
            planned_qty:        r.planned_qty,
            source_order:       r.source_order,
            lot_number:         r.lot_number,
            mo_note:            r.mo_note,
            planned_start_date: r.planned_start_date,
            planned_end_date:   r.planned_end_date,
            create_date:        r.create_date,
            interface_id:       interfaceId,
          })),
        }),
      }).catch(err => console.warn('[製令上傳紀錄] 寫入失敗（不影響主流程）', err))
      setFailedImports(prev => removeFailedImportsByRows(prev, filteredRows))

      // 從主清單移除已成功匯入的訂單，避免重複匯入
      const importedKeys = new Set(filteredRows.map(createSourceRowKey))
      setSourceRows(prev => prev.filter(r => !importedKeys.has(createSourceRowKey(r))))
      setSelectedRows(new Set())

      const successMsg = `✅ ${factoryLabel(factory)} ${records.length} 筆已匯入 ERP ${targetLabel}並儲存至製令總表`
      setSaveMsg(successMsg)
      // 顯示首筆製令號 + ERP 原始回應，確認資料有進 ERP（DEBUG 用，確認後可移除）
      const firstMo = records[0]?.mo_number ?? '?'
      const erpRaw = typeof result?.rawText === 'string'
        ? result.rawText.slice(0, 400)
        : JSON.stringify(result?.apiResult ?? '').slice(0, 400)
      alert(`${successMsg}\n\n首筆製令號：${firstMo}\n\n【ERP 原始回應（前400字）】\n${erpRaw}`)

      setTimeout(() => setSaveMsg(''), 6000)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ArgoERP 匯入失敗'
      console.error('[ArgoERP 匯入] 失敗', error)
      const attemptedAt = new Date().toLocaleString('zh-TW')
      setFailedImports(prev => mergeFailedImports(prev, filteredRows, message, attemptedAt))
      const errMsg = `❌ ${factoryLabel(factory)} ${targetLabel}匯入失敗：${message}\n${filteredRows.length} 筆已移至失敗區`
      setSaveMsg(errMsg)
      alert(errMsg)
      setTimeout(() => setSaveMsg(''), 8000)
    } finally {
      setImportingFactory(null)
    }
  }, [sourceRows, soMatchResults])

  // ---- 匯入前預覽：先跑 prefetch 取得最新 seq，再呈現將產生的製令單號讓使用者確認 ----
  const handleShowPreview = useCallback(async (factory: 'T' | 'C' | 'O') => {
    const withIdx = sourceRows.map((r, i) => ({ r, i })).filter(({ r }) => r.factory === factory)
    if (withIdx.length === 0) return
    const filteredMatch = withIdx.map(({ i }) => soMatchResults[i])

    // 分離有序號（來源訂單項號已比對）vs 無序號（移入暫緩區）
    const withSeqIdx = withIdx.filter((_, j) => !!filteredMatch[j]?.line_no)
    const noSeqIdx = withIdx.filter((_, j) => !filteredMatch[j]?.line_no)
    const noSeqCount = noSeqIdx.length

    // 無序號的列移入暫緩區（failedImports）
    if (noSeqIdx.length > 0) {
      const attemptedAt = new Date().toLocaleString('zh-TW')
      setFailedImports(prev => mergeFailedImports(
        prev,
        noSeqIdx.map(({ r }) => r),
        '來源訂單序號未比對到，請確認 ERP 同步後重新比對',
        attemptedAt
      ))
    }

    if (withSeqIdx.length === 0) {
      alert(`⚠️ ${noSeqCount} 筆均無法比對序號，已全數移入暫緩區。\n請重新同步 SO 後再比對序號。`)
      return
    }

    const withSeqRows = withSeqIdx.map(({ r }) => r)
    const withSeqMatch = withSeqIdx.map(({ i }) => soMatchResults[i])

    try {
      await prefetchSeqFromDb()
    } catch {
      alert('⚠️ 無法連線 Supabase 查詢已用流水號，將使用本機暫存作為備援。\n如 dev server 剛重啟，請確認 SUPABASE_SERVICE_ROLE 已設定。')
    }
    const prefix = factory === 'O' ? 'MOO' : `MO${factory}`
    // dbMax：取本批次所有 SO 日期中已用的最大流水號（供預覽提示用）
    const today = new Date()
    const todayFallback = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`
    const soDateDigitsInBatch = [...new Set(withSeqRows.map(r => parseSoDateDigits(r.order_number) ?? todayFallback))]
    const dbMax = Math.max(0, ...soDateDigitsInBatch.map(d => (seqCacheFromDb as Map<string, number>).get(`${prefix}${d}`) ?? 0))
    const exportRows = mapAllToExport(withSeqRows, withSeqMatch)
    setImportPreview({
      factory,
      dbMax,
      skippedCount: noSeqCount,
      rows: exportRows.map(r => ({
        mo_number: r.mo_number,
        product_code: r.product_code,
        source_order: r.source_order,
        source_order_line: r.source_order_line,
        planned_qty: r.planned_qty,
        custom_1: r.custom_1,
        planned_end_date: r.planned_end_date,
      })),
    })
  }, [sourceRows, soMatchResults])

  const handleRestoreFailedToSource = useCallback((mode: 'append' | 'replace') => {
    if (failedImports.length === 0) return

    const failedRows = failedImports.map(item => item.row)
    setSourceRows(prev => mode === 'replace' ? failedRows : mergeSourceRows(prev, failedRows))
    setSelectedRows(new Set())
    setShowPasteArea(false)
    setViewMode('source')
    setSaveMsg(mode === 'replace' ? `✅ 已載入 ${failedRows.length} 筆失敗資料到主清單` : `✅ 已將 ${failedRows.length} 筆失敗資料加入主清單`)
    setTimeout(() => setSaveMsg(''), 4000)
  }, [failedImports])

  const handleSendFailedToPasteArea = useCallback(() => {
    if (failedImports.length === 0) return

    setPasteText(sourceRowsToTsv(failedImports.map(item => item.row)))
    setShowPasteArea(true)
    setViewMode('source')
    setSaveMsg(`✅ 已將 ${failedImports.length} 筆失敗資料送回貼上區，可直接修改後重新解析`)
    setTimeout(() => setSaveMsg(''), 4000)
  }, [failedImports])

  const handleRemoveFailedItem = useCallback((key: string) => {
    setFailedImports(prev => prev.filter(item => item.key !== key))
  }, [])

  const handleClearFailedImports = useCallback(() => {
    setFailedImports([])
  }, [])

  const handleCheckPoLinks = useCallback(async () => {
    setPoLinksLoading(true)
    setPoLinks(null)
    try {
      const res = await fetch('/api/argoerp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'fetch_po_pdl_links' }),
      })
      const json = await res.json()
      if (json.status === 'ok') {
        setPoLinks(json.links ?? [])
      } else {
        alert(`❌ 比對失敗：${json.error ?? '未知錯誤'}`)
      }
    } catch (e) {
      alert(`❌ 連線錯誤：${e}`)
    } finally {
      setPoLinksLoading(false)
    }
  }, [])
  // ---- 移至暫緩區 / 清空 ----
  const handleMoveToStaging = useCallback(async () => {
    if (selectedRows.size === 0) return
    const moving = sourceRows.filter((_, i) => selectedRows.has(i))
    try {
      const res = await fetch('/api/argoerp/staging', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: moving }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`)
      setSourceRows(prev => prev.filter((_, i) => !selectedRows.has(i)))
      setSelectedRows(new Set())
    } catch (e) {
      alert(`移至暫緩區失敗：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [selectedRows, sourceRows])

  const handleClearAll = useCallback(() => {
    setSourceRows([])
    setSelectedRows(new Set())
    localStorage.removeItem(STORAGE_KEY)
    setShowPasteArea(true)
  }, [])

  const toggleSelectAll = useCallback(() => {
    if (selectedRows.size === sourceRows.length) setSelectedRows(new Set())
    else setSelectedRows(new Set(sourceRows.map((_, i) => i)))
  }, [selectedRows, sourceRows])

  const toggleRow = useCallback((idx: number) => {
    setSelectedRows(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx); else next.add(idx)
      return next
    })
  }, [])

  // 來源預覽欄位（不含訂單狀態，生產廠別用特殊欄位處理）
  const SOURCE_DISPLAY_COLS: { key: keyof SourceRow; label: string }[] = [
    { key: 'order_number', label: '工單編號' },
    { key: 'doc_type', label: '單據種類' },
    // factory 用特殊欄位渲染，不在這裡
    { key: 'designer', label: '美編' },
    { key: 'customer', label: '客戶/供應商名' },
    { key: 'handler', label: '承辦人' },
    { key: 'issuer', label: '開單人員' },
    { key: 'item_code', label: '品項編碼' },
    { key: 'item_name', label: '品名/規格' },
    { key: 'note', label: '備註' },
    { key: 'quantity', label: '數量' },
    { key: 'delivery_date', label: '交付日期' },
    { key: 'plate_count', label: '盤數' },
  ]

  // 匯出預覽欄位（只顯示有資料的）
  const exportPreviewRows = useMemo(() => mapAllToExport(sourceRows), [sourceRows])
  const EXPORT_PREVIEW_COLS = EXPORT_COLUMNS.filter(col =>
    MAPPED_KEYS.has(col.key) || exportPreviewRows.some(r => r[col.key]?.trim())
  )

  return (
    <div className="min-h-screen bg-slate-950 text-white p-4 md:p-6">
      <div className="max-w-[1800px] mx-auto">
        {/* Header */}
        <div className="mb-6 border-b border-slate-800 pb-4 flex flex-col lg:flex-row lg:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">訂單批量轉製令匯出</h1>
            <p className="text-slate-400 mt-1 text-sm">ArgoERP — 貼上工單資料 → 設定廠別 → 匯出 CSV / XLSX</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => setShowPasteArea(v => !v)}
              className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors text-sm"
            >
              {showPasteArea ? '收合貼上區' : '📋 貼上資料'}
            </button>
            {sourceRows.length > 0 && (
              <>
                {/* 匯出格式選擇 */}
                <button
                  onClick={() => buildSoMatches(sourceRows)}
                  disabled={soMatchLoading}
                  className="px-4 py-2 rounded-lg bg-teal-800 hover:bg-teal-700 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm flex items-center gap-1.5"
                >
                  {soMatchLoading ? '比對中…' : (
                    <>
                      {soMatchResults.length > 0
                        ? `🔄 重新比對（${soMatchResults.filter(r => r.status === 'matched').length}/${soMatchResults.length} 已比對）`
                        : '🔍 比對來源單號'
                      }
                    </>
                  )}
                </button>
                <button
                  onClick={handleCheckPoLinks}
                  disabled={poLinksLoading}
                  className="px-4 py-2 rounded-lg bg-violet-800 hover:bg-violet-700 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm flex items-center gap-1.5"
                >
                  {poLinksLoading ? '查詢中…' : '🔗 比對採購單'}
                </button>
                <div className="flex bg-slate-800 rounded-lg p-0.5 border border-slate-700">
                  <button
                    onClick={() => setExportFormat('csv')}
                    className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${exportFormat === 'csv' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'}`}
                  >CSV</button>
                  <button
                    onClick={() => setExportFormat('xlsx')}
                    className={`px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${exportFormat === 'xlsx' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'}`}
                  >XLSX</button>
                </div>
                <button
                  onClick={handleExport}
                  className="px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium transition-colors text-sm flex items-center gap-1.5"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                  匯出 {exportFormat.toUpperCase()} ({sourceRows.length} 筆)
                </button>
                <button
                  onClick={handleSaveToSummary}
                  className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white font-medium transition-colors text-sm flex items-center gap-1.5"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                  儲存至總表
                </button>
                {saveMsg && (
                  <span className={`px-3 py-2 text-sm animate-pulse ${saveMsg.startsWith('❌') ? 'text-red-400' : 'text-emerald-400'}`}>{saveMsg}</span>
                )}
                {selectedRows.size > 0 && (
                  <>
                    {/* 廠別切換按鈕 */}
                    <button onClick={() => handleToggleFactory('T')} className="px-3 py-2 rounded-lg bg-blue-900/50 border border-blue-700/50 text-blue-300 hover:bg-blue-800 hover:text-white transition-colors text-sm">
                      選取 → 台北(T)
                    </button>
                    <button onClick={() => handleToggleFactory('C')} className="px-3 py-2 rounded-lg bg-orange-900/50 border border-orange-700/50 text-orange-300 hover:bg-orange-800 hover:text-white transition-colors text-sm">
                      選取 → 常平(C)
                    </button>
                    <button onClick={() => handleToggleFactory('O')} className="px-3 py-2 rounded-lg bg-purple-900/50 border border-purple-700/50 text-purple-300 hover:bg-purple-800 hover:text-white transition-colors text-sm">
                      選取 → 委外(O)
                    </button>
                    <button onClick={handleMoveToStaging} className="px-4 py-2 rounded-lg bg-amber-900/60 border border-amber-700/50 text-amber-300 hover:bg-amber-800 hover:text-white transition-colors text-sm">
                      移至暫緩區 ({selectedRows.size})
                    </button>
                  </>
                )}
                <button onClick={handleClearAll} className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:bg-red-900/40 hover:text-red-300 hover:border-red-700/50 transition-colors text-sm">
                  全部清空
                </button>
              </>
            )}
          </div>
        </div>

        <div className="mb-6 bg-slate-900 border border-slate-800 rounded-lg p-4">
          <h2 className="text-lg font-semibold text-white mb-3">流程狀態</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div className="flex items-center justify-between rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <span className="text-slate-400">已帶入流程</span>
              <span className="text-cyan-300 font-semibold">{sourceRows.length} 筆</span>
            </div>
            <div className="flex items-center justify-between rounded-lg bg-slate-950/60 border border-slate-800 px-3 py-2">
              <span className="text-slate-400">批備料作業</span>
              <span className="text-emerald-300 font-medium text-xs">請前往「生產批備料」頁面處理</span>
            </div>
          </div>
        </div>

        {/* 貼上區域 */}
        {showPasteArea && (
          <div className="mb-6 bg-slate-900 border border-slate-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              <h2 className="text-lg font-semibold text-white">貼上工單資料</h2>
            </div>
            <p className="text-xs text-slate-500 mb-2">
              這是備用入口。若來源單尚未進系統主檔，可從 Excel / Google Sheet 複製工單資料直接貼上，後續仍可走同一套 ARGO 轉換與 BOM 比對流程。
            </p>
            <textarea
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
              placeholder={"從 Excel 複製工單表格後貼上此處（Tab 分隔）...\n\n欄位順序：工單編號、單據種類、簽收人員、打樣、附素材、美編、客戶/供應商名、LINE暱稱、承辦人、開單人員、品項編碼、品名/規格、備註、數量、交付日期、盤數、上傳RO、訂單狀態、生管/物管備註"}
              className="w-full h-44 bg-slate-950 border border-slate-700 rounded-lg p-3 text-sm text-slate-200 font-mono resize-y focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/30 placeholder:text-slate-600"
            />
            {parseError && (
              <p className="mt-2 text-red-400 text-sm flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                {parseError}
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <button
                onClick={handleParse}
                disabled={!pasteText.trim()}
                className="px-5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 disabled:text-slate-500 text-white font-medium transition-colors text-sm"
              >
                解析並加入
              </button>
              <button
                onClick={() => setPasteText('')}
                className="px-4 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-white transition-colors text-sm"
              >
                清除文字
              </button>
            </div>
          </div>
        )}

        {/* 統計 + 視圖切換 */}
        {sourceRows.length > 0 && (
          <div className="mb-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-center gap-4 text-sm">
              <span className="text-slate-400">
                共 <span className="text-cyan-400 font-bold">{sourceRows.length}</span> 筆資料
              </span>
              {selectedRows.size > 0 && (
                <>
                  <span className="text-slate-600">|</span>
                  <span className="text-orange-400">已選取 {selectedRows.size} 筆</span>
                </>
              )}
            </div>
            <div className="flex bg-slate-800 rounded-lg p-0.5 border border-slate-700">
              <button
                onClick={() => setViewMode('source')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${viewMode === 'source' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                來源資料
              </button>
              <button
                onClick={() => setViewMode('export')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${viewMode === 'export' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:text-white'}`}
              >
                匯出預覽（ArgoERP 格式）
              </button>
            </div>
          </div>
        )}

        {/* 資料表格 */}
        {sourceRows.length > 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              {viewMode === 'source' ? (
                /* ---- 來源資料視圖 ---- */
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-800/80 border-b border-slate-700">
                      <th className="px-2 py-3 text-center sticky left-0 bg-slate-800/80 z-10 w-10">
                        <input type="checkbox" checked={selectedRows.size === sourceRows.length} onChange={toggleSelectAll}
                          className="rounded border-slate-600 bg-slate-700 text-cyan-500 focus:ring-cyan-500/30" />
                      </th>
                      <th className="px-2 py-3 text-center text-slate-500 font-mono text-xs w-10">#</th>
                      <th className="px-3 py-3 text-left text-slate-300 font-medium whitespace-nowrap text-xs">工單編號</th>
                      <th className="px-3 py-3 text-center text-slate-300 font-medium whitespace-nowrap text-xs min-w-[100px]">序號比對</th>
                      <th className="px-3 py-3 text-left text-slate-300 font-medium whitespace-nowrap text-xs">單據種類</th>
                      <th className="px-3 py-3 text-center text-slate-300 font-medium whitespace-nowrap text-xs min-w-[90px]">生產廠別</th>
                      {SOURCE_DISPLAY_COLS.filter(c => c.key !== 'order_number' && c.key !== 'doc_type').map(col => (
                        <th key={col.key} className={`px-3 py-3 text-left text-slate-300 font-medium whitespace-nowrap text-xs ${col.key === 'customer' ? 'max-w-[100px]' : ''}`}>
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sourceRows.map((row, idx) => (
                      <tr key={idx} className={`border-b border-slate-800/50 transition-colors ${selectedRows.has(idx) ? 'bg-cyan-950/30' : idx % 2 === 0 ? 'bg-slate-900/50' : 'bg-slate-900/20'} hover:bg-slate-800/50`}>
                        <td className="px-2 py-2 text-center sticky left-0 bg-inherit z-10">
                          <input type="checkbox" checked={selectedRows.has(idx)} onChange={() => toggleRow(idx)}
                            className="rounded border-slate-600 bg-slate-700 text-cyan-500 focus:ring-cyan-500/30" />
                        </td>
                        <td className="px-2 py-2 text-center text-slate-500 font-mono text-xs">{idx + 1}</td>
                        <td className="px-3 py-2 text-slate-300 whitespace-nowrap max-w-[250px] truncate text-xs" title={row.order_number || ''}>
                          {row.order_number || <span className="text-slate-700">—</span>}
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
                          ) : (
                            <span className="text-slate-700 text-xs">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-300 whitespace-nowrap max-w-[250px] truncate text-xs" title={row.doc_type || ''}>
                          {row.doc_type || <span className="text-slate-700">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center whitespace-nowrap min-w-[90px]">
                          <button
                            onClick={() => {
                              const cycle: Array<'T' | 'C' | 'O'> = ['T', 'C', 'O']
                              const nextIdx = (cycle.indexOf(row.factory) + 1) % cycle.length
                              setSourceRows(prev => prev.map((r, i) =>
                                i === idx ? { ...r, factory: cycle[nextIdx] } : r
                              ))
                            }}
                            className={`px-2 py-0.5 rounded text-xs font-bold transition-colors ${
                              row.factory === 'C'
                                ? 'bg-orange-900/60 text-orange-300 border border-orange-700/50 hover:bg-orange-800'
                                : row.factory === 'O'
                                ? 'bg-purple-900/60 text-purple-300 border border-purple-700/50 hover:bg-purple-800'
                                : 'bg-blue-900/60 text-blue-300 border border-blue-700/50 hover:bg-blue-800'
                            }`}
                          >
                            {row.factory === 'C' ? 'C 常平' : row.factory === 'O' ? 'O 委外' : 'T 台北'}
                          </button>
                        </td>
                        {SOURCE_DISPLAY_COLS.filter(c => c.key !== 'order_number' && c.key !== 'doc_type').map(col => (
                          <td key={col.key} className={`px-3 py-2 text-slate-300 whitespace-nowrap truncate text-xs ${col.key === 'customer' ? 'max-w-[100px]' : 'max-w-[250px]'}`} title={row[col.key] || ''}>
                            {row[col.key] || <span className="text-slate-700">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                /* ---- 匯出預覽視圖（依廠別分組）---- */
                <div className="space-y-6 p-4">
                  {([
                    { type: 'T' as const, label: '台北 (MOT / 製令)', colorBg: 'bg-blue-900/30', colorBorder: 'border-blue-700/40', colorText: 'text-blue-300', btnClass: 'bg-blue-700 hover:bg-blue-600' },
                    { type: 'C' as const, label: '常平 (MOC / 採購單)', colorBg: 'bg-orange-900/30', colorBorder: 'border-orange-700/40', colorText: 'text-orange-300', btnClass: 'bg-orange-700 hover:bg-orange-600' },
                    { type: 'O' as const, label: '委外 (MOO / 採購單)', colorBg: 'bg-purple-900/30', colorBorder: 'border-purple-700/40', colorText: 'text-purple-300', btnClass: 'bg-purple-700 hover:bg-purple-600' },
                  ]).map(group => {
                    const factoryWithIdx = sourceRows.map((r, i) => ({ r, i })).filter(({ r }) => r.factory === group.type)
                    const factoryRows = factoryWithIdx.map(({ r }) => r)
                    if (factoryRows.length === 0) return null
                    const factoryMatchResults = factoryWithIdx.map(({ i }) => soMatchResults[i])
                    const fExportRows = mapAllToExport(factoryRows, factoryMatchResults)
                    const importConfig = getImportConfig(group.type)
                    return (
                      <div key={group.type} className={`rounded-lg border ${group.colorBorder} overflow-hidden`}>
                        <div className={`${group.colorBg} px-4 py-3 flex items-center justify-between`}>
                          <div className="flex items-center gap-3">
                            <h3 className={`font-bold text-base ${group.colorText}`}>{group.label}</h3>
                            <span className="text-slate-400 text-sm">{factoryRows.length} 筆</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleShowPreview(group.type)}
                              disabled={importingFactory !== null}
                              className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-700 disabled:text-slate-400 text-white text-sm font-medium transition-colors flex items-center gap-1.5"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                              {importingFactory === group.type ? '匯入中...' : `匯入 ERP ${importConfig.targetLabel}並存總表 (${factoryRows.length} 筆)`}
                            </button>
                            <button
                              onClick={() => handleExportByFactory(group.type)}
                              className={`px-3 py-1.5 rounded-lg ${group.btnClass} text-white text-sm font-medium transition-colors flex items-center gap-1.5`}
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                              匯出 {exportFormat.toUpperCase()} ({factoryRows.length} 筆)
                            </button>
                          </div>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="bg-slate-800/60 border-b border-slate-700/50">
                                <th className="px-2 py-2.5 text-center text-slate-500 font-mono text-xs w-10">#</th>
                                {EXPORT_PREVIEW_COLS.map(col => (
                                  <th key={col.key} className={`px-3 py-2.5 text-left whitespace-nowrap text-xs ${MAPPED_KEYS.has(col.key) ? 'text-cyan-300 font-semibold' : 'text-slate-400 font-medium'}`}>
                                    <div>{col.label}</div>
                                    <div className={`text-[10px] font-normal mt-0.5 ${MAPPED_KEYS.has(col.key) ? 'text-cyan-500/60' : 'text-slate-600'}`}>
                                      {col.typeLabel}
                                      {MAPPED_KEYS.has(col.key) && ' ✦'}
                                    </div>
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {fExportRows.map((row, idx) => (
                                <tr key={idx} className={`border-b border-slate-800/50 ${idx % 2 === 0 ? 'bg-slate-900/50' : 'bg-slate-900/20'} hover:bg-slate-800/50`}>
                                  <td className="px-2 py-2 text-center text-slate-500 font-mono text-xs">{idx + 1}</td>
                                  {EXPORT_PREVIEW_COLS.map(col => (
                                    <td key={col.key} className={`px-3 py-2 whitespace-nowrap max-w-[250px] truncate text-xs ${MAPPED_KEYS.has(col.key) && row[col.key] ? 'text-cyan-200' : 'text-slate-500'}`} title={row[col.key] || ''}>
                                      {row[col.key] || <span className="text-slate-700">—</span>}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          !showPasteArea && (
            <div className="bg-slate-900 border border-slate-800 rounded-lg p-12 text-center">
              <p className="text-slate-500">尚無資料，請點擊「📋 貼上資料」開始</p>
            </div>
          )
        )}

        {failedImports.length > 0 && (
          <div className="mt-6 bg-red-950/20 border border-red-800/40 rounded-lg overflow-hidden">
            <div className="px-4 py-4 border-b border-red-800/30 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-red-300">匯入失敗集中區</h3>
                <p className="text-sm text-red-200/70 mt-1">失敗資料會集中保留在這裡，方便你修正後重新上傳。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() => handleRestoreFailedToSource('append')}
                  className="px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 transition-colors text-sm"
                >
                  加入主清單編輯 ({failedImports.length} 筆)
                </button>
                <button
                  onClick={() => handleRestoreFailedToSource('replace')}
                  className="px-3 py-2 rounded-lg bg-amber-800/70 border border-amber-700/50 text-amber-100 hover:bg-amber-700 transition-colors text-sm"
                >
                  只保留失敗資料
                </button>
                <button
                  onClick={handleSendFailedToPasteArea}
                  className="px-3 py-2 rounded-lg bg-cyan-800/70 border border-cyan-700/50 text-cyan-100 hover:bg-cyan-700 transition-colors text-sm"
                >
                  送回貼上區修改
                </button>
                <button
                  onClick={handleClearFailedImports}
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
                    <th className="px-3 py-2.5 text-left text-red-200/80 text-xs whitespace-nowrap">工單編號</th>
                    <th className="px-3 py-2.5 text-left text-red-200/80 text-xs whitespace-nowrap">廠別</th>
                    <th className="px-3 py-2.5 text-left text-red-200/80 text-xs whitespace-nowrap">品項編碼</th>
                    <th className="px-3 py-2.5 text-left text-red-200/80 text-xs whitespace-nowrap">品名/規格</th>
                    <th className="px-3 py-2.5 text-left text-red-200/80 text-xs whitespace-nowrap">錯誤原因</th>
                    <th className="px-3 py-2.5 text-left text-red-200/80 text-xs whitespace-nowrap">失敗時間</th>
                    <th className="px-3 py-2.5 text-center text-red-200/80 text-xs whitespace-nowrap">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {failedImports.map(item => (
                    <tr key={item.key} className="border-b border-red-900/20 bg-slate-950/30 hover:bg-slate-900/50">
                      <td className="px-3 py-2 text-slate-200 text-xs whitespace-nowrap max-w-[160px] truncate" title={item.row.order_number}>{item.row.order_number || '—'}</td>
                      <td className="px-3 py-2 text-slate-300 text-xs whitespace-nowrap">{factoryLabel(item.factory)}</td>
                      <td className="px-3 py-2 text-slate-300 text-xs whitespace-nowrap max-w-[140px] truncate" title={item.row.item_code}>{item.row.item_code || '—'}</td>
                      <td className="px-3 py-2 text-slate-300 text-xs whitespace-nowrap max-w-[220px] truncate" title={item.row.item_name}>{item.row.item_name || '—'}</td>
                      <td className="px-3 py-2 text-red-200 text-xs max-w-[320px]" title={item.error}>{item.error}</td>
                      <td className="px-3 py-2 text-slate-400 text-xs whitespace-nowrap">{item.attemptedAt}</td>
                      <td className="px-3 py-2 text-center">
                        <button
                          onClick={() => handleRemoveFailedItem(item.key)}
                          className="px-2.5 py-1 rounded-md bg-slate-800 border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-700 transition-colors text-xs"
                        >
                          移除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* PO 比對結果面板 */}
        {poLinks !== null && (() => {
          // 建立 so_project_id → PO 清單 的 map
          const soToPo = new Map<string, typeof poLinks>()
          for (const link of poLinks) {
            if (!link.so_project_id) continue
            if (!soToPo.has(link.so_project_id)) soToPo.set(link.so_project_id, [])
            soToPo.get(link.so_project_id)!.push(link)
          }
          // 找出當前來源清單中有對應採購單的 order_number
          const matchedOrders = sourceRows.filter(r => soToPo.has(r.order_number))
          return (
            <div className="mt-6 bg-violet-950/20 border border-violet-700/40 rounded-lg overflow-hidden">
              <div className="px-4 py-4 border-b border-violet-700/30 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-violet-300">採購單比對結果</h3>
                  <p className="text-sm text-violet-200/60 mt-0.5">
                    共查到 <span className="text-violet-300 font-medium">{poLinks.length}</span> 筆 PO 明細有連結訂購單序號。
                    目前工單清單中有 <span className={`font-medium ${matchedOrders.length > 0 ? 'text-amber-300' : 'text-emerald-300'}`}>{matchedOrders.length}</span> 筆訂購單已對應採購單。
                  </p>
                </div>
                <button onClick={() => setPoLinks(null)} className="text-slate-400 hover:text-white text-lg">✕</button>
              </div>

              {matchedOrders.length > 0 && (
                <div className="px-4 py-3 border-b border-violet-700/20 bg-amber-950/20">
                  <p className="text-xs font-semibold text-amber-300 mb-2">⚠️ 以下工單的訂購單在 ERP 已有採購單，請確認是否重複建立：</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-400 border-b border-slate-700">
                          <th className="px-3 py-2 text-left">訂購單號</th>
                          <th className="px-3 py-2 text-left">客戶</th>
                          <th className="px-3 py-2 text-left">品項</th>
                          <th className="px-3 py-2 text-left">對應採購單</th>
                          <th className="px-3 py-2 text-left">採購貨號</th>
                          <th className="px-3 py-2 text-right">採購數量</th>
                        </tr>
                      </thead>
                      <tbody>
                        {matchedOrders.flatMap(src =>
                          (soToPo.get(src.order_number) ?? []).map((link, i) => (
                            <tr key={`${src.order_number}-${i}`} className="border-b border-slate-800/40">
                              <td className="px-3 py-1.5 font-mono text-amber-300 whitespace-nowrap">{src.order_number}</td>
                              <td className="px-3 py-1.5 text-slate-300 max-w-[120px] truncate" title={src.customer}>{src.customer}</td>
                              <td className="px-3 py-1.5 text-slate-400 max-w-[150px] truncate" title={src.item_name}>{src.item_name}</td>
                              <td className="px-3 py-1.5 font-mono text-violet-300 whitespace-nowrap">{link.po_project_id}</td>
                              <td className="px-3 py-1.5 text-slate-300 whitespace-nowrap">{link.mbp_part || '—'}</td>
                              <td className="px-3 py-1.5 text-right text-slate-300">{link.order_qty_oru ?? '—'}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="px-4 py-3">
                <p className="text-xs text-slate-500 mb-2">所有有連結訂購單的採購單明細（共 {poLinks.length} 筆）：</p>
                <div className="overflow-x-auto max-h-64">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-900">
                      <tr className="text-slate-400 border-b border-slate-700">
                        <th className="px-3 py-2 text-left">採購單號</th>
                        <th className="px-3 py-2 text-right">採購單序號</th>
                        <th className="px-3 py-2 text-left">訂購單號</th>
                        <th className="px-3 py-2 text-right">訂購單序號</th>
                        <th className="px-3 py-2 text-left">項號</th>
                        <th className="px-3 py-2 text-left">貨號</th>
                        <th className="px-3 py-2 text-right">數量</th>
                      </tr>
                    </thead>
                    <tbody>
                      {poLinks.map((link, i) => (
                        <tr key={i} className={`border-b border-slate-800/30 ${i % 2 === 0 ? 'bg-slate-900/50' : ''}`}>
                          <td className="px-3 py-1.5 font-mono text-violet-300 whitespace-nowrap">{link.po_project_id}</td>
                          <td className="px-3 py-1.5 text-right text-slate-400 font-mono">{link.pdl_seq}</td>
                          <td className="px-3 py-1.5 font-mono text-cyan-300 whitespace-nowrap">{link.so_project_id}</td>
                          <td className="px-3 py-1.5 text-right text-slate-400 font-mono">{link.pdl_seq_so}</td>
                          <td className="px-3 py-1.5 text-slate-400">{link.line_no}</td>
                          <td className="px-3 py-1.5 text-slate-300">{link.mbp_part || '—'}</td>
                          <td className="px-3 py-1.5 text-right text-slate-300">{link.order_qty_oru ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )
        })()}

        {/* 欄位對應說明 */}
        {sourceRows.length > 0 && (
          <div className="mt-6 bg-slate-900/50 border border-slate-800/50 rounded-lg p-4">
            <h3 className="text-sm font-medium text-slate-400 mb-3">欄位對應規則</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
              {[
                ['自動生成', '製令單號', 'MO+廠別(T/C/O) + 開立日期(YYYYMMDD) + 流水號(001-999)'],
                ['自動計算', '預定投產日', '建單下一個工作日'],
                ['交付日期', '預定結案日', ''],
                ['預設 OPEN', '製令狀態', ''],
                ['預設 M1100', '部門', ''],
                ['預設 M1000', '成本部門', ''],
                ['預設 1', '編號', ''],
                ['品項編碼', '生產貨號', ''],
                ['預設 1', '版本', ''],
                ['客戶名稱', '自定義欄位1', 'PDL01C 文字(200)，無字元限制'],
                ['數量', '預訂產出量', ''],
                ['預設 99', 'BOM製造批料階數', ''],
                ['預設 1', '成品工費分攤約當比例', ''],
                ['預設 1', '直接原料分攤約當比例', ''],
                ['工單編號', '來源訂單', ''],
                ['品名/規格+備註', '製令說明', ''],
                ['今天日期', '開立日期', ''],
                ['預設 N', '自動批備料', ''],
              ].map(([from, to, desc], i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-slate-500 w-24 shrink-0">{from}</span>
                  <span className="text-slate-600">→</span>
                  <span className="text-cyan-400">{to}</span>
                  {desc && <span className="text-slate-600 text-[10px] ml-1">({desc})</span>}
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] text-slate-600">
              ✦ 標記的欄位為自動對應。支援匯出 CSV（UTF-8 BOM）及 XLSX 格式，含 {EXPORT_COLUMNS.length} 欄完整 ArgoERP 製令格式（含型態定義列）。其餘欄位匯出時留空，可於 ArgoERP 補填。
            </p>
          </div>
        )}
      </div>

      {/* ---- 匯入預覽 Modal ---- */}
      {importPreview && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setImportPreview(null)}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl w-full max-w-3xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-700 flex items-center justify-between">
              <div>
                <h2 className="text-base font-bold text-white">匯入預覽 — {factoryLabel(importPreview.factory)} ({importPreview.rows.length} 筆)</h2>
                <p className="text-xs text-slate-400 mt-0.5 flex flex-wrap items-center gap-2">
                  以下為將產生的製令單號，請確認無誤後再匯入
                  <span className={`px-2 py-0.5 rounded text-[11px] font-mono ${importPreview.dbMax > 0 ? 'bg-emerald-900/60 text-emerald-300' : 'bg-yellow-900/60 text-yellow-300'}`}>
                    DB 已用最大號：{importPreview.dbMax > 0 ? String(importPreview.dbMax).padStart(3, '0') : '未抓到（server 可能需重啟）'}
                  </span>
                  {importPreview.skippedCount > 0 && (
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-red-900/60 text-red-300">
                      ⚠ {importPreview.skippedCount} 筆無序號已移入暫緩區
                    </span>
                  )}
                </p>
              </div>
              <button onClick={() => setImportPreview(null)} className="text-slate-400 hover:text-white text-lg leading-none">✕</button>
            </div>
            <div className="overflow-y-auto flex-1">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-800">
                  <tr className="text-slate-400 text-xs border-b border-slate-700">
                    <th className="px-3 py-2.5 text-left font-medium">#</th>
                    <th className="px-3 py-2.5 text-left font-medium">製令單號</th>
                    <th className="px-3 py-2.5 text-left font-medium">生產貨號</th>
                    <th className="px-3 py-2.5 text-left font-medium">來源訂單</th>
                    <th className="px-3 py-2.5 text-center font-medium">序號 <span className="text-red-400">*</span></th>
                    <th className="px-3 py-2.5 text-right font-medium">數量</th>
                    <th className="px-3 py-2.5 text-left font-medium">客戶</th>
                    <th className="px-3 py-2.5 text-left font-medium">結案日</th>
                  </tr>
                </thead>
                <tbody>
                  {importPreview.rows.map((row, i) => (
                    <tr key={i} className={`border-b border-slate-800/50 ${i % 2 === 0 ? 'bg-slate-900/60' : 'bg-slate-900/20'}`}>
                      <td className="px-3 py-2 text-slate-500 text-xs">{i + 1}</td>
                      <td className="px-3 py-2 font-mono text-cyan-300 text-xs whitespace-nowrap">{row.mo_number}</td>
                      <td className="px-3 py-2 text-white text-xs whitespace-nowrap">{row.product_code}</td>
                      <td className="px-3 py-2 text-slate-300 text-xs whitespace-nowrap">{row.source_order}</td>
                      <td className="px-3 py-2 text-center text-xs">
                        {row.source_order_line
                          ? <span className="text-emerald-400 font-mono">{row.source_order_line}</span>
                          : <span className="text-red-400">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right text-slate-300 text-xs">{row.planned_qty}</td>
                      <td className="px-3 py-2 text-slate-400 text-xs max-w-[150px] truncate" title={row.custom_1}>{row.custom_1}</td>
                      <td className="px-3 py-2 text-slate-400 text-xs whitespace-nowrap">{row.planned_end_date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-4 border-t border-slate-700 flex items-center justify-end gap-3">
              <button
                onClick={() => setImportPreview(null)}
                className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 text-white text-sm transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => { setImportPreview(null); handleImportToErp(importPreview.factory) }}
                disabled={importingFactory !== null}
                className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:bg-slate-700 disabled:text-slate-400 text-white text-sm font-medium transition-colors flex items-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                確認匯入 ERP
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
