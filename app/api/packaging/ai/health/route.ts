import { after, type NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { getSupabaseAdminClient } from '@/lib/supabaseAdmin'
import { guardPackagingAi, noStore } from '@/lib/packaging/guard'
import {
  AI_FALLBACK_BETA,
  AI_MODEL,
  type AiCallTrace,
  aiNotConfiguredMessage,
  aiRuntimeInfo,
  attachTrace,
  classifyAiError,
  createClaudeClient,
  errorShape,
  isAiConfigured,
} from '@/lib/packaging/ai/claude'
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages'
import { actorOf, logAi } from '../_lib/aiRoute'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// stream 模式 max_tokens 1500＋思考可能 30～60 秒；after 模式的背景工作也算在這次呼叫內。
// 探針 client 用 maxRetries 0：SDK timeout（stream 90 秒）× 1 次嘗試 < 120，不會在重試中途被平台砍掉（砍掉就連 log 都寫不出來）。
export const maxDuration = 120

// 包裝專區 AI 健康檢查（D112；2026-09-30 RCA 擴充三種模式）
//
// GET /api/packaging/ai/health                → ping：用正式站「同一個 client、同一個模型」送一個極小請求（max_tokens 5，幾乎不花錢），
//                                                 回報金鑰／網路／模型是否正常。分不出「金鑰沒設或失效」「連不上」「模型不可用」就看這個。
// GET …/health?mode=stream[&nofallback=1]     → 與正式排程「同形」的請求（json_schema 輸出＋adaptive thinking＋system cache_control＋
//                                                 betas／fallbacks）但 payload 極小，在「請求內」重現；與 ping 對照可切開「金鑰／連線」與「請求形狀」。
//                                                 nofallback=1 省略 betas／fallbacks（對應 PACKAGING_AI_NO_FALLBACK 開關的 A/B）。
// GET …/health?mode=after[&persist=1]         → 把 stream 模式一模一樣的測試放進 after()（回應送出後才跑），唯一差異就是「回應後執行」，
//                                                 對應正式排程的 after(() => executeRun(...))。結果一律 console.log（Vercel Runtime Logs 搜
//                                                 [packaging/ai/health/after]）；persist=1 另外寫一筆 packaging_op_log（kind 'ai_sim'，
//                                                 label「AI 健康檢查（after 模式）#xxxx」，主管在操作紀錄可看到）。不寫 packaging_ai_runs。
// 所有模式都附 env（Node 版本、fetch 是否被 Next 包裝、Vercel region、診斷開關的布林），只回布林／版本字串，不回任何變數值。
// 權限比照 AI 模擬區（packaging_ai／admin）。不接受其他方法。回應不快取。
// 安全：不回傳金鑰、不回傳 AI 文字內容、不回傳 API 訊息原文；錯誤只給分類後的繁中訊息＋脫敏技術標籤（errorShape）。

type ProbeUsage = { input: number; output: number; cacheRead: number; cacheCreate: number }
type ProbeOk = { success: true; ms: number; stop: string | null; model: string; usage: ProbeUsage; trace: AiCallTrace }
type ProbeFail = { success: false; ms: number; code: string; error: string; status: number | null; tag: string; trace: AiCallTrace | null }
type ProbeResult = ProbeOk | ProbeFail

/** stream 模式的極小 JSON schema（回應內容不外露，只看 stop_reason／usage） */
const PROBE_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
  required: ['ok', 'note'],
  additionalProperties: false,
} as const

/** 與 buildClaudeRequest 同形（model／thinking／output_config.format／system cache_control／betas／fallbacks），只有 payload 極小（route 檔只 export handler／config，這個不 export） */
function buildProbeRequest(nofallback: boolean): BetaMessageStreamParams {
  return {
    model: AI_MODEL,
    max_tokens: 1500,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: PROBE_SCHEMA } },
    system: [{ type: 'text', text: '你是健康檢查用的回覆器，只回 JSON。', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: '請回 {"ok":true,"note":"pong"}' }],
    ...(nofallback ? {} : { betas: [AI_FALLBACK_BETA], fallbacks: 'default' as const }),
  }
}

async function runProbe(body: BetaMessageStreamParams, timeoutMs: number): Promise<ProbeResult> {
  const t0 = Date.now()
  let trace: AiCallTrace | null = null
  try {
    const client = createClaudeClient({ maxRetries: 0 })
    const stream = client.beta.messages.stream(body, { timeout: timeoutMs })
    trace = attachTrace(stream, t0)
    const msg = await stream.finalMessage()
    trace.aiMs = Date.now() - t0
    const u = msg.usage
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    return {
      success: true,
      ms: Date.now() - t0,
      stop: msg.stop_reason ?? null,
      model: msg.model ?? AI_MODEL,
      usage: { input: n(u?.input_tokens), output: n(u?.output_tokens), cacheRead: n(u?.cache_read_input_tokens), cacheCreate: n(u?.cache_creation_input_tokens) },
      trace,
    }
  } catch (e) {
    if (trace) trace.aiMs = Date.now() - t0
    const ai = classifyAiError(e, trace ?? undefined)
    return { success: false, ms: Date.now() - t0, code: ai.code, error: ai.message, status: ai.status, tag: errorShape(e).tag, trace }
  }
}

const pingProbe = () => runProbe({ model: AI_MODEL, max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] }, 45_000)
const streamProbe = (nofallback: boolean) => runProbe(buildProbeRequest(nofallback), 90_000)

export async function GET(request: NextRequest) {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  const q = request.nextUrl.searchParams
  const modeRaw = q.get('mode') ?? 'ping'
  if (modeRaw !== 'ping' && modeRaw !== 'stream' && modeRaw !== 'after') {
    return noStore({ success: false, code: 'bad_request', error: 'mode 只接受 ping（預設）／stream／after' }, 400)
  }
  const mode = modeRaw
  const nofallback = q.get('nofallback') === '1'
  const persist = q.get('persist') === '1'
  const env = aiRuntimeInfo()
  if (!isAiConfigured()) {
    return noStore({ success: false, code: 'ai_not_configured', error: aiNotConfiguredMessage(), model: AI_MODEL, mode, env }, 503)
  }

  if (mode === 'after') {
    const probeId = randomUUID().slice(0, 8)
    const at = new Date().toISOString()
    const me = actorOf(g.member)
    after(async () => {
      const r = await streamProbe(nofallback)
      const result = { probeId, mode: 'after', nofallback, at, ...r, env }
      // 只有數字／枚舉／脫敏標籤，沒有 AI 文字與請求內容
      console.log('[packaging/ai/health/after] ' + JSON.stringify(result))
      if (persist) {
        try {
          // kind 'ai_sim' 在 packaging_op_log_kind_check 內（sql/20260928d_packaging_closures.sql）；insertOpLog 失敗只 console.error
          await logAi(getSupabaseAdminClient(), me, 'ai_sim', `AI 健康檢查（after 模式）#${probeId}`, [result])
        } catch (e) {
          console.error(`[packaging/ai/health/after] #${probeId} op_log 寫入失敗 ${errorShape(e).tag}`)
        }
      }
    })
    return noStore({
      accepted: true,
      mode,
      probeId,
      at,
      nofallback,
      persist,
      readBack: persist
        ? `約 30～90 秒後到包裝專區「操作紀錄」找「AI 健康檢查（after 模式）#${probeId}」，或在 Vercel Logs 搜 [packaging/ai/health/after]`
        : '請到 Vercel Runtime Logs 搜 [packaging/ai/health/after]（加 &persist=1 會另外寫進操作紀錄）',
      env,
    })
  }

  const r = mode === 'stream' ? await streamProbe(nofallback) : await pingProbe()
  if (!r.success) console.error(`[packaging/ai/health] mode=${mode} ${r.code} ${r.tag}`)
  return noStore({ ...r, mode, nofallback: mode === 'stream' ? nofallback : undefined, model: r.success ? r.model : AI_MODEL, env }, r.success ? 200 : 502)
}
