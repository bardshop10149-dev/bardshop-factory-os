// 包裝專區 — 待排池共用快取（規格 §7.1；D98 ② 先給舊資料、背景更新）
//
// /api/packaging/board、/api/packaging/pool（D102 起）與所有 P1 寫入 API 共用同一份（同一個 Vercel 實例內的模組層記憶體）：
// - 讀（board）用 maxAgeMs = 120 秒：塔台 30 分、ERP 5 分～1 小時才同步，2 分鐘內重算沒有意義。
// - 寫（placements／complete…）用 10 分鐘：驗證只需要「這一行大概有多少可排量、預估可包日」，
//   換來拖曳不會碰到 3～6 秒的冷啟動重算。讀取時會再依最新資料修剪／標示（規格 §9.1 第 8 條）。
// - 同時多個請求共用同一個進行中的 Promise，避免冷啟動時雪崩式重算。
//
// D98 ②（主管反映「拖完要等」：讀取快取 120 秒一過期，下一個請求就要同步等 4～9 秒重組）→ stale-while-revalidate：
//   年齡 < maxAgeMs                          → 直接用快取（同舊）
//   maxAgeMs ≤ 年齡 < POOL_WRITE_MAX_AGE_MS  → 立刻回舊資料，背景重組一次（同一時間只一個，single-flight）
//   年齡 ≥ POOL_WRITE_MAX_AGE_MS、沒有快取    → 同步重組（同舊）；fresh → 一律同步重組（同舊）
// 為什麼舊資料上限是 10 分鐘：寫入驗證本來就接受 10 分鐘內的待排池，讀取拿到的不會比寫入驗證用的更舊。
// 寫入路徑的 maxAgeMs 就是 10 分鐘 → 沒有「過期但可先用」的區間，行為完全不變。
// cached 旗標語意不變：從快取拿的（新鮮或先給的舊資料）＝true；這次請求親自等到的重組結果＝false。
//
// 背景重組在 serverless 的兩個坑：
// - 回應送出後函式可能被凍結，背景 Promise 停在半路 → 交給 next/server 的 after()（Vercel 上＝waitUntil）撐到做完；
//   不在請求範圍（腳本、測試）after 會丟錯 → 吞掉，照樣背景跑。
// - 真的被凍結／掛住時，single-flight 旗標不能永遠卡著：超過 POOL_BUILD_STUCK_MS 的進行中重組視為失效，
//   下一個請求會另起一個；快取的「年齡」以重組「開始」時間計，凍結很久才完成的舊結果不會被當成新資料，
//   也不會蓋掉之後才開始、先完成的較新結果。
// 背景重組失敗：只 log（不可 unhandled rejection），快取維持舊的，下一個讀取再試。
// 快取本體（可注入 build／時鐘，單元測試用）在 poolCacheCore.ts；本檔只負責接上正式的 build 與 after()。
//
// 只「讀」buildPackagingPool 的輸出，不修改 pool 邏輯。回傳的物件是多個請求共用的，呼叫端不可修改它。
// （D102：/api/packaging/pool 已改用本檔，待排池頁與工作台看的是同一份。）

import { after } from 'next/server'
import { describeError, getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { buildPackagingPool, type PoolOk } from '@/lib/packaging/pool'
import { createPoolCache } from '@/lib/packaging/poolCacheCore'

export {
  POOL_BUILD_STUCK_MS,
  POOL_READ_MAX_AGE_MS,
  POOL_STALE_MAX_AGE_MS,
  POOL_WRITE_MAX_AGE_MS,
} from '@/lib/packaging/poolCacheCore'

const shared = createPoolCache({
  build: () => buildPackagingPool(getSupabaseAdminClient()),
  keepAlive: (p) => after(p),
  onBackgroundError: (e) => console.error('[packaging/poolCache] 背景重組待排池失敗（沿用舊快取，下次讀取再試）:', describeError(e)),
})

export async function getPool(opts: { fresh?: boolean; maxAgeMs?: number } = {}): Promise<PoolOk> {
  return shared.get(opts)
}
