// 包裝專區 — 待排池快取本體（D98 ② stale-while-revalidate；規則說明見 poolCache.ts 檔頭）
//
// 為什麼拆出這個檔：poolCache.ts 要 import next/server 的 after()（Vercel 上讓背景重組撐到做完），
// 而 node --experimental-strip-types 跑單元測試時無法解析 'next/server'（next 套件沒有 exports 對照）。
// 這裡不 import 任何執行環境的東西，build／時鐘／keepAlive 都由呼叫端注入 → 可以直接測；
// 正式程式只透過 poolCache.ts 的 getPool 使用它。

import type { PoolOk } from './pool'

export const POOL_READ_MAX_AGE_MS = 120_000
export const POOL_WRITE_MAX_AGE_MS = 10 * 60_000
/** 讀取時「先給舊資料、背景更新」的年齡上限（＝寫入驗證可接受的年齡） */
export const POOL_STALE_MAX_AGE_MS = POOL_WRITE_MAX_AGE_MS
/** 進行中的重組超過這麼久還沒結束＝視為掛住（實測 4～9 秒；board route 的 maxDuration 是 60 秒） */
export const POOL_BUILD_STUCK_MS = 60_000

export interface PoolCacheDeps {
  build: () => Promise<PoolOk>
  now?: () => number
  /** 讓執行環境在回應送出後繼續等背景重組做完（Vercel：after／waitUntil）；丟錯＝不支援，忽略 */
  keepAlive?: (p: Promise<unknown>) => void
  /** 背景重組失敗（快取維持舊的，下一個讀取再試） */
  onBackgroundError?: (e: unknown) => void
}

export interface PoolCache {
  get: (opts?: { fresh?: boolean; maxAgeMs?: number }) => Promise<PoolOk>
}

export function createPoolCache(deps: PoolCacheDeps): PoolCache {
  const now = deps.now ?? Date.now
  /** at＝產生這份資料的重組「開始」時間（凍結很久才完成的結果不會被當成新資料） */
  let cache: { at: number; data: PoolOk } | null = null
  let flight: { startedAt: number; promise: Promise<PoolOk> } | null = null

  /** 還沒逾時的進行中重組；掛住超過 POOL_BUILD_STUCK_MS 的不算（避免 single-flight 旗標永遠卡著） */
  const liveFlight = (t: number) => (flight && t - flight.startedAt < POOL_BUILD_STUCK_MS ? flight : null)

  const start = (t: number) => {
    const f = { startedAt: t, promise: null as unknown as Promise<PoolOk> }
    // 先登記再開始：build 同步丟錯時，finally 才認得出「這一個」並清掉，不會留下一個已失敗卻佔著位子的 flight
    flight = f
    f.promise = (async () => {
      try {
        const data = await deps.build()
        // 較早開始、較晚完成（例：被凍結過）的結果不蓋掉較新的
        if (!cache || f.startedAt >= cache.at) cache = { at: f.startedAt, data }
        return data
      } finally {
        if (flight === f) flight = null
      }
    })()
    return f
  }

  const refreshInBackground = (t: number) => {
    if (liveFlight(t)) return
    const f = start(t)
    // 背景這一支自己接住錯誤（不可 unhandled rejection）；同一個 promise 若也有同步請求在等，那邊照樣收到錯誤
    const settled = f.promise.then(
      () => undefined,
      (e: unknown) => { deps.onBackgroundError?.(e) },
    )
    try {
      deps.keepAlive?.(settled)
    } catch {
      /* 不在請求範圍（腳本、測試）：不延長，照樣在背景跑 */
    }
  }

  return {
    async get(opts = {}) {
      const t = now()
      const maxAge = opts.maxAgeMs ?? POOL_READ_MAX_AGE_MS
      if (!opts.fresh && cache) {
        const age = t - cache.at
        if (age < maxAge) return { ...cache.data, cached: true }
        // 用 < 而不是 ≤：讀取先給的舊資料，永遠比寫入驗證（age < 10 分鐘才用快取）可接受的新
        if (age < POOL_STALE_MAX_AGE_MS) {
          refreshInBackground(t)
          return { ...cache.data, cached: true }
        }
      }
      return (liveFlight(t) ?? start(t)).promise
    },
  }
}
