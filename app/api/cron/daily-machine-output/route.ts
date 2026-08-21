import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { argoConfigured } from '@/lib/argoQuery'
import { computeDailyMachineOutput, taipeiYesterdayStr } from '@/lib/dailyMachineOutput'

// 每天 05:00（台北時區）排程：算「昨天」的各機台產出，存成快照，
// 供 /admin/production/daily-machine-output 頁面與 05:30 的通知信共用讀取，
// 不用每次開頁面/寄信都重新即時查一次 ARGO。
//
// 觸發方式與驗證：跟現有 /api/cron/sync/[mode] 完全一致——Vercel Cron 以 GET 呼叫，
// 自動帶 `Authorization: Bearer <CRON_SECRET>`；也接受 POST + WEBHOOK_SECRET 供手動測試。

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  return run(request)
}
export async function POST(request: NextRequest) {
  return run(request)
}

async function run(request: NextRequest) {
  const bearer = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const cronSecret = process.env.CRON_SECRET ?? ''
  const webhookSecret = process.env.WEBHOOK_SECRET ?? ''
  const authorized = !!bearer && ((!!cronSecret && bearer === cronSecret) || (!!webhookSecret && bearer === webhookSecret))
  if (!authorized) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    if (!argoConfigured()) {
      return NextResponse.json({ success: false, error: '未設定 ARGO 連線環境變數' }, { status: 500 })
    }
    // 允許 ?date=YYYY-MM-DD 手動指定（補算某天），預設算昨天
    const dateParam = request.nextUrl.searchParams.get('date')
    const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : taipeiYesterdayStr()

    const result = await computeDailyMachineOutput(date)

    const sb = getSupabaseAdminClient()
    const { error } = await sb
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
    if (error) throw error

    return NextResponse.json({
      success: true,
      date: result.date,
      machineCount: result.rows.length,
      packingItemCount: result.packingList.length,
      totalMoCount: result.totalMoCount,
      unassignedMoCount: result.unassignedMoCount,
    })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    console.error('[cron/daily-machine-output] failed:', msg)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
