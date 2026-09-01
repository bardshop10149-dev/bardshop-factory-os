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
  // 重複發單警示——貼上解析時，這一列的「訂單號+序號」在其他日期的出單表已經出現過，
  // 可能是誤重複貼入/重複發單
  duplicate_alert?: boolean
  duplicate_alert_dismissed?: boolean
  // 被偵測到重複的其他日期（YYYY-MM-DD），供警示訊息顯示
  duplicate_alert_dates?: string[]
  // 示意圖（舊版單張欄位，僅供相容舊資料讀取，新資料一律寫入 sketch_urls）
  sketch_url?: string | null
  // 示意圖：對應這一列（訂單號#項號）的圖片/PDF，可能不只一張（同一品項常有多個版本/角度），
  // 全部上傳至 Supabase Storage 後存網址陣列於此，一經設定即所有人、所有裝置都看得到，
  // 不用每次重新選內網資料夾（見 order-sketch API）
  sketch_urls?: string[] | null
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

// 廠區警示（首次匯入警示功能）：委外(O)廠列的品項編碼／料號規定要以 C 開頭，
// 不是的話代表廠區可能填錯，需要人工確認。空品號（如「改單/示意圖」列）不計。
export function computeFactoryAlert(row: { factory: string; item_code: string }): boolean {
  if (row.factory !== 'O') return false
  const code = (row.item_code ?? '').trim().toUpperCase()
  if (!code) return false
  return !code.startsWith('C')
}

// 交期警示預設閾值（工作天）；使用者可在 app_settings key='due_date_thresholds' 覆寫
export const DUE_THRESHOLD_DEFAULTS: Record<string, number> = { T: 4, C: 5, O: 5 }

export function parseDeliveryDate(s: string): Date | null {
  const t = (s ?? '').trim()
  if (!t) return null
  let y: number, m: number, d: number
  if (/^\d{8}$/.test(t)) {
    y = +t.slice(0, 4); m = +t.slice(4, 6); d = +t.slice(6, 8)
  } else {
    const parts = t.slice(0, 10).split(/[/-]/)
    if (parts.length < 3) return null
    y = +parts[0]; m = +parts[1]; d = +parts[2]
  }
  if (!y || !m || !d) return null
  const dt = new Date(y, m - 1, d)
  return isNaN(dt.getTime()) ? null : dt
}

/**
 * 從「出單表日期」（day 0）開始，計算到 to 有幾個工作天（週一～週五）。
 * from 本身是 day 0，所以從 from+1 起算。如果 to <= from，回傳 0。
 */
export function countWorkingDaysFrom(from: Date, to: Date): number {
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

// 交期警示（首次匯入警示功能）：以出單日為第0天，交期距離出單日不足該廠別設定的工作天數
export function computeDueDateAlert(
  row: { factory: string; delivery_date: string },
  sheetDateObj: Date,
  thresholds: Record<string, number>,
): boolean {
  const threshold = thresholds[row.factory]
  if (threshold === undefined) return false
  if (!row.delivery_date) return false
  const dueDate = parseDeliveryDate(row.delivery_date)
  if (!dueDate) return false
  return countWorkingDaysFrom(sheetDateObj, dueDate) < threshold
}

const DONE_STATES = new Set(['已備料', '無需備料', '已批備料'])

// 從一天的完整 rows 算出列表頁要顯示的待處理計數——寫入時（POST/PATCH）算好存成獨立欄位，
// 讓列表 GET 不必再把每天的完整 rows JSONB 都抓下來重算一次。
// 抽自 app/api/argoerp/daily-order-sheet/route.ts，供該路由本身與美編出單表 16:00
// 轉入排程（app/api/cron/design-sheet-transfer/route.ts）共用，避免各自維護造成漂移。
export function computeSheetCounts(rowsArr: Array<Record<string, unknown>>) {
  const pendingMos = new Set<string>()
  let pendingPrCount = 0
  let pendingCCount = 0
  for (const row of rowsArr) {
    if (row.mo_status === '已匯入製令') {
      const mo = typeof row.mo_number === 'string' ? row.mo_number : ''
      if (mo) {
        const status = typeof row.material_prep_status === 'string' ? row.material_prep_status : ''
        if (!DONE_STATES.has(status)) pendingMos.add(mo)
      }
    }
    if (row.factory === 'O' && row.po_status !== 'no_po') {
      const mo = typeof row.mo_number === 'string' ? row.mo_number.trim().toUpperCase() : ''
      const pr = typeof row.pr_number === 'string' ? row.pr_number.trim().toUpperCase() : ''
      if (!mo.startsWith('MPO') && !pr.startsWith('MPO')) pendingPrCount++
    }
    if (row.factory === 'C' && !row.po_number && row.po_status !== 'matched') {
      pendingCCount++
    }
  }
  return {
    row_count: rowsArr.length,
    pending_count: pendingMos.size,
    pending_pr_count: pendingPrCount,
    pending_c_count: pendingCCount,
  }
}

// 受保護欄位：所有可由外部 PATCH（集單同步、批備料、採購比對等）寫入的欄位——
// incoming row 這些欄位為空、但 DB 既有列有值時，保留 DB 值，避免整批 POST 覆蓋掉。
const PRESERVE_IF_EMPTY = [
  'mo_number', 'mo_status',
  'material_prep_status', 'argo_slip_no',
  'po_number', 'po_sub_no', 'po_status', 'po_qty_erp', 'po_confirmed',
  'pr_number', 'pr_sub_no', 'pr_status',
  'match_status', 'match_line_no', 'match_pdl_seq', 'match_reason',
  'machine',
] as const

/**
 * 把「即將整批寫入」的 incoming rows 與資料庫既有 rows 合併：對每一筆 incoming row，
 * 依 row_key（找不到則退用「訂單號+序號」次要索引）找出對應的既有列，把既有列上
 * PRESERVE_IF_EMPTY 欄位的值（如製令/採購/請購單號、備料狀態、機台）補回 incoming row
 * 對應欄位為空的地方——確保整批覆寫（POST 貼上重新解析、美編出單表轉入等）不會
 * 把外部 PATCH（批備料、採購比對等）已經寫入的狀態洗掉。
 * 抽自 app/api/argoerp/daily-order-sheet/route.ts 的 POST handler，供該路由與
 * 美編出單表 16:00 轉入排程共用。
 */
export function mergeIncomingRowsWithExisting(
  existingRows: Array<Record<string, unknown>>,
  incomingRows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const existingMap = new Map(existingRows.map(r => [r.row_key as string, r]))
  const existingByOrderSeq = new Map<string, Array<Record<string, unknown>>>()
  for (const r of existingRows) {
    const orderNo = typeof r.order_number === 'string' ? r.order_number : ''
    const seq = typeof r.line_no_input === 'string' && r.line_no_input
      ? r.line_no_input
      : (typeof r.match_line_no === 'string' ? r.match_line_no : '')
    if (!orderNo || !seq) continue
    const key = `${orderNo}|${seq}`
    const arr = existingByOrderSeq.get(key) ?? []
    arr.push(r)
    existingByOrderSeq.set(key, arr)
  }
  const osConsumed = new Map<string, number>()

  return incomingRows.map(row => {
    let ex = existingMap.get(row.row_key as string)
    const lineNoInput = typeof row.line_no_input === 'string' ? row.line_no_input : ''
    const orderNo = typeof row.order_number === 'string' ? row.order_number : ''
    if (!ex && lineNoInput && orderNo) {
      const key = `${orderNo}|${lineNoInput}`
      const candidates = existingByOrderSeq.get(key)
      if (candidates && candidates.length > 0) {
        const idx = osConsumed.get(key) ?? 0
        ex = candidates[Math.min(idx, candidates.length - 1)]
        osConsumed.set(key, idx + 1)
      }
    }
    if (!ex) return row
    const out = { ...row }
    for (const field of PRESERVE_IF_EMPTY) {
      if ((out[field] === null || out[field] === undefined || out[field] === '') && ex[field] != null && ex[field] !== '') {
        out[field] = ex[field]
      }
    }
    // 特殊案例：同步明確找不到對應採購單（po_status='no_match'，po_number=null）時，
    // 不保留 DB 舊的 po_number，否則該列在 order-batch-export-c 篩選中消失（有 po_number 被排除）
    if (row.po_status === 'no_match' && (row.po_number == null || row.po_number === '')) {
      out.po_number = null
      out.po_sub_no = null
    }
    return out
  })
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
