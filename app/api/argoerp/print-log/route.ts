import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'

const TABLE = 'argoerp_mo_print_log'

// GET: 取得所有列印紀錄（可選 ?mo_number= 篩選）
export async function GET(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const mo = new URL(request.url).searchParams.get('mo_number')
    const supabase = getSupabaseAdminClient()
    let query = supabase.from(TABLE).select('id, mo_number, printed_at').order('printed_at', { ascending: true })
    if (mo) query = query.eq('mo_number', mo)

    const { data, error } = await query
    if (error) throw error
    return NextResponse.json({ success: true, logs: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// POST: 新增列印紀錄 { mo_numbers: string[] }
export async function POST(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const { mo_numbers } = await request.json() as { mo_numbers?: string[] }
    if (!Array.isArray(mo_numbers) || mo_numbers.length === 0) {
      return NextResponse.json({ success: false, error: 'mo_numbers 不可為空' }, { status: 400 })
    }
    const now = new Date().toISOString()
    const rows = mo_numbers.map(mo => ({ mo_number: mo, printed_at: now }))
    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase.from(TABLE).insert(rows).select('id, mo_number, printed_at')
    if (error) throw error
    return NextResponse.json({ success: true, inserted: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// DELETE: 清除紀錄 { mo_number: string } → 清除該製令全部紀錄
export async function DELETE(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const { mo_number } = await request.json() as { mo_number?: string }
    if (!mo_number?.trim()) {
      return NextResponse.json({ success: false, error: 'mo_number 不可為空' }, { status: 400 })
    }
    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).delete().eq('mo_number', mo_number.trim())
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
