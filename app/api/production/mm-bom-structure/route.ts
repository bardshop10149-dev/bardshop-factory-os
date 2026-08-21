import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'

// BOM 展開結構單筆（或一次多筆子件）新增——供「工序/BOM補登表」頁面補登用。
// 既有的 sync_bom_structure（app/api/argoerp/route.ts）是從 ARGO 全量同步覆蓋，
// 這支是本系統手動補登、不經過 ARGO，寫入同一張 mm_bom_structure 表。

export const dynamic = 'force-dynamic'

interface ChildInput {
  child_part: string
  child_qty: number
  child_scrap?: number
}

// POST { parent_part, bom_ver?, children: [{ child_part, child_qty, child_scrap? }] }
export async function POST(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as { parent_part?: string; bom_ver?: number; children?: ChildInput[] }
    const parentPart = (body.parent_part ?? '').trim()
    const bomVer = body.bom_ver && body.bom_ver > 0 ? body.bom_ver : 1
    const children = (body.children ?? []).filter(c => c.child_part?.trim())
    if (!parentPart || children.length === 0) {
      return NextResponse.json({ success: false, error: '請提供 parent_part 及至少一筆 children' }, { status: 400 })
    }

    const sb = getSupabaseAdminClient()

    const { data: existingRows, error: existingErr } = await sb
      .from('mm_bom_structure')
      .select('line_no')
      .eq('parent_part', parentPart)
      .eq('bom_ver', bomVer)
      .order('line_no', { ascending: false })
      .limit(1)
    if (existingErr) throw existingErr
    let nextLineNo = (existingRows?.[0]?.line_no ?? 0) + 1

    const rows = children.map(c => ({
      parent_part: parentPart,
      bom_ver: bomVer,
      child_part: c.child_part.trim(),
      child_ver: 1,
      line_no: nextLineNo++,
      child_qty: Number(c.child_qty) || 0,
      child_scrap: Number(c.child_scrap) || 0,
      lot_child_qty: null,
      lot_base: null,
      synced_at: new Date().toISOString(),
    }))

    const { data, error } = await sb.from('mm_bom_structure').insert(rows).select()
    if (error) throw error

    return NextResponse.json({ success: true, rows: data })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
