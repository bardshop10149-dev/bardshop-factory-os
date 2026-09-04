import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { argoConfigured, argoQuery, argoImport } from '@/lib/argoQuery'

// 每天 17:01（台北時間）自動轉單：當天出單表的委外列→請購單（IFAF105）、
// 常平列→採購單（IFAF024）。邏輯完整搬自兩個手動頁面（order-batch-export-pr /
// order-batch-export-c），表頭全部用頁面的固定預設值；設計決策（2026-08-24 與使用者確認）：
//   * 常平採購單價一律 0
//   * 序號比對不到的常平列：跳過 + 記錄，不送出
//
// 防重複建單：詳見 sql/20260824_auto_doc_runs.sql——ARGO 已建單但回寫失敗的紀錄
// （status='imported'）會擋住後續所有自動執行，直到人工確認並標記 resolved。

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

type SheetRowRec = Record<string, unknown>

function taipeiTodayStr(): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const y = parts.find(p => p.type === 'year')!.value
  const m = parts.find(p => p.type === 'month')!.value
  const d = parts.find(p => p.type === 'day')!.value
  return `${y}-${m}-${d}`
}

/** YYYY-MM-DD → YYYY/MM/DD */
function slashDate(isoDate: string): string {
  return isoDate.replace(/-/g, '/')
}

function parseYmd(s: string): Date | null {
  const m = String(s ?? '').trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/)
  if (!m) return null
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(dt.getTime()) ? null : dt
}
function fmtSlash(d: Date): string {
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}
// ARGO 規則：DUEDATE 必須晚於 APPLY_DATE（與 order-batch-export-pr 的 clampDueDate 一致）
function clampDueDate(deliveryDate: string, applyDate: string): string {
  const apply = parseYmd(applyDate)
  if (!apply) return (deliveryDate ?? '').trim()
  const minDue = new Date(apply.getTime())
  minDue.setDate(minDue.getDate() + 1)
  const due = parseYmd(deliveryDate)
  if (due && due.getTime() >= minDue.getTime()) return fmtSlash(due)
  return fmtSlash(minDue)
}

const str = (v: unknown): string => String(v ?? '').trim()
const qtyOf = (v: unknown): number => parseFloat(str(v).replace(/,/g, '')) || 0

type Sb = ReturnType<typeof getSupabaseAdminClient>

// 逐列 CHECK_FLAG 判讀（與兩個手動頁面一致的語意）
function classifyLines(
  importResult: Awaited<ReturnType<typeof argoImport>>,
  totalLines: number,
): { successIdx: number[]; failedInfo: Array<{ i: number; error: string }> } {
  const flagByLineNo = new Map<string, { flag: string; error: string }>()
  for (const row of importResult.resultRows) {
    const lineNo = str(row.LINE_NO)
    if (!lineNo) continue
    flagByLineNo.set(String(parseInt(lineNo, 10)), {
      flag: String(row.CHECK_FLAG ?? '').toUpperCase(),
      error: str(row.ERROR_CODE ?? row.ERROR) || '未知錯誤',
    })
  }
  const successIdx: number[] = []
  const failedInfo: Array<{ i: number; error: string }> = []
  for (let i = 0; i < totalLines; i++) {
    const info = flagByLineNo.get(String(i + 1))
    if (!info) {
      if (importResult.resultRows.length === 0 && importResult.success) successIdx.push(i)
      else failedInfo.push({ i, error: 'ARGO 未回報此筆狀態' })
    } else if (info.flag === 'N') {
      failedInfo.push({ i, error: info.error })
    } else {
      successIdx.push(i)
    }
  }
  return { successIdx, failedInfo }
}

// 出單表逐列回寫（等同 daily-order-sheet PATCH 的合併語意，cron 直接用 admin client 寫）
async function patchSheetRows(
  sb: Sb,
  sheetDate: string,
  updates: Array<{ row_key: string } & Record<string, unknown>>,
): Promise<void> {
  const { data: existing, error: fetchError } = await sb
    .from('daily_order_sheets')
    .select('rows')
    .eq('sheet_date', sheetDate)
    .single()
  if (fetchError) throw fetchError
  const updateMap = new Map(updates.map(u => [u.row_key, u]))
  const currentRows = Array.isArray(existing.rows) ? existing.rows as SheetRowRec[] : []
  const updatedRows = currentRows.map(row => {
    const upd = updateMap.get(row.row_key as string)
    if (!upd) return row
    const merged = { ...row }
    for (const [k, v] of Object.entries(upd)) {
      if (k === 'row_key') continue
      merged[k] = v
    }
    return merged
  })
  const { error: updateError } = await sb
    .from('daily_order_sheets')
    .update({
      rows: updatedRows,
      updated_at: new Date().toISOString(),
      updated_by: 'auto-doc-creation',
      updated_by_name: '自動轉單排程',
      last_action: 'auto_doc_creation',
    })
    .eq('sheet_date', sheetDate)
  if (updateError) throw updateError
}

async function logRun(sb: Sb, id: number | null, patch: Record<string, unknown>): Promise<void> {
  if (id == null) return
  await sb.from('argoerp_auto_doc_runs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
}

interface RunSummary {
  runType: 'pr' | 'po'
  status: string
  docNo?: string
  imported?: number
  failed?: number
  skipped?: number
  message?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// 委外請購（IFAF105）——搬自 order-batch-export-pr
// ─────────────────────────────────────────────────────────────────────────────
async function runPrCreation(sb: Sb, sheetDate: string, allRows: SheetRowRec[]): Promise<RunSummary> {
  const isMpoImported = (row: SheetRowRec): boolean => {
    const moNo = str(row.mo_number).toUpperCase()
    const prNo = str(row.pr_number).toUpperCase()
    return prNo.startsWith('MPO') || prNo.startsWith('MP') || moNo.startsWith('MPO')
  }
  const rows = allRows.filter(r =>
    r.factory === 'O' && r.po_status !== 'no_po' && !isMpoImported(r) && qtyOf(r.quantity) > 0,
  )
  if (rows.length === 0) {
    await sb.from('argoerp_auto_doc_runs').insert({ run_type: 'pr', sheet_date: sheetDate, status: 'skipped', detail: { reason: '無待轉委外列' } })
    return { runType: 'pr', status: 'skipped', message: '無待轉委外列' }
  }

  const { data: runRow, error: runErr } = await sb
    .from('argoerp_auto_doc_runs')
    .insert({ run_type: 'pr', sheet_date: sheetDate, status: 'started', detail: { rowCount: rows.length } })
    .select('id').single()
  if (runErr) throw runErr
  const runId: number = runRow.id

  try {
    // ERP 單位（IFAF105 單位需與 ERP 對應，手動頁會擋不一致；自動版直接以 ERP 單位為準）
    const partCodes = [...new Set(rows.map(r => str(r.item_code)).filter(Boolean))]
    const unitMap = new Map<string, string>()
    if (partCodes.length > 0) {
      const { data: unitData } = await sb.from('mm_bom_part_units').select('part_code, unit_of_measure').in('part_code', partCodes)
      for (const u of unitData ?? []) {
        if (u.part_code && u.unit_of_measure) unitMap.set(u.part_code, u.unit_of_measure)
      }
    }

    // 取號：即時查 ARGO 請購主檔當天最大流水 +1（不依賴 erp_pj_sync）
    const applyDate = slashDate(sheetDate)
    const digits = sheetDate.replace(/-/g, '')
    const prefix = `MPO${digits}`
    const argoExisting = await argoQuery('PJ_APPLYPROJECT', { APPLY_ID: `LIKE '${prefix}%'` })
    let maxSeq = 0
    for (const rec of argoExisting) {
      const docNo = str(rec.APPLY_ID).toUpperCase()
      if (!docNo.startsWith(prefix)) continue
      const seq = parseInt(docNo.slice(prefix.length), 10)
      if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq
    }
    const applyId = `${prefix}${String(maxSeq + 1).padStart(2, '0')}`
    await logRun(sb, runId, { doc_no: applyId })

    const payload = rows.map((row, i) => ({
      APPLY_ID: applyId,
      APPLY_DATE: applyDate,
      SEG_SEGMENT_NO_DEPARTMENT: 'M1100',
      HOLD_STATUS: 'UNSIGNED',
      LINE_NO: String(i + 1),
      MBP_PART: str(row.item_code),
      MBP_VER: '1',
      MBP_LOT_NO: str(row.order_number),
      UNIT_OF_MEASURE_ORU: unitMap.get(str(row.item_code)) || 'PCS',
      ORDER_QTY_ORU: String(qtyOf(row.quantity)),
      CURRENCY: 'CNY',
      DUEDATE: clampDueDate(str(row.delivery_date), applyDate),
      FLOW_TYPE: 'IVAR154-1',
      APPLY_USER: '10149',
    }))

    const importResult = await argoImport('IFAF105', payload)
    const { successIdx, failedInfo } = classifyLines(importResult, rows.length)

    if (successIdx.length === 0) {
      await logRun(sb, runId, { status: 'failed', detail: { error: importResult.error, rawText: importResult.rawText, failedInfo } })
      return { runType: 'pr', status: 'failed', docNo: applyId, failed: rows.length, message: importResult.error ?? '整批失敗' }
    }

    // ARGO 已建單——先標 imported（此刻起若回寫失敗，這筆紀錄會擋住之後的自動執行）
    await logRun(sb, runId, { status: 'imported', detail: { successCount: successIdx.length, failedInfo } })

    const updates: Array<{ row_key: string } & Record<string, unknown>> = []
    const noRowKey: string[] = []
    for (const i of successIdx) {
      const src = rows[i]
      const rowKey = str(src.row_key)
      if (!rowKey) { noRowKey.push(`${str(src.order_number)}/${str(src.item_code)}`); continue }
      const hasMatchedPo = src.po_status === 'matched' && !!src.po_number
      // pr_sub_no 必須一併回寫：上面送 ARGO 時已用 LINE_NO = i+1 指定行號，同一張請購單
      // 會涵蓋多張訂單的多個品項，只記單號而不記行號的話，下游（SARA 工序轉換）組出的
      // 工單號會是不帶後綴的「MPO…」，同一張請購單的所有品項在塔台裡全部擠成同一個工單號、
      // 無法分辨是哪一筆（2026-09-04 使用者回報）。常平採購單路徑本來就有寫 po_sub_no
      // （見下方 IFAF024 段落），這裡是漏寫。
      const prSubNo = String(i + 1)
      updates.push(hasMatchedPo
        ? { row_key: rowKey, mo_number: src.po_number, pr_number: applyId, pr_sub_no: prSubNo, po_number: src.po_number, po_status: 'matched' }
        : { row_key: rowKey, mo_number: applyId, pr_number: applyId, pr_sub_no: prSubNo, po_status: null })
    }
    if (updates.length > 0) await patchSheetRows(sb, sheetDate, updates)

    // 缺 row_key 的成功列無法回寫——保持 imported 狀態擋住後續執行，待人工確認
    if (noRowKey.length > 0) {
      await logRun(sb, runId, { detail: { successCount: successIdx.length, failedInfo, noRowKey, warning: '部分成功列缺 row_key 無法回寫，需人工確認後標記 resolved' } })
      return { runType: 'pr', status: 'imported', docNo: applyId, imported: successIdx.length, failed: failedInfo.length, message: `${noRowKey.length} 筆缺 row_key 無法回寫，需人工確認` }
    }

    await logRun(sb, runId, { status: 'written_back', detail: { successCount: successIdx.length, failedInfo } })
    return { runType: 'pr', status: 'written_back', docNo: applyId, imported: successIdx.length, failed: failedInfo.length }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // 尚未送 ARGO 就丟例外 → failed；若是在 imported 之後丟（回寫失敗），狀態已停在 imported，不覆蓋
    const { data: cur } = await sb.from('argoerp_auto_doc_runs').select('status').eq('id', runId).single()
    if (cur?.status === 'started') await logRun(sb, runId, { status: 'failed', detail: { error: msg } })
    else await logRun(sb, runId, { detail: { error: msg } })
    return { runType: 'pr', status: cur?.status === 'started' ? 'failed' : 'imported', message: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 常平採購（IFAF024）——搬自 order-batch-export-c
// ─────────────────────────────────────────────────────────────────────────────
async function runPoCreation(sb: Sb, sheetDate: string, allRows: SheetRowRec[]): Promise<RunSummary> {
  const candidates = allRows.filter(r =>
    r.factory === 'C' && !r.po_number && r.po_status !== 'matched' && qtyOf(r.quantity) > 0,
  )
  if (candidates.length === 0) {
    await sb.from('argoerp_auto_doc_runs').insert({ run_type: 'po', sheet_date: sheetDate, status: 'skipped', detail: { reason: '無待轉常平列' } })
    return { runType: 'po', status: 'skipped', message: '無待轉常平列' }
  }

  // 序號比對（與頁面 runSerialMatch 相同邏輯）：優先用列上既有的 line_no_input/match_line_no，
  // 沒有的再用 erp_so_lines 依「單號+品號+數量」找候選（依序消耗，不重複沿用）
  const orderNumbers = [...new Set(candidates.map(r => str(r.order_number)).filter(Boolean))]
  const { data: soLines } = await sb
    .from('erp_so_lines')
    .select('project_id, line_no, mbp_part, order_qty_oru, unit_of_measure_oru, remark2, packing')
    .in('project_id', orderNumbers.length > 0 ? orderNumbers : ['__none__'])
  const candidateMap = new Map<string, string[]>()
  const soLineInfoMap = new Map<string, { uom: string | null; remark2: string | null; packing: string | null }>()
  for (const line of soLines ?? []) {
    const qty = Number(line.order_qty_oru ?? 0)
    const key = `${line.project_id}|${line.mbp_part ?? ''}|${qty}`
    if (!candidateMap.has(key)) candidateMap.set(key, [])
    candidateMap.get(key)!.push(String(line.line_no ?? ''))
    soLineInfoMap.set(`${line.project_id}|${String(line.line_no ?? '')}`, { uom: line.unit_of_measure_oru, remark2: line.remark2, packing: line.packing })
  }
  for (const arr of candidateMap.values()) arr.sort((a, b) => (Number(a) || 0) - (Number(b) || 0))
  const usageCounter = new Map<string, number>()

  const rows: SheetRowRec[] = []
  const lineSeqs: string[] = []
  const skipped: Array<{ order: string; item: string; reason: string }> = []
  for (const src of candidates) {
    const existingSeq = str(src.line_no_input) || str(src.match_line_no)
    if (existingSeq) { rows.push(src); lineSeqs.push(existingSeq); continue }
    const key = `${str(src.order_number)}|${str(src.item_code)}|${qtyOf(src.quantity)}`
    const cands = candidateMap.get(key) ?? []
    const used = usageCounter.get(key) ?? 0
    if (cands.length === 0 || used >= cands.length) {
      skipped.push({ order: str(src.order_number), item: str(src.item_code), reason: cands.length === 0 ? '序號比對不到（無對應單號/數量）' : '候選序號不足' })
      continue
    }
    usageCounter.set(key, used + 1)
    rows.push(src)
    lineSeqs.push(cands[used])
  }

  if (rows.length === 0) {
    await sb.from('argoerp_auto_doc_runs').insert({ run_type: 'po', sheet_date: sheetDate, status: 'skipped', detail: { reason: '全部序號比對失敗', skipped } })
    return { runType: 'po', status: 'skipped', skipped: skipped.length, message: '全部序號比對失敗，已跳過' }
  }

  const { data: runRow, error: runErr } = await sb
    .from('argoerp_auto_doc_runs')
    .insert({ run_type: 'po', sheet_date: sheetDate, status: 'started', detail: { rowCount: rows.length, skipped } })
    .select('id').single()
  if (runErr) throw runErr
  const runId: number = runRow.id

  try {
    // 取號：即時查 ARGO 採購主檔當天最大 POC 流水 +1
    const beginDate = slashDate(sheetDate)
    const prefix = `POC${sheetDate.replace(/-/g, '')}`
    const argoExisting = await argoQuery('PJ_PROJECT', { PROJECT_ID: `LIKE '${prefix}%'` })
    let maxSeq = 0
    for (const rec of argoExisting) {
      const docNo = str(rec.PROJECT_ID).toUpperCase()
      if (!docNo.startsWith(prefix)) continue
      const seq = parseInt(docNo.slice(prefix.length), 10)
      if (!Number.isNaN(seq) && seq > maxSeq) maxSeq = seq
    }
    const pid = `${prefix}${String(maxSeq + 1).padStart(2, '0')}`
    await logRun(sb, runId, { doc_no: pid })

    const payload = rows.map((row, i) => {
      const seq = lineSeqs[i]
      const soInfo = soLineInfoMap.get(`${str(row.order_number)}|${seq}`)
      const rec: Record<string, string> = {
        PROJECT_ID: pid,
        MODIFY_VER: '1',
        BEGIN_DATE: beginDate,
        HOLD_STATUS: 'UNSIGNED',
        TPN_PARTNER_ID: 'C01510',
        SEG_SEGMENT_NO_DEPARTMENT: 'M1100',
        SALES_ID: '10149',
        PO_TYPE: 'GENERAL',
        PAYMENT_TERM: 'PM30',
        PAYMENT_MODE: 'T',
        CURRENCY: 'CNY',
        EXCHANGE_RATE: '4',
        TAX_RATE: '0',
        LINE_NO: String(i + 1),
        MBP_PART: str(row.item_code),
        MBP_VER: '1',
        ORDER_QTY_ORU: String(qtyOf(row.quantity)),
        UNIT_OF_MEASURE_ORU: soInfo?.uom || 'PCS',
        UNIT_PRICE_ORU: '0',   // 自動轉單一律單價 0（2026-08-24 與使用者確認）
        DUEDATE: str(row.delivery_date),
        MBP_LOT_NO: str(row.order_number),
        SO_PROJECT_ID: str(row.order_number),
        TPN_PART_NO: seq,
      }
      const remark = [str(row.item_name), str(row.note)].filter(Boolean).join(' ')
      if (remark) rec.REMARK = remark
      if (str(soInfo?.remark2)) rec.REMARK2 = str(soInfo?.remark2)
      if (str(soInfo?.packing)) rec.PACKING = str(soInfo?.packing)
      return rec
    })

    const importResult = await argoImport('IFAF024', payload)
    const { successIdx, failedInfo } = classifyLines(importResult, rows.length)

    if (successIdx.length === 0) {
      await logRun(sb, runId, { status: 'failed', detail: { error: importResult.error, rawText: importResult.rawText, failedInfo, skipped } })
      return { runType: 'po', status: 'failed', docNo: pid, failed: rows.length, skipped: skipped.length, message: importResult.error ?? '整批失敗' }
    }

    await logRun(sb, runId, { status: 'imported', detail: { successCount: successIdx.length, failedInfo, skipped } })

    const updates: Array<{ row_key: string } & Record<string, unknown>> = []
    const noRowKey: string[] = []
    for (const i of successIdx) {
      const src = rows[i]
      const rowKey = str(src.row_key)
      if (!rowKey) { noRowKey.push(`${str(src.order_number)}/${str(src.item_code)}`); continue }
      updates.push({ row_key: rowKey, po_number: pid, po_sub_no: String(i + 1), po_status: 'matched', po_confirmed: true })
    }
    if (updates.length > 0) await patchSheetRows(sb, sheetDate, updates)

    if (noRowKey.length > 0) {
      await logRun(sb, runId, { detail: { successCount: successIdx.length, failedInfo, skipped, noRowKey, warning: '部分成功列缺 row_key 無法回寫，需人工確認後標記 resolved' } })
      return { runType: 'po', status: 'imported', docNo: pid, imported: successIdx.length, failed: failedInfo.length, skipped: skipped.length, message: `${noRowKey.length} 筆缺 row_key 無法回寫，需人工確認` }
    }

    await logRun(sb, runId, { status: 'written_back', detail: { successCount: successIdx.length, failedInfo, skipped } })
    return { runType: 'po', status: 'written_back', docNo: pid, imported: successIdx.length, failed: failedInfo.length, skipped: skipped.length }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const { data: cur } = await sb.from('argoerp_auto_doc_runs').select('status').eq('id', runId).single()
    if (cur?.status === 'started') await logRun(sb, runId, { status: 'failed', detail: { error: msg } })
    else await logRun(sb, runId, { detail: { error: msg } })
    return { runType: 'po', status: cur?.status === 'started' ? 'failed' : 'imported', message: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) { return run(request) }
export async function POST(request: NextRequest) { return run(request) }

async function run(request: NextRequest) {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const cronSecret = process.env.CRON_SECRET ?? ''
  const webhookSecret = process.env.WEBHOOK_SECRET ?? ''
  const authorized = !!bearer && ((!!cronSecret && bearer === cronSecret) || (!!webhookSecret && bearer === webhookSecret))
  if (!authorized) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  try {
    if (!argoConfigured()) {
      return NextResponse.json({ success: false, error: '未設定 ARGO 連線環境變數' }, { status: 500 })
    }
    const sb = getSupabaseAdminClient()

    // ── 防重複建單鎖：有任何未解決的 imported 紀錄就整個中止 ──
    const { data: stuck } = await sb
      .from('argoerp_auto_doc_runs')
      .select('id, run_type, sheet_date, doc_no, created_at')
      .eq('status', 'imported')
    if ((stuck ?? []).length > 0) {
      const detail = stuck!.map(s => `#${s.id} ${s.run_type} ${s.doc_no ?? '?'}（${s.sheet_date}）`).join('、')
      console.error(`[cron/auto-doc-creation] 中止：有未解決的 imported 紀錄（ARGO 已建單但回寫未完成），需人工確認後將 status 改為 resolved：${detail}`)
      return NextResponse.json({ success: false, aborted: true, error: `有未解決的 imported 紀錄，已中止自動轉單：${detail}` }, { status: 409 })
    }

    // 允許 ?date= 手動指定（補跑），預設台北今天
    const dateParam = request.nextUrl.searchParams.get('date')
    const sheetDate = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : taipeiTodayStr()

    const { data: sheet } = await sb
      .from('daily_order_sheets')
      .select('rows')
      .eq('sheet_date', sheetDate)
      .maybeSingle()
    if (!sheet) {
      return NextResponse.json({ success: true, sheetDate, message: '當天沒有出單表，跳過' })
    }
    const allRows = Array.isArray(sheet.rows) ? (sheet.rows as SheetRowRec[]) : []

    // 順序執行（PR 先、PO 後），彼此獨立記錄
    const prResult = await runPrCreation(sb, sheetDate, allRows)
    const poResult = await runPoCreation(sb, sheetDate, allRows)

    // 匯入後同步（涵蓋其他等待比對的列）——呼叫既有的內部同步 action
    const baseUrl =
      (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
      ?? process.env.NEXT_PUBLIC_BASE_URL
      ?? request.nextUrl.origin
    const syncErrors: string[] = []
    for (const action of ['sync_pr', 'sync_po'] as const) {
      try {
        const res = await fetch(`${baseUrl}/api/argoerp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': webhookSecret },
          body: JSON.stringify({ action }),
        })
        const j = await res.json().catch(() => ({})) as Record<string, unknown>
        if (!res.ok || j.status !== 'ok') syncErrors.push(`${action}: ${String(j.error ?? `HTTP ${res.status}`)}`)
      } catch (e) {
        syncErrors.push(`${action}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    const ok = prResult.status !== 'failed' && prResult.status !== 'imported'
      && poResult.status !== 'failed' && poResult.status !== 'imported'
    return NextResponse.json({
      success: ok,
      sheetDate,
      pr: prResult,
      po: poResult,
      syncErrors: syncErrors.length > 0 ? syncErrors : undefined,
    }, { status: ok ? 200 : 500 })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    console.error('[cron/auto-doc-creation] failed:', msg)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
