// 包裝專區 P3 AI 模擬排程 — D106 模擬區兩個整批動作（純函式；route 只照結果讀寫）
//
// ① 一鍵清空模擬區排程（planClearSim）：模擬列全部拿掉、模式改 clear；鎖定只丟「卡片鎖」（卡已不存在），
//    訂單鎖與整條線鎖照留（它們描述的是「AI 之後不能動什麼」，不是某一張卡）。
//    產線時數覆寫（sim_capacity）與模擬範圍（window_dates）完全不碰 —— D106：清排程、保留產能。
//
// ② 拉正式區 1:1（planPullLive）：
//    - 擺放：範圍內（window × 目前啟用中的線）正式區未完成的擺放整份複製（沿用 copyPlacementsFromLive：日期、線、
//      線內順序 sortIndex、覆寫工時 estMinutesOverride 都帶；已完成不複製）。範圍外的正式卡、待排區的卡本來就以
//      「正式區唯讀列」顯示在模擬區（composeSimState），不必也不能複製 —— 模擬區的資料模型只放範圍內可動的列。
//    - 線：換成「目前啟用中的線」（同重設）；建立模擬區之後才啟用的線也一起納入，才算 1:1。
//    - 產能：模擬產能是「疊在正式產能上的覆寫」（simCapacity.ts 檔頭）—— 沒有覆寫 ＝ 各線各日都用正式值。
//      所以「把正式產能 1:1 複製進模擬區」＝ 把覆寫清空（cells 清空、模擬才開的週末關掉並從 window_dates 移除）。
//      為什麼不把正式值逐格寫成 cells：applySimCapacityInputs／pruneAdoptedCells 的既有不變式是「覆寫只放與正式不同的格」；
//      逐格寫入會讓橫幅顯示「調整 N 格」、採用預覽列出一堆沒變的格，還會在組長之後改正式表時把舊值蓋回去。
//      正式已開的週末（liveOpenWeekends）留在 window_dates 裡（它是正式的事實，不是模擬開的）。
//    - 鎖定：訂單鎖、線鎖照留（線鎖只留仍在新線集合內的）；卡片鎖經 livePlacementId 對應搬到新列
//      （舊模擬列是從正式卡 X 複製來的且被鎖 → 新複製出的 X 也鎖），手動／AI 新建的列（沒有 livePlacementId）的鎖丟掉。
//
// 兩個動作在 route 都先 snapshotForUndo（kind 沿用 'reset'：穩定站舊程式 parseSimUndo 只認既有的 kind，
//   新增 kind 會被它當成 'ops'／洗掉；label 已足以區分）。
//
// 硬規則：不 import supabase、不讀時鐘、相對路徑 import、不用 enum。

import type { Placement, YMD } from '../scheduleTypes'
import { copyPlacementsFromLive, normalizeLocks } from './simState'
import { emptySimCapacity, isEmptySimCapacity, normalizeSimCapacity } from './simCapacity'
import type { SimCapacity, SimLocks, SimMode, SimPlacement, SimSession } from './types'

const EMPTY_LOCKS: SimLocks = { placementIds: [], soNumbers: [], lineIds: [] }

export interface ClearSimPlan {
  placements: SimPlacement[]
  locks: SimLocks
  mode: SimMode
  /** 被清掉的模擬列數 */
  removedCount: number
  /** 被丟掉的卡片鎖數（訂單鎖、線鎖不算） */
  cardLocksDropped: number
  /** 沒有任何東西要改（已經是空的、模式已是 clear、沒有卡片鎖）→ route 不寫入、不推 undo */
  noop: boolean
}

/** D106 ①：清空模擬列（保留產能覆寫與範圍；只丟卡片鎖） */
export function planClearSim(session: Pick<SimSession, 'placements' | 'locks' | 'lineIds' | 'mode'>): ClearSimPlan {
  const locks = normalizeLocks(session.locks, { placements: [], lineIds: session.lineIds }) ?? { ...EMPTY_LOCKS }
  const cardLocksDropped = session.locks.placementIds.length - locks.placementIds.length
  return {
    placements: [],
    locks,
    mode: 'clear',
    removedCount: session.placements.length,
    cardLocksDropped,
    noop: session.placements.length === 0 && session.mode === 'clear' && cardLocksDropped === 0,
  }
}

/**
 * 卡片鎖搬家：舊列被鎖且有 livePlacementId → 新列中 livePlacementId 相同的那一張也鎖。
 * 回傳新的 placementIds（依新列順序，去重）；搬不過去的（舊列沒有 livePlacementId、或正式卡已不在範圍內）不算。
 */
export function transferCardLocks(
  oldPlacements: readonly SimPlacement[],
  oldLocks: Pick<SimLocks, 'placementIds'>,
  newPlacements: readonly SimPlacement[],
): string[] {
  const lockedIds = new Set(oldLocks.placementIds)
  const lockedLive = new Set<string>()
  for (const p of oldPlacements) if (lockedIds.has(p.id) && p.livePlacementId) lockedLive.add(p.livePlacementId)
  const out: string[] = []
  for (const p of newPlacements) if (p.livePlacementId && lockedLive.has(p.livePlacementId) && !out.includes(p.id)) out.push(p.id)
  return out
}

export interface PullLiveCapacityPlan {
  windowDates: YMD[]
  simCapacity: SimCapacity
  /** 被拿掉的覆寫格數 */
  cellsDropped: number
  /** 被關掉（從 window_dates 移除）的模擬週末 */
  weekendsClosed: YMD[]
  windowChanged: boolean
  capChanged: boolean
}

/**
 * D106 ②的產能段：正式產能 1:1 ＝ 清空覆寫。模擬才開、正式沒開的週末從 window_dates 移除；正式已開的週末留著。
 * windowDates 只會「減少」（拿掉模擬週末），工作日集合與起訖日不變。
 */
export function pullLiveCapacity(
  session: Pick<SimSession, 'windowDates' | 'lineIds'> & { simCapacity?: SimCapacity },
  liveOpenWeekends: ReadonlySet<YMD>,
): PullLiveCapacityPlan {
  const cur = normalizeSimCapacity(session.simCapacity ?? emptySimCapacity(), session)
  const weekendsClosed = cur.weekendsOpened.filter((d) => !liveOpenWeekends.has(d))
  const closed = new Set(weekendsClosed)
  const windowDates = session.windowDates.filter((d) => !closed.has(d))
  return {
    windowDates,
    simCapacity: emptySimCapacity(),
    cellsDropped: cur.cells.length,
    weekendsClosed,
    windowChanged: windowDates.length !== session.windowDates.length,
    capChanged: !isEmptySimCapacity(cur),
  }
}

export interface PullLivePlan extends PullLiveCapacityPlan {
  placements: SimPlacement[]
  locks: SimLocks
  mode: SimMode
  lineIds: number[]
  lineIdsChanged: boolean
  /** 卡片鎖：搬過去幾個、丟掉幾個 */
  cardLocksKept: number
  cardLocksDropped: number
}

/**
 * D106 ②：拉正式區 1:1。先算產能段（決定新的 window_dates），再依新範圍 × 目前啟用中的線複製正式擺放，最後整理鎖定。
 * newId：每張新列的 id（route 傳 crypto.randomUUID；測試傳可預期的序號）。
 */
export function planPullLive(input: {
  live: readonly Placement[]
  session: Pick<SimSession, 'placements' | 'locks' | 'lineIds' | 'windowDates' | 'mode'> & { simCapacity?: SimCapacity }
  /** 目前啟用中的線 id（activeLinesOf；空陣列由 route 先擋） */
  activeLineIds: readonly number[]
  liveOpenWeekends: ReadonlySet<YMD>
  newId: () => string
}): PullLivePlan {
  const { session } = input
  const cap = pullLiveCapacity(session, input.liveOpenWeekends)
  const lineIds = [...input.activeLineIds]
  const scope = { windowDates: cap.windowDates, lineIds }
  const placements = copyPlacementsFromLive(input.live, scope, input.newId)
  const placementIds = transferCardLocks(session.placements, session.locks, placements)
  const locks = normalizeLocks({ placementIds, soNumbers: session.locks.soNumbers, lineIds: session.locks.lineIds }, { placements, lineIds })
    ?? { ...EMPTY_LOCKS }
  const sameLines = lineIds.length === session.lineIds.length && lineIds.every((id) => session.lineIds.includes(id))
  return {
    ...cap,
    placements,
    locks,
    mode: 'copy',
    lineIds,
    lineIdsChanged: !sameLines,
    cardLocksKept: locks.placementIds.length,
    cardLocksDropped: session.locks.placementIds.length - locks.placementIds.length,
  }
}
