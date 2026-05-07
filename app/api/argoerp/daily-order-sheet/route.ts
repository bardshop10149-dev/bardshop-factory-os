import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'

export const dynamic = 'force-dynamic'

const TABLE = 'daily_order_sheets'

// GET:
//   無 date 參數 → 回傳所有已儲存日期 ([{sheet_date, row_count, updated_at}])
//   有 date=YYYY-MM-DD → 回傳該日出單表（含 rows）
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date')
    const supabase = getSupabaseAdminClient()

    if (!date) {
      const { data, error } = await supabase
        .from(TABLE)
        .select('sheet_date, rows, updated_at')
        .order('sheet_date', { ascending: false })
      if (error) throw error
      const list = (data ?? []).map((r: { sheet_date: string; rows: unknown[]; updated_at: string }) => ({
        sheet_date: r.sheet_date,
        row_count: Array.isArray(r.rows) ? r.rows.length : 0,
        updated_at: r.updated_at,
      }))
      return NextResponse.json({ success: true, sheets: list })
    }

    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('sheet_date', date)
      .single()
    if (error && error.code === 'PGRST116') {
      // not found
      return NextResponse.json({ success: true, sheet: null })
    }
    if (error) throw error
    return NextResponse.json({ success: true, sheet: data })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// POST: 新增或完整取代一天的出單表
// Body: { sheet_date: 'YYYY-MM-DD', raw_text: string, rows: SheetRow[] }
export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as {
      sheet_date?: string
      raw_text?: string
      rows?: unknown[]
    }
    const { sheet_date, raw_text = '', rows = [] } = body
    if (!sheet_date || !/^\d{4}-\d{2}-\d{2}$/.test(sheet_date)) {
      return NextResponse.json({ success: false, error: '請提供有效的 sheet_date (YYYY-MM-DD)' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase
      .from(TABLE)
      .upsert({ sheet_date, raw_text, rows, updated_at: new Date().toISOString() }, { onConflict: 'sheet_date' })
      .select()
      .single()
    if (error) throw error
    return NextResponse.json({ success: true, sheet: data })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// PATCH: 更新特定列的 mo_status（由訂單批量轉製令頁面呼叫）
// Body: { sheet_date: 'YYYY-MM-DD', updates: { row_key: string, mo_status: string }[] }
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json() as {
      sheet_date?: string
      updates?: { row_key: string; mo_status: string; mo_number?: string }[]
    }
    const { sheet_date, updates } = body
    if (!sheet_date || !Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json({ success: false, error: '請提供 sheet_date 及 updates' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()

    // 讀取目前的 rows
    const { data: existing, error: fetchError } = await supabase
      .from(TABLE)
      .select('rows')
      .eq('sheet_date', sheet_date)
      .single()
    if (fetchError && fetchError.code === 'PGRST116') {
      return NextResponse.json({ success: false, error: '找不到指定日期的出單表' }, { status: 404 })
    }
    if (fetchError) throw fetchError

    const updateMap = new Map(updates.map(u => [u.row_key, u]))
    const currentRows = Array.isArray(existing.rows) ? existing.rows as Record<string, unknown>[] : []
    const updatedRows = currentRows.map(row => {
      const upd = updateMap.get(row.row_key as string)
      if (!upd) return row
      return { ...row, mo_status: upd.mo_status, ...(upd.mo_number ? { mo_number: upd.mo_number } : {}) }
    })

    const { error: updateError } = await supabase
      .from(TABLE)
      .update({ rows: updatedRows, updated_at: new Date().toISOString() })
      .eq('sheet_date', sheet_date)
    if (updateError) throw updateError

    return NextResponse.json({ success: true, updated: updates.length })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// DELETE: 刪除指定日期的出單表
// Query: ?date=YYYY-MM-DD
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date')
    if (!date) return NextResponse.json({ success: false, error: '請提供 date 參數' }, { status: 400 })

    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).delete().eq('sheet_date', date)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
