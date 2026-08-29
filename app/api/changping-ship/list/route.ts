import { NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// GET:常平訂單資料區列表(黃底=常平已出貨 標記快照)
// 權限:changping_ship(管理員自動通過)
// 表由 service_role 持有,前端不直連 —— 一律經此 API。

const MAX_ROWS = 6000   // 全量後標記約 4~5 千筆;超過取 last_seen 最新的

// 型別推導吃不了串接的 select 字串 → 照 lib/purchasing/data.ts 慣例以介面斷言
interface MarkRec {
  still_marked: boolean
  applied_at: string | null
  match_status: string | null
  [key: string]: unknown
}

export async function GET() {
  const guard = await guardPermission('changping_ship')
  if (!guard.ok) return guard.res

  const supabase = getSupabaseAdminClient()
  try {
    const { data, error } = await supabase
      .from('changping_ship_marks')
      .select('mark_key, sheet, row_no, detail_id, po_no, pr_no, so_no, vendor, item_code, item_name, qty, '
        + 'order_date, hope_date, transport, expected_ship, ship_date_text, ship_date, fill_color, '
        + 'still_marked, first_seen_at, last_seen_at, matched_lines, match_status, applied_at, apply_note')
      .order('last_seen_at', { ascending: false })
      .order('sheet', { ascending: false })
      .order('row_no', { ascending: true })
      .limit(MAX_ROWS)
    if (error) throw new Error(error.message)

    const rows = (data ?? []) as unknown as MarkRec[]
    const counts = {
      total: rows.length,
      active: rows.filter((r) => r.still_marked).length,
      applied: rows.filter((r) => r.applied_at != null).length,
      unmatched: rows.filter((r) => r.match_status === 'no_line').length,
    }
    return NextResponse.json({ success: true, rows, counts })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
