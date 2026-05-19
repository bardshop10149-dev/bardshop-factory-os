import { NextRequest, NextResponse } from 'next/server'

import { formatSupabaseAdminError, getSupabaseAdminClient } from '../../../lib/supabaseAdmin'

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

function toNumber(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0

  const parsed = Number(String(value).replace(/,/g, '').trim())
  return Number.isFinite(parsed) ? parsed : 0
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
      book_count: number
      physical_count: number
      qisheng_sichuan_total: number
    }>()

    for (const row of rows) {
      const itemCode = String(getRecordValue(row, mapping.itemCodeField) ?? '').trim()
      if (!itemCode) continue
      const existing = grouped.get(itemCode)
      const bookQty = toNumber(getRecordValue(row, mapping.bookCountField))
      if (existing) {
        existing.book_count += bookQty
        existing.physical_count += toNumber(getRecordValue(row, mapping.physicalCountField))
        existing.qisheng_sichuan_total += toNumber(getRecordValue(row, mapping.warehouseTotalField))
      } else {
        grouped.set(itemCode, {
          item_code: itemCode,
          item_name: String(getRecordValue(row, mapping.itemNameField) ?? '').trim(),
          spec: String(getRecordValue(row, mapping.specField) ?? '').trim(),
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
      action: 'import' | 'query' | 'sync_inventory' | 'sync_customer' | 'fetch_po_pdl_links' | 'explore_so_columns' | 'test_so_detail' | 'test_po_detail' | 'sync_so' | 'sync_mo' | 'sync_pj' | 'sync_po' | 'sync_bom_units' | 'sync_material_prep'
      data?: Record<string, unknown>[]
      interfaceId?: string
    }

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

      try {
        const supabaseAdmin = getSupabaseAdminClient()
        const { error: clearError } = await supabaseAdmin.from('material_inventory_list').delete().neq('id', 0)
        if (clearError) throw clearError

        const batchSize = 500
        for (let index = 0; index < normalizedRows.length; index += batchSize) {
          const chunk = normalizedRows.slice(index, index + batchSize)
          const { error: insertError } = await supabaseAdmin.from('material_inventory_list').insert(chunk)
          if (insertError) throw insertError
        }
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
        SHOWNULLCOLUMN: 'N',
        CUSTOMCOLUMN: 'PROJECT_ID,BEGIN_DATE,HOLD_STATUS,TPN_PARTNER_ID,SALES_NAME,PARTNER_NAME',
        PJT_TYPE: "= 'SO'",
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
          remark:             String(getRecordValue(row, 'REMARK') ?? '').trim() || null,
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

      try {
        const supabaseAdmin = getSupabaseAdminClient()

        const { error: clearError } = await supabaseAdmin.from('erp_so_lines').delete().neq('id', 0)
        if (clearError) throw clearError

        const batchSize = 500
        for (let i = 0; i < soLines.length; i += batchSize) {
          const chunk = soLines.slice(i, i + batchSize)
          const { error: insertError } = await supabaseAdmin.from('erp_so_lines').insert(chunk)
          if (insertError) {
            const detail = typeof insertError === 'object' && 'message' in insertError
              ? (insertError as { message: string }).message : JSON.stringify(insertError)
            throw new Error(detail)
          }
        }
      } catch (err) {
        const message = err instanceof Error ? formatSupabaseAdminError(err.message) : '寫入 erp_so_lines 失敗'
        return NextResponse.json({ status: 'error', error: message }, { status: 500 })
      }

      return NextResponse.json({
        status: 'ok',
        syncedCount: soLines.length,
        totalRows: soDetailRows.length,
        headerCount: soHeaderRows.length,
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
        CUSTOMCOLUMN: 'PROJECT_ID,BEGIN_DATE,HOLD_STATUS,TPN_PARTNER_ID,SALES_ID,PAYMENT_TERM,PAYMENT_MODE,CURRENCY,EXCHANGE_RATE,TAX_RATE,SEG_SEGMENT_NO,PO_TYPE,MODIFY_VER',
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
        CUSTOMCOLUMN: 'PJT_PROJECT_ID,LINE_NO,MBP_PART,MBP_LOT_NO,ORDER_QTY_ORU,UNIT_OF_MEASURE_ORU,DUEDATE,REMARK,REMARK2,PACKING,UNIT_PRICE_ORU,MBP_VER,PDL_SEQ_SO,TPN_PART_NO,SO_PROJECT_ID',
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
        end_date:        String(getRecordValue(dtl, 'DUEDATE') ?? '').trim() || null,
        customer_vendor: String(getRecordValue(hdr, 'TPN_PARTNER_ID') ?? '').trim() || null,
        remark:          String(getRecordValue(dtl, 'REMARK2') ?? '').trim() || null,
        extra: {
          UNIT_PRICE_ORU: getRecordValue(dtl, 'UNIT_PRICE_ORU') ?? null,
          MBP_VER:        getRecordValue(dtl, 'MBP_VER') ?? null,
          MBP_LOT_NO:     String(getRecordValue(dtl, 'MBP_LOT_NO') ?? '').trim() || null,
          SO_PROJECT_ID:  String(getRecordValue(dtl, 'SO_PROJECT_ID') ?? '').trim() || null,
          SO_LINE_NO:     getRecordValue(dtl, 'PDL_SEQ_SO') != null ? String(getRecordValue(dtl, 'PDL_SEQ_SO')) : null,
          TPN_PART_NO:    String(getRecordValue(dtl, 'TPN_PART_NO') ?? '').trim() || null,
          PACKING:        String(getRecordValue(dtl, 'PACKING') ?? '').trim() || null,
          SALES_ID:       String(getRecordValue(hdr, 'SALES_ID') ?? '').trim() || null,
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

      try {
        const supabaseAdmin = getSupabaseAdminClient()
        const { error: clearError } = await supabaseAdmin.from('erp_pj_sync').delete().eq('doc_type', '採購單號')
        if (clearError) throw clearError
        const batchSize = 500
        for (let i = 0; i < poSyncRows.length; i += batchSize) {
          const chunk = poSyncRows.slice(i, i + batchSize)
          const { error: insertError } = await supabaseAdmin.from('erp_pj_sync').insert(chunk)
          if (insertError) throw insertError
        }
      } catch (err) {
        const message = err instanceof Error ? formatSupabaseAdminError(err.message) : '寫入 erp_pj_sync 失敗'
        return NextResponse.json({ status: 'error', error: message }, { status: 500 })
      }

      return NextResponse.json({
        status: 'ok',
        syncedCount: poSyncRows.length,
        totalHdrRows: hdrRows.length,
        totalDtlRows: dtlRows.length,
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

      try {
        const supabaseAdmin = getSupabaseAdminClient()
        const { error: clearError } = await supabaseAdmin.from('erp_mo_lines').delete().neq('id', 0)
        if (clearError) throw clearError

        const batchSize = 500
        for (let i = 0; i < dedupedLines.length; i += batchSize) {
          const chunk = dedupedLines.slice(i, i + batchSize)
          const { error: insertError } = await supabaseAdmin.from('erp_mo_lines').insert(chunk)
          if (insertError) throw insertError
        }
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
        // 刪除同類型舊資料後重寫
        const { error: clearError } = await supabaseAdmin
          .from('erp_pj_sync')
          .delete()
          .eq('doc_type', docType)
        if (clearError) throw clearError

        const batchSize = 500
        for (let index = 0; index < normalizedRows.length; index += batchSize) {
          const chunk = normalizedRows.slice(index, index + batchSize)
          const { error: insertError } = await supabaseAdmin.from('erp_pj_sync').insert(chunk)
          if (insertError) throw insertError
        }
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
        CUSTOMCOLUMN: 'PART,UNIT_OF_MEASURE',
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

      // 整理：過濾掉 PART 或 UNIT_OF_MEASURE 為空的
      const syncedAt = new Date().toISOString()
      const upsertRows = bomRows
        .map(row => ({
          part_code: String(getRecordValue(row, 'PART') ?? '').trim(),
          unit_of_measure: String(getRecordValue(row, 'UNIT_OF_MEASURE') ?? '').trim() || null,
          synced_at: syncedAt,
        }))
        .filter(r => r.part_code && r.unit_of_measure)

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

      // 全量刪除後重寫
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

      try {
        const supabaseAdmin = getSupabaseAdminClient()
        const { error: clearError } = await supabaseAdmin.from('erp_customers').delete().neq('id', 0)
        if (clearError) throw clearError

        const batchSize = 500
        for (let i = 0; i < customerRows.length; i += batchSize) {
          const chunk = customerRows.slice(i, i + batchSize)
          const { error: insertError } = await supabaseAdmin.from('erp_customers').insert(chunk)
          if (insertError) throw insertError
        }
      } catch (err) {
        const message = err instanceof Error ? formatSupabaseAdminError(err.message) : '寫入 erp_customers 失敗'
        return NextResponse.json({ status: 'error', error: message }, { status: 500 })
      }

      return NextResponse.json({
        status: 'ok',
        syncedCount: customerRows.length,
        skippedCount: queryRows.length - customerRows.length,
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
