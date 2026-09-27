// 包裝專區 P1 分線輪 — D66 手動區塊的組裝與快取（I/O 層，lines.md §六.4）
//
// 使用點：GET board（組裝前併進待排池）、handleApplyRequest（supplyOf／cards）、版本還原（poolLines）。
// /api/packaging/pool（P0 唯讀待排池頁）不加手動區塊（PoolBlock.tsx 不能改；P0 頁是唯讀總覽）。
//
// 快取：以「待排池 blocks 物件（WeakMap）＋有效紀錄指紋（筆數＋最大 updated_at）」為鍵、最長 120 秒；寫入 API 成功後清掉。
// 為什麼要讓併入後的 pool 物件在內容不變時「同一個參考」：scheduleBoard.poolDigest 以 blocks 陣列做 WeakMap 記憶，
// 每次都產生新陣列就得每 60 秒重算一次整包待排池的 sha1（數百 KB），D52 的 unchanged 省流量也會失效。

import type { PoolResponse } from '@/lib/packaging/types'
import type { ManualInclusionMeta } from '@/lib/packaging/scheduleTypes'
import { computeStdTime, loadStdTimeTables, type StdTimeTables } from '@/lib/packaging/stdTime'
import type { WorkEstimator } from '@/lib/packaging/classify'
import { buildManualBlock, mergeManualIntoPool, normalPoolLineKeys } from '@/lib/packaging/manualPool'
import { loadActiveInclusions, loadSoLinesForSos, manualFingerprint } from '@/lib/packaging/manualDb'
import { loadSalesForSos } from '@/lib/packaging/salesSync'
import type { SupabaseAdmin } from '@/lib/packaging/scheduleDb'

type PoolOk = Extract<PoolResponse, { success: true }>

export const MANUAL_CACHE_MAX_AGE_MS = 120_000
const STD_TABLES_MAX_AGE_MS = 10 * 60_000

export interface ManualMerged {
  /** 已把 'mn' 區塊放在最前面的待排池（內容不變時是同一個物件） */
  pool: PoolOk
  meta: Record<string, ManualInclusionMeta>
  backInPoolKeys: ReadonlySet<string>
  skipped: { soGone: number; backInPool: number; soldOut: number }
}

let stdTables: { at: number; data: StdTimeTables } | null = null
async function getStdTables(sb: SupabaseAdmin): Promise<StdTimeTables> {
  if (stdTables && Date.now() - stdTables.at < STD_TABLES_MAX_AGE_MS) return stdTables.data
  const data = await loadStdTimeTables(sb)
  stdTables = { at: Date.now(), data }
  return data
}

const memo = new WeakMap<object, { fp: string; at: number; value: ManualMerged }>()
/** 清快取的世代號：寫入 API 成功後 +1，WeakMap 裡舊世代的結果一律視為過期 */
let generation = 0

/** 寫入（加入／改量／移出）成功後呼叫（同一個實例立即生效；其他實例靠指紋與 120 秒過期） */
export function invalidateManualCache(): void {
  generation++
}

/**
 * 待排池併入 D66 手動區塊。
 * 表不存在（migration 未套用）會丟 ScheduleDbError（pgCode PGRST205／42P01），由呼叫端轉成 migration_required 訊息。
 */
export async function getManualMergedPool(sb: SupabaseAdmin, pool: PoolOk): Promise<ManualMerged> {
  const fp = `${generation}|${await manualFingerprint(sb)}`
  const hit = memo.get(pool.blocks)
  // 回傳時換成這次 pool 的其他欄位（cached 等），blocks 陣列沿用同一個參考
  if (hit && hit.fp === fp && Date.now() - hit.at < MANUAL_CACHE_MAX_AGE_MS) return { ...hit.value, pool: { ...pool, blocks: hit.value.pool.blocks } }

  const inclusions = await loadActiveInclusions(sb)
  let value: ManualMerged
  if (inclusions.length === 0) {
    // 沒有手動紀錄：仍放一個空的 'mn' 區塊，畫面可固定顯示「手動加入」與「＋加入訂單」
    const built = buildManualBlock({ inclusions: [], soLines: [], normalLineKeys: new Set(), estimate: () => { throw new Error('unused') }, today: pool.today })
    value = { pool: mergeManualIntoPool(pool, built.block), meta: {}, backInPoolKeys: new Set(), skipped: built.skipped }
  } else {
    const [soLines, tables, soSales] = await Promise.all([
      loadSoLinesForSos(sb, inclusions.map((i) => i.so)),
      getStdTables(sb),
      // D73：這些 SO 的銷貨鏡像（表不存在／讀取失敗 → null，不排除；銷貨變動最多晚 120 秒快取反映）
      loadSalesForSos(sb, inclusions.map((i) => i.so)),
    ])
    const estimate: WorkEstimator = (input) => computeStdTime(input, tables).work
    const built = buildManualBlock({ inclusions, soLines, normalLineKeys: normalPoolLineKeys(pool), estimate, today: pool.today, soSales })
    value = { pool: mergeManualIntoPool(pool, built.block), meta: built.meta, backInPoolKeys: built.backInPoolKeys, skipped: built.skipped }
  }
  memo.set(pool.blocks, { fp, at: Date.now(), value })
  return value
}
