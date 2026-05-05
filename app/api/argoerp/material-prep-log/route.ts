import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'

const TABLE = 'argoerp_material_prep_log'

interface LogRow {
  mo_number: string
  factory?: string
  product_code?: string
  planned_qty?: string
  status: '已備料' | '無需備料'
  lines_count?: number
  interface_id?: string
}

// GET: 取得批備料上傳紀錄（最新在前，可用 ?mo_number= 篩選）
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const moNumber = searchParams.get('mo_number')

    const supabase = getSupabaseAdminClient()
    let query = supabase
      .from(TABLE)
      .select('*')
      .order('logged_at', { ascending: false })
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

// POST: 批次新增批備料紀錄 { rows: LogRow[] }
export async function POST(request: NextRequest) {
  try {
    const { rows } = await request.json() as { rows?: LogRow[] }
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json({ success: false, error: '未提供紀錄資料' }, { status: 400 })
    }

    const VALID_STATUSES = new Set(['已備料', '無需備料'])
    for (const r of rows) {
      if (!r.mo_number) {
        return NextResponse.json({ success: false, error: '每筆紀錄必須包含 mo_number' }, { status: 400 })
      }
      if (!VALID_STATUSES.has(r.status)) {
        return NextResponse.json({ success: false, error: `狀態值無效：${r.status}` }, { status: 400 })
      }
    }

    const insertRows = rows.map(r => ({
      mo_number:    r.mo_number,
      factory:      r.factory       ?? null,
      product_code: r.product_code  ?? null,
      planned_qty:  r.planned_qty   ?? null,
      status:       r.status,
      lines_count:  r.lines_count   ?? 0,
      interface_id: r.interface_id  ?? null,
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
