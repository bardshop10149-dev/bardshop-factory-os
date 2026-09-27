// 工作台的「本機暫時狀態」工具：樂觀更新、版本號重算、拖放限制。
//
// 設計取捨：
// - 伺服器才是真相（分配、修剪、產能、延誤都由 GET /api/packaging/board 的 assembleBoard 算）。
//   前端只做「看起來立刻動了」的最小搬移（樂觀更新），佇列清空後一定重抓一次工作台校正。
//   所以這裡不重做 allocateLine 等規則，只搬卡、改數量、重算欄頭已排分鐘。
// - 本檔不依賴 lib/packaging/schedule*.ts 純函式（與本畫面並行開發），只依型別契約。

import {
  MIN_CARD_MINUTES,
  PLACEABLE_BLOCKS,
  type BoardCard,
  type BoardDay,
  type BoardResponse,
  type DayLoad,
  type EffectiveCapacity,
  type PlacementOp,
  type PoolCardMeta,
  type YMD,
} from '@/lib/packaging/scheduleTypes'
import type { PackagingCard, PoolBlock, PoolBlockId } from '@/lib/packaging/types'

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

/** 與伺服器 dayLoad 同規則（欄頭顏色） */
export function localDayLoad(used: number, cap: EffectiveCapacity): DayLoad {
  if (cap.regularMinutes == null) return 'unset'
  if (used <= cap.regularMinutes) return 'ok'
  if (used <= cap.regularMinutes + cap.overtimeMinutes) return 'over_regular'
  return 'over_overtime'
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
      case 'uncomplete': {
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
    }
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────
// 樂觀更新
// ─────────────────────────────────────────────────────────────────────

export type LocalAction =
  | { t: 'place'; id: string; qty: number; toDate: YMD | null; poolCard: PackagingCard }
  | { t: 'move'; id: string; toDate: YMD | null }
  | { t: 'unplace'; id: string }
  | { t: 'complete'; id: string; by: string; byName: string | null; atIso: string }
  | { t: 'uncomplete'; id: string }
  | { t: 'split'; id: string; keepQty: number; parts: { id: string; qty: number; toDate: YMD | null }[] }
  | { t: 'merge'; targetId: string; sourceIds: string[] }

function withQty(c: BoardCard, qty: number): BoardCard {
  const minutes = localMinutes(c.card.work.perUnit, qty)
  return {
    ...c,
    qty,
    effectiveQty: qty,
    readyQty: Math.min(c.readyQty, qty),
    minutes,
    card: { ...c.card, qtyCard: qty, qtyReady: Math.min(c.card.qtyReady, qty), work: { ...c.card.work, qtyBasis: qty, minutes } },
  }
}

/** 把一張待排池卡轉成暫時的擺放卡（等伺服器重抓時換成正式資料） */
function tempCardFromPool(id: string, qty: number, toDate: YMD | null, pc: PackagingCard): BoardCard {
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
      cards = [...cards, tempCardFromPool(a.id, a.qty, a.toDate, a.poolCard)]
      pool = { ...pool, ...takeFromPool(d, a.poolCard.cardId, a.qty) }
      break
    }
    case 'move':
      cards = cards.map(c => c.placementId !== a.id ? c : {
        ...c,
        planDate: a.toDate,
        displayDate: a.toDate,
        originalDate: c.originalDate ?? a.toDate,
        delayWorkdays: 0,
        source: 'manual',
        // 主管挪過就不再是延誤／非工作日（D50）；其他警示等重抓再算
        flags: c.flags.filter(f => f.code !== 'delayed' && f.code !== 'off_board_day'),
      })
      break
    case 'unplace':
      cards = cards.filter(c => c.placementId !== a.id)
      break
    case 'complete':
      cards = cards.map(c => c.placementId !== a.id ? c : {
        ...c,
        completed: { at: a.atIso, by: a.by, byName: a.byName, poolQtyAt: null },
        // 延誤卡／待排區卡勾完成 → 伺服器改到 rollTarget（實際完成日）
        displayDate: c.displayDate ?? d.rollTarget,
        planDate: c.planDate == null || c.planDate < d.today ? d.rollTarget : c.planDate,
        delayWorkdays: 0,
        flags: c.flags.filter(f => f.code !== 'delayed'),
      })
      break
    case 'uncomplete':
      cards = cards.map(c => c.placementId !== a.id ? c : { ...c, completed: null })
      break
    case 'split': {
      const orig = cards.find(c => c.placementId === a.id)
      if (!orig) return d
      const parts = a.parts.map(p => ({
        ...withQty(orig, p.qty),
        placementId: p.id,
        version: 1,
        planDate: p.toDate,
        displayDate: p.toDate,
        flags: orig.flags.filter(f => f.code !== 'delayed' || p.toDate === orig.displayDate),
      }))
      cards = [...cards.map(c => c.placementId === a.id ? withQty(c, a.keepQty) : c), ...parts]
      break
    }
    case 'merge': {
      const target = cards.find(c => c.placementId === a.targetId)
      if (!target) return d
      const src = cards.filter(c => a.sourceIds.includes(c.placementId))
      const total = target.qty + src.reduce((n, c) => n + c.qty, 0)
      cards = cards
        .filter(c => !a.sourceIds.includes(c.placementId))
        .map(c => c.placementId === a.targetId ? withQty(c, total) : c)
      break
    }
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
