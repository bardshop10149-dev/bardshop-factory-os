import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdminClient, formatSupabaseAdminError, describeError } from '@/lib/supabaseAdmin'
import { guardAuth } from '@/lib/requireAuth'
import { buildPackagingPool, type PoolOk } from '@/lib/packaging/pool'
import type { PoolResponse } from '@/lib/packaging/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 P0：唯讀待排池（D42）。規格 docs/design/2026-09-27-packaging-schedule.md §7.1
//
// GET            回傳 PoolResponse（10 個區塊的卡片、各來源更新時間、排除計數、註腳、發單超過 30 天仍未上塔台清單）
// GET ?fresh=1   略過伺服器快取重算
// （原 ?hideStale=N 已移除：D43 改以「塔台未結案批」界定待排池範圍，舊單不再進池）
//
// 只讀 Supabase 鏡像，不寫任何資料（P0 不建表、不回寫塔台 D4）。

/** D30：包裝專區唯讀（packaging）與主管編輯（packaging_admin）都能看待排池；admin 自動通過 */
const READ_PERMISSIONS = ['packaging', 'packaging_admin']

// 模組層記憶體快取：塔台 30 分、ERP 5 分~1 小時才同步，2 分鐘內重算沒有意義；
// 同一實例同時多個請求共用同一個進行中的 Promise（避免冷啟動時雪崩式重算）。
const TTL_MS = 120_000
let cache: { at: number; data: PoolOk } | null = null
let inflight: Promise<PoolOk> | null = null

export async function GET(request: NextRequest) {
  const g = await guardAuth()
  if (!g.ok) return g.res
  if (!g.member.isAdmin && !READ_PERMISSIONS.some((p) => g.member.permissions.includes(p))) {
    return NextResponse.json<PoolResponse>({ success: false, error: '需要權限：包裝專區（packaging）' }, { status: 403 })
  }

  const fresh = request.nextUrl.searchParams.get('fresh') === '1'
  const headers = { 'Cache-Control': 'no-store' }
  try {
    if (!fresh && cache && Date.now() - cache.at < TTL_MS) {
      return NextResponse.json<PoolResponse>({ ...cache.data, cached: true }, { headers })
    }
    if (!inflight) {
      const supabase = getSupabaseAdminClient()
      inflight = buildPackagingPool(supabase)
        .then((data) => { cache = { at: Date.now(), data }; return data })
        .finally(() => { inflight = null })
    }
    const data = await inflight
    return NextResponse.json<PoolResponse>(data, { headers })
  } catch (e) {
    const msg = e instanceof Error ? formatSupabaseAdminError(e.message) : describeError(e)
    console.error('[packaging/pool] 組裝失敗:', msg)
    return NextResponse.json<PoolResponse>({ success: false, error: msg }, { status: 500, headers })
  }
}
