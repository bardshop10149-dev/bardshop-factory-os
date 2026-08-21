import { NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'

// 工序/BOM 補登表——找出「發單作業區出現過，但工序總表(item_routes)或BOM
// (mm_bom_structure)沒有對應資料」的品項編碼，供生管補齊資料。
//
// item_code 來源：掃描 daily_order_sheets 全部日期的 rows（跟 so-change-notices
// 的既有掃描模式一致），不是只看最近幾天——只要出過單，缺工序/BOM 就該被抓出來。

export const dynamic = 'force-dynamic'

interface GapItem {
  item_code: string
  item_name: string
  missing_route: boolean
  missing_bom: boolean
  order_count: number
  last_seen_date: string
}

export async function GET() {
  const guard = await guardAuth()
  if (!guard.ok) return guard.res
  try {
    const sb = getSupabaseAdminClient()

    const { data: sheets, error: sheetsErr } = await sb
      .from('daily_order_sheets')
      .select('sheet_date, rows')
      .order('sheet_date', { ascending: false })
    if (sheetsErr) throw sheetsErr

    // item_code -> { item_name（取最近一次出現的）, order_count, last_seen_date }
    const itemMap = new Map<string, { item_name: string; order_count: number; last_seen_date: string }>()
    for (const sheet of (sheets ?? []) as Array<{ sheet_date: string; rows: unknown }>) {
      const rowsArr = Array.isArray(sheet.rows) ? (sheet.rows as Array<Record<string, unknown>>) : []
      for (const row of rowsArr) {
        const itemCode = String(row.item_code ?? '').trim()
        if (!itemCode) continue
        const itemName = String(row.item_name ?? '').trim()
        const existing = itemMap.get(itemCode)
        if (!existing) {
          itemMap.set(itemCode, { item_name: itemName, order_count: 1, last_seen_date: sheet.sheet_date })
        } else {
          existing.order_count += 1
          // sheets 已按日期新到舊排序，第一次遇到某 item_code 就是最新一次出現
        }
      }
    }

    const allItemCodes = [...itemMap.keys()]
    if (allItemCodes.length === 0) {
      return NextResponse.json({ success: true, items: [] }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // 分批查（IN 條件筆數過多時 PostgREST 可能有 URL 長度限制），500 筆一批
    const CHUNK = 500
    const hasRoute = new Set<string>()
    const hasBom = new Set<string>()
    for (let i = 0; i < allItemCodes.length; i += CHUNK) {
      const chunk = allItemCodes.slice(i, i + CHUNK)
      const [{ data: routes, error: routesErr }, { data: boms, error: bomsErr }] = await Promise.all([
        sb.from('item_routes').select('item_code').in('item_code', chunk),
        sb.from('mm_bom_structure').select('parent_part').in('parent_part', chunk),
      ])
      if (routesErr) throw routesErr
      if (bomsErr) throw bomsErr
      for (const r of routes ?? []) hasRoute.add(r.item_code)
      for (const b of boms ?? []) hasBom.add(b.parent_part)
    }

    const items: GapItem[] = []
    for (const [itemCode, info] of itemMap) {
      const missingRoute = !hasRoute.has(itemCode)
      const missingBom = !hasBom.has(itemCode)
      if (!missingRoute && !missingBom) continue
      items.push({
        item_code: itemCode,
        item_name: info.item_name,
        missing_route: missingRoute,
        missing_bom: missingBom,
        order_count: info.order_count,
        last_seen_date: info.last_seen_date,
      })
    }
    items.sort((a, b) => b.last_seen_date.localeCompare(a.last_seen_date) || b.order_count - a.order_count)

    return NextResponse.json({ success: true, items }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
