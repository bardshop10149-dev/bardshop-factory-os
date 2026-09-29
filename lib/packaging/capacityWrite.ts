// 包裝專區 — 執行產能寫入計畫（I/O；D101 自 PUT /api/packaging/capacity 抽出，寫入順序與抽出前逐字相同）
//
// 計畫由 capacityPlan.planCapacityPut 算好（純函式）；這裡只照順序寫進 packaging_daily_capacity／packaging_line_capacity。
// 呼叫端：PUT /api/packaging/capacity（產能表手動儲存）、AI 採用（寫入模擬產能）、AI 退回採用（還原產能）。
// 沒有交易（PostgREST 一個請求一個敘述）：順序偏向「週末沒開」——
//   a. 關閉週末的 daily（旗標 false）先寫、整天清除的 daily 先刪
//   b. 各線列（upsert、delete、整天清除）
//   c. 其餘 daily（含開週末：線列已在，最後才打開旗標）
// 中途失敗丟 ScheduleDbError（由呼叫端決定要不要補償）；前面已寫入的不會自動還原。

import {
  deleteCapacity,
  deleteLineCapacity,
  deleteLineCapacityDates,
  upsertCapacity,
  upsertLineCapacity,
  type SupabaseAdmin,
} from './scheduleDb'
import type { CapacityWritePlan } from './capacityPlan'

export async function executeCapacityPlan(sb: SupabaseAdmin, plan: CapacityWritePlan, nowIso: string): Promise<void> {
  await upsertCapacity(sb, plan.closesFirst, nowIso)
  await deleteCapacity(sb, plan.clearDates)
  await upsertLineCapacity(sb, plan.lineUpserts, nowIso)
  await deleteLineCapacity(sb, plan.lineDeletes)
  await deleteLineCapacityDates(sb, plan.clearDates)
  await upsertCapacity(sb, plan.rest, nowIso)
}
