import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'

const TABLE = 'argoerp_material_prep_log'

interface LogRow {
  mo_number: string
  factory?: string
  product_code?: string
  planned_qty?: string
  status: '已備料' | '無需備料'
  lines_count?: number
  interface_id?: string
  argo_slip_no?: string
}

// GET: 取得批備料上傳紀錄（最新在前，可用 ?mo_number= 篩選）
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
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
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
      argo_slip_no: r.argo_slip_no  ?? null,
    }))

    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).insert(insertRows)
    if (error) {
      // 23505 = unique_violation：argo_slip_no 已存在（見 sql/20260811_ng_prep_log_slip_unique.sql）
      // 通常代表另一個分頁/使用者已搶先用掉這個批備料單號（保留位機制），
      // 呼叫端（NG補印頁面）需視為「送出前的併發衝突」中止流程，不可視為一般錯誤忽略。
      const isDup = error.code === '23505' || /duplicate key|already exists/i.test(error.message)
      return NextResponse.json(
        {
          success: false,
          error: isDup
            ? `批備料單號重複，可能有人剛用相同單號送出：${error.message}`
            : formatSupabaseAdminError(error.message),
          duplicate: isDup,
        },
        { status: isDup ? 409 : 500 }
      )
    }

    return NextResponse.json({ success: true, inserted: insertRows.length })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// DELETE: 撤銷/釋放單筆批備料紀錄（保留位回滾用）
// body: { mo_number: string, argo_slip_no: string }
// 用途：NG補印頁面在寫入「保留位」記錄後，若後續呼叫 ARGO 匯入失敗，
// 需要釋放已保留的批備料單號，讓使用者可以重試（否則該單號會被永久佔用、
// 但 ARGO 那邊其實沒有真的匯入成功的資料）。
export async function DELETE(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const moNumber: string = body?.mo_number
    const argoSlipNo: string = body?.argo_slip_no

    if (!moNumber || !argoSlipNo) {
      return NextResponse.json({ success: false, error: 'mo_number 與 argo_slip_no 皆為必填' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { error, count } = await supabase
      .from(TABLE)
      .delete({ count: 'exact' })
      .eq('mo_number', moNumber)
      .eq('argo_slip_no', argoSlipNo)

    if (error) {
      return NextResponse.json({ success: false, error: formatSupabaseAdminError(error.message) }, { status: 500 })
    }

    return NextResponse.json({ success: true, deleted: count ?? 0 })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
