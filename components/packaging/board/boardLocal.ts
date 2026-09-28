// 工作台的「本機暫時狀態」工具：樂觀更新、版本號重算、拖放限制。
//
// 設計取捨：
// - 伺服器才是真相（分配、修剪、產能、延誤都由 GET /api/packaging/board 的 assembleBoard 算）。
//   前端只做「看起來立刻動了」的最小搬移（樂觀更新），佇列清空後一定重抓一次工作台校正。
//   所以這裡不重做 allocateLine 等規則，只搬卡、改數量、重算欄頭已排分鐘。
// - 分線輪起改用 lib/packaging 的純函式（scheduleLines／scheduleMinutes／scheduleCapacity.dayLoad）：
//   自動選線（D72）、工時覆寫換算（D69）、各線負荷顏色要和伺服器同一套規則，拖放後畫面才不會「先跳一條線、重抓又跳回來」。
// - D74 線內順序同理用 lib/packaging/laneOrder.ts：樂觀更新後各欄依同一規則重排（null 在上、其後依 sortIndex），
//   新排入的卡給「現在」的 appendSortIndex（伺服器寫入時用它自己的時間，兩者都比既有的大 → 一樣落在最後）。

import {
  MIN_CARD_MINUTES,
  PLACEABLE_BLOCKS,
  type BoardCard,
  type BoardDay,
  type BoardLane,
  type BoardResponse,
  type DayLoad,
  type EffectiveCapacity,
  type MinutesOverride,
  type PackagingLine,
  type PlacementOp,
  type PoolCardMeta,
  type YMD,
} from '@/lib/packaging/scheduleTypes'
import type { PackagingCard, PoolBlock, PoolBlockId } from '@/lib/packaging/types'
import { dayLoad } from '@/lib/packaging/scheduleCapacity'
import { activeLinesOf, laneRemaining, laneStopped, pickAutoLane, resolveLaneId } from '@/lib/packaging/scheduleLines'
import { effectiveMinutes, mergeOverride, overrideFromEffective, splitOverride } from '@/lib/packaging/scheduleMinutes'
import {
  appendSortIndex, insertIndexAt, planLaneReorder, sortByLaneOrder, stepTarget,
  type ReorderChange, type StepBlock, type StepDir,
} from '@/lib/packaging/laneOrder'
import { laneScale, layoutLane } from '@/lib/packaging/laneTimeline'

export type BoardOk = Extract<BoardResponse, { success: true; unchanged?: false }>

const PLACEABLE = new Set<PoolBlockId>(PLACEABLE_BLOCKS)

export function isPlaceableBlock(b: PoolBlockId): boolean {
  return PLACEABLE.has(b)
}

/** uuid（擺放 id 由前端產生，Undo/Redo 需要以原 id 重建）；舊瀏覽器沒有 randomUUID 時用 getRandomValues 組 v4 */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** 與伺服器 minutesForQty 同規則：perUnit 未知 null；每張子卡最少 10 分 */
export function localMinutes(perUnit: number | null, qty: number): number | null {
  if (perUnit == null) return null
  if (qty <= 0) return 0
  return Math.max(MIN_CARD_MINUTES, Math.round(perUnit * qty * 10) / 10)
}

/** 與伺服器 dayLoad 同規則（欄頭顏色；整天與每條線各算一次） */
export function localDayLoad(used: number, cap: Pick<EffectiveCapacity, 'regularMinutes' | 'overtimeMinutes'>): DayLoad {
  return dayLoad(used, cap)
}

// ─────────────────────────────────────────────────────────────────────
// 分線（D67／D72）
// ─────────────────────────────────────────────────────────────────────

/** 工作台上的線（伺服器舊版沒帶 lines 時為空陣列） */
export function boardLines(d: Pick<BoardOk, 'lines'>): PackagingLine[] {
  return d.lines ?? []
}

/** 啟用中的線（依 sortOrder） */
export function boardActiveLines(d: Pick<BoardOk, 'lines'>): PackagingLine[] {
  return activeLinesOf(boardLines(d))
}

/** 卡片排到某天時實際顯示的線（停用／不存在 → 預設線，同伺服器 resolveLaneId） */
function laneOf(d: BoardOk, lineId: number | null | undefined, planDate: YMD | null): number | null {
  return resolveLaneId(lineId, planDate, boardLines(d), d.defaultLineId ?? null).laneId
}

/**
 * D72 某天沒指定線（拖到日期欄頭、「前一天／後一天」放置區、對話框選「自動」）時放哪條線：
 * 當天各線「剩餘工時」最多的線（pickAutoLane）。
 * moving：被拖的卡本來就在這天時，把它自己的工時加回原線（deltaByLane），避免「因為自己佔著所以跳到別線」。
 * 當天不在畫面上（沒有 lanes）→ fallback（呼叫端決定：沿用原線或預設線）。
 */
export function autoLaneFor(
  day: Pick<BoardDay, 'lanes' | 'cards'> | null | undefined,
  moving: { placementId: string } | null,
  fallback: number | null,
): number | null {
  const lanes = day?.lanes ?? []
  if (!day || lanes.length === 0) return fallback
  const own = moving ? day.cards.find(c => c.placementId === moving.placementId) : undefined
  const delta = own && own.laneId != null && own.minutes != null ? new Map([[own.laneId, own.minutes]]) : undefined
  return pickAutoLane(
    // stopped：明確填 0 h 的線（停工）排在 unset 之後，不收自動放入的卡
    lanes.map(l => ({ lineId: l.lineId, sortOrder: l.sortOrder, remainingMinutes: l.remainingMinutes, stopped: laneStopped(l.capacity) })),
    { deltaByLane: delta },
  ) ?? fallback
}

/** 拖放目標 id 解析：lane:${date}:${lineId}／day:${date}／holding／pool */
export type DropTarget =
  | { kind: 'lane'; date: YMD; lineId: number }
  | { kind: 'day'; date: YMD }
  | { kind: 'holding' }
  | { kind: 'pool' }

export function parseDropId(id: string): DropTarget | null {
  if (id === 'holding') return { kind: 'holding' }
  if (id === 'pool') return { kind: 'pool' }
  if (id.startsWith('day:')) return { kind: 'day', date: id.slice(4) }
  if (id.startsWith('lane:')) {
    // 日期是 YYYY-MM-DD（不含冒號），最後一段是線 id
    const rest = id.slice(5)
    const i = rest.lastIndexOf(':')
    const lineId = Number(rest.slice(i + 1))
    if (i > 0 && Number.isInteger(lineId)) return { kind: 'lane', date: rest.slice(0, i), lineId }
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────
// 工時覆寫（D69）
// ─────────────────────────────────────────────────────────────────────

/**
 * 卡片目前的覆寫值「以本列 qty 為準」（DB 存的量）；沒有覆寫 null。
 * BoardCard.minutesOverride.minutes 是伺服器依有效數量等比換算後的值，要換回 qty 基準。
 */
export function storedOverrideOf(c: Pick<BoardCard, 'qty' | 'effectiveQty' | 'minutesOverride'>): number | null {
  if (!c.minutesOverride) return null
  return overrideFromEffective(c.minutesOverride.minutes, c.qty, c.effectiveQty)
}

/** 工作台上所有擺放卡（日期欄＋待排區） */
export function allBoardCards(d: BoardOk): BoardCard[] {
  return [...d.days.flatMap(x => x.cards), ...d.holding]
}

export function findBoardCard(d: BoardOk, placementId: string): BoardCard | null {
  for (const day of d.days) for (const c of day.cards) if (c.placementId === placementId) return c
  for (const c of d.holding) if (c.placementId === placementId) return c
  return null
}

export function findPoolCard(d: BoardOk, cardId: string): PackagingCard | null {
  for (const b of d.pool.blocks) for (const c of b.cards) if (c.cardId === cardId) return c
  return null
}

// ─────────────────────────────────────────────────────────────────────
// 拖放限制（D22）：伺服器仍會再驗一次，這裡只是讓不能放的欄在拖曳時直接變灰
// ─────────────────────────────────────────────────────────────────────

export interface DragRule {
  /** 完全不能排（區塊 3／5c） */
  blocked: boolean
  /** 最早可放的日期（預排卡的預估可包日）；null＝不限 */
  minDate: YMD | null
  reason: string | null
}

export function ruleForPoolCard(card: PackagingCard): DragRule {
  if (!isPlaceableBlock(card.block)) {
    return { blocked: true, minDate: null, reason: '此區塊不預排（未寄出／出貨待確認），僅提醒' }
  }
  // 有未就緒的量且知道預估可包日 → 整張排出去會變預排卡，不能早於預估可包日（D22）
  if (card.qtyReady < card.qtyCard && card.estReadyDate) {
    return { blocked: false, minDate: card.estReadyDate, reason: `預估 ${md(card.estReadyDate)} 才可包` }
  }
  return { blocked: false, minDate: null, reason: null }
}

export function ruleForBoardCard(c: BoardCard): DragRule {
  if (c.completed) return { blocked: true, minDate: null, reason: '已完成的卡要先取消完成才能移動' }
  if (c.readiness === 'pre' && c.preReadyDate) {
    return { blocked: false, minDate: c.preReadyDate, reason: `預估 ${md(c.preReadyDate)} 才可包` }
  }
  return { blocked: false, minDate: null, reason: null }
}

/** 拖曳中這一天能不能放（D22 預排卡早於預估可包日、區塊 3／5c）；可放回 null。伺服器仍會再驗一次 */
export function dropBlockedReason(rule: DragRule | null, date: string | null): string | null {
  if (!rule) return null
  if (rule.blocked) return rule.reason ?? '不能排'
  if (date && rule.minDate && date < rule.minDate) return rule.reason ?? `預估 ${md(rule.minDate)} 才可包`
  return null
}

/** 同欄同 SO 行有 ≥ 2 張未完成子卡 → 可合併 */
export function mergeCandidates(cards: BoardCard[], bc: BoardCard): BoardCard[] {
  if (bc.completed) return []
  return cards.filter(c => c.placementId !== bc.placementId && c.soLineKey === bc.soLineKey && !c.completed)
}

function md(ymd: string): string {
  const m = ymd.match(/^\d{4}-(\d{2})-(\d{2})/)
  return m ? `${Number(m[1])}/${Number(m[2])}` : ymd
}

// ─────────────────────────────────────────────────────────────────────
// 版本號重算（送出前）
// ─────────────────────────────────────────────────────────────────────

/**
 * 依「目前已知的伺服器版本」改寫 ops 裡的 version，並在同一批內模擬每一步 +1。
 *
 * 為什麼需要：伺服器回的 inverse 帶的是「那一刻」的版本。同一張卡連續操作兩次後 Undo 兩次時，
 * 第二次 Undo 帶的仍是舊版本 → 必定 version_conflict。編輯鎖保證只有自己在寫，
 * 所以用「最後一次讀到／寫入回應的版本」重算是安全的；若真的有別人改過（例如自己另一個分頁在接手前的殘留請求），
 * 已知版本仍會和資料庫不同，伺服器照樣擋下。
 */
export function rebaseOpVersions(ops: PlacementOp[], known: ReadonlyMap<string, number>): PlacementOp[] {
  const sim = new Map<string, number>()
  const cur = (id: string, fallback: number) => sim.get(id) ?? known.get(id) ?? fallback
  const out: PlacementOp[] = []
  for (const op of ops) {
    switch (op.op) {
      case 'place':
        sim.set(op.id, 1)
        out.push(op)
        break
      case 'restore':
        sim.set(op.row.id, 1)
        out.push(op)
        break
      case 'move':
      case 'setQty':
      case 'complete':
      case 'uncomplete':
      case 'setMinutes':
      case 'reorder': {
        const v = cur(op.id, op.version)
        sim.set(op.id, v + 1)
        out.push({ ...op, version: v })
        break
      }
      case 'unplace': {
        const v = cur(op.id, op.version)
        sim.delete(op.id)
        out.push({ ...op, version: v })
        break
      }
      case 'split': {
        const v = cur(op.id, op.version)
        sim.set(op.id, v + 1)
        for (const p of op.parts) sim.set(p.id, 1)
        out.push({ ...op, version: v })
        break
      }
      case 'merge': {
        const tv = cur(op.targetId, op.targetVersion)
        sim.set(op.targetId, tv + 1)
        const sources = op.sources.map(s => ({ id: s.id, version: cur(s.id, s.version) }))
        for (const s of op.sources) sim.delete(s.id)
        out.push({ ...op, targetVersion: tv, sources })
        break
      }
      default: {
        // 漏加新 op 時編譯期就會報錯（never），不會像以前一樣悄悄丟掉操作（lines.md §3.8）
        const unknownOp: never = op
        out.push(unknownOp)
      }
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────
// 樂觀更新
// ─────────────────────────────────────────────────────────────────────

export type LocalAction =
  /** lineId：toDate 非 null 時的線（前端已決定好的明確值，D72） */
  | { t: 'place'; id: string; qty: number; toDate: YMD | null; poolCard: PackagingCard; lineId: number | null }
  /**
   * lineId 省略＝沿用原線（同伺服器 move）。
   * sortIndex 省略＝同伺服器規則（換到別的天×線放最後、顯示位置沒變保留、進待排區清空）；有帶＝直接用
   */
  | { t: 'move'; id: string; toDate: YMD | null; lineId?: number | null; sortIndex?: number | null }
  | { t: 'unplace'; id: string }
  /** lineId：待排區的卡勾完成時放哪條線（伺服器省略＝預設線） */
  | { t: 'complete'; id: string; by: string; byName: string | null; atIso: string; lineId?: number | null }
  | { t: 'uncomplete'; id: string }
  /** parts[].lineId 省略＝同原卡的線 */
  | { t: 'split'; id: string; keepQty: number; parts: { id: string; qty: number; toDate: YMD | null; lineId?: number | null }[] }
  | { t: 'merge'; targetId: string; sourceIds: string[] }
  /** D69 改工時：minutes＝以本列 qty 為準的覆寫值（null＝回到標準估計） */
  | { t: 'setMinutes'; id: string; minutes: number | null; by: string; byName: string | null; atIso: string }
  /** D74 線內上下排序：只改 sortIndex，各欄重排後就是新順序 */
  | { t: 'reorder'; id: string; sortIndex: number | null }

/** D74 樂觀更新用的「放在該線最後」（伺服器會用寫入當下的時間，兩者都比既有的大） */
function localAppend(seq = 0): number {
  return appendSortIndex(new Date().toISOString(), seq)
}

/**
 * 改數量（拆卡、合併）後的卡：override＝新數量下「以 qty 為準」的覆寫值（null＝標準估計）。
 * 本機暫時把有效數量視為儲存數量（修剪要伺服器重算），所以覆寫值就是顯示的工時。
 */
function withQty(c: BoardCard, qty: number, override: number | null): BoardCard {
  const std = localMinutes(c.card.work.perUnit, qty)
  const minutes = override ?? std
  const mo: MinutesOverride | null = override == null ? null
    : { minutes: override, by: c.minutesOverride?.by ?? '', byName: c.minutesOverride?.byName ?? null, at: c.minutesOverride?.at ?? '' }
  return {
    ...c,
    qty,
    effectiveQty: qty,
    readyQty: Math.min(c.readyQty, qty),
    minutes,
    minutesStd: std,
    minutesOverride: mo,
    card: { ...c.card, qtyCard: qty, qtyReady: Math.min(c.card.qtyReady, qty), work: { ...c.card.work, qtyBasis: qty, minutes } },
  }
}

/** 把一張待排池卡轉成暫時的擺放卡（等伺服器重抓時換成正式資料） */
function tempCardFromPool(
  id: string, qty: number, toDate: YMD | null, pc: PackagingCard,
  lineId: number | null, laneId: number | null, meta: PoolCardMeta | undefined,
): BoardCard {
  const ready = pc.qtyReady >= qty
  const minutes = localMinutes(pc.work.perUnit, qty)
  const readyQty = Math.min(pc.qtyReady, qty)
  return {
    placementId: id,
    version: 1,
    soLineKey: pc.soLineKey,
    qty,
    effectiveQty: qty,
    planDate: toDate,
    displayDate: toDate,
    originalDate: toDate,
    delayWorkdays: 0,
    readiness: ready ? 'ready' : pc.estReadyDate ? 'pre' : 'pre_unknown',
    readyQty,
    preReadyDate: ready ? null : pc.estReadyDate,
    minutes,
    split: null,
    completed: null,
    source: 'manual',
    flags: [],
    card: { ...pc, qtyCard: qty, qtyReady: readyQty, split: null, work: { ...pc.work, qtyBasis: qty, minutes } },
    lineId: toDate == null ? null : lineId,
    laneId: toDate == null ? null : laneId,
    minutesStd: minutes,
    minutesOverride: null,
    manual: meta?.manual ?? null,
    // D74：新排入的卡放在該線最後；待排區沒有順序
    sortIndex: toDate == null ? null : localAppend(),
  }
}

/** 各線負荷（同伺服器 assembleBoard：D108 已完成不佔工時、不含工時未知） */
function recomputeLane(lane: BoardLane, cards: BoardCard[]): BoardLane {
  let used = 0
  let open = 0
  let unknown = 0
  let count = 0
  for (const c of cards) {
    if (c.laneId !== lane.lineId) continue
    count++
    if (c.minutes == null) { unknown++; continue }
    if (c.completed) continue  // D108：勾完成的卡不佔工時
    used += c.minutes
    open += c.minutes
  }
  used = Math.round(used * 10) / 10
  return {
    ...lane,
    cardCount: count,
    usedMinutes: used,
    openMinutes: Math.round(open * 10) / 10,
    unknownMinutesCards: unknown,
    load: localDayLoad(used, lane.capacity),
    remainingMinutes: laneRemaining(lane.capacity, used),
  }
}

function recomputeDay(day: BoardDay, cards: BoardCard[]): BoardDay {
  let used = 0
  let open = 0
  let unknown = 0
  for (const c of cards) {
    if (c.minutes == null) { unknown++; continue }
    if (c.completed) continue  // D108：勾完成的卡不佔工時
    used += c.minutes
    open += c.minutes
  }
  return {
    ...day,
    cards,
    usedMinutes: used,
    openMinutes: open,
    unknownMinutesCards: unknown,
    load: localDayLoad(used, day.capacity),
    rolledInCount: cards.filter(c => c.flags.some(f => f.code === 'delayed')).length,
    lanes: day.lanes?.map(l => recomputeLane(l, cards)),
  }
}

/** 從待排池扣掉排出去的量（剩 0 的卡移除，區塊合計重算） */
function takeFromPool(d: BoardOk, cardId: string, qty: number): Pick<BoardOk['pool'], 'blocks' | 'cardMeta'> {
  const blocks: PoolBlock[] = d.pool.blocks.map(b => {
    const idx = b.cards.findIndex(c => c.cardId === cardId)
    if (idx < 0) return b
    const c = b.cards[idx]
    const left = Math.max(0, c.qtyCard - qty)
    const cards = [...b.cards]
    const oldMin = c.work.minutes ?? 0
    let newMin = 0
    if (left <= 0) {
      cards.splice(idx, 1)
    } else {
      const minutes = localMinutes(c.work.perUnit, left)
      newMin = minutes ?? 0
      cards[idx] = { ...c, qtyCard: left, qtyReady: Math.min(c.qtyReady, left), work: { ...c.work, qtyBasis: left, minutes } }
    }
    return {
      ...b,
      cards,
      cardCount: cards.length,
      totalMinutes: Math.max(0, b.totalMinutes - oldMin + newMin),
    }
  })
  const prev: PoolCardMeta | undefined = d.pool.cardMeta[cardId]
  const cardMeta = prev
    ? { ...d.pool.cardMeta, [cardId]: { ...prev, placedQty: prev.placedQty + qty, remainingQty: Math.max(0, prev.remainingQty - qty) } }
    : d.pool.cardMeta
  return { blocks, cardMeta }
}

/**
 * 在本機套用一個動作。回傳新的 BoardOk（不改原物件）；找不到卡時原樣回傳。
 * 放回待排池（unplace）只把卡從日期欄拿掉，待排池的數量等重抓後才回來——前端不重算分配。
 */
export function applyLocal(d: BoardOk, a: LocalAction): BoardOk {
  let cards = allBoardCards(d)
  let pool = d.pool
  switch (a.t) {
    case 'place': {
      const laneId = laneOf(d, a.lineId, a.toDate)
      cards = [...cards, tempCardFromPool(a.id, a.qty, a.toDate, a.poolCard, a.lineId, laneId, d.pool.cardMeta[a.poolCard.cardId])]
      pool = { ...pool, ...takeFromPool(d, a.poolCard.cardId, a.qty) }
      break
    }
    case 'move':
      cards = cards.map(c => {
        if (c.placementId !== a.id) return c
        const lineId = a.toDate == null ? null : a.lineId !== undefined ? a.lineId : (c.lineId ?? null)
        const laneId = laneOf(d, lineId, a.toDate)
        // D74：同伺服器 applyOps move 的規則
        const sortIndex = a.toDate == null ? null
          : a.sortIndex !== undefined ? a.sortIndex
            : a.toDate === c.displayDate && lineId === (c.lineId ?? null) ? (c.sortIndex ?? null) : localAppend()
        return {
          ...c,
          sortIndex,
          planDate: a.toDate,
          displayDate: a.toDate,
          originalDate: c.originalDate ?? a.toDate,
          delayWorkdays: 0,
          source: 'manual',
          lineId,
          laneId,
          // 主管挪過就不再是延誤／非工作日（D50）；換到啟用中的線就不再是「線已停用」；其他警示等重抓再算
          flags: c.flags.filter(f => f.code !== 'delayed' && f.code !== 'off_board_day' && (f.code !== 'line_inactive' || laneId !== lineId)),
        }
      })
      break
    case 'unplace':
      cards = cards.filter(c => c.placementId !== a.id)
      break
    case 'complete':
      cards = cards.map(c => {
        if (c.placementId !== a.id) return c
        // 待排區卡勾完成：伺服器排到 rollTarget，線＝lineId（省略＝預設線）
        const fromHolding = c.planDate == null
        const lineId = fromHolding ? (a.lineId ?? d.defaultLineId ?? null) : (c.lineId ?? null)
        const planDate = c.planDate == null || c.planDate < d.today ? d.rollTarget : c.planDate
        return {
          ...c,
          // D74：待排區卡勾完成＝排進 rollTarget 那條線 → 放最後
          sortIndex: fromHolding ? localAppend() : (c.sortIndex ?? null),
          completed: { at: a.atIso, by: a.by, byName: a.byName, poolQtyAt: null },
          // 延誤卡／待排區卡勾完成 → 伺服器改到 rollTarget（實際完成日）
          displayDate: c.displayDate ?? d.rollTarget,
          planDate,
          delayWorkdays: 0,
          lineId,
          laneId: fromHolding ? laneOf(d, lineId, planDate) : c.laneId,
          flags: c.flags.filter(f => f.code !== 'delayed'),
        }
      })
      break
    case 'uncomplete':
      cards = cards.map(c => c.placementId !== a.id ? c : { ...c, completed: null })
      break
    case 'split': {
      const orig = cards.find(c => c.placementId === a.id)
      if (!orig) return d
      // D69 規則 2：原卡有覆寫 → 依數量比例分給各張（同伺服器 splitOverride）
      const ov = splitOverride(storedOverrideOf(orig), orig.qty, a.keepQty, a.parts.map(p => p.qty))
      const parts = a.parts.map((p, i) => {
        const lineId = p.toDate == null ? null : p.lineId !== undefined ? p.lineId : (orig.lineId ?? null)
        return {
          ...withQty(orig, p.qty, ov.parts[i] ?? null),
          placementId: p.id,
          version: 1,
          planDate: p.toDate,
          displayDate: p.toDate,
          lineId,
          laneId: laneOf(d, lineId, p.toDate),
          flags: orig.flags.filter(f => f.code !== 'delayed' || p.toDate === orig.displayDate),
          // D74：拆出的新卡放在該線最後
          sortIndex: p.toDate == null ? null : localAppend(i),
        }
      })
      cards = [...cards.map(c => c.placementId === a.id ? withQty(c, a.keepQty, ov.keep) : c), ...parts]
      break
    }
    case 'merge': {
      const target = cards.find(c => c.placementId === a.targetId)
      if (!target) return d
      const src = cards.filter(c => a.sourceIds.includes(c.placementId))
      const total = target.qty + src.reduce((n, c) => n + c.qty, 0)
      // D69 規則 3：任一張有覆寫 → 合併後覆寫＝各張有效覆寫或標準值加總（同伺服器 mergeOverride）
      const merged = mergeOverride(
        { qty: target.qty, override: storedOverrideOf(target) },
        src.map(c => ({ qty: c.qty, override: storedOverrideOf(c) })),
        target.card.work.perUnit,
      )
      cards = cards
        .filter(c => !a.sourceIds.includes(c.placementId))
        .map(c => c.placementId === a.targetId ? withQty(c, total, merged) : c)
      break
    }
    case 'setMinutes':
      cards = cards.map(c => {
        if (c.placementId !== a.id) return c
        const perUnit = c.card.work.perUnit
        const eff = effectiveMinutes({ qty: c.qty, effectiveQty: c.effectiveQty, override: a.minutes, perUnit })
        return {
          ...c,
          minutes: eff,
          minutesStd: c.minutesStd ?? localMinutes(perUnit, c.effectiveQty),
          minutesOverride: a.minutes == null || eff == null ? null : { minutes: eff, by: a.by, byName: a.byName, at: a.atIso },
          card: { ...c.card, work: { ...c.card.work, minutes: eff } },
        }
      })
      break
    case 'reorder':
      cards = cards.map(c => (c.placementId === a.id ? { ...c, sortIndex: a.sortIndex } : c))
      break
  }

  // 依 displayDate 重新分配到各欄；視窗外（之後的日期）暫時算進 later
  const byDate = new Map<string, BoardCard[]>()
  const holding: BoardCard[] = []
  let laterAdd = 0
  const inWindow = new Set(d.days.map(x => x.date))
  for (const c of cards) {
    if (c.displayDate == null) { holding.push(c); continue }
    if (!inWindow.has(c.displayDate)) { laterAdd++; continue }
    const arr = byDate.get(c.displayDate) ?? []
    arr.push(c)
    byDate.set(c.displayDate, arr)
  }
  // D74：各欄依線內順序重排（穩定排序：sortIndex 為 null 或相同的卡保留伺服器排好的固定排序）；重抓後以伺服器為準
  const days = d.days.map(day => recomputeDay(day, sortByLaneOrder(byDate.get(day.date) ?? [])))
  return {
    ...d,
    days,
    holding,
    pool,
    later: laterAdd > 0 ? { ...d.later, count: d.later.count + laterAdd } : d.later,
  }
}

// ─────────────────────────────────────────────────────────────────────
// D74 線內上下排序（D100 起：日／週／兩週檢視拖曳，與卡片詳情的上移／下移共用）
//   插入點：日檢視＝時間尺版面（laneDropPlan）、週／兩週＝DOM 量到的清單位置（multiDayDropPlan），兩者都走 planLaneDrop；
//   要改哪些 sort_index：一律 laneOrder.planLaneReorder（拖曳＝laneReorderChanges、按鈕＝laneStepPlan）。
// ─────────────────────────────────────────────────────────────────────

/** 某天某條線的卡（順序＝day.cards；不在任何 lane 的卡歸第一條線，同 DayLanesView） */
export function laneCardsOf(day: Pick<BoardDay, 'cards' | 'lanes'>, laneId: number): BoardCard[] {
  const lanes = day.lanes ?? []
  if (lanes.length === 0) return []
  const ids = new Set(lanes.map(l => l.lineId))
  const first = lanes[0].lineId
  return day.cards.filter(c => (c.laneId != null && ids.has(c.laneId) ? c.laneId : first) === laneId)
}

/**
 * 拖曳到日檢視某條線時「會放在哪裡」（插入線的位置與放下後排在哪張卡之前）。
 * moving：被拖的排定卡（同一條線內＝重排，它自己不算插入點）；待排池卡或別條線的卡＝null（放到最後，D74）。
 * yBodyPx：游標相對於該線時間軸本體頂端的 y；null＝不看位置、一律放最後。
 * 卡片版面與 DayLanesView 相同（全部卡含已完成一起疊；隱藏已完成時它們照樣佔位，只是不能當插入點）。
 * 延誤卡釘在最上面（laneOrder.ts）：插入點不能在延誤卡上面，游標在那裡時插入線畫在最後一張延誤卡下面。
 */
export function laneDropPlan(
  day: Pick<BoardDay, 'cards' | 'lanes'>,
  laneId: number,
  movingId: string | null,
  yBodyPx: number | null,
  hideCompleted: boolean,
): LaneDropPlan {
  const lane = day.lanes?.find(l => l.lineId === laneId)
  const cards = laneCardsOf(day, laneId)
  if (!lane || cards.length === 0) return { beforeId: null, topPx: 0, index: 0, visibleCount: 0 }
  const layouts = layoutLane(cards.map(c => ({ placementId: c.placementId, minutes: c.minutes })), laneScale(lane.capacity))
  return planLaneDrop(cards, layouts, movingId, yBodyPx, hideCompleted)
}

export interface LaneDropPlan {
  /** 放在哪張卡之前（null＝最後） */
  beforeId: string | null
  /** 插入線位置（與 layouts 同一個座標系：日檢視＝時間軸本體內 px；多日檢視＝client 座標，畫面不用它） */
  topPx: number
  /** 插在第幾個「看得到的卡」之前（0 起算；＋1＝放下後是第幾張） */
  index: number
  visibleCount: number
  /**
   * D100（只有週／兩週的 multiDayDropPlan 會設）：插入點就是被拖的卡自己目前的位置（看得到的順序沒變）＝放回原位、不送。
   * 為什麼要另外標：隱藏已完成時，完成卡在清單裡不畫也不佔位；被拖的卡正下方若是看不到的完成卡，beforeId 會是「下一張看得到的卡」，
   *   交給 laneReorderChanges 就變成「排到那張完成卡之後」→ 畫面看起來原位、卻送出寫入（延誤卡還會被 replan＝解除延誤）。
   *   日檢視（時間尺）的完成卡照樣佔位、空位看得到，插入線畫在空位下方＝真的會越過它 → 不標，維持 D74 原行為。
   */
  stay?: boolean
}

/** 一張卡在畫面上的位置（日檢視：layoutLane 算的；多日檢視：DOM 量的 getBoundingClientRect） */
export interface LaneRect {
  topPx: number
  heightPx: number
}

/**
 * D100 插入點的通用算法（日檢視 laneDropPlan、多日檢視 multiDayDropPlan 共用）：座標系由呼叫端決定，這裡只比大小。
 * layouts 與 cards 一一對應；null＝畫面上沒有這張（隱藏、沒畫出來、量不到）→ 不當插入點。
 * 被拖的卡自己、隱藏的已完成卡不當插入點；延誤卡釘在最上面（插入點夾到最後一張延誤卡之後）。
 * 為什麼抽出來而不是另寫一份多日版：兩種檢視只差在「卡片在哪裡」（時間尺 vs 清單），夾延誤卡、排除自己等規則要一模一樣。
 */
export function planLaneDrop(
  cards: readonly Pick<BoardCard, 'placementId' | 'completed' | 'delayWorkdays'>[],
  layouts: readonly (LaneRect | null | undefined)[],
  movingId: string | null,
  y: number | null,
  hideCompleted: boolean,
): LaneDropPlan {
  const visible: { c: (typeof cards)[number]; l: LaneRect }[] = []
  cards.forEach((c, i) => {
    const l = layouts[i]
    if (l && c.placementId !== movingId && !(hideCompleted && c.completed)) visible.push({ c, l })
  })
  let pinned = visible.findIndex(x => !isPinned(x.c))
  if (pinned < 0) pinned = visible.length
  const index = y == null || movingId == null
    ? visible.length
    : Math.max(pinned, insertIndexAt(visible.map(x => ({ topPx: x.l.topPx, heightPx: x.l.heightPx })), y))
  const at = visible[index]
  const last = visible[visible.length - 1]
  return {
    beforeId: at ? at.c.placementId : null,
    topPx: at ? at.l.topPx : last ? last.l.topPx + last.l.heightPx : 0,
    index,
    visibleCount: visible.length,
  }
}

/**
 * D100 週／兩週檢視（清單排版，卡高與工時無關）：rects＝DOM 量到的每張卡位置（client 座標、已含捲動），y＝游標 clientY。
 * 被拖的卡以半透明留在原處也沒關係：它不當插入點（planLaneDrop 排除 movingId）。
 * stay：插入點＝被拖的卡目前在「看得到的卡」中的位置 → 放回原位（見 LaneDropPlan.stay；呼叫端用 ownLaneDropChanges）。
 */
export function multiDayDropPlan(
  day: Pick<BoardDay, 'cards' | 'lanes'>,
  laneId: number,
  movingId: string | null,
  rects: ReadonlyMap<string, LaneRect>,
  clientY: number | null,
  hideCompleted: boolean,
): LaneDropPlan {
  const cards = laneCardsOf(day, laneId)
  const plan = planLaneDrop(cards, cards.map(c => rects.get(c.placementId) ?? null), movingId, clientY, hideCompleted)
  const mi = movingId == null ? -1 : cards.findIndex(c => c.placementId === movingId)
  if (mi < 0) return plan
  // 排在被拖的卡上面、當得了插入點的卡數（條件同 planLaneDrop 的 visible）＝它自己那格的插入位置
  const own = cards.slice(0, mi).filter(c => rects.has(c.placementId) && !(hideCompleted && c.completed)).length
  return plan.index === own ? { ...plan, stay: true } : plan
}

/**
 * D100 拖回自己那條線放下時要送的 sort_index 變更：放回原位（plan.stay）＝不送；其餘＝laneReorderChanges（D74）。
 * 正式區 BoardLayout.onDragEnd 用；模擬區同樣先看 stay 再交給 simLaneReorder。
 */
export function ownLaneDropChanges(
  day: Pick<BoardDay, 'cards' | 'lanes'>,
  laneId: number,
  movingId: string,
  plan: Pick<LaneDropPlan, 'beforeId' | 'stay'>,
): ReorderChange[] {
  return plan.stay ? [] : laneReorderChanges(day, laneId, movingId, plan.beforeId)
}

/**
 * D100 日檢視插入線畫在哪（本體內 px）：「放在 beforeId 之前」的位置（null＝最後一張看得到的卡底部）。
 * 模擬區實際落點和游標算出的不同時（被夾到固定在最上面的唯讀卡之後，simBoard.simLaneReorder），用它把插入線畫到實際落點。
 */
export function laneLineTopPx(
  day: Pick<BoardDay, 'cards' | 'lanes'>,
  laneId: number,
  movingId: string | null,
  beforeId: string | null,
  hideCompleted: boolean,
): number {
  const lane = day.lanes?.find(l => l.lineId === laneId)
  const cards = laneCardsOf(day, laneId)
  if (!lane || cards.length === 0) return 0
  const layouts = layoutLane(cards.map(c => ({ placementId: c.placementId, minutes: c.minutes })), laneScale(lane.capacity))
  let lastBottom = 0
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]
    if (c.placementId === movingId || (hideCompleted && c.completed)) continue
    if (c.placementId === beforeId) return layouts[i].topPx
    lastBottom = layouts[i].topPx + layouts[i].heightPx
  }
  return lastBottom
}

/**
 * D100 放下的目標是不是「被拖的卡自己那條線」（同一天、同一條顯示中的線）→ 走線內重排，不是移動。
 * D74 只在日檢視成立；週／兩週拖回自己那格原本會變成 move 到同日同線 → moveCard 直接 return，畫面沒反應（Snow 回報「拖不動」）。
 * 延誤卡以 displayDate（目前顯示的那天）比對：拖回原位＝不送、延誤照舊（同 D74）；拖到別的位置＝replan。
 */
export function isOwnLaneDrop(bc: Pick<BoardCard, 'displayDate' | 'laneId'>, target: DropTarget): boolean {
  return target.kind === 'lane' && bc.displayDate === target.date && bc.laneId === target.lineId
}

/** 延誤卡（D50 順延進來、還沒被主管重排）：釘在最上面、不看 sortIndex（laneOrder.effectiveSortIndex） */
export const isPinned = (c: Pick<BoardCard, 'delayWorkdays' | 'completed'>): boolean => !c.completed && c.delayWorkdays > 0

/**
 * D100 延誤卡在自己那條線換位置（拖曳或上移／下移）一定送 move（排到目前顯示的那天＝解除延誤，D74），伺服器會對 move 驗 D22；
 * 這張又是預排卡、預估可包日在顯示日之後 → 必回 before_est_ready（整批回滾）。回傳原因＝不能在線內調整順序（null＝可以）。
 * 會出現在：排定後預估可包日又延後、卡又順延進今天。一般卡（非延誤）換位置只送 reorder、不驗 D22，不受影響。
 * 用在：卡片詳情的上移／下移（laneStepPlan）、拖曳時要不要把自己那格當「同線重排」而免 D22 遮罩（BoardLayout／SimLayout 的 ownLaneKey）。
 */
export function laneReplanBlockedReason(c: Pick<BoardCard, 'delayWorkdays' | 'completed' | 'readiness' | 'preReadyDate' | 'displayDate'>): string | null {
  if (!isPinned(c) || c.readiness !== 'pre' || !c.preReadyDate || !c.displayDate || c.displayDate >= c.preReadyDate) return null
  return `延誤卡調整順序＝改排到 ${md(c.displayDate)}（解除延誤），但這張是預排卡、預估 ${md(c.preReadyDate)} 才可包（D22），不能排在那之前；請用「移到…」排到 ${md(c.preReadyDate)} 或之後`
}

// ─────────────────────────────────────────────────────────────────────
// D100 卡片詳情「上移／下移」（正式區、模擬區共用；與拖曳同一套 planLaneReorder）
// ─────────────────────────────────────────────────────────────────────

export type LaneStepCode = StepBlock | 'completed' | 'pre_ready'

/** 上移／下移不能按的原因（按鈕 title 與停用時的小字；手機沒有 hover，兩個都停用時要直接顯示） */
export const LANE_STEP_REASON: Record<LaneStepCode, string> = {
  missing: '這張卡不在這條線上（已移走或不在畫面上）',
  completed: '已完成的卡不調整順序（要先取消完成）',
  pinned: '延誤卡固定在最上面；按「下移」可解除延誤並往下排一格',
  first: '已經是這條線的第一張（延誤卡固定在最上面，不能排到它上面）',
  last: '已經是這條線的最後一張',
  // 實際顯示用 laneReplanBlockedReason 帶日期的版本；這裡是沒有日期時的通用說法
  pre_ready: '延誤的預排卡還沒到預估可包日，調整順序會解除延誤並改排到今天（D22 不允許）',
}

export type LaneStepResult =
  | {
    ok: true
    beforeId: string | null
    changes: ReorderChange[]
    /** 移動後是這條線看得到的卡中的第幾張（1 起算；寫在操作標籤「A 線 第 n 張」） */
    position: number
    total: number
  }
  | { ok: false; code: LaneStepCode; reason: string }

/**
 * 卡片詳情按一下「上移／下移」要送什麼（D100）：stepTarget 找目標 → laneReorderChanges（＝拖到那個位置）。
 * hideCompleted：隱藏的已完成卡不當錨點（照樣參與編號，同拖曳）。
 * 延誤＋預排、還沒到預估可包日的卡：兩個方向都停用（laneReplanBlockedReason；送出去伺服器一定擋 D22）。
 * （模擬區有唯讀卡時的退回路徑在 simBoard.simLaneStep，用 laneOrder.planLaneReorderAnchored，不在這裡）
 */
export function laneStepPlan(
  day: Pick<BoardDay, 'cards' | 'lanes'>,
  laneId: number,
  movingId: string,
  dir: StepDir,
  opts: { hideCompleted?: boolean } = {},
): LaneStepResult {
  const lane = laneCardsOf(day, laneId)
  const moving = lane.find(c => c.placementId === movingId)
  if (!moving) return { ok: false, code: 'missing', reason: LANE_STEP_REASON.missing }
  if (moving.completed) return { ok: false, code: 'completed', reason: LANE_STEP_REASON.completed }
  const d22 = laneReplanBlockedReason(moving)
  if (d22) return { ok: false, code: 'pre_ready', reason: d22 }
  const anchor = (c: BoardCard) => !(opts.hideCompleted && c.completed)
  const t = stepTarget(lane.map(c => ({ id: c.placementId, pinned: isPinned(c), anchor: anchor(c) })), movingId, dir)
  if ('reason' in t) return { ok: false, code: t.reason, reason: LANE_STEP_REASON[t.reason] }
  const entries = lane.map(c => ({ placementId: c.placementId, version: c.version, sortIndex: c.sortIndex ?? null, pinned: isPinned(c) }))
  const plan = planLaneReorder(entries, movingId, t.beforeId)
  const changes = plan?.changes ?? []
  if (!plan || changes.length === 0) {
    const code = dir === 'up' ? 'first' : 'last'
    return { ok: false, code, reason: LANE_STEP_REASON[code] }
  }
  const byId = new Map(lane.map(c => [c.placementId, c]))
  const seen = plan.order.filter(id => id === movingId || anchor(byId.get(id)!))
  return { ok: true, beforeId: t.beforeId, changes, position: seen.indexOf(movingId) + 1, total: seen.length }
}

/**
 * 套上 changes 之後 movingId 是這條線看得到的卡中的第幾張（1 起算；操作標籤「A 線 第 n 張」用）。
 * 用和樂觀更新 applyLocal 同一套穩定排序（sortByLaneOrder），畫面上看到的就是這個位置；replan＝解除延誤（不再釘在最上面）。
 */
export function lanePositionAfter(
  day: Pick<BoardDay, 'cards' | 'lanes'>,
  laneId: number,
  movingId: string,
  changes: readonly ReorderChange[],
  hideCompleted = false,
): number {
  const next = new Map(changes.map(c => [c.id, c]))
  const lane = laneCardsOf(day, laneId).map(c => {
    const ch = next.get(c.placementId)
    return ch ? { ...c, sortIndex: ch.sortIndex, delayWorkdays: ch.replan ? 0 : c.delayWorkdays } : c
  })
  const seen = sortByLaneOrder(lane).filter(c => c.placementId === movingId || !(hideCompleted && c.completed))
  return seen.findIndex(c => c.placementId === movingId) + 1
}

/** 卡片詳情的「順序」列：目前第幾張、上移／下移能不能按（不能＝原因） */
export interface LaneStepInfo {
  position: number
  total: number
  up: string | null
  down: string | null
  /** 延誤卡（下移＝解除延誤） */
  pinned: boolean
}

/** 兩個方向各試算一次（一條線不到幾十張卡，render 時直接算即可） */
export function laneStepInfo(
  day: Pick<BoardDay, 'cards' | 'lanes'>,
  laneId: number,
  id: string,
  opts: { hideCompleted?: boolean } = {},
): LaneStepInfo {
  const lane = laneCardsOf(day, laneId)
  const self = lane.find(c => c.placementId === id)
  const seen = lane.filter(c => c.placementId === id || !(opts.hideCompleted && c.completed))
  const up = laneStepPlan(day, laneId, id, 'up', opts)
  const down = laneStepPlan(day, laneId, id, 'down', opts)
  return {
    position: seen.findIndex(c => c.placementId === id) + 1,
    total: seen.length,
    up: up.ok ? null : up.reason,
    down: down.ok ? null : down.reason,
    pinned: !!self && isPinned(self),
  }
}

/**
 * 同一條線內把 moving 拖到 beforeId 之前（null＝最後）要改的 sort_index（D74）。
 * 該線全部卡（含已完成、隱藏的已完成）依目前顯示順序傳給 planLaneReorder；回空陣列＝位置沒變。
 * replan 的那一筆＝被拖的是延誤卡：呼叫端送 move（排到目前顯示的那天、解除延誤）＋ sortIndex，不是 reorder。
 */
export function laneReorderChanges(day: Pick<BoardDay, 'cards' | 'lanes'>, laneId: number, movingId: string, beforeId: string | null): ReorderChange[] {
  const lane = laneCardsOf(day, laneId).map(c => ({ placementId: c.placementId, version: c.version, sortIndex: c.sortIndex ?? null, pinned: isPinned(c) }))
  return planLaneReorder(lane, movingId, beforeId)?.changes ?? []
}

/** 從工作台資料建立「id → 版本」表（送出前重算版本號用） */
export function versionMapOf(d: BoardOk): Map<string, number> {
  const m = new Map<string, number>()
  for (const c of allBoardCards(d)) m.set(c.placementId, c.version)
  return m
}
