import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

const TABLE = 'order_anomaly_options'
const VALID_OPTION_TYPES = new Set(['category', 'department', 'person'])

// ============================================================
// GET：列出所有下拉選項（依 option_type, option_value 排序）
// ============================================================
export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .order('option_type')
      .order('option_value')

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, options: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// POST：新增一筆下拉選項
// body: { option_type: 'category' | 'department' | 'person', option_value: string }
// ============================================================
export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const optionType: string = body?.option_type
    const optionValue: string = typeof body?.option_value === 'string' ? body.option_value.trim() : ''

    if (!VALID_OPTION_TYPES.has(optionType)) {
      return NextResponse.json(
        { success: false, error: `option_type 必須是 category / department / person 之一，實際收到：${optionType}` },
        { status: 400 }
      )
    }
    if (!optionValue) {
      return NextResponse.json({ success: false, error: 'option_value 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase
      .from(TABLE)
      .insert({ option_type: optionType, option_value: optionValue })
      .select('*')
      .single()

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, option: data })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// DELETE：刪除一筆下拉選項（?id= 或 body 帶 { id }）
// ============================================================
export async function DELETE(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const url = new URL(request.url)
    let idRaw: string | null = url.searchParams.get('id')

    if (!idRaw) {
      try {
        const body = await request.json()
        idRaw = body?.id != null ? String(body.id) : null
      } catch {
        idRaw = null
      }
    }

    const id = idRaw ? Number(idRaw) : NaN
    if (!id || Number.isNaN(id)) {
      return NextResponse.json({ success: false, error: 'id 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).delete().eq('id', id)

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
