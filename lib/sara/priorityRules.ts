// SARA Priority Level（排程優先等級 1-99）——依交期自動判斷的共用規則
//
// 2026-09-01 生管定義的預設級距（距今天數 → 優先度）：
//   ≤2 天 → 10、3 天 → 9、4~5 天 → 8、6~7 天 → 7、8~10 天 → 6、超過 10 天 → 不填
// 規則可在「SARA 工序格式產生器」頁面上方編輯，存於 app_settings.sara_priority_rules，
// 手動轉換與每日自動轉換（autoProcessGen）都套用同一份。
//
// 本檔只放「純函式與預設值」（client/server 皆可 import）；
// 讀寫儲存的規則走 /api/sara/priority-rules。

export interface PriorityRule {
  /** 交期距今天數的上限（含）——依 max_days 由小到大逐級比對，落在第一個符合的級距 */
  max_days: number
  /** 套用的優先度（1-99，數字越大越優先） */
  priority: number
}

export const DEFAULT_PRIORITY_RULES: PriorityRule[] = [
  { max_days: 2, priority: 10 },
  { max_days: 3, priority: 9 },
  { max_days: 5, priority: 8 },
  { max_days: 7, priority: 7 },
  { max_days: 10, priority: 6 },
]

export const PRIORITY_RULES_SETTINGS_KEY = 'sara_priority_rules'

/** 正規化外部載入的規則（過濾非法值、依 max_days 排序）；空陣列回傳預設 */
export function normalizePriorityRules(raw: unknown): PriorityRule[] {
  if (!Array.isArray(raw)) return DEFAULT_PRIORITY_RULES
  const cleaned = raw
    .map(r => ({
      max_days: Number((r as PriorityRule)?.max_days),
      priority: Number((r as PriorityRule)?.priority),
    }))
    .filter(r => Number.isFinite(r.max_days) && r.max_days >= 0 && Number.isInteger(r.priority) && r.priority >= 1 && r.priority <= 99)
    .sort((a, b) => a.max_days - b.max_days)
  return cleaned.length > 0 ? cleaned : DEFAULT_PRIORITY_RULES
}

/** 解析交期字串（支援 YYYY/M/D、YYYY-MM-DD），回傳「該日 00:00 的 UTC epoch（把台北時鐘視為 UTC 座標）」 */
function parseDueDateMs(due: string): number | null {
  const m = due.trim().match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** 今天（台北）00:00 的同座標 epoch */
export function taipeiTodayMs(): number {
  const t = new Date(Date.now() + 8 * 3600 * 1000)
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())
}

/**
 * 依交期算 Priority Level：回傳字串（無符合級距或交期無法解析時回空字串）。
 * 交期已過（負天數）視為 0 天處理（最急）。
 */
export function computePriorityFromDue(due: string | null | undefined, rules: PriorityRule[], todayMs: number = taipeiTodayMs()): string {
  if (!due) return ''
  const dueMs = parseDueDateMs(due)
  if (dueMs === null) return ''
  const days = Math.max(0, Math.round((dueMs - todayMs) / 86400000))
  for (const r of rules) {
    if (days <= r.max_days) return String(r.priority)
  }
  return ''
}
