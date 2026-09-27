// 工作台的「本機暫時狀態」工具：樂觀更新、版本號重算、拖放限制。
//
// 設計取捨：
// - 伺服器才是真相（分配、修剪、產能、延誤都由 GET /api/packaging/board 的 assembleBoard 算）。
//   前端只做「看起來立刻動了」的最小搬移（樂觀更新），佇列清空後一定重抓一次工作台校正。
//   所以這裡不重做 allocateLine 等規則，只搬卡、改數量、重算欄頭已排分鐘。
// - 分線輪起改用 lib/packaging 的純函式（scheduleLines／scheduleMinutes／scheduleCapacity.dayLoad）：
//   自動選線（D72）、工時覆寫換算（D69）、各線負荷顏色要和伺服器同一套規則，拖放後畫面才不會「先跳一條線、重抓又跳回來」。

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
      case 'setMinutes': {
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
  /** lineId 省略＝沿用原線（同伺服器 move） */
  | { t: 'move'; id: string; toDate: YMD | null; lineId?: number | null }
  | { t: 'unplace'; id: string }
  /** lineId：待排區的卡勾完成時放哪條線（伺服器省略＝預設線） */
  | { t: 'complete'; id: string; by: string; byName: string | null; atIso: string; lineId?: number | null }
  | { t: 'uncomplete'; id: string }
  /** parts[].lineId 省略＝同原卡的線 */
  | { t: 'split'; id: string; keepQty: number; parts: { id: string; qty: number; toDate: YMD | null; lineId?: number | null }[] }
  | { t: 'merge'; targetId: string; sourceIds: string[] }
  /** D69 改工時：minutes＝以本列 qty 為準的覆寫值（null＝回到標準估計） */
  | { t: 'setMinutes'; id: string; minutes: number | null; by: string; byName: string | null; atIso: string }

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
  }
}

/** 各線負荷（同伺服器 assembleBoard：已排含已完成、不含工時未知） */
function recomputeLane(lane: BoardLane, cards: BoardCard[]): BoardLane {
  let used = 0
  let open = 0
  let unknown = 0
  let count = 0
  for (const c of cards) {
    if (c.laneId !== lane.lineId) continue
    count++
    if (c.minutes == null) { unknown++; continue }
    used += c.minutes
    if (!c.completed) open += c.minutes
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
    used += c.minutes
    if (!c.completed) open += c.minutes
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
        return {
          ...c,
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
  // 視窗內原本就在的卡維持原順序，新來的接在後面（欄內順序沒有意義，D5；重抓後依伺服器排序）
  const days = d.days.map(day => recomputeDay(day, byDate.get(day.date) ?? []))
  return {
    ...d,
    days,
    holding,
    pool,
    later: laterAdd > 0 ? { ...d.later, count: d.later.count + laterAdd } : d.later,
  }
}

/** 從工作台資料建立「id → 版本」表（送出前重算版本號用） */
export function versionMapOf(d: BoardOk): Map<string, number> {
  const m = new Map<string, number>()
  for (const c of allBoardCards(d)) m.set(c.placementId, c.version)
  return m
}
