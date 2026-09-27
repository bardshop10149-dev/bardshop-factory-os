// 包裝專區 P1 — 版本快照（純函式，規格 §3.9；D33）
//
// 可變的現況用列（packaging_placements），不可變的歷史用 JSON（packaging_schedule_versions.snapshot）。
// 快照只存「計畫」：未完成的擺放。完成是事實不是計畫，還原時已完成列一律不動。
//
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum。

import type { Placement, PlacementSnapshotRow, RestorePlan, ScheduleSnapshot, YMD } from './scheduleTypes'
import { isValidYmd } from './scheduleCalendar'

export function toSnapshotRow(p: Placement): PlacementSnapshotRow {
  return {
    id: p.id, soLineKey: p.soLineKey, qty: p.qty, planDate: p.planDate,
    originalDate: p.originalDate, source: p.source, originCardId: p.originCardId,
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
  return { schemaVersion: 1, takenAt: nowIso, today, placements: rows }
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

function parseRow(x: unknown): PlacementSnapshotRow | null {
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
  return {
    id: o.id, soLineKey: o.soLineKey, qty,
    planDate: (o.planDate as YMD | null | undefined) ?? null,
    originalDate: (o.originalDate as YMD | null | undefined) ?? null,
    source: o.source,
    originCardId: (o.originCardId as string | null | undefined) ?? null,
  }
}

/** DB 讀出的 jsonb → ScheduleSnapshot；schemaVersion 不是 1 或任一列不合法 → null（不做部分還原） */
export function parseSnapshot(json: unknown): ScheduleSnapshot | null {
  if (!json || typeof json !== 'object') return null
  const o = json as Record<string, unknown>
  if (o.schemaVersion !== 1 || !Array.isArray(o.placements)) return null
  if (typeof o.takenAt !== 'string' || !isValidYmd(o.today)) return null
  const rows: PlacementSnapshotRow[] = []
  for (const r of o.placements) {
    const p = parseRow(r)
    if (!p) return null
    rows.push(p)
  }
  return { schemaVersion: 1, takenAt: o.takenAt, today: o.today, placements: rows }
}

/**
 * 還原計畫（D33）：刪除目前所有未完成擺放、以新 id 寫入快照列（舊 id 可能已是別的已完成列）。
 * 日期已過、數量超過目前供給等情形「不在還原時修正」，全交給讀取時的 §3.3／§3.5（同一套規則，不另寫特例）。
 */
export function planRestore(
  current: readonly Placement[],
  snap: ScheduleSnapshot,
  ctx: { today: YMD; poolLines: ReadonlySet<string>; newId: () => string },
): { plan: RestorePlan; deleteIds: string[]; inserts: PlacementSnapshotRow[] } {
  const deleteIds = current.filter((p) => !p.completed).map((p) => p.id)
  const inserts = snap.placements.map((r) => ({ ...r, id: ctx.newId() }))
  return {
    plan: {
      removeCount: deleteIds.length,
      insertCount: inserts.length,
      pastDateCount: inserts.filter((r) => r.planDate != null && r.planDate < ctx.today).length,
      lineGoneCount: inserts.filter((r) => !ctx.poolLines.has(r.soLineKey)).length,
    },
    deleteIds,
    inserts,
  }
}
