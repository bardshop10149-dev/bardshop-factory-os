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

import type { BoardCard, BoardDay, BoardLane, LockState, PlacementOp, YMD } from '@/lib/packaging/scheduleTypes'
import { SIM_MAX_OPS_PER_REQUEST, type BoardBody, type SimCardMeta, type SimLockReason, type SimLocks, type SimView } from '@/lib/packaging/ai/types'
import { planLaneReorder, planLaneReorderAnchored, type ReorderChange, type StepDir } from '@/lib/packaging/laneOrder'
import {
  LANE_STEP_REASON, applyLocal, autoLaneFor, isPinned, laneCardsOf, laneStepPlan,
  type BoardOk, type LaneStepCode, type LaneStepInfo, type LocalAction,
} from '@/components/packaging/board/boardLocal'

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

// ─────────────────────────────────────────────────────────────────────
// D100 模擬區線內順序（日／全部天數檢視拖曳、卡片詳情上移／下移共用）
// ─────────────────────────────────────────────────────────────────────

/** 判斷「哪些卡能改順序」需要的模擬區狀態 */
export interface SimOrderCtx {
  simCards: Record<string, SimCardMeta>
  locks: SimLocks
  scopeLineIds: readonly number[]
}

export type SimReorderFail = 'not_sim' | 'locked_moving' | 'locked_renumber' | 'too_many' | 'frozen_top' | 'no_gap'

/** 模擬區調整順序不能做的原因（toast 與按鈕停用說明） */
export const SIM_LANE_REASON: Record<SimReorderFail | 'readonly_neighbor', string> = {
  not_sim: '正式排程的卡（唯讀）：模擬區不能調整它的順序',
  locked_moving: '已鎖定的卡不能調整順序，先解除鎖定',
  locked_renumber: '這條線的卡還沒有順序值，調整要整條重新編號，其中有鎖定的卡（鎖定＝連順序都不動）；先解除那張卡的鎖定再調整',
  too_many: `這條線要重新編號的卡超過一次上限（${SIM_MAX_OPS_PER_REQUEST} 張），無法調整順序`,
  // D100 退回路徑（laneOrder.planLaneReorderAnchored）：唯讀卡、鎖定卡的順序值改不了 → 當固定錨點
  frozen_top: '上面是正式區唯讀（或已鎖定）、還沒有順序值的卡：它們固定排在最上面、模擬區改不了，這張卡排不到它們上面',
  no_gap: '前後是正式區唯讀（或已鎖定）的卡，順序值之間沒有空隙可以放；請改放到別的位置',
  readonly_neighbor: '這個方向相鄰的是正式區唯讀（或已鎖定）、還沒有順序值的卡：它們固定排在最上面、模擬區改不了，不能越過它們',
}

function orderHelpers(day: Pick<BoardDay, 'cards' | 'lanes'>, lineId: number, ctx: SimOrderCtx) {
  const lane = laneCardsOf(day, lineId)
  const byId = new Map(lane.map(c => [c.placementId, c]))
  const isSim = (id: string) => !!ctx.simCards[id]
  /** 模擬列而且沒鎖（伺服器 applySimOps 對 reorder 只准這種列：非模擬列回 not_sim_row、鎖定回 locked） */
  const movable = (id: string) => {
    const c = byId.get(id)
    if (!c) return false
    const st = simCardState(c, ctx.simCards, ctx.locks, ctx.scopeLineIds)
    return !!st.sim && st.lockedBy.length === 0
  }
  const movingCheck = (id: string): SimReorderFail | null => {
    const c = byId.get(id)
    if (!c) return null
    const st = simCardState(c, ctx.simCards, ctx.locks, ctx.scopeLineIds)
    return !st.sim ? 'not_sim' : st.lockedBy.length > 0 ? 'locked_moving' : null
  }
  return { lane, byId, isSim, movable, movingCheck }
}

/**
 * 模擬區把 movingId 放到 beforeId 之前（null＝最後）要改哪些 sort_index。
 * 為什麼分兩步（修正 D74 模擬區版「插入線畫在唯讀卡前、卡卻依唯讀卡的數值落在別處」）：
 *   1. 先拿「整條線」（含正式區唯讀卡）交給 planLaneReorder（與正式區 D74 同一套）：
 *      要改的卡全是「模擬列而且沒鎖」（通常只改被拖的那一張）→ 直接用，結果和插入線完全一致，也可以排到已完成卡的前後。
 *   2. 否則（這條線還有 null、要整條重新編號而會碰到唯讀卡或鎖定卡）→ D100 改用 laneOrder.planLaneReorderAnchored：
 *      唯讀卡、鎖定卡當固定錨點（值不改）；沒有順序值的錨點固定在最上面，插入點夾到它們之後；可改的卡填進錨點之間的空隙。
 *      修正前是「只拿模擬列從 1 開始重新編號」：null 的唯讀卡會跳到最上面、有值的唯讀卡會和 1..n 交錯或平手
 *      → 按「上移」反而往下掉、插入線畫的地方和放下後的位置不同、前端和伺服器排出來不一樣（D100 驗證 F2）。
 *   做不到（要往上越過固定在最上面的卡、錨點之間沒空隙）→ ok:false 附原因（frozen_top／no_gap），不送、不亂排。
 *   最後檢查：超過一次上限 → too_many；要改的卡有鎖定的 → locked_renumber（防呆；錨點做法不會改到鎖定卡）。
 * 回傳的 beforeId＝實際落點（被夾到固定段之後時和游標不同），拖曳中的插入線畫在這裡。
 * 不動 laneOrder.planLaneReorder／boardLocal.laneReorderChanges：正式區樂觀更新、applyOps、採用都依賴它們，模擬區專用邏輯只包在外面。
 */
export function simLaneReorder(
  day: Pick<BoardDay, 'cards' | 'lanes'>,
  lineId: number,
  movingId: string,
  beforeId: string | null,
  ctx: SimOrderCtx,
): { ok: true; changes: ReorderChange[]; beforeId: string | null; fallback: boolean } | { ok: false; reason: SimReorderFail; changes: ReorderChange[] } {
  const h = orderHelpers(day, lineId, ctx)
  if (!h.byId.has(movingId)) return { ok: true, changes: [], beforeId, fallback: false }
  const bad = h.movingCheck(movingId)
  if (bad) return { ok: false, reason: bad, changes: [] }
  const entries = h.lane.map(c => ({ placementId: c.placementId, version: c.version, sortIndex: c.sortIndex ?? null, pinned: isPinned(c) }))
  const plan = planLaneReorder(entries, movingId, beforeId)
  let changes = plan?.changes ?? []
  // 實際落點＝結果順序裡被拖的卡的下一張（要求排到延誤卡上面時 D74 會夾到延誤卡之後，和要求的 beforeId 不同）
  let used = plan ? plan.order[plan.order.indexOf(movingId) + 1] ?? null : beforeId
  let fallback = false
  if (!changes.every(c => h.movable(c.id))) {
    fallback = true
    const a = planLaneReorderAnchored(entries.map(e => ({ ...e, fixed: !h.movable(e.placementId) })), movingId, beforeId)
    if (!a) return { ok: true, changes: [], beforeId, fallback }
    if ('blocked' in a) return { ok: false, reason: a.blocked === 'frozen' ? 'frozen_top' : 'no_gap', changes: [] }
    // 被夾到固定段之後、結果就是原位＝想往上卻一格也上不去 → 說明原因（不要默默沒反應）
    if (a.clamped && a.changes.length === 0) return { ok: false, reason: 'frozen_top', changes: [] }
    changes = a.changes
    used = a.beforeId
  }
  if (changes.length > SIM_MAX_OPS_PER_REQUEST) return { ok: false, reason: 'too_many', changes }
  if (changes.some(c => !h.movable(c.id))) return { ok: false, reason: 'locked_renumber', changes }
  return { ok: true, changes, beforeId: used, fallback }
}

export type SimStepResult =
  | { ok: true; changes: ReorderChange[]; beforeId: string | null; position: number; total: number; fallback: boolean }
  | { ok: false; code: LaneStepCode | SimReorderFail | 'readonly_neighbor'; reason: string }

/**
 * 模擬區卡片詳情的「上移／下移」。同 simLaneReorder 的兩步：
 *   1. 整條線（看得到的卡都是錨點，含唯讀卡）→ 上一張／下下一張之前；要改的卡都能改就用（畫面上真的往上／下一格）。
 *   2. 否則 D100 用 planLaneReorderAnchored（唯讀卡、鎖定卡當固定錨點、值不改）排到同一個目標：
 *      往下若會夾在兩張固定在最上面的卡中間，就排到它們之後（同方向多移幾格，「第 n 張」照實寫）；
 *      結果沒有往要求的方向移動（往上越不過固定在最上面的卡）→ 停用並寫原因，不會「按了反而往下掉」或「按了沒反應」。
 */
export function simLaneStep(
  day: Pick<BoardDay, 'cards' | 'lanes'>,
  lineId: number,
  movingId: string,
  dir: StepDir,
  ctx: SimOrderCtx,
): SimStepResult {
  const h = orderHelpers(day, lineId, ctx)
  if (!h.byId.has(movingId)) return { ok: false, code: 'missing', reason: LANE_STEP_REASON.missing }
  const bad = h.movingCheck(movingId)
  if (bad) return { ok: false, code: bad, reason: SIM_LANE_REASON[bad] }
  const full = laneStepPlan(day, lineId, movingId, dir)
  if (!full.ok) return full
  if (full.changes.every(c => h.movable(c.id))) {
    if (full.changes.length > SIM_MAX_OPS_PER_REQUEST) return { ok: false, code: 'too_many', reason: SIM_LANE_REASON.too_many }
    return { ...full, fallback: false }
  }
  const entries = h.lane.map(c => ({
    placementId: c.placementId, version: c.version, sortIndex: c.sortIndex ?? null, pinned: isPinned(c), fixed: !h.movable(c.placementId),
  }))
  const a = planLaneReorderAnchored(entries, movingId, full.beforeId)
  if (!a) return { ok: false, code: 'missing', reason: LANE_STEP_REASON.missing }
  if ('blocked' in a) {
    return a.blocked === 'no_gap'
      ? { ok: false, code: 'no_gap', reason: SIM_LANE_REASON.no_gap }
      : { ok: false, code: 'readonly_neighbor', reason: SIM_LANE_REASON.readonly_neighbor }
  }
  const oldAt = h.lane.findIndex(c => c.placementId === movingId)
  const newAt = a.order.indexOf(movingId)
  if (a.changes.length === 0 || (dir === 'up' ? newAt >= oldAt : newAt <= oldAt)) {
    return { ok: false, code: 'readonly_neighbor', reason: SIM_LANE_REASON.readonly_neighbor }
  }
  if (a.changes.length > SIM_MAX_OPS_PER_REQUEST) return { ok: false, code: 'too_many', reason: SIM_LANE_REASON.too_many }
  if (a.changes.some(c => !h.movable(c.id))) return { ok: false, code: 'locked_renumber', reason: SIM_LANE_REASON.locked_renumber }
  // 第幾張：planLaneReorderAnchored 已驗算「套上新值後的排序＝order」（前端穩定排序與伺服器固定排序一致）
  return { ok: true, changes: a.changes, beforeId: a.beforeId, fallback: true, position: newAt + 1, total: h.lane.length }
}

/** 模擬區卡片詳情的「順序」列（模擬區不隱藏已完成：每張卡都看得到） */
export function simLaneStepInfo(day: Pick<BoardDay, 'cards' | 'lanes'>, lineId: number, id: string, ctx: SimOrderCtx): LaneStepInfo {
  const h = orderHelpers(day, lineId, ctx)
  const self = h.byId.get(id)
  const up = simLaneStep(day, lineId, id, 'up', ctx)
  const down = simLaneStep(day, lineId, id, 'down', ctx)
  return {
    position: h.lane.findIndex(c => c.placementId === id) + 1,
    total: h.lane.length,
    up: up.ok ? null : up.reason,
    down: down.ok ? null : down.reason,
    pinned: !!self && isPinned(self),
  }
}

type ReorderOp = Extract<PlacementOp, { op: 'reorder' }>
const isReorderOp = (o: PlacementOp): o is ReorderOp => o.op === 'reorder'

/**
 * useSim 佇列：還在排隊（尚未送出）的一批與新一批「都只有 reorder」時併成一批（同一張卡後者覆蓋）；不能併回 null。
 * 為什麼：模擬區每個請求推一格「退回上一步」（上限 SIM_UNDO_LIMIT 30 格）；連按上移／下移十幾次會把「AI 排程前」那格擠掉。
 * 為什麼可以併：reorder 只設 sort_index（同一張卡「設 a 再設 b」＝設 b；不同卡互不影響，順序無關），
 *   模擬列版本固定是 1（simState SIM_ROW_VERSION）不會因前一步 +1 而衝突；move／setMinutes 等不併（會改分配或版本語意）。
 */
export function mergeQueuedReorderOps(prev: readonly PlacementOp[], next: readonly PlacementOp[], max: number): PlacementOp[] | null {
  if (prev.length === 0 || next.length === 0) return null
  if (!prev.every(isReorderOp) || !next.every(isReorderOp)) return null
  const byId = new Map<string, ReorderOp>()
  for (const o of [...prev, ...next] as ReorderOp[]) byId.set(o.id, o)
  const out = [...byId.values()]
  return out.length > max ? null : out
}

/** 兩組日期是否相同（歷史結果能不能載入目前模擬區：範圍要一樣） */
export function sameDates(a: readonly YMD[], b: readonly YMD[]): boolean {
  return a.length === b.length && a.every((d, i) => d === b[i])
}
