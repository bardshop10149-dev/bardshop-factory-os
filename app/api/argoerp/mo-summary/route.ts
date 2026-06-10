import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// 與前端 MoRecord 介面對齊
interface MoRecord {
  mo_number: string
  factory: string
  planned_start_date?: string
  planned_end_date?: string
  mo_status?: string
  department?: string
  product_code?: string
  lot_number?: string
  planned_qty?: string
  source_order?: string
  mo_note?: string
  create_date?: string
  saved_at?: string
  prep_status?: '未備料' | '已備料' | '無需備料'
}

const TABLE = 'argoerp_mo_summary'

// 允許寫入的欄位白名單（避免前端塞奇怪欄位）
const ALLOWED_FIELDS = [
  'mo_number', 'factory',
  'planned_start_date', 'planned_end_date', 'mo_status',
  'department', 'product_code', 'lot_number', 'planned_qty',
  'source_order', 'mo_note', 'create_date', 'saved_at',
  'prep_status', 'plate_count', 'machine',
] as const

function pickAllowed(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ALLOWED_FIELDS) {
    if (rec[k] !== undefined) out[k] = rec[k]
  }
  return out
}

// ============================================================
// GET：列出所有製令；可用 ?date=YYYYMMDD&factory=T 篩選
// ============================================================
export async function GET(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const url = new URL(request.url)
    const date = url.searchParams.get('date')        // 例: 20260422
    const factory = url.searchParams.get('factory')  // 例: T / C / O
    const prepStatus = url.searchParams.get('prep_status')  // 未備料 / 已備料 / 無需備料

    const supabase = getSupabaseAdminClient()
    let query = supabase.from(TABLE).select('*').order('created_at', { ascending: false })

    if (factory) query = query.eq('factory', factory)
    if (date) query = query.eq('create_date', date)
    if (prepStatus) query = query.eq('prep_status', prepStatus)

    const { data, error } = await query

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, records: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// POST：批次寫入製令
// body: { records: MoRecord[] }
// ?mode=upsert  → 衝突時覆蓋（直接轉入總表用）
// 預設（無參數）→ INSERT，mo_number 已存在則報錯（不覆蓋）
// ============================================================
export async function POST(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const url = new URL(request.url)
    const isUpsert = url.searchParams.get('mode') === 'upsert'

    const body = await request.json()
    const records: MoRecord[] = Array.isArray(body?.records) ? body.records : []

    if (records.length === 0) {
      return NextResponse.json({ success: false, error: 'records 不可為空' }, { status: 400 })
    }

    // 驗證每筆都有必要欄位
    for (const r of records) {
      if (!r?.mo_number || !r?.factory) {
        return NextResponse.json(
          { success: false, error: `記錄缺少 mo_number 或 factory: ${JSON.stringify(r)}` },
          { status: 400 }
        )
      }
    }

    const cleaned = records.map(r => pickAllowed(r as unknown as Record<string, unknown>))

    const supabase = getSupabaseAdminClient()

    if (isUpsert) {
      // 直接轉入模式：已存在則覆蓋（跳過 ARGO 重新上傳）
      const { data, error } = await supabase
        .from(TABLE)
        .upsert(cleaned, { onConflict: 'mo_number', ignoreDuplicates: false })
        .select('mo_number')

      if (error) {
        return NextResponse.json(
          { success: false, error: formatSupabaseAdminError(error.message) },
          { status: 500 }
        )
      }

      return NextResponse.json({ success: true, upserted: data?.length ?? 0 })
    }

    const { data, error } = await supabase
      .from(TABLE)
      .insert(cleaned)
      .select('mo_number')

    if (error) {
      // 23505 = unique_violation：表示有重複的 mo_number
      const isDup = error.code === '23505' || /duplicate key|already exists/i.test(error.message)
      return NextResponse.json(
        {
          success: false,
          error: isDup
            ? `製令單號重複，可能有人同時操作或本地流水號未同步：${error.message}`
            : formatSupabaseAdminError(error.message),
          duplicate: isDup,
        },
        { status: isDup ? 409 : 500 }
      )
    }

    return NextResponse.json({ success: true, inserted: data?.length ?? 0 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// DELETE：依 mo_number 列表批次刪除
// body: { mo_numbers: string[] }
// ============================================================
export async function DELETE(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const moNumbers: string[] = Array.isArray(body?.mo_numbers) ? body.mo_numbers : []

    if (moNumbers.length === 0) {
      return NextResponse.json({ success: false, error: 'mo_numbers 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { error, count } = await supabase
      .from(TABLE)
      .delete({ count: 'exact' })
      .in('mo_number', moNumbers)

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, deleted: count ?? 0 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// PATCH：批次更新製令的 prep_status
// body: { mo_numbers: string[], prep_status: '未備料' | '已備料' | '無需備料' }
// ============================================================
const VALID_PREP_STATUS = new Set(['未備料', '已備料', '無需備料'])

export async function PATCH(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const moNumbers: string[] = Array.isArray(body?.mo_numbers) ? body.mo_numbers : []
    const prepStatus: string = body?.prep_status

    if (moNumbers.length === 0) {
      return NextResponse.json({ success: false, error: 'mo_numbers 不可為空' }, { status: 400 })
    }
    if (!VALID_PREP_STATUS.has(prepStatus)) {
      return NextResponse.json(
        { success: false, error: `prep_status 必須是 未備料 / 已備料 / 無需備料 之一，實際收到：${prepStatus}` },
        { status: 400 }
      )
    }

    const supabase = getSupabaseAdminClient()
    const { error, count } = await supabase
      .from(TABLE)
      .update({ prep_status: prepStatus }, { count: 'exact' })
      .in('mo_number', moNumbers)

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, updated: count ?? 0 })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// PUT：更新單筆製令的可編輯欄位
// body: { mo_number: string, fields: Partial<MoRecord> }
// ============================================================
export async function PUT(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const moNumber: string = body?.mo_number
    const fields: Record<string, unknown> = body?.fields ?? {}

    if (!moNumber) {
      return NextResponse.json({ success: false, error: 'mo_number 不可為空' }, { status: 400 })
    }

    const cleaned = pickAllowed(fields)
    // mo_number 不允許被更新
    delete cleaned.mo_number

    if (Object.keys(cleaned).length === 0) {
      return NextResponse.json({ success: false, error: '沒有可更新的欄位' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { error } = await supabase
      .from(TABLE)
      .update(cleaned)
      .eq('mo_number', moNumber)

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
