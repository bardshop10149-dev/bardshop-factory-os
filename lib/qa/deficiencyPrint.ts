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

const COLS = 9
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

// 處置勾選：警告/小過/大過 對應勾（「口頭警告」含「警告」也勾警告）；
// 其他非空值勾「其他」附原文；空值全留白。
const dispositionLine = (dispValue: string): string => {
  const val = (dispValue || '').trim()
  const standard = ['警告', '小過', '大過']
  const hit = standard.find((s) => val.includes(s))
  const boxes = standard.map((s) => `${hit === s ? '☑' : '□'}${s}`)
  boxes.push(hit || !val ? '□其他：' : `☑其他：${val}`)
  return boxes.join('　　')
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

const buildSheet = (
  record: DeficiencyPrintRecord,
  person: string,
  dept: string,
  partnerName: string,
  orderQty: number | null,
  serial: string,
): XLSX.WorkSheet => {
  const ws: XLSX.WorkSheet = {}
  const lossQty = record.loss_qty
  const lossText = lossQty != null ? String(lossQty) : ''
  const rateText = lossQty != null && orderQty != null && orderQty > 0
    ? `${((lossQty / orderQty) * 100).toFixed(1)}%`
    : ''
  const handlers = normalizeArray(record.qa_handlers).join('、')
  const dispValue = parseDisp(record.qa_disposition)[person] || ''

  // R1 標題
  setCell(ws, 0, 0, '品質異常處理單', styles.title)
  // R2 編號 / 日期
  setCell(ws, 1, 0, `編號：${serial}`, styles.meta)
  setCell(ws, 1, 5, `日期：${rocDate(record.created_at)}`, styles.metaRight)
  // R3-R6 左：不良發生點（直向合併）
  setCell(ws, 2, 0, '不良發生點 Occurred Point：\n□進料檢驗　□半成品檢驗\n□成品檢驗　□其它：＿＿＿＿', styles.block)
  // R3-R6 右：訂單詳情（採購單號列已移除）
  setCell(ws, 2, 3, '廠商/客戶名稱', styles.label)
  setCell(ws, 2, 5, partnerName, styles.value)
  setCell(ws, 3, 3, '客戶訂單單號', styles.label)
  setCell(ws, 3, 5, record.order_number || '', styles.value)
  setCell(ws, 4, 3, '訂單量', styles.label)
  setCell(ws, 4, 5, orderQty != null ? String(orderQty) : '', styles.value)
  setCell(ws, 4, 7, '不良數', styles.label)
  setCell(ws, 4, 8, lossText, styles.value)
  setCell(ws, 5, 3, '不良率', styles.label)
  setCell(ws, 5, 5, rateText, styles.value)
  setCell(ws, 5, 7, '異常數量', styles.label)
  setCell(ws, 5, 8, lossText, styles.value)
  // R7 品名規格
  setCell(ws, 6, 0, '品名規格物料編號', styles.label)
  setCell(ws, 6, 3, [record.item_code, record.item_name].filter(Boolean).join('　'), styles.value)
  // R8-R10 (1) 發現人填寫
  setCell(ws, 7, 0, '（1）發現人填寫', styles.band)
  setCell(ws, 8, 0, `異常狀況說明：\n${record.reason || ''}`, styles.block)
  setCell(ws, 9, 0, `經辦：${record.qa_reporter || ''}`, styles.metaRight)
  // R11-R17 (2) 責任單位填寫
  setCell(ws, 10, 0, '（2）責任單位填寫', styles.band)
  setCell(ws, 11, 0, `異常原因分析：\n${record.cause_analysis || ''}`, styles.block)
  setCell(ws, 12, 0, `責任人員：${person}`, styles.metaRight)
  setCell(ws, 13, 0, `即時處理方式：\n${record.immediate_action || ''}`, styles.block)
  setCell(ws, 14, 0, `人員：${handlers}`, styles.metaRight)
  setCell(ws, 15, 0, `預防及修正方式：\n${record.corrective_action || ''}`, styles.block)
  setCell(ws, 16, 0, '部門主管：', styles.metaRight)
  // R18 部門 / 缺失人員（自原版上方移到處置方式正上方）
  setCell(ws, 17, 0, '部門', styles.label)
  setCell(ws, 17, 2, dept, styles.value)
  setCell(ws, 17, 4, '缺失人員', styles.label)
  setCell(ws, 17, 6, person, styles.value)
  // R19 (3) 處置方式（縮成一排）
  setCell(ws, 18, 0, '（3）處置方式', styles.label)
  setCell(ws, 18, 2, dispositionLine(dispValue), styles.value)
  // R20-R21 (4) 品保判定
  setCell(ws, 19, 0, '（4）品保判定責任歸屬：', styles.block)
  setCell(ws, 20, 0, '經辦人員：', styles.metaRight)
  // R22-R25 (5) 結案 + 簽核欄
  setCell(ws, 21, 0, '（5）結案', styles.band)
  setCell(ws, 22, 0, '責任單位：', styles.value)
  setCell(ws, 22, 3, '總經理室', styles.label)
  setCell(ws, 22, 5, '品保主管', styles.label)
  setCell(ws, 22, 7, '主責部門主管', styles.label)
  setCell(ws, 23, 0, '損失成本：', styles.value)
  setCell(ws, 24, 0, '其他：', styles.value)

  ws['!merges'] = [
    M(0, 0, 0, 8),                          // 標題
    M(1, 0, 1, 4), M(1, 5, 1, 8),           // 編號 / 日期
    M(2, 0, 5, 2),                          // 不良發生點（直向）
    M(2, 3, 2, 4), M(2, 5, 2, 8),           // 廠商/客戶名稱
    M(3, 3, 3, 4), M(3, 5, 3, 8),           // 客戶訂單單號
    M(4, 3, 4, 4), M(4, 5, 4, 6),           // 訂單量（H/I 為不良數）
    M(5, 3, 5, 4), M(5, 5, 5, 6),           // 不良率（H/I 為異常數量）
    M(6, 0, 6, 2), M(6, 3, 6, 8),           // 品名規格
    M(7, 0, 7, 8),                          // (1) band
    M(8, 0, 8, 8),                          // 異常狀況說明
    M(9, 0, 9, 8),                          // 經辦
    M(10, 0, 10, 8),                        // (2) band
    M(11, 0, 11, 8),                        // 異常原因分析
    M(12, 0, 12, 8),                        // 責任人員
    M(13, 0, 13, 8),                        // 即時處理方式
    M(14, 0, 14, 8),                        // 人員
    M(15, 0, 15, 8),                        // 預防及修正方式
    M(16, 0, 16, 8),                        // 部門主管
    M(17, 0, 17, 1), M(17, 2, 17, 3), M(17, 4, 17, 5), M(17, 6, 17, 8), // 部門/缺失人員
    M(18, 0, 18, 1), M(18, 2, 18, 8),       // (3) 處置方式
    M(19, 0, 19, 8),                        // (4)
    M(20, 0, 20, 8),                        // 經辦人員
    M(21, 0, 21, 8),                        // (5) band
    M(22, 0, 22, 2), M(22, 3, 22, 4), M(22, 5, 22, 6), M(22, 7, 22, 8), // 結案列 + 簽核表頭
    M(23, 0, 23, 2), M(23, 3, 24, 4), M(23, 5, 24, 6), M(23, 7, 24, 8), // 損失成本 + 簽名空格
    M(24, 0, 24, 2),                        // 其他
  ]

  ws['!cols'] = Array.from({ length: COLS }, () => ({ wch: 9.5 }))
  ws['!rows'] = [28, 18, 18, 18, 18, 18, 20, 16, 80, 18, 16, 70, 18, 70, 18, 70, 18, 20, 22, 55, 18, 16, 20, 30, 30]
    .map((hpt) => ({ hpt }))
  ws['!margins'] = { left: 0.4, right: 0.4, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 }
  ws['!ref'] = `A1:${XLSX.utils.encode_cell({ r: ROWS - 1, c: COLS - 1 })}`

  // 全區補實儲存格並上框線（合併範圍的框線須逐格設定才會顯示）；外框加粗
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      const cell = (ws[addr] as XLSX.CellObject | undefined) ?? { t: 's', v: '' }
      const existing = (cell.s ?? {}) as CellStyle
      cell.s = {
        font: baseFont,
        ...existing,
        border: {
          top: r === 0 ? MEDIUM : THIN,
          bottom: r === ROWS - 1 ? MEDIUM : THIN,
          left: c === 0 ? MEDIUM : THIN,
          right: c === COLS - 1 ? MEDIUM : THIN,
        },
      }
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

/** 產生缺失單工作簿並觸發下載：每筆紀錄 × 每位缺失人員一張工作表。 */
export async function printDeficiencySheets(
  records: DeficiencyPrintRecord[],
  personnelDeptMap: ReadonlyMap<string, string>,
): Promise<void> {
  if (records.length === 0) return

  const orderNumbers = [...new Set(records.map((r) => (r.order_number || '').trim()).filter(Boolean))]
  const orderInfoMap = await fetchOrderInfo(orderNumbers)

  const wb = XLSX.utils.book_new()
  let seq = 0
  for (const record of records) {
    const orderKey = (record.order_number || '').trim()
    const info = orderInfoMap.get(orderKey)
    const orderQty = resolveOrderQty(info, record.item_code)
    const persons = normalizeArray(record.qa_responsible).map((p) => p.trim()).filter(Boolean)
    const sheetPersons = persons.length > 0 ? persons : ['']
    sheetPersons.forEach((person, personIdx) => {
      seq += 1
      const serial = `QR-${orderKey || record.id}-${personIdx + 1}`
      const dept = person ? (personnelDeptMap.get(person) || '') : ''
      const ws = buildSheet(record, person, dept, info?.partnerName || '', orderQty, serial)
      const name = sanitizeSheetName(`${seq}_${person.slice(0, 8) || '未指定'}_${orderKey || record.id}`)
      XLSX.utils.book_append_sheet(wb, ws, name)
    })
  }

  const now = new Date()
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  XLSX.writeFile(wb, `缺失單_${ymd}.xlsx`)
}
