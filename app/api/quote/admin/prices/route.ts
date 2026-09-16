import { NextRequest, NextResponse } from 'next/server'
import { guardQuote } from '@/lib/quote/guard'
import { describeError } from '@/lib/supabaseAdmin'
import {
  badRequest,
  createQuoteCtx,
  loadPriceRows,
  PLANTS,
  quoteErrorResponse,
  readJsonBody,
  taipeiToday,
  writableClient,
} from '@/lib/quote/data'
import type { AdminPriceRow } from '@/lib/quote/api'
import type { Plant } from '@/lib/quote/types'

export const dynamic = 'force-dynamic'

const NOTE_MAX_LEN = 200
const DISPLAY_MAX_LEN = 80
const PART_CODE_MAX_LEN = 40
const MAX_ROWS = 200

// GET ?plant=changping：整張價格表（含 ERP 建議價欄位）。
export async function GET(request: NextRequest) {
  const guard = await guardQuote('quote_admin')
  if (!guard.ok) return guard.res

  const plantRaw = request.nextUrl.searchParams.get('plant')
  const plant = plantRaw && (PLANTS as string[]).includes(plantRaw) ? (plantRaw as Plant) : undefined

  try {
    const ctx = createQuoteCtx()
    const rows: AdminPriceRow[] = await loadPriceRows(ctx, plant)
    return NextResponse.json({ success: true, rows, devSeed: ctx.devSeed })
  } catch (e) {
    return quoteErrorResponse(e)
  }
}

type PutRow = {
  id: string
  price?: number
  display_name?: string | null
  argo_part_code?: string | null
  note?: string | null
  attrs?: Record<string, unknown> | null
  /** YYYY-MM-DD；後台可手改生效日，有送才覆蓋（優先於「改價自動帶今天」） */
  effective_from?: string | null
}

// PUT { rows:[{id, price?, display_name?, argo_part_code?, note?, attrs?, effective_from?}] }：批次更新，逐欄白名單。
// 價格真的變了才更新 effective_from（今天，台灣時區）；只改名稱／料號不動生效日；頁面明確送 effective_from 則以它為準。
export async function PUT(request: NextRequest) {
  const guard = await guardQuote('quote_admin')
  if (!guard.ok) return guard.res

  const body = await readJsonBody<{ rows?: PutRow[] }>(request)
  if (!body || !Array.isArray(body.rows) || body.rows.length === 0) return badRequest('缺少 rows')
  if (body.rows.length > MAX_ROWS) return badRequest(`一次最多更新 ${MAX_ROWS} 列`)

  try {
    const ctx = createQuoteCtx()
    const sb = writableClient(ctx)
    if (!sb) return badRequest('目前為開發 seed 模式（資料表尚未建立或 QUOTE_DEV_SEED=1），無法寫入', 'DEV_SEED')
    const updatedBy = guard.member.realName ?? guard.member.email
    const now = new Date().toISOString()
    const today = taipeiToday()

    const ids = body.rows.map((r) => (typeof r?.id === 'string' ? r.id.trim() : '')).filter(Boolean)
    if (ids.length !== body.rows.length) return badRequest('每列都要有 id')

    const { data: existingRows, error: readErr } = await sb
      .from('quote_price_items')
      .select('id, price')
      .in('id', ids)
    if (readErr) throw new Error(describeError(readErr))
    const currentPrice = new Map<string, number>(
      ((existingRows ?? []) as { id: string; price: number | string | null }[]).map((r) => [r.id, Number(r.price ?? 0)]),
    )

    let updated = 0
    const skipped: string[] = []
    for (const r of body.rows) {
      const id = r.id.trim()
      if (!currentPrice.has(id)) {
        skipped.push(id)
        continue
      }
      const update: Record<string, unknown> = { updated_by: updatedBy, updated_at: now }
      if (r.price !== undefined) {
        const p = Number(r.price)
        if (!Number.isFinite(p) || p < 0) return badRequest(`價格必須是 ≥ 0 的數字（id=${id}）`)
        update.price = p
        if (Math.abs(p - (currentPrice.get(id) ?? 0)) > 1e-9) update.effective_from = today
      }
      if (r.display_name !== undefined) {
        if (r.display_name !== null && typeof r.display_name !== 'string') return badRequest('display_name 必須是文字')
        const v = (r.display_name ?? '').trim()
        if (v.length > DISPLAY_MAX_LEN) return badRequest(`顯示名稱最多 ${DISPLAY_MAX_LEN} 字`)
        update.display_name = v || null
      }
      if (r.argo_part_code !== undefined) {
        if (r.argo_part_code !== null && typeof r.argo_part_code !== 'string') return badRequest('argo_part_code 必須是文字')
        const v = (r.argo_part_code ?? '').trim().toUpperCase()
        if (v.length > PART_CODE_MAX_LEN) return badRequest(`ARGO 料號最多 ${PART_CODE_MAX_LEN} 字`)
        update.argo_part_code = v || null
      }
      if (r.note !== undefined) {
        if (r.note !== null && typeof r.note !== 'string') return badRequest('note 必須是文字')
        const v = (r.note ?? '').trim()
        if (v.length > NOTE_MAX_LEN) return badRequest(`備註最多 ${NOTE_MAX_LEN} 字`)
        update.note = v || null
      }
      if (r.attrs !== undefined) {
        if (r.attrs !== null && (typeof r.attrs !== 'object' || Array.isArray(r.attrs))) return badRequest('attrs 必須是物件')
        update.attrs = r.attrs
      }
      if (r.effective_from !== undefined) {
        if (r.effective_from !== null && typeof r.effective_from !== 'string') return badRequest('effective_from 必須是文字')
        const v = (r.effective_from ?? '').trim()
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return badRequest(`生效日格式需為 YYYY-MM-DD（id=${id}）`)
        update.effective_from = v || null
      }
      if (Object.keys(update).length === 2) continue // 只有 updated_by/at，沒東西要改

      const { error } = await sb.from('quote_price_items').update(update).eq('id', id)
      if (error) throw new Error(describeError(error))
      updated += 1
    }
    return NextResponse.json({ success: true, updated, skipped })
  } catch (e) {
    return quoteErrorResponse(e)
  }
}
