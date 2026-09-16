import { NextRequest, NextResponse } from 'next/server'
import { guardQuote } from '@/lib/quote/guard'
import { describeError } from '@/lib/supabaseAdmin'
import {
  badRequest,
  createQuoteCtx,
  loadPriceRows,
  loadSettings,
  quoteErrorResponse,
  readJsonBody,
  writableClient,
} from '@/lib/quote/data'
import type { ErpSuggestion } from '@/lib/quote/api'

export const dynamic = 'force-dynamic'

const MAX_ITEMS = 300

/** ERP 幣別寫法統一：CNY/RMB → RMB；TWD/NTD/NT$ → TWD */
function normalizeCurrency(raw: string | null | undefined): string {
  const v = String(raw ?? '').trim().toUpperCase()
  if (v === 'CNY' || v === 'RMB') return 'RMB'
  if (v === 'TWD' || v === 'NTD' || v === 'NT$') return 'TWD'
  return v
}

// POST { itemIds?: string[] }：對有 ARGO 料號的價格項目抓最近一張採購單身的單價與幣別，
// 寫回 quote_price_items.erp_suggested_*（只是建議，不覆寫 price；人工在後台「採用」才改）。
export async function POST(request: NextRequest) {
  const guard = await guardQuote('quote_admin')
  if (!guard.ok) return guard.res

  const body = (await readJsonBody<{ itemIds?: unknown }>(request)) ?? {}
  let itemIds: string[] | null = null
  if (body.itemIds !== undefined) {
    if (!Array.isArray(body.itemIds) || !body.itemIds.every((x) => typeof x === 'string')) return badRequest('itemIds 必須是字串陣列')
    itemIds = (body.itemIds as string[]).map((s) => s.trim()).filter(Boolean)
    if (itemIds.length > MAX_ITEMS) return badRequest(`一次最多 ${MAX_ITEMS} 項`)
  }

  try {
    const ctx = createQuoteCtx()
    const sb = writableClient(ctx)
    if (!sb) return badRequest('目前為開發 seed 模式（資料表尚未建立或 QUOTE_DEV_SEED=1），無法查 ERP', 'DEV_SEED')

    const settings = await loadSettings(ctx)
    const rate = settings.fx_rmb_twd?.rate ?? null
    const rows = (await loadPriceRows(ctx))
      .filter((r) => r.argo_part_code)
      .filter((r) => !itemIds || itemIds.includes(r.id))
    if (rows.length === 0) return NextResponse.json({ success: true, suggestions: [] as ErpSuggestion[], missing: [] as string[] })

    type PoRow = { doc_no: string; end_date: string | null; synced_at: string | null; unit_price: string | null; currency: string | null }
    const suggestions: ErpSuggestion[] = []
    const missing: string[] = []
    const now = new Date().toISOString()

    for (const r of rows) {
      const code = r.argo_part_code as string
      // 只抓帶單價的採購單身；synced_at 最新的一筆當「最近採購價」
      const { data, error } = await sb
        .from('erp_pj_sync')
        .select('doc_no, end_date, synced_at, unit_price:extra->>UNIT_PRICE_ORU, currency:extra->>CURRENCY')
        .eq('doc_type', '採購單號')
        .eq('item_code', code)
        .not('extra->>UNIT_PRICE_ORU', 'is', null)
        .order('synced_at', { ascending: false })
        .limit(1)
      if (error) throw new Error(describeError(error))
      const po = ((data ?? []) as PoRow[])[0]
      const price = po ? Number(po.unit_price) : NaN
      if (!po || !Number.isFinite(price) || price <= 0) {
        missing.push(code)
        continue
      }

      const erpCurrency = normalizeCurrency(po.currency) || normalizeCurrency(r.currency)
      const itemCurrency = normalizeCurrency(r.currency)
      let convertedPrice: number | null
      if (erpCurrency === itemCurrency) convertedPrice = price
      else if (rate && erpCurrency === 'TWD' && itemCurrency === 'RMB') convertedPrice = price / rate
      else if (rate && erpCurrency === 'RMB' && itemCurrency === 'TWD') convertedPrice = price * rate
      else convertedPrice = null

      const { error: upErr } = await sb
        .from('quote_price_items')
        .update({ erp_suggested_price: price, erp_suggested_currency: erpCurrency, erp_suggested_at: now })
        .eq('id', r.id)
      if (upErr) throw new Error(describeError(upErr))

      suggestions.push({
        itemId: r.id,
        argoPartCode: code,
        price,
        currency: erpCurrency,
        docNo: po.doc_no,
        date: po.end_date ?? null,
        convertedPrice,
      })
    }

    return NextResponse.json({ success: true, suggestions, missing, fxRate: rate })
  } catch (e) {
    return quoteErrorResponse(e)
  }
}
