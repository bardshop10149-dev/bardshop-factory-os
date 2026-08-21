import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

// 讀取每天 05:00 排程算好的「各機台日產出」快照——頁面用這支，不即時查 ARGO。
// GET ?date=YYYY-MM-DD（不帶 date 則回傳最新一筆快照）

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const sb = getSupabaseAdminClient()
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date')

    let query = sb.from('argoerp_daily_machine_output_snapshots').select('*')
    query = date ? query.eq('date', date) : query.order('date', { ascending: false }).limit(1)
    const { data, error } = await query.maybeSingle()
    if (error) throw error

    return NextResponse.json({ success: true, snapshot: data ?? null }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
