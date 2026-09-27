// 包裝專區 — 待排池共用快取（規格 §7.1）
//
// /api/packaging/board 與所有 P1 寫入 API 共用同一份（同一個 Vercel 實例內的模組層記憶體）：
// - 讀（board）用 maxAgeMs = 120 秒：塔台 30 分、ERP 5 分～1 小時才同步，2 分鐘內重算沒有意義。
// - 寫（placements／complete…）用 10 分鐘：驗證只需要「這一行大概有多少可排量、預估可包日」，
//   換來拖曳不會碰到 3～6 秒的冷啟動重算。讀取時會再依最新資料修剪／標示（規格 §9.1 第 8 條）。
// - 同時多個請求共用同一個進行中的 Promise，避免冷啟動時雪崩式重算。
//
// 只「讀」buildPackagingPool 的輸出，不修改 pool 邏輯。回傳的物件是多個請求共用的，呼叫端不可修改它。
// （/api/packaging/pool 目前仍用自己的模組快取；改為共用本檔屬該 route 的修改，不在本次範圍。）

import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { buildPackagingPool, type PoolOk } from '@/lib/packaging/pool'

export const POOL_READ_MAX_AGE_MS = 120_000
export const POOL_WRITE_MAX_AGE_MS = 10 * 60_000

let cache: { at: number; data: PoolOk } | null = null
let inflight: Promise<PoolOk> | null = null

export async function getPool(opts: { fresh?: boolean; maxAgeMs?: number } = {}): Promise<PoolOk> {
  const maxAge = opts.maxAgeMs ?? POOL_READ_MAX_AGE_MS
  if (!opts.fresh && cache && Date.now() - cache.at < maxAge) return { ...cache.data, cached: true }
  if (!inflight) {
    const supabase = getSupabaseAdminClient()
    inflight = buildPackagingPool(supabase)
      .then((data) => { cache = { at: Date.now(), data }; return data })
      .finally(() => { inflight = null })
  }
  return inflight
}
