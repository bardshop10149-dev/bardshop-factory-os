import { NextRequest, NextResponse } from 'next/server'
import { guardQuote } from '@/lib/quote/guard'
import {
  badRequest,
  createQuoteCtx,
  getProduct,
  quoteErrorResponse,
  readJsonBody,
  verifyProduct,
} from '@/lib/quote/data'
import type { VerifyResponse } from '@/lib/quote/api'

export const dynamic = 'force-dynamic'

// POST { productId, includeProposed? }：跑該品項的 golden case。
// gate 只看 approved；includeProposed=true 時 proposed 也跑（結果列出，但不影響 gate），
// 讓 Snow 核可前先看「這筆案例現在過不過」。每筆的 last_result/last_diff/last_run_at 會寫回（devSeed 不寫）。
export async function POST(request: NextRequest) {
  const guard = await guardQuote('quote_admin')
  if (!guard.ok) return guard.res

  const body = await readJsonBody<{ productId?: string; includeProposed?: boolean }>(request)
  if (!body || typeof body !== 'object') return badRequest('Invalid JSON')
  const productId = typeof body.productId === 'string' ? body.productId.trim() : ''
  if (!productId) return badRequest('缺少 productId')
  const includeProposed = body.includeProposed === true

  try {
    const ctx = createQuoteCtx()
    const product = await getProduct(ctx, productId)
    if (!product) return badRequest('找不到此品項')
    const result: VerifyResponse = await verifyProduct(ctx, product.id, { includeProposed, persist: true })
    return NextResponse.json({ success: true, ...result, devSeed: ctx.devSeed })
  } catch (e) {
    return quoteErrorResponse(e)
  }
}
