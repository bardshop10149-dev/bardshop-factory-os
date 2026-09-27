// 包裝專區 P1 — 供給、分配與拆卡守恆（純函式，規格 §2.3、§3.3、§3.4；D7／D22／D23／D24／D26／D45）
//
// 核心觀念：排程表只存「排了多少到哪天」，不存待排池剩餘量（規格 §1.2）。
// 每次讀取都用「P0 待排池當下的可排供給 S」重新分配給各擺放：
//   S（待排池可排量）＝ U（已勾完成但待排池還沒扣掉的量）＋ Σ 擺放有效量 ＋ 待排池剩餘量
// 所以到貨、塔台報工、ERP 改量都不需要同步程式去改排程表。
//
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum。

import {
  MIN_CARD_MINUTES,
  PLACEABLE_BLOCKS,
  type LineAllocation,
  type LineSupply,
  type Placement,
  type PlacementAllocation,
  type SupplySegment,
  type YMD,
} from './scheduleTypes'
import type { PackagingCard, PoolBlockId } from './types'
import { displayDateOf } from './scheduleCalendar'

/** 數量一律到小數 3 位（DB numeric(14,3)），避免 0.1 + 0.2 這種浮點誤差讓守恆檢查誤判 */
export const r3 = (x: number): number => Math.round(x * 1000) / 1000
const round1 = (x: number): number => Math.round(x * 10) / 10
const EPS = 1e-9

const PLACEABLE_SET: ReadonlySet<string> = new Set(PLACEABLE_BLOCKS)
/** D22：區塊 3（常平未寄出且緊張）、5c（委外出貨待確認）不可排 */
export function isPlaceableBlock(b: PoolBlockId): boolean {
  return PLACEABLE_SET.has(b)
}
const blockRank = (b: PoolBlockId): number => {
  const i = (PLACEABLE_BLOCKS as readonly string[]).indexOf(b)
  return i < 0 ? 99 : i
}
const tsOf = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

/**
 * 規格 §2.3：一條 SO 行的可排供給。每張可排卡拆成 ready 片（qtyReady）與 pending 片（qtyCard − qtyReady，帶 estReadyDate）。
 * 排序：可包片在前（PLACEABLE_BLOCKS 順序、再 cardId）→ 未就緒片依 estReadyDate 升冪、null 最後。
 * perUnit：可排卡 work.perUnit 以 qtyCard 加權平均（全 null → null；沒有可排卡時退用全部卡）。
 */
export function lineSupply(soLineKey: string, cards: readonly PackagingCard[]): LineSupply {
  const placeable = cards.filter((c) => isPlaceableBlock(c.block))
  const ready: SupplySegment[] = []
  const pending: SupplySegment[] = []
  for (const c of placeable) {
    const total = Math.max(0, c.qtyCard)
    const rq = Math.min(total, Math.max(0, c.qtyReady))
    if (rq > 0) ready.push({ cardId: c.cardId, block: c.block, qty: r3(rq), ready: true, estReadyDate: null })
    const pq = r3(total - rq)
    if (pq > 0) pending.push({ cardId: c.cardId, block: c.block, qty: pq, ready: false, estReadyDate: c.estReadyDate ?? null })
  }
  ready.sort((a, b) => blockRank(a.block) - blockRank(b.block) || (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0))
  pending.sort((a, b) => {
    if (a.estReadyDate !== b.estReadyDate) {
      if (a.estReadyDate == null) return 1
      if (b.estReadyDate == null) return -1
      return a.estReadyDate < b.estReadyDate ? -1 : 1
    }
    return blockRank(a.block) - blockRank(b.block) || (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0)
  })
  const segments = [...ready, ...pending]
  const basis = placeable.length > 0 ? placeable : cards
  let wSum = 0, qSum = 0
  for (const c of basis) {
    if (c.work.perUnit != null && c.qtyCard > 0) { wSum += c.work.perUnit * c.qtyCard; qSum += c.qtyCard }
  }
  return {
    soLineKey,
    segments,
    total: r3(segments.reduce((s, x) => s + x.qty, 0)),
    readyTotal: r3(ready.reduce((s, x) => s + x.qty, 0)),
    nonPlaceableQty: r3(cards.filter((c) => !isPlaceableBlock(c.block)).reduce((s, c) => s + Math.max(0, c.qtyCard), 0)),
    perUnit: qSum > 0 ? Math.round((wSum / qSum) * 10000) / 10000 : null,
  }
}

/**
 * 規格 §3.4（D24／D26／D45）：已勾完成、但待排池還沒扣掉的量 U。
 *   C = Σ 完成量；B = 最早一筆完成時記下的 completed_pool_qty（null 視為 S）
 *   drop = max(0, B − S)（第一次勾完成到現在，待排池少了多少＝塔台報工已反映的量）
 *   U = clamp(C − drop, 0, C)
 * 委外（塔台沒有包裝工序）：池不會減 → U＝C；常平／製令之後塔台報工：池減少 → U 跟著變小，不重複扣。
 */
export function unreflectedCompletedQty(completed: readonly Placement[], supplyTotal: number): number {
  const done = completed.filter((p) => p.completed)
  if (done.length === 0) return 0
  const C = r3(done.reduce((s, p) => s + p.qty, 0))
  let earliest = done[0]
  for (const p of done) if (tsOf(p.completed!.at) < tsOf(earliest.completed!.at)) earliest = p
  const B = earliest.completed!.poolQtyAt ?? supplyTotal
  const drop = Math.max(0, B - supplyTotal)
  return r3(Math.min(C, Math.max(0, C - drop)))
}

/** 規格 §3.3 排序：顯示日期升冪、待排區最後、created_at、id */
export function compareOpenPlacements(
  a: { display: YMD | null; p: Placement },
  b: { display: YMD | null; p: Placement },
): number {
  if (a.display !== b.display) {
    if (a.display == null) return 1
    if (b.display == null) return -1
    return a.display < b.display ? -1 : 1
  }
  const t = tsOf(a.p.createdAt) - tsOf(b.p.createdAt)
  if (t !== 0) return t
  return a.p.id < b.p.id ? -1 : a.p.id > b.p.id ? 1 : 0
}

/**
 * 規格 §3.3 allocateLine（D7 拆卡守恆＋D22 預排判定）：
 * 1. U 先從片段扣（可包片先扣——完成的東西一定是已就緒的）
 * 2. 未完成擺放依日期排序；Σqty 超過 E＝S−U 時，從最早的卡開始修剪（最常見原因是塔台已報包裝完工 D45）
 * 3. 依同一順序把剩下的片段分給各卡：先可包片，再依 estReadyDate 的未就緒片
 * 4. 片段剩下的量＝待排池剩餘（remainingByCard）
 * 不變式：Σ open.effectiveQty + U_consumed + remainingTotal = S。
 * 輸出的 placements：先是未完成（依上面順序），後面接已完成（effectiveQty＝qty、ready，只為了畫面顯示）。
 */
export function allocateLine(input: {
  supply: LineSupply
  placements: readonly Placement[]
  today: YMD
  openSats: ReadonlySet<YMD>
}): LineAllocation {
  const { supply, today, openSats } = input
  const open = input.placements.filter((p) => !p.completed)
  const completed = input.placements.filter((p) => !!p.completed)
  const S = supply.total

  const U = unreflectedCompletedQty(completed, S)
  const E = r3(Math.max(0, S - U))

  // 片段剩餘量（可變副本）；U 從最前面（可包片）開始扣
  const left = supply.segments.map((s) => s.qty)
  let uLeft = Math.min(U, S)
  for (let i = 0; i < left.length && uLeft > EPS; i++) {
    const take = Math.min(left[i], uLeft)
    left[i] = r3(left[i] - take)
    uLeft = r3(uLeft - take)
  }

  const ordered = open
    .map((p) => ({ p, display: displayDateOf(p, today, openSats).date }))
    .sort(compareOpenPlacements)

  // 修剪：從最早的卡開始扣
  let over = r3(ordered.reduce((s, x) => s + x.p.qty, 0) - E)
  const effective = ordered.map((x) => {
    if (over <= EPS) return x.p.qty
    const cut = Math.min(x.p.qty, over)
    over = r3(over - cut)
    return r3(x.p.qty - cut)
  })

  const firstPlaceableCard = supply.segments[0]?.cardId ?? null
  let segIdx = 0
  const allocs: PlacementAllocation[] = ordered.map((x, i) => {
    let need = effective[i]
    let readyQty = 0, pendingQty = 0
    let preReadyDate: YMD | null = null
    let unknownEta = false
    const byCard = new Map<string, number>()
    while (need > EPS && segIdx < left.length) {
      if (left[segIdx] <= EPS) { segIdx++; continue }
      const seg = supply.segments[segIdx]
      const take = Math.min(left[segIdx], need)
      left[segIdx] = r3(left[segIdx] - take)
      need = r3(need - take)
      byCard.set(seg.cardId, r3((byCard.get(seg.cardId) ?? 0) + take))
      if (seg.ready) readyQty = r3(readyQty + take)
      else {
        pendingQty = r3(pendingQty + take)
        if (seg.estReadyDate == null) unknownEta = true
        else if (preReadyDate == null || seg.estReadyDate > preReadyDate) preReadyDate = seg.estReadyDate
      }
    }
    // effective ≤ E ≤ 片段剩餘合計，所以 need 應為 0；保險起見不足的部分視為未就緒且可包日未知
    if (need > EPS) { pendingQty = r3(pendingQty + need); unknownEta = true }
    if (unknownEta) preReadyDate = null
    let baseCardId: string | null = null
    let best = -1
    for (const [cid, q] of byCard) if (q > best) { best = q; baseCardId = cid }
    return {
      placementId: x.p.id,
      effectiveQty: effective[i],
      trimmedQty: r3(x.p.qty - effective[i]),
      readyQty,
      pendingQty,
      readiness: pendingQty <= EPS ? 'ready' : unknownEta ? 'pre_unknown' : 'pre',
      preReadyDate: pendingQty <= EPS ? null : preReadyDate,
      baseCardId: baseCardId ?? firstPlaceableCard,
    }
  })

  for (const p of completed) {
    allocs.push({
      placementId: p.id, effectiveQty: p.qty, trimmedQty: 0, readyQty: p.qty, pendingQty: 0,
      readiness: 'ready', preReadyDate: null, baseCardId: p.originCardId ?? firstPlaceableCard,
    })
  }

  const remainingByCard: Record<string, number> = {}
  supply.segments.forEach((s, i) => { remainingByCard[s.cardId] = r3((remainingByCard[s.cardId] ?? 0) + left[i]) })
  const remainingTotal = r3(left.reduce((s, x) => s + x, 0))

  return {
    soLineKey: supply.soLineKey,
    supply,
    unreflectedCompletedQty: U,
    effectiveSupply: E,
    placements: allocs,
    remainingByCard,
    remainingTotal,
  }
}

/**
 * 子卡工時（分鐘）：perUnit 未知 → null；qty ≤ 0 → 0；否則 max(10, round1(perUnit × qty))。
 * 沿用 P0 calcEst「每卡最少 10 分」；拆越多張，最少值的影響越大（規格 §9.1 已知誤差）。
 */
export function minutesForQty(perUnit: number | null, qty: number): number | null {
  if (perUnit == null) return null
  if (qty <= 0) return 0
  return Math.max(MIN_CARD_MINUTES, round1(perUnit * qty))
}
