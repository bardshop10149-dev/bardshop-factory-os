// 每日出單表（daily-order-sheet）共用型別與 row_key 產生規則
//
// 抽自 app/admin/argoerp/daily-order-sheet/page.tsx，供該頁面本身與改單專區
// （app/api/argoerp/change-order/route.ts、ChangeOrderPanel）共用，避免伺服器端
// API route 需要重算 row_key 時，跟頁面上的計算邏輯各自維護、彼此漂移。

// ===== 型別定義（與 order-batch-export 一致）=====
export interface SourceRow {
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
  mo_status: '已匯入製令' | null
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
  // 已手動轉換廠區（用不同底色標示）
  factory_changed?: boolean
  // 已透過改單專區人工更正過（日期/數量/品項編碼/廠區任一項），供合併時比照
  // factory_changed 的方式保留舊列的單據狀態，不被原始出單表重新解析覆蓋
  corrected?: boolean
  // 警示（第一次匯入時檢查一次，之後重新解析/載入同一列時原樣保留，不重複觸發）：
  // 交期警示——以出單日為第0天，交期距離出單日不足該廠別設定的工作天數
  due_date_alert?: boolean
  due_date_alert_dismissed?: boolean
  // 廠區警示——委外(O)廠列的品項編碼未以 C 開頭
  factory_alert?: boolean
  factory_alert_dismissed?: boolean
  // 示意圖：對應這一列（訂單號#項號）的圖片/PDF，上傳至 Supabase Storage 後存網址於此，
  // 一經設定即所有人、所有裝置都看得到，不用每次重新選內網資料夾（見 order-sketch API）
  sketch_url?: string | null
}

// 廠區切換時，該列在舊廠區底下取得的製令/採購/請購單號與備料狀態一律失效，必須清除，
// 否則會殘留錯誤資料（例如原本台北廠有製令號，改成常平後製令號沒被清掉，畫面上誤以為
// 常平那筆也已經有效轉單）。「無需備料」是使用者純手動設定、與任何單號無關，予以保留；
// 其餘備料狀態（已備料／已批備料）都衍生自舊廠區的 ARGO 動作，必須連同 argo_slip_no 一併清除。
export function clearStaleDocsOnFactoryChange<T extends {
  mo_number?: string
  mo_status?: '已匯入製令' | null
  po_number?: string | null
  po_sub_no?: string | null
  po_status?: 'matched' | 'no_match' | 'no_po' | 'qty_mismatch' | null
  po_qty_erp?: number | null
  po_confirmed?: boolean
  pr_number?: string | null
  pr_sub_no?: string | null
  pr_status?: 'matched' | 'no_match' | null
  argo_slip_no?: string | null
  material_prep_status?: '已備料' | '無需備料' | '已批備料' | null
}>(row: T): T {
  const keepPrep = row.material_prep_status === '無需備料'
  return {
    ...row,
    mo_number: undefined,
    mo_status: null,
    po_number: null,
    po_sub_no: null,
    po_status: null,
    po_qty_erp: null,
    po_confirmed: false,
    pr_number: null,
    pr_sub_no: null,
    pr_status: null,
    argo_slip_no: keepPrep ? row.argo_slip_no : null,
    material_prep_status: keepPrep ? row.material_prep_status : null,
  }
}

export function detectFactory(docType: string): 'T' | 'C' | 'O' {
  if (docType.includes('常平')) return 'C'
  if (docType.includes('委外')) return 'O'
  return 'T'
}

// 序號（B欄 line_no_input，或已比對出的 match_line_no）決定「同一張工單裡的哪一筆」，
// 必須納入 row_key 組成 —— 否則同工單/同品號/同數量/同交期但不同序號的多筆列會產生相同
// row_key，導致以 row_key 為鍵的操作（勾選 selectedKeys、逐列機台指派 rowMachines、
// handlePrint、handleBatchChangeFactory 等）互相污染。
// 優先採用使用者手動填入的 line_no_input；若尚無手動輸入（列本身也還沒有 line_no_input，
// 例如尚未比對完成的舊資料）則退用已比對出的 match_line_no，確保任何時間點重新計算
// row_key 都能維持列與列之間的唯一性。
export function createRowKey(row: SourceRow & { match_line_no?: string | null }): string {
  return [
    row.order_number,
    row.doc_type,
    row.factory,
    row.item_code,
    row.item_name,
    row.note,
    row.quantity,
    row.delivery_date,
    row.line_no_input || row.match_line_no || '',
  ].join('||')
}
