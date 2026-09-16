import { NextResponse } from 'next/server'
import { guardQuote } from '@/lib/quote/guard'
import {
  collectPriceNames,
  createQuoteCtx,
  fxInfoOf,
  loadPriceMap,
  loadProducts,
  loadSettings,
  quoteErrorResponse,
} from '@/lib/quote/data'
import type { CatalogCategory, CatalogPriceItem, CatalogProduct, CatalogResponse } from '@/lib/quote/api'

export const dynamic = 'force-dynamic'

const CATEGORIES: CatalogCategory[] = [
  { code: 'acrylic', name: '壓克力', enabled: true },
  { code: 'sticker', name: '貼紙', enabled: false },
  { code: 'crystal', name: '水晶標', enabled: false },
]

// GET：前台目錄 —— 分頁、published 品項、這些品項會用到的價格項目、費率版本、匯率。
// 價格只回「品項 config 會查到的名稱」，不把整張價格表丟到前台。
export async function GET() {
  const guard = await guardQuote('quote_user')
  if (!guard.ok) return guard.res

  try {
    const ctx = createQuoteCtx()
    const [settings, products] = await Promise.all([loadSettings(ctx), loadProducts(ctx, { publishedOnly: true })])

    const needed = new Set<string>()
    const plants = new Set(products.map((p) => p.plant))
    for (const p of products) for (const n of collectPriceNames(p.config)) needed.add(n)

    const priceItems: CatalogPriceItem[] = []
    for (const plant of plants) {
      const map = await loadPriceMap(ctx, plant)
      for (const name of needed) {
        const it = map.get(name)
        if (!it) continue
        priceItems.push({
          name: it.name,
          displayName: it.display_name ?? it.name,
          group: it.group,
          unit: it.unit,
          price: it.price,
          currency: it.currency,
          attrs: it.attrs,
        })
      }
    }

    const body: CatalogResponse = {
      categories: CATEGORIES,
      products: products.map<CatalogProduct>((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        plant: p.plant,
        status: p.status,
        version: p.version,
        config: p.config,
      })),
      priceItems,
      rateVersion: settings.rate_version,
      fx: fxInfoOf(settings),
      validityDays: settings.quote_validity_days,
      canEngineer: guard.member.isAdmin || guard.member.permissions.includes('quote_admin'),
      devSeed: ctx.devSeed,
    }
    return NextResponse.json({ success: true, ...body })
  } catch (e) {
    return quoteErrorResponse(e)
  }
}
