import { NextRequest, NextResponse } from 'next/server'
import { guardQuote } from '@/lib/quote/guard'
import { describeError } from '@/lib/supabaseAdmin'
import {
  badRequest,
  createQuoteCtx,
  getProduct,
  loadGoldenCases,
  loadProducts,
  PLANTS,
  PRODUCT_STATUSES,
  quoteErrorResponse,
  readJsonBody,
  validateProductConfig,
  verifyProduct,
  writableClient,
} from '@/lib/quote/data'
import type { AdminProductRow, AdminProductsAction, GoldenRow } from '@/lib/quote/api'
import type { ProductConfig } from '@/lib/quote/types'

export const dynamic = 'force-dynamic'

const NAME_MAX_LEN = 40

// GET：全部品項 + 全部 golden（各自陣列，golden 以 product_id 對回品項）。
export async function GET() {
  const guard = await guardQuote('quote_admin')
  if (!guard.ok) return guard.res

  try {
    const ctx = createQuoteCtx()
    const products: AdminProductRow[] = await loadProducts(ctx, { publishedOnly: false })
    const goldens: GoldenRow[] = await loadGoldenCases(ctx)
    return NextResponse.json({ success: true, products, goldens, devSeed: ctx.devSeed })
  } catch (e) {
    return quoteErrorResponse(e)
  }
}

const isText = (v: unknown, max = NAME_MAX_LEN): v is string => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max

// POST：AdminProductsAction（create / update / setStatus / setGoldenStatus）。所有寫入逐欄白名單。
export async function POST(request: NextRequest) {
  const guard = await guardQuote('quote_admin')
  if (!guard.ok) return guard.res

  const body = await readJsonBody<AdminProductsAction>(request)
  if (!body || typeof body !== 'object' || typeof body.action !== 'string') return badRequest('Invalid JSON')

  try {
    const ctx = createQuoteCtx()
    const sb = writableClient(ctx)
    if (!sb) return badRequest('目前為開發 seed 模式（資料表尚未建立或 QUOTE_DEV_SEED=1），無法寫入', 'DEV_SEED')
    const updatedBy = guard.member.realName ?? guard.member.email
    const now = new Date().toISOString()

    switch (body.action) {
      case 'create': {
        const p = body.product
        if (!p || typeof p !== 'object') return badRequest('缺少 product')
        if (!isText(p.name)) return badRequest(`品項名稱必填，最多 ${NAME_MAX_LEN} 字`)
        if (!isText(p.category)) return badRequest('品類必填')
        if (!PLANTS.includes(p.plant)) return badRequest(`plant 必須是 ${PLANTS.join('/')}`)
        const cfgErr = validateProductConfig(p.config)
        if (cfgErr) return badRequest(cfgErr)
        const sortOrder = Number.isFinite(Number(p.sort_order)) ? Math.floor(Number(p.sort_order)) : 0
        // 新建一律 draft：published 只能經 setStatus 走驗證閘門
        const { data, error } = await sb
          .from('quote_products')
          .insert({
            family: 'acrylic',
            category: p.category.trim(),
            name: p.name.trim(),
            plant: p.plant,
            status: 'draft',
            version: 1,
            config: p.config as ProductConfig,
            sort_order: sortOrder,
            updated_by: updatedBy,
            updated_at: now,
            published_at: null,
          })
          .select('id')
          .single()
        if (error) throw new Error(describeError(error))
        return NextResponse.json({ success: true, id: (data as { id: string }).id })
      }

      case 'update': {
        if (!isText(body.id, 64)) return badRequest('缺少 id')
        const patch = body.patch
        if (!patch || typeof patch !== 'object') return badRequest('缺少 patch')
        const existing = await getProduct(ctx, body.id)
        if (!existing) return badRequest('找不到此品項')

        const update: Record<string, unknown> = { updated_by: updatedBy, updated_at: now }
        if (patch.name !== undefined) {
          if (!isText(patch.name)) return badRequest(`品項名稱必填，最多 ${NAME_MAX_LEN} 字`)
          update.name = patch.name.trim()
        }
        if (patch.category !== undefined) {
          if (!isText(patch.category)) return badRequest('品類必填')
          update.category = patch.category.trim()
        }
        if (patch.plant !== undefined) {
          if (!PLANTS.includes(patch.plant)) return badRequest(`plant 必須是 ${PLANTS.join('/')}`)
          update.plant = patch.plant
        }
        if (patch.sort_order !== undefined) {
          const n = Number(patch.sort_order)
          if (!Number.isFinite(n)) return badRequest('sort_order 必須是數字')
          update.sort_order = Math.floor(n)
        }
        let demoted = false
        if (patch.config !== undefined) {
          const cfgErr = validateProductConfig(patch.config)
          if (cfgErr) return badRequest(cfgErr)
          update.config = patch.config
          // 已發布的品項改了設定 → 退回 testing、版本 +1，必須重跑驗證才能再發布
          if (existing.status === 'published') {
            update.status = 'testing'
            update.version = existing.version + 1
            demoted = true
          }
        }
        const { error } = await sb.from('quote_products').update(update).eq('id', existing.id)
        if (error) throw new Error(describeError(error))
        return NextResponse.json({ success: true, demoted, version: demoted ? existing.version + 1 : existing.version })
      }

      case 'setStatus': {
        if (!isText(body.id, 64)) return badRequest('缺少 id')
        if (!PRODUCT_STATUSES.includes(body.status)) return badRequest(`status 必須是 ${PRODUCT_STATUSES.join('/')}`)
        const existing = await getProduct(ctx, body.id)
        if (!existing) return badRequest('找不到此品項')

        const update: Record<string, unknown> = { status: body.status, updated_by: updatedBy, updated_at: now }
        if (body.status === 'published') {
          // 發布閘門：該品項所有 approved golden 都要在容差內
          const verify = await verifyProduct(ctx, existing.id, { includeProposed: false, persist: true })
          if (verify.gate === 'no-approved-cases') {
            return NextResponse.json(
              { success: false, error: '此品項沒有任何已核可的驗證案例，無法發布。請先核可（approve）至少一筆 golden case。', code: 'NO_APPROVED_CASES', verify },
              { status: 400 },
            )
          }
          if (verify.gate === 'fail') {
            const failed = verify.results.filter((r) => r.status === 'approved' && !r.pass).map((r) => r.name)
            return NextResponse.json(
              { success: false, error: `驗證未通過，無法發布：${failed.join('、')}`, code: 'VERIFY_FAILED', verify },
              { status: 400 },
            )
          }
          update.published_at = now
        }
        const { error } = await sb.from('quote_products').update(update).eq('id', existing.id)
        if (error) throw new Error(describeError(error))
        return NextResponse.json({ success: true, status: body.status })
      }

      case 'setGoldenStatus': {
        if (!isText(body.goldenId, 64)) return badRequest('缺少 goldenId')
        if (!['approved', 'rejected', 'proposed'].includes(body.status)) return badRequest('status 必須是 approved/rejected/proposed')
        const update: Record<string, unknown> = { status: body.status }
        if (body.status === 'approved') {
          update.approved_by = updatedBy
          update.approved_at = now
        } else {
          update.approved_by = null
          update.approved_at = null
        }
        const { data, error } = await sb.from('quote_golden_cases').update(update).eq('id', body.goldenId).select('id')
        if (error) throw new Error(describeError(error))
        if (!data || data.length === 0) return badRequest('找不到此驗證案例')
        return NextResponse.json({ success: true, status: body.status })
      }

      default:
        return badRequest('action 必須是 create / update / setStatus / setGoldenStatus')
    }
  } catch (e) {
    return quoteErrorResponse(e)
  }
}
