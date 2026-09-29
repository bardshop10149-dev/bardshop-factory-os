// AI 模擬排程畫面的文字與小計算（純函式；不讀時鐘——需要「現在」的由呼叫端傳入）。
// 集中在這裡：AiRunPanel／AdoptDialog／AdoptionsDialog／SimLayout 用同一套說法，主管看到的名詞才一致（D95：訊息給主管看得懂）。

import type {
  AdoptionCounts,
  AiErrorCode,
  AiHorizon,
  RunPhase,
  RunStatus,
  SimLockReason,
  SimMode,
  SimSource,
  SimUndoKind,
  ValidationIssueCode,
} from '@/lib/packaging/ai/types'

export const MODE_LABEL: Record<SimMode, string> = {
  copy: '複製現有排程',
  clear: '清空全部重排',
}

export const MODE_HINT: Record<SimMode, string> = {
  copy: '把正式排程在這幾天的卡複製過來，可以先鎖定不想動的卡／訂單／線，再讓 AI 排其餘的',
  clear: '範圍內全部清空、所有卡都可以動（D78）；待排區與已完成的卡不受影響',
}

export function horizonLabel(h: AiHorizon | number): string {
  return `${h} 個工作日`
}

export const SIM_SOURCE_LABEL: Record<SimSource, string> = {
  copy: '複製自正式排程',
  ai: 'AI 排入',
  manual: '主管在模擬區調整',
}

export const LOCK_REASON_LABEL: Record<SimLockReason, string> = {
  card: '這張卡已鎖定',
  order: '整張訂單已鎖定',
  line: '整條線已鎖定',
}

export const UNDO_KIND_LABEL: Record<SimUndoKind, string> = {
  ops: '手動調整',
  ai_run: 'AI 排程',
  reset: '建立／重設',
  load_run: '載入歷史結果',
  locks: '鎖定變更',
  capacity: '產線時數',
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  running: '執行中',
  done: '完成',
  failed: '失敗',
}

/** AI 執行的三個階段（規格 §八「準備資料 → AI 思考中 → 程式驗算」） */
export const RUN_STEPS: { phase: Extract<RunPhase, 'preparing' | 'thinking' | 'validating'>; label: string }[] = [
  { phase: 'preparing', label: '準備資料' },
  { phase: 'thinking', label: 'AI 思考中' },
  { phase: 'validating', label: '程式驗算' },
]

/** 預估總時間（規格 §八：60～180 秒）；只用來畫進度，不是承諾 */
export const RUN_EXPECTED_SEC = { min: 60, max: 180 } as const

/**
 * 進度百分比（依階段與經過秒數；AI 思考沒有真正的進度可讀，用「趨近但不到頂」的曲線，免得卡在 99% 很久）：
 *   準備資料 2%→8%、AI 思考中 10%→約 88%（90 秒過一半）、程式驗算 92%、完成／失敗 100%。
 */
export function runProgressPct(phase: RunPhase, elapsedMs: number): number {
  const s = Math.max(0, elapsedMs / 1000)
  switch (phase) {
    case 'done':
    case 'failed':
      return 100
    case 'preparing':
      return Math.min(8, 2 + s * 0.5)
    case 'validating':
      return 92
    case 'thinking':
    default:
      return Math.round(10 + 78 * (1 - Math.exp(-s / 90)))
  }
}

/** 文字進度條：████████░░░░ 42%（Snow 要求長任務要有文字進度條） */
export function textBar(pct: number, width = 20): string {
  const p = Math.max(0, Math.min(100, pct))
  const n = Math.round((p / 100) * width)
  return `${'█'.repeat(n)}${'░'.repeat(width - n)} ${Math.round(p)}%`
}

/** 1 分 05 秒／42 秒 */
export function durationText(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  return `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`
}

/** AI 執行失敗碼的說明（伺服器的 error_message 優先；沒有時用這裡，D95） */
export const RUN_ERROR_LABEL: Record<AiErrorCode, string> = {
  ai_not_configured: '尚未設定 AI 金鑰（ANTHROPIC_API_KEY），請 Snow 設定後再試',
  ai_auth: 'AI 金鑰無效或沒有權限',
  ai_rate_limited: 'AI 用量達上限或太頻繁，請稍後再試（額度由 Snow 在 Anthropic Console 控管）',
  ai_timeout: 'AI 執行逾時（超過約 4.5 分鐘），可縮小範圍或稍後再試',
  ai_network: '連不到 AI 服務（網路問題），請稍後再試',
  ai_api: 'AI 服務回傳錯誤（可能是服務忙碌或額度不足）',
  ai_refused: 'AI 拒絕回答這次的資料',
  ai_truncated: 'AI 的回答太長被截斷，可縮小範圍（例如 2 個工作日）再試',
  ai_bad_output: 'AI 回傳的格式不正確，請再試一次',
  ai_stale: '這次執行超過 6 分鐘沒有結束（伺服器可能已中斷），已視為失敗',
  ai_pii_blocked: '送出前檢查發現資料含疑似個資（電話、email、單號或客戶名稱），已停止、沒有送給 AI；請修正品名／包裝方式或規則文字後再試',
  pool_unavailable: '待排池暫時無法取得，請稍後再試',
  session_gone: '模擬區已不存在',
  internal: '系統在準備資料／驗算／寫回時發生錯誤',
}

/** 驗算時「丟棄／修正」的原因（ValidationReport.adjusted／dropped 的 code） */
export const ISSUE_LABEL: Record<ValidationIssueCode, string> = {
  unknown_card: '不是這次送出的卡',
  day_out_of_window: '日期不在模擬範圍',
  line_invalid: '不是可用的線',
  line_locked: '線已鎖定',
  order_locked: '訂單已鎖定',
  qty_invalid: '數量不正確',
  not_placeable: '這一行目前不能排',
  duplicate: '同一天同一線重複',
  qty_clamped: '數量超過可排量，已減量',
  moved_to_ready_day: '排在可包日之前，已移到可包日',
  before_est_ready: '排在可包日之前，且可包日不在範圍內',
  apply_failed: '系統驗證不通過',
}

/** 採用／退回張數的一句話（0 的項目省略） */
export function countsText(c: AdoptionCounts | null | undefined): string {
  if (!c) return '—'
  const parts: string[] = []
  if (c.added > 0) parts.push(`新增 ${c.added} 張`)
  if (c.moved > 0) parts.push(`移動 ${c.moved} 張`)
  if (c.returned > 0) parts.push(`移回待排池 ${c.returned} 張`)
  if (c.qtyChanged > 0) parts.push(`改數量 ${c.qtyChanged} 張`)
  if (c.reordered > 0) parts.push(`調整順序 ${c.reordered} 張`)
  if (c.minutesChanged > 0) parts.push(`改工時 ${c.minutesChanged} 張`)
  if (c.skipped > 0) parts.push(`略過 ${c.skipped} 張`)
  if (parts.length === 0) return c.unchanged > 0 ? `沒有差異（${c.unchanged} 張相同）` : '沒有差異'
  return parts.join('、') + (c.unchanged > 0 ? `（${c.unchanged} 張不變）` : '')
}

/** 採用／退回實際會寫入的張數（不含 unchanged、skipped） */
export function countsTotal(c: AdoptionCounts | null | undefined): number {
  if (!c) return 0
  return c.added + c.moved + c.returned + c.qtyChanged + c.reordered + c.minutesChanged
}

/**
 * 採用預覽的狀態（AdoptDialog 用；D95 訊息要讓主管看得懂，兩種「不用採用」要分開講）：
 * - identical：範圍內真的一模一樣（沒有變更、也沒有會被略過的）→「不需要採用」
 * - allSkipped：有變更，但全部會被自動略過（卡片已完成／已銷貨／不在待排池）→「這些變更都無法套用，正式排程不會被修改」
 * - conflicts：鎖定線上與正式排程不一致（伺服器會擋 locked_line_diverged）
 * blocked：以上任一成立 → 採用鈕停用（POST 也只會回 nothing_to_adopt／locked_line_diverged）。
 * D101：有產線時數要匯入（capacity.cells／weekendsOpened 非空）也算「有變更」——只改時數也能採用（「只匯入產線時數」）；
 *   產能段驗證不過（capacity.error）→ 擋下。沒有 capacity 的預覽（舊伺服器、模擬區沒調時數）行為與 D101 前完全相同。
 */
export function adoptPreviewFlags(
  p: {
    counts: AdoptionCounts
    skipped: readonly unknown[]
    lockedConflicts?: readonly unknown[]
    capacity?: { cells: readonly unknown[]; weekendsOpened: readonly unknown[]; error?: string | null } | null
  } | null | undefined,
  conflictsOverride?: readonly unknown[] | null,
): { identical: boolean; allSkipped: boolean; conflicts: number; blocked: boolean } {
  if (!p) return { identical: false, allSkipped: false, conflicts: 0, blocked: true }
  const capChanges = (p.capacity?.cells.length ?? 0) + (p.capacity?.weekendsOpened.length ?? 0)
  const noScheduleChanges = countsTotal(p.counts) === 0
  const noChanges = noScheduleChanges && capChanges === 0
  const identical = noChanges && p.skipped.length === 0
  const allSkipped = noChanges && p.skipped.length > 0
  const conflicts = (conflictsOverride ?? p.lockedConflicts ?? []).length
  return { identical, allSkipped, conflicts, blocked: noChanges || conflicts > 0 || !!p.capacity?.error }
}

// ── D101 產線時數的說法（採用預覽、退回預覽、模擬區橫幅共用） ──

/** 小時：最多 2 位小數、去掉多餘的 0 */
export function hoursNum(h: number): string {
  return String(Math.round(h * 100) / 100)
}

/**
 * 一格產線時數的一句話：平日「8h＋加班 2h」／「8h」／「未設定」；週末「加班 4h」／「沒開加班」。
 * regularHours null＝平日從沒設定過。
 */
export function capHoursText(h: { regularHours: number | null; overtimeHoursMax: number } | null, weekend: boolean): string {
  if (!h) return weekend ? '沒開加班' : '沒有設定（沿用前一個平日）'
  if (weekend) return h.overtimeHoursMax > 0 ? `加班 ${hoursNum(h.overtimeHoursMax)}h` : '加班 0h'
  if (h.regularHours == null) return '未設定'
  return `${hoursNum(h.regularHours)}h${h.overtimeHoursMax > 0 ? `＋加班 ${hoursNum(h.overtimeHoursMax)}h` : ''}`
}

/** 分鐘版（SimView.capacity.diffs 用） */
export function capMinutesText(m: { regularMinutes: number | null; overtimeMinutes: number }, weekend: boolean): string {
  return capHoursText({
    regularHours: m.regularMinutes == null ? null : m.regularMinutes / 60,
    overtimeHoursMax: m.overtimeMinutes / 60,
  }, weekend)
}

/** 退回時「週末保持開著」的原因 */
export const WEEKEND_KEPT_LABEL: Record<'has_cards' | 'changed_after' | 'already_closed' | 'past' | 'invalid', string> = {
  has_cards: '那天退回後還有卡，保持開著',
  changed_after: '組長在採用後改過那天的時數，保持開著',
  already_closed: '已經關閉了',
  past: '日期已過，不變動',
  invalid: '還原後那天會通不過產能表規則，整天保持不變',
}

/** 小時（1 位小數） */
export function hoursOf(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return '—'
  return (Math.round((min / 60) * 10) / 10).toFixed(1)
}
