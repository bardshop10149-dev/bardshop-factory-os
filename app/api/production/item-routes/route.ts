import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth, guardPermission } from '@/lib/requireAuth'

// 工序總表（品項關聯）單筆新增——供「工序/BOM補登表」頁面補登用。
// 既有的 /admin/upload 是整批覆蓋式匯入（清空重寫），這支只新增單筆，不影響既有資料。

export const dynamic = 'force-dynamic'

// GET — 回傳既有 route_id 清單（含每個 route 的工序數，方便判斷是否為空殼途程），供路徑挑選用
export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const sb = getSupabaseAdminClient()
    const { data, error } = await sb.from('route_operations').select('route_id')
    if (error) throw error
    const counts = new Map<string, number>()
    for (const r of data ?? []) counts.set(r.route_id, (counts.get(r.route_id) ?? 0) + 1)
    const routes = [...counts.entries()].map(([route_id, op_count]) => ({ route_id, op_count })).sort((a, b) => a.route_id.localeCompare(b.route_id))
    return NextResponse.json({ success: true, routes }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// POST { item_code, item_name?, route_id } — 新增一筆品項↔途程對應
export async function POST(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as { item_code?: string; item_name?: string; route_id?: string }
    const itemCode = (body.item_code ?? '').trim()
    const routeId = (body.route_id ?? '').trim()
    if (!itemCode || !routeId) {
      return NextResponse.json({ success: false, error: '請提供 item_code 及 route_id' }, { status: 400 })
    }

    const sb = getSupabaseAdminClient()

    const { data: existing } = await sb.from('item_routes').select('id').eq('item_code', itemCode).maybeSingle()
    if (existing) {
      return NextResponse.json({ success: false, error: `品項編碼「${itemCode}」已經有途程對應，請至「工序總表更新」頁面調整` }, { status: 409 })
    }

    const { data, error } = await sb
      .from('item_routes')
      .insert({ item_code: itemCode, item_name: (body.item_name ?? '').trim() || null, route_id: routeId })
      .select()
      .single()
    if (error) throw error

    return NextResponse.json({ success: true, row: data })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
