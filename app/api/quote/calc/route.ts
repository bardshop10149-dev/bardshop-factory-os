import { NextRequest, NextResponse } from 'next/server'
import { guardQuote } from '@/lib/quote/guard'
import { badRequest, createQuoteCtx, quoteErrorResponse, readJsonBody, runCalc } from '@/lib/quote/data'
import type { CalcRequest } from '@/lib/quote/api'

export const dynamic = 'force-dynamic'

// POST：對每款尺寸跑引擎，組 CalcResponse。輸入問題一律走 errors[]（HTTP 200），
// 只有 JSON 壞掉、表不存在、系統錯誤才回非 200。
// 驗證與組裝都在 lib/quote/data.ts runCalc()，log route 產生報價時會用同一段重算。
export async function POST(request: NextRequest) {
  const guard = await guardQuote('quote_user')
  if (!guard.ok) return guard.res

  const body = await readJsonBody<CalcRequest>(request)
  if (!body || typeof body !== 'object') return badRequest('Invalid JSON')

  try {
    const ctx = createQuoteCtx()
    const { res } = await runCalc(ctx, body, guard.member)
    return NextResponse.json({ success: true, ...res, devSeed: ctx.devSeed })
  } catch (e) {
    return quoteErrorResponse(e)
  }
}
