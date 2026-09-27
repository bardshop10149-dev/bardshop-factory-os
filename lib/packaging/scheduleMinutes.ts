// 包裝專區 P1 分線輪 — D69 主管覆寫工時（純函式，lines.md §3.6）
//
// 覆寫的顆粒度＝擺放列（子卡），值「以該列 qty 為準」存在 packaging_placements.est_minutes_override；
// 畫面顯示的是「依有效數量」的工時（待排池減少被修剪時等比縮小）。
// 不 import supabase、不讀時鐘；相對路徑 import、不用 enum（node --experimental-strip-types 可直接測）。

import {
  MINUTES_OVERRIDE_MAX,
  MINUTES_OVERRIDE_MIN,
  MINUTES_SNAP,
  type ManualRouteType,
  type MinutesEditVia,
  type Placement,
  type TimeAdjustmentRow,
  type YMD,
} from './scheduleTypes'
import type { PackagingCard, SourceKind } from './types'
import { minutesForQty } from './scheduleAllocate'

const round1 = (x: number): number => Math.round(x * 10) / 10
const round4 = (x: number): number => Math.round(x * 10000) / 10000
const clampOverride = (m: number): number => Math.min(MINUTES_OVERRIDE_MAX, Math.max(MINUTES_OVERRIDE_MIN, round1(m)))

/** 標準估計工時（＝minutesForQty：perUnit 未知 null、qty ≤ 0 → 0、最少 10 分） */
export function stdMinutesFor(perUnit: number | null, qty: number): number | null {
  return minutesForQty(perUnit, qty)
}

/**
 * 卡片實際顯示／計入負荷的工時（D69 規則 1）：
 * - 有覆寫 → round1(override × effectiveQty ÷ qty)（被修剪時等比縮小；effectiveQty 0 → 0）
 * - 否則 → 標準估計（依有效數量）
 */
export function effectiveMinutes(p: { qty: number; effectiveQty: number; override: number | null | undefined; perUnit: number | null }): number | null {
  if (p.override != null) {
    if (p.effectiveQty <= 0 || p.qty <= 0) return 0
    if (Math.abs(p.effectiveQty - p.qty) < 1e-9) return round1(p.override)
    return round1((p.override * p.effectiveQty) / p.qty)
  }
  return stdMinutesFor(p.perUnit, p.effectiveQty)
}

/**
 * D69 規則 2 拆卡：原卡有覆寫 → 依數量比例分給原卡與各新卡；沒有覆寫 → 全部 null（沿用標準估計）。
 * 各張 round1(override × q ÷ qty)、捨入差補到原卡；任一張低於 MINUTES_OVERRIDE_MIN 時取 MIN。
 * 例：500 件覆寫 300 分，拆成 300／200 → 180／120。
 */
export function splitOverride(
  override: number | null | undefined,
  qty: number,
  keepQty: number,
  partQtys: readonly number[],
): { keep: number | null; parts: (number | null)[] } {
  if (override == null || qty <= 0) return { keep: null, parts: partQtys.map(() => null) }
  const parts = partQtys.map((q) => clampOverride((override * q) / qty))
  const keep = clampOverride(override - parts.reduce((s, x) => s + x, 0))
  void keepQty // keep 以「總量 − 各新卡」求得，捨入差自然落在原卡；keepQty 只為了呼叫端語意清楚
  return { keep, parts }
}

/**
 * D69 規則 3 合併：任一張有覆寫 → 合併後覆寫＝各張「覆寫值或標準值（依該張 qty）」加總（上限 MAX）；都沒有 → null。
 * （各張的覆寫都是以該張 qty 為準，加總後正好以合併後的 qty 為準）
 */
export function mergeOverride(
  target: { qty: number; override: number | null | undefined },
  sources: readonly { qty: number; override: number | null | undefined }[],
  perUnit: number | null,
): number | null {
  const all = [target, ...sources]
  if (all.every((x) => x.override == null)) return null
  const sum = all.reduce((s, x) => s + (x.override ?? stdMinutesFor(perUnit, x.qty) ?? 0), 0)
  return clampOverride(sum)
}

/**
 * 畫面上改的是「有效數量的工時」，存回 DB 要換成「以本列 qty 為準」：round1(newEff × qty ÷ effectiveQty)。
 * 有效數量 0（已被待排池扣完）時無從換算 → 直接存 newEff。結果夾在 [MIN, MAX]。
 */
export function overrideFromEffective(newEffMinutes: number, qty: number, effectiveQty: number): number {
  if (effectiveQty <= 0 || qty <= 0) return clampOverride(newEffMinutes)
  return clampOverride((newEffMinutes * qty) / effectiveQty)
}

/** 拉卡片下緣的吸附：四捨五入到 snap（預設 5 分），下限 snap（lines.md §3.7：吸附在「工時分鐘」上，不是鐘面分鐘） */
export function snapMinutes(m: number, snap: number = MINUTES_SNAP): number {
  if (!Number.isFinite(m)) return snap
  return Math.max(snap, Math.round(m / snap) * snap)
}

/** 覆寫值合法：(0, 6000]、≥ MINUTES_OVERRIDE_MIN、最多 1 位小數（DB numeric(8,1) 與 check） */
export function isValidOverride(m: unknown): m is number {
  return typeof m === 'number' && Number.isFinite(m)
    && m >= MINUTES_OVERRIDE_MIN && m <= MINUTES_OVERRIDE_MAX
    && Math.abs(Math.round(m * 10) - m * 10) < 1e-6
}

/** 待排池卡的來源 → 學習紀錄的途程類型（同 stdTime 的 routeType） */
export function routeTypeOfSource(kind: SourceKind | null | undefined): ManualRouteType | null {
  return kind === 'changping' ? '常平' : kind === 'outsource' ? '委外' : kind === 'inhouse' ? '自製' : null
}

/**
 * D69 規則 6：組一筆 packaging_time_adjustments（伺服器在 setMinutes 寫入成功後插入）。
 * - qty＝修改當下的有效數量（有效數量 0 時退用本列 qty，DB 要求 > 0）
 * - std／before／after 都是「依有效數量」的工時；清除覆寫時 after＝標準值
 * - 品名只存前 80 字、不存客戶名稱（學習用不到，減少個資）
 */
export function buildAdjustment(input: {
  before: Placement
  after: Placement
  /** 該行待排池底卡（BoardCard.card 同一張）；行已不在池內時 null */
  card: PackagingCard | null
  effectiveQty: number
  /** 該行每件分鐘（LineSupply.perUnit） */
  perUnit: number | null
  reason: string | null
  via: MinutesEditVia
  actor: { email: string; name: string | null }
}): Omit<TimeAdjustmentRow, 'id' | 'created_at'> {
  const { before, after, card, perUnit } = input
  const effQty = input.effectiveQty > 0 ? input.effectiveQty : after.qty
  const stdMin = stdMinutesFor(perUnit, effQty)
  const beforeMin = effectiveMinutes({ qty: before.qty, effectiveQty: effQty, override: before.minutesOverride?.minutes ?? null, perUnit })
  const afterOverride = after.minutesOverride?.minutes ?? null
  const afterMin = effectiveMinutes({ qty: after.qty, effectiveQty: effQty, override: afterOverride, perUnit })
  const cut = (s: string | null | undefined, n: number): string | null => (s ? s.slice(0, n) : null)
  return {
    placement_id: after.id,
    so_line_key: after.soLineKey,
    item_code: card?.itemCode ?? null,
    item_name: cut(card?.itemName, 80),
    qty: effQty,
    packing: cut(card?.packing, 200),
    route_type: routeTypeOfSource(card?.sourceKind),
    work_source: card?.work.source ?? null,
    work_explain: cut(card?.work.explain, 300),
    per_unit_std: perUnit == null ? null : round4(perUnit),
    std_minutes: stdMin,
    before_minutes: beforeMin,
    after_minutes: afterMin,
    per_unit_after: afterMin == null || effQty <= 0 ? null : round4(afterMin / effQty),
    cleared: afterOverride == null,
    reason: input.reason ? input.reason.slice(0, 200) : null,
    via: input.via,
    plan_date: (after.planDate ?? null) as YMD | null,
    line_id: after.planDate != null ? (after.lineId ?? null) : null,
    actor_email: input.actor.email,
    actor_name: input.actor.name,
  }
}
