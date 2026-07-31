import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

export const dynamic = 'force-dynamic'

/** "2026/8/5" | "2026-8-5" | "2026/08/05" → "2026-08-05" for string comparison */
function normDate(d: unknown): string {
  if (!d) return ''
  const s = String(d).split(/[ T]/)[0].replace(/\//g, '-').split('-')
  if (s.length !== 3) return ''
  return `${s[0]}-${s[1].padStart(2, '0')}-${s[2].padStart(2, '0')}`
}

function parseQty(q: unknown): number {
  return parseFloat(String(q ?? '0').replace(/,/g, '')) || 0
}

// GET /api/argoerp/bulk-orders
//   ?delivery_from=YYYY-MM-DD  (可選)
//   &delivery_to=YYYY-MM-DD    (可選)
//   &min_qty=1000              (預設 1000)
export async function GET(request: NextRequest) {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const { searchParams } = new URL(request.url)
    const deliveryFrom = normDate(searchParams.get('delivery_from') ?? '')
    const deliveryTo   = normDate(searchParams.get('delivery_to') ?? '')
    const minQty       = Math.max(0, parseFloat(searchParams.get('min_qty') ?? '1000') || 1000)

    const supabase = getSupabaseAdminClient()
    const { data: sheets, error } = await supabase
      .from('daily_order_sheets')
      .select('sheet_date, rows')
      .order('sheet_date', { ascending: false })
    if (error) throw error

    const results: Record<string, unknown>[] = []

    for (const sheet of (sheets ?? [])) {
      const rowsArr = Array.isArray(sheet.rows)
        ? (sheet.rows as Record<string, unknown>[])
        : []
      for (const row of rowsArr) {
        const qty = parseQty(row.quantity)
        if (qty < minQty) continue
        const deliv = normDate(row.delivery_date)
        if (deliveryFrom && deliv && deliv < deliveryFrom) continue
        if (deliveryTo   && deliv && deliv > deliveryTo)   continue
        results.push({ ...row, sheet_date: sheet.sheet_date })
      }
    }

    // 排序：交期 ASC → 出單日 ASC → 數量 DESC
    results.sort((a, b) => {
      const da = normDate(a.delivery_date), db = normDate(b.delivery_date)
      if (da !== db) return da.localeCompare(db)
      const sa = String(a.sheet_date ?? ''), sb = String(b.sheet_date ?? '')
      if (sa !== sb) return sa.localeCompare(sb)
      return parseQty(b.quantity) - parseQty(a.quantity)
    })

    return NextResponse.json({ success: true, rows: results, total: results.length })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
