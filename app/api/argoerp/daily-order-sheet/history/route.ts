import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, describeError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

// 每日出單表修改歷程（唯讀）
//   ?date=YYYY-MM-DD            → 該日出單表的所有寫入紀錄（新→舊）
//   ?order=SO2608xxxxx[&line=1] → 跨日期查這張單（可指定序號）被新增/刪除/改欄位的紀錄
// 寫入端見 lib/argoerp/sheetHistory.ts（所有寫出單表的 API 與排程都會記）。
export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date')
    const order = (searchParams.get('order') ?? '').trim()
    const line = (searchParams.get('line') ?? '').trim()
    const limit = Math.min(Number(searchParams.get('limit') ?? 200) || 200, 1000)
    const sb = getSupabaseAdminClient()

    if (order) {
      // jsonb 包含查詢：changes.field_changes / added / removed 任一陣列含此訂單號
      const probe = (key: string) => JSON.stringify({ [key]: [line ? { order_number: order, line } : { order_number: order }] })
      const { data, error } = await sb
        .from('daily_order_sheet_history')
        .select('*')
        .or(`changes.cs.${probe('field_changes')},changes.cs.${probe('added')},changes.cs.${probe('removed')}`)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) throw error
      return NextResponse.json({ success: true, entries: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
    }

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ success: false, error: '請提供 date=YYYY-MM-DD 或 order=訂單號' }, { status: 400 })
    }
    const { data, error } = await sb
      .from('daily_order_sheet_history')
      .select('*')
      .eq('sheet_date', date)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    return NextResponse.json({ success: true, entries: data ?? [] }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ success: false, error: describeError(e) }, { status: 500 })
  }
}
