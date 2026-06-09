import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

const TABLE = 'daily_order_sheets'

// GET:
//   無 date 參數 → 回傳所有已儲存日期 ([{sheet_date, row_count, updated_at}])
//   有 date=YYYY-MM-DD → 回傳該日出單表（含 rows）
export async function GET(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date')
    const supabase = getSupabaseAdminClient()

    const search = searchParams.get('search')

    // ?search=<query> — 跨日期單號搜尋（不需 date 參數）
    if (!date && search) {
      const q = search.trim().toLowerCase()
      const { data, error } = await supabase
        .from(TABLE)
        .select('sheet_date, rows')
        .order('sheet_date', { ascending: false })
      if (error) throw error
      const results: { sheet_date: string; rows: Record<string, unknown>[] }[] = []
      for (const sheet of (data ?? [])) {
        const rowsArr = Array.isArray(sheet.rows) ? (sheet.rows as Array<Record<string, unknown>>) : []
        const matched = rowsArr.filter(r => {
          const on = typeof r.order_number === 'string' ? r.order_number.toLowerCase() : ''
          const mo = typeof r.mo_number === 'string' ? r.mo_number.toLowerCase() : ''
          return on.includes(q) || mo.includes(q)
        })
        if (matched.length > 0) results.push({ sheet_date: sheet.sheet_date, rows: matched })
      }
      return NextResponse.json({ success: true, results })
    }

    if (!date) {
      const { data, error } = await supabase
        .from(TABLE)
        .select('sheet_date, rows, updated_at')
        .order('sheet_date', { ascending: false })
      if (error) throw error
      const DONE_STATES = new Set(['已備料', '無需備料', '已批備料'])
      const list = (data ?? []).map((r: { sheet_date: string; rows: unknown[]; updated_at: string }) => {
        const rowsArr = Array.isArray(r.rows) ? (r.rows as Array<Record<string, unknown>>) : []
        const pendingMos = new Set<string>()
        for (const row of rowsArr) {
          if (row.mo_status !== '已匯入製令') continue
          const mo = typeof row.mo_number === 'string' ? row.mo_number : ''
          if (!mo) continue
          const status = typeof row.material_prep_status === 'string' ? row.material_prep_status : ''
          if (DONE_STATES.has(status)) continue
          pendingMos.add(mo)
        }
        return {
          sheet_date: r.sheet_date,
          row_count: rowsArr.length,
          pending_count: pendingMos.size,
          updated_at: r.updated_at,
        }
      })
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
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
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

// PATCH: 更新特定列的狀態（mo_status / mo_number / 序號比對 / 批備料）
// Body: { sheet_date: 'YYYY-MM-DD', updates: [{ row_key, mo_status?, mo_number?, match_status?, match_line_no?, match_pdl_seq?, match_reason?, material_prep_status? }] }
export async function PATCH(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as {
      sheet_date?: string
      updates?: Array<{
        row_key: string
        mo_status?: string
        mo_number?: string
        pr_number?: string | null
        match_status?: string | null
        match_line_no?: string | null
        match_pdl_seq?: number | null
        match_reason?: string | null
        material_prep_status?: string | null
        argo_slip_no?: string | null
        po_number?: string | null
        po_status?: string | null
      }>
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
      const merged = { ...row }
      // 只覆寫 updates 裡明確帶入的欄位
      if (upd.mo_status !== undefined) merged.mo_status = upd.mo_status
      if (upd.mo_number !== undefined) merged.mo_number = upd.mo_number
      if (upd.pr_number !== undefined) merged.pr_number = upd.pr_number
      if (upd.match_status !== undefined) merged.match_status = upd.match_status
      if (upd.match_line_no !== undefined) merged.match_line_no = upd.match_line_no
      if (upd.match_pdl_seq !== undefined) merged.match_pdl_seq = upd.match_pdl_seq
      if (upd.match_reason !== undefined) merged.match_reason = upd.match_reason
      if (upd.material_prep_status !== undefined) merged.material_prep_status = upd.material_prep_status
      if (upd.argo_slip_no !== undefined) merged.argo_slip_no = upd.argo_slip_no
      if (upd.po_number !== undefined) merged.po_number = upd.po_number
      if (upd.po_status !== undefined) merged.po_status = upd.po_status
      if ((upd as Record<string, unknown>).machine !== undefined) merged.machine = (upd as Record<string, unknown>).machine
      return merged
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
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
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
