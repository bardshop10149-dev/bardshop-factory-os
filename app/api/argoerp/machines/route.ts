import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'

const TABLE = 'argoerp_machines'

// GET: 取得機台清單（依 sort_order, id 排序）
export async function GET() {
  try {
    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase
      .from(TABLE)
      .select('id, name, sort_order')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true })

    if (error) throw error
    return NextResponse.json({ success: true, machines: data ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// POST: 新增機台 { name: string }
export async function POST(request: NextRequest) {
  try {
    const { name } = await request.json() as { name?: string }
    if (!name?.trim()) {
      return NextResponse.json({ success: false, error: '機台名稱不可為空' }, { status: 400 })
    }
    const supabase = getSupabaseAdminClient()
    const { data, error } = await supabase
      .from(TABLE)
      .insert({ name: name.trim() })
      .select('id, name, sort_order')
      .single()

    if (error) {
      const isDup = error.code === '23505'
      return NextResponse.json(
        { success: false, error: isDup ? '機台名稱已存在' : formatSupabaseAdminError(error.message) },
        { status: isDup ? 409 : 500 }
      )
    }
    return NextResponse.json({ success: true, machine: data })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// DELETE: 刪除機台 { name: string }
export async function DELETE(request: NextRequest) {
  try {
    const { name } = await request.json() as { name?: string }
    if (!name?.trim()) {
      return NextResponse.json({ success: false, error: '機台名稱不可為空' }, { status: 400 })
    }
    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).delete().eq('name', name.trim())
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// PATCH: 重新命名機台 { old_name: string, new_name: string }
export async function PATCH(request: NextRequest) {
  try {
    const { old_name, new_name } = await request.json() as { old_name?: string; new_name?: string }
    if (!old_name?.trim() || !new_name?.trim()) {
      return NextResponse.json({ success: false, error: '機台名稱不可為空' }, { status: 400 })
    }
    const supabase = getSupabaseAdminClient()
    const { error } = await supabase.from(TABLE).update({ name: new_name.trim() }).eq('name', old_name.trim())
    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
