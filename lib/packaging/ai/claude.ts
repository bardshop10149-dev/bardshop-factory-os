// 包裝專區 P3 AI 模擬排程 — 呼叫 Claude（伺服器端專用，規格 §4.2；D85 模型與金鑰、D95 失敗處理）
//
// ⚠ 全專案「唯一」讀 ANTHROPIC_API_KEY 的地方（isAiConfigured；SDK 建構時也由它自環境變數讀）。絕不使用 NEXT_PUBLIC_ 前綴。
// ⚠ 伺服器端專用：專案沒有安裝 server-only 套件（見 types.ts「SDK 能力確認」第 5 點），依任務指示不另外安裝，
//   改用下方「typeof window !== 'undefined' 就丟錯」的執行期檢查——若有人不小心從 'use client' 元件 import 本檔，
//   瀏覽器一載入就會丟錯（而不是默默把 SDK 打包進前端）。之後若安裝 server-only，改成檔首 import 'server-only' 即可。
// ⚠ 不得 console.log payload、AI 輸出、rawText（Vercel log 會留存）；錯誤 log 只記錯誤類別（AiError.code）與 status。
//
// SDK 用法一律以 node_modules/@anthropic-ai/sdk（0.128.0）的型別為準（已確認的能力見 types.ts 檔頭「SDK 能力確認」）。
// 測試（scratchpad/ai-impl/tests/claude.test.mjs，node:test）：傳入 mock 的 ClaudeClientLike，不連網路、不需要金鑰。
//
// 為什麼用串流（.stream + finalMessage）而不是 .create：AI 要思考 1～3 分鐘，非串流請求在這段時間連線上完全沒有資料，
//   容易被中間的網路設備當成閒置連線切掉；串流一直有事件在流動比較穩（SDK 在沒設 timeout 時也會直接拒絕 max_tokens 這麼大的
//   非串流請求，見 node_modules/@anthropic-ai/sdk/src/client.ts calculateNonstreamingTimeout）。
//   串流只是傳輸方式，finalMessage() 拿到的仍是跟 create 一樣的完整 BetaMessage。
// 為什麼走 client.beta：拒答備援（fallbacks: 'default'＋betas）只在 beta 端點的型別裡（types.ts「SDK 能力確認」第 2 點）。

import Anthropic from '@anthropic-ai/sdk'
import type { BetaMessage, BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages'
import { AI_OUTPUT_SCHEMA, parseAiOutput } from './schema'
import { SYSTEM_PROMPT, buildUserMessage } from './prompt'
import type { AiErrorCode, AiPayload, AiUsage, ClaudeCallResult } from './types'

if (typeof window !== 'undefined') {
  throw new Error('lib/packaging/ai/claude.ts 只能在伺服器端使用（AI 金鑰不得進入瀏覽器，D85）')
}

/** D85：Claude Opus 5 */
export const AI_MODEL = 'claude-opus-5'
/**
 * output_config.effort。正式站函式上限 300 秒（route maxDuration），runner 內部預算 270 秒。
 * 2026-09-28 以正式資料實測（208 張候選、4 天、copy 模式，同一份 payload）：
 *   high   → 256 秒、輸出 23.3K token（約 17K 是思考）、約 NT$24；離 270 秒預算只剩 14 秒，太險
 *   medium → 189 秒、輸出 16.4K token、約 NT$19；排程品質相當（全部通過驗算、風險提醒更具體）
 * 所以用 medium。候選變多或改 6 天若又逼近預算，再評估 'low' 或提高 maxDuration（需 Vercel 方案支援）。
 */
export const AI_EFFORT: 'low' | 'medium' | 'high' = 'medium'
/** max_tokens（思考 token 也算在內） */
export const AI_MAX_TOKENS = 48_000
/** SDK timeout（毫秒；TypeScript SDK 單位是毫秒） */
export const AI_TIMEOUT_MS = 280_000
/** SDK 自動重試次數（重試也吃時間預算，1 次就好） */
export const AI_MAX_RETRIES = 1
/** 拒答備援（server-side fallback）beta 旗標；搭配 fallbacks: 'default'（SDK 0.128.0 型別兩者皆接受） */
export const AI_FALLBACK_BETA = 'server-side-fallback-2026-07-01' as const

/** callClaude 的失敗：code 給 run.error_code、message 為給主管看的繁中（D95）；status＝HTTP 狀態（有的話） */
export class AiError extends Error {
  readonly code: AiErrorCode
  readonly status: number | null
  constructor(code: AiErrorCode, message: string, status: number | null = null) {
    super(message)
    this.name = 'AiError'
    this.code = code
    this.status = status
  }
}

/** 是否已設定金鑰（未設定 → POST session/run 回 400 ai_not_configured「尚未設定 AI 金鑰」，不建 run） */
export function isAiConfigured(): boolean {
  const k = process.env.ANTHROPIC_API_KEY
  return typeof k === 'string' && k.trim() !== ''
}

/**
 * callClaude 需要的最小 client 介面（測試用 mock 實作它即可；真的 Anthropic 實例一定符合，見下方編譯期檢查）。
 * 只用 beta.messages.stream（拒答備援 fallbacks／betas 只在 beta 端點）。
 */
export interface ClaudeClientLike {
  beta: {
    messages: {
      stream(body: BetaMessageStreamParams, options?: { signal?: AbortSignal; timeout?: number }): { finalMessage(): Promise<BetaMessage> }
    }
  }
}

// 編譯期檢查：SDK 升級後若 Anthropic 不再符合 ClaudeClientLike，tsc 會在這裡報錯（不產生任何執行期程式碼）
type AssertAnthropicFits = Anthropic extends ClaudeClientLike ? true : never
const anthropicFits: AssertAnthropicFits = true
void anthropicFits

/** 正式 client：new Anthropic({ timeout: AI_TIMEOUT_MS, maxRetries: AI_MAX_RETRIES })（金鑰由 SDK 自 ANTHROPIC_API_KEY 讀） */
export function createClaudeClient(): ClaudeClientLike {
  return new Anthropic({ timeout: AI_TIMEOUT_MS, maxRetries: AI_MAX_RETRIES })
}

/**
 * 組請求本體（規格 §4.2）。獨立成函式：測試可直接斷言送出的參數，callClaude 只負責送與收。
 * system 放固定的 SYSTEM_PROMPT 並標 cache_control（穩定前綴 → 同一個 5 分鐘內重跑可讀快取，省輸入費用與延遲）；
 * 會變的 payload 一律放 user message，不得混進 system（否則每次都打破快取）。
 */
export function buildClaudeRequest(payload: AiPayload): BetaMessageStreamParams {
  return {
    model: AI_MODEL,
    max_tokens: AI_MAX_TOKENS,
    // Opus 5 不寫 thinking 也是 adaptive；明寫出來，日後換模型時一眼看得出有開思考
    thinking: { type: 'adaptive' },
    output_config: { effort: AI_EFFORT, format: { type: 'json_schema', schema: AI_OUTPUT_SCHEMA } },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserMessage(payload) }],
    // 拒答備援：分類器誤判拒答時，伺服器端改用 Anthropic 建議的備援模型重跑（同一個請求內完成）。
    // 'default' 純量寫法配 -2026-07-01 旗標（陣列寫法才配 -2026-06-01，兩者混用會 400）。
    betas: [AI_FALLBACK_BETA],
    fallbacks: 'default',
  }
}

/** usage 裡可能是 null 的欄位一律補 0（存 packaging_ai_runs.usage） */
function usageOf(u: BetaMessage['usage'] | null | undefined): AiUsage {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    inputTokens: n(u?.input_tokens),
    outputTokens: n(u?.output_tokens),
    cacheReadInputTokens: n(u?.cache_read_input_tokens),
    cacheCreationInputTokens: n(u?.cache_creation_input_tokens),
  }
}

/**
 * 從回應的 content 取出結構化輸出的 JSON 文字候選（依序嘗試，第一個 JSON.parse 成功的就用）：
 *   1. 全部 text block 依序接起來——串流中途拒答、伺服器改用備援模型時，備援模型是「接著前一段文字繼續寫」，
 *      完整 JSON 會被 fallback block 切成前後兩段 text（SDK 文件：mid-stream fallback keeps the partial … and continues）；
 *   2. 最後一個 fallback block 之後的 text 接起來（萬一備援是從頭重寫）；
 *   3. 最後一個 text block。
 * thinking／redacted_thinking／fallback 等其他 block 一律略過。
 */
function textCandidates(content: readonly BetaMessage['content'][number][]): string[] {
  const texts: string[] = []
  const afterFallback: string[] = []
  for (const b of content) {
    if (b.type === 'fallback') afterFallback.length = 0
    else if (b.type === 'text') {
      texts.push(b.text)
      afterFallback.push(b.text)
    }
  }
  if (texts.length === 0) return []
  const out = [texts.join(''), afterFallback.join(''), texts[texts.length - 1]]
  return out.filter((s, i) => s.trim() !== '' && out.indexOf(s) === i)
}

/**
 * 解讀回應（規格 §4.2「回應檢查順序」）。獨立 export 給測試用（不需要 mock 串流）。
 * 拒答要最先判斷：拒答時 content 可能是空的或只有半截，不能先去讀 content。
 * ⚠ 錯誤訊息只用固定文字，不帶回應內容（parse 錯誤的 message 會夾帶一段原文，不能外露也不能 log）。
 */
export function readClaudeMessage(msg: Pick<BetaMessage, 'stop_reason' | 'content' | 'usage' | 'model'>): ClaudeCallResult {
  if (msg.stop_reason === 'refusal') {
    throw new AiError('ai_refused', 'AI 拒絕處理這次的排程資料（安全機制判定，備援模型也未接手），請稍後再試；若一再發生請通知管理員')
  }
  if (msg.stop_reason === 'max_tokens' || msg.stop_reason === 'model_context_window_exceeded') {
    throw new AiError('ai_truncated', 'AI 的回覆太長被截斷（這次要排的卡片或天數太多），請把模擬範圍改小（例如 2 天）或先鎖定部分卡片後再試')
  }
  const candidates = textCandidates(msg.content ?? [])
  if (candidates.length === 0) {
    throw new AiError('ai_bad_output', 'AI 沒有回傳排程結果（回應中沒有文字內容），請再試一次')
  }
  let raw: unknown = undefined
  let rawText: string | null = null
  for (const text of candidates) {
    try {
      raw = JSON.parse(text)
      rawText = text
      break
    } catch {
      // 換下一個候選；錯誤本身可能夾帶原文，不保留
    }
  }
  if (rawText == null) throw new AiError('ai_bad_output', 'AI 回傳的排程結果不是有效的 JSON，請再試一次')
  const parsed = parseAiOutput(raw)
  if (!parsed.ok) throw new AiError('ai_bad_output', `AI 回傳的排程結果格式不符（${parsed.message.slice(0, 120)}），請再試一次`)
  return {
    output: parsed.output,
    usage: usageOf(msg.usage),
    // 備援模型接手時，回應的 model 就是備援模型（D91 LOG 要記實際是誰排的）
    model: typeof msg.model === 'string' && msg.model ? msg.model : AI_MODEL,
    rawText,
  }
}

/**
 * 呼叫 Claude 排程（規格 §4.2）。opts.client 省略＝createClaudeClient()；opts.signal 給 runner 的總預算 AbortController。
 * 請求（client.beta.messages.stream(...) → await stream.finalMessage()）：
 *   model: AI_MODEL、max_tokens: AI_MAX_TOKENS、thinking: { type: 'adaptive' }、
 *   output_config: { effort: AI_EFFORT, format: { type: 'json_schema', schema: AI_OUTPUT_SCHEMA } }（schema.ts）、
 *   system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }]（prompt.ts；穩定前綴可快取）、
 *   messages: [{ role: 'user', content: buildUserMessage(payload) }]、
 *   betas: [AI_FALLBACK_BETA]、fallbacks: 'default'（拒答備援）。
 * 回應檢查順序：stop_reason === 'refusal' → AiError('ai_refused')；'max_tokens' → AiError('ai_truncated')；
 *   取 content 中的 text block（沒有 → ai_bad_output）→ JSON.parse（失敗 → ai_bad_output）→ parseAiOutput（失敗 → ai_bad_output）。
 * usage：input_tokens／output_tokens／cache_read_input_tokens／cache_creation_input_tokens（null → 0）；model＝回應的 message.model。
 * 任何 SDK 例外 → throw classifyAiError(e)。
 */
export async function callClaude(
  payload: AiPayload,
  opts: { client?: ClaudeClientLike; signal?: AbortSignal } = {},
): Promise<ClaudeCallResult> {
  // 沒金鑰時 new Anthropic() 會直接丟英文錯誤；先擋下來給主管看得懂的訊息（D95）。測試注入 mock client 時不看金鑰。
  if (!opts.client && !isAiConfigured()) {
    throw new AiError('ai_not_configured', '尚未設定 AI 金鑰（ANTHROPIC_API_KEY），請通知管理員設定後再試')
  }
  // 組請求放在 try 外：這裡出錯是程式問題（不是 SDK 錯誤），讓呼叫端歸類成 internal
  const body = buildClaudeRequest(payload)
  let msg: BetaMessage
  try {
    const client = opts.client ?? createClaudeClient()
    const stream = client.beta.messages.stream(body, opts.signal ? { signal: opts.signal } : undefined)
    msg = await stream.finalMessage()
  } catch (e) {
    throw classifyAiError(e)
  }
  return readClaudeMessage(msg)
}

/**
 * SDK 例外 → AiError（由具體到一般；訊息一律繁中、給主管看得懂，D95）：
 *   已是 AiError → 原樣；
 *   Anthropic.AuthenticationError（401）／PermissionDeniedError（403）→ 'ai_auth'「AI 金鑰無效或沒有權限，請通知管理員檢查金鑰」；
 *   Anthropic.RateLimitError（429）→ 'ai_rate_limited'「AI 用量達上限或太頻繁，請稍後再試（額度由管理員在 Console 控管）」；
 *   Anthropic.APIConnectionTimeoutError（必須先於 APIConnectionError 判斷）或 signal abort／APIUserAbortError（總預算用完）→ 'ai_timeout'「AI 回應逾時…」；
 *   Anthropic.APIConnectionError → 'ai_network'「連不上 AI 服務…」；
 *   Anthropic.APIError 其他（含 529 overloaded、402 額度）→ 'ai_api'「AI 服務錯誤（HTTP {status}）…」，status 帶上；
 *   其他未知例外 → 'internal'「AI 執行時發生未預期的錯誤」。
 * 不得把 e.message 原文放進回傳訊息（可能含請求內容）；只用固定文字＋status。
 */
export function classifyAiError(e: unknown): AiError {
  if (e instanceof AiError) return e
  // 繼承關係（node_modules/@anthropic-ai/sdk/core/error.d.ts）：AuthenticationError 等 4xx／5xx 類別、APIConnectionError、
  // APIUserAbortError 全都 extends APIError；APIConnectionTimeoutError extends APIConnectionError。
  // → 一律「子類別先判」，APIError 放最後當兜底，否則逾時會被誤判成網路錯誤、429 會被誤判成一般 API 錯誤。
  if (e instanceof Anthropic.AuthenticationError) {
    return new AiError('ai_auth', 'AI 金鑰無效或已停用（HTTP 401），請通知管理員檢查金鑰', 401)
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return new AiError('ai_auth', 'AI 金鑰沒有使用這個模型的權限（HTTP 403），請通知管理員檢查帳號設定', 403)
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new AiError('ai_rate_limited', 'AI 用量達上限或呼叫太頻繁（HTTP 429），請過幾分鐘再試；額度由管理員在 Anthropic Console 控管', 429)
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError || e instanceof Anthropic.APIUserAbortError || isAbortLike(e)) {
    // SDK 單次請求逾時（AI_TIMEOUT_MS），或 runner 的總預算（AI_RUN_BUDGET_MS）用完而中止
    return new AiError('ai_timeout', 'AI 思考太久、超過時間上限，這次沒有結果；請再試一次，或把模擬範圍改小（例如 2 天）')
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new AiError('ai_network', '連不上 AI 服務（網路問題），請稍後再試')
  }
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === 'number' ? e.status : null
    return new AiError('ai_api', apiErrorMessage(status, e.type ?? null), status)
  }
  // 2026-09-30 正式站兩次 AI 執行都只留下「未預期的錯誤」（D112）：instanceof 在打包後可能因 SDK 模組被載入兩份而失敗，
  // 導致 401／429／529 全部掉進這裡、連原因都不留。→ instanceof 都不中時，改「看物件內容」再分類一次（duck typing），
  // 最後才歸 internal，而且附上安全的技術資訊（只有錯誤類別／狀態碼／Node 錯誤代號，不含任何訊息原文）。
  const shape = errorShape(e)
  if (shape.status === 401 || shape.status === 403) {
    return new AiError('ai_auth', `AI 金鑰無效或沒有權限（HTTP ${shape.status}），請通知管理員檢查金鑰`, shape.status)
  }
  if (shape.status === 429) {
    return new AiError('ai_rate_limited', 'AI 用量達上限或呼叫太頻繁（HTTP 429），請過幾分鐘再試；額度由管理員在 Anthropic Console 控管', 429)
  }
  if (/Timeout|Abort/i.test(shape.name) || shape.code === 'ETIMEDOUT' || shape.code === 'UND_ERR_HEADERS_TIMEOUT') {
    return new AiError('ai_timeout', 'AI 思考太久、超過時間上限，這次沒有結果；請再試一次，或把模擬範圍改小（例如 2 天）')
  }
  if (/ConnectionError|FetchError/i.test(shape.name) || /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR)/.test(shape.code)) {
    return new AiError('ai_network', `連不上 AI 服務（網路問題，${shape.tag}），請稍後再試`)
  }
  if (shape.status != null) {
    return new AiError('ai_api', apiErrorMessage(shape.status, shape.type), shape.status)
  }
  return new AiError('internal', `AI 執行時發生未預期的錯誤，請通知管理員（技術資訊：${shape.tag}）`)
}

/**
 * 從未知例外取出「可安全外露」的形狀：類別名稱、HTTP 狀態碼、API 錯誤類型、Node 錯誤代號。
 * 刻意不取 e.message（可能含請求內容）。tag 例：`APIError／529`、`TypeError／ECONNRESET`。
 */
export function errorShape(e: unknown): { name: string; status: number | null; type: string | null; code: string; tag: string } {
  const o = (e && typeof e === 'object') ? (e as Record<string, unknown>) : {}
  const ctor = (o as { constructor?: { name?: unknown } }).constructor?.name
  const name = typeof o.name === 'string' && o.name ? o.name : (typeof ctor === 'string' && ctor ? ctor : typeof e)
  const status = typeof o.status === 'number' ? o.status : null
  const err = (o.error && typeof o.error === 'object') ? (o.error as Record<string, unknown>) : null
  const inner = (err?.error && typeof err.error === 'object') ? (err.error as Record<string, unknown>) : null
  const type = typeof o.type === 'string' ? o.type : (typeof inner?.type === 'string' ? (inner.type as string) : null)
  const cause = (o.cause && typeof o.cause === 'object') ? (o.cause as Record<string, unknown>) : null
  const code = typeof o.code === 'string' ? o.code : (typeof cause?.code === 'string' ? (cause.code as string) : '')
  const tag = [name, status != null ? String(status) : null, type, code].filter(Boolean).join('／')
  return { name, status, type, code, tag }
}

/** 非 SDK 包裝的中止（例：fetch 直接丟 DOMException AbortError） */
function isAbortLike(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'AbortError'
}

/** 其他 HTTP 錯誤（shared/error-codes.md 對照表）→ 給主管看得懂的一句話；只用狀態碼與錯誤類型，不帶 API 回的原文 */
function apiErrorMessage(status: number | null, type: string | null): string {
  const tag = `HTTP ${status ?? '未知'}`
  if (status === 529 || type === 'overloaded_error') return `AI 服務目前太忙（${tag}），請過幾分鐘再試`
  if (status === 402 || type === 'billing_error') return `AI 帳號額度不足或付款有問題（${tag}），請通知管理員到 Anthropic Console 確認`
  if (status === 413) return `送出的排程資料太大（${tag}），請把模擬範圍改小後再試`
  if (status === 404) return `找不到指定的 AI 模型或帳號沒有使用權（${tag}），請通知管理員`
  if (status === 400) return `AI 服務不接受這次的請求格式（${tag}），請通知管理員檢查設定`
  if (status != null && status >= 500) return `AI 服務暫時發生錯誤（${tag}），請稍後再試`
  return `AI 服務錯誤（${tag}），請稍後再試或通知管理員`
}
