/**
 * 陣列工具（全站單一實作）
 */

/**
 * 把陣列切成每 size 一組（最後一組可能較短）；空陣列回 []。
 * 主要用在 Supabase 批次 upsert / in() 查詢的分批——單次請求有 URL 長度與 payload 上限，
 * 全站慣例是 500 一批。
 *
 * 注意：lib/erpSyncReconcile.ts 保留自己的變體（空陣列回 [[]]，讓對帳流程至少跑一輪），
 * 語意不同，刻意不合併。
 */
export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}
