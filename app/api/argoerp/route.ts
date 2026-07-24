import { NextRequest, NextResponse } from 'next/server'

import { formatSupabaseAdminError, getSupabaseAdminClient } from '../../../lib/supabaseAdmin'
import { guardAuth, guardPermission } from '@/lib/requireAuth'
import { reconcileTable } from '@/lib/erpSyncReconcile'

const API_BASE = process.env.ARGOERP_API_BASE!
const USERNAME = process.env.ARGOERP_USERNAME!
const PASSWORD = process.env.ARGOERP_PASSWORD!
const SEGMENT = process.env.ARGOERP_SEGMENT!

interface ApiKeyResponse {
  RESULT: {
    APIKEY1: string
    APIKEY2: string
    APIKEY3: string
  }
}

interface PjSyncMapping {
  docNoField: string
  subNoField?: string
  itemCodeField?: string
  descriptionField?: string
  qtyField?: string
  unitField?: string
  statusField?: string
  startDateField?: string
  endDateField?: string
  customerVendorField?: string
  remarkField?: string
}

interface InventorySyncMapping {
  sequenceNoField?: string
  itemCodeField: string
  itemNameField?: string
  specField?: string
  unitField?: string
  physicalCountField?: string
  bookCountField: string
  warehouseTotalField?: string
  // 啟用時會將相同 itemCode 的 bookCountField 在 server 端累加（用於 iv_inventoryboh 等明細表）
  groupByItemCode?: boolean
}

function getRecordValue(record: Record<string, unknown> | undefined | null, fieldName?: string) {
  if (!record || !fieldName) return undefined

  if (fieldName in record) return record[fieldName]

  const normalizedField = fieldName.trim().toLowerCase()
  // 先嘗試精確比對（含表格前綴，如 "IV_NOTICE.SLIP_NO"）
  const matchedKey = Object.keys(record).find((key) => key.trim().toLowerCase() === normalizedField)
  if (matchedKey) return record[matchedKey]

  // JOIN 查詢時欄位可能帶表格前綴（如 "IV_NOTICE.SLIP_NO"），嘗試比對後綴
  const suffixKey = Object.keys(record).find((key) => {
    const lower = key.trim().toLowerCase()
    return lower === normalizedField || lower.endsWith('.' + normalizedField)
  })
  return suffixKey ? record[suffixKey] : undefined
}

function getFirstNonEmptyRecordValue(
  record: Record<string, unknown> | undefined | null,
  fieldNames: string[]
): string | null {
  for (const fieldName of fieldNames) {
    const raw = getRecordValue(record, fieldName)
    const value = String(raw ?? '').trim()
    if (value) return value
  }
  return null
}

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0

  const parsed = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}

// 交期規則：請購單／採購單匯入時，將交期往前推兩個「工作天」（跳過週六、週日）；
// 若往前推兩個工作天後的日期小於今日，則維持原交期不變。
// 支援格式：YYYYMMDD / YYYY/MM/DD / YYYY-MM-DD（含時間後綴），輸出維持與輸入相同的格式樣式。
function shiftDueDateBackTwoWorkdays(raw: string | null | undefined): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null

  // 解析成 Y/M/D 並記錄原始格式分隔樣式
  let y: number, m: number, d: number
  let style: 'compact' | 'slash' | 'dash'
  if (/^\d{8}$/.test(s)) {
    y = +s.slice(0, 4); m = +s.slice(4, 6); d = +s.slice(6, 8); style = 'compact'
  } else if (/^\d{4}\/\d{2}\/\d{2}/.test(s)) {
    y = +s.slice(0, 4); m = +s.slice(5, 7); d = +s.slice(8, 10); style = 'slash'
  } else if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    y = +s.slice(0, 4); m = +s.slice(5, 7); d = +s.slice(8, 10); style = 'dash'
  } else {
    return s // 非預期格式，原樣保留
  }

  const due = new Date(Date.UTC(y, m - 1, d))
  if (Number.isNaN(due.getTime())) return s

  // 往前推兩個工作天（跳過週六日）
  const shifted = new Date(due.getTime())
  let remaining = 2
  while (remaining > 0) {
    shifted.setUTCDate(shifted.getUTCDate() - 1)
    const dow = shifted.getUTCDay() // 0=日, 6=六
    if (dow !== 0 && dow !== 6) remaining--
  }

  // 若推算後日期 < 今日，維持原交期不變
  const now = new Date()
  const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
  if (shifted.getTime() < todayUTC.getTime()) return s

  const yy = shifted.getUTCFullYear()
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(shifted.getUTCDate()).padStart(2, '0')
  if (style === 'compact') return `${yy}${mm}${dd}`
  if (style === 'slash') return `${yy}/${mm}/${dd}`
  return `${yy}-${mm}-${dd}`
}

function findObjectRows(value: unknown, seen = new Set<unknown>()): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return []
  if (seen.has(value)) return []
  seen.add(value)

  if (Array.isArray(value)) {
    const objectRows = value.filter(
      (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)
    )
    if (objectRows.length > 0) return objectRows

    for (const item of value) {
      const nested = findObjectRows(item, seen)
      if (nested.length > 0) return nested
    }

    return []
  }

  const record = value as Record<string, unknown>
  const priorityKeys = ['RESULT', 'DATA', 'ROWS', 'rows', 'items', 'Items', 'Table', 'TABLE']

  for (const key of priorityKeys) {
    if (!(key in record)) continue
    const nested = findObjectRows(record[key], seen)
    if (nested.length > 0) return nested
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findObjectRows(nestedValue, seen)
    if (nested.length > 0) return nested
  }

  return []
}

function normalizeInventoryRows(rows: Record<string, unknown>[], mapping: InventorySyncMapping) {
  const normalizedAt = new Date().toISOString()

  if (mapping.groupByItemCode) {
    // 明細表模式：將相同 itemCode 的 bookCountField 累加（等效 GROUP BY mbp_part SUM(qty)）
    const grouped = new Map<string, {
      item_code: string
      item_name: string
      spec: string
      unit_of_measure: string | null
      book_count: number
      physical_count: number
      qisheng_sichuan_total: number
    }>()

    for (const row of rows) {
      const itemCode = String(getRecordValue(row, mapping.itemCodeField) ?? '').trim()
      if (!itemCode) continue
      const existing = grouped.get(itemCode)
      const bookQty = toNumber(getRecordValue(row, mapping.bookCountField))
      const rowUnit = mapping.unitField ? String(getRecordValue(row, mapping.unitField) ?? '').trim() || null : null
      if (existing) {
        existing.book_count += bookQty
        existing.physical_count += toNumber(getRecordValue(row, mapping.physicalCountField))
        existing.qisheng_sichuan_total += toNumber(getRecordValue(row, mapping.warehouseTotalField))
        if (!existing.unit_of_measure && rowUnit) existing.unit_of_measure = rowUnit
      } else {
        grouped.set(itemCode, {
          item_code: itemCode,
          item_name: String(getRecordValue(row, mapping.itemNameField) ?? '').trim(),
          spec: String(getRecordValue(row, mapping.specField) ?? '').trim(),
          unit_of_measure: rowUnit,
          book_count: bookQty,
          physical_count: toNumber(getRecordValue(row, mapping.physicalCountField)),
          qisheng_sichuan_total: toNumber(getRecordValue(row, mapping.warehouseTotalField)),
        })
      }
    }

    return [...grouped.values()].map((entry, index) => ({
      sequence_no: index + 1,
      ...entry,
      updated_at: normalizedAt,
    }))
  }

  // 一般模式：一資料一筆
  const normalizedRows = rows
    .map((row, index) => {
      const itemCode = String(getRecordValue(row, mapping.itemCodeField) ?? '').trim()
      if (!itemCode) return null

      return {
        sequence_no: mapping.sequenceNoField ? toNumber(getRecordValue(row, mapping.sequenceNoField)) : index + 1,
        item_code: itemCode,
        item_name: String(getRecordValue(row, mapping.itemNameField) ?? '').trim(),
        spec: String(getRecordValue(row, mapping.specField) ?? '').trim(),
        unit_of_measure: mapping.unitField ? String(getRecordValue(row, mapping.unitField) ?? '').trim() || null : null,
        physical_count: toNumber(getRecordValue(row, mapping.physicalCountField)),
        book_count: toNumber(getRecordValue(row, mapping.bookCountField)),
        qisheng_sichuan_total: toNumber(getRecordValue(row, mapping.warehouseTotalField)),
        updated_at: normalizedAt,
      }
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))

  return normalizedRows
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // 第一次失敗：ARGO REMARK 等欄位可能含有未 escape 的控制字元（換行、Tab 等），
    // 違反 JSON 規格 → 先將控制字元轉成合法 escape 序列後再試一次
    try {
      const fixed = text.replace(
        /[\u0000-\u001F\u007F\u0085\u2028\u2029]/g,
        ch => {
          if (ch === '\n') return '\\n'
          if (ch === '\r') return '\\r'
          if (ch === '\t') return '\\t'
          return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
        }
      )
      return JSON.parse(fixed)
    } catch {
      return text
    }
  }
}

function extractApiError(result: unknown): string | null {
  if (!result) return null
  if (typeof result === 'string') {
    return /(error|exception|invalid|ora-|未授權|授權失敗|授權錯誤|無權|驗證失敗|webservice未|失敗)/i.test(result) ? result : null
  }
  if (typeof result !== 'object') return null

  const record = result as Record<string, unknown>
  const candidates = [record.ERROR, record.error, record.message, record.MESSAGE]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }

  // 從 RESULT 陣列收集 CHECK_FLAG=N 的 ERROR_CODE
  if (Array.isArray(record.RESULT)) {
    const errorLines = (record.RESULT as Record<string, unknown>[])
      .filter(row => String(row.CHECK_FLAG ?? '').toUpperCase() === 'N')
      .map(row => `${row.SLIP_NO ?? ''} L${row.LINE_NO ?? ''}: ${row.ERROR_CODE ?? ''}`)
      .filter(Boolean)
    if (errorLines.length > 0) return errorLines.join('\n')
  }

  return null
}

function isArgoSuccess(result: unknown): boolean {
  if (!result) return false
  if (typeof result === 'string') {
    return !/(error|exception|invalid|ora-|未授權|授權失敗|授權錯誤|無權|驗證失敗|webservice未|失敗)/i.test(result)
  }
  if (typeof result !== 'object') return true

  const record = result as Record<string, unknown>
  if (record.STATUS !== undefined) {
    const status = String(record.STATUS).trim().toUpperCase()
    if (['0', 'FALSE', 'N', 'ERROR'].includes(status)) return false
  }

  // 檢查 RESULT 陣列中是否有任何 CHECK_FLAG = 'N' (ARGO 驗證失敗)
  if (Array.isArray(record.RESULT)) {
    const hasCheckError = (record.RESULT as Record<string, unknown>[]).some(
      row => String(row.CHECK_FLAG ?? '').toUpperCase() === 'N'
    )
    if (hasCheckError) return false
  }

  return extractApiError(result) === null
}

async function readApiResponse(res: Response) {
  const rawText = await res.text()
  const parsed = rawText ? tryParseJson(rawText) : null
  return { rawText, parsed }
}

async function getApiKeys(): Promise<{ APIKEY1: string; APIKEY2: string; APIKEY3: string }> {
  const res = await fetch(`${API_BASE}/S_APIKEY`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`S_APIKEY failed: ${res.status}`)
  const data: ApiKeyResponse = await res.json()
  if (!data.RESULT?.APIKEY1) throw new Error('S_APIKEY returned no keys')
  return data.RESULT
}

// GET: 測試連線 — 取得版本 + 金鑰驗證
export async function GET() {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res

  try {
    // 1. 取得 API 版本
    const versionRes = await fetch(`${API_BASE}/S_VERSION`, { method: 'GET' })
    const versionData = await versionRes.text()

    // 2. 取得金鑰（驗證帳密是否正確）
    const keys = await getApiKeys()

    return NextResponse.json({
      status: 'ok',
      version: versionData,
      segment: SEGMENT,
      keysObtained: true,
      apiBase: API_BASE,
    })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ status: 'error', error: message }, { status: 500 })
  }
}

// POST: 匯入製令資料
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { action, data, interfaceId } = body as {
      action: 'import' | 'query' | 'query_so_detail' | 'sync_inventory' | 'sync_customer' | 'sync_vendor' | 'fetch_po_pdl_links' | 'explore_so_columns' | 'test_so_detail' | 'test_po_detail' | 'sync_so' | 'sync_mo' | 'sync_pj' | 'sync_po' | 'sync_pr' | 'sync_bom_units' | 'sync_bom_structure' | 'sync_material_prep'
      data?: Record<string, unknown>[]
      interfaceId?: string
    }

    // 權限分級：只有「寫入 ERP」(import) 需 production_admin；其餘同步/查詢類只需登入即可。
    // 若來自內部 webhook（X-Internal-Secret 驗證通過），直接放行。
    const internalSecret = request.headers.get('X-Internal-Secret') ?? ''
    const webhookSecret = process.env.WEBHOOK_SECRET ?? ''
    const isInternalCall = !!(webhookSecret && internalSecret === webhookSecret)

    const guard = action === 'import'
      ? await guardPermission('production_admin')
      : isInternalCall ? { ok: true as const, res: null }
      : await guardAuth()
    if (!guard.ok) return guard.res

    // 取得金鑰（5 分鐘時效）
    const keys = await getApiKeys()

    if (action === 'import') {
      if (!data || !interfaceId) {
        return NextResponse.json({ status: 'error', error: 'Missing data or interfaceId' }, { status: 400 })
      }

      const sparam = JSON.stringify({
        APIKEY1: keys.APIKEY1,
        APIKEY2: keys.APIKEY2,
        APIKEY3: keys.APIKEY3,
        SEGMENT,
        IMP: 'Y',
        INTERFACE: interfaceId,
        DATA: data,
      })

      const res = await fetch(`${API_BASE}/S_IMPORT`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam }),
      })

      const { rawText, parsed } = await readApiResponse(res)
      const resultRows = (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).RESULT))
        ? ((parsed as Record<string, unknown>).RESULT as Record<string, unknown>[])
        : []
      const hasCheckY = resultRows.some(row => String(row.CHECK_FLAG ?? '').toUpperCase() === 'Y')
      const hasCheckN = resultRows.some(row => String(row.CHECK_FLAG ?? '').toUpperCase() === 'N')

      // IMPORT 端點常見「已寫入但附帶警示字串」情況：
      // 若 RESULT 存在且無 N，視為成功；若有 Y 也有 N，視為部分成功（success=false 但 HTTP 200）。
      const success = res.ok && (
        (resultRows.length > 0 ? !hasCheckN : isArgoSuccess(parsed))
      )
      const error = hasCheckN ? extractApiError(parsed) : (success ? null : extractApiError(parsed))
      const partialSuccess = res.ok && hasCheckY && hasCheckN

      return NextResponse.json({
        status: success ? 'ok' : 'error',
        success,
        partialSuccess,
        anySuccess: hasCheckY,
        error,
        apiResult: parsed,
        rawText,
      }, { status: res.ok ? 200 : 502 })
    }

    if (action === 'query') {
      const { table, filters, customColumn } = body as {
        table: string
        filters?: Record<string, string>
        customColumn?: string
      }

      const sparam = JSON.stringify({
        APIKEY1: keys.APIKEY1,
        APIKEY2: keys.APIKEY2,
        APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: table,
        SHOWNULLCOLUMN: 'N',
        ...(customColumn ? { CUSTOMCOLUMN: customColumn } : {}),
        ...(filters || {}),
      })

      const res = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam }),
      })

      const { rawText, parsed } = await readApiResponse(res)
      const error = extractApiError(parsed)
      const success = res.ok && isArgoSuccess(parsed)

      return NextResponse.json({
        status: success ? 'ok' : 'error',
        success,
        error,
        apiResult: parsed,
        rawText,
      }, { status: success ? 200 : 502 })
    }

    if (action === 'query_so_detail') {
      // ── 單張 SO 即時明細（供 SoOrderModal 即時回 ARGO 撈規格用）──────────────
      // 直接查 ARGO（PJ_PROJECT 表頭 + PJ_PROJECTDETAIL 明細，JS 端 JOIN），
      // 不經 erp_so_lines 同步表，確保「當天新單／剛更新的單」也看得到最新規格。
      const rawProjectId = String((body as { projectId?: unknown }).projectId ?? '').trim()
      // 防注入：SO 單號只會是英數（如 SO260709018、SOB260707517），其餘字元一律剔除
      const projectId = rawProjectId.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
      if (!projectId) {
        return NextResponse.json({ status: 'error', error: '缺少 projectId' }, { status: 400 })
      }

      // 表頭：取 CUSTOMER_REMARK（表頭備註）＋基本資訊
      const headSparam = JSON.stringify({
        APIKEY1: keys.APIKEY1, APIKEY2: keys.APIKEY2, APIKEY3: keys.APIKEY3,
        SEGMENT, TABLE: 'PJ_PROJECT', SHOWNULLCOLUMN: 'Y',
        PROJECT_ID: `= '${projectId}'`,
      })
      const headRes = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam: headSparam }),
      })
      const { parsed: parsedHead, rawText: rawHead } = await readApiResponse(headRes)
      if (!headRes.ok || !isArgoSuccess(parsedHead)) {
        return NextResponse.json({
          status: 'error',
          error: extractApiError(parsedHead) || 'ARGO PJ_PROJECT 查詢失敗',
          rawText: rawHead,
        }, { status: 502 })
      }
      const headerRow = findObjectRows(parsedHead).find(
        r => String(getRecordValue(r, 'PROJECT_ID') ?? '').trim().toUpperCase() === projectId,
      )

      // 明細：規格(REMARK)／商品備註(REMARK2)／包裝(PACKING)／等
      const detailSparam = JSON.stringify({
        APIKEY1: keys.APIKEY1, APIKEY2: keys.APIKEY2, APIKEY3: keys.APIKEY3,
        SEGMENT, TABLE: 'PJ_PROJECTDETAIL', SHOWNULLCOLUMN: 'N',
        CUSTOMCOLUMN: 'PJT_PROJECT_ID,LINE_NO,MBP_PART,MBP_VER,DUEDATE,ORDER_QTY_ORU,UNIT_OF_MEASURE_ORU,REMARK,PACKING,REMARK2,GRADE',
        PJT_PROJECT_ID: `= '${projectId}'`,
      })
      const detailRes = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam: detailSparam }),
      })
      const { parsed: parsedDetail, rawText: rawDetail } = await readApiResponse(detailRes)
      if (!detailRes.ok || !isArgoSuccess(parsedDetail)) {
        return NextResponse.json({
          status: 'error',
          error: extractApiError(parsedDetail) || 'ARGO PJ_PROJECTDETAIL 查詢失敗',
          rawText: rawDetail,
        }, { status: 502 })
      }

      // 只留該 project 的明細，並依 LINE_NO 去重
      const dedupe = new Map<string, Record<string, unknown>>()
      for (const row of findObjectRows(parsedDetail)) {
        const pid = String(getRecordValue(row, 'PJT_PROJECT_ID') ?? '').trim().toUpperCase()
        if (pid !== projectId) continue
        const lineNo = String(getRecordValue(row, 'LINE_NO') ?? '').trim()
        if (!dedupe.has(lineNo)) dedupe.set(lineNo, row)
      }

      const holdStatus = String(getRecordValue(headerRow, 'HOLD_STATUS') ?? '').trim() || null
      const lines = Array.from(dedupe.values())
        .map(row => ({
          line_no: getRecordValue(row, 'LINE_NO') != null ? Number(getRecordValue(row, 'LINE_NO')) : null,
          description: String(getRecordValue(row, 'REMARK') ?? '').trim() || null,   // 規格（長串 REMARK）
          mbp_part: String(getRecordValue(row, 'MBP_PART') ?? '').trim() || null,
          duedate: String(getRecordValue(row, 'DUEDATE') ?? '').trim() || null,
          order_qty_oru: toNumber(getRecordValue(row, 'ORDER_QTY_ORU')),
          unit_of_measure_oru: String(getRecordValue(row, 'UNIT_OF_MEASURE_ORU') ?? '').trim() || null,
          remark: String(getRecordValue(row, 'REMARK2') ?? '').trim() || null,       // 商品備註 = REMARK2（沿用 sync_so 對應）
          packing: String(getRecordValue(row, 'PACKING') ?? '').trim() || null,
          remark2: String(getRecordValue(row, 'REMARK2') ?? '').trim() || null,
          grade: String(getRecordValue(row, 'GRADE') ?? '').trim() || null,
          hold_status: holdStatus,
        }))
        .sort((a, b) => (a.line_no ?? 0) - (b.line_no ?? 0))

      return NextResponse.json({
        status: 'ok',
        success: true,
        meta: {
          project_id: projectId,
          begin_date: String(getRecordValue(headerRow, 'BEGIN_DATE') ?? '').trim() || null,
          sales_name: String(getRecordValue(headerRow, 'SALES_NAME') ?? '').trim() || null,
          partner_name: String(getRecordValue(headerRow, 'PARTNER_NAME') ?? '').trim() || null,
          hold_status: holdStatus,
          customer_remark: getFirstNonEmptyRecordValue(headerRow, ['CUSTOMER_REMARK', 'REMARK']),
        },
        lines,
      })
    }

    if (action === 'sync_inventory') {
      const { table, filters, customColumn, mapping } = body as {
        table: string
        filters?: Record<string, string>
        customColumn?: string
        mapping?: InventorySyncMapping
      }

      if (!table?.trim()) {
        return NextResponse.json({ status: 'error', error: 'Missing inventory table' }, { status: 400 })
      }

      if (!mapping?.itemCodeField?.trim() || !mapping?.bookCountField?.trim()) {
        return NextResponse.json({ status: 'error', error: 'Missing required inventory field mapping' }, { status: 400 })
      }

      const sparam = JSON.stringify({
        APIKEY1: keys.APIKEY1,
        APIKEY2: keys.APIKEY2,
        APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: table,
        SHOWNULLCOLUMN: 'N',
        ...(customColumn ? { CUSTOMCOLUMN: customColumn } : {}),
        ...(filters || {}),
      })

      const res = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam }),
      })

      const { rawText, parsed } = await readApiResponse(res)
      const error = extractApiError(parsed)
      const success = res.ok && isArgoSuccess(parsed)

      if (!success) {
        return NextResponse.json({
          status: 'error',
          error: error || 'ARGO inventory query failed',
          apiResult: parsed,
          rawText,
        }, { status: 502 })
      }

      const queryRows = findObjectRows(parsed)
      if (queryRows.length === 0) {
        return NextResponse.json({
          status: 'error',
          error: 'ARGO 查詢成功，但找不到可映射的資料列，請確認 TABLE / CUSTOMCOLUMN / 欄位設定。',
          apiResult: parsed,
          rawText,
        }, { status: 422 })
      }

      const normalizedRows = normalizeInventoryRows(queryRows, mapping)
      if (normalizedRows.length === 0) {
        return NextResponse.json({
          status: 'error',
          error: 'ARGO 查詢有回傳資料，但目前欄位映射抓不到料號，請調整欄位名稱。',
          apiResult: parsed,
          rawText,
        }, { status: 422 })
      }

      // 庫存單位補值：部分庫存表未開放 API 查詢單位（或查詢結果不含單位），
      // 改以 mm_bom_part_units（同步自 MM_BOM_PART.UNIT_OF_MEASURE）依料號比對補上庫存單位。
      // 已從庫存查詢取得單位者（unitField）優先保留，僅補空值。
      try {
        const supabaseAdminForUnit = getSupabaseAdminClient()
        const itemCodes = [...new Set(normalizedRows.map((r) => r.item_code).filter(Boolean))]
        const unitMap = new Map<string, string>()
        const UNIT_BATCH = 300
        for (let i = 0; i < itemCodes.length; i += UNIT_BATCH) {
          const slice = itemCodes.slice(i, i + UNIT_BATCH)
          const { data: unitData } = await supabaseAdminForUnit
            .from('mm_bom_part_units')
            .select('part_code, unit_of_measure')
            .in('part_code', slice)
          for (const u of unitData ?? []) {
            const code = String(u.part_code ?? '').trim()
            const unit = String(u.unit_of_measure ?? '').trim()
            if (code && unit) unitMap.set(code, unit)
          }
        }
        for (const r of normalizedRows) {
          const rowWithUnit = r as { item_code: string; unit_of_measure?: string | null }
          if (!rowWithUnit.unit_of_measure) {
            rowWithUnit.unit_of_measure = unitMap.get(rowWithUnit.item_code) ?? null
          }
        }
      } catch {
        // 補單位失敗不影響庫存主資料同步
      }

      try {
        const supabaseAdmin = getSupabaseAdminClient()
        // 增量比對更新（取代整批 delete+insert）。sequence_no 為位置性編號，
        // 納入比對以維持「每次同步照 ARGO 順序重新編號」的原行為（首頁/物料頁靠它排序與搜尋）。
        await reconcileTable(supabaseAdmin, {
          table: 'material_inventory_list',
          keyCols: ['item_code'],
          compareCols: ['sequence_no', 'item_name', 'spec', 'unit_of_measure', 'physical_count', 'book_count', 'qisheng_sichuan_total'],
          rows: normalizedRows,
          action: 'sync_inventory',
          docNoCol: 'item_code',
        })
      } catch (error) {
        const pgErr = error as { message?: string; code?: string; details?: string; hint?: string }
        const message = pgErr?.message
          ? `寫入 material_inventory_list 失敗：${pgErr.message}${pgErr.details ? ` / ${pgErr.details}` : ''}${pgErr.hint ? ` (hint: ${pgErr.hint})` : ''}`
          : error instanceof Error ? formatSupabaseAdminError(error.message) : '寫入 material_inventory_list 失敗（未知錯誤）'
        return NextResponse.json({ status: 'error', error: message }, { status: 500 })
      }

      return NextResponse.json({
        status: 'ok',
        syncedCount: normalizedRows.length,
        skippedCount: Math.max(0, queryRows.length - normalizedRows.length),
        table,
        rawSample: queryRows[0] ?? null,
      })
    }

    if (action === 'fetch_po_pdl_links') {
      // ── 查詢有 PDL_SEQ_SO 的採購單明細（代表此 PO 行連結了某 SO 行） ──
      const poSparam = JSON.stringify({
        APIKEY1: keys.APIKEY1, APIKEY2: keys.APIKEY2, APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: 'PJ_PROJECTDETAIL',
        SHOWNULLCOLUMN: 'N',
        CUSTOMCOLUMN: [
          'PJ_PROJECTDETAIL.PJT_PROJECT_ID',
          'PJ_PROJECTDETAIL.PDL_SEQ',
          'PJ_PROJECTDETAIL.SO_PROJECT_ID',
          'PJ_PROJECTDETAIL.PDL_SEQ_SO',
          'PJ_PROJECTDETAIL.LINE_NO',
          'PJ_PROJECTDETAIL.MBP_PART',
          'PJ_PROJECTDETAIL.ORDER_QTY_ORU',
        ].join(','),
        'PJ_PROJECTDETAIL.PDL_SEQ_SO': 'IS NOT NULL',
      })
      const poRes = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam: poSparam }),
      })
      const { parsed: parsedPo, rawText: rawPo } = await readApiResponse(poRes)
      const poError = extractApiError(parsedPo)
      if (!poRes.ok || !isArgoSuccess(parsedPo)) {
        return NextResponse.json({
          status: 'error',
          error: poError || 'ARGO PO PDL_SEQ_SO query failed',
          rawText: rawPo,
        }, { status: 502 })
      }
      const poRows = findObjectRows(parsedPo)
      const links = poRows.map((row) => ({
        po_project_id: String(getRecordValue(row, 'PJT_PROJECT_ID') ?? '').trim(),
        pdl_seq:       getRecordValue(row, 'PDL_SEQ') != null ? Number(getRecordValue(row, 'PDL_SEQ')) : null,
        so_project_id: String(getRecordValue(row, 'SO_PROJECT_ID') ?? '').trim(),
        pdl_seq_so:    getRecordValue(row, 'PDL_SEQ_SO') != null ? Number(getRecordValue(row, 'PDL_SEQ_SO')) : null,
        line_no:       String(getRecordValue(row, 'LINE_NO') ?? '').trim(),
        mbp_part:      String(getRecordValue(row, 'MBP_PART') ?? '').trim(),
        order_qty_oru: getRecordValue(row, 'ORDER_QTY_ORU') != null ? Number(getRecordValue(row, 'ORDER_QTY_ORU')) : null,
      }))
      return NextResponse.json({ status: 'ok', count: links.length, links })
    }

    if (action === 'explore_so_columns') {
      // ── 探索 PJ_PROJECT 和 PJ_PROJECTDETAIL 全部欄位 ──────
      // PJ_PROJECT：取 1 筆 SO
      const headerSparam = JSON.stringify({
        APIKEY1: keys.APIKEY1, APIKEY2: keys.APIKEY2, APIKEY3: keys.APIKEY3,
        SEGMENT, TABLE: 'PJ_PROJECT', SHOWNULLCOLUMN: 'Y',
        PJT_TYPE: "= 'SO'", ROWNUM: '<= 1',
      })
      const headerRes = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam: headerSparam }),
      })
      const { parsed: ph } = await readApiResponse(headerRes)
      const headerRow = findObjectRows(ph)[0] ?? {}

      // PJ_PROJECTDETAIL：取 PROJECT_ID RO26033104 的 1 筆明細
      const detailSparam = JSON.stringify({
        APIKEY1: keys.APIKEY1, APIKEY2: keys.APIKEY2, APIKEY3: keys.APIKEY3,
        SEGMENT, TABLE: 'PJ_PROJECTDETAIL', SHOWNULLCOLUMN: 'Y',
        PJT_PROJECT_ID: "= 'RO26033104'", ROWNUM: '<= 1',
      })
      const detailRes = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam: detailSparam }),
      })
      const { parsed: pd } = await readApiResponse(detailRes)
      const detailRow = findObjectRows(pd)[0] ?? {}

      return NextResponse.json({
        status: 'ok',
        pj_project_columns: Object.keys(headerRow),
        pj_project_sample: headerRow,
        pj_projectdetail_columns: Object.keys(detailRow),
        pj_projectdetail_sample: detailRow,
      })
    }

    if (action === 'test_so_detail') {
      // ── SO 明細查詢測試 (PJ_PROJECT JOIN PJ_PROJECTDETAIL) ──
      const { projectId } = body as { projectId?: string }
      const sparam: Record<string, string> = {
        APIKEY1: keys.APIKEY1,
        APIKEY2: keys.APIKEY2,
        APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: 'PJ_PROJECT,PJ_PROJECTDETAIL',
        SHOWCOLUMNTIME: 'Y',
        SHOWNULLCOLUMN: 'Y',
        CUSTOMCOLUMN: [
          'PJ_PROJECT.PROJECT_ID',
          'PJ_PROJECT.SALES_ID',
          'PJ_PROJECT.TPN_PARTNER_ID',
          'PJ_PROJECT.CURRENCY',
          'PJ_PROJECT.EXCHANGE_RATE',
          'PJ_PROJECT.SEG_SEGMENT_NO_DEPARTMENT',
          'PJ_PROJECT.SALES_CATEGORY',
          'PJ_PROJECT.BEGIN_DATE',
          'PJ_PROJECT.HOLD_STATUS',
          'PJ_PROJECTDETAIL.LINE_NO',
          'PJ_PROJECTDETAIL.MBP_PART',
          'PJ_PROJECTDETAIL.MBP_VER',
          'PJ_PROJECTDETAIL.DUEDATE',
          'PJ_PROJECTDETAIL.ORDER_QTY_ORU',
          'PJ_PROJECTDETAIL.UNIT_OF_MEASURE_ORU',
          'PJ_PROJECTDETAIL.UNIT_PRICE_ORU',
          'PJ_PROJECTDETAIL.GRADE',
          'PJ_PROJECT.CREATE_DATE',
          'PJ_PROJECT.UPDATE_DATE',
        ].join(','),
        'PJ_PROJECT.PROJECT_ID': '=PJ_PROJECTDETAIL.PJT_PROJECT_ID',
      }
      if (projectId?.trim()) {
        sparam['PROJECT_ID'] = `='${projectId.trim()}'`
      } else {
        sparam['PJ_PROJECT.PJT_TYPE'] = "= 'SO'"
        sparam['ROWNUM'] = '<= 5'
      }

      const res = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam: JSON.stringify(sparam) }),
      })
      const { parsed, rawText } = await readApiResponse(res)
      const rows = findObjectRows(parsed)
      return NextResponse.json({
        status: res.ok ? 'ok' : 'error',
        httpStatus: res.status,
        rowCount: rows.length,
        sampleRow: rows[0] ?? null,
        allRows: rows,
        rawText: rawText.slice(0, 3000),
      })
    }

    if (action === 'sync_so') {
      // ── 銷售訂單同步 (兩段式：先查 PJ_PROJECT 表頭，再查 PJ_PROJECTDETAIL，JS 端 JOIN) ──
      // 不使用 ARGO 端 SQL JOIN，避免 ORA-00923 / 虛擬欄位地雷（與 sync_mo 同樣模式）
      const soHeaderSparam = JSON.stringify({
        APIKEY1: keys.APIKEY1,
        APIKEY2: keys.APIKEY2,
        APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: 'PJ_PROJECT',
        // 只取確定存在的核心欄位，避免兩種 Oracle 錯誤：
        // - ORA-64451：SHOWNULLCOLUMN:'Y' 取全欄位時，含特殊字元的欄位無法 JSON escape
        // - ORA-00904：CUSTOMCOLUMN 列出不存在的欄位名稱（各站台欄位命名不同）
        // 地址/備注/發票等選填顯示欄位因各站台命名不一，不列入 CUSTOMCOLUMN；同步後為 null 屬可接受。
        SHOWNULLCOLUMN: 'N',
        CUSTOMCOLUMN: 'PROJECT_ID,BEGIN_DATE,TPN_PARTNER_ID,PARTNER_NAME,SALES_NAME,HOLD_STATUS,REMARK',
        PJT_TYPE: "= 'SO'",
        HOLD_STATUS: "IN ('OPEN','UNSIGNED')",
      })

      const soHeaderRes = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam: soHeaderSparam }),
      })
      const { parsed: parsedSoHeader, rawText: rawSoHeader } = await readApiResponse(soHeaderRes)
      const soHeaderError = extractApiError(parsedSoHeader)
      if (!soHeaderRes.ok || !isArgoSuccess(parsedSoHeader)) {
        return NextResponse.json({
          status: 'error',
          error: soHeaderError || 'ARGO PJ_PROJECT (SO) query failed',
          rawText: rawSoHeader,
        }, { status: 502 })
      }

      const soHeaderRows = findObjectRows(parsedSoHeader)
      if (soHeaderRows.length === 0) {
        return NextResponse.json({ status: 'error', error: 'PJ_PROJECT 查無 SO 表頭資料' }, { status: 422 })
      }

      // 表頭 map: PROJECT_ID → header row
      const soHeaderMap = new Map<string, Record<string, unknown>>()
      for (const row of soHeaderRows) {
        const pid = String(getRecordValue(row, 'PROJECT_ID') ?? '').trim()
        if (pid) soHeaderMap.set(pid, row)
      }

      // 查 PJ_PROJECTDETAIL — 直接查所有，與 sync_mo 同模式
      const soDetailSparam = JSON.stringify({
        APIKEY1: keys.APIKEY1,
        APIKEY2: keys.APIKEY2,
        APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: 'PJ_PROJECTDETAIL',
        SHOWNULLCOLUMN: 'N',
        CUSTOMCOLUMN: 'PJT_PROJECT_ID,LINE_NO,MBP_PART,MBP_VER,DUEDATE,ORDER_QTY_ORU,UNIT_OF_MEASURE_ORU,REMARK,PACKING,REMARK2,TPN_PART_NO,GRADE',
        LINE_NO: '>= 0',
      })
      const soDetailRes = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam: soDetailSparam }),
      })
      const { parsed: parsedSoDetail, rawText: rawSoDetail } = await readApiResponse(soDetailRes)
      if (!soDetailRes.ok || !isArgoSuccess(parsedSoDetail)) {
        return NextResponse.json({
          status: 'error',
          error: extractApiError(parsedSoDetail) || 'ARGO PJ_PROJECTDETAIL query failed',
          rawText: rawSoDetail,
        }, { status: 502 })
      }
      const allDetailRows = findObjectRows(parsedSoDetail)
      // 只保留 SO 表頭裡有的 project_id
      const soDetailRows = allDetailRows.filter((row) => {
        const pid = String(getRecordValue(row, 'PJT_PROJECT_ID') ?? '').trim()
        return pid && soHeaderMap.has(pid)
      })

      const syncedAt = new Date().toISOString()

      // 去重：project_id + line_no
      const dedupeMap = new Map<string, Record<string, unknown>>()
      for (const row of soDetailRows) {
        const pid = String(getRecordValue(row, 'PJT_PROJECT_ID') ?? '').trim()
        const lineNo = String(getRecordValue(row, 'LINE_NO') ?? '').trim()
        if (!pid) continue
        const key = `${pid}|${lineNo}`
        if (!dedupeMap.has(key)) dedupeMap.set(key, row)
      }

      const soLines = Array.from(dedupeMap.values()).map((row) => {
        const pid = String(getRecordValue(row, 'PJT_PROJECT_ID') ?? '').trim()
        const header = soHeaderMap.get(pid)
        const deliveryAddress = getFirstNonEmptyRecordValue(header, [
          'DELIVERY_ADDRESS',
          'SHIP_ADDRESS',
          'RECEIVE_ADDRESS',
          'ADDRESS',
          'DELIVERY_ADDR',
          'SHIP_ADDR',
        ])
        const customerRemark = getFirstNonEmptyRecordValue(header, [
          'CUSTOMER_REMARK',
          'REMARK',
        ])
        const invoiceFormat = getFirstNonEmptyRecordValue(header, [
          'EXPORT_MODE',
          'INVOICE_FORMAT',
        ])
        return {
          project_id:         pid,
          begin_date:         String(getRecordValue(header, 'BEGIN_DATE') ?? '').trim() || null,
          tpn_partner_id:     String(getRecordValue(header, 'TPN_PARTNER_ID') ?? '').trim() || null,
          sales_name:         String(getRecordValue(header, 'SALES_NAME') ?? '').trim() || null,
          sales_id:           null,
          currency:           null,
          exchange_rate:      null,
          department:         null,
          sales_category:     null,
          hold_status:        String(getRecordValue(header, 'HOLD_STATUS') ?? '').trim() || null,
          pdl_seq:            null,
          line_no:            String(getRecordValue(row, 'LINE_NO') ?? '').trim(),
          mbp_part:           String(getRecordValue(row, 'MBP_PART') ?? '').trim() || null,
          mbp_ver:            getRecordValue(row, 'MBP_VER') != null ? Number(getRecordValue(row, 'MBP_VER')) : null,
          duedate:            String(getRecordValue(row, 'DUEDATE') ?? '').trim() || null,
          description:        String(getRecordValue(row, 'REMARK') ?? '').trim() || null,
          partner_name:       String(getRecordValue(header, 'PARTNER_NAME') ?? '').trim() || null,
          delivery_address:   deliveryAddress,
          customer_remark:    customerRemark,
          invoice_format:     invoiceFormat,
          remark:             String(getRecordValue(row, 'REMARK2') ?? '').trim() || null,
          packing:            String(getRecordValue(row, 'PACKING') ?? '').trim() || null,
          remark2:            String(getRecordValue(row, 'REMARK2') ?? '').trim() || null,
          tpn_part_no:        String(getRecordValue(row, 'TPN_PART_NO') ?? '').trim() || null,
          order_qty_oru:      toNumber(getRecordValue(row, 'ORDER_QTY_ORU')),
          unit_of_measure_oru: String(getRecordValue(row, 'UNIT_OF_MEASURE_ORU') ?? '').trim() || null,
          unit_price_oru:     null,
          grade:              String(getRecordValue(row, 'GRADE') ?? '').trim() || null,
          create_date:        null,
          update_date:        null,
          synced_at:          syncedAt,
        }
      })

      // 增量比對更新（取代整批 delete+insert）：只寫變動列、刪除消失列、逐筆記 log
      let soRecon
      try {
        const supabaseAdmin = getSupabaseAdminClient()
        soRecon = await reconcileTable(supabaseAdmin, {
          table: 'erp_so_lines',
          keyCols: ['project_id', 'line_no'],
          compareCols: [
            'begin_date', 'tpn_partner_id', 'sales_name', 'sales_id', 'currency', 'exchange_rate',
            'department', 'sales_category', 'hold_status', 'pdl_seq', 'mbp_part', 'mbp_ver',
            'duedate', 'description', 'partner_name', 'delivery_address', 'customer_remark',
            'invoice_format', 'remark', 'packing', 'remark2', 'tpn_part_no',
            'order_qty_oru', 'unit_of_measure_oru', 'unit_price_oru', 'grade',
            'create_date', 'update_date',
          ],
          rows: soLines,
          action: 'sync_so',
          docNoCol: 'project_id',
          subNoCol: 'line_no',
          returnUpdates: true,
        })
      } catch (err) {
        const message = err instanceof Error ? formatSupabaseAdminError(err.message) : '寫入 erp_so_lines 失敗'
        return NextResponse.json({ status: 'error', error: message }, { status: 500 })
      }

      // ── 寫入改單通知（僅記錄業務關鍵欄位的變動，不阻斷主流程）──
      const SO_NOTICE_FIELDS = new Set(['mbp_part', 'duedate', 'order_qty_oru', 'description', 'hold_status', 'partner_name', 'packing', 'sales_name'])
      if (soRecon.updates && soRecon.updates.length > 0) {
        const notices = soRecon.updates
          .map(({ before, after, changed }) => {
            const importantChanged = changed.filter(f => SO_NOTICE_FIELDS.has(f))
            if (!importantChanged.length) return null
            return {
              project_id:     String(before.project_id ?? after.project_id ?? ''),
              line_no:        String(before.line_no ?? after.line_no ?? ''),
              changed_fields: importantChanged,
              old_values:     Object.fromEntries(importantChanged.map(f => [f, before[f] ?? null])),
              new_values:     Object.fromEntries(importantChanged.map(f => [f, after[f] ?? null])),
            }
          })
          .filter((n): n is NonNullable<typeof n> => n !== null)
        if (notices.length > 0) {
          await getSupabaseAdminClient()
            .from('so_change_notices')
            .insert(notices)
            .then(() => {}, () => { /* 表尚未建立時不阻斷同步 */ })
        }
      }

      return NextResponse.json({
        status: 'ok',
        syncedCount: soLines.length,
        totalRows: soDetailRows.length,
        headerCount: soHeaderRows.length,
        inserted: soRecon.inserted,
        updated: soRecon.updated,
        deleted: soRecon.deleted,
        unchanged: soRecon.unchanged,
        changeNotices: soRecon.updates?.filter(u => u.changed.some(f => SO_NOTICE_FIELDS.has(f))).length ?? 0,
      })
    }


    if (action === 'test_po_detail') {
      // ── 採購單明細診斷查詢 ──────────────────────────────────
      // 分三種方式查詢，回傳原始結果以診斷欄位結構
      const { projectId } = body as { projectId?: string }
      const pid = (projectId ?? '').trim()

      // 查1: 直接查 PJ_PROJECTDETAIL（指定 PO 單號 或 ROWNUM<=5）
      const q1 = JSON.stringify({
        APIKEY1: keys.APIKEY1, APIKEY2: keys.APIKEY2, APIKEY3: keys.APIKEY3,
        SEGMENT, TABLE: 'PJ_PROJECTDETAIL', SHOWNULLCOLUMN: 'Y',
        ...(pid ? { PJT_PROJECT_ID: `= '${pid}'` } : { ROWNUM: '<= 5' }),
      })
      const r1 = await fetch(`${API_BASE}/S_QUERY`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sparam: q1 }) })
      const { parsed: p1, rawText: raw1 } = await readApiResponse(r1)
      const rows1 = findObjectRows(p1)

      // 查2: JOIN PJ_PROJECT+PJ_PROJECTDETAIL，PJT_TYPE=PO，ROWNUM<=5
      const q2 = JSON.stringify({
        APIKEY1: keys.APIKEY1, APIKEY2: keys.APIKEY2, APIKEY3: keys.APIKEY3,
        SEGMENT, TABLE: 'PJ_PROJECT,PJ_PROJECTDETAIL', SHOWNULLCOLUMN: 'Y',
        'PJ_PROJECT.PROJECT_ID': '=PJ_PROJECTDETAIL.PJT_PROJECT_ID',
        'PJ_PROJECT.PJT_TYPE': "= 'PO'",
        ROWNUM: '<= 5',
      })
      const r2 = await fetch(`${API_BASE}/S_QUERY`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sparam: q2 }) })
      const { parsed: p2, rawText: raw2 } = await readApiResponse(r2)
      const rows2 = findObjectRows(p2)

      return NextResponse.json({
        status: 'ok',
        q1_direct: { rowCount: rows1.length, columns: Object.keys(rows1[0] ?? {}), sample: rows1[0] ?? null, rawText: raw1.slice(0, 2000) },
        q2_join:   { rowCount: rows2.length, columns: Object.keys(rows2[0] ?? {}), sample: rows2[0] ?? null, rawText: raw2.slice(0, 2000) },
      })
    }

    if (action === 'sync_po') {
      // ── 採購單同步（與 sync_so 同模式：兩段式，JS 端 JOIN）──────────────
      // 注意：使用 CUSTOMCOLUMN（不加表格前綴）+ 各表獨立查，與 sync_so 完全相同模式

      // Step 1: 查 PJ_PROJECT WHERE PJT_TYPE='PO'
      const poHeaderSparam = JSON.stringify({
        APIKEY1: keys.APIKEY1, APIKEY2: keys.APIKEY2, APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: 'PJ_PROJECT',
        SHOWNULLCOLUMN: 'N',
        CUSTOMCOLUMN: 'PROJECT_ID,BEGIN_DATE,HOLD_STATUS,TPN_PARTNER_ID,SALES_ID,SALES_NAME,PAYMENT_TERM,PAYMENT_MODE,CURRENCY,EXCHANGE_RATE,TAX_RATE,SEG_SEGMENT_NO,PO_TYPE,MODIFY_VER',
        PJT_TYPE: "= 'PO'",
      })
      const poHdrRes = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam: poHeaderSparam }),
      })
      const { parsed: parsedHdr, rawText: rawHdr } = await readApiResponse(poHdrRes)
      if (!poHdrRes.ok || !isArgoSuccess(parsedHdr)) {
        return NextResponse.json({ status: 'error', error: extractApiError(parsedHdr) || 'PJ_PROJECT query failed', rawText: rawHdr }, { status: 502 })
      }
      const hdrRows = findObjectRows(parsedHdr)
      if (hdrRows.length === 0) {
        return NextResponse.json({ status: 'error', error: 'PJ_PROJECT 查無 PO 表頭' }, { status: 422 })
      }

      // 建 header map：PROJECT_ID → header row
      const hdrMap = new Map<string, Record<string, unknown>>()
      for (const row of hdrRows) {
        const pid = String(getRecordValue(row, 'PROJECT_ID') ?? '').trim()
        if (pid) hdrMap.set(pid, row)
      }

      // Step 2: 查 PJ_PROJECTDETAIL，用 CUSTOMCOLUMN 指定所需欄位（比全欄位查詢快且欄名確定無前綴）
      // LINE_NO >= 1 已排除 stub row，可安全使用 CUSTOMCOLUMN
      const poDtlSparam = JSON.stringify({
        APIKEY1: keys.APIKEY1, APIKEY2: keys.APIKEY2, APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: 'PJ_PROJECTDETAIL',
        SHOWNULLCOLUMN: 'Y',
        CUSTOMCOLUMN: 'PJT_PROJECT_ID,LINE_NO,MBP_PART,MBP_LOT_NO,ORDER_QTY_ORU,ACTUAL_QTY_ORU,UNIT_OF_MEASURE_ORU,DUEDATE,REMARK,REMARK2,PACKING,UNIT_PRICE_ORU,MBP_VER,PDL_SEQ_SO,TPN_PART_NO,SO_PROJECT_ID',
        PJT_TYPE: "= 'PO'",
        LINE_NO: '>= 1',
      })
      const poDtlRes = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam: poDtlSparam }),
      })
      const { parsed: parsedDtl, rawText: rawDtl } = await readApiResponse(poDtlRes)
      if (!poDtlRes.ok || !isArgoSuccess(parsedDtl)) {
        return NextResponse.json({ status: 'error', error: extractApiError(parsedDtl) || 'PJ_PROJECTDETAIL query failed', rawText: rawDtl }, { status: 502 })
      }
      const dtlRows = findObjectRows(parsedDtl)

      if (dtlRows.length === 0) {
        return NextResponse.json({ status: 'error', error: 'PJ_PROJECTDETAIL 查無明細' }, { status: 422 })
      }

      const poSyncedAt = new Date().toISOString()

      // 合併：只保留 hdrMap 裡有 PO 表頭的明細（=只要 PO，排除其他 project type）
      // 去重 pjt_project_id + line_no
      const poDedupe = new Map<string, { dtl: Record<string, unknown>; hdr: Record<string, unknown> }>()
      for (const dtl of dtlRows) {
        const pid  = String(getRecordValue(dtl, 'PJT_PROJECT_ID') ?? '').trim()
        const line = String(getRecordValue(dtl, 'LINE_NO') ?? '').trim()
        const hdr  = hdrMap.get(pid)
        if (!hdr) continue  // 非 PO 單，略過
        const key = `${pid}|${line}`
        if (!poDedupe.has(key)) poDedupe.set(key, { dtl, hdr })
      }

      const poSyncRows = Array.from(poDedupe.values()).map(({ dtl, hdr }) => ({
        doc_type:        '採購單號',
        doc_no:          String(getRecordValue(hdr, 'PROJECT_ID') ?? '').trim(),
        sub_no:          String(getRecordValue(dtl, 'LINE_NO') ?? '').trim(),
        item_code:       String(getRecordValue(dtl, 'MBP_PART') ?? '').trim() || null,
        description:     String(getRecordValue(dtl, 'REMARK') ?? '').trim() || null,
        qty:             toNumber(getRecordValue(dtl, 'ORDER_QTY_ORU')),
        unit:            String(getRecordValue(dtl, 'UNIT_OF_MEASURE_ORU') ?? '').trim() || null,
        status:          String(getRecordValue(hdr, 'HOLD_STATUS') ?? '').trim() || null,
        start_date:      String(getRecordValue(hdr, 'BEGIN_DATE') ?? '').trim() || null,
        end_date:        shiftDueDateBackTwoWorkdays(String(getRecordValue(dtl, 'DUEDATE') ?? '').trim() || null),
        customer_vendor: String(getRecordValue(hdr, 'TPN_PARTNER_ID') ?? '').trim() || null,
        remark:          String(getRecordValue(dtl, 'REMARK2') ?? '').trim() || null,
        extra: {
          UNIT_PRICE_ORU: getRecordValue(dtl, 'UNIT_PRICE_ORU') ?? null,
          RECEIVED_QTY:   toNumber(getRecordValue(dtl, 'ACTUAL_QTY_ORU')),   // 已入庫量（進貨單入庫後 ARGO 回寫）
          MBP_VER:        getRecordValue(dtl, 'MBP_VER') ?? null,
          MBP_LOT_NO:     String(getRecordValue(dtl, 'MBP_LOT_NO') ?? '').trim() || null,
          SO_PROJECT_ID:  String(getRecordValue(dtl, 'SO_PROJECT_ID') ?? '').trim() || null,
          SO_LINE_NO:     getRecordValue(dtl, 'PDL_SEQ_SO') != null ? String(getRecordValue(dtl, 'PDL_SEQ_SO')) : null,
          TPN_PART_NO:    String(getRecordValue(dtl, 'TPN_PART_NO') ?? '').trim() || null,
          PACKING:        String(getRecordValue(dtl, 'PACKING') ?? '').trim() || null,
          SALES_ID:       String(getRecordValue(hdr, 'SALES_ID') ?? '').trim() || null,
          SALES_NAME:     String(getRecordValue(hdr, 'SALES_NAME') ?? '').trim() || null,
          PAYMENT_TERM:   String(getRecordValue(hdr, 'PAYMENT_TERM') ?? '').trim() || null,
          PAYMENT_MODE:   String(getRecordValue(hdr, 'PAYMENT_MODE') ?? '').trim() || null,
          CURRENCY:       String(getRecordValue(hdr, 'CURRENCY') ?? '').trim() || null,
          EXCHANGE_RATE:  String(getRecordValue(hdr, 'EXCHANGE_RATE') ?? '').trim() || null,
          TAX_RATE:       String(getRecordValue(hdr, 'TAX_RATE') ?? '').trim() || null,
          SEG_SEGMENT_NO: String(getRecordValue(hdr, 'SEG_SEGMENT_NO') ?? '').trim() || null,
          PO_TYPE:        String(getRecordValue(hdr, 'PO_TYPE') ?? '').trim() || null,
          MODIFY_VER:     String(getRecordValue(hdr, 'MODIFY_VER') ?? '').trim() || null,
        },
        synced_at: poSyncedAt,
      }))

      // 增量比對更新（取代整批 delete+insert）；scope 限 doc_type，PO 對帳絕不動 PR/其他單別
      let poRecon
      try {
        const supabaseAdmin = getSupabaseAdminClient()
        poRecon = await reconcileTable(supabaseAdmin, {
          table: 'erp_pj_sync',
          keyCols: ['doc_type', 'doc_no', 'sub_no'],
          compareCols: ['item_code', 'description', 'qty', 'unit', 'status', 'start_date', 'end_date', 'customer_vendor', 'remark', 'extra'],
          rows: poSyncRows,
          scope: { col: 'doc_type', value: '採購單號' },
          action: 'sync_po',
          docNoCol: 'doc_no',
          subNoCol: 'sub_no',
        })
      } catch (err) {
        const message = err instanceof Error ? formatSupabaseAdminError(err.message) : '寫入 erp_pj_sync 失敗'
        return NextResponse.json({ status: 'error', error: message }, { status: 500 })
      }

      return NextResponse.json({
        status: 'ok',
        syncedCount: poSyncRows.length,
        totalHdrRows: hdrRows.length,
        totalDtlRows: dtlRows.length,
        inserted: poRecon.inserted,
        updated: poRecon.updated,
        deleted: poRecon.deleted,
        unchanged: poRecon.unchanged,
      })
    }


    if (action === 'sync_pr') {
      // ── 請購單同步（PJ_APPLYPROJECT + PJ_APPLYPROJECTDETAIL 兩段式，JS 端 JOIN）──────────────
      const prSyncedAt = new Date().toISOString()

      // 解析委外請購的銷售訂單號（RO 號）：
      //  - MP 開頭請購：RO 號乾淨地存在 PROJECT_ID / MBP_LOT_NO
      //  - PR 開頭委外請購：RO 號夾在 DESCRIPTION 文字中（如 "RO25123140/0102山鷹"）
      const extractSoNo = (...candidates: Array<unknown>): string | null => {
        for (const c of candidates) {
          const s = String(c ?? '').trim()
          if (!s) continue
          const m = s.match(/RO\d{6,}/i)
          if (m) return m[0].toUpperCase()
        }
        return null
      }

      // 增量比對更新（取代整批 delete+insert）；scope 限 doc_type，PR 對帳絕不動 PO/其他單別
      async function persistPrSyncRows(prSyncRows: Array<Record<string, unknown>>) {
        const supabaseAdmin = getSupabaseAdminClient()
        await reconcileTable(supabaseAdmin, {
          table: 'erp_pj_sync',
          keyCols: ['doc_type', 'doc_no', 'sub_no'],
          compareCols: ['item_code', 'description', 'qty', 'unit', 'status', 'start_date', 'end_date', 'customer_vendor', 'remark', 'extra'],
          rows: prSyncRows,
          scope: { col: 'doc_type', value: '請購單號' },
          action: 'sync_pr',
          docNoCol: 'doc_no',
          subNoCol: 'sub_no',
        })
      }

      async function runPrQuery(
        table: string,
        customColumn: string | null,
        extra: Record<string, string> = {},
        showNullColumn: 'Y' | 'N' = 'Y'
      ) {
        const payload: Record<string, string> = {
          APIKEY1: keys.APIKEY1,
          APIKEY2: keys.APIKEY2,
          APIKEY3: keys.APIKEY3,
          SEGMENT,
          TABLE: table,
          SHOWNULLCOLUMN: showNullColumn,
          ...extra,
        }
        if (customColumn) payload.CUSTOMCOLUMN = customColumn

        const sparam = JSON.stringify(payload)
        const res = await fetch(`${API_BASE}/S_QUERY`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sparam }),
        })
        const { parsed, rawText } = await readApiResponse(res)
        return { res, parsed, rawText, rows: findObjectRows(parsed) }
      }

      // Step 0: 優先嘗試聯表（部分環境只授權 PJ_APPLYPROJECT,PJ_APPLYPROJECTDETAIL）
      const prJoinedAttempts = [
        {
          customColumn: 'APPLY_ID,LINE_NO,MBP_PART,MBP_VER,MBP_LOT_NO,PROJECT_ID,DESCRIPTION,ORDER_QTY_ORU,UNIT_OF_MEASURE_ORU,DUEDATE,APPLY_DATE,HOLD_STATUS,SEG_SEGMENT_NO_DEPARTMENT,REMARK,CURRENCY',
          showNull: 'N' as const,
        },
        {
          customColumn: 'PROJECT_ID,LINE_NO,MBP_PART,MBP_VER,MBP_LOT_NO,DESCRIPTION,ORDER_QTY_ORU,UNIT_OF_MEASURE_ORU,DUEDATE,APPLY_DATE,HOLD_STATUS,SEG_SEGMENT_NO_DEPARTMENT,REMARK,CURRENCY',
          showNull: 'N' as const,
        },
        { customColumn: null, showNull: 'N' as const },
        {
          customColumn: 'APPLY_ID,LINE_NO,MBP_PART,MBP_VER,MBP_LOT_NO,PROJECT_ID,DESCRIPTION,ORDER_QTY_ORU,UNIT_OF_MEASURE_ORU,DUEDATE,APPLY_DATE,HOLD_STATUS,SEG_SEGMENT_NO_DEPARTMENT,REMARK,CURRENCY',
          showNull: 'Y' as const,
        },
        {
          customColumn: 'PROJECT_ID,LINE_NO,MBP_PART,MBP_VER,MBP_LOT_NO,DESCRIPTION,ORDER_QTY_ORU,UNIT_OF_MEASURE_ORU,DUEDATE,APPLY_DATE,HOLD_STATUS,SEG_SEGMENT_NO_DEPARTMENT,REMARK,CURRENCY',
          showNull: 'Y' as const,
        },
        { customColumn: null, showNull: 'Y' as const },
      ]

      for (const attemptConfig of prJoinedAttempts) {
        const joined = await runPrQuery(
          'PJ_APPLYPROJECT,PJ_APPLYPROJECTDETAIL',
          attemptConfig.customColumn,
          { LINE_NO: '>= 1' },
          attemptConfig.showNull
        )
        if (!joined.res.ok || !isArgoSuccess(joined.parsed) || joined.rows.length === 0) continue

        const joinedDedupe = new Map<string, Record<string, unknown>>()
        for (const row of joined.rows) {
          const docNo = getFirstNonEmptyRecordValue(row, ['APPLY_ID', 'PROJECT_ID', 'PJT_PROJECT_ID']) ?? ''
          const subNo = String(getRecordValue(row, 'LINE_NO') ?? '').trim()
          if (!docNo || !subNo) continue
          const key = `${docNo}|${subNo}`
          if (!joinedDedupe.has(key)) joinedDedupe.set(key, row)
        }

        const prSyncRows = Array.from(joinedDedupe.values()).map((row) => ({
          doc_type:        '請購單號',
          doc_no:          getFirstNonEmptyRecordValue(row, ['APPLY_ID', 'PROJECT_ID', 'PJT_PROJECT_ID']) ?? '',
          sub_no:          String(getRecordValue(row, 'LINE_NO') ?? '').trim(),
          item_code:       String(getRecordValue(row, 'MBP_PART') ?? '').trim() || null,
          description:     String(getRecordValue(row, 'REMARK') ?? '').trim() || null,
          qty:             toNumber(getRecordValue(row, 'ORDER_QTY_ORU')),
          unit:            String(getRecordValue(row, 'UNIT_OF_MEASURE_ORU') ?? '').trim() || null,
          status:          String(getRecordValue(row, 'HOLD_STATUS') ?? '').trim() || null,
          start_date:      String(getRecordValue(row, 'APPLY_DATE') ?? '').trim() || null,
          end_date:        shiftDueDateBackTwoWorkdays(String(getRecordValue(row, 'DUEDATE') ?? '').trim() || null),
          customer_vendor: String(getRecordValue(row, 'SEG_SEGMENT_NO_DEPARTMENT') ?? '').trim() || null,
          remark:          String(getRecordValue(row, 'CURRENCY') ?? '').trim() || null,
          extra: {
            MBP_VER:    String(getRecordValue(row, 'MBP_VER') ?? '').trim() || null,
            MBP_LOT_NO: String(getRecordValue(row, 'MBP_LOT_NO') ?? '').trim() || null,
            PROJECT_ID: String(getRecordValue(row, 'PROJECT_ID') ?? '').trim() || null,
            DTL_DESC:   String(getRecordValue(row, 'DESCRIPTION') ?? '').trim() || null,
            // 正規化銷售訂單號（RO 號）：優先 PROJECT_ID > MBP_LOT_NO > DESCRIPTION 文字解析
            SO_PROJECT_ID: extractSoNo(
              getRecordValue(row, 'PROJECT_ID'),
              getRecordValue(row, 'MBP_LOT_NO'),
              getRecordValue(row, 'DESCRIPTION'),
            ),
            HDR_REMARK: String(getRecordValue(row, 'REMARK') ?? '').trim() || null,
          },
          synced_at: prSyncedAt,
        }))

        if (prSyncRows.length > 0) {
          try {
            await persistPrSyncRows(prSyncRows)
          } catch (err) {
            const message = err instanceof Error ? formatSupabaseAdminError(err.message) : '寫入 erp_pj_sync 失敗'
            return NextResponse.json({ status: 'error', error: message }, { status: 500 })
          }

          return NextResponse.json({
            status: 'ok',
            syncedCount: prSyncRows.length,
            totalHdrRows: prSyncRows.length,
            totalDtlRows: prSyncRows.length,
            syncMode: 'joined',
          })
        }
      }

      // Step 1: 查 PJ_APPLYPROJECT（表頭）
      const prHeaderAttempts = [
        { customColumn: 'APPLY_ID,APPLY_DATE,HOLD_STATUS,SEG_SEGMENT_NO_DEPARTMENT,REMARK,CURRENCY', showNull: 'N' as const },
        { customColumn: 'PROJECT_ID,APPLY_DATE,HOLD_STATUS,SEG_SEGMENT_NO_DEPARTMENT,REMARK,CURRENCY', showNull: 'N' as const },
        { customColumn: null, showNull: 'N' as const },
        { customColumn: 'APPLY_ID,APPLY_DATE,HOLD_STATUS,SEG_SEGMENT_NO_DEPARTMENT,REMARK,CURRENCY', showNull: 'Y' as const },
        { customColumn: 'PROJECT_ID,APPLY_DATE,HOLD_STATUS,SEG_SEGMENT_NO_DEPARTMENT,REMARK,CURRENCY', showNull: 'Y' as const },
        { customColumn: null, showNull: 'Y' as const },
      ]

      let prHdrRows: Record<string, unknown>[] = []
      let parsedPrHdr: unknown = null
      let rawPrHdr = ''
      let prHdrOk = false
      for (const attemptConfig of prHeaderAttempts) {
        // ARGO S_QUERY 至少需帶一個條件式，否則 WHERE 為空 → ORA-00936（遺漏表示式）。
        // APPLY_ID IS NOT NULL 為恆真條件，可取得全部請購表頭。
        const attempt = await runPrQuery('PJ_APPLYPROJECT', attemptConfig.customColumn, { APPLY_ID: 'IS NOT NULL' }, attemptConfig.showNull)
        parsedPrHdr = attempt.parsed
        rawPrHdr = attempt.rawText
        if (!attempt.res.ok || !isArgoSuccess(attempt.parsed)) continue
        if (attempt.rows.length === 0) continue
        prHdrRows = attempt.rows
        prHdrOk = true
        break
      }
      if (!prHdrOk) {
        return NextResponse.json({
          status: 'error',
          error: extractApiError(parsedPrHdr) || 'PJ_APPLYPROJECT query failed',
          rawText: rawPrHdr,
          debugSparam: {
            SEGMENT,
            TABLE: 'PJ_APPLYPROJECT',
            SHOWNULLCOLUMN: 'Y',
          },
        }, { status: 502 })
      }
      if (prHdrRows.length === 0) {
        return NextResponse.json({ status: 'error', error: 'PJ_APPLYPROJECT 查無請購表頭' }, { status: 422 })
      }

      // 建 header map：兼容 APPLY_ID / PROJECT_ID 欄位差異
      const prHdrMap = new Map<string, Record<string, unknown>>()
      for (const row of prHdrRows) {
        const pid = getFirstNonEmptyRecordValue(row, ['APPLY_ID', 'PROJECT_ID', 'PJT_PROJECT_ID'])
        if (pid) prHdrMap.set(pid, row)
      }

      // Step 2: 查 PJ_APPLYPROJECTDETAIL（明細）
      // 注意：明細表關聯表頭的欄位為 APJ_APPLY_ID（= 表頭 APPLY_ID），
      // 並非 APPLY_ID / PJT_PROJECT_ID（這些在明細表不存在，會 ORA-00904）。
      const prDetailAttempts = [
        { customColumn: 'APJ_APPLY_ID,LINE_NO,MBP_PART,MBP_VER,MBP_LOT_NO,PROJECT_ID,DESCRIPTION,ORDER_QTY_ORU,UNIT_OF_MEASURE_ORU,DUEDATE,CURRENCY', showNull: 'N' as const },
        { customColumn: 'APJ_APPLY_ID,LINE_NO,MBP_PART,MBP_VER,MBP_LOT_NO,PROJECT_ID,DESCRIPTION,ORDER_QTY_ORU,UNIT_OF_MEASURE_ORU,DUEDATE', showNull: 'N' as const },
        { customColumn: null, showNull: 'N' as const },
        { customColumn: 'APJ_APPLY_ID,LINE_NO,MBP_PART,MBP_VER,MBP_LOT_NO,PROJECT_ID,DESCRIPTION,ORDER_QTY_ORU,UNIT_OF_MEASURE_ORU,DUEDATE,CURRENCY', showNull: 'Y' as const },
        { customColumn: 'APJ_APPLY_ID,LINE_NO,MBP_PART,MBP_VER,MBP_LOT_NO,PROJECT_ID,DESCRIPTION,ORDER_QTY_ORU,UNIT_OF_MEASURE_ORU,DUEDATE', showNull: 'Y' as const },
        { customColumn: null, showNull: 'Y' as const },
      ]

      let prDtlRows: Record<string, unknown>[] = []
      let parsedPrDtl: unknown = null
      let rawPrDtl = ''
      let prDtlOk = false
      for (const attemptConfig of prDetailAttempts) {
        const attempt = await runPrQuery(
          'PJ_APPLYPROJECTDETAIL',
          attemptConfig.customColumn,
          { LINE_NO: '>= 1' },
          attemptConfig.showNull
        )
        parsedPrDtl = attempt.parsed
        rawPrDtl = attempt.rawText
        if (!attempt.res.ok || !isArgoSuccess(attempt.parsed)) continue
        if (attempt.rows.length === 0) continue
        prDtlRows = attempt.rows
        prDtlOk = true
        break
      }
      if (!prDtlOk) {
        return NextResponse.json({
          status: 'error',
          error: extractApiError(parsedPrDtl) || 'PJ_APPLYPROJECTDETAIL query failed',
          rawText: rawPrDtl,
          debugSparam: {
            SEGMENT,
            TABLE: 'PJ_APPLYPROJECTDETAIL',
            SHOWNULLCOLUMN: 'Y',
            LINE_NO: '>= 1',
          },
        }, { status: 502 })
      }

      if (prDtlRows.length === 0) {
        return NextResponse.json({ status: 'error', error: 'PJ_APPLYPROJECTDETAIL 查無明細' }, { status: 422 })
      }

      // 合併：去重 project_id + line_no，只保留有表頭的明細
      const prDedupe = new Map<string, { dtl: Record<string, unknown>; hdr: Record<string, unknown> }>()
      for (const dtl of prDtlRows) {
        const pid = getFirstNonEmptyRecordValue(dtl, ['APJ_APPLY_ID', 'APPLY_ID', 'PJT_PROJECT_ID', 'PROJECT_ID']) ?? ''
        const line = String(getRecordValue(dtl, 'LINE_NO') ?? '').trim()
        const hdr  = prHdrMap.get(pid)
        if (!hdr) continue
        const key = `${pid}|${line}`
        if (!prDedupe.has(key)) prDedupe.set(key, { dtl, hdr })
      }

      if (prDedupe.size === 0) {
        return NextResponse.json({
          status: 'error',
          error: '請購表頭/明細 JOIN 後為 0 筆，可能是 APPLY_ID / PROJECT_ID 欄位命名不一致',
          totalHdrRows: prHdrRows.length,
          totalDtlRows: prDtlRows.length,
        }, { status: 422 })
      }

      const prSyncRows = Array.from(prDedupe.values()).map(({ dtl, hdr }) => ({
        doc_type:        '請購單號',
        doc_no:          getFirstNonEmptyRecordValue(hdr, ['APPLY_ID', 'PROJECT_ID']) ?? '',
        sub_no:          String(getRecordValue(dtl, 'LINE_NO') ?? '').trim(),
        item_code:       String(getRecordValue(dtl, 'MBP_PART') ?? '').trim() || null,
        description:     String(getRecordValue(hdr, 'REMARK') ?? '').trim() || null,
        qty:             toNumber(getRecordValue(dtl, 'ORDER_QTY_ORU')),
        unit:            String(getRecordValue(dtl, 'UNIT_OF_MEASURE_ORU') ?? '').trim() || null,
        status:          String(getRecordValue(hdr, 'HOLD_STATUS') ?? '').trim() || null,
        start_date:      String(getRecordValue(hdr, 'APPLY_DATE') ?? '').trim() || null,
        end_date:        shiftDueDateBackTwoWorkdays(String(getRecordValue(dtl, 'DUEDATE') ?? '').trim() || null),
        customer_vendor: String(getRecordValue(hdr, 'SEG_SEGMENT_NO_DEPARTMENT') ?? '').trim() || null,
        remark:          (getFirstNonEmptyRecordValue(hdr, ['CURRENCY']) ?? String(getRecordValue(dtl, 'CURRENCY') ?? '').trim()) || null,
        extra: {
          MBP_VER:    String(getRecordValue(dtl, 'MBP_VER') ?? '').trim() || null,
          MBP_LOT_NO: String(getRecordValue(dtl, 'MBP_LOT_NO') ?? '').trim() || null,
          PROJECT_ID: String(getRecordValue(dtl, 'PROJECT_ID') ?? '').trim() || null,
          DTL_DESC:   String(getRecordValue(dtl, 'DESCRIPTION') ?? '').trim() || null,
          // 正規化銷售訂單號（RO 號）：優先 PROJECT_ID > MBP_LOT_NO > DESCRIPTION 文字解析
          SO_PROJECT_ID: extractSoNo(
            getRecordValue(dtl, 'PROJECT_ID'),
            getRecordValue(dtl, 'MBP_LOT_NO'),
            getRecordValue(dtl, 'DESCRIPTION'),
          ),
          HDR_REMARK: String(getRecordValue(hdr, 'REMARK') ?? '').trim() || null,
        },
        synced_at: prSyncedAt,
      }))

      try {
        await persistPrSyncRows(prSyncRows)
      } catch (err) {
        const message = err instanceof Error ? formatSupabaseAdminError(err.message) : '寫入 erp_pj_sync 失敗'
        return NextResponse.json({ status: 'error', error: message }, { status: 500 })
      }

      return NextResponse.json({
        status: 'ok',
        syncedCount: prSyncRows.length,
        totalHdrRows: prHdrRows.length,
        totalDtlRows: prDtlRows.length,
      })
    }

    if (action === 'sync_mo') {
      // ── 製令同步 ────────────────────────────────────────────
      // 步驟一：查 PJ_PROJECT（表頭）— PROJECT_ID/BEGIN_DATE/END_DATE/HOLD_STATUS
      const moHeaderSparam = JSON.stringify({
        APIKEY1: keys.APIKEY1,
        APIKEY2: keys.APIKEY2,
        APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: 'PJ_PROJECT',
        SHOWNULLCOLUMN: 'N',
        CUSTOMCOLUMN: 'PROJECT_ID,BEGIN_DATE,END_DATE,HOLD_STATUS,MO_BEGIN_DATE',
        PJT_TYPE: "= 'MO'",
      })

      const moHeaderRes = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam: moHeaderSparam }),
      })
      const { parsed: parsedMoHeader, rawText: rawMoHeader } = await readApiResponse(moHeaderRes)
      const moHeaderError = extractApiError(parsedMoHeader)
      if (!moHeaderRes.ok || !isArgoSuccess(parsedMoHeader)) {
        return NextResponse.json({
          status: 'error',
          error: moHeaderError || 'ARGO PJ_PROJECT (MO) query failed',
          rawText: rawMoHeader,
        }, { status: 502 })
      }

      const moHeaderRows = findObjectRows(parsedMoHeader)
      if (moHeaderRows.length === 0) {
        return NextResponse.json({ status: 'error', error: 'PJ_PROJECT 查無 MO 表頭資料' }, { status: 422 })
      }

      // 建立表頭 map：PROJECT_ID → header 欄位
      const moHeaderMap = new Map<string, Record<string, unknown>>()
      for (const row of moHeaderRows) {
        const pid = String(getRecordValue(row, 'PROJECT_ID') ?? '').trim()
        if (pid) moHeaderMap.set(pid, row)
      }

      // 步驟二：嘗試查 PJ_PROJECTDETAIL（明細）— 若未授權則降級為表頭模式
      let moDetailRows: Record<string, unknown>[] = []
      let detailTotal = 0
      let detailAuthorized = false
      let detailError: string | null = null

      try {
        const moDetailSparam = JSON.stringify({
          APIKEY1: keys.APIKEY1,
          APIKEY2: keys.APIKEY2,
          APIKEY3: keys.APIKEY3,
          SEGMENT,
          TABLE: 'PJ_PROJECTDETAIL',
          SHOWNULLCOLUMN: 'N',
          CUSTOMCOLUMN: 'PJT_PROJECT_ID,LINE_NO,MBP_PART,MBP_LOT_NO,ORDER_QTY,PJT_PROJECT_ID_MO_SO',
          LINE_NO: '>= 0',
        })
        const moDetailRes = await fetch(`${API_BASE}/S_QUERY`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sparam: moDetailSparam }),
        })
        const { parsed: parsedMoDetail, rawText: rawMoDetail } = await readApiResponse(moDetailRes)
        if (moDetailRes.ok && isArgoSuccess(parsedMoDetail)) {
          moDetailRows = findObjectRows(parsedMoDetail)
          detailTotal = moDetailRows.length
          detailAuthorized = true
        } else {
          detailError = extractApiError(parsedMoDetail) || `HTTP ${moDetailRes.status}: ${rawMoDetail.slice(0, 200)}`
        }
      } catch (e) {
        detailError = e instanceof Error ? e.message : '明細查詢發生未知錯誤'
      }

      // 步驟三：組合 moLines
      const syncedAt = new Date().toISOString()
      let moLines: {
        project_id: string
        begin_date: string | null
        end_date: string | null
        hold_status: string | null
        mo_begin_date: string | null
        line_no: string
        mbp_part: string | null
        mbp_lot_no: string | null
        order_qty: number
        source_order: string | null
        synced_at: string
      }[]

      if (detailAuthorized && moDetailRows.length > 0) {
        // 有明細：以明細為主，JOIN 表頭
        moLines = moDetailRows
          .map((row) => {
            const pid = String(getRecordValue(row, 'PJT_PROJECT_ID') ?? '').trim()
            if (!pid) return null
            const header = moHeaderMap.get(pid)
            return {
              project_id: pid,
              begin_date:    String(getRecordValue(header, 'BEGIN_DATE') ?? '').trim() || null,
              end_date:      String(getRecordValue(header, 'END_DATE') ?? '').trim()   || null,
              hold_status:   String(getRecordValue(header, 'HOLD_STATUS') ?? '').trim() || null,
              mo_begin_date: String(getRecordValue(header, 'MO_BEGIN_DATE') ?? '').trim() || null,
              line_no:       String(getRecordValue(row, 'LINE_NO') ?? '').trim(),
              mbp_part:      String(getRecordValue(row, 'MBP_PART') ?? '').trim()      || null,
              mbp_lot_no:    String(getRecordValue(row, 'MBP_LOT_NO') ?? '').trim()    || null,
              order_qty:     Number(getRecordValue(row, 'ORDER_QTY') ?? 0) || 0,
              source_order:  String(getRecordValue(row, 'PJT_PROJECT_ID_MO_SO') ?? '').trim() || null,
              synced_at: syncedAt,
            }
          })
          .filter((r): r is NonNullable<typeof r> => r !== null)
      } else {
        // 無明細授權：表頭模式（一 MO = 一列，明細欄位 null）
        moLines = moHeaderRows
          .map((row) => {
            const pid = String(getRecordValue(row, 'PROJECT_ID') ?? '').trim()
            if (!pid) return null
            return {
              project_id:    pid,
              begin_date:    String(getRecordValue(row, 'BEGIN_DATE') ?? '').trim()    || null,
              end_date:      String(getRecordValue(row, 'END_DATE') ?? '').trim()      || null,
              hold_status:   String(getRecordValue(row, 'HOLD_STATUS') ?? '').trim()   || null,
              mo_begin_date: String(getRecordValue(row, 'MO_BEGIN_DATE') ?? '').trim() || null,
              line_no:       '',
              mbp_part:      null,
              mbp_lot_no:    null,
              order_qty:     0,
              source_order:  null,
              synced_at:     syncedAt,
            }
          })
          .filter((r): r is NonNullable<typeof r> => r !== null)
      }

      // 步驟四：去重後寫入 erp_mo_lines
      // ARGO 可能回傳重複 (project_id, line_no)，用 Map 保留最後一筆
      const dedupeMap = new Map<string, typeof moLines[0]>()
      for (const row of moLines) {
        dedupeMap.set(`${row.project_id}|${row.line_no}`, row)
      }
      const dedupedLines = Array.from(dedupeMap.values())

      // 增量比對更新（取代整批 delete+insert）：只寫變動列、刪除消失列、逐筆記 log
      let moRecon
      try {
        const supabaseAdmin = getSupabaseAdminClient()
        moRecon = await reconcileTable(supabaseAdmin, {
          table: 'erp_mo_lines',
          keyCols: ['project_id', 'line_no'],
          compareCols: ['begin_date', 'end_date', 'hold_status', 'mo_begin_date', 'mbp_part', 'mbp_lot_no', 'order_qty', 'source_order'],
          rows: dedupedLines,
          action: 'sync_mo',
          docNoCol: 'project_id',
          subNoCol: 'line_no',
        })
      } catch (err) {
        const pgError = err as { message?: string; code?: string; details?: string; hint?: string }
        const message = pgError?.message
          ? `寫入 erp_mo_lines 失敗：${pgError.message}${pgError.code ? ` (code: ${pgError.code})` : ''}${pgError.details ? ` — ${pgError.details}` : ''}`
          : String(err)
        return NextResponse.json({ status: 'error', error: message }, { status: 500 })
      }

      return NextResponse.json({
        status: 'ok',
        syncedCount: dedupedLines.length,
        headerCount: moHeaderRows.length,
        detailTotal,
        detailAuthorized,
        detailError,
        inserted: moRecon.inserted,
        updated: moRecon.updated,
        deleted: moRecon.deleted,
        unchanged: moRecon.unchanged,
      })
    }

    if (action === 'sync_pj') {
      const { table, filters, customColumn, docType, mapping } = body as {
        table: string
        filters?: Record<string, string>
        customColumn?: string
        docType: string
        mapping: PjSyncMapping
      }

      if (!table?.trim()) {
        return NextResponse.json({ status: 'error', error: 'Missing PJ table' }, { status: 400 })
      }
      if (!docType?.trim()) {
        return NextResponse.json({ status: 'error', error: 'Missing docType' }, { status: 400 })
      }
      if (!mapping?.docNoField?.trim()) {
        return NextResponse.json({ status: 'error', error: 'Missing docNoField in mapping' }, { status: 400 })
      }

      // ARGO S_QUERY 將 filter 組成 WHERE key value（無 = 符號），
      // 因此 value 必須包含完整算符，例如 "= 'SO'" 或 ">= 100"。
      // 此處若 value 尚未以算符開頭，自動補上 = 並對字串補引號。
      const quotedFilters: Record<string, string> = {}
      for (const [k, v] of Object.entries(filters || {})) {
        if (v !== undefined && v !== null) {
          const s = String(v).trim()
          // 已含算符（=, !=, <, >, LIKE, IN, BETWEEN, IS …）則原樣送出
          const hasOperator = /^(=|!=|<>|<=|>=|<|>|like|in\s*\(|between|is\s)/i.test(s)
          if (hasOperator) {
            quotedFilters[k] = s
          } else {
            // 數字直接加 =，字串加 = 並補單引號
            const isNumeric = /^\d+(\.\d+)?$/.test(s)
            quotedFilters[k] = isNumeric ? `= ${s}` : `= '${s.replace(/'/g, "''")}'`
          }
        }
      }

      const sparam = JSON.stringify({
        APIKEY1: keys.APIKEY1,
        APIKEY2: keys.APIKEY2,
        APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: table,
        SHOWNULLCOLUMN: 'N',
        ...(customColumn ? { CUSTOMCOLUMN: customColumn } : {}),
        ...quotedFilters,
      })

      const res = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam }),
      })

      const { rawText, parsed } = await readApiResponse(res)
      const error = extractApiError(parsed)
      const success = res.ok && isArgoSuccess(parsed)

      if (!success) {
        return NextResponse.json({
          status: 'error',
          error: error || 'ARGO PJ query failed',
          rawText,
          debugSparam: JSON.parse(sparam) as Record<string, unknown>,
        }, { status: 502 })
      }

      const queryRows = findObjectRows(parsed)
      if (queryRows.length === 0) {
        return NextResponse.json({
          status: 'error',
          error: 'ARGO 查詢成功，但找不到可映射的資料列。請確認 TABLE / CUSTOMCOLUMN 設定。',
          rawText,
        }, { status: 422 })
      }

      const normalizedRows = normalizePjRows(queryRows, docType, mapping)

      // 第一筆 raw 資料回給前端供欄位對照用
      const rawSample = queryRows[0] ?? null

      if (normalizedRows.length === 0) {
        return NextResponse.json({
          status: 'error',
          error: `找到 ${queryRows.length.toString()} 筆原始資料，但 docNoField="${mapping.docNoField}" 欄位全為空，請調整欄位映射。`,
          rawSample,
          rawText,
        }, { status: 422 })
      }

      try {
        const supabaseAdmin = getSupabaseAdminClient()
        // 增量比對更新（取代整批 delete+insert）；scope 限本次 docType，不動其他單別
        await reconcileTable(supabaseAdmin, {
          table: 'erp_pj_sync',
          keyCols: ['doc_type', 'doc_no', 'sub_no'],
          compareCols: ['item_code', 'description', 'qty', 'unit', 'status', 'start_date', 'end_date', 'customer_vendor', 'remark', 'extra'],
          rows: normalizedRows,
          scope: { col: 'doc_type', value: docType },
          action: 'sync_pj',
          docNoCol: 'doc_no',
          subNoCol: 'sub_no',
        })
      } catch (err) {
        const message = err instanceof Error ? formatSupabaseAdminError(err.message) : '寫入 erp_pj_sync 失敗'
        return NextResponse.json({ status: 'error', error: message }, { status: 500 })
      }

      return NextResponse.json({
        status: 'ok',
        syncedCount: normalizedRows.length,
        skippedCount: Math.max(0, queryRows.length - normalizedRows.length),
        docType,
        table,
        rawSample,
      })
    }

    if (action === 'sync_bom_units') {
      // ── 全量同步 MM_BOM_PART 料號→單位 到 Supabase mm_bom_part_units ──
      // 不帶 filter，一次取全部 PART + UNIT_OF_MEASURE，避免批次過多 ARGO 請求
      const sparam = JSON.stringify({
        APIKEY1: keys.APIKEY1,
        APIKEY2: keys.APIKEY2,
        APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: 'MM_BOM_PART',
        SHOWNULLCOLUMN: 'N',
        CUSTOMCOLUMN: 'PART,UNIT_OF_MEASURE,PART_NAME,PART_DESC',
        PART: 'IS NOT NULL',   // ARGO 需要至少一個 filter，否則空 WHERE 子句 → ORA-00936
      })
      const argoRes = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam }),
      })
      const { parsed: argoParsed, rawText: argoRaw } = await readApiResponse(argoRes)
      const argoError = extractApiError(argoParsed)
      if (!argoRes.ok || !isArgoSuccess(argoParsed)) {
        return NextResponse.json({ status: 'error', error: argoError || 'ARGO MM_BOM_PART query failed', rawText: argoRaw }, { status: 502 })
      }

      const bomRows = findObjectRows(argoParsed)
      if (bomRows.length === 0) {
        return NextResponse.json({ status: 'error', error: 'ARGO 查無 MM_BOM_PART 資料' }, { status: 422 })
      }

      // 整理：過濾掉 PART 為空的（UNIT_OF_MEASURE / PART_NAME / PART_DESC 允許為 null）
      const syncedAt = new Date().toISOString()
      const upsertRows = bomRows
        .map(row => ({
          part_code: String(getRecordValue(row, 'PART') ?? '').trim(),
          unit_of_measure: String(getRecordValue(row, 'UNIT_OF_MEASURE') ?? '').trim() || null,
          part_name: String(getRecordValue(row, 'PART_NAME') ?? '').trim() || null,
          part_desc: String(getRecordValue(row, 'PART_DESC') ?? '').trim() || null,
          synced_at: syncedAt,
        }))
        .filter(r => r.part_code)

      const supabaseAdmin = getSupabaseAdminClient()
      const BATCH_SIZE = 500
      let upsertedCount = 0
      for (let i = 0; i < upsertRows.length; i += BATCH_SIZE) {
        const chunk = upsertRows.slice(i, i + BATCH_SIZE)
        const { error: upsertError } = await supabaseAdmin
          .from('mm_bom_part_units')
          .upsert(chunk, { onConflict: 'part_code' })
        if (upsertError) throw upsertError
        upsertedCount += chunk.length
      }

      return NextResponse.json({
        status: 'ok',
        totalFromArgo: bomRows.length,
        upsertedCount,
      })
    }

    if (action === 'sync_bom_structure') {
      // ── 全量同步 MM_BOM_STRUCTURE BOM展開結構 到 Supabase mm_bom_structure ──
      const sparam = JSON.stringify({
        APIKEY1: keys.APIKEY1,
        APIKEY2: keys.APIKEY2,
        APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: 'MM_BOM_STRUCTURE',
        SHOWNULLCOLUMN: 'N',
        CUSTOMCOLUMN: 'MBP_PART,MBP_VER,MBP_CHILD_PART,MBP_CHILD_VER,LINE_NO,CHILD_QTY,CHILD_SCRAP,LOT_CHILD_QTY,LOT_BASE',
        MBP_PART: 'IS NOT NULL',  // ARGO 需要至少一個 filter，否則 ORA-00936
      })
      const argoRes = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam }),
      })
      const { parsed: argoParsed, rawText: argoRaw } = await readApiResponse(argoRes)
      const argoError = extractApiError(argoParsed)
      if (!argoRes.ok || !isArgoSuccess(argoParsed)) {
        return NextResponse.json({ status: 'error', error: argoError || 'ARGO MM_BOM_STRUCTURE query failed', rawText: argoRaw }, { status: 502 })
      }

      const bomRows = findObjectRows(argoParsed)
      if (bomRows.length === 0) {
        return NextResponse.json({ status: 'error', error: 'ARGO 查無 MM_BOM_STRUCTURE 資料' }, { status: 422 })
      }

      const syncedAt = new Date().toISOString()
      const upsertRows = bomRows
        .map(row => ({
          parent_part:   String(getRecordValue(row, 'MBP_PART')       ?? '').trim(),
          bom_ver:       Number(getRecordValue(row, 'MBP_VER')        ?? 1),
          child_part:    String(getRecordValue(row, 'MBP_CHILD_PART') ?? '').trim(),
          child_ver:     Number(getRecordValue(row, 'MBP_CHILD_VER')  ?? 1),
          line_no:       Number(getRecordValue(row, 'LINE_NO')         ?? 1),
          child_qty:     Number(getRecordValue(row, 'CHILD_QTY')       ?? 0),
          child_scrap:   Number(getRecordValue(row, 'CHILD_SCRAP')     ?? 0),
          lot_child_qty: getRecordValue(row, 'LOT_CHILD_QTY') != null ? Number(getRecordValue(row, 'LOT_CHILD_QTY')) : null,
          lot_base:      getRecordValue(row, 'LOT_BASE')      != null ? Number(getRecordValue(row, 'LOT_BASE'))      : null,
          synced_at: syncedAt,
        }))
        .filter(r => r.parent_part && r.child_part)

      const supabaseAdmin = getSupabaseAdminClient()
      const BATCH_SIZE = 500
      let upsertedCount = 0
      for (let i = 0; i < upsertRows.length; i += BATCH_SIZE) {
        const chunk = upsertRows.slice(i, i + BATCH_SIZE)
        const { error: upsertError } = await supabaseAdmin
          .from('mm_bom_structure')
          .upsert(chunk, { onConflict: 'parent_part,bom_ver,child_part,child_ver,line_no' })
        if (upsertError) throw upsertError
        upsertedCount += chunk.length
      }

      return NextResponse.json({
        status: 'ok',
        syncedCount: upsertedCount,
        totalFromArgo: bomRows.length,
      })
    }

    if (action === 'sync_material_prep') {
      // ── 批備料單同步（單一 JOIN 查詢：IV_NOTICE,IV_NOTICEDETAIL，與驗證範本相同）──

      const sparam = JSON.stringify({
        APIKEY1: keys.APIKEY1,
        APIKEY2: keys.APIKEY2,
        APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: 'IV_NOTICE,IV_NOTICEDETAIL',
        SHOWCOLUMNTIME: 'Y',
        SHOWNULLCOLUMN: 'Y',
        CUSTOMCOLUMN: 'IV_NOTICE.SLIP_NO,IV_NOTICE.SLIP_DATE,IV_NOTICE.PJT_PROJECT_ID,IV_NOTICE.MO_MBP_PART,IV_NOTICE.MO_QTY,IV_NOTICE.REMARK,IV_NOTICEDETAIL.LINE_NO,IV_NOTICEDETAIL.MBP_PART,IV_NOTICEDETAIL.NOTICE_QTY',
        'IV_NOTICEDETAIL.NTC_SLIP_NO': '=IV_NOTICE.SLIP_NO',
      })

      const res = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam }),
      })
      const { parsed, rawText } = await readApiResponse(res)
      if (!res.ok || !isArgoSuccess(parsed)) {
        return NextResponse.json({
          status: 'error',
          error: extractApiError(parsed) || 'ARGO IV_NOTICE/IV_NOTICEDETAIL query failed',
          rawText,
        }, { status: 502 })
      }

      const rows = findObjectRows(parsed)
      if (rows.length === 0) {
        return NextResponse.json({ status: 'error', error: 'IV_NOTICE/IV_NOTICEDETAIL 查無備料單資料' }, { status: 422 })
      }

      // 組合 prepLines（每列已是 JOIN 後的完整資料）
      const syncedAt = new Date().toISOString()
      const slipNos = new Set<string>()
      const prepLines: {
        slip_no: string
        slip_date: string | null
        mo_number: string | null
        fg_part: string | null
        mo_qty: number
        line_no: number | null
        mbp_part: string | null
        notice_qty: number
        remark: string | null
        synced_at: string
      }[] = []

      for (const row of rows) {
        const slipNo = String(getRecordValue(row, 'SLIP_NO') ?? '').trim()
        if (!slipNo) continue
        slipNos.add(slipNo)
        prepLines.push({
          slip_no:    slipNo,
          slip_date:  String(getRecordValue(row, 'SLIP_DATE') ?? '').trim() || null,
          mo_number:  String(getRecordValue(row, 'PJT_PROJECT_ID') ?? '').trim() || null,
          fg_part:    String(getRecordValue(row, 'MO_MBP_PART') ?? '').trim() || null,
          mo_qty:     Number(getRecordValue(row, 'MO_QTY') ?? 0) || 0,
          line_no:    getRecordValue(row, 'LINE_NO') != null ? Number(getRecordValue(row, 'LINE_NO')) : null,
          mbp_part:   String(getRecordValue(row, 'MBP_PART') ?? '').trim() || null,
          notice_qty: Number(getRecordValue(row, 'NOTICE_QTY') ?? 0) || 0,
          remark:     String(getRecordValue(row, 'REMARK') ?? '').trim() || null,
          synced_at: syncedAt,
        })
      }

      // 全量刪除後重寫。
      // 【刻意維持整批覆蓋，勿改增量】實測 ARGO IV_NOTICEDETAIL 同一 (slip_no, line_no)
      // 可有多筆不同料號、也有完全相同的重複列（2026-07-03 稽核：2216 列中 8 組重複，
      // 其中 MOT26061101401 line 1 有兩種料）。此表沒有可靠自然鍵，上唯一索引/upsert 會丟資料。
      try {
        const supabaseAdmin = getSupabaseAdminClient()
        const { error: clearError } = await supabaseAdmin.from('erp_material_prep_lines').delete().neq('id', 0)
        if (clearError) throw clearError

        const batchSize = 500
        for (let i = 0; i < prepLines.length; i += batchSize) {
          const chunk = prepLines.slice(i, i + batchSize)
          const { error: insertError } = await supabaseAdmin.from('erp_material_prep_lines').insert(chunk)
          if (insertError) throw insertError
        }
      } catch (err) {
        const pgError = err as { message?: string; code?: string; details?: string }
        const message = pgError?.message
          ? `寫入 erp_material_prep_lines 失敗：${pgError.message}${pgError.code ? ` (code: ${pgError.code})` : ''}${pgError.details ? ` — ${pgError.details}` : ''}`
          : String(err)
        return NextResponse.json({ status: 'error', error: message }, { status: 500 })
      }

      return NextResponse.json({
        status: 'ok',
        syncedCount: prepLines.length,
        headerCount: slipNos.size,
        detailTotal: prepLines.length,
      })
    }

    if (action === 'sync_customer') {
      const sparam = JSON.stringify({
        APIKEY1: keys.APIKEY1,
        APIKEY2: keys.APIKEY2,
        APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: 'GL_TRADINGPARTNER',
        SHOWNULLCOLUMN: 'N',
        CUSTOMCOLUMN: 'PARTNER_ID,CNAME,FULL_CNAME',
        CUSTOMER: "= 'Y'",
      })

      const res = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam }),
      })

      const { rawText, parsed } = await readApiResponse(res)
      const error = extractApiError(parsed)
      const success = res.ok && isArgoSuccess(parsed)

      if (!success) {
        return NextResponse.json({
          status: 'error',
          error: error || 'ARGO GL_TRADINGPARTNER query failed',
          rawText,
        }, { status: 502 })
      }

      const queryRows = findObjectRows(parsed)
      if (queryRows.length === 0) {
        return NextResponse.json({
          status: 'error',
          error: 'ARGO 查詢成功，但找不到客戶資料列，請確認 CUSTOMER=Y 及欄位設定。',
          rawText,
        }, { status: 422 })
      }

      const syncedAt = new Date().toISOString()
      const customerRows = queryRows
        .map((row) => {
          const partnerId = String(getRecordValue(row, 'PARTNER_ID') ?? '').trim()
          if (!partnerId) return null
          return {
            partner_id: partnerId,
            cname:      String(getRecordValue(row, 'CNAME')      ?? '').trim(),
            full_cname: String(getRecordValue(row, 'FULL_CNAME') ?? '').trim() || null,
            synced_at:  syncedAt,
          }
        })
        .filter((r): r is NonNullable<typeof r> => Boolean(r))

      // 增量比對更新（取代整批 delete+insert）：只寫變動列、刪除消失列、記 log。
      // erp_customers 已有 partner_id unique index（20260511_erp_customers.sql），可直接 upsert。
      let recon
      try {
        const supabaseAdmin = getSupabaseAdminClient()
        recon = await reconcileTable(supabaseAdmin, {
          table: 'erp_customers',
          keyCols: ['partner_id'],
          onConflict: 'partner_id',
          compareCols: ['cname', 'full_cname'],
          rows: customerRows,
          action: 'sync_customer',
        })
      } catch (err) {
        const message = err instanceof Error ? formatSupabaseAdminError(err.message) : '寫入 erp_customers 失敗'
        return NextResponse.json({ status: 'error', error: message }, { status: 500 })
      }

      return NextResponse.json({
        status: 'ok',
        syncedCount: customerRows.length,
        skippedCount: queryRows.length - customerRows.length,
        inserted: recon.inserted,
        updated: recon.updated,
        deleted: recon.deleted,
        unchanged: recon.unchanged,
      })
    }

    if (action === 'sync_vendor') {
      // ── 供應商主檔同步（與 sync_customer 同模式，改抓 SUPPLIER='Y' 寫 erp_vendors）──
      // erp_vendors 為 service_role 專用（供應商資料不可外流），僅採購 API 讀取。
      const sparam = JSON.stringify({
        APIKEY1: keys.APIKEY1,
        APIKEY2: keys.APIKEY2,
        APIKEY3: keys.APIKEY3,
        SEGMENT,
        TABLE: 'GL_TRADINGPARTNER',
        SHOWNULLCOLUMN: 'N',
        CUSTOMCOLUMN: 'PARTNER_ID,CNAME,FULL_CNAME',
        SUPPLIER: "= 'Y'",   // GL_TRADINGPARTNER 的供應商旗標欄位（客戶為 CUSTOMER，實查確認）
      })

      const res = await fetch(`${API_BASE}/S_QUERY`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sparam }),
      })

      const { rawText, parsed } = await readApiResponse(res)
      const error = extractApiError(parsed)
      const success = res.ok && isArgoSuccess(parsed)

      if (!success) {
        return NextResponse.json({
          status: 'error',
          error: error || 'ARGO GL_TRADINGPARTNER query failed',
          rawText,
        }, { status: 502 })
      }

      const queryRows = findObjectRows(parsed)
      if (queryRows.length === 0) {
        return NextResponse.json({
          status: 'error',
          error: 'ARGO 查詢成功，但找不到供應商資料列，請確認 VENDOR=Y 及欄位設定。',
          rawText,
        }, { status: 422 })
      }

      const syncedAt = new Date().toISOString()
      const vendorRows = queryRows
        .map((row) => {
          const partnerId = String(getRecordValue(row, 'PARTNER_ID') ?? '').trim()
          if (!partnerId) return null
          return {
            partner_id: partnerId,
            cname:      String(getRecordValue(row, 'CNAME')      ?? '').trim(),
            full_cname: String(getRecordValue(row, 'FULL_CNAME') ?? '').trim() || null,
            synced_at:  syncedAt,
          }
        })
        .filter((r): r is NonNullable<typeof r> => Boolean(r))

      // 增量比對更新：erp_vendors 有 partner_id unique index（20260703_purchasing_tracking.sql）
      let recon
      try {
        const supabaseAdmin = getSupabaseAdminClient()
        recon = await reconcileTable(supabaseAdmin, {
          table: 'erp_vendors',
          keyCols: ['partner_id'],
          onConflict: 'partner_id',
          compareCols: ['cname', 'full_cname'],
          rows: vendorRows,
          action: 'sync_vendor',
        })
      } catch (err) {
        const message = err instanceof Error ? formatSupabaseAdminError(err.message) : '寫入 erp_vendors 失敗'
        return NextResponse.json({ status: 'error', error: message }, { status: 500 })
      }

      return NextResponse.json({
        status: 'ok',
        syncedCount: vendorRows.length,
        skippedCount: queryRows.length - vendorRows.length,
        inserted: recon.inserted,
        updated: recon.updated,
        deleted: recon.deleted,
        unchanged: recon.unchanged,
      })
    }

    return NextResponse.json({ status: 'error', error: `Unknown action: ${action}` }, { status: 400 })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ status: 'error', error: message }, { status: 500 })
  }
}

function normalizePjRows(
  rows: Record<string, unknown>[],
  docType: string,
  mapping: PjSyncMapping,
) {
  const syncedAt = new Date().toISOString()
  const knownFields = new Set(Object.values(mapping).filter(Boolean))

  return rows
    .map((row) => {
      const docNo = String(getRecordValue(row, mapping.docNoField) ?? '').trim()
      if (!docNo) return null

      // 非映射欄位全部塞進 extra JSON
      const extra: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) {
        if (!knownFields.has(k)) extra[k] = v
      }

      return {
        doc_type: docType,
        doc_no: docNo,
        sub_no: String(getRecordValue(row, mapping.subNoField) ?? '').trim(),
        item_code: String(getRecordValue(row, mapping.itemCodeField) ?? '').trim() || null,
        description: String(getRecordValue(row, mapping.descriptionField) ?? '').trim() || null,
        qty: toNumber(getRecordValue(row, mapping.qtyField)),
        unit: String(getRecordValue(row, mapping.unitField) ?? '').trim() || null,
        status: String(getRecordValue(row, mapping.statusField) ?? '').trim() || null,
        start_date: String(getRecordValue(row, mapping.startDateField) ?? '').trim() || null,
        end_date: String(getRecordValue(row, mapping.endDateField) ?? '').trim() || null,
        customer_vendor: String(getRecordValue(row, mapping.customerVendorField) ?? '').trim() || null,
        remark: String(getRecordValue(row, mapping.remarkField) ?? '').trim() || null,
        extra: Object.keys(extra).length > 0 ? extra : null,
        synced_at: syncedAt,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
}
