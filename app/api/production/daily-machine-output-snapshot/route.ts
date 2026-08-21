import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth, guardPermission } from '@/lib/requireAuth'
import { argoConfigured } from '@/lib/argoQuery'
import { computeDailyMachineOutput } from '@/lib/dailyMachineOutput'

// 讀取/手動重算每天 05:00 排程算好的「各機台日產出」快照——頁面用這支，不即時查 ARGO。
// GET  ?date=YYYY-MM-DD（不帶 date 則回傳最新一筆快照）
// POST { date: YYYY-MM-DD } → 手動觸發重算並覆蓋該日快照（供頁面上的「手動更新」
//   按鈕使用，走一般登入身分驗證，不是 cron 排程那組 Bearer secret）

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

export async function POST(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    if (!argoConfigured()) {
      return NextResponse.json({ success: false, error: '未設定 ARGO 連線環境變數' }, { status: 500 })
    }
    const body = await request.json() as { date?: string }
    const date = body.date
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ success: false, error: '請提供有效的 date (YYYY-MM-DD)' }, { status: 400 })
    }

    const result = await computeDailyMachineOutput(date)

    const sb = getSupabaseAdminClient()
    const { data, error } = await sb
      .from('argoerp_daily_machine_output_snapshots')
      .upsert({
        date: result.date,
        rows: result.rows,
        packing_list: result.packingList,
        total_mo_count: result.totalMoCount,
        unassigned_mo_count: result.unassignedMoCount,
        unassigned_mo_numbers: result.unassignedMoNumbers,
        computed_at: new Date().toISOString(),
      }, { onConflict: 'date' })
      .select()
      .single()
    if (error) throw error

    return NextResponse.json({ success: true, snapshot: data })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
