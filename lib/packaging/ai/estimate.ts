// 包裝專區 AI 排程 — 依卡片數的「預估耗時」與「時間預算」（純函式，零依賴，可直接單測）
//
// 為什麼不用固定 170 秒：Snow 要求時間隨卡片數增加而增加。實測（Opus 5.5 + effort high）214 張／4 天 → AI 呼叫 174 秒，
//   208 張 → 189 秒（Opus 5 medium）；冷實例組資料 9～18 秒。線性模型：固定 30 秒 + 0.9 秒/張（6 天 ×1.1）。
// 預算 = 預估 × AI_BUDGET_FACTOR（1.5），clamp 到 [AI_RUN_BUDGET_MIN_MS, AI_RUN_BUDGET_MS]：
//   - 下限 120 秒：小批次也可能遇到冷實例＋AI 首字延遲慢，不能一過預估就砍。
//   - 上限 AI_RUN_BUDGET_MS＝route maxDuration（AI_ROUTE_MAX_DURATION_MS，方案未確認前取 300 秒）− 30 秒寫回；所有數字都從這個常數推導，
//     不在這裡寫死秒數（之後 cap 改成 800，本檔不用動）。
//   ⚠ 預估 × 1.5 ≥ 上限後預算恆為上限，卡再多預算不會再變大；預估本身 > 上限 → zone 'over'，畫面標「超過上限」但仍讓它跑
//   （擋不擋是業務決策，先不擋）。cap 300 時 4 天約 229 張起 warn、267 張起 over（確切張數由 scripts/test-ai-estimate.ts 用常數算出並印在輸出），
//   都在 AI_MAX_CANDIDATES（400）之內，所以畫面要能顯示 warn／over 兩種提示；cap 改 800 後 400 張內到不了 warn。
// 對照表與各區起點見 scripts/test-ai-estimate.ts（用常數算，不手抄）。

import {
  AI_BUDGET_FACTOR,
  AI_EST_FIXED_MS,
  AI_EST_LONG_HORIZON_FACTOR,
  AI_EST_PER_CARD_MS,
  AI_EST_WARN_RATIO,
  AI_RUN_BUDGET_MIN_MS,
  AI_RUN_BUDGET_MS,
  type AiHorizon,
} from '@/lib/packaging/ai/types'

/** 預估總耗時（毫秒）：(固定 + 每張 × 張數) × (6 天 ? 1.1 : 1)，四捨五入；負數張數當 0 */
export function estimateRunMs(sentCount: number, horizon: AiHorizon | number): number {
  const n = Number.isFinite(sentCount) ? Math.max(0, sentCount) : 0
  const factor = horizon >= 6 ? AI_EST_LONG_HORIZON_FACTOR : 1
  return Math.round((AI_EST_FIXED_MS + AI_EST_PER_CARD_MS * n) * factor)
}

/** 預算（毫秒）：預估 × AI_BUDGET_FACTOR，clamp 到 [AI_RUN_BUDGET_MIN_MS, capMs]（capMs 預設 AI_RUN_BUDGET_MS；測試可注入） */
export function budgetForEstimate(estimateMs: number, capMs: number = AI_RUN_BUDGET_MS): number {
  const raw = Math.round(Math.max(0, estimateMs) * AI_BUDGET_FACTOR)
  const lo = Math.min(AI_RUN_BUDGET_MIN_MS, capMs)
  return Math.max(lo, Math.min(capMs, raw))
}

export type EstimateZone = 'ok' | 'warn' | 'over'

/**
 * 預估落在哪一區（畫面提示用）：
 *   over：預估本身就超過硬上限（estimateMs > capMs）→ 很可能逾時，建議取消後縮小範圍
 *   warn：預算／預估 < AI_EST_WARN_RATIO（預算被 clamp 到上限、餘裕不足 15%）→ 接近上限
 *   ok：其餘
 */
export function estimateZone(e: { estimateMs: number; budgetMs: number; capMs: number }): EstimateZone {
  if (e.estimateMs > e.capMs) return 'over'
  if (e.estimateMs > 0 && e.budgetMs / e.estimateMs < AI_EST_WARN_RATIO) return 'warn'
  return 'ok'
}
