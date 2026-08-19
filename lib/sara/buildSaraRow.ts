// SARA（塔台）SARA_101 匯入格式共用列產生器
//
// 欄位對應規則抽自 app/admin/sara/process-gen/page.tsx（原本 handleDownload／
// handleAppendToExchangeCsv 各自內嵌一份幾乎相同的陣列映射），供該頁面與改單專區
// （日後從出單表更正資料轉換成 SARA CSV 列）共用，避免兩處各自維護、邏輯漂移。

export interface SaraRow {
  order_number: string
  mfg_order_number: string
  product_name: string
  product_desc: string
  lot_number: string
  prod_qty: number
  due: string
  priority: string
  earliest_start: string
  job_seq: number | string
  workcenter: string
  job_name: string
  job_qty: number
  outsourcing: string
  est_time: number
  time_unit: string
  bom: string
  mat_req_qty: string
  customer?: string
  assigned_machine?: string   // 分配機台（僅台北廠印刷站2F/6F）
  factory?: 'T' | 'C' | 'O'   // 廠區（僅預覽，不匯出）
  _noRoute?: boolean
}

// CSV_H1（app/api/sara/exchange-csv/route.ts）22 欄順序：
// Order Number, Manufacturing Order Number, Product Name, Product Description,
// Lot Number, Production Quantity, Due, Priority Level, Earliest Start Time,
// Job Sequence, Workcenter, Job Name, Job Quantity, Out Sourcing, Est. Time,
// Time Unit, BOM Components, Material Required Quantity, customer_id,
// assigned_machine, Rule, Parameter 1
export function buildSaraRow(r: SaraRow): string[] {
  return [
    r.order_number, r.mfg_order_number, r.product_name, r.product_desc,
    r.lot_number, String(r.prod_qty), r.due, r.priority, r.earliest_start,
    String(r.job_seq), r.workcenter, r.job_name, String(r.job_qty), r.outsourcing,
    String(r.est_time), r.time_unit, r.bom, r.mat_req_qty,
    r.customer ?? '', r.assigned_machine ?? '', '', '',
  ]
}
