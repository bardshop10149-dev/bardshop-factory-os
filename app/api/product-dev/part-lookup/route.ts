import { NextRequest, NextResponse } from 'next/server'
import { guardPermission } from '@/lib/requireAuth'
import { searchParts, getPartTemplate } from '@/lib/productDev/argoParts'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * GET /api/product-dev/part-lookup
 *   ?q=關鍵字   → 搜尋既有品項（料號前綴 或 品名包含），供挑選引用範本
 *   ?part=料號  → 取該品項的完整 ERP 設定，帶入申請表單
 *
 * 唯讀。權限：product_dev（管理員自動放行）。
 */
export async function GET(request: NextRequest) {
  const guard = await guardPermission('product_dev')
  if (!guard.ok) return guard.res

  const { searchParams } = new URL(request.url)
  const part = (searchParams.get('part') ?? '').trim()
  const q = (searchParams.get('q') ?? '').trim()

  try {
    if (part) {
      const row = await getPartTemplate(part)
      if (!row) return NextResponse.json({ success: false, error: '查無此品項編碼' }, { status: 404 })
      return NextResponse.json({ success: true, part: row })
    }

    if (q.length < 2) {
      return NextResponse.json({ success: false, error: '請輸入至少 2 個字元' }, { status: 400 })
    }

    const rows = await searchParts(q)
    return NextResponse.json({ success: true, parts: rows, count: rows.length })
  } catch (err) {
    const message = err instanceof Error ? err.message : '查詢失敗'
    console.error('[part-lookup]', message)
    return NextResponse.json({ success: false, error: `ARGO 查詢失敗：${message}` }, { status: 502 })
  }
}
