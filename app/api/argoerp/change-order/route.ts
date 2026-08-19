import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth, guardPermission } from '@/lib/requireAuth'
import {
  createRowKey,
  clearStaleDocsOnFactoryChange,
  type SheetRow,
} from '@/lib/argoerp/dailyOrderSheetShared'

export const dynamic = 'force-dynamic'

const SHEET_TABLE = 'daily_order_sheets'
// 跨日期掃描視窗——沿用 so-change-notices/page.tsx 既有前例（180 天），改單精靈需要找出
// 這張訂單這個序號在所有出現過的出單表日期上的列，沒有以 order_number narrow 查詢的伺服器端作法。
const SCAN_LIMIT = 200

type SheetRowRec = Record<string, unknown>

function rowLineId(row: SheetRowRec): string {
  const lineNoInput = typeof row.line_no_input === 'string' ? row.line_no_input : ''
  const matchLineNo = typeof row.match_line_no === 'string' ? row.match_line_no : ''
  return lineNoInput || matchLineNo || ''
}

// GET ?order_number=SOxxxx — 查詢單頭 + 各序號在所有出單表日期上的相關列
export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const { searchParams } = new URL(request.url)
    const orderNumber = (searchParams.get('order_number') ?? '').trim()
    if (!orderNumber) {
      return NextResponse.json({ success: false, error: '請提供 order_number' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()

    const { data: soLines, error: soErr } = await supabase
      .from('erp_so_lines')
      .select('project_id, begin_date, sales_name, partner_name, customer_remark, line_no, description, mbp_part, duedate, order_qty_oru, unit_of_measure_oru, remark, packing, remark2, hold_status')
      .eq('project_id', orderNumber)
      .order('line_no', { ascending: true })
    if (soErr) throw soErr

    const { data: sheets, error: sheetsErr } = await supabase
      .from(SHEET_TABLE)
      .select('sheet_date, rows')
      .order('sheet_date', { ascending: false })
      .limit(SCAN_LIMIT)
    if (sheetsErr) throw sheetsErr

    const sheetRowsByLine = new Map<string, Array<{ sheet_date: string; row: SheetRowRec }>>()
    const moNumbers = new Set<string>()
    for (const sheet of (sheets ?? []) as Array<{ sheet_date: string; rows: unknown }>) {
      const rowsArr = Array.isArray(sheet.rows) ? (sheet.rows as SheetRowRec[]) : []
      for (const row of rowsArr) {
        if (String(row.order_number ?? '').trim() !== orderNumber) continue
        const lineId = rowLineId(row)
        if (!lineId) continue
        const arr = sheetRowsByLine.get(lineId) ?? []
        arr.push({ sheet_date: sheet.sheet_date, row })
        sheetRowsByLine.set(lineId, arr)
        if (typeof row.mo_number === 'string' && row.mo_number) moNumbers.add(row.mo_number)
      }
    }

    let moSummary: Record<string, unknown>[] = []
    if (moNumbers.size > 0) {
      const { data } = await supabase
        .from('argoerp_mo_summary')
        .select('*')
        .in('mo_number', [...moNumbers])
      moSummary = data ?? []
    }

    const { data: changeNotices } = await supabase
      .from('so_change_notices')
      .select('*')
      .eq('project_id', orderNumber)
      .is('confirmed_at', null)

    return NextResponse.json({
      success: true,
      so_lines: soLines ?? [],
      sheet_rows_by_line: Object.fromEntries(sheetRowsByLine),
      mo_summary: moSummary,
      change_notices: changeNotices ?? [],
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// POST — 套用改單精靈的更正：找出這個序號在所有出單表日期上的列，套用更正、重算 row_key，
// 依 factory_changed 既有保護機制的方式把舊列的單據狀態帶到新列上，並寫入 order_change_log。
export async function POST(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as {
      order_number?: string
      line_no?: string
      changes?: {
        delivery_date?: string
        quantity?: string
        item_code?: string
        factory?: 'T' | 'C' | 'O'
      }
      note?: string
    }
    const orderNumber = (body.order_number ?? '').trim()
    const lineNo = (body.line_no ?? '').trim()
    const changes = body.changes ?? {}
    const changedFields = Object.keys(changes).filter(k => changes[k as keyof typeof changes] !== undefined)
    if (!orderNumber || !lineNo) {
      return NextResponse.json({ success: false, error: '請提供 order_number 及 line_no' }, { status: 400 })
    }
    if (changedFields.length === 0) {
      return NextResponse.json({ success: false, error: '請至少選擇一項要更正的欄位' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()

    const { data: sheets, error: sheetsErr } = await supabase
      .from(SHEET_TABLE)
      .select('sheet_date, rows')
      .order('sheet_date', { ascending: false })
      .limit(SCAN_LIMIT)
    if (sheetsErr) throw sheetsErr

    const affectedDates: string[] = []
    const beforeRows: Array<Record<string, unknown>> = []
    const afterRows: Array<Record<string, unknown>> = []
    let factoryChanged = false
    let anyMatched = false

    // 依序處理每一個受影響的日期，逐一寫回（避免單一巨大 transaction，且各日期本來就是獨立列）
    for (const sheet of (sheets ?? []) as Array<{ sheet_date: string; rows: unknown }>) {
      const rowsArr = Array.isArray(sheet.rows) ? (sheet.rows as SheetRowRec[]) : []
      let touched = false
      const newRows = rowsArr.map(row => {
        if (String(row.order_number ?? '').trim() !== orderNumber) return row
        if (rowLineId(row) !== lineNo) return row

        anyMatched = true
        touched = true
        const before = { ...row }
        let next: SheetRowRec = { ...row }

        if (changes.delivery_date !== undefined) next.delivery_date = changes.delivery_date
        if (changes.quantity !== undefined) next.quantity = changes.quantity
        if (changes.item_code !== undefined) next.item_code = changes.item_code
        if (changes.factory !== undefined && changes.factory !== row.factory) {
          next = { ...clearStaleDocsOnFactoryChange(next as unknown as SheetRow), factory: changes.factory } as unknown as SheetRowRec
          factoryChanged = true
        }

        next.row_key = createRowKey(next as unknown as Parameters<typeof createRowKey>[0])
        next.corrected = true

        beforeRows.push({ sheet_date: sheet.sheet_date, row_key: before.row_key, ...before })
        afterRows.push({ sheet_date: sheet.sheet_date, row_key: next.row_key, ...next })
        return next
      })

      if (!touched) continue
      affectedDates.push(sheet.sheet_date)

      const { error: updateErr } = await supabase
        .from(SHEET_TABLE)
        .update({
          rows: newRows,
          updated_at: new Date().toISOString(),
          updated_by: guard.member.email,
          updated_by_name: guard.member.realName ?? guard.member.email,
          last_action: 'change_order',
        })
        .eq('sheet_date', sheet.sheet_date)
      if (updateErr) throw updateErr
    }

    if (!anyMatched) {
      return NextResponse.json({ success: false, error: '找不到這張訂單這個序號的出單表資料' }, { status: 404 })
    }

    const { data: logRow, error: logErr } = await supabase
      .from('order_change_log')
      .insert({
        order_number: orderNumber,
        line_no: lineNo,
        changed_fields: changedFields,
        old_values: { rows: beforeRows },
        new_values: { rows: afterRows },
        affected_sheet_dates: affectedDates,
        factory_changed: factoryChanged,
        redocumented: false,
        sara_synced: false,
        changed_by: guard.member.realName ?? guard.member.email,
        changed_by_email: guard.member.email,
        note: body.note ?? null,
      })
      .select('id')
      .single()
    if (logErr) throw logErr

    return NextResponse.json({
      success: true,
      log_id: logRow?.id ?? null,
      affected_sheet_dates: affectedDates,
      updated_rows: afterRows,
      needs_redocument: factoryChanged,
    })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// PATCH — 標記某筆改單紀錄已完成重新轉單／已同步至 SARA
// Body: { log_id: number, redocumented?: boolean, sara_synced?: boolean }
export async function PATCH(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as { log_id?: number; redocumented?: boolean; sara_synced?: boolean }
    if (!body.log_id) {
      return NextResponse.json({ success: false, error: '請提供 log_id' }, { status: 400 })
    }
    const patch: Record<string, boolean> = {}
    if (body.redocumented !== undefined) patch.redocumented = body.redocumented
    if (body.sara_synced !== undefined) patch.sara_synced = body.sara_synced
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ success: false, error: '沒有要更新的欄位' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from('order_change_log').update(patch).eq('id', body.log_id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
