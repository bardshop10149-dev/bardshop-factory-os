// 包裝專區 P1 分線輪 — D66 手動區塊的組裝與快取（I/O 層，lines.md §六.4）
//
// 使用點：GET board（組裝前併進待排池）、handleApplyRequest（supplyOf／cards）、版本還原（poolLines）、
// D102 GET /api/packaging/pool（待排池頁＝可排卡片的唯一控制台：手動加入的加入／改數量／移出都在那一頁，getPoolPageManual）。
// （舊規格 lines.md §6.4「P0 頁不加手動區塊」已由 D102 推翻；'mn' 區塊在待排池頁由 ManualPoolSection 自己畫，不經過 PoolBlock.tsx。）
//
// 快取：以「待排池 blocks 物件（WeakMap）＋有效紀錄指紋（筆數＋最大 updated_at）」為鍵、最長 120 秒；寫入 API 成功後清掉。
// 為什麼要讓併入後的 pool 物件在內容不變時「同一個參考」：scheduleBoard.poolDigest 以 blocks 陣列做 WeakMap 記憶，
// 每次都產生新陣列就得每 60 秒重算一次整包待排池的 sha1（數百 KB），D52 的 unchanged 省流量也會失效。

import type { PoolResponse } from '@/lib/packaging/types'
import { MANUAL_BLOCK_ID, type ManualInclusionMeta } from '@/lib/packaging/scheduleTypes'
import { computeStdTime, loadStdTimeTables, type StdTimeTables } from '@/lib/packaging/stdTime'
import type { WorkEstimator } from '@/lib/packaging/classify'
import {
  buildManualBlock,
  mergeManualIntoPool,
  normalPoolLineKeys,
  splitManualForPoolPage,
  type PoolManualSection,
} from '@/lib/packaging/manualPool'
import { loadActiveInclusions, loadSoLinesForSos, manualFingerprint } from '@/lib/packaging/manualDb'
import { loadSalesForSos } from '@/lib/packaging/salesSync'
import { loadPlacementsByLines, type SupabaseAdmin } from '@/lib/packaging/scheduleDb'

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

/**
 * D102 待排池頁用：併手動區塊（沿用 getManualMergedPool 的快取與失效機制）＋讀這些行的擺放 → 拆出「已全數完成」。
 * - 快取：手動層靠 invalidateManualCache 世代號（同實例）＋ manualFingerprint（跨實例）→ 寫入後重抓一定拿到新的；
 *   擺放每次都查（完成／排定是工作台隨時在改的，不能吃手動層的 120 秒快取），≤300 行一次查詢，很便宜。
 * - 回傳的 pool 是新物件（blocks 陣列重建、'mn' 換成拆完的區塊）；共用快取物件一律不改。
 * 表不存在（migration 未套用）同 getManualMergedPool 會丟 ScheduleDbError，由路由降級處理。
 */
export async function getPoolPageManual(sb: SupabaseAdmin, pool: PoolOk): Promise<{ pool: PoolOk; section: PoolManualSection }> {
  const merged = await getManualMergedPool(sb, pool)
  const mn = merged.pool.blocks.find((b) => b.id === MANUAL_BLOCK_ID)
  const skipped = { ...merged.skipped }
  if (!mn) return { pool: merged.pool, section: { available: true, error: null, lines: {}, ended: [], skipped } }
  const placements = mn.cards.length > 0 ? await loadPlacementsByLines(sb, mn.cards.map((c) => c.soLineKey)) : []
  const split = splitManualForPoolPage({ block: mn, meta: merged.meta, placements, today: pool.today })
  return {
    pool: { ...merged.pool, blocks: merged.pool.blocks.map((b) => (b.id === MANUAL_BLOCK_ID ? split.block : b)) },
    section: { available: true, error: null, lines: split.lines, ended: split.ended, skipped },
  }
}
