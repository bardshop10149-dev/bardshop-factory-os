// 包裝專區 P1 — DB 列（snake_case）↔ API 型別（camelCase）轉換（純函式）
//
// PostgREST 回傳 numeric 可能是 number 也可能是字串（依設定），一律 Number() 正規化。
// 相對路徑 import、不用 enum。

import {
  VERSION_RETENTION_DAYS,
  type DailyCapacity,
  type DailyCapacityRow,
  type EditLockRow,
  type LockState,
  type Placement,
  type PlacementRow,
  type ScheduleVersionRow,
  type VersionMeta,
} from './scheduleTypes'
import { evaluateLock } from './scheduleLock'

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0))
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v))
/** date 欄位保險起見只取前 10 碼 */
const ymdOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null)

export function rowToPlacement(r: PlacementRow): Placement {
  return {
    id: r.id,
    soLineKey: r.so_line_key,
    qty: num(r.qty),
    planDate: ymdOrNull(r.plan_date),
    originalDate: ymdOrNull(r.original_date),
    source: r.source === 'ai' ? 'ai' : 'manual',
    originCardId: r.origin_card_id ?? null,
    completed: r.completed_at
      ? { at: r.completed_at, by: r.completed_by ?? '', byName: r.completed_by_name ?? null, poolQtyAt: numOrNull(r.completed_pool_qty) }
      : null,
    version: num(r.version),
    createdAt: r.created_at,
    createdBy: r.created_by,
    createdByName: r.created_by_name ?? null,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    updatedByName: r.updated_by_name ?? null,
  }
}

export function placementToRow(p: Placement): PlacementRow {
  return {
    id: p.id,
    so_line_key: p.soLineKey,
    qty: p.qty,
    plan_date: p.planDate,
    original_date: p.originalDate,
    source: p.source,
    origin_card_id: p.originCardId,
    completed_at: p.completed?.at ?? null,
    completed_by: p.completed?.by ?? null,
    completed_by_name: p.completed?.byName ?? null,
    completed_pool_qty: p.completed?.poolQtyAt ?? null,
    version: p.version,
    created_by: p.createdBy,
    created_by_name: p.createdByName,
    created_at: p.createdAt,
    updated_by: p.updatedBy,
    updated_by_name: p.updatedByName,
    updated_at: p.updatedAt,
  }
}

export function rowToCapacity(r: DailyCapacityRow): DailyCapacity {
  return {
    date: ymdOrNull(r.date) ?? r.date,
    headcount: r.headcount == null ? null : num(r.headcount),
    regularHours: num(r.regular_hours),
    overtimeHoursMax: num(r.overtime_hours_max),
    isSaturdayOpen: r.is_saturday_open === true,
    note: r.note ?? null,
    updatedBy: r.updated_by,
    updatedByName: r.updated_by_name ?? null,
    updatedAt: r.updated_at,
  }
}

/** 鎖列 → LockState（＝evaluateLock；放這裡讓 API 端一次 import 完所有轉換） */
export function lockRowToState(row: EditLockRow | null, nowMs: number, caller: { email: string; token: string | null }): LockState {
  return evaluateLock(row, nowMs, caller)
}

/** 版本列（不含 snapshot 亦可）→ VersionMeta；expiresAt＝createdAt＋90 天（D33） */
export function versionRowToMeta(r: Omit<ScheduleVersionRow, 'snapshot'> & { snapshot?: unknown }): VersionMeta {
  const created = Date.parse(r.created_at)
  return {
    id: num(r.id),
    label: r.label,
    source: r.source,
    placementCount: num(r.placement_count),
    createdAt: r.created_at,
    createdBy: r.created_by,
    createdByName: r.created_by_name ?? null,
    expiresAt: new Date((Number.isFinite(created) ? created : 0) + VERSION_RETENTION_DAYS * 86_400_000).toISOString(),
  }
}
