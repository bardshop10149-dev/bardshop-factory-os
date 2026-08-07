import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// GET ?codes=A,B,C    — 依料號精準查詢
// GET ?keyword=xxx    — 依關鍵字模糊查詢（item_code / item_name / spec）
export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const { searchParams } = new URL(request.url)
    const codes   = searchParams.get('codes')
    const keyword = searchParams.get('keyword')
    const supabase = getSupabaseAdminClient()

    if (codes) {
      const codeList = codes.split(',').map(c => c.trim()).filter(Boolean)
      const { data, error } = await supabase
        .from('material_inventory_list')
        .select('item_code, item_name, spec, unit_of_measure, physical_count, book_count, updated_at')
        .in('item_code', codeList)
      if (error) throw error
      return NextResponse.json({ success: true, rows: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
    }

    if (keyword) {
      const kw = keyword.trim()
      const { data, error } = await supabase
        .from('material_inventory_list')
        .select('item_code, item_name, spec, unit_of_measure, physical_count, book_count, updated_at')
        .or(`item_code.ilike.%${kw}%,item_name.ilike.%${kw}%,spec.ilike.%${kw}%`)
        .order('item_code', { ascending: true })
        .limit(50)
      if (error) throw error
      return NextResponse.json({ success: true, rows: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
    }

    return NextResponse.json({ success: false, error: '請提供 codes 或 keyword 參數' }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
