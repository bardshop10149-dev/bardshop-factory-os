import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'
import { loadPoTrackingLines, loadPoPage, loadReminders, type PageParams } from '@/lib/purchasing/data'
import { computeDueCounts } from '@/lib/purchasing/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// GET：採購明細。三種模式：
//   預設        → 伺服器端過濾/排序/分頁（每頁 100 筆，只 enrich 當頁 → 快），回 { lines, total }
//   ?mode=reminders → 交期 10 天內的 OPEN 列（到期提醒分頁用），回 { lines, counts }
//   ?count=1    → 只回到期提醒統計（首頁卡片徽章用）
// 僅採購權限可用（含供應商與付款；跨區請走 /api/purchasing/po-public）。
export async function GET(request: NextRequest) {
  const guard = await guardPermission('purchasing')
  if (!guard.ok) return guard.res

  const s = request.nextUrl.searchParams
  const supabase = getSupabaseAdminClient()

  try {
    if (s.get('count') === '1') {
      const lines = await loadPoTrackingLines(supabase, { countOnly: true })
      return NextResponse.json({ success: true, counts: computeDueCounts(lines), openLines: lines.length })
    }

    if (s.get('mode') === 'reminders') {
      const lines = await loadReminders(supabase)
      return NextResponse.json({ success: true, lines, counts: computeDueCounts(lines) })
    }

    // 分頁清單
    const cpRaw = s.get('cp')
    const sortRaw = s.get('sortDue')
    const params: PageParams = {
      page: Math.max(1, Number(s.get('page')) || 1),
      pageSize: Math.min(200, Math.max(1, Number(s.get('pageSize')) || 100)),
      orderFrom: s.get('orderFrom'),
      orderTo: s.get('orderTo'),
      dueFrom: s.get('dueFrom'),
      dueTo: s.get('dueTo'),
      vendorCode: s.get('vendorCode'),
      vendorName: s.get('vendorName'),
      itemCode: s.get('itemCode'),
      buyer: s.get('buyer'),
      poNo: s.get('poNo'),
      poFrom: s.get('poFrom'),
      poTo: s.get('poTo'),
      cp: cpRaw === 'only' || cpRaw === 'exclude' ? cpRaw : 'all',
      sortDue: sortRaw === 'asc' || sortRaw === 'desc' ? sortRaw : null,
    }
    const { lines, total } = await loadPoPage(supabase, params)
    return NextResponse.json({ success: true, lines, total, page: params.page, pageSize: params.pageSize })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
