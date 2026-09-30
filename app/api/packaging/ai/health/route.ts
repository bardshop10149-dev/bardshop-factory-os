import { guardPackagingAi, noStore } from '@/lib/packaging/guard'
import { AI_MODEL, classifyAiError, createClaudeClient, errorShape, isAiConfigured } from '@/lib/packaging/ai/claude'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 包裝專區 AI 健康檢查（D112）
//
// GET /api/packaging/ai/health → 用正式站「同一個 client、同一個模型」送一個極小請求（max_tokens 5，幾乎不花錢），
// 回報金鑰／網路／模型是否正常。正式站上 AI 排程失敗時，管理員在瀏覽器打開這個網址就能分辨是
// 「金鑰沒設或失效」「連不上」「模型不可用」還是「排程程式本身的問題」，不必翻 Vercel log。
// 權限比照 AI 模擬區（packaging_ai／admin）。不接受其他方法。回應不快取。
// 安全：不回傳金鑰、不回傳任何 API 訊息原文；錯誤只給分類後的繁中訊息＋技術標籤（類別／狀態碼／代號）。

export async function GET() {
  const g = await guardPackagingAi()
  if (!g.ok) return g.res
  if (!isAiConfigured()) {
    return noStore({ success: false, code: 'ai_not_configured', error: '尚未設定 AI 金鑰（ANTHROPIC_API_KEY）', model: AI_MODEL }, 503)
  }
  const t0 = Date.now()
  try {
    const client = createClaudeClient()
    const msg = await client.beta.messages.stream({ model: AI_MODEL, max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] }, { timeout: 45_000 }).finalMessage()
    return noStore({ success: true, model: msg.model ?? AI_MODEL, ms: Date.now() - t0, stop: msg.stop_reason ?? null })
  } catch (e) {
    const ai = classifyAiError(e)
    console.error(`[packaging/ai/health] ${ai.code} ${errorShape(e).tag}`)
    return noStore({ success: false, code: ai.code, error: ai.message, status: ai.status, tag: errorShape(e).tag, ms: Date.now() - t0, model: AI_MODEL }, 502)
  }
}
