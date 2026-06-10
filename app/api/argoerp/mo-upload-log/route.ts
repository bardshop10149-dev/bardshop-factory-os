import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'

const TABLE = 'argoerp_mo_upload_log'

interface LogRow {
  mo_number: string
  factory?: string
  product_code?: string
  planned_qty?: string
  source_order?: string
  lot_number?: string
  mo_note?: string
  planned_start_date?: string
  planned_end_date?: string
  create_date?: string
  interface_id?: string
}

// GET: 取得製令上傳紀錄（最新在前，可用 ?mo_number= 篩選單筆）
export async function GET(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const { searchParams } = new URL(request.url)
    const moNumber = searchParams.get('mo_number')

    const supabase = getSupabaseAdminClient()
    let query = supabase
      .from(TABLE)
      .select('*')
      .order('uploaded_at', { ascending: false })
      .limit(500)

    if (moNumber) {
      query = query.eq('mo_number', moNumber)
    }

    const { data, error } = await query
    if (error) throw error
    return NextResponse.json({ success: true, rows: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// POST: 批次新增製令上傳紀錄 { rows: LogRow[] }
export async function POST(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const { rows } = await request.json() as { rows?: LogRow[] }
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ success: false, error: '未提供紀錄資料' }, { status: 400 })
    }

    const insertRows = rows.map(r => ({
      mo_number:          r.mo_number,
      factory:            r.factory            ?? 'T',
      product_code:       r.product_code        ?? null,
      planned_qty:        r.planned_qty         ?? null,
      source_order:       r.source_order        ?? null,
      lot_number:         r.lot_number          ?? null,
      mo_note:            r.mo_note             ?? null,
      planned_start_date: r.planned_start_date  ?? null,
      planned_end_date:   r.planned_end_date    ?? null,
      create_date:        r.create_date         ?? null,
      interface_id:       r.interface_id        ?? null,
    }))

    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).insert(insertRows)
    if (error) throw error

    return NextResponse.json({ success: true, inserted: insertRows.length })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
