// 共用的「出單表列 → ArgoERP 製令/採購單匯出格式」轉換邏輯。
//
// 這份邏輯原本各自嵌在 app/admin/argoerp/order-batch-export/page.tsx（台北廠製令）
// 跟 daily-order-sheet/ChangeOrderPanel.tsx（原 _shared/FactoryOrderExportPage.tsx 為零引用半成品，2026-09-10 移除）（常平/委外採購單）裡，兩邊
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

// ── 常平採購單交期規則（2026-09-22 下限 / 2026-09-24 例假日）────────────
//
// 常平是委外的實體工廠，出單表上的交期常常直接抄客戶的希望交期，等採購單開出去
// 才發現只剩兩三天——料還沒到、產線也排不進去。因此轉成採購單時強制拉出一段
// 最低前置時間：交期至少是開立日之後的 5 個工作天。
//
// 例假日：常平在中國，放假日跟台灣不一樣（國慶連假、春節長度都不同），光跳過
// 六日不夠。可在「出單表→常平採購」頁面維護一份常平的例假日清單，存在
// app_settings.changping_holidays；這裡的工作天計算與交期落點都會避開那些日子。
//
// 5 這個數字與出單表的交期警示閾值一致（DUE_THRESHOLD_DEFAULTS.C = 5），
// 差別在於那邊只跳警示、可以被忽略，這裡是實際寫進 ARGO 採購單的值。

export const CHANGPING_MIN_LEAD_WORKDAYS = 5
export const CHANGPING_HOLIDAYS_KEY = 'changping_holidays'

/** 例假日清單（任意寫法）→ 以 YYYY-MM-DD 為鍵的 Set */
export function toHolidaySet(list: unknown): Set<string> {
  const out = new Set<string>()
  if (!Array.isArray(list)) return out
  for (const raw of list) {
    const d = parseAnyYmd(String(raw ?? ''))
    if (d) out.add(ymdKey(d))
  }
  return out
}

function ymdKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 六日或名單內的例假日都算「常平沒上班」 */
export function isNonWorkingDay(d: Date, holidays?: Set<string>): boolean {
  const dow = d.getDay()
  if (dow === 0 || dow === 6) return true
  return !!holidays?.has(ymdKey(d))
}

/** 從 from 起算往後推 n 個工作天（from 當天為第 0 天，跳過六日與例假日） */
export function addWorkingDays(from: Date, n: number, holidays?: Set<string>): Date {
  const d = new Date(from)
  let left = n
  // 上限保險：避免例假日清單填成整年造成無窮迴圈
  let guard = 0
  while (left > 0 && guard++ < 3650) {
    d.setDate(d.getDate() + 1)
    if (!isNonWorkingDay(d, holidays)) left--
  }
  return d
}

/** 往前 / 往後找最近的非例假日（含當天） */
function nearestWorkingDay(from: Date, dir: -1 | 1, holidays?: Set<string>): Date {
  const d = new Date(from)
  let guard = 0
  while (isNonWorkingDay(d, holidays) && guard++ < 3650) d.setDate(d.getDate() + dir)
  return d
}

/** 解析 YYYY/M/D、YYYY-M-D、YYYYMMDD 三種寫法 */
function parseAnyYmd(s: string): Date | null {
  const t = String(s ?? '').trim()
  if (!t) return null
  let y: number, m: number, d: number
  if (/^\d{8}$/.test(t)) {
    y = +t.slice(0, 4); m = +t.slice(4, 6); d = +t.slice(6, 8)
  } else {
    const mm = t.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
    if (!mm) return null
    y = +mm[1]; m = +mm[2]; d = +mm[3]
  }
  const dt = new Date(y, m - 1, d)
  return Number.isNaN(dt.getTime()) ? null : dt
}

function fmtSlashDate(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 常平採購單的交期。兩條規則：
 *   1. 下限：至少給常平 workdays 個工作天（跳過六日與例假日）
 *   2. 落點：交期不可以落在常平的例假日——先試著「往前」移到最近的上班日，
 *      往前移之後若仍滿足下限就用它（對我們比較有利，早一天拿到貨）；
 *      不滿足才「往後」移到最近的上班日。
 *
 * @returns YYYY/MM/DD；beginDate 解析不出來時原樣回傳 deliveryDate（不亂動）
 */
export function ensureChangpingLeadTime(
  deliveryDate: string,
  beginDate: string,
  opts: { holidays?: Set<string>; workdays?: number } = {},
): string {
  const { holidays, workdays = CHANGPING_MIN_LEAD_WORKDAYS } = opts
  const begin = parseAnyYmd(beginDate)
  if (!begin) return String(deliveryDate ?? '').trim()

  // 下限本身一定落在上班日（addWorkingDays 只會停在上班日）
  const earliest = addWorkingDays(begin, workdays, holidays)
  const due = parseAnyYmd(deliveryDate)

  // 交期沒填、或早於下限 → 用下限
  if (!due || due.getTime() < earliest.getTime()) return fmtSlashDate(earliest)

  // 交期本身就是上班日 → 直接用
  if (!isNonWorkingDay(due, holidays)) return fmtSlashDate(due)

  // 落在例假日：往前移仍滿足下限就往前，否則往後
  const back = nearestWorkingDay(due, -1, holidays)
  if (back.getTime() >= earliest.getTime()) return fmtSlashDate(back)
  return fmtSlashDate(nearestWorkingDay(due, 1, holidays))
}
