import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

const TABLE = 'production_notice_groups'

// 允許讀寫的欄位白名單（避免前端塞奇怪欄位）
const ALLOWED_FIELDS = [
  'name', 'sample_days', 'mass_days', 'summary', 'mass_qty_standard', 'order',
] as const

function pickAllowed(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of ALLOWED_FIELDS) {
    if (rec[k] !== undefined) out[k] = rec[k]
  }
  return out
}

// ============================================================
// GET：列出所有群組（依 id 排序，與原前端 .order("id") 行為一致）
// ============================================================
export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase.from(TABLE).select('*').order('id')

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, groups: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// POST：新增群組
// body: { name, sample_days, mass_days, summary, mass_qty_standard }
// ============================================================
export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const cleaned = pickAllowed(body ?? {})

    if (!cleaned.name) {
      return NextResponse.json({ success: false, error: 'name 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase.from(TABLE).insert([cleaned]).select()

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, groups: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// PUT / PATCH：更新單筆群組欄位
// body: { id, fields: Partial<Group> }
// 用途涵蓋：
//   - moveGroup 交換排序時逐筆更新 order 欄位
//   - 編輯群組（name/summary/sample_days/mass_days/mass_qty_standard）
// ============================================================
export async function PUT(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const id = body?.id
    const fields: Record<string, unknown> = body?.fields ?? {}

    if (id === undefined || id === null) {
      return NextResponse.json({ success: false, error: 'id 不可為空' }, { status: 400 })
    }

    const cleaned = pickAllowed(fields)
    if (Object.keys(cleaned).length === 0) {
      return NextResponse.json({ success: false, error: '沒有可更新的欄位' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase.from(TABLE).update(cleaned).eq('id', id).select()

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, groups: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

export const PATCH = PUT

// ============================================================
// DELETE：依 id 刪除群組
// body: { id }
// ============================================================
export async function DELETE(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const id = body?.id

    if (id === undefined || id === null) {
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
