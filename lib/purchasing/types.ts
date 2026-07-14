// 採購專區（Purchasing Zone）共用型別與常數
// 注意：PublicPoLine 為跨區（如業務查詢）可見形狀 —— 絕不可加入供應商 / 付款欄位。

export const SHIP_METHODS = ['順豐', '空運', '海特快', '一般海運'] as const
export type ShipMethod = typeof SHIP_METHODS[number]

export const PAYMENT_PCTS = [0, 30, 50, 70, 100] as const
export type PaymentPct = typeof PAYMENT_PCTS[number]

// 執行進度＝三個里程碑：已發單、已出貨（皆採購手動點選）＋已到倉（入庫量滿足採購量自動亮）
export type Progress = '未發單' | '已發單' | '已出貨' | '已到倉'

/** 入庫量是否已滿足採購量（已到倉的判定依據） */
export function arrivedFull(t: { qty: number | null; received_qty: number | null }): boolean {
  return t.received_qty != null && t.qty != null && t.qty > 0 && t.received_qty >= t.qty
}

/** 目前抵達的最高里程碑（跨區單一標籤用）：已到倉 > 已出貨 > 已發單 > 未發單 */
export function milestoneOf(t: { sent_at: string | null; shipped_at: string | null; qty: number | null; received_qty: number | null }): Progress {
  if (arrivedFull(t)) return '已到倉'
  if (t.shipped_at) return '已出貨'
  if (t.sent_at) return '已發單'
  return '未發單'
}

/** 到期提醒門檻（交期前 N 日；2 含逾期） */
export const DUE_THRESHOLDS = [10, 5, 2] as const

/** 採購專區完整明細列（僅經 guardPermission('purchasing') 的 API 流出） */
export interface PoTrackingLine {
  doc_no: string
  sub_no: string
  item_code: string | null
  description: string | null
  qty: number | null
  unit: string | null
  received_qty: number | null         // 已入庫量（ARGO 進貨入庫後回寫的 ACTUAL_QTY）
  po_status: string | null            // ARGO HOLD_STATUS（OPEN…）
  order_date: string | null           // 下單日（YYYY-MM-DD）
  due_date: string | null             // 交期（YYYY-MM-DD，同步時已倒推 2 工作日）
  due_days: number | null             // 距交期天數（負值 = 已逾期）
  vendor_code: string | null
  vendor_name: string | null
  so_no: string | null                // 來源 SO/RO 單號
  so_line: string | null
  pr_no: string | null                // 對應請購單號（比對不到為 null）
  pr_sub: string | null
  mo_no: string | null                // 對應製令單號（比對不到為 null）
  buyer: string | null                // 承辦人姓名（SALES_NAME 優先，退回 erp_so_lines 對照表）
  buyer_id: string | null             // 承辦人工號（SALES_ID）
  sent_at: string | null              // null = 未發出；有值 = 已發給廠商（製作中）
  shipped_at: string | null           // null = 尚未出貨；有值 = 已出貨
  ship_method: ShipMethod | null
  expected_ship_date: string | null
  note: string | null                 // 採購手打備註（逐行，po_line_tracking.note）
  payment_pct: PaymentPct             // 表頭層級（同 doc_no 各行相同）
  updated_by: string | null
  updated_at: string | null
}

/** 到期提醒統計（互斥分組：due2 含逾期、due5 = 3~5 天、due10 = 6~10 天） */
export interface DueCounts {
  due2: number
  due5: number
  due10: number
  total: number
}

/**
 * 跨區可見的 PO 追蹤資訊（業務查詢等處點 PO 帶出）。
 * 結構性防外流：只有這些欄位，無 vendor_*、無 payment_*。
 */
export interface PublicPoLine {
  doc_no: string
  sub_no: string
  item_code: string | null
  description: string | null
  qty: number | null
  unit: string | null
  received_qty: number | null         // 已入庫量（非供應商敏感資訊）
  po_status: string | null
  due_date: string | null
  progress: Progress
  ship_method: ShipMethod | null
  expected_ship_date: string | null
}

/** 各式 ARGO 文字日期（YYYYMMDD / YYYY/MM/DD / YYYY-MM-DD…）→ YYYY-MM-DD */
export function normalizeDateText(d: string | null | undefined): string | null {
  if (!d) return null
  const s = String(d).trim()
  if (!s) return null
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  if (/^\d{4}\/\d{2}\/\d{2}/.test(s)) return s.slice(0, 10).replace(/\//g, '-')
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  return null
}

/** 今天（台北時間）的 YYYY-MM-DD */
export function todayTaipei(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/** 距交期天數（負值 = 已逾期）；日期無法解析回傳 null */
export function daysUntil(dueDate: string | null, todayIso: string): number | null {
  if (!dueDate) return null
  const due = Date.parse(`${dueDate}T00:00:00Z`)
  const today = Date.parse(`${todayIso}T00:00:00Z`)
  if (Number.isNaN(due) || Number.isNaN(today)) return null
  return Math.round((due - today) / 86400000)
}

/** 依未出貨明細計算到期提醒統計（已出貨或已到倉不計入） */
export function computeDueCounts(lines: Pick<PoTrackingLine, 'shipped_at' | 'due_days' | 'qty' | 'received_qty'>[]): DueCounts {
  const counts: DueCounts = { due2: 0, due5: 0, due10: 0, total: 0 }
  for (const l of lines) {
    if (l.shipped_at || arrivedFull(l) || l.due_days == null || l.due_days > 10) continue
    if (l.due_days <= 2) counts.due2++
    else if (l.due_days <= 5) counts.due5++
    else counts.due10++
    counts.total++
  }
  return counts
}
