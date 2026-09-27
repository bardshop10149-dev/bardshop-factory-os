// 包裝專區 — D74 線內上下排序（純函式；伺服器組裝工作台、applyOps 與前端樂觀更新共用同一套規則）
//
// 規則（規格 docs/design/2026-09-27-packaging-lines.md 第十三章 §13.2）：
//   同一天同一條線內，卡片由上往下＝
//     ① 「固定排序群組」：sort_index 為 null 的卡，以及延誤卡（D50 順延到今天、還沒被主管重排的卡），
//        依既有固定排序（延誤天數多 → 預排到期 → 打樣 → 交期 → 建立時間）→ 延誤卡一定在最上面
//     ② 其後是有 sort_index 的卡，由小到大（平手再用固定排序）
//   新排入（place／move 到別的「天×線」、split 拆出的新卡、待排區卡勾完成）＝appendSortIndex(now) → 一定落在該線最後。
//   主管上下拖曳：該線其他（非延誤）卡都已有 sort_index → 只改被拖的那張（取前後兩張的中間值）；
//     還有 null 的卡（或間距不夠）→ 除延誤卡外整條線依新順序重新編號 1、2、3…（一次送出＝一步 Undo）。
//   延誤卡「釘在最上面」：別的卡不能插到它上面；拖動延誤卡本身＝排到它目前顯示的那天（move，解除延誤，同 D50「拖到任何一天即解除」）
//     並放到指定位置（replan）。
//
// 為什麼 null 放「最上面」而不是最下面：
//   「新排入的卡放該線最後」要在「這條線從沒調整過（全是 null）」時也成立。若 null 放最下面，
//   新卡（有 sort_index）反而會跑到所有舊卡的上面；null 放最上面，新卡一律在最後，調整過的線也一樣。
//   舊資料（套用 migration 前的卡、舊版穩定站新增的卡）都是 null → 維持原本固定排序、排在最上面。
// 為什麼延誤卡不看 sort_index：順延進來的卡帶著「原本那天」的順序值，和今天這條線的值比大小沒有意義
//   （昨天的第 2 張會插在今天的第 2 張後面）；延誤＝該先處理的舊工作，固定在最上面最直覺。
//
// 不 import supabase、不讀時鐘（now 由參數傳入）；相對路徑 import、不用 enum（node --experimental-strip-types 可直接測）。

import { SORT_INDEX_ABS_MAX, SORT_INDEX_DECIMALS } from './scheduleTypes'

/** appendSortIndex 的起點：2026-01-01T00:00:00Z（之後每分鐘 +1；numeric(12,4) 可用到約 2216 年） */
export const SORT_INDEX_EPOCH_MS = Date.UTC(2026, 0, 1)
const SCALE = 10 ** SORT_INDEX_DECIMALS
const EPS = 1e-9

export const round4 = (x: number): number => Math.round(x * SCALE) / SCALE

/** numeric(12,4) 放得下、最多 4 位小數的有限數字 */
export function isValidSortIndex(x: unknown): x is number {
  if (typeof x !== 'number' || !Number.isFinite(x)) return false
  if (Math.abs(x) > SORT_INDEX_ABS_MAX) return false
  return Math.abs(Math.round(x * SCALE) - x * SCALE) < 1e-6
}

/**
 * 「放在該線最後」的 sort_index：2026-01-01 起的分鐘數（一定大於主管拖曳重新編號的 1、2、3…，也大於更早排入的卡）。
 * seq：同一批操作裡的第幾張（拆卡一次拆出多張時保持拆出的先後），每張 +0.001 分。
 */
export function appendSortIndex(nowIso: string, seq = 0): number {
  const t = Date.parse(nowIso)
  const minutes = Number.isFinite(t) ? (t - SORT_INDEX_EPOCH_MS) / 60_000 : 0
  return round4(Math.min(SORT_INDEX_ABS_MAX - 1, Math.max(0, minutes)) + Math.max(0, seq) * 0.001)
}

/** 排序時實際採用的 sort_index：延誤卡（delayWorkdays > 0）一律視為 null（固定排序群組、延誤在最上面） */
export function effectiveSortIndex(c: { sortIndex?: number | null; delayWorkdays?: number }): number | null {
  return (c.delayWorkdays ?? 0) > 0 ? null : (c.sortIndex ?? null)
}

/** 只比 sort_index：null 在前（回負數）、都有值時小的在前；都 null 或相等回 0（交給固定排序） */
export function compareSortIndex(a: number | null | undefined, b: number | null | undefined): number {
  const an = a == null
  const bn = b == null
  if (an && bn) return 0
  if (an) return -1
  if (bn) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

type Orderable = { sortIndex?: number | null; delayWorkdays?: number }

/** 線內完整排序：有效 sort_index（null／延誤在前）→ 平手用 tie（固定排序） */
export function compareLaneOrder<T extends Orderable>(a: T, b: T, tie: (a: T, b: T) => number): number {
  return compareSortIndex(effectiveSortIndex(a), effectiveSortIndex(b)) || tie(a, b)
}

/**
 * 穩定排序（前端樂觀更新用）：只依有效 sort_index 重排，同為 null（含延誤卡）或相同的卡保留目前的相對順序
 * （目前順序＝伺服器上次排好的固定排序，前端沒有建立時間等資料可以重算）。
 */
export function sortByLaneOrder<T extends Orderable>(cards: readonly T[]): T[] {
  return cards
    .map((c, i) => ({ c, i, s: effectiveSortIndex(c) }))
    .sort((x, y) => compareSortIndex(x.s, y.s) || x.i - y.i)
    .map((x) => x.c)
}

/**
 * 拖曳放下的插入位置：pointer 的 y（相對於該線時間軸本體頂端，px）落在第幾張卡「之前」。
 * layouts＝該線畫面上的卡（不含被拖的那張）由上往下；以每張卡的垂直中線為界。回 0～layouts.length。
 */
export function insertIndexAt(layouts: readonly { topPx: number; heightPx: number }[], yPx: number): number {
  let n = 0
  for (const l of layouts) {
    if (l.topPx + l.heightPx / 2 < yPx) n++
    else break
  }
  return n
}

export interface LaneOrderEntry {
  placementId: string
  version: number
  /** DB 的 sort_index（延誤卡也傳原值；是否採用看 pinned） */
  sortIndex?: number | null
  /** 延誤卡：釘在最上面（固定排序群組），別的卡不能插到它上面；它自己被拖＝replan */
  pinned?: boolean
}

export interface ReorderChange {
  id: string
  version: number
  sortIndex: number
  /** 被拖的是延誤卡：要送 move（排到目前顯示的那天、解除延誤）並帶這個 sortIndex，而不是 reorder */
  replan?: boolean
}

/**
 * 主管把 movingId 拖到 beforeId 之前（beforeId null＝放到最後）後，這條線要改哪些卡的 sort_index。
 * lane：這條線「目前的顯示順序」（含已完成、含隱藏的已完成；不含別條線）；延誤卡（pinned）一定是最前面的一段。
 * 回傳 null＝movingId 不在這條線；changes 空陣列＝位置沒變（不用送）。
 * - 插入位置不能在延誤卡上面（夾到延誤卡之後）
 * - 其他非延誤卡全都有 sort_index → 只改被拖的那張：前後兩張的中間值（第一張非延誤＝下一張 − 1、最下面＝上一張 + 1）
 * - 有 null 的卡、或中間值塞不下（間距 < 0.0001 或平手）→ 非延誤卡依新順序重新編號 1、2、3…（只送值有變的卡）
 * - 被拖的是延誤卡 → 它的那一筆標 replan（一律要送）
 */
export function planLaneReorder(
  lane: readonly LaneOrderEntry[],
  movingId: string,
  beforeId: string | null,
): { order: string[]; changes: ReorderChange[]; renumbered: boolean } | null {
  const moving = lane.find((c) => c.placementId === movingId)
  if (!moving) return null
  const rest = lane.filter((c) => c.placementId !== movingId)
  let pinnedCount = rest.findIndex((c) => !c.pinned)
  if (pinnedCount < 0) pinnedCount = rest.length
  let pos = beforeId == null ? rest.length : rest.findIndex((c) => c.placementId === beforeId)
  if (pos < 0) pos = rest.length
  pos = Math.max(pos, pinnedCount)
  const next = [...rest.slice(0, pos), moving, ...rest.slice(pos)]
  const order = next.map((c) => c.placementId)
  if (order.every((id, i) => id === lane[i].placementId)) return { order, changes: [], renumbered: false }
  const replan = moving.pinned ? { replan: true as const } : {}

  const others = rest.slice(pinnedCount)
  if (others.every((c) => c.sortIndex != null)) {
    const prev = pos > pinnedCount ? (rest[pos - 1].sortIndex as number) : null
    const nxt = pos < rest.length ? (rest[pos].sortIndex as number) : null
    const cand = round4(prev != null && nxt != null ? (prev + nxt) / 2 : prev != null ? prev + 1 : nxt != null ? nxt - 1 : 1)
    const fits = (prev == null || cand > prev + EPS) && (nxt == null || cand < nxt - EPS) && isValidSortIndex(cand)
    if (fits) return { order, changes: [{ id: moving.placementId, version: moving.version, sortIndex: cand, ...replan }], renumbered: false }
  }
  const changes: ReorderChange[] = []
  next.slice(pinnedCount).forEach((c, i) => {
    const v = i + 1
    const isMoving = c.placementId === moving.placementId
    if (c.sortIndex == null || Math.abs(c.sortIndex - v) > EPS || (isMoving && moving.pinned)) {
      changes.push({ id: c.placementId, version: c.version, sortIndex: v, ...(isMoving ? replan : {}) })
    }
  })
  return { order, changes, renumbered: true }
}
