// 包裝專區 P3 AI 模擬排程 — 模擬區狀態（純函式，規格 §三；D77／D78／D88）
//
// 核心概念：模擬區畫面與驗算用的「整張排程」＝ 組合狀態（composeSimState）
//   ＝ 正式區中「不在模擬範圍內、或已完成、或待排區（plan_date null）」的列（唯讀）
//   ∪ session.placements（範圍內的模擬列，可動）
//   範圍（isInSimScope）＝ planDate ∈ windowDates 且 lineId ∈ lineIds。範圍外的線（建立後才啟用的線、停用線上的卡）照正式區唯讀。
//   D50 延誤卡（planDate < today、未完成）不在範圍內 → 正式區唯讀列，照樣佔今天的產能（AI 看成 fixedMin）。
// 丟進既有 assembleBoard → 與 BoardResponse 同形（前端重用 DayLanesView／MultiDayView／PoolSidebar）；
// 丟進既有 applyOps → 模擬區手動操作與 AI 驗算走「跟正式區同一套」守恆／日期／線／D22 驗證，規則不會分岔。
//
// 為什麼「組合」而不是把正式區整份複製進模擬區：範圍外的列、已完成的列、延誤卡、待排區都是正式區的事實，
//   模擬區只負責「窗內 × 模擬線」這一塊；其餘每次讀正式區最新狀態，守恆（同一 SO 行的全部未完成量 ≤ 可排供給）才算得準，
//   採用時也只需要對這一塊算差異（D87 範圍外完全不動）。
//
// 硬規則：不 import supabase、不讀時鐘（today／nowIso／stamp 由參數傳入）、相對路徑 import、不用 enum；
//   既有 scheduleOps／scheduleBoard／laneOrder 等只呼叫、不修改。
// 模擬列的 Placement.version 一律合成為 SIM_ROW_VERSION（1）：模擬區的併發由 session.version CAS 保護，
//   列版本只是為了讓 applyOps 的 version 檢查通過（前端從 GET 拿到的 BoardCard.version 也是 1，送回來一致）。

import type { LineSupply, Placement, PlacementOp, YMD } from '../scheduleTypes'
import type { PackagingCard } from '../types'
import { applyOps, type OpsContext } from '../scheduleOps'
import { assembleBoard } from '../scheduleBoard'
import { addDays, boardWindow, nextBoardDay, openWeekendDaysOf, rollTarget } from '../scheduleCalendar'
import { lineSupply } from '../scheduleAllocate'
import { defaultLineIdOf } from '../scheduleLines'
import {
  SIM_LABEL_MAX,
  SIM_MAX_PLACEMENTS,
  SIM_UNDO_LIMIT,
  SIM_PLACEMENTS_MAX_BYTES,
  SIM_UNDO_MAX_BYTES,
  type AiHorizon,
  type ApplySimOpsInput,
  type ApplySimOpsResult,
  type BoardBody,
  type ComposedSimState,
  type SimCardMeta,
  type SimLockReason,
  type SimLocks,
  type SimPlacement,
  type SimScope,
  type SimSession,
  type SimSessionState,
  type SimSource,
  type SimStamp,
  type SimStartOption,
  type SimUndoEntry,
  type SimUndoKind,
  type SimWorld,
} from './types'

/** 模擬列轉成 Placement 時合成的 version（見檔頭） */
export const SIM_ROW_VERSION = 1

/** 模擬區手動操作允許的 op（complete／uncomplete／setQty／restore 只屬於正式區或 Undo，不開放） */
export const SIM_ALLOWED_OPS: ReadonlySet<PlacementOp['op']> = new Set(['place', 'move', 'split', 'merge', 'unplace', 'reorder', 'setMinutes'])

/** 寫入最遠可排到 today + 120 日曆天（同 scheduleWrite.MAX_PLAN_DAYS；那支檔 import next／supabase，純函式不能 import 它） */
const MAX_PLAN_DAYS = 120
/** 鎖定訂單的 SO 單號長度（so_line_key 最長 80，SO 部分實測 11～13 字） */
const SO_NUMBER_MAX = 40
const EPS = 1e-9

// ─────────────────────────────────────────────────────────────────────
// 範圍與起始日（§三「範圍」）
// ─────────────────────────────────────────────────────────────────────

/**
 * 起始日：'today'＝today 若是工作台日期（isBoardDay）否則下一個（＝scheduleCalendar.rollTarget）；
 * 'next'＝today 之後第一個工作台日期（scheduleCalendar.nextBoardDay(today)）。
 * 回傳 boardWindow(start, horizon, openWeekends)（週末加班日插入但不佔名額）。
 */
export function planSimWindow(input: { today: YMD; start: SimStartOption; horizon: AiHorizon; openWeekends: ReadonlySet<YMD> }): YMD[] {
  const { today, openWeekends } = input
  const from = input.start === 'next' ? nextBoardDay(today, openWeekends) : rollTarget(today, openWeekends)
  return boardWindow(from, input.horizon, openWeekends)
}

/** planDate ∈ scope.windowDates 且 lineId ∈ scope.lineIds（planDate null＝待排區 → false） */
export function isInSimScope(p: { planDate: YMD | null; lineId?: number | null }, scope: SimScope): boolean {
  if (p.planDate == null || p.lineId == null) return false
  return scope.windowDates.includes(p.planDate) && scope.lineIds.includes(p.lineId)
}

/** 模擬列固定排序：planDate → lineId → sortIndex（null 在前）→ id（同一份資料產生的 JSON 一樣，方便比對與測試） */
export function compareSimRows(
  a: { planDate: YMD | null; lineId?: number | null; sortIndex?: number | null; id: string },
  b: { planDate: YMD | null; lineId?: number | null; sortIndex?: number | null; id: string },
): number {
  const ad = a.planDate ?? '9999-12-31', bd = b.planDate ?? '9999-12-31'
  if (ad !== bd) return ad < bd ? -1 : 1
  const al = a.lineId ?? 0, bl = b.lineId ?? 0
  if (al !== bl) return al - bl
  const as = a.sortIndex ?? null, bs = b.sortIndex ?? null
  if (as !== bs) {
    if (as == null) return -1
    if (bs == null) return 1
    return as < bs ? -1 : 1
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ─────────────────────────────────────────────────────────────────────
// 鎖定（D88）
// ─────────────────────────────────────────────────────────────────────

/** so_line_key 的 SO 部分：最後一個 '-' 之前、trim、大寫（'SO260924020-1' → 'SO260924020'；沒有 '-' 就整串） */
export function soNumberOf(soLineKey: string): string {
  const s = (soLineKey ?? '').trim()
  const i = s.lastIndexOf('-')
  return (i > 0 ? s.slice(0, i) : s).trim().toUpperCase()
}

/** 這張卡為什麼被鎖：'card'（placementIds 含 row.id）、'order'（soNumbers 含 soNumberOf）、'line'（lineIds 含 row.lineId）；空陣列＝沒鎖 */
export function lockReasonsOf(row: { id: string; soLineKey: string; lineId?: number | null }, locks: SimLocks): SimLockReason[] {
  const out: SimLockReason[] = []
  if (locks.placementIds.includes(row.id)) out.push('card')
  if (locks.soNumbers.length > 0 && locks.soNumbers.includes(soNumberOf(row.soLineKey))) out.push('order')
  if (row.lineId != null && locks.lineIds.includes(row.lineId)) out.push('line')
  return out
}

/** lockReasonsOf(...).length > 0 */
export function isRowLocked(row: { id: string; soLineKey: string; lineId?: number | null }, locks: SimLocks): boolean {
  return lockReasonsOf(row, locks).length > 0
}

/** 整張訂單是否被鎖（place 從待排池拿之前檢查；鎖定訂單的剩餘量 AI 也不能新排，D88） */
export function isOrderLocked(soLineKey: string, locks: SimLocks): boolean {
  return locks.soNumbers.length > 0 && locks.soNumbers.includes(soNumberOf(soLineKey))
}

/**
 * 驗證 POST session/locks 的 locks（整份替換）：
 * - placementIds：只留目前 session.placements 裡存在的 id（去重）
 * - soNumbers：字串、trim、大寫、去重、長度 1～40（trim 後空字串略過；超過 40 字＝不合法）
 * - lineIds：只留 session.lineIds 內的（去重）
 * - 各陣列最多 SIM_MAX_PLACEMENTS 個；形狀不對（非物件／非陣列／型別錯）回 null → route 回 bad_request
 * - 缺某個鍵＝該類不鎖（空陣列）
 * clear 模式也可以鎖（例如清空後手動放了幾張再鎖），UI 在 clear 剛建立時才灰掉。
 */
export function normalizeLocks(raw: unknown, session: Pick<SimSession, 'placements' | 'lineIds'>): SimLocks | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const arr = (v: unknown): unknown[] | null => (v === undefined ? [] : Array.isArray(v) && v.length <= SIM_MAX_PLACEMENTS ? v : null)
  const pids = arr(o.placementIds)
  const sos = arr(o.soNumbers)
  const lids = arr(o.lineIds)
  if (!pids || !sos || !lids) return null

  const simIds = new Set(session.placements.map((p) => p.id))
  const placementIds: string[] = []
  for (const x of pids) {
    if (typeof x !== 'string') return null
    if (simIds.has(x) && !placementIds.includes(x)) placementIds.push(x)
  }
  const soNumbers: string[] = []
  for (const x of sos) {
    if (typeof x !== 'string') return null
    const s = x.trim().toUpperCase()
    if (!s) continue
    if (s.length > SO_NUMBER_MAX) return null
    if (!soNumbers.includes(s)) soNumbers.push(s)
  }
  const lineSet = new Set(session.lineIds)
  const lineIds: number[] = []
  for (const x of lids) {
    if (typeof x !== 'number' || !Number.isInteger(x)) return null
    if (lineSet.has(x) && !lineIds.includes(x)) lineIds.push(x)
  }
  return { placementIds, soNumbers, lineIds }
}

// ─────────────────────────────────────────────────────────────────────
// 模擬列 ↔ Placement
// ─────────────────────────────────────────────────────────────────────

/**
 * 模擬列 → Placement（丟進 assembleBoard／applyOps 用）：
 * completed null、version SIM_ROW_VERSION、created／updated＝stamp（email／name／at）、
 * minutesOverride＝estMinutesOverride 有值時 { minutes, by: stamp.email, byName: stamp.name, at: stamp.at }、
 * source：simSource 'ai' → 'ai'，其餘沿用列上的 source。lineId／sortIndex 原樣。
 */
export function simToPlacement(row: SimPlacement, stamp: SimStamp): Placement {
  return {
    id: row.id,
    soLineKey: row.soLineKey,
    qty: row.qty,
    planDate: row.planDate,
    originalDate: row.originalDate ?? null,
    source: row.simSource === 'ai' ? 'ai' : row.source,
    originCardId: row.originCardId ?? null,
    completed: null,
    version: SIM_ROW_VERSION,
    createdAt: stamp.at,
    createdBy: stamp.email,
    createdByName: stamp.name,
    updatedAt: stamp.at,
    updatedBy: stamp.email,
    updatedByName: stamp.name,
    lineId: row.lineId,
    minutesOverride: row.estMinutesOverride != null
      ? { minutes: row.estMinutesOverride, by: stamp.email, byName: stamp.name, at: stamp.at }
      : null,
    sortIndex: row.sortIndex ?? null,
  }
}

/**
 * Placement（applyOps 結果中的列）→ 模擬列。prev＝同 id 的舊模擬列（新列 null）：
 * aiReason／livePlacementId 沿用 prev（新列 null），simSource 由呼叫端決定；planDate／lineId 必須非 null（呼叫端先確認在範圍內）。
 */
export function placementToSim(p: Placement, prev: SimPlacement | null, simSource: SimSource): SimPlacement {
  if (p.planDate == null || p.lineId == null) {
    // 程式錯誤（呼叫端應先以 isInSimScope 過濾）；不默默丟掉數量
    throw new Error(`[simState] placementToSim：模擬列必須有日期與線（${p.id}）`)
  }
  return {
    id: p.id,
    soLineKey: p.soLineKey,
    qty: p.qty,
    planDate: p.planDate,
    originalDate: p.originalDate ?? null,
    source: p.source,
    originCardId: p.originCardId ?? null,
    lineId: p.lineId,
    estMinutesOverride: p.minutesOverride?.minutes ?? null,
    sortIndex: p.sortIndex ?? null,
    aiReason: prev?.aiReason ?? null,
    simSource,
    livePlacementId: prev?.livePlacementId ?? null,
  }
}

/**
 * copy 模式建立／重設（§三）：live 中「範圍內（isInSimScope）且未完成」的擺放全部複製成模擬列——
 * 新 id（newId()）、livePlacementId＝原 id、simSource 'copy'、aiReason null；
 * 保留 soLineKey、qty、planDate、originalDate、source、originCardId、lineId、sortIndex、estMinutesOverride（minutesOverride?.minutes）。
 * 依（planDate、lineId、sortIndex null 在前、原 id）固定順序編新 id 並輸出（同一份正式區資料 → 同樣的呼叫順序）。
 */
export function copyPlacementsFromLive(live: readonly Placement[], scope: SimScope, newId: () => string): SimPlacement[] {
  const src = live.filter((p) => !p.completed && isInSimScope(p, scope)).sort(compareSimRows)
  return src.map((p): SimPlacement => ({
    id: newId(),
    soLineKey: p.soLineKey,
    qty: p.qty,
    planDate: p.planDate as YMD,
    originalDate: p.originalDate ?? null,
    source: p.source,
    originCardId: p.originCardId ?? null,
    lineId: p.lineId as number,
    estMinutesOverride: p.minutesOverride?.minutes ?? null,
    sortIndex: p.sortIndex ?? null,
    aiReason: null,
    simSource: 'copy',
    livePlacementId: p.id,
  }))
}

/**
 * 組合狀態（§三「組合檢視」）：
 * placements ＝ live 中「!isInSimScope 或 completed」的列 ∪ session.placements.map(simToPlacement)
 *   （範圍內未完成的 live 列被模擬列取代 → 放進 hiddenLiveIds）。
 * stamp 用 { email: session.ownerEmail, name: session.ownerName, at: session.updatedAt }。
 * 模擬列 id 不可能與 live id 相同（copy 換新 id）；萬一相同（資料壞掉）以模擬列為準並把該 live id 放進 hiddenLiveIds。
 */
export function composeSimState(
  live: readonly Placement[],
  session: Pick<SimSession, 'windowDates' | 'lineIds' | 'placements' | 'ownerEmail' | 'ownerName' | 'updatedAt'>,
): ComposedSimState {
  const scope: SimScope = { windowDates: session.windowDates, lineIds: session.lineIds }
  const stamp: SimStamp = { email: session.ownerEmail, name: session.ownerName, at: session.updatedAt }
  const simIds = new Set(session.placements.map((p) => p.id))
  const hiddenLiveIds = new Set<string>()
  const placements: Placement[] = []
  for (const p of live) {
    if ((!p.completed && isInSimScope(p, scope)) || simIds.has(p.id)) {
      hiddenLiveIds.add(p.id)
      continue
    }
    placements.push(p)
  }
  for (const s of session.placements) placements.push(simToPlacement(s, stamp))
  return { placements, simIds, hiddenLiveIds }
}

/**
 * 模擬區工作台：assembleBoard({ pool: world.pool, placements: composeSimState(...).placements, capacityRows, lines, lineRows,
 *   manual: world.manual, today: world.today, from: session.windowDates[0], workdays: session.horizon })。
 * 起始日已過（stale）時 from 會被 assembleBoard 夾到 today——畫面照顯示，route 另回 stale 提示重設。
 */
export function assembleSimBoard(
  world: SimWorld,
  session: Pick<SimSession, 'windowDates' | 'lineIds' | 'placements' | 'horizon' | 'ownerEmail' | 'ownerName' | 'updatedAt'>,
): BoardBody {
  const composed = composeSimState(world.live, session)
  return assembleBoard({
    pool: world.pool,
    placements: composed.placements,
    capacityRows: world.capacityRows,
    lines: world.lines,
    lineRows: world.lineRows,
    manual: world.manual,
    today: world.today,
    from: session.windowDates[0] ?? world.today,
    workdays: session.horizon,
  })
}

/**
 * 組合狀態上每張模擬列的附加資訊（SimView.simCards）：placementId → { simSource, aiReason, livePlacementId, lockedBy }。
 * 不在表內的卡＝正式區唯讀列。
 */
export function simCardMetaOf(session: Pick<SimSession, 'placements' | 'locks'>): Record<string, SimCardMeta> {
  const out: Record<string, SimCardMeta> = {}
  for (const p of session.placements) {
    out[p.id] = {
      simSource: p.simSource,
      aiReason: p.aiReason ?? null,
      livePlacementId: p.livePlacementId ?? null,
      lockedBy: lockReasonsOf(p, session.locks),
    }
  }
  return out
}

/**
 * 與 lib/packaging/scheduleWrite.ts handleApplyRequest 同一套 OpsContext（模擬區操作、AI 驗算、採用共用）：
 * today／nowIso／actor 取自 world；openWeekends＝openWeekendDaysOf(capacityRows, lineRows, 啟用線 id)；
 * supplyOf＝以 pool 各 SO 行的卡跑 lineSupply（記憶化）；cards＝cardId → 卡；maxDate＝today + MAX_PLAN_DAYS（120）；
 * lines＝id → 線（含停用）；defaultLineId＝defaultLineIdOf(lines)。
 */
export function buildSimOpsContext(world: SimWorld): OpsContext {
  const cards = new Map<string, PackagingCard>()
  const cardsByLine = new Map<string, PackagingCard[]>()
  for (const b of world.pool.blocks) for (const c of b.cards) {
    cards.set(c.cardId, c)
    let arr = cardsByLine.get(c.soLineKey)
    if (!arr) { arr = []; cardsByLine.set(c.soLineKey, arr) }
    arr.push(c)
  }
  const supplyMemo = new Map<string, LineSupply | null>()
  const supplyOf = (key: string): LineSupply | null => {
    if (!supplyMemo.has(key)) {
      const list = cardsByLine.get(key)
      supplyMemo.set(key, list && list.length > 0 ? lineSupply(key, list) : null)
    }
    return supplyMemo.get(key) ?? null
  }
  const activeIds = new Set(world.lines.filter((l) => l.active).map((l) => l.id))
  return {
    today: world.today,
    nowIso: world.nowIso,
    actor: { email: world.actor.email, name: world.actor.name },
    openWeekends: openWeekendDaysOf(world.capacityRows, world.lineRows, activeIds),
    supplyOf,
    cards,
    maxDate: addDays(world.today, MAX_PLAN_DAYS),
    lines: new Map(world.lines.map((l) => [l.id, l])),
    defaultLineId: defaultLineIdOf(world.lines),
  }
}

// ─────────────────────────────────────────────────────────────────────
// 模擬區手動操作（§三「模擬區手動操作」，D77）
// ─────────────────────────────────────────────────────────────────────

/**
 * POST session/ops 的核心（route 只負責讀寫與 CAS）：
 * 1. op 種類必須在 SIM_ALLOWED_OPS，否則 op_not_allowed。
 * 2. 只允許動 session.placements 內的列（move／split／merge／unplace／reorder／setMinutes 的 id／targetId／sources），
 *    否則 not_sim_row（正式區唯讀列、範圍外列、已完成列都不能在模擬區動）。同一批前面 place／split 新建的列也算模擬列。
 * 3. 鎖定（isRowLocked）的列不能動；place 的 soLineKey 所屬訂單被鎖、或目標線被鎖 → locked。
 * 4. 目標日期（place／move 的 toDate、split parts 的 toDate）必須在 windowDates 內且線在 lineIds 內 → 否則 out_of_window；
 *    toDate null（放進待排區）也回 out_of_window（模擬區沒有待排區，要退回請拖回待排池＝unplace）。
 *    新建列的 id 不可與任何正式列相同（id_exists）：否則組合狀態裡同一個 id 會同時代表正式卡與模擬卡。
 * 5. 對組合狀態（composeSimState）跑既有 applyOps({ byId }, ops, buildSimOpsContext(world))；失敗原樣回傳 code／opIndex／message。
 * 6. 成功：結果 next 中「範圍內、未完成、且是模擬列或本批新建」的列轉回 SimPlacement（placementToSim），其餘丟掉；
 *    simSource：新建、或日期／線／數量有變的列 → 'manual'；只改順序（reorder）或工時（setMinutes）的列保留原 simSource。
 *    split 拆出的新列 livePlacementId null；merge 被併掉的來源列消失。
 * 7. 結果列數 > SIM_MAX_PLACEMENTS → bad_request。
 * 回傳 { ok, placements（整份新模擬列，固定排序）, changedIds }。undo 由 route 用 snapshotForUndo／pushUndo 推。
 */
export function applySimOps(input: ApplySimOpsInput): ApplySimOpsResult {
  const { world, session, ops } = input
  const locks = session.locks
  const scope: SimScope = { windowDates: session.windowDates, lineIds: session.lineIds }
  const windowSet = new Set(session.windowDates)
  const lineSet = new Set(session.lineIds)
  const lockedLines = new Set(locks.lineIds)
  const simById = new Map(session.placements.map((p) => [p.id, p]))
  const liveIds = new Set(world.live.map((p) => p.id))
  /** 本批前面 place／split 新建的列 → 它的日期與線（之後同批 move／split 省略 lineId／toDate 時沿用） */
  const created = new Map<string, { planDate: YMD | null; lineId: number | null }>()

  type Fail = Extract<ApplySimOpsResult, { ok: false }>
  const fail = (code: Fail['code'], opIndex: number, message: string): Fail => ({ ok: false, code, opIndex, message })
  const isSimRow = (id: string) => simById.has(id) || created.has(id)
  const lineOfRow = (id: string): number | null => simById.get(id)?.lineId ?? created.get(id)?.lineId ?? null
  const dateOfRow = (id: string): YMD | null => simById.get(id)?.planDate ?? created.get(id)?.planDate ?? null
  const rowLocked = (id: string): boolean => {
    const r = simById.get(id)
    return r ? isRowLocked(r, locks) : false // 本批新建的列：訂單／線在 place 時已檢查過，不會是鎖定的
  }
  /** 目標（日期、線）必須在模擬範圍內、且不是鎖定線 */
  const checkTarget = (i: number, toDate: YMD | null | undefined, lineId: number | null | undefined): Fail | null => {
    if (toDate == null) return fail('out_of_window', i, '模擬區沒有待排區，要退回請拖回待排池')
    if (!windowSet.has(toDate)) return fail('out_of_window', i, `${toDate} 不在模擬範圍內`)
    if (lineId != null && !lineSet.has(lineId)) return fail('out_of_window', i, '這條線不在模擬範圍內')
    if (lineId != null && lockedLines.has(lineId)) return fail('locked', i, '這條線已鎖定，不能放入或移出卡片')
    return null
  }
  const checkRow = (i: number, id: string): Fail | null => {
    if (!isSimRow(id)) return fail('not_sim_row', i, '這張卡不在模擬範圍內（正式區唯讀），不能在模擬區調整')
    if (rowLocked(id)) return fail('locked', i, '這張卡已鎖定，不能調整')
    return null
  }
  const checkNewId = (i: number, id: string): Fail | null =>
    liveIds.has(id) || simById.has(id) || created.has(id) ? fail('id_exists', i, '卡片 id 重複，請重新整理') : null

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]
    if (!op || typeof op !== 'object' || !SIM_ALLOWED_OPS.has(op.op)) {
      return fail('op_not_allowed', i, `模擬區不接受這種操作（${String((op as { op?: unknown } | null)?.op)}）`)
    }
    switch (op.op) {
      case 'place': {
        if (isOrderLocked(op.soLineKey, locks)) return fail('locked', i, '這張訂單已鎖定，不能再排入')
        const t = checkTarget(i, op.toDate, op.lineId ?? null)
        if (t) return t
        const idErr = checkNewId(i, op.id)
        if (idErr) return idErr
        created.set(op.id, { planDate: op.toDate, lineId: op.lineId ?? null })
        break
      }
      case 'move': {
        const r = checkRow(i, op.id)
        if (r) return r
        const t = checkTarget(i, op.toDate, op.lineId ?? lineOfRow(op.id))
        if (t) return t
        break
      }
      case 'split': {
        const r = checkRow(i, op.id)
        if (r) return r
        for (const part of op.parts ?? []) {
          // toDate 省略＝沿用原卡日期（applyOps 的規則）；線省略＝沿用原卡線
          const d = part.toDate === undefined ? dateOfRow(op.id) : part.toDate
          const t = checkTarget(i, d, part.lineId ?? lineOfRow(op.id))
          if (t) return t
          const idErr = checkNewId(i, part.id)
          if (idErr) return idErr
          created.set(part.id, { planDate: d ?? null, lineId: part.lineId ?? lineOfRow(op.id) })
        }
        break
      }
      case 'merge': {
        const r = checkRow(i, op.targetId)
        if (r) return r
        for (const s of op.sources ?? []) {
          const e = checkRow(i, s.id)
          if (e) return e
        }
        break
      }
      case 'unplace':
      case 'reorder':
      case 'setMinutes': {
        const r = checkRow(i, op.id)
        if (r) return r
        break
      }
      default:
        return fail('op_not_allowed', i, '模擬區不接受這種操作')
    }
  }

  const composed = composeSimState(world.live, session)
  const orig = new Map(composed.placements.map((p) => [p.id, p]))
  const res = applyOps({ byId: orig }, ops, buildSimOpsContext(world))
  if (!res.ok) return { ok: false, code: res.code, opIndex: res.opIndex, message: res.message }

  const placements: SimPlacement[] = []
  const changedIds: string[] = []
  for (const p of res.next.values()) {
    const prev = simById.get(p.id) ?? null
    const before = orig.get(p.id)
    const isNew = !before
    if (!prev && !isNew) continue // 正式區唯讀列（範圍外／已完成／待排區／延誤卡）
    if (p.completed) continue
    if (!isInSimScope(p, scope)) {
      // 上面已逐一檢查目標；走到這裡代表規則有漏洞 → 擋下，不默默把數量丟回待排池
      return fail('out_of_window', 0, '操作結果有卡片落在模擬範圍外，請重新整理')
    }
    let simSource: SimSource = prev?.simSource ?? 'manual'
    if (isNew) simSource = 'manual'
    else if (before !== p) {
      const moved = before.planDate !== p.planDate || (before.lineId ?? null) !== (p.lineId ?? null) || Math.abs(before.qty - p.qty) > EPS
      if (moved) simSource = 'manual'
    }
    if (isNew || before !== p) changedIds.push(p.id)
    placements.push(placementToSim(p, prev, simSource))
  }
  if (placements.length > SIM_MAX_PLACEMENTS) {
    return fail('bad_request', 0, `模擬區最多 ${SIM_MAX_PLACEMENTS} 張卡，請先合併`)
  }
  placements.sort(compareSimRows)
  return { ok: true, placements, changedIds }
}

// ─────────────────────────────────────────────────────────────────────
// 退回上一步（§三「退回上一步」）
// ─────────────────────────────────────────────────────────────────────

const copyLocks = (l: SimLocks): SimLocks => ({ placementIds: [...l.placementIds], soNumbers: [...l.soNumbers], lineIds: [...l.lineIds] })
const cutChars = (s: string, max: number): string => {
  const chars = Array.from(s ?? '')
  return chars.length > max ? chars.slice(0, max).join('') : (s ?? '')
}

/**
 * 取 session 目前狀態做一格 undo（深拷貝 placements／locks／陣列，之後改 session 不會改到快照）。
 * D101：模擬產能（simCapacity）也一起深拷貝——所有推 undo 的路徑（ops、locks、ai_run、reset、load_run、capacity）自動帶上產能快照；
 *   state 沒有這欄（測試替身、舊格）就不帶這個鍵（退回時保留目前產能）。
 *   在這裡就地拷貝（不 import simCapacity.ts）：simCapacity.ts 會 import 本檔的 composeSimState，互相 import 會形成循環。
 */
export function snapshotForUndo(state: SimSessionState, label: string, kind: SimUndoKind, at: string): SimUndoEntry {
  const cap = state.simCapacity
  return {
    label: cutChars(label, SIM_LABEL_MAX),
    kind,
    at,
    state: {
      horizon: state.horizon,
      mode: state.mode,
      windowDates: [...state.windowDates],
      lineIds: [...state.lineIds],
      placements: state.placements.map((p) => ({ ...p })),
      locks: copyLocks(state.locks),
      ...(cap !== undefined
        ? { simCapacity: { v: 1 as const, cells: cap.cells.map((c) => ({ ...c, base: { ...c.base } })), weekendsOpened: [...cap.weekendsOpened] } }
        : {}),
    },
  }
}

/**
 * 估算 Postgres `octet_length(<jsonb>::text)`（DB 大小 check 量的就是它）：JSON.stringify 的 UTF-8 位元組數
 * ＋字串裡每個 ':' 與 ','（jsonb 轉文字時每個鍵值分隔與元素分隔後面都會多一個空白）。
 * 字串內容裡的 ':'／',' 也算進去 → 只會高估、不會低估（保守，寧可 undo 少留一格也不要整份寫不進去）。
 * 為什麼不用 JSON.stringify(v).length：那是 UTF-16 字元數，中文一字只算 1，DB 算 3 bytes；審查實測（ai-impl/review/r5-undo-size）
 *   每格 1000 張時字元數在上限內、位元組卻超過 8,000,000 → 每次寫入都 23514 失敗。
 * 不用 TextEncoder／Buffer：這支是純函式（前端與 node:test 都會載入），逐字元算即可、也不必配置一份位元組陣列。
 */
export function jsonbTextBytes(v: unknown): number {
  const json = JSON.stringify(v) ?? ''
  let bytes = 0
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i)
    if (c < 0x80) {
      bytes += c === 0x3a || c === 0x2c ? 2 : 1 // ':' ','（jsonb 輸出多一個空白）
    } else if (c < 0x800) {
      bytes += 2
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < json.length) {
      const n = json.charCodeAt(i + 1)
      if (n >= 0xdc00 && n <= 0xdfff) { bytes += 4; i++ } else bytes += 3
    } else {
      bytes += 3
    }
  }
  return bytes
}

/** 模擬列整份是否超過上限（張數 SIM_MAX_PLACEMENTS 或位元組 SIM_PLACEMENTS_MAX_BYTES）；寫進 session.placements 前檢查 */
export function simPlacementsTooLarge(placements: readonly SimPlacement[]): boolean {
  return placements.length > SIM_MAX_PLACEMENTS || jsonbTextBytes(placements) > SIM_PLACEMENTS_MAX_BYTES
}

/**
 * 推一格（舊 → 新，新的放最後）：超過 SIM_UNDO_LIMIT 從最舊的丟；估算的 jsonb 位元組數（jsonbTextBytes）> SIM_UNDO_MAX_BYTES
 * 也從最舊的丟，直到符合（至少保留剛推的這一格）。label 截到 SIM_LABEL_MAX。回傳新陣列，不改輸入。
 */
export function pushUndo(stack: readonly SimUndoEntry[], entry: SimUndoEntry): SimUndoEntry[] {
  const out = [...stack, { ...entry, label: cutChars(entry.label, SIM_LABEL_MAX) }]
  while (out.length > SIM_UNDO_LIMIT) out.shift()
  // 每格各算一次（整份 stringify 在 30 格 × 數百張時很慢）；陣列＝各格＋元素之間的 ', '（2 bytes）＋兩個括號
  const sizes = out.map((e) => jsonbTextBytes(e))
  let total = sizes.reduce((s, n) => s + n, 0) + Math.max(0, sizes.length - 1) * 2 + 2
  while (out.length > 1 && total > SIM_UNDO_MAX_BYTES) {
    out.shift()
    total -= sizes.shift()! + 2
  }
  return out
}

/** 彈出最新一格：{ entry: 最後一格 | null（空堆疊）, rest: 其餘 }；不改輸入 */
export function popUndo(stack: readonly SimUndoEntry[]): { entry: SimUndoEntry | null; rest: SimUndoEntry[] } {
  if (stack.length === 0) return { entry: null, rest: [] }
  return { entry: stack[stack.length - 1], rest: stack.slice(0, -1) }
}
