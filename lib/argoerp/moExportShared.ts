// 共用的「出單表列 → ArgoERP 製令/採購單匯出格式」轉換邏輯。
//
// 這份邏輯原本各自嵌在 app/admin/argoerp/order-batch-export/page.tsx（台北廠製令）
// 跟 app/admin/argoerp/_shared/FactoryOrderExportPage.tsx（常平/委外採購單）裡，兩邊
// 完全複製貼上、綁死在各自元件的 state 上，其他頁面沒辦法呼叫。這裡抽成純函式，
// 兩個原本的頁面改成 import 這裡的版本（純搬移，行為不變），改單專區之類需要重新
// 轉單的新功能也走這裡，不再產生第三份複製。
//
// T 廠跟 C/O 廠的序號判斷邏輯不完全一樣（C/O 版本會優先採用 B欄直接填入的序號），
// 故意保留兩支獨立函式而非強行合併。

export interface ExportColumn {
  key: string
  label: string
  typeLabel: string
}

export type ExportRow = Record<string, string>

export interface SoMatchResult {
  line_no: string | null
  pdl_seq: number | null
  status: 'matched' | 'no_order' | 'no_qty_match' | 'insufficient_candidates'
  reason: string
}

// mapMoExportRowsT / mapPoExportRowsCO 實際會讀取的欄位（結構型別，
// 呼叫端既有的 SourceRow 型別欄位比這個多，仍能直接傳入）
export interface MoExportSourceRow {
  order_number: string
  factory: 'T' | 'C' | 'O'
  item_code: string
  item_name: string
  note: string
  quantity: string
  delivery_date: string
  line_no_input?: string
}

// ==================== ArgoERP 匯出欄位定義（IFAF028 製令 / IFAF044 採購單共用）====================
export const EXPORT_COLUMNS: ExportColumn[] = [
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

// ==================== ArgoERP 介面欄位代碼對應（IFAF028/IFAF044 共用）====================
export const ERP_FIELD_CODE_MAP: Record<string, string> = {
  mo_number: 'PROJECT_ID',
  planned_start_date: 'BEGIN_DATE',
  planned_end_date: 'END_DATE',
  mo_status: 'HOLD_STATUS',
  status_date: 'STATUS_DATE',
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

// ==================== 工具函式 ====================
export function formatDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// 以 byte 長度截斷字串（UTF-8）——中文一字 3 bytes、英數 1 byte
export function truncateByByteLength(text: string, maxBytes: number): string {
  if (!text) return ''
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8')
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  let cut = maxBytes
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut--
  return decoder.decode(bytes.slice(0, cut))
}

// 取得下一個工作日（跳過六日）
export function getNextBusinessDay(from: Date): Date {
  const d = new Date(from)
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1)
  }
  return d
}

// 從銷售訂單號取出英文前綴後的完整數字串（例：RO26050101 → "26050101"，SOA260622-111728-486 → "260622-111728-486"）
export function parseSoDateDigits(orderNumber: string): string | null {
  const m = orderNumber.match(/^[A-Za-z]+(.+)/)
  return m ? m[1] : null
}

export function getImportConfig(factory: 'T' | 'C' | 'O') {
  if (factory === 'T') {
    return { interfaceId: 'IFAF028', targetLabel: '製令', shortLabel: 'MOT' }
  }
  return { interfaceId: 'IFAF044', targetLabel: '採購單', shortLabel: factory === 'C' ? 'MOC' : 'MOO' }
}

// 將內部 ExportRow（英文 key）轉換為 ArgoERP 介面 payload（ERP 欄位代碼為 key）
// 只送有值的欄位，避免 ORA-00957（duplicate column）—— 某些欄位 ERP 程序內部會自填，
// 若我們再送空字串會造成重複欄位錯誤。
export function toErpPayload(rows: ExportRow[]): Array<Record<string, string>> {
  return rows.map(row => {
    const erp: Record<string, string> = {}
    for (const [internalKey, value] of Object.entries(row)) {
      const erpCode = ERP_FIELD_CODE_MAP[internalKey]
      if (!erpCode) continue
      const v = (value ?? '').trim()
      if (!v) continue
      erp[erpCode] = v
    }
    return erp
  })
}

// ==================== 台北廠（製令 IFAF028）====================
// 製令單號：MO + T + 來源單號日期(YYYYMMDD) + 兩碼序號，末兩碼直接取 matchResults 的 line_no
export function mapMoExportRowsT(srcRows: MoExportSourceRow[], matchResults?: SoMatchResult[]): ExportRow[] {
  const today = new Date()
  const todayStr = formatDate(today)
  const nextBizDay = formatDate(getNextBusinessDay(today))
  const todayDateDigits = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

  return srcRows.map((src, rowIndex) => {
    const row: ExportRow = {}
    EXPORT_COLUMNS.forEach(col => { row[col.key] = '' })

    const prefix = src.factory === 'O' ? 'MOO' : `MO${src.factory}`
    const soDateDigits = parseSoDateDigits(src.order_number) ?? todayDateDigits
    const lineNo = matchResults?.[rowIndex]?.line_no
    const seqStr = lineNo ? String(Number(lineNo)).padStart(2, '0') : '00'
    row.mo_number = `${prefix}${soDateDigits}${seqStr}`

    row.planned_start_date = nextBizDay
    row.planned_end_date = src.delivery_date
    row.mo_status = src.factory === 'T' ? 'OPEN' : 'UNSIGNED'
    row.department = 'M1100'
    row.cost_department = 'M1000'
    row.seq_number = lineNo ? String(Number(lineNo)) : '1'
    row.product_code = src.item_code
    row.version = '1'
    row.lot_number = truncateByByteLength(src.order_number, 30)
    row.custom_1 = ''
    row.planned_qty = src.quantity.replace(/,/g, '')
    row.bom_level = '99'
    row.product_cost_ratio = '1'
    row.material_cost_ratio = '1'
    row.source_order = src.order_number
    row.source_order_line = matchResults?.[rowIndex]?.line_no ?? ''
    row.mo_note = [src.item_name, src.note].filter(Boolean).join(' ')
    row.create_date = todayStr
    row.auto_material = 'N'

    return row
  })
}

// ==================== 常平/委外廠（採購單 IFAF044）====================
// 序號優先序：B欄直接填入的 line_no_input（若有）優先於 matchResults 比對結果
export function mapPoExportRowsCO(srcRows: MoExportSourceRow[], matchResults: SoMatchResult[]): ExportRow[] {
  const today = new Date()
  const todayStr = formatDate(today)
  const nextBizDay = formatDate(getNextBusinessDay(today))
  const todayDateDigits = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

  return srcRows.map((src, rowIndex) => {
    const row: ExportRow = {}
    EXPORT_COLUMNS.forEach(col => { row[col.key] = '' })

    const prefix = src.factory === 'O' ? 'MOO' : `MO${src.factory}`
    const soDateDigits = parseSoDateDigits(src.order_number) ?? todayDateDigits
    const lineNo = (src.line_no_input && src.line_no_input.trim()) ? src.line_no_input.trim() : (matchResults[rowIndex]?.line_no ?? null)
    const seqStr = lineNo ? String(Number(lineNo)).padStart(2, '0') : '00'
    row.mo_number = `${prefix}${soDateDigits}${seqStr}`

    row.planned_start_date = nextBizDay
    row.planned_end_date = src.delivery_date
    row.mo_status = 'OPEN'
    row.department = 'M1100'
    row.cost_department = 'M1000'
    row.seq_number = lineNo ? String(Number(lineNo)) : '1'
    row.product_code = src.item_code
    row.version = '1'
    row.lot_number = truncateByByteLength(src.order_number, 30)
    row.planned_qty = src.quantity.replace(/,/g, '')
    row.bom_level = '99'
    row.product_cost_ratio = '1'
    row.material_cost_ratio = '1'
    row.source_order = src.order_number
    row.source_order_line = lineNo ?? ''
    row.mo_note = [src.item_name, src.note].filter(Boolean).join(' ')
    row.create_date = todayStr
    row.auto_material = 'N'
    return row
  })
}
