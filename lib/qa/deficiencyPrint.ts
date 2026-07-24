// 品質異常處理單（缺失單）Excel 產生器
// 一筆異常紀錄 × 每位缺失人員 = 一張 A4 直式工作表（無人員也出一張、人員留白）。
// 版面複刻公司 Word 範本（QR 單），差異：移除採購單號列、
// 「部門/缺失人員」列移至（3）處置方式正上方、處置方式縮成一排。
import * as XLSX from 'xlsx-js-style'
import { supabase } from '../supabaseClient'

export interface DeficiencyPrintRecord {
  id: number
  created_at: string
  order_number: string
  item_code: string | null
  item_name: string | null
  reason: string | null
  qa_reporter: string | null
  qa_handlers: string[] | string | null
  qa_responsible: string[] | null
  qa_disposition: Record<string, string> | string | null
  loss_qty: number | null
  cause_analysis: string | null
  immediate_action: string | null
  corrective_action: string | null
}

interface OrderLine {
  mbpPart: string
  qty: number | null
}

interface OrderInfo {
  partnerName: string
  lines: OrderLine[]
}

const COLS = 11
const ROWS = 25
const FONT = '新細明體'

const parseDisp = (val: unknown): Record<string, string> => {
  if (!val) return {}
  if (typeof val === 'string') {
    try { return JSON.parse(val) as Record<string, string> } catch { return {} }
  }
  if (typeof val === 'object') return val as Record<string, string>
  return {}
}

const normalizeArray = (value: string[] | string | null | undefined): string[] => {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

// created_at ISO → 民國「115年7月23日」；直接取日期字串避免時區位移
const rocDate = (iso: string): string => {
  const day = (iso || '').slice(0, 10)
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return '　　年　月　日'
  return `${y - 1911}年${m}月${d}日`
}

// Excel 工作表名稱限 31 字、不可含 [ ] : * ? / \
const sanitizeSheetName = (raw: string): string => {
  const cleaned = raw.replace(/[\[\]:*?/\\]/g, '').replace(/^'+|'+$/g, '')
  return (cleaned || 'sheet').slice(0, 31)
}

// 處置勾選：優先序判定——「口頭警告/申誡」勾口頭申誡、「警告」勾警告、
// 小過/大過對應勾；其他非空值勾「其他」附原文；空值全留白。
const DISP_MATCHERS = [
  { label: '口頭申誡', test: (v: string) => v.includes('申誡') || v.includes('口頭警告') },
  { label: '警告', test: (v: string) => v.includes('警告') },
  { label: '小過', test: (v: string) => v.includes('小過') },
  { label: '大過', test: (v: string) => v.includes('大過') },
]
const DISP_ORDER = ['口頭申誡', '警告', '小過', '大過']
const dispositionLine = (dispValue: string): string => {
  const val = (dispValue || '').trim()
  const hit = DISP_MATCHERS.find((m) => m.test(val))?.label
  const boxes = DISP_ORDER.map((label) => `${hit === label ? '☑' : '□'}${label}`)
  boxes.push(hit || !val ? '□其他：' : `☑其他：${val}`)
  return boxes.join('　')
}

type CellStyle = Record<string, unknown>

const THIN = { style: 'thin', color: { rgb: '000000' } }
const MEDIUM = { style: 'medium', color: { rgb: '000000' } }
const GREY = { fgColor: { rgb: 'D9D9D9' } }

const baseFont = { name: FONT, sz: 10 }

const styles = {
  title: { font: { name: FONT, sz: 16, bold: true }, alignment: { horizontal: 'center', vertical: 'center' } },
  meta: { font: baseFont, alignment: { horizontal: 'left', vertical: 'center' } },
  metaRight: { font: baseFont, alignment: { horizontal: 'right', vertical: 'center' } },
  label: { font: { ...baseFont, bold: true }, fill: GREY, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } },
  band: { font: { ...baseFont, bold: true }, fill: GREY, alignment: { horizontal: 'left', vertical: 'center' } },
  value: { font: baseFont, alignment: { horizontal: 'left', vertical: 'center', wrapText: true } },
  block: { font: baseFont, alignment: { horizontal: 'left', vertical: 'top', wrapText: true } },
  signBlank: { font: baseFont },
} satisfies Record<string, CellStyle>

const setCell = (ws: XLSX.WorkSheet, r: number, c: number, v: string, s: CellStyle) => {
  ws[XLSX.utils.encode_cell({ r, c })] = { t: 's', v, s }
}

const M = (r1: number, c1: number, r2: number, c2: number) => ({ s: { r: r1, c: c1 }, e: { r: r2, c: c2 } })

/** 一張缺失單（一筆紀錄 × 一位缺失人員）的完整內容；預覽與 Excel 共用同一份資料。 */
export interface DeficiencySheetData {
  sheetName: string
  serial: string
  dateText: string
  createdDay: string
  partnerName: string
  orderNumber: string
  orderQtyText: string
  lossText: string
  rateText: string
  itemText: string
  reason: string
  reporter: string
  causeAnalysis: string
  immediateAction: string
  correctiveAction: string
  handlers: string
  person: string
  dept: string
  dispositionLine: string
}

const buildSheet = (d: DeficiencySheetData): XLSX.WorkSheet => {
  const ws: XLSX.WorkSheet = {}

  // R1 標題
  setCell(ws, 0, 0, '品質異常處理單', styles.title)
  // R2 編號 / 日期
  setCell(ws, 1, 0, `編號：${d.serial}`, styles.meta)
  setCell(ws, 1, 5, `日期：${d.dateText}`, styles.metaRight)
  // R3-R6 左：不良發生點（直向合併；其它移末行、原位置改製圖失誤）
  setCell(ws, 2, 0, '不良發生點 Occurred Point：\n□進料檢驗　□半成品檢驗\n□成品檢驗　□製圖失誤\n□其它：', styles.block)
  // R3-R6 右：訂單詳情（右區 8 欄，四格各 2 欄等寬；採購單號列已移除）
  setCell(ws, 2, 3, '廠商/客戶名稱', styles.label)
  setCell(ws, 2, 5, d.partnerName, styles.value)
  setCell(ws, 3, 3, '客戶訂單單號', styles.label)
  setCell(ws, 3, 5, d.orderNumber, styles.value)
  setCell(ws, 3, 7, '製造單號', styles.label)
  setCell(ws, 3, 9, '', styles.value)
  setCell(ws, 4, 3, '訂單量', styles.label)
  setCell(ws, 4, 5, d.orderQtyText, styles.value)
  setCell(ws, 4, 7, '不良數', styles.label)
  setCell(ws, 4, 9, d.lossText, styles.value)
  setCell(ws, 5, 3, '不良率', styles.label)
  setCell(ws, 5, 5, d.rateText, styles.value)
  setCell(ws, 5, 7, '異常數量', styles.label)
  setCell(ws, 5, 9, d.lossText, styles.value)
  // R7 品名規格
  setCell(ws, 6, 0, '品名規格物料編號', styles.label)
  setCell(ws, 6, 3, d.itemText, styles.value)
  // R8-R10 (1) 發現人填寫：標籤與經辦同列（經辦約 2/3 處起靠左），下方整片填寫區
  setCell(ws, 7, 0, '（1）發現人填寫', styles.band)
  setCell(ws, 8, 0, '異常狀況說明：', styles.meta)
  setCell(ws, 8, 7, `經辦：${d.reporter}`, styles.meta)
  setCell(ws, 9, 0, d.reason, styles.block)
  // R11-R17 (2) 責任單位填寫：標籤與人名同列（人名靠右），下方整片留白填寫區
  setCell(ws, 10, 0, '（2）責任單位填寫', styles.band)
  setCell(ws, 11, 0, '異常原因分析：', styles.meta)
  setCell(ws, 11, 7, `責任人員：${d.person}`, styles.meta)
  setCell(ws, 12, 0, d.causeAnalysis, styles.block)
  setCell(ws, 13, 0, '即時處理方式：', styles.meta)
  setCell(ws, 13, 7, `人員：${d.handlers}`, styles.meta)
  setCell(ws, 14, 0, d.immediateAction, styles.block)
  setCell(ws, 15, 0, '預防及修正方式：', styles.meta)
  setCell(ws, 15, 7, '部門主管：', styles.meta)
  setCell(ws, 16, 0, d.correctiveAction, styles.block)
  // R18 部門 / 缺失人員（自原版上方移到處置方式正上方）
  setCell(ws, 17, 0, '部門', styles.label)
  setCell(ws, 17, 2, d.dept, styles.value)
  setCell(ws, 17, 5, '缺失人員', styles.label)
  setCell(ws, 17, 7, d.person, styles.value)
  // R19 (3) 處置方式（縮成一排）
  setCell(ws, 18, 0, '（3）處置方式', styles.label)
  setCell(ws, 18, 2, d.dispositionLine, styles.value)
  // R20-R21 (4) 品保判定：標籤與經辦人員同列，下方留白
  setCell(ws, 19, 0, '（4）品保判定責任歸屬：', styles.meta)
  setCell(ws, 19, 7, '經辦人員：', styles.meta)
  setCell(ws, 20, 0, '', styles.block)
  // R22-R25 (5) 結案 + 簽核欄（簽名區縮小：三格各 2 欄，左側填寫區擴大至 5 欄）
  setCell(ws, 21, 0, '（5）結案', styles.band)
  setCell(ws, 22, 0, '責任單位：', styles.value)
  setCell(ws, 22, 5, '總經理', styles.label)
  setCell(ws, 22, 7, '品保部', styles.label)
  setCell(ws, 22, 9, '部門主管', styles.label)
  setCell(ws, 23, 0, '損失成本：', styles.value)
  setCell(ws, 24, 0, '其他：', styles.value)

  ws['!merges'] = [
    M(0, 0, 0, 10),                          // 標題
    M(1, 0, 1, 4), M(1, 5, 1, 10),           // 編號 / 日期
    M(2, 0, 5, 2),                           // 不良發生點（直向）
    M(2, 3, 2, 4), M(2, 5, 2, 10),           // 廠商/客戶名稱
    M(3, 3, 3, 4), M(3, 5, 3, 6), M(3, 7, 3, 8), M(3, 9, 3, 10),   // 客戶訂單單號 | 製造單號
    M(4, 3, 4, 4), M(4, 5, 4, 6), M(4, 7, 4, 8), M(4, 9, 4, 10),   // 訂單量 | 不良數
    M(5, 3, 5, 4), M(5, 5, 5, 6), M(5, 7, 5, 8), M(5, 9, 5, 10),   // 不良率 | 異常數量
    M(6, 0, 6, 2), M(6, 3, 6, 10),           // 品名規格
    M(7, 0, 7, 10),                          // (1) band
    M(8, 0, 8, 6), M(8, 7, 8, 10),           // 異常狀況說明 | 經辦
    M(9, 0, 9, 10),                          // 填寫區
    M(10, 0, 10, 10),                        // (2) band
    M(11, 0, 11, 6), M(11, 7, 11, 10),       // 異常原因分析 | 責任人員
    M(12, 0, 12, 10),                        // 填寫區
    M(13, 0, 13, 6), M(13, 7, 13, 10),       // 即時處理方式 | 人員
    M(14, 0, 14, 10),                        // 填寫區
    M(15, 0, 15, 6), M(15, 7, 15, 10),       // 預防及修正方式 | 部門主管
    M(16, 0, 16, 10),                        // 填寫區
    M(17, 0, 17, 1), M(17, 2, 17, 4), M(17, 5, 17, 6), M(17, 7, 17, 10), // 部門/缺失人員
    M(18, 0, 18, 1), M(18, 2, 18, 10),       // (3) 處置方式
    M(19, 0, 19, 6), M(19, 7, 19, 10),       // (4) | 經辦人員
    M(20, 0, 20, 10),                        // 填寫區
    M(21, 0, 21, 10),                        // (5) band
    M(22, 0, 22, 4), M(22, 5, 22, 6), M(22, 7, 22, 8), M(22, 9, 22, 10), // 結案列 + 簽核表頭（三格各2欄）
    M(23, 0, 23, 4), M(23, 5, 24, 6), M(23, 7, 24, 8), M(23, 9, 24, 10), // 損失成本 + 簽名空格
    M(24, 0, 24, 4),                         // 其他
  ]

  ws['!cols'] = Array.from({ length: COLS }, () => ({ wch: 7.8 }))
  ws['!rows'] = [28, 18, 18, 18, 18, 18, 20, 16, 18, 80, 16, 18, 70, 18, 70, 18, 70, 20, 22, 18, 55, 16, 20, 30, 30]
    .map((hpt) => ({ hpt }))
  ws['!margins'] = { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
  ws['!ref'] = `A1:${XLSX.utils.encode_cell({ r: ROWS - 1, c: COLS - 1 })}`

  // 標籤列（左標籤＋右人名）：與下方填寫區之間不畫橫線、左右兩段之間不畫豎線，
  // 視覺上與填寫區合為同一大格（框線在上、人名在上、下方整片留白）
  const LABEL_ROWS = new Set([8, 11, 13, 15, 19])

  // 全區補實儲存格並上框線（合併範圍的框線須逐格設定才會顯示）；外框加粗
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      const cell = (ws[addr] as XLSX.CellObject | undefined) ?? { t: 's', v: '' }
      const existing = (cell.s ?? {}) as CellStyle
      const border: Record<string, unknown> = {}
      if (c === 0) border.left = MEDIUM
      else if (!LABEL_ROWS.has(r)) border.left = THIN
      if (c === COLS - 1) border.right = MEDIUM
      else if (!LABEL_ROWS.has(r)) border.right = THIN
      if (!LABEL_ROWS.has(r - 1)) border.top = r === 0 ? MEDIUM : THIN
      if (!LABEL_ROWS.has(r)) border.bottom = r === ROWS - 1 ? MEDIUM : THIN
      cell.s = { font: baseFont, ...existing, border }
      ws[addr] = cell
    }
  }

  return ws
}

// 批次抓取訂單資訊（一次 .in() 查詢）；查詢失敗時降級為空資料，缺失單照樣產出
const fetchOrderInfo = async (orderNumbers: string[]): Promise<Map<string, OrderInfo>> => {
  const map = new Map<string, OrderInfo>()
  if (orderNumbers.length === 0) return map
  try {
    const { data, error } = await supabase
      .from('erp_so_lines')
      .select('project_id, mbp_part, order_qty_oru, partner_name')
      .in('project_id', orderNumbers)
    if (error) throw error
    for (const row of (data || []) as { project_id: string; mbp_part: string | null; order_qty_oru: number | null; partner_name: string | null }[]) {
      const key = (row.project_id || '').trim()
      if (!key) continue
      if (!map.has(key)) map.set(key, { partnerName: row.partner_name || '', lines: [] })
      const info = map.get(key)!
      if (!info.partnerName && row.partner_name) info.partnerName = row.partner_name
      info.lines.push({ mbpPart: (row.mbp_part || '').trim(), qty: row.order_qty_oru })
    }
  } catch (err) {
    console.error('缺失單列印：訂單資訊查詢失敗，訂單欄位將留白', err)
  }
  return map
}

// 訂單量：品號對得上的行加總；對不上退回全行加總；查無訂單回 null
const resolveOrderQty = (info: OrderInfo | undefined, itemCode: string | null): number | null => {
  if (!info || info.lines.length === 0) return null
  const code = (itemCode || '').trim()
  const matched = code ? info.lines.filter((l) => l.mbpPart === code) : []
  const pool = matched.length > 0 ? matched : info.lines
  const qtys = pool.map((l) => l.qty).filter((q): q is number => q != null)
  if (qtys.length === 0) return null
  return qtys.reduce((s, q) => s + q, 0)
}

/** 解析出每張缺失單的內容（每筆紀錄 × 每位缺失人員一張），供預覽與下載共用。 */
export async function resolveDeficiencySheets(
  records: DeficiencyPrintRecord[],
  personnelDeptMap: ReadonlyMap<string, string>,
): Promise<DeficiencySheetData[]> {
  if (records.length === 0) return []

  const orderNumbers = [...new Set(records.map((r) => (r.order_number || '').trim()).filter(Boolean))]
  const orderInfoMap = await fetchOrderInfo(orderNumbers)

  const sheets: DeficiencySheetData[] = []
  let seq = 0
  for (const record of records) {
    const orderKey = (record.order_number || '').trim()
    const info = orderInfoMap.get(orderKey)
    const orderQty = resolveOrderQty(info, record.item_code)
    const lossQty = record.loss_qty
    const lossText = lossQty != null ? String(lossQty) : ''
    const rateText = lossQty != null && orderQty != null && orderQty > 0
      ? `${((lossQty / orderQty) * 100).toFixed(1)}%`
      : ''
    const dispMap = parseDisp(record.qa_disposition)
    const persons = normalizeArray(record.qa_responsible).map((p) => p.trim()).filter(Boolean)
    const sheetPersons = persons.length > 0 ? persons : ['']
    sheetPersons.forEach((person, personIdx) => {
      seq += 1
      sheets.push({
        sheetName: sanitizeSheetName(`${seq}_${person.slice(0, 8) || '未指定'}_${orderKey || record.id}`),
        serial: `QR-${orderKey || record.id}-${personIdx + 1}`,
        dateText: rocDate(record.created_at),
        createdDay: (record.created_at || '').slice(0, 10),
        partnerName: info?.partnerName || '',
        orderNumber: orderKey,
        orderQtyText: orderQty != null ? String(orderQty) : '',
        lossText,
        rateText,
        itemText: [record.item_code, record.item_name].filter(Boolean).join('　'),
        reason: record.reason || '',
        reporter: record.qa_reporter || '',
        causeAnalysis: record.cause_analysis || '',
        immediateAction: record.immediate_action || '',
        correctiveAction: record.corrective_action || '',
        handlers: normalizeArray(record.qa_handlers).join('、'),
        person,
        dept: person ? (personnelDeptMap.get(person) || '') : '',
        dispositionLine: dispositionLine(dispMap[person] || ''),
      })
    })
  }
  return sheets
}

/** 檔名：缺失人員姓名＋紀錄日期（單人=姓名、兩人=並列、三人以上=某某等N人；同日=YYYYMMDD、同月=YYYYMM、跨月=起迄） */
export const buildDeficiencyFileName = (sheets: DeficiencySheetData[]): string => {
  const uniqPersons = [...new Set(sheets.map((s) => s.person).filter(Boolean))]
  let personPart: string
  if (uniqPersons.length === 0) personPart = '未指定'
  else if (uniqPersons.length === 1) personPart = uniqPersons[0]
  else if (uniqPersons.length === 2) personPart = `${uniqPersons[0]}_${uniqPersons[1]}`
  else personPart = `${uniqPersons[0]}等${uniqPersons.length}人`
  personPart = personPart.replace(/[\\/:*?"<>|]/g, '')

  const days = [...new Set(sheets.map((s) => s.createdDay).filter(Boolean))].sort()
  const months = [...new Set(days.map((d) => d.slice(0, 7)))].sort()
  let datePart: string
  if (days.length === 1) datePart = days[0].replace(/-/g, '')
  else if (months.length === 1) datePart = months[0].replace(/-/g, '')
  else if (months.length > 1) datePart = `${months[0].replace(/-/g, '')}-${months[months.length - 1].replace(/-/g, '')}`
  else {
    const now = new Date()
    datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  }
  return `缺失單_${personPart}_${datePart}.xlsx`
}

/** 依已解析的內容產生工作簿並觸發下載。 */
export function downloadDeficiencyWorkbook(sheets: DeficiencySheetData[]): void {
  if (sheets.length === 0) return
  const wb = XLSX.utils.book_new()
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(wb, buildSheet(sheet), sheet.sheetName)
  }
  XLSX.writeFile(wb, buildDeficiencyFileName(sheets))
}
