import { NextRequest } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError, describeError } from '@/lib/supabaseAdmin'
import { guardPackaging, noStore } from '@/lib/packaging/guard'
import { getPool, POOL_READ_MAX_AGE_MS } from '@/lib/packaging/poolCache'
import { getPoolPageManual } from '@/lib/packaging/manualCache'
import { unavailableManualSection, type PoolPageResponse } from '@/lib/packaging/manualPool'
import { isMissingSchema, linesMigrationMessage } from '@/lib/packaging/scheduleDb'
import type { PoolOk } from '@/lib/packaging/pool'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區待排池頁（P0 起，D42；規格 docs/design/2026-09-27-packaging-schedule.md §7.1）
//
// GET            回傳 PoolPageResponse＝PoolResponse（各區塊的卡片、各來源更新時間、排除計數、註腳、
//                發單超過 30 天仍未上塔台清單）＋ manual（D102 手動加入的管理資訊）
// GET ?fresh=1   略過伺服器快取重算（同一實例 30 秒最多一次，見下）
// （原 ?hideStale=N 已移除：D43 改以「塔台未結案批」界定待排池範圍，舊單不再進池）
//
// 權限：packaging（唯讀）／packaging_admin（主管）／admin 都能讀（D30）。本路由只讀，不寫任何資料；
// 手動加入的寫入走 /api/packaging/manual（D102 起不需編輯鎖，見該檔檔頭）。
//
// D102「待排池頁是可排卡片的唯一控制台」改了兩件事：
// 1. 待排池改用 lib/packaging/poolCache 的共用快取（原本本檔自己有一份 120 秒模組快取）。
//    為什麼：待排池頁、排程工作台、手動加入的驗證看的是同一份待排池——不會出現「這頁看得到、加入時卻說已在待排池」
//    的 2 分鐘錯位；也吃到 D98 的「先給舊資料、背景更新」，寫入後重抓不會撞到快取過期而多等 3～6 秒。
//    代價：fresh=1 會連帶重組工作台共用的那份，唯讀者也按得到 → 同 board 的 30 秒節流。
// 2. 併入手動加入區塊 'mn'（getPoolPageManual：已全數完成的拆到 manual.ended，不灌水張數與工時）。
//    手動層讀取失敗（例：migration 未套用）只讓 manual.available=false，待排池其他區塊照常——
//    這一頁是全廠在看的總覽，不能因為手動加入壞掉就整頁 500。

/** fresh=1 同一實例最多每 30 秒一次（同 /api/packaging/board 的 FRESH_MIN_INTERVAL_MS）；期間內視同一般讀取 */
const FRESH_MIN_INTERVAL_MS = 30_000
let lastFreshAt = 0

export async function GET(request: NextRequest) {
  const g = await guardPackaging('read')
  if (!g.ok) return g.res

  const nowMs = Date.now()
  let fresh = false
  if (request.nextUrl.searchParams.get('fresh') === '1' && nowMs - lastFreshAt >= FRESH_MIN_INTERVAL_MS) {
    fresh = true
    lastFreshAt = nowMs
  }

  let pool: PoolOk
  try {
    pool = await getPool({ fresh, maxAgeMs: POOL_READ_MAX_AGE_MS })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : describeError(e)
    console.error('[packaging/pool] 組裝失敗:', msg)
    return noStore<PoolPageResponse>({ success: false, error: msg }, 500)
  }

  try {
    const r = await getPoolPageManual(getSupabaseAdminClient(), pool)
    // 展開成新物件：pool／r.pool 是多個請求共用的快取物件，不可修改
    return noStore<PoolPageResponse>({ ...r.pool, manual: r.section })
  } catch (e) {
    console.error('[packaging/pool] 手動加入讀取失敗（其他區塊照常）:', describeError(e))
    const error = isMissingSchema(e) ? linesMigrationMessage(e) : '手動加入資料暫時讀不到（其他區塊不受影響），請稍後按「重新整理」'
    return noStore<PoolPageResponse>({ ...pool, manual: unavailableManualSection(error) })
  }
}
