import { NextRequest, NextResponse } from 'next/server'
import { formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardPermission } from '@/lib/requireAuth'
import { argoConfigured } from '@/lib/argoQuery'
import { computeDailyMachineOutput } from '@/lib/dailyMachineOutput'

// 即時查詢版——供頁面手動指定任意日期查詢。每天 05:00 的排程快照見
// /api/cron/daily-machine-output + lib/dailyMachineOutput.ts（實際計算邏輯共用）。
//
// GET ?date=YYYY-MM-DD（台北時區的日曆日）

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    if (!argoConfigured()) {
      return NextResponse.json({ success: false, error: '未設定 ARGO 連線環境變數' }, { status: 500 })
    }
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date')
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ success: false, error: '請提供有效的 date (YYYY-MM-DD)' }, { status: 400 })
    }

    const result = await computeDailyMachineOutput(date)

    return NextResponse.json({ success: true, ...result }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
