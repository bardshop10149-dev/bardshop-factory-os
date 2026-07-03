import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'
import { loadPoTrackingLines } from '@/lib/purchasing/data'
import { computeDueCounts } from '@/lib/purchasing/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// GET：全部 OPEN 採購明細 + 追蹤/付款/供應商/PR/MO 組裝。
// 僅採購權限可用（含供應商與付款資訊，不可外流 → 跨區請走 /api/purchasing/po-public）。
// ?count=1 只回到期提醒統計（首頁卡片徽章用，略過 enrich 較快）。
export async function GET(request: NextRequest) {
  const guard = await guardPermission('purchasing')
  if (!guard.ok) return guard.res

  const countOnly = request.nextUrl.searchParams.get('count') === '1'
  const supabase = getSupabaseAdminClient()

  try {
    const lines = await loadPoTrackingLines(supabase, { countOnly })
    const counts = computeDueCounts(lines)
    if (countOnly) {
      return NextResponse.json({ success: true, counts, openLines: lines.length })
    }
    return NextResponse.json({ success: true, counts, lines })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: formatSupabaseAdminError(msg) }, { status: 500 })
  }
}
