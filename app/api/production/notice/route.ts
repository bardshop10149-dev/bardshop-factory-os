import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

const BOM_TABLE = 'bom'
const GROUPS_TABLE = 'production_notice_groups'

// ============================================================
// GET：回傳所有 bom 品項（id, product_code, product_name, group_name）
// 以及群組清單。bom 表有 3000+ 筆，PostgREST 單次請求有筆數上限，
// 這裡沿用原前端邏輯：以 1000 筆為一批用 range() 分批撈取直到取完。
// ============================================================
export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const supabase = getSupabaseAdminClient()

    let allItems: Record<string, unknown>[] = []
    let from = 0
    const batchSize = 1000
    while (true) {
      const to = from + batchSize - 1
      const { data, error } = await supabase
        .from(BOM_TABLE)
        .select('id, product_code, product_name, group_name')
        .range(from, to)

      if (error) {
        return NextResponse.json(
          { success: false, error: formatSupabaseAdminError(error.message) },
          { status: 500 }
        )
      }

      if (data && data.length > 0) {
        allItems = allItems.concat(data)
        if (data.length < batchSize) break
        from += batchSize
      } else {
        break
      }
    }

    const { data: groups, error: groupsError } = await supabase
      .from(GROUPS_TABLE)
      .select('*')
      .order('id')

    if (groupsError) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(groupsError.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, items: allItems, groups: groups ?? [] })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}

// ============================================================
// PATCH：更新一或多筆 bom 品項的 group_name
// body: { id: number, group_name: string } 或 { ids: number[], group_name: string }
// 對應原本 setItemGroup（單筆）/ batchSetGroup（批次）
// ============================================================
export async function PATCH(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const body = await request.json()
    const groupName: string = typeof body?.group_name === 'string' ? body.group_name : ''

    let ids: number[] = []
    if (Array.isArray(body?.ids)) {
      ids = body.ids
    } else if (body?.id !== undefined && body?.id !== null) {
      ids = [body.id]
    }

    if (ids.length === 0) {
      return NextResponse.json({ success: false, error: 'id 或 ids 不可為空' }, { status: 400 })
    }

    const supabase = getSupabaseAdminClient()
    const { error } = await supabase
      .from(BOM_TABLE)
      .update({ group_name: groupName })
      .in('id', ids)

    if (error) {
      return NextResponse.json(
        { success: false, error: formatSupabaseAdminError(error.message) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, updated: ids.length })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
