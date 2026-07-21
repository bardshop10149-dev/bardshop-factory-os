import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'
import { loadPoTrackingLines, loadPoPage, type PageParams } from '@/lib/purchasing/data'
import { computeDueCounts } from '@/lib/purchasing/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// GET：採購明細。三種模式：
//   ?mode=page  → 伺服器端過濾/排序/分頁（追蹤列表用，只 enrich 當頁 → 次秒級），回 { lines, total }
//   ?count=1    → 只回到期提醒統計（首頁卡片徽章用）
//   預設        → 全量（到期提醒分頁用；含 counts）
// 僅採購權限可用（含供應商與付款資訊，不可外流 → 跨區請走 /api/purchasing/po-public）。
export async function GET(request: NextRequest) {
  const guard = await guardPermission('purchasing')
  if (!guard.ok) return guard.res

  const params = request.nextUrl.searchParams
  const countOnly = params.get('count') === '1'
  const orderFrom = params.get('from')
  const orderTo = params.get('to')
  // 單據狀態（ARGO HOLD_STATUS）白名單；count 模式（首頁徽章）固定 OPEN
  const poStatus = (params.get('status') ?? 'OPEN').trim().toUpperCase()
  if (!['OPEN', 'CLOSE', 'VOID'].includes(poStatus)) {
    return NextResponse.json({ success: false, error: 'status 必須是 OPEN/CLOSE/VOID' }, { status: 400 })
  }
  const supabase = getSupabaseAdminClient()

  try {
    const timings: Record<string, number> = {}

    if (params.get('mode') === 'page') {
      const cpRaw = params.get('cp')
      const sortRaw = params.get('sortDue')
      const p: PageParams = {
        page: Math.max(1, Number(params.get('page')) || 1),
        pageSize: Math.min(200, Math.max(1, Number(params.get('pageSize')) || 100)),
        poStatus,
        orderFrom: params.get('orderFrom'),
        orderTo: params.get('orderTo'),
        dueFrom: params.get('dueFrom'),
        dueTo: params.get('dueTo'),
        vendorCode: params.get('vendorCode'),
        vendorName: params.get('vendorName'),
        itemCode: params.get('itemCode'),
        buyer: params.get('buyer'),
        poNo: params.get('poNo'),
        poFrom: params.get('poFrom'),
        poTo: params.get('poTo'),
        cp: cpRaw === 'only' || cpRaw === 'exclude' ? cpRaw : 'all',
        srcNo: params.get('srcNo'),
        sortDue: sortRaw === 'asc' || sortRaw === 'desc' ? sortRaw : null,
      }
      const { lines, total } = await loadPoPage(supabase, p, timings)
      return NextResponse.json({ success: true, lines, total, page: p.page, pageSize: p.pageSize, timings })
    }

    const lines = await loadPoTrackingLines(supabase, countOnly ? { countOnly } : { orderFrom, orderTo, poStatus }, timings)
    const counts = computeDueCounts(lines)
    if (countOnly) {
      return NextResponse.json({ success: true, counts, openLines: lines.length })
    }
    return NextResponse.json({ success: true, counts, lines, timings })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
