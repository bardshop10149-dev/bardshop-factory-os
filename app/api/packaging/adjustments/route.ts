import { NextRequest } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import type { AdjustmentsResponse, TimeAdjustment } from '@/lib/packaging/scheduleTypes'
import { guardPackaging, noStore } from '@/lib/packaging/guard'
import { isUuid } from '@/lib/packaging/scheduleOps'
import {
  isMissingSchema,
  linesMigrationMessage,
  listItemAdjustments,
  listPlacementAdjustments,
  publicDbError,
} from '@/lib/packaging/scheduleDb'

export const dynamic = 'force-dynamic'

// 包裝專區 P1 分線輪：D69 工時修改紀錄（卡片詳情「修改歷程」用）。規格 docs/design/2026-09-27-packaging-lines.md §4.6
//
// GET ?placementId=<uuid>&itemCode=<品號>（讀）→ AdjustmentsResponse
//   placement：這張（子）卡的修改歷程（新到舊，最多 100 筆，含 Undo 產生的紀錄）
//   sameItem：同品號過去的修改（排除 via='undo'）：筆數、改後每件分鐘平均、最近 10 筆（解讀，待確認 §十一第 11 題）
// 只回 actorName，不回 email。只讀 packaging_time_adjustments。

const ITEM_CODE_MAX = 80
const SAME_ITEM_RECENT = 10

export async function GET(request: NextRequest) {
  const g = await guardPackaging('read')
  if (!g.ok) return g.res
  const sp = request.nextUrl.searchParams
  const placementId = sp.get('placementId')?.trim() || null
  const itemCode = sp.get('itemCode')?.trim() || null
  if (placementId != null && !isUuid(placementId)) return noStore<AdjustmentsResponse>({ success: false, code: 'bad_request', error: 'placementId 格式錯誤' }, 400)
  if (itemCode != null && itemCode.length > ITEM_CODE_MAX) return noStore<AdjustmentsResponse>({ success: false, code: 'bad_request', error: '品號過長' }, 400)
  if (!placementId && !itemCode) return noStore<AdjustmentsResponse>({ success: false, code: 'bad_request', error: '請提供 placementId 或 itemCode' }, 400)
  try {
    const sb = getSupabaseAdminClient()
    const [placement, item] = await Promise.all([
      placementId ? listPlacementAdjustments(sb, placementId) : Promise.resolve([] as TimeAdjustment[]),
      itemCode ? listItemAdjustments(sb, itemCode) : Promise.resolve([] as TimeAdjustment[]),
    ])
    const per = item.map((a) => a.perUnitAfter).filter((x): x is number => x != null && Number.isFinite(x))
    const avg = per.length > 0 ? Math.round((per.reduce((s, x) => s + x, 0) / per.length) * 10000) / 10000 : null
    return noStore<AdjustmentsResponse>({
      success: true,
      placement,
      sameItem: { itemCode, count: item.length, avgPerUnitAfter: avg, recent: item.slice(0, SAME_ITEM_RECENT) },
    })
  } catch (e) {
    console.error('[packaging/adjustments]', describeError(e))
    if (isMissingSchema(e)) return noStore<AdjustmentsResponse>({ success: false, code: 'migration_required', error: linesMigrationMessage(e) }, 409)
    return noStore<AdjustmentsResponse>({ success: false, code: 'db_error', error: publicDbError(e) }, 500)
  }
}
