import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth, guardPermission } from '@/lib/requireAuth'

// BOM 人工補登——獨立於 ARGO 同步的 mm_bom_structure，不會被每天 4 次的全量同步清掉。
// 詳見 sql/20260821_bom_manual_supplement.sql 的說明。
// 批備料頁面（material-prep）查 BOM 時會合併讀取這張表，讓補登的資料真的能被用到，
// 不只是紀錄。之後 ARGO 那邊若確認有 BOM 匯入介面可以回寫，這張表的資料要能對應
// 遷移過去。

export const dynamic = 'force-dynamic'

interface ChildInput {
  child_part: string
  child_qty: number
}

// GET ?parent_parts=A,B,C — 供批備料頁面查詢補登的 BOM（跟 mm_bom_structure 合併用）
export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const sb = getSupabaseAdminClient()
    const { searchParams } = new URL(request.url)
    const parentParam = searchParams.get('parent_parts')

    let query = sb.from('bom_manual_supplement').select('*').order('created_at', { ascending: false })
    if (parentParam) {
      const parents = parentParam.split(',').map(s => s.trim()).filter(Boolean)
      if (parents.length > 0) query = query.in('parent_part', parents)
    }
    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({ success: true, rows: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// POST { parent_part, children: [{ child_part, child_qty }], note? }
export async function POST(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json() as { parent_part?: string; children?: ChildInput[]; note?: string }
    const parentPart = (body.parent_part ?? '').trim()
    const children = (body.children ?? []).filter(c => c.child_part?.trim())
    if (!parentPart || children.length === 0) {
      return NextResponse.json({ success: false, error: '請提供 parent_part 及至少一筆 children' }, { status: 400 })
    }

    const sb = getSupabaseAdminClient()
    const rows = children.map(c => ({
      parent_part: parentPart,
      child_part: c.child_part.trim(),
      child_qty: Number(c.child_qty) || 0,
      note: body.note ?? null,
      created_by: guard.member.realName ?? guard.member.email,
      created_by_email: guard.member.email,
    }))

    const { data, error } = await sb.from('bom_manual_supplement').insert(rows).select()
    if (error) throw error

    return NextResponse.json({ success: true, rows: data })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// DELETE ?id=123 — 刪除一筆補登資料（例如打錯了，或 ARGO 那邊已經正式建好了）
export async function DELETE(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const id = new URL(request.url).searchParams.get('id')
    if (!id) return NextResponse.json({ success: false, error: '請提供 id' }, { status: 400 })

    const sb = getSupabaseAdminClient()
    const { error } = await sb.from('bom_manual_supplement').delete().eq('id', id)
    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
