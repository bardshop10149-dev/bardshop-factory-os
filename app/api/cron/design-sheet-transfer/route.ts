import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import {
  createRowKey, detectFactory, computeFactoryAlert, computeDueDateAlert,
  mergeIncomingRowsWithExisting, computeSheetCounts, DUE_THRESHOLD_DEFAULTS,
  type SourceRow, type SheetRow, type MatchStatus,
} from '@/lib/argoerp/dailyOrderSheetShared'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 每天 16:00 台北時間：把美編天地當天的「每日出單表」(design_daily_sheets) 轉入生管的
// 每日出單表 (daily_order_sheets)。16:00 之後美編新增資料一律鎖定進隔天（見
// /api/design/daily-sheet 的 autoTargetDate），所以 16:00 這個時間點轉今天的資料是安全的
// ——不會有還在增加中的資料被漏轉。
//
// 轉入方式：把美編列轉成跟「貼上 Excel 後解析出的第一版 SheetRow」完全一致的初始狀態
// （row_key／序號直填則預填比對成功／交期與廠區警示），與當天既有的 daily_order_sheets
// 列（若生管當天也手動貼過）做聯集後整批覆蓋——聯集而非取代，避免洗掉生管手動補的資料；
// 同單號同序號重複時以美編列為準，並透過 mergeIncomingRowsWithExisting 把舊列已有的
// 製令/採購/請購單號、備料狀態、機台等外部狀態帶過去，不會因為重新轉入而消失。
//
// 已知範圍限制（v1）：不做「重複發單」跨日期偵測（duplicate_alert 一律 false）——
// 這項檢查目前只在人工貼上時的 handleParse 觸發，之後如需要可比照 dup_index 查詢補上。

const TABLE_DESIGN = 'design_daily_sheets'
const TABLE_PROD = 'daily_order_sheets'
const SOURCE_ROW_FIELDS: (keyof SourceRow)[] = [
  'order_number', 'line_no_input', 'doc_type', 'receiver', 'is_sample', 'has_material',
  'designer', 'customer', 'line_nickname', 'handler', 'issuer', 'item_code', 'item_name',
  'note', 'packing', 'quantity', 'delivery_date', 'plate_count', 'upload_ro', 'order_status',
  'pm_note', 'assigned_machine',
]

function taipeiTodayStr(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function toSourceRow(raw: Record<string, unknown>): SourceRow {
  const out: Record<string, unknown> = {}
  for (const f of SOURCE_ROW_FIELDS) {
    const v = raw[f]
    out[f] = typeof v === 'string' ? v : (v == null ? '' : String(v))
  }
  out.factory = detectFactory(String(out.doc_type ?? ''))
  return out as unknown as SourceRow
}

export async function GET(request: NextRequest) { return run(request) }
export async function POST(request: NextRequest) { return run(request) }

async function run(request: NextRequest) {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const cronSecret = process.env.CRON_SECRET ?? ''
  const webhookSecret = process.env.WEBHOOK_SECRET ?? ''
  const authorized = !!bearer && ((!!cronSecret && bearer === cronSecret) || (!!webhookSecret && bearer === webhookSecret))
  if (!authorized) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const dateParam = request.nextUrl.searchParams.get('date')
    const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : taipeiTodayStr()

    const sb = getSupabaseAdminClient()

    const { data: designSheet, error: designErr } = await sb
      .from(TABLE_DESIGN).select('rows').eq('sheet_date', date).maybeSingle()
    if (designErr) throw new Error(designErr.message)
    const designRows = Array.isArray(designSheet?.rows) ? designSheet!.rows as Record<string, unknown>[] : []
    if (designRows.length === 0) {
      return NextResponse.json({ success: true, date, transferred: 0, reason: '美編出單表當日無資料，不轉入' })
    }

    const { data: thresholdSetting } = await sb
      .from('app_settings').select('value').eq('key', 'due_date_thresholds').maybeSingle()
    const thresholds = (thresholdSetting?.value && typeof thresholdSetting.value === 'object')
      ? thresholdSetting.value as Record<string, number>
      : DUE_THRESHOLD_DEFAULTS
    const sheetDateObj = new Date(date)
    sheetDateObj.setHours(0, 0, 0, 0)

    // 轉成生管出單表的初始 SheetRow 狀態（比照人工貼上解析後的第一版）
    const transferredRows: SheetRow[] = designRows.map(raw => {
      const src = toSourceRow(raw)
      const base: SheetRow = {
        ...src,
        row_key: createRowKey(src),
        mo_status: null,
        due_date_alert: computeDueDateAlert(src, sheetDateObj, thresholds),
        due_date_alert_dismissed: false,
        factory_alert: computeFactoryAlert(src),
        factory_alert_dismissed: false,
        duplicate_alert: false,
        duplicate_alert_dismissed: false,
      }
      if (src.line_no_input) {
        base.match_line_no = src.line_no_input
        base.match_status = 'matched' as MatchStatus
        base.match_reason = '美編出單表直接填入'
      }
      return base
    })

    // 與生管當天既有列做聯集：同訂單號+序號時以美編轉入列為準（但透過
    // mergeIncomingRowsWithExisting 保留舊列的製令/採購/備料等外部狀態）；
    // 既有列若訂單號+序號不在本次轉入清單中，原樣保留（不因轉入而消失）。
    const { data: prodSheet, error: prodErr } = await sb
      .from(TABLE_PROD).select('rows').eq('sheet_date', date).maybeSingle()
    if (prodErr) throw new Error(prodErr.message)
    const existingRows = Array.isArray(prodSheet?.rows) ? prodSheet!.rows as Record<string, unknown>[] : []

    const transferredKeySet = new Set(
      transferredRows.map(r => `${r.order_number}|${r.line_no_input || r.match_line_no || ''}`)
    )
    const keptExisting = existingRows.filter(r => {
      const orderNo = typeof r.order_number === 'string' ? r.order_number : ''
      const seq = typeof r.line_no_input === 'string' && r.line_no_input
        ? r.line_no_input
        : (typeof r.match_line_no === 'string' ? r.match_line_no : '')
      return !transferredKeySet.has(`${orderNo}|${seq}`)
    })

    const incoming = [...keptExisting, ...(transferredRows as unknown as Record<string, unknown>[])]
    const mergedRows = mergeIncomingRowsWithExisting(existingRows, incoming)

    const rawTextLine = (r: SheetRow) => SOURCE_ROW_FIELDS.map(f => String((r as unknown as Record<string, unknown>)[f] ?? '')).join('\t')
    const rawText = transferredRows.map(rawTextLine).join('\n')

    const { error: upErr } = await sb.from(TABLE_PROD).upsert({
      sheet_date: date,
      raw_text: rawText,
      rows: mergedRows,
      ...computeSheetCounts(mergedRows),
      updated_at: new Date().toISOString(),
      updated_by: 'system',
      updated_by_name: '美編出單表自動轉入',
      last_action: 'design_transfer',
    }, { onConflict: 'sheet_date' })
    if (upErr) throw new Error(upErr.message)

    await sb.from(TABLE_DESIGN).update({ transferred_at: new Date().toISOString() }).eq('sheet_date', date)

    return NextResponse.json({
      success: true, date,
      transferred: transferredRows.length,
      keptExisting: keptExisting.length,
      totalRows: mergedRows.length,
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
