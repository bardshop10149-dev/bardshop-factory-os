import { NextRequest, NextResponse } from 'next/server'
import { guardAuth, guardPermission } from '@/lib/requireAuth'
import { readPendingList, writePendingList } from '@/lib/sara/autoProcessGen'

export const dynamic = 'force-dynamic'

// SARA 工序自動產生的「待處理清單」（無途程且不符合自動規則／尚未轉單而被跳過的列）。
// GET  ?count=1 → 只回數量（導覽列徽章輪詢用）；不帶參數 → 回完整清單
// DELETE body { keys?: string[] } → 移除指定項（key = order_number||item_code||line_seq）；
//        不帶 keys → 全部清空
export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const items = await readPendingList()
    if (new URL(request.url).searchParams.get('count') === '1') {
      return NextResponse.json({ success: true, count: items.length }, { headers: { 'Cache-Control': 'no-store' } })
    }
    return NextResponse.json({ success: true, count: items.length, items }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  const guard = await guardPermission('production_admin')
  if (!guard.ok) return guard.res
  try {
    const body = await request.json().catch(() => ({})) as { keys?: string[] }
    const items = await readPendingList()
    if (Array.isArray(body.keys) && body.keys.length > 0) {
      const keySet = new Set(body.keys)
      const kept = items.filter(x => !keySet.has(`${x.order_number}||${x.item_code}||${x.line_seq}`))
      await writePendingList(kept)
      return NextResponse.json({ success: true, removed: items.length - kept.length, count: kept.length })
    }
    await writePendingList([])
    return NextResponse.json({ success: true, removed: items.length, count: 0 })
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
