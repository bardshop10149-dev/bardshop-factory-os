// 包裝專區 P1 — 版本快照（純函式，規格 §3.9；D33）
//
// 可變的現況用列（packaging_placements），不可變的歷史用 JSON（packaging_schedule_versions.snapshot）。
// 快照只存「計畫」：未完成的擺放。完成是事實不是計畫，還原時已完成列一律不動。
// 分線輪（lines.md §八）：schemaVersion 2 起每列多存 lineId（D72）與 estMinutesOverride（D69）；
// v1 快照照常可還原，排進日期的列落到預設線。
// D74：schemaVersion 3 起每列多存 sortIndex（線內上下順序）；v1／v2 還原後 sortIndex＝null（該線最上面、固定排序）。
//
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum。

import type { PackagingLine, Placement, PlacementSnapshotRow, RestorePlan, ScheduleSnapshot, YMD } from './scheduleTypes'
import { isValidYmd } from './scheduleCalendar'
import { isValidOverride } from './scheduleMinutes'
import { isValidSortIndex } from './laneOrder'

export function toSnapshotRow(p: Placement): PlacementSnapshotRow {
  return {
    id: p.id, soLineKey: p.soLineKey, qty: p.qty, planDate: p.planDate,
    originalDate: p.originalDate, source: p.source, originCardId: p.originCardId,
    // 待排區不屬於任何線（D72）
    lineId: p.planDate == null ? null : (p.lineId ?? null),
    estMinutesOverride: p.minutesOverride?.minutes ?? null,
    // D74：待排區沒有線內順序
    sortIndex: p.planDate == null ? null : (p.sortIndex ?? null),
  }
}

/** D33：只收未完成的擺放；依（日期、待排區最後、id）固定排序，同一份資料產生的 JSON 一樣 */
export function buildSnapshot(placements: readonly Placement[], today: YMD, nowIso: string): ScheduleSnapshot {
  const rows = placements.filter((p) => !p.completed).map(toSnapshotRow)
  rows.sort((a, b) => {
    if (a.planDate !== b.planDate) {
      if (a.planDate == null) return 1
      if (b.planDate == null) return -1
      return a.planDate < b.planDate ? -1 : 1
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return { schemaVersion: 3, takenAt: nowIso, today, placements: rows }
}

/** 快照上限：列數與 JSON 長度（migration 另有 octet_length < 5MB 的 check 當最後防線） */
export const SNAPSHOT_MAX_ROWS = 5000
export const SNAPSHOT_MAX_CHARS = 2_000_000

/** 超過上限回中文原因，否則 null（寫入版本前檢查；正常數百張約 60KB） */
export function snapshotTooLarge(snap: ScheduleSnapshot): string | null {
  if (snap.placements.length > SNAPSHOT_MAX_ROWS) return `未完成的卡 ${snap.placements.length} 張，超過快照上限 ${SNAPSHOT_MAX_ROWS} 張`
  const n = JSON.stringify(snap).length
  if (n > SNAPSHOT_MAX_CHARS) return `快照過大（約 ${Math.round(n / 1000)} KB），超過上限 ${Math.round(SNAPSHOT_MAX_CHARS / 1000)} KB`
  return null
}

const isLineIdLike = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= 32767

function parseRow(x: unknown, schemaVersion: 1 | 2 | 3): PlacementSnapshotRow | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  const qty = typeof o.qty === 'string' ? Number(o.qty) : o.qty
  if (typeof o.id !== 'string' || !o.id) return null
  if (typeof o.soLineKey !== 'string' || o.soLineKey.length < 3 || o.soLineKey.length > 80) return null
  if (typeof qty !== 'number' || !Number.isFinite(qty) || qty <= 0) return null
  if (o.planDate != null && !isValidYmd(o.planDate)) return null
  if (o.originalDate != null && !isValidYmd(o.originalDate)) return null
  if (o.source !== 'manual' && o.source !== 'ai') return null
  if (o.originCardId != null && typeof o.originCardId !== 'string') return null
  const planDate = (o.planDate as YMD | null | undefined) ?? null
  let lineId: number | null = null
  let estMinutesOverride: number | null = null
  let sortIndex: number | null = null
  // v1 的列視為「沒有線、沒有覆寫」（lines.md §八）；v2 起的兩欄格式不對 → 整份不收（不做部分還原）
  if (schemaVersion >= 2) {
    if (o.lineId != null && !isLineIdLike(o.lineId)) return null
    if (o.estMinutesOverride != null && !isValidOverride(o.estMinutesOverride)) return null
    lineId = planDate == null ? null : ((o.lineId as number | null | undefined) ?? null)
    estMinutesOverride = (o.estMinutesOverride as number | null | undefined) ?? null
  }
  // D74：v3 起有 sortIndex；v1／v2 視為 null（還原後排在該線最上面、依固定排序）
  if (schemaVersion >= 3) {
    if (o.sortIndex != null && !isValidSortIndex(o.sortIndex)) return null
    sortIndex = planDate == null ? null : ((o.sortIndex as number | null | undefined) ?? null)
  }
  return {
    id: o.id, soLineKey: o.soLineKey, qty,
    planDate,
    originalDate: (o.originalDate as YMD | null | undefined) ?? null,
    source: o.source,
    originCardId: (o.originCardId as string | null | undefined) ?? null,
    lineId,
    estMinutesOverride,
    sortIndex,
  }
}

/** DB 讀出的 jsonb → ScheduleSnapshot；schemaVersion 不是 1／2／3 或任一列不合法 → null（不做部分還原） */
export function parseSnapshot(json: unknown): ScheduleSnapshot | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  const ver = o.schemaVersion
  if ((ver !== 1 && ver !== 2 && ver !== 3) || !Array.isArray(o.placements)) return null
  if (typeof o.takenAt !== 'string' || !isValidYmd(o.today)) return null
  const rows: PlacementSnapshotRow[] = []
  for (const r of o.placements) {
    const p = parseRow(r, ver)
    if (!p) return null
    rows.push(p)
  }
  return { schemaVersion: ver, takenAt: o.takenAt, today: o.today, placements: rows }
}

/**
 * 還原計畫（D33）：刪除目前所有未完成擺放、以新 id 寫入快照列（舊 id 可能已是別的已完成列）。
 * 日期已過、數量超過目前供給等情形「不在還原時修正」，全交給讀取時的 §3.3／§3.5（同一套規則，不另寫特例）。
 * 分線（lines.md §4.7）：排進日期的列 lineId 缺（v1）、不存在或已停用 → 改放預設線，計入 lineRemappedCount。
 *   （沒給 lines 時不改線、lineRemappedCount 0——只給不需要線別的舊呼叫端；伺服器一律帶 lines。）
 * D74：sortIndex 照快照還原；改放預設線的列清成 null（原線的順序在別條線沒有意義 → 排在最上面、依固定排序，也比較顯眼）。
 */
export function planRestore(
  current: readonly Placement[],
  snap: ScheduleSnapshot,
  ctx: { today: YMD; poolLines: ReadonlySet<string>; newId: () => string; lines?: readonly PackagingLine[]; defaultLineId?: number | null },
): { plan: RestorePlan; deleteIds: string[]; inserts: PlacementSnapshotRow[] } {
  const deleteIds = current.filter((p) => !p.completed).map((p) => p.id)
  const active = ctx.lines ? new Set(ctx.lines.filter((l) => l.active).map((l) => l.id)) : null
  let lineRemappedCount = 0
  const inserts = snap.placements.map((r): PlacementSnapshotRow => {
    const row: PlacementSnapshotRow = {
      ...r, id: ctx.newId(),
      lineId: r.planDate == null ? null : (r.lineId ?? null),
      estMinutesOverride: r.estMinutesOverride ?? null,
      sortIndex: r.planDate == null ? null : (r.sortIndex ?? null),
    }
    if (active && row.planDate != null && (row.lineId == null || !active.has(row.lineId))) {
      row.lineId = ctx.defaultLineId ?? null
      row.sortIndex = null
      lineRemappedCount++
    }
    return row
  })
  return {
    plan: {
      removeCount: deleteIds.length,
      insertCount: inserts.length,
      pastDateCount: inserts.filter((r) => r.planDate != null && r.planDate < ctx.today).length,
      lineGoneCount: inserts.filter((r) => !ctx.poolLines.has(r.soLineKey)).length,
      lineRemappedCount,
    },
    deleteIds,
    inserts,
  }
}
