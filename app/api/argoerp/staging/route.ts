import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'

export const dynamic = 'force-dynamic'

const TABLE = 'argoerp_staging'

const ALLOWED = [
  'order_number', 'doc_type', 'factory', 'receiver', 'is_sample', 'has_material',
  'designer', 'customer', 'line_nickname', 'handler', 'issuer',
  'item_code', 'item_name', 'note', 'quantity', 'delivery_date',
  'plate_count', 'upload_ro', 'order_status', 'pm_note', 'hold_reason', 'staged_at',
] as const

// GET: 取得所有暫緩訂單（依 staged_at 升冪）
export async function GET() {
  try {
    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('staged_at', { ascending: true })
    if (error) throw error
    return NextResponse.json({ success: true, rows: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// POST: 新增暫緩訂單 { rows: StagingRow[] }
export async function POST(request: NextRequest) {
  try {
    const { rows } = await request.json() as { rows?: Record<string, unknown>[] }
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ success: false, error: 'rows 不可為空' }, { status: 400 })
    }
    const now = new Date().toISOString()
    const cleaned = rows.map(row => {
      const out: Record<string, unknown> = { staged_at: now, hold_reason: '' }
      for (const k of ALLOWED) {
        if (row[k] !== undefined) out[k] = row[k]
      }
      return out
    })
    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase.from(TABLE).insert(cleaned).select('id')
    if (error) throw error
    return NextResponse.json({ success: true, inserted: data?.length ?? 0 })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// DELETE: 刪除 { ids: number[] }
export async function DELETE(request: NextRequest) {
  try {
    const { ids } = await request.json() as { ids?: number[] }
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ success: false, error: 'ids 不可為空' }, { status: 400 })
    }
    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).delete().in('id', ids)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// PATCH: 更新暫緩原因 { id: number, hold_reason: string }
export async function PATCH(request: NextRequest) {
  try {
    const { id, hold_reason } = await request.json() as { id?: number; hold_reason?: string }
    if (typeof id !== 'number') {
      return NextResponse.json({ success: false, error: 'id 不可為空' }, { status: 400 })
    }
    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).update({ hold_reason: hold_reason ?? '' }).eq('id', id)
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
