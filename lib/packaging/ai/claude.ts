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
import type { BetaMessageStream } from '@anthropic-ai/sdk/lib/BetaMessageStream'
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

/**
 * 診斷用環境變數開關（2026-09-30 正式站 AI 排程連續失敗、只留下「a／cause:TypeError」的 RCA，D112）。
 * 全部「未設＝關＝現狀」；只在正式站／Preview 明確設成 '1' 才生效，每個開關對應一個假設，用來 A/B 切分原因：
 *   PACKAGING_AI_NO_FALLBACK   H1：省略 betas／fallbacks（拒答備援），看是不是 fallback 事件形狀讓 SDK 串流累積器炸掉
 *   PACKAGING_AI_NATIVE_FETCH  H3／H4：SDK 改用 Next 包裝前的原生 fetch（patch-fetch.js 掛在 fetch._nextOriginalFetch）
 *   PACKAGING_AI_SYNC_RUN      H4：POST session/run 改成「同步等 executeRun 跑完才回應」，不走 after()（只做實驗，UI 會等 1～3 分鐘）
 *   PACKAGING_AI_SDK_EXTERNAL  H6：next.config.ts 把 SDK 列進 serverExternalPackages（build 時決定；見 next.config.ts）
 * 這裡只回布林，永遠不回變數的值。
 */
export function aiDiagFlags(): { noFallback: boolean; nativeFetch: boolean; syncRun: boolean; sdkExternal: boolean } {
  const on = (k: string) => process.env[k] === '1'
  return {
    noFallback: on('PACKAGING_AI_NO_FALLBACK'),
    nativeFetch: on('PACKAGING_AI_NATIVE_FETCH'),
    syncRun: on('PACKAGING_AI_SYNC_RUN'),
    sdkExternal: on('PACKAGING_AI_SDK_EXTERNAL'),
  }
}

/**
 * 金鑰狀態：'missing'＝沒設或空白；'bad_chars'＝含不可見／非 ASCII 字元（貼上時混入換行、全形字、零寬字元）；'ok'。
 * 為什麼要檢查字元：Anthropic 金鑰只會是可見 ASCII（0x21～0x7e）。含內部換行或非 Latin-1 的值，SDK 組 header 時
 *   `Headers.append` 會直接丟「無 code 的 TypeError」（'… is an invalid header value.'／'Cannot convert argument to a ByteString …'），
 *   不經 fetch、不重試，外觀與 2026-09-30 正式站的失敗一模一樣（H2）；與其事後猜，不如送出前就擋、訊息直接指出問題。
 * 首尾空白不算壞（SDK readEnv 會 trim）。
 */
export function aiKeyState(): 'ok' | 'missing' | 'bad_chars' {
  const k = process.env.ANTHROPIC_API_KEY
  if (typeof k !== 'string' || k.trim() === '') return 'missing'
  return /^[\x21-\x7e]+$/.test(k.trim()) ? 'ok' : 'bad_chars'
}

/** 是否已設定「可用的」金鑰（未設定或含壞字元 → POST session/run 回 400 ai_not_configured，不建 run） */
export function isAiConfigured(): boolean {
  return aiKeyState() === 'ok'
}

/** ai_not_configured 給主管看的繁中訊息（依 aiKeyState 分兩種；不含金鑰任何內容） */
export function aiNotConfiguredMessage(): string {
  return aiKeyState() === 'bad_chars'
    ? 'AI 金鑰（ANTHROPIC_API_KEY）含不可見或非 ASCII 字元（可能是貼上時混入換行／全形字），請管理員到 Vercel 重新貼一次'
    : '尚未設定 AI 金鑰（ANTHROPIC_API_KEY），請通知管理員設定後再試'
}

/**
 * callClaude 拿到的串流物件的最小介面：finalMessage 必要；on 選填（真的 BetaMessageStream 有，測試 mock 可以不給）。
 * on 只拿來訂閱 'connect'／'streamEvent' 做階段追蹤（見 callClaude），不影響 finalMessage 的結果。
 */
export type ClaudeStreamLike = Pick<BetaMessageStream, 'finalMessage'> & Partial<Pick<BetaMessageStream, 'on'>>

/**
 * callClaude 需要的最小 client 介面（測試用 mock 實作它即可；真的 Anthropic 實例一定符合，見下方編譯期檢查）。
 * 只用 beta.messages.stream（拒答備援 fallbacks／betas 只在 beta 端點）。
 */
export interface ClaudeClientLike {
  beta: {
    messages: {
      stream(body: BetaMessageStreamParams, options?: { signal?: AbortSignal; timeout?: number }): ClaudeStreamLike
    }
  }
}

// 編譯期檢查：SDK 升級後若 Anthropic 不再符合 ClaudeClientLike，tsc 會在這裡報錯（不產生任何執行期程式碼）
type AssertAnthropicFits = Anthropic extends ClaudeClientLike ? true : never
const anthropicFits: AssertAnthropicFits = true
void anthropicFits

/**
 * 正式 client：new Anthropic({ timeout: AI_TIMEOUT_MS, maxRetries: AI_MAX_RETRIES })（金鑰由 SDK 自 ANTHROPIC_API_KEY 讀）。
 * PACKAGING_AI_NATIVE_FETCH=1 時改傳 Next 包裝前的原生 fetch（patch-fetch.js 把它掛在 globalThis.fetch._nextOriginalFetch）。
 * ⚠ fetch 一定要在這裡（請求時）才抓：Next 的 patchFetch 是每次請求進來才套用，模組頂層抓到的可能還是原生的。
 */
export function createClaudeClient(opts: { maxRetries?: number } = {}): ClaudeClientLike {
  const fetch = aiDiagFlags().nativeFetch ? nativeFetchOf(globalThis.fetch) : undefined
  // opts.maxRetries：健康檢查探針用 0（SDK timeout × 重試次數不能超過 route 的 maxDuration）；正式排程沿用 AI_MAX_RETRIES
  return new Anthropic({ timeout: AI_TIMEOUT_MS, maxRetries: opts.maxRetries ?? AI_MAX_RETRIES, ...(fetch ? { fetch } : {}) })
}

/** Next patch-fetch 掛的原生 fetch（沒被 patch 就回傳原本的 fetch） */
export function nativeFetchOf(f: typeof globalThis.fetch): typeof globalThis.fetch {
  const orig = (f as unknown as { _nextOriginalFetch?: unknown })._nextOriginalFetch
  return typeof orig === 'function' ? (orig as typeof globalThis.fetch) : f
}

/** 執行環境資訊（健康檢查回傳用；只有版本字串／布林，不含任何變數值） */
export function aiRuntimeInfo(): { node: string; fetchPatched: boolean; hasNativeFetch: boolean; vercelRequestContext: boolean; region: string | null; flags: ReturnType<typeof aiDiagFlags> } {
  const f = globalThis.fetch as unknown as { __nextPatched?: unknown; _nextOriginalFetch?: unknown }
  return {
    node: process.version,
    fetchPatched: f.__nextPatched === true,
    hasNativeFetch: typeof f._nextOriginalFetch === 'function',
    vercelRequestContext: typeof (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('@next/request-context')] !== 'undefined',
    region: typeof process.env.VERCEL_REGION === 'string' ? process.env.VERCEL_REGION : null,
    flags: aiDiagFlags(),
  }
}

/**
 * 組請求本體（規格 §4.2）。獨立成函式：測試可直接斷言送出的參數，callClaude 只負責送與收。
 * system 放固定的 SYSTEM_PROMPT 並標 cache_control（穩定前綴 → 同一個 5 分鐘內重跑可讀快取，省輸入費用與延遲）；
 * 會變的 payload 一律放 user message，不得混進 system（否則每次都打破快取）。
 */
export function buildClaudeRequest(payload: AiPayload, opts: { noFallback?: boolean } = {}): BetaMessageStreamParams {
  const noFallback = opts.noFallback ?? aiDiagFlags().noFallback
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
    // PACKAGING_AI_NO_FALLBACK=1（H1 實驗／緊急繞道）時兩個都不送：拒答改走既有 stop_reason==='refusal' → ai_refused 提示。
    ...(noFallback ? {} : { betas: [AI_FALLBACK_BETA], fallbacks: 'default' as const }),
  }
}

/**
 * callClaude 的階段追蹤（診斷用，D112）：只記「型別」不記內容。
 *   stage：'created'＝串流物件建好、還沒連上（送出前就炸＝金鑰／header／請求組裝問題）；
 *          'connected'＝HTTP 回應已到（SDK 'connect' 事件）但還沒有任何事件；
 *          'streaming'＝已收到事件，events 是前幾個事件型別（content_block_start 另附區塊型別，例 content_block_start:thinking）。
 *   aiMs：從建立串流到失敗／完成的毫秒數。
 * 一行就能切開「送出前／連上沒事件／事件到了才炸」——分別對應金鑰、平台／after()、SDK 累積器三類假設。
 */
export type AiCallTrace = {
  stage: 'created' | 'connected' | 'streaming'
  events: string[]
  /** 建立串流 → 結束（失敗或完成）的毫秒數；由呼叫端結束時填 */
  aiMs: number
  /** 建立串流 → 'connect' 事件（HTTP 回應到達）的毫秒數；null＝沒連上 */
  connectMs: number | null
  /** 建立串流 → 第一個串流事件的毫秒數；null＝沒收到任何事件 */
  firstEventMs: number | null
}
/** events 最多記幾個型別（夠看出「卡在哪一個事件」，又不會把幾千個 delta 全記下來） */
export const AI_TRACE_MAX_EVENTS = 8

/** 追蹤資訊 → 可外露的短字串（只有固定枚舉字串與數字） */
export function traceTag(t: AiCallTrace | undefined): string {
  if (!t) return ''
  const ms = (v: number | null) => (v == null ? '-' : String(Math.max(0, Math.round(v))))
  return `stage=${t.stage}／events=${t.events.length ? t.events.join(',') : '-'}／aiMs=${ms(t.aiMs)}／connectMs=${ms(t.connectMs)}／firstEventMs=${ms(t.firstEventMs)}`
}

/**
 * 在串流上掛 'connect'／'streamEvent' 監聽（duck typing：mock 沒有 on 就不掛），回傳會隨事件更新的 trace。
 * t0＝建立串流的時間（呼叫端傳入，同一個基準算 connectMs／firstEventMs）；aiMs 由呼叫端在結束時填。
 * on() 只是訂閱，不改變 finalMessage() 的行為。
 */
export function attachTrace(stream: ClaudeStreamLike, t0: number = Date.now(), nowMs: () => number = Date.now): AiCallTrace {
  const trace: AiCallTrace = { stage: 'created', events: [], aiMs: 0, connectMs: null, firstEventMs: null }
  if (typeof stream.on === 'function') {
    stream.on('connect', () => {
      if (trace.stage === 'created') trace.stage = 'connected'
      if (trace.connectMs == null) trace.connectMs = nowMs() - t0
    })
    stream.on('streamEvent', (ev) => {
      trace.stage = 'streaming'
      if (trace.firstEventMs == null) trace.firstEventMs = nowMs() - t0
      if (trace.events.length < AI_TRACE_MAX_EVENTS) {
        const type = typeof ev?.type === 'string' ? ev.type : '?'
        const block = ev?.type === 'content_block_start' ? (ev.content_block as { type?: unknown } | undefined)?.type : undefined
        trace.events.push(typeof block === 'string' ? `${type}:${block}` : type)
      }
    })
  }
  return trace
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
    throw new AiError('ai_not_configured', aiNotConfiguredMessage())
  }
  // 組請求放在 try 外：這裡出錯是程式問題（不是 SDK 錯誤），讓呼叫端歸類成 internal
  const body = buildClaudeRequest(payload)
  let msg: BetaMessage
  const t0 = Date.now()
  let trace: AiCallTrace | undefined
  try {
    const client = opts.client ?? createClaudeClient()
    const stream = client.beta.messages.stream(body, opts.signal ? { signal: opts.signal } : undefined)
    trace = attachTrace(stream, t0)
    msg = await stream.finalMessage()
  } catch (e) {
    if (trace) trace.aiMs = Date.now() - t0
    const ai = classifyAiError(e, trace)
    // 只有分類代號、階段、事件型別、脫敏後的技術標籤——沒有請求內容（D95）
    console.error(`[packaging/ai/claude] ${ai.code} ${traceTag(trace) || 'stage=created'} tag=${errorShape(e).tag}`)
    throw ai
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
 * 不得把 e.message 原文放進回傳訊息（可能含請求內容）；只用固定文字＋status＋errorShape 的脫敏標籤（sanitizeMsg）。
 * trace（callClaude 的階段追蹤）有給時，internal／ai_network 的技術資訊會附 stage／events／aiMs。
 */
export function classifyAiError(e: unknown, trace?: AiCallTrace): AiError {
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
  // 最後才歸 internal，而且附上安全的技術資訊（類別／狀態碼／代號／脫敏後的訊息／cause 鏈，不含請求內容）。
  const shape = errorShape(e)
  if (shape.status === 401 || shape.status === 403) {
    return new AiError('ai_auth', `AI 金鑰無效或沒有權限（HTTP ${shape.status}），請通知管理員檢查金鑰`, shape.status)
  }
  if (shape.status === 429) {
    return new AiError('ai_rate_limited', 'AI 用量達上限或呼叫太頻繁（HTTP 429），請過幾分鐘再試；額度由管理員在 Anthropic Console 控管', 429)
  }
  if (shape.kind === 'bad-header' || shape.kind === 'non-ascii-header') {
    // 送出前組 header 就炸：唯一會這樣的是環境變數的值含換行／非 ASCII（H2）。
    // 必須排在 ai_network 之前：SDK makeRequest 會把 fetch 內丟的 Headers 錯誤包成 APIConnectionError('Connection error.')，
    // 白名單句子會先命中網路規則；kind 是掃整條 cause 鏈算的，不受包裝影響。
    return new AiError('ai_not_configured', `AI 金鑰或 ANTHROPIC_ 環境變數含不可見／非 ASCII 字元，請管理員到 Vercel 重新貼一次（技術資訊：${shape.tag}）`)
  }
  if (/Timeout|Abort/i.test(shape.name) || shape.code === 'ETIMEDOUT' || shape.code === 'UND_ERR_HEADERS_TIMEOUT' || /timed out|aborted/i.test(shape.tag)) {
    return new AiError('ai_timeout', 'AI 思考太久、超過時間上限，這次沒有結果；請再試一次，或把模擬範圍改小（例如 2 天）')
  }
  if (/ConnectionError|FetchError/i.test(shape.name) || /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR)/.test(shape.code) || /Connection error|fetch failed|terminated|Could not resolve a `Response`/i.test(shape.tag)) {
    return new AiError('ai_network', `連不上 AI 服務（網路問題，${shape.tag}${trace ? `；${traceTag(trace)}` : ''}），請稍後再試`)
  }
  if (shape.status != null) {
    return new AiError('ai_api', apiErrorMessage(shape.status, shape.type), shape.status)
  }
  return new AiError('internal', `AI 執行時發生未預期的錯誤，請通知管理員（技術資訊：${shape.tag}${trace ? `；${traceTag(trace)}` : ''}）`)
}

/**
 * 從未知例外取出「可安全外露」的形狀：類別名稱、HTTP 狀態碼、API 錯誤類型、Node 錯誤代號、脫敏後的訊息、cause 鏈、訊息樣式代號。
 * tag 例：`APIError／529`、`[undefined-prop] a／Cannot read properties of undefined (reading 'type') ← TypeError／Cannot read …`。
 * 為什麼 2026-09-30 之前只留白名單句子不夠：#8 只剩「a／cause:TypeError」——V8／undici 的 TypeError 訊息
 *   （例 "Cannot read properties of undefined (reading 'type')"）只含屬性名、不含請求內容，卻被整句擋掉，落點就查不到。
 *   現在改「脫敏後放行」（sanitizeMsg），並把 cause 往下走最多 3 層（causeChain）。整體 slice(0, 300)：error_message 上限 500 字，要留給繁中說明。
 */
export function errorShape(e: unknown): { name: string; status: number | null; type: string | null; code: string; kind: string | null; tag: string } {
  const o = (e && typeof e === 'object') ? (e as Record<string, unknown>) : {}
  const name = ctorOrName(o, typeof e)
  const status = typeof o.status === 'number' ? o.status : null
  const err = (o.error && typeof o.error === 'object') ? (o.error as Record<string, unknown>) : null
  const inner = (err?.error && typeof err.error === 'object') ? (err.error as Record<string, unknown>) : null
  const type = typeof o.type === 'string' ? o.type : (typeof inner?.type === 'string' ? (inner.type as string) : null)
  const cause = (o.cause && typeof o.cause === 'object') ? (o.cause as Record<string, unknown>) : null
  const code = typeof o.code === 'string' ? o.code : (typeof cause?.code === 'string' ? (cause.code as string) : '')
  const kind = msgKind(e)
  const chain = causeChain(e)
  const head = [name, status != null ? String(status) : null, type, code, sanitizeMsg(o.message)].filter(Boolean).join('／')
  const tag = `${kind ? `[${kind}] ` : ''}${head}${chain ? ` ← ${chain}` : ''}`.slice(0, 300)
  return { name, status, type, code, kind, tag }
}

/**
 * 類別名稱：own name（≠'Error'）優先，否則 constructor.name。SDK 0.128 的錯誤類別（AnthropicError／APIConnectionError…）都沒設 this.name，
 * name 一律是 'Error'，只能靠類別名稱分；打包後類別名會被壓縮成單字母（正式站 #8 的「a」），所以另外靠脫敏訊息／固定句子輔助。
 */
function ctorOrName(o: Record<string, unknown>, fallback: string): string {
  const ctor = (o as { constructor?: { name?: unknown } }).constructor?.name
  const own = typeof o.name === 'string' && o.name && o.name !== 'Error' ? o.name : ''
  return own || (typeof ctor === 'string' && ctor ? ctor : (typeof o.name === 'string' && o.name ? o.name : fallback))
}

/** e.cause 往下走最多 3 層（Set 防循環），每層 `類別／code／脫敏訊息`（只保留有值的段），用 ` ← ` 串接 */
export function causeChain(e: unknown): string {
  const seen = new Set<unknown>([e])
  const parts: string[] = []
  let cur = (e && typeof e === 'object') ? (e as { cause?: unknown }).cause : undefined
  for (let depth = 0; depth < 3 && cur && typeof cur === 'object' && !seen.has(cur); depth++) {
    seen.add(cur)
    const c = cur as Record<string, unknown>
    parts.push([ctorOrName(c, 'object'), typeof c.code === 'string' ? c.code : null, sanitizeMsg(c.message)].filter(Boolean).join('／'))
    cur = c.cause
  }
  return parts.join(' ← ')
}

/**
 * 訊息樣式代號（只做輔助分類，不外露原文）：看 e 與 cause 鏈上所有訊息。
 *   undefined-prop＝V8 對 undefined 取屬性（SDK 累積器吃到意外事件形狀，H1）；bad-header／non-ascii-header＝Headers.append 拒收（H2）；
 *   shape＝不是函式／不可迭代（body 或 SDK 回傳形狀不對，H3）；body-state＝Response body 已被讀走或鎖住（H4）。
 */
export function msgKind(e: unknown): string | null {
  const seen = new Set<unknown>()
  let cur: unknown = e
  for (let depth = 0; depth < 4 && cur && typeof cur === 'object' && !seen.has(cur); depth++) {
    seen.add(cur)
    const m = (cur as { message?: unknown }).message
    if (typeof m === 'string') {
      if (/Cannot read propert|Cannot destructure|of undefined|of null/i.test(m)) return 'undefined-prop'
      if (/invalid header value|invalid header name/i.test(m)) return 'bad-header'
      if (/ByteString/i.test(m)) return 'non-ascii-header'
      if (/is not a function|is not iterable|is not async iterable/i.test(m)) return 'shape'
      if (/Body is unusable|disturbed or locked|Invalid state|already been read|already read/i.test(m)) return 'body-state'
    }
    cur = (cur as { cause?: unknown }).cause
  }
  return null
}

/**
 * SDK／Node 自己的固定句子（白名單）：整句原樣放行——這些是固定字串，對定位問題最有用（例：Connection error.、Request timed out.）。
 * 其他句子走 sanitizeMsg 脫敏後才放行。
 */
const SAFE_MSG_ALLOWLIST = /^(Connection error\.?|Request timed out\.?|Request was aborted\.?|Could not resolve a `Response` object|fetch failed|terminated|other side closed|socket hang up|read ECONNRESET|Stream ended without producing a Message with role=assistant|The operation was aborted\.?|This operation was aborted)$/i
/** 引號／括號內「像識別字」的內容才保留（V8 的 (reading 'type') 這種有定位價值），其他一律換成佔位符 */
const IDENT_RE = /^[A-Za-z_$][\w$.]{0,23}$/
const BRACKET_INNER_RE = /^(?:(?:reading|of|at|in|for|to|on|named|called|type|got|expected) )?'?[A-Za-z_$][\w$.]{0,23}'?$/

/**
 * 錯誤訊息脫敏（規格 D95：外露文字不得含請求內容）。順序固定、先遮再刪：
 *   1. 非字串 → null；換行改空白、trim；2. 白名單命中 → 原樣；
 *   3. 遮 token：sk-ant-… → <key>；任何 ≥20 字的 base64／識別字樣式 → <tok>；email → <mail>；字母＋數字混合的代碼（K001、SO-…）→ <tok>
 *      （Headers.append 的錯誤會把「整個 header 值」印進訊息——含金鑰！所以這步必須在去引號之前，不能直接放行 e.message）；
 *   4. 括號 (…)／[…]／{…} 由內而外最多 3 輪：內容不像識別字 → <..>；5. 引號 '…'／"…"／`…`：內容不像識別字 → <q>；
 *   6. 數字 → #；非 ASCII 全刪（中文客戶名／品名不可能留下）；連續空白合一；slice(0, 120)。
 * 已知邊界：沒加引號、純英文字母的詞（例：Latin 公司名）無法與 SDK／V8 固定句子區分，會原樣留下；SDK 與 V8 的訊息都會把
 *   變動內容放在引號或括號內，4xx 的 API 錯誤又走 ai_api 不帶 tag，所以實務上碰不到請求內容。
 */
export function sanitizeMsg(m: unknown): string | null {
  if (typeof m !== 'string') return null
  // 換行改成空白而不是只取第一行：Headers.append 的訊息會把含換行的 header 值整個印進來，診斷字（is an invalid header value）在換行之後
  let t = m.replace(/\s*\r?\n\s*/g, ' ').trim()
  if (t === '') return null
  if (SAFE_MSG_ALLOWLIST.test(t)) return t
  t = t.replace(/sk-ant-[A-Za-z0-9_\-]*/g, '<key>').replace(/[A-Za-z0-9+/_\-]{20,}={0,2}/g, '<tok>').replace(/\S+@\S+/g, '<mail>')
  // 字母＋數字混合的代碼（卡片代號 K001、單號 SO-…、客戶代碼 ACME-9981）一律遮掉；純字母的英文詞（ByteString、ECONNRESET、reading）保留
  t = t.replace(/\b(?=[A-Za-z0-9_\-]*\d)(?=[A-Za-z0-9_\-]*[A-Za-z])[A-Za-z0-9_\-]{2,}\b/g, '<tok>')
  for (let i = 0; i < 3; i++) {
    const before = t
    t = t
      .replace(/\(([^()]*)\)/g, (_, inner: string) => (BRACKET_INNER_RE.test(inner.trim()) ? `(${inner.trim()})` : '<..>'))
      .replace(/\[([^[\]]*)\]/g, (_, inner: string) => (BRACKET_INNER_RE.test(inner.trim()) ? `[${inner.trim()}]` : '<..>'))
      .replace(/\{([^{}]*)\}/g, (_, inner: string) => (BRACKET_INNER_RE.test(inner.trim()) ? `{${inner.trim()}}` : '<..>'))
    if (t === before) break
  }
  t = t.replace(/(['"`])((?:(?!\1).)*)\1/g, (_, q: string, inner: string) => (IDENT_RE.test(inner) ? `${q}${inner}${q}` : `${q}<q>${q}`))
  t = t.replace(/\d/g, '#').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim()
  return t === '' ? null : t.slice(0, 120)
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
