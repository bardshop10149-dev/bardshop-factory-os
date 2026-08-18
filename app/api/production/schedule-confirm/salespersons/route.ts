import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

const TABLE = 'schedule_inquiry_salespersons'

// ============================================================
// GET：列出所有業務人員（依姓名排序）
// ============================================================
export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase
      .from(TABLE)
      .select('name')
      .order('name', { ascending: true })

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    const salespersons = (data ?? []).map((r: { name: string }) => r.name)
    return NextResponse.json({ success: true, salespersons })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// POST：新增一位業務人員
// body: { name: string }
// ============================================================
export async function POST(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const name = typeof body?.name === 'string' ? body.name.trim() : ''

    if (!name) {
      return NextResponse.json({ success: false, error: 'name 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).insert({ name })

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

// ============================================================
// DELETE：依姓名刪除一位業務人員（?name= 或 body 帶 { name }）
// ============================================================
export async function DELETE(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const url = new URL(request.url)
    let name: string | null = url.searchParams.get('name')

    if (!name) {
      try {
        const body = await request.json()
        name = typeof body?.name === 'string' ? body.name : null
      } catch {
        name = null
      }
    }

    if (!name) {
      return NextResponse.json({ success: false, error: 'name 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).delete().eq('name', name)

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
