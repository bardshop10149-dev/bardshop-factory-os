import { NextRequest, NextResponse } from 'next/server'
import { guardQuote } from '@/lib/quote/guard'
import { describeError } from '@/lib/supabaseAdmin'
import {
  badRequest,
  createQuoteCtx,
  isTableMissingError,
  loadProducts,
  nextQuoteNo,
  QuoteTableMissingError,
  quoteErrorResponse,
  readJsonBody,
  runCalc,
  summarize,
  taipeiToday,
  writableClient,
} from '@/lib/quote/data'
import type { CalcRequest, LogRequest, LogResponse, LogRow } from '@/lib/quote/api'

export const dynamic = 'force-dynamic'

const CUSTOMER_MAX_LEN = 40
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50

// POST：產生報價 → 寫 quote_calc_logs（含報價編號、品項版本、費率版本、價格快照）。
// 只信 body.request：伺服器用 runCalc 重跑一次，落庫的 response / quote_unit / price_snapshot / fx /
// rate_version / product_version 全部是伺服器算出來的（body.response 只是前台畫面上的東西，不採用），
// 否則任何 info_board 使用者都能偽造任意單價的正式報價編號。
// devSeed 模式不寫 DB，回 DEV- 開頭的編號讓前台流程走得通。
export async function POST(request: NextRequest) {
  const guard = await guardQuote('quote_user')
  if (!guard.ok) return guard.res

  const body = await readJsonBody<LogRequest>(request)
  if (!body || typeof body !== 'object') return badRequest('Invalid JSON')
  const reqRaw = body.request
  if (!reqRaw || typeof reqRaw !== 'object' || typeof reqRaw.productId !== 'string' || !reqRaw.productId) {
    return badRequest('缺少 request.productId')
  }
  if (body.customer != null && typeof body.customer !== 'string') return badRequest('customer 必須是文字')
  const customer = (body.customer ?? '').trim().slice(0, CUSTOMER_MAX_LEN) || null

  try {
    const ctx = createQuoteCtx()
    // audit：不管業務用哪個模式，落庫一律存完整五段與價格快照（稽核用）；回給前端的只有編號與摘要
    const { res, req, product } = await runCalc(ctx, reqRaw, guard.member, { audit: true })
    if (res.errors.length > 0 || !req || !product) {
      const first = res.errors[0]
      return badRequest(first ? `試算結果含錯誤，無法產生報價：${first.message.replace(/^※\s*/, '')}` : '試算結果含錯誤，無法產生報價', first?.code)
    }
    if (res.sizes.length === 0) return badRequest('試算沒有結果，請先完成試算')
    const quoteUnit = Number(res.sizes[0].quoteUnit)
    if (!Number.isFinite(quoteUnit) || quoteUnit <= 0) return badRequest('報價單價無效，請重新試算')

    const summary = summarize(req, res, product)
    const now = new Date().toISOString()

    const sb = writableClient(ctx)
    if (!sb) {
      const out: LogResponse = { quoteNo: `DEV-${taipeiToday().replace(/-/g, '')}-${Date.now().toString().slice(-4)}`, createdAt: now }
      return NextResponse.json({ success: true, ...out, summary, devSeed: true })
    }

    const quoteNo = await nextQuoteNo(sb)
    // 逐欄白名單：request 存正規化後的請求，response 與其餘欄位一律來自伺服器重算的結果
    const { error } = await sb.from('quote_calc_logs').insert({
      quote_no: quoteNo,
      product_id: product.id,
      product_version: res.productVersion || product.version,
      rate_version: res.rateVersion || null,
      customer,
      request: req,
      response: res,
      price_snapshot: res.priceSnapshot,
      fx: res.fx,
      quote_unit: quoteUnit,
      summary,
      user_email: guard.member.email,
      created_at: now,
    })
    if (error) throw new Error(describeError(error))

    const out: LogResponse = { quoteNo, createdAt: now }
    return NextResponse.json({ success: true, ...out, summary, devSeed: false })
  } catch (e) {
    return quoteErrorResponse(e)
  }
}

// GET ?mine=1&limit=10：本人最近 N 筆（最近報價帶入用）。
export async function GET(request: NextRequest) {
  const guard = await guardQuote('quote_user')
  if (!guard.ok) return guard.res

  const params = request.nextUrl.searchParams
  const limitRaw = Number(params.get('limit') ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_LIMIT) : DEFAULT_LIMIT
  const mine = params.get('mine') !== '0'
  if (!mine) return badRequest('目前只支援 ?mine=1（本人紀錄）')

  try {
    const ctx = createQuoteCtx()
    const sb = writableClient(ctx)
    if (!sb) return NextResponse.json({ success: true, logs: [] as LogRow[], devSeed: true })

    type Row = {
      quote_no: string; created_at: string; customer: string | null; product_id: string
      summary: string | null; quote_unit: number | string | null; request: unknown
    }
    const { data, error } = await sb
      .from('quote_calc_logs')
      .select('quote_no, created_at, customer, product_id, summary, quote_unit, request')
      .eq('user_email', guard.member.email)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) {
      if (isTableMissingError(error)) {
        // 開發環境表還沒建：回空清單讓前台能動；正式環境照規則 503
        if (ctx.allowSeedFallback) return NextResponse.json({ success: true, logs: [] as LogRow[], devSeed: true })
        throw new QuoteTableMissingError()
      }
      throw new Error(describeError(error))
    }

    const products = await loadProducts(ctx, { publishedOnly: false })
    const nameOf = new Map(products.map((p) => [p.id, p.name]))
    const logs: LogRow[] = ((data ?? []) as Row[]).map((r) => ({
      quote_no: r.quote_no,
      created_at: r.created_at,
      customer: r.customer,
      product_name: nameOf.get(r.product_id) ?? '（品項已移除）',
      summary: r.summary ?? '',
      quote_unit: Number(r.quote_unit ?? 0),
      request: r.request as CalcRequest,
    }))
    return NextResponse.json({ success: true, logs, devSeed: ctx.devSeed })
  } catch (e) {
    return quoteErrorResponse(e)
  }
}
