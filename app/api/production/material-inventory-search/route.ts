import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

// 搜尋 ERP 同步區的庫存名單（material_inventory_list），供 BOM 補登表選子件料號用。
// GET ?q=關鍵字 — 依料號或品名模糊比對，回傳前 20 筆
//
// 只回傳 M 開頭／W 開頭的料號（見 lib/bomPrefixRules.ts）：BOM 子件本來就是原料/
// 半成品，C/O/S 開頭是委外/代工成品、不會是子件，搜尋範圍縮小可以避免選錯。

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const q = (new URL(request.url).searchParams.get('q') ?? '').trim()
    if (!q) {
      return NextResponse.json({ success: true, items: [] }, { headers: { 'Cache-Control': 'no-store' } })
    }

    const sb = getSupabaseAdminClient()
    const { data, error } = await sb
      .from('material_inventory_list')
      .select('item_code, item_name, unit_of_measure, book_count')
      .or('item_code.ilike.M%,item_code.ilike.W%')
      .or(`item_code.ilike.%${q}%,item_name.ilike.%${q}%`)
      .order('item_code', { ascending: true })
      .limit(20)
    if (error) throw error

    return NextResponse.json({ success: true, items: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
