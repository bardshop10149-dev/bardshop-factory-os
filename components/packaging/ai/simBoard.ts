// AI 模擬區畫面的純函式：鎖定判斷、卡片身分（模擬列／正式區唯讀列）、顯示用的標記、樂觀更新。
//
// 為什麼要「改顯示資料」而不是改顯示元件：
//   DayLanesView／MultiDayView／LaneCard／PlacementCard 是正式工作台與穩定站共用的元件（規格 §八：只重用、不改），
//   它們沒有「鎖頭」「AI」的欄位。模擬區在交給它們之前先把資料加工：
//   - 鎖定的卡：品名前加 🔒（卡面第 4 行、日檢視短卡的品名、aria-label 都看得到）；
//     SimLayout 再用 CSS 屬性選擇器（aria-label 含 🔒）把卡片底色改成灰色斜紋（「灰底＋🔒」，規格 §八）
//   - AI 排入的卡：品名前加〔AI〕；正式區唯讀、未完成的卡（範圍外的線、延誤順延）加〔正式〕
//   - 鎖定的線：線名前加 🔒；不在模擬範圍的線（建立後才啟用）線名後加「（範圍外）」
//   只改傳給畫面的複本（新物件），不改原資料；卡片詳情一律用未加工的原始資料。
//
// 鎖定規則與伺服器 lib/packaging/ai/simState.ts 的 lockReasonsOf 相同（D88）；前端自己算是為了樂觀更新——
// 按下鎖頭立刻變灰，不用等伺服器回應。伺服器仍是最後把關（鎖定的列動不了，回 locked）。

import type { BoardCard, BoardDay, BoardLane, LockState, YMD } from '@/lib/packaging/scheduleTypes'
import type { BoardBody, SimCardMeta, SimLockReason, SimLocks, SimView } from '@/lib/packaging/ai/types'
import { applyLocal, autoLaneFor, type BoardOk, type LocalAction } from '@/components/packaging/board/boardLocal'

export const LOCK_MARK = '🔒'
export const AI_MARK = '〔AI〕'
export const LIVE_MARK = '〔正式〕'

/** so_line_key 的 SO 部分：最後一個 '-' 之前、trim、大寫（同 simState.soNumberOf） */
export function soNumberOfKey(soLineKey: string): string {
  const s = soLineKey.trim()
  const i = s.lastIndexOf('-')
  return (i > 0 ? s.slice(0, i) : s).trim().toUpperCase()
}

/** 這張卡為什麼被鎖（同 simState.lockReasonsOf）；空陣列＝沒鎖 */
export function lockReasonsFor(row: { id: string; soLineKey: string; lineId?: number | null }, locks: SimLocks): SimLockReason[] {
  const out: SimLockReason[] = []
  if (locks.placementIds.includes(row.id)) out.push('card')
  if (locks.soNumbers.includes(soNumberOfKey(row.soLineKey))) out.push('order')
  if (row.lineId != null && locks.lineIds.includes(row.lineId)) out.push('line')
  return out
}

/** 畫面上一張卡在模擬區的身分 */
export interface SimCardState {
  /** 模擬列資訊；null＝正式區唯讀列 */
  sim: SimCardMeta | null
  lockedBy: SimLockReason[]
  /** 正式區唯讀列不能動的原因（模擬列 null） */
  readonlyReason: string | null
}

export function simCardState(bc: BoardCard, simCards: Record<string, SimCardMeta>, locks: SimLocks, scopeLineIds: readonly number[]): SimCardState {
  const sim = simCards[bc.placementId] ?? null
  const lockedBy = sim ? lockReasonsFor({ id: bc.placementId, soLineKey: bc.soLineKey, lineId: bc.lineId ?? null }, locks) : []
  let readonlyReason: string | null = null
  if (!sim) {
    readonlyReason = bc.completed ? '已完成的卡（正式排程）'
      : bc.planDate == null ? '待排區的卡（主管擱置，AI 與模擬區都不動）'
        : bc.delayWorkdays > 0 ? '延誤順延到今天的正式排程卡（不在模擬範圍）'
          : bc.lineId != null && !scopeLineIds.includes(bc.lineId) ? '不在模擬範圍的線（建立模擬區之後才啟用的線，或已停用的線）'
            : '正式排程的卡（不在模擬範圍）'
  }
  return { sim, lockedBy, readonlyReason }
}

/** 線能不能放新卡：在模擬範圍內、且沒被鎖 */
export function isLineUsable(lineId: number, scopeLineIds: readonly number[], locks: SimLocks): boolean {
  return scopeLineIds.includes(lineId) && !locks.lineIds.includes(lineId)
}

function decorateCard(bc: BoardCard, simCards: Record<string, SimCardMeta>, locks: SimLocks, scopeLineIds: readonly number[]): BoardCard {
  const st = simCardState(bc, simCards, locks, scopeLineIds)
  let prefix = ''
  if (st.sim) {
    if (st.lockedBy.length > 0) prefix += `${LOCK_MARK} `
    if (st.sim.simSource === 'ai') prefix += AI_MARK
  } else if (!bc.completed) {
    prefix += LIVE_MARK
  }
  // AI 排入的卡在卡片詳情（CardDetailDialog 的「來源 AI 排入」）也要一致：source 標成 ai
  const source = st.sim?.simSource === 'ai' ? 'ai' as const : bc.source
  if (!prefix && source === bc.source) return bc
  return {
    ...bc,
    source,
    card: prefix ? { ...bc.card, itemName: `${prefix}${bc.card.itemName ?? '（無品名）'}` } : bc.card,
  }
}

function decorateLane(lane: BoardLane, scopeLineIds: readonly number[], locks: SimLocks): BoardLane {
  if (!scopeLineIds.includes(lane.lineId)) return { ...lane, name: `${lane.name}（範圍外）` }
  if (locks.lineIds.includes(lane.lineId)) return { ...lane, name: `${LOCK_MARK} ${lane.name}` }
  return lane
}

/** 給 DayLanesView／MultiDayView／ParkingArea 的顯示複本（見檔頭） */
export function decorateSimBoard(
  board: BoardBody,
  simCards: Record<string, SimCardMeta>,
  locks: SimLocks,
  scopeLineIds: readonly number[],
): BoardBody {
  const days: BoardDay[] = board.days.map(d => ({
    ...d,
    cards: d.cards.map(c => decorateCard(c, simCards, locks, scopeLineIds)),
    lanes: d.lanes?.map(l => decorateLane(l, scopeLineIds, locks)),
  }))
  return { ...board, days, holding: board.holding.map(c => decorateCard(c, simCards, locks, scopeLineIds)) }
}

// ─────────────────────────────────────────────────────────────────────
// 自動選線（D72，模擬區版）：只在「範圍內、未鎖定」的線裡挑剩餘工時最多的
// ─────────────────────────────────────────────────────────────────────

export function simAutoLane(
  day: Pick<BoardDay, 'lanes' | 'cards'> | null | undefined,
  moving: { placementId: string } | null,
  usableLineIds: readonly number[],
  fallback: number | null,
): number | null {
  if (!day) return fallback
  const lanes = (day.lanes ?? []).filter(l => usableLineIds.includes(l.lineId))
  if (lanes.length === 0) return null
  return autoLaneFor({ lanes, cards: day.cards }, moving, fallback)
}

// ─────────────────────────────────────────────────────────────────────
// 樂觀更新：沿用正式工作台的 boardLocal.applyLocal（同一套搬卡規則），外面包一層 BoardBody ↔ BoardOk
// ─────────────────────────────────────────────────────────────────────

/** applyLocal 需要 BoardOk（多 lock／me／serverTime／revision）；這幾欄它不讀，給空值即可 */
const NO_LOCK: LockState = {
  held: false, holderEmail: null, holderName: null, acquiredAt: null, lastActionAt: null, expiresAt: null, isMine: false, takenOverBy: null,
}

export function applyLocalToBody(board: BoardBody, actions: readonly LocalAction[]): BoardBody {
  if (actions.length === 0) return board
  const ok: BoardOk = { ...board, serverTime: '', revision: '', lock: NO_LOCK, me: { email: '', name: null, canEdit: true } }
  const next = actions.reduce(applyLocal, ok)
  // applyLocal 只改 days／holding／pool／later，其餘沿用
  return { ...board, days: next.days, holding: next.holding, pool: next.pool, later: next.later }
}

/**
 * 本機動作對「哪些是模擬列」的影響（規格 §三：新建、或日期／線／數量有變 → manual；只改順序／工時保留原來源）。
 * 讓樂觀更新後新放上去的卡立刻被當成模擬列（能再拖、能鎖），不用等伺服器回應。
 */
export function applyLocalToSimCards(simCards: Record<string, SimCardMeta>, actions: readonly LocalAction[]): Record<string, SimCardMeta> {
  let out = simCards
  const fresh = (): SimCardMeta => ({ simSource: 'manual', aiReason: null, livePlacementId: null, lockedBy: [] })
  const edit = (fn: (m: Record<string, SimCardMeta>) => void) => {
    if (out === simCards) out = { ...simCards }
    fn(out)
  }
  for (const a of actions) {
    switch (a.t) {
      case 'place':
        edit(m => { m[a.id] = fresh() })
        break
      case 'move':
        if (out[a.id]) edit(m => { m[a.id] = { ...m[a.id], simSource: 'manual' } })
        break
      case 'split':
        edit(m => {
          if (m[a.id]) m[a.id] = { ...m[a.id], simSource: 'manual' }
          for (const p of a.parts) m[p.id] = fresh()
        })
        break
      case 'merge':
        edit(m => {
          if (m[a.targetId]) m[a.targetId] = { ...m[a.targetId], simSource: 'manual' }
          for (const id of a.sourceIds) delete m[id]
        })
        break
      case 'unplace':
        if (out[a.id]) edit(m => { delete m[a.id] })
        break
      default:
        break
    }
  }
  return out
}

/** 鎖定的樂觀更新：session.locks 換成新的、simCards 的 lockedBy 重算 */
export function withLocks(view: SimView, locks: SimLocks): SimView {
  if (!view.session) return view
  const simCards: Record<string, SimCardMeta> = {}
  const cardById = new Map<string, BoardCard>()
  for (const d of view.board?.days ?? []) for (const c of d.cards) cardById.set(c.placementId, c)
  for (const [id, m] of Object.entries(view.simCards)) {
    const c = cardById.get(id)
    simCards[id] = c ? { ...m, lockedBy: lockReasonsFor({ id, soLineKey: c.soLineKey, lineId: c.lineId ?? null }, locks) } : m
  }
  return { ...view, session: { ...view.session, locks }, simCards }
}

// ─────────────────────────────────────────────────────────────────────
// 鎖定的切換（整份替換，POST session/locks）
// ─────────────────────────────────────────────────────────────────────

function toggleIn<T>(arr: readonly T[], v: T): T[] {
  return arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]
}

export function toggleCardLock(locks: SimLocks, placementId: string): SimLocks {
  return { ...locks, placementIds: toggleIn(locks.placementIds, placementId) }
}

export function toggleOrderLock(locks: SimLocks, soLineKey: string): SimLocks {
  return { ...locks, soNumbers: toggleIn(locks.soNumbers, soNumberOfKey(soLineKey)) }
}

export function toggleLineLock(locks: SimLocks, lineId: number): SimLocks {
  return { ...locks, lineIds: toggleIn(locks.lineIds, lineId) }
}

export function locksCount(locks: SimLocks): number {
  return locks.placementIds.length + locks.soNumbers.length + locks.lineIds.length
}

/** 兩組日期是否相同（歷史結果能不能載入目前模擬區：範圍要一樣） */
export function sameDates(a: readonly YMD[], b: readonly YMD[]): boolean {
  return a.length === b.length && a.every((d, i) => d === b[i])
}
