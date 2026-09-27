// 包裝專區 P1 — DB 列（snake_case）↔ API 型別（camelCase）轉換（純函式）
//
// PostgREST 回傳 numeric 可能是 number 也可能是字串（依設定），一律 Number() 正規化。
// 相對路徑 import、不用 enum。

import {
  VERSION_RETENTION_DAYS,
  type DailyCapacity,
  type DailyCapacityRow,
  type EditLockRow,
  type LineCapacity,
  type LineCapacityRow,
  type LockState,
  type ManualInclusion,
  type ManualInclusionMeta,
  type ManualInclusionRow,
  type ManualRouteType,
  type MinutesOverride,
  type PackagingLine,
  type PackagingLineRow,
  type Placement,
  type PlacementRow,
  type ScheduleVersionRow,
  type TimeAdjustment,
  type TimeAdjustmentRow,
  type VersionMeta,
} from './scheduleTypes'
import { evaluateLock } from './scheduleLock'

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0))

/** 待排區（plan_date null）的列寫入 DB 時填的 line_id＝DB 欄位預設值（A 線，sql/20260927b 第 4 段）；讀取時忽略 */
export const PARKED_ROW_LINE_ID = 1
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v))
/** date 欄位保險起見只取前 10 碼 */
const ymdOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length >= 10 ? v.slice(0, 10) : null)

/** D69 覆寫四欄 → MinutesOverride（覆寫值 null＝沒覆寫；舊程式列沒有這些欄 → null） */
function overrideOf(r: PlacementRow): MinutesOverride | null {
  if (r.est_minutes_override == null) return null
  return { minutes: Number(r.est_minutes_override), by: r.minutes_override_by ?? '', byName: r.minutes_override_by_name ?? null, at: r.minutes_override_at ?? '' }
}

export function rowToPlacement(r: PlacementRow): Placement {
  const planDate = ymdOrNull(r.plan_date)
  return {
    id: r.id,
    soLineKey: r.so_line_key,
    qty: num(r.qty),
    planDate,
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
    // D72：待排區（plan_date null）一律不屬於任何線——舊程式（穩定站）把卡移到待排區不會清 line_id，讀取時忽略（lines.md §1.4）
    lineId: planDate == null || r.line_id == null ? null : num(r.line_id),
    minutesOverride: overrideOf(r),
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
    // D72：待排區的卡「不屬於任何線」只是讀取端的語意（rowToPlacement 在 plan_date 為 null 時忽略 line_id）。
    // 寫入時待排區仍填 DB 預設的 A 線（1），不寫 null：舊版穩定站把待排區的卡移進日期或勾完成走 UPDATE、只改 plan_date
    // 不帶 line_id，DB 預設值不會生效；若這裡寫 null 就會違反 packaging_placements_line_required（23514）。
    line_id: p.planDate == null ? PARKED_ROW_LINE_ID : (p.lineId ?? null),
    // D69：覆寫值與誰何時改的「同有同無」（DB check minutes_override_meta）
    est_minutes_override: p.minutesOverride?.minutes ?? null,
    minutes_override_by: p.minutesOverride ? p.minutesOverride.by : null,
    minutes_override_by_name: p.minutesOverride ? p.minutesOverride.byName : null,
    minutes_override_at: p.minutesOverride ? p.minutesOverride.at : null,
  }
}

// ── 分線輪新表（sql/20260927b_packaging_p1_extend.sql）──

export function rowToLine(r: PackagingLineRow): PackagingLine {
  return {
    id: num(r.id),
    code: r.code,
    name: r.name,
    sortOrder: num(r.sort_order),
    active: r.active === true,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    updatedByName: r.updated_by_name ?? null,
  }
}

export function rowToLineCapacity(r: LineCapacityRow): LineCapacity {
  return {
    date: ymdOrNull(r.date) ?? r.date,
    lineId: num(r.line_id),
    regularHours: num(r.regular_hours),
    overtimeHoursMax: num(r.overtime_hours_max),
    note: r.note ?? null,
    updatedBy: r.updated_by,
    updatedByName: r.updated_by_name ?? null,
    updatedAt: r.updated_at,
  }
}

const asRouteType = (v: unknown): ManualRouteType => (v === '常平' || v === '委外' ? v : '自製')

export function rowToManualMeta(r: ManualInclusionRow): ManualInclusionMeta {
  return {
    inclusionId: num(r.id),
    qty: num(r.qty),
    routeType: asRouteType(r.route_type),
    reason: r.reason ?? null,
    addedBy: r.added_by,
    addedByName: r.added_by_name ?? null,
    addedAt: r.added_at,
  }
}

export function rowToManualInclusion(r: ManualInclusionRow): ManualInclusion {
  return {
    ...rowToManualMeta(r),
    soLineKey: r.so_line_key,
    so: r.so,
    lineNo: r.line_no,
    removedAt: r.removed_at ?? null,
    removedByName: r.removed_by_name ?? null,
    removedReason: r.removed_reason ?? null,
    updatedAt: r.updated_at,
  }
}

/** 學習紀錄 → API 形狀（不回 actor_email，只回名字） */
export function rowToAdjustment(r: TimeAdjustmentRow): TimeAdjustment {
  return {
    id: num(r.id),
    createdAt: r.created_at,
    placementId: r.placement_id,
    soLineKey: r.so_line_key,
    itemCode: r.item_code ?? null,
    itemName: r.item_name ?? null,
    qty: num(r.qty),
    packing: r.packing ?? null,
    routeType: r.route_type ?? null,
    workSource: r.work_source ?? null,
    workExplain: r.work_explain ?? null,
    perUnitStd: numOrNull(r.per_unit_std),
    stdMinutes: numOrNull(r.std_minutes),
    beforeMinutes: numOrNull(r.before_minutes),
    afterMinutes: numOrNull(r.after_minutes),
    perUnitAfter: numOrNull(r.per_unit_after),
    cleared: r.cleared === true,
    reason: r.reason ?? null,
    via: r.via === 'drag' || r.via === 'dialog' ? r.via : 'undo',
    planDate: ymdOrNull(r.plan_date),
    lineId: numOrNull(r.line_id),
    actorName: r.actor_name ?? null,
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
