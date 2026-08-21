import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

// 查詢一個品項「目前」的 BOM——同時回傳 ARGO 同步版本（mm_bom_structure）跟
// 人工補登/更正版本（bom_manual_supplement），並標明目前實際生效的是哪一份。
// 生效規則：只要 bom_manual_supplement 有這個品項的資料，一律優先於 ARGO
// （不管 ARGO 那邊有沒有資料）——跟批備料頁面的合併邏輯一致，見 lib 說明。
//
// GET ?item_code=XXX

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const itemCode = (new URL(request.url).searchParams.get('item_code') ?? '').trim()
    if (!itemCode) {
      return NextResponse.json({ success: false, error: '請提供 item_code' }, { status: 400 })
    }

    const sb = getSupabaseAdminClient()
    const [{ data: argoRows, error: argoErr }, { data: manualRows, error: manualErr }] = await Promise.all([
      sb.from('mm_bom_structure')
        .select('parent_part, child_part, child_ver, bom_ver, line_no, child_qty, child_scrap, lot_child_qty, lot_base')
        .eq('parent_part', itemCode)
        .order('bom_ver', { ascending: true })
        .order('line_no', { ascending: true }),
      sb.from('bom_manual_supplement')
        .select('*')
        .eq('parent_part', itemCode)
        .order('id', { ascending: true }),
    ])
    if (argoErr) throw argoErr
    if (manualErr) throw manualErr

    const hasManual = (manualRows ?? []).length > 0
    const effectiveSource = hasManual ? 'manual' : (argoRows ?? []).length > 0 ? 'argo' : 'none'

    return NextResponse.json({
      success: true,
      item_code: itemCode,
      argo_rows: argoRows ?? [],
      manual_rows: manualRows ?? [],
      effective_source: effectiveSource,
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
